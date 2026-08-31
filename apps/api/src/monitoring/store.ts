import type { Db } from 'mongodb';

const QUERY_TIMEOUT_MILLISECONDS = 1_500;
const READINESS_SLOW_MILLISECONDS = 5_000;

export const readinessFailureCategories = [
  'stripe_timeout',
  'stripe_authentication_failure',
  'stripe_api_failure',
  'stripe_rate_limit',
  'stripe_malformed_response',
  'stripe_account_identity_mismatch',
  'stripe_account_mode_mismatch',
  'stripe_account_refresh_claim_lost',
  'refresh_lease_exhausted',
] as const;

export type ReadinessFailureCategory = (typeof readinessFailureCategories)[number];
export type ReadinessFailureCounts = Record<ReadinessFailureCategory, number>;

interface HeartbeatDocument {
  service: 'worker';
  environment: string;
  commit_sha: string;
  observed_at: Date;
}

interface OldestDocument {
  created_at?: Date;
  received_at?: Date;
  processing_started_at?: Date | null;
  updated_at?: Date;
}

export interface MonitoringSnapshot {
  worker: HeartbeatDocument | null;
  pendingCount: number;
  oldestPendingAt: Date | null;
  processingCount: number;
  oldestProcessingAt: Date | null;
  terminalFailed15m: number;
  terminalFailed24h: number;
  stripePendingCount: number;
  stripeOldestPendingAt: Date | null;
  stripeProcessingCount: number;
  stripeFailedCount: number;
  stripeHistoricalTerminalFailedCount: number;
  paymentManualReviewCount: number;
  paymentOldestManualReviewAt: Date | null;
  paymentFinalizationFailureCount: number;
  paymentExpiryCandidateCount: number;
  paymentReconciliationPendingCount: number;
  paymentReconciliationProcessingCount: number;
  paymentSucceededUnfinalizedCount: number;
  paymentOldestSucceededUnfinalizedAt: Date | null;
  paymentRetryExhaustedCount: number;
  readinessFailureCount15m: number;
  readinessOldestFailureAt: Date | null;
  readinessNewestFailureAt: Date | null;
  readinessFailureCounts15m: ReadinessFailureCounts;
  readinessUnreadyCount24h: number;
  readinessSlowCount15m: number;
  readinessMaxDurationMs15m: number;
  readinessReclaimedLeaseCount24h: number;
}

export interface MonitoringReader {
  read(environment: string, now: Date): Promise<MonitoringSnapshot>;
}

export class MongoMonitoringReader implements MonitoringReader {
  public constructor(
    private readonly database: Db,
    private readonly queryTimeoutMilliseconds = QUERY_TIMEOUT_MILLISECONDS,
  ) {}

  public async read(environment: string, now: Date): Promise<MonitoringSnapshot> {
    const heartbeats = this.database.collection<HeartbeatDocument>('service_heartbeats');
    const outbox = this.database.collection<OldestDocument>('notification_outbox');
    const stripeEvents = this.database.collection<OldestDocument>('stripe_webhook_events');
    const stripeAcknowledgements = this.database.collection(
      'stripe_webhook_failure_acknowledgements',
    );
    const paymentAttempts = this.database.collection<OldestDocument>('payment_attempts');
    const auditLogs = this.database.collection('audit_logs');
    const maxTimeMS = this.queryTimeoutMilliseconds;
    const fifteenMinutesAgo = new Date(now.valueOf() - 15 * 60_000);
    const twentyFourHoursAgo = new Date(now.valueOf() - 24 * 60 * 60_000);

    const query = Promise.all([
      heartbeats.findOne(
        { service: 'worker', environment },
        {
          sort: { observed_at: -1 },
          projection: { _id: 0, service: 1, environment: 1, commit_sha: 1, observed_at: 1 },
          maxTimeMS,
        },
      ),
      outbox.countDocuments({ status: 'pending' }, { maxTimeMS }),
      outbox.findOne(
        { status: 'pending' },
        { sort: { created_at: 1 }, projection: { _id: 0, created_at: 1 }, maxTimeMS },
      ),
      outbox.countDocuments({ status: 'processing' }, { maxTimeMS }),
      outbox.findOne(
        { status: 'processing' },
        {
          sort: { processing_started_at: 1 },
          projection: { _id: 0, processing_started_at: 1 },
          maxTimeMS,
        },
      ),
      outbox.countDocuments(
        { status: 'failed', failed_at: { $gte: fifteenMinutesAgo } },
        { maxTimeMS },
      ),
      outbox.countDocuments(
        { status: 'failed', failed_at: { $gte: twentyFourHoursAgo } },
        { maxTimeMS },
      ),
      stripeEvents.countDocuments({ processing_status: 'pending' }, { maxTimeMS }),
      stripeEvents.findOne(
        { processing_status: 'pending' },
        { sort: { received_at: 1 }, projection: { _id: 0, received_at: 1 }, maxTimeMS },
      ),
      stripeEvents.countDocuments({ processing_status: 'processing' }, { maxTimeMS }),
      stripeEvents
        .aggregate<{ count: number }>(
          [
            { $match: { processing_status: 'failed' } },
            {
              $lookup: {
                from: 'stripe_webhook_failure_acknowledgements',
                localField: '_id',
                foreignField: 'stripe_webhook_event_id',
                as: 'operational_acknowledgements',
              },
            },
            { $match: { operational_acknowledgements: { $eq: [] } } },
            { $count: 'count' },
          ],
          { maxTimeMS },
        )
        .next(),
      stripeAcknowledgements.countDocuments({}, { maxTimeMS }),
      paymentAttempts.countDocuments({ state: 'manual_review' }, { maxTimeMS }),
      paymentAttempts.findOne(
        { state: 'manual_review' },
        { sort: { updated_at: 1 }, projection: { _id: 0, updated_at: 1 }, maxTimeMS },
      ),
      paymentAttempts.countDocuments(
        { state: 'manual_review', failure_category: 'local_finalization' },
        { maxTimeMS },
      ),
      paymentAttempts.countDocuments(
        {
          slot_released: false,
          expires_at: { $lte: now },
          state: { $nin: ['succeeded', 'expired', 'stale', 'failed_terminal', 'manual_review'] },
        },
        { maxTimeMS },
      ),
      paymentAttempts.countDocuments(
        {
          slot_released: false,
          next_attempt_at: { $lte: now },
          claim_token: null,
          state: {
            $in: [
              'stripe_creation_processing',
              'requires_payment_method',
              'requires_customer_action',
              'failed_recoverable',
              'processing',
              'succeeded_unfinalized',
            ],
          },
        },
        { maxTimeMS },
      ),
      paymentAttempts.countDocuments({ claim_token: { $type: 'string' } }, { maxTimeMS }),
      paymentAttempts.countDocuments({ state: 'succeeded_unfinalized' }, { maxTimeMS }),
      paymentAttempts.findOne(
        { state: 'succeeded_unfinalized' },
        { sort: { updated_at: 1 }, projection: { _id: 0, updated_at: 1 }, maxTimeMS },
      ),
      paymentAttempts.countDocuments(
        { state: 'manual_review', attempt_count: { $gte: 5 } },
        { maxTimeMS },
      ),
      auditLogs
        .aggregate<{
          failure_count: number;
          oldest_failure_at: Date | null;
          newest_failure_at: Date | null;
          unready_count: number;
          slow_count: number;
          max_duration_ms: number;
          reclaimed_lease_count: number;
          categories: Array<{ category: string; count: number }>;
        }>(
          [
            {
              $match: {
                event: 'stripe_readiness_refresh.completed',
                created_at: { $gte: twentyFourHoursAgo },
              },
            },
            {
              $facet: {
                failures: [
                  { $match: { outcome: 'failure', created_at: { $gte: fifteenMinutesAgo } } },
                  {
                    $group: {
                      _id: null,
                      failure_count: { $sum: 1 },
                      oldest_failure_at: { $min: '$created_at' },
                      newest_failure_at: { $max: '$created_at' },
                    },
                  },
                ],
                categories: [
                  { $match: { outcome: 'failure', created_at: { $gte: fifteenMinutesAgo } } },
                  { $group: { _id: '$metadata.category', count: { $sum: 1 } } },
                ],
                unready: [
                  { $match: { outcome: 'success', 'metadata.category': 'account_unready' } },
                  { $count: 'count' },
                ],
                latency: [
                  { $match: { created_at: { $gte: fifteenMinutesAgo } } },
                  {
                    $set: {
                      duration: {
                        $convert: {
                          input: '$metadata.duration_ms',
                          to: 'int',
                          onError: 0,
                          onNull: 0,
                        },
                      },
                    },
                  },
                  {
                    $group: {
                      _id: null,
                      slow_count: {
                        $sum: {
                          $cond: [{ $gte: ['$duration', READINESS_SLOW_MILLISECONDS] }, 1, 0],
                        },
                      },
                      max_duration_ms: { $max: '$duration' },
                    },
                  },
                ],
                reclaimed: [
                  { $match: { 'metadata.lease_reclaimed': 'true' } },
                  { $count: 'count' },
                ],
              },
            },
            {
              $project: {
                _id: 0,
                failure_count: { $ifNull: [{ $first: '$failures.failure_count' }, 0] },
                oldest_failure_at: { $ifNull: [{ $first: '$failures.oldest_failure_at' }, null] },
                newest_failure_at: { $ifNull: [{ $first: '$failures.newest_failure_at' }, null] },
                unready_count: { $ifNull: [{ $first: '$unready.count' }, 0] },
                slow_count: { $ifNull: [{ $first: '$latency.slow_count' }, 0] },
                max_duration_ms: { $ifNull: [{ $first: '$latency.max_duration_ms' }, 0] },
                reclaimed_lease_count: { $ifNull: [{ $first: '$reclaimed.count' }, 0] },
                categories: {
                  $map: {
                    input: '$categories',
                    as: 'item',
                    in: { category: '$$item._id', count: '$$item.count' },
                  },
                },
              },
            },
          ],
          { maxTimeMS },
        )
        .next(),
    ]);

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Monitoring query timeout')), maxTimeMS);
      timer.unref();
    });

    const [
      worker,
      pendingCount,
      oldestPending,
      processingCount,
      oldestProcessing,
      terminalFailed15m,
      terminalFailed24h,
      stripePendingCount,
      stripeOldestPending,
      stripeProcessingCount,
      stripeActionableFailed,
      stripeHistoricalTerminalFailedCount,
      paymentManualReviewCount,
      paymentOldestManualReview,
      paymentFinalizationFailureCount,
      paymentExpiryCandidateCount,
      paymentReconciliationPendingCount,
      paymentReconciliationProcessingCount,
      paymentSucceededUnfinalizedCount,
      paymentOldestSucceededUnfinalized,
      paymentRetryExhaustedCount,
      readiness,
    ] = await Promise.race([query, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });

    return {
      worker,
      pendingCount,
      oldestPendingAt: oldestPending?.created_at ?? null,
      processingCount,
      oldestProcessingAt: oldestProcessing?.processing_started_at ?? null,
      terminalFailed15m,
      terminalFailed24h,
      stripePendingCount,
      stripeOldestPendingAt: stripeOldestPending?.received_at ?? null,
      stripeProcessingCount,
      stripeFailedCount: stripeActionableFailed?.count ?? 0,
      stripeHistoricalTerminalFailedCount,
      paymentManualReviewCount,
      paymentOldestManualReviewAt: paymentOldestManualReview?.updated_at ?? null,
      paymentFinalizationFailureCount,
      paymentExpiryCandidateCount,
      paymentReconciliationPendingCount,
      paymentReconciliationProcessingCount,
      paymentSucceededUnfinalizedCount,
      paymentOldestSucceededUnfinalizedAt: paymentOldestSucceededUnfinalized?.updated_at ?? null,
      paymentRetryExhaustedCount,
      readinessFailureCount15m: readiness?.failure_count ?? 0,
      readinessOldestFailureAt: readiness?.oldest_failure_at ?? null,
      readinessNewestFailureAt: readiness?.newest_failure_at ?? null,
      readinessFailureCounts15m: readinessCounts(readiness?.categories ?? []),
      readinessUnreadyCount24h: readiness?.unready_count ?? 0,
      readinessSlowCount15m: readiness?.slow_count ?? 0,
      readinessMaxDurationMs15m: readiness?.max_duration_ms ?? 0,
      readinessReclaimedLeaseCount24h: readiness?.reclaimed_lease_count ?? 0,
    };
  }
}

function readinessCounts(
  values: Array<{ category: string; count: number }>,
): ReadinessFailureCounts {
  const counts = Object.fromEntries(
    readinessFailureCategories.map((category) => [category, 0]),
  ) as ReadinessFailureCounts;
  for (const value of values)
    if (readinessFailureCategories.includes(value.category as ReadinessFailureCategory))
      counts[value.category as ReadinessFailureCategory] = value.count;
  return counts;
}

import type { Db } from 'mongodb';

const QUERY_TIMEOUT_MILLISECONDS = 1_500;

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
    };
  }
}

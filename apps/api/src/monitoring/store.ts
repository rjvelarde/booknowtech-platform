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
      stripeEvents.countDocuments({ processing_status: 'failed' }, { maxTimeMS }),
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
      stripeFailedCount,
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
      stripeFailedCount,
    };
  }
}

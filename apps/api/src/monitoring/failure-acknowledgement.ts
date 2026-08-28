import { randomUUID } from 'node:crypto';
import { type Db, type MongoClient, ObjectId } from 'mongodb';

const TERMINAL_ATTEMPTS = 8;

interface WebhookFailureDocument {
  _id: ObjectId;
  public_id: string;
  stripe_event_id: string;
  processing_status: string;
  attempt_count: number;
  processing_started_at: Date | null;
  processed_at: Date | null;
  failure_category: string | null;
}

export async function acknowledgeTerminalWebhookFailure(input: {
  client: MongoClient;
  database: Db;
  stripeEventId: string;
  operatorId: string;
  reason: string;
  requestId: string;
}) {
  const session = input.client.startSession();
  try {
    return await session.withTransaction(async () => {
      const events = input.database.collection<WebhookFailureDocument>('stripe_webhook_events');
      const acknowledgements = input.database.collection('stripe_webhook_failure_acknowledgements');
      const event = await events.findOne({ stripe_event_id: input.stripeEventId }, { session });
      if (!event) throw new Error('webhook_failure_not_found');
      if (
        event.processing_status !== 'failed' ||
        event.attempt_count < TERMINAL_ATTEMPTS ||
        event.processing_started_at !== null ||
        event.processed_at !== null ||
        typeof event.failure_category !== 'string'
      )
        throw new Error('webhook_failure_not_terminal');
      const existing = await acknowledgements.findOne(
        { stripe_webhook_event_id: event._id },
        { session },
      );
      if (existing)
        return { outcome: 'already_acknowledged', stripe_event_id: input.stripeEventId };
      const now = new Date();
      const acknowledgement = {
        _id: new ObjectId(),
        public_id: randomUUID(),
        stripe_webhook_event_id: event._id,
        stripe_event_id: event.stripe_event_id,
        failure_category: event.failure_category,
        operator_id: input.operatorId,
        reason: input.reason,
        request_id: input.requestId,
        created_at: now,
      };
      await acknowledgements.insertOne(acknowledgement, { session });
      await input.database.collection('audit_logs').insertOne(
        {
          public_id: randomUUID(),
          event: 'stripe_webhook_failure.acknowledged_non_actionable',
          outcome: 'success',
          actor_user_id: null,
          tenant_id: null,
          request_id: input.requestId,
          metadata: {
            operator_id: input.operatorId,
            reason: input.reason,
            stripe_event_id: event.stripe_event_id,
            webhook_event_public_id: event.public_id,
            failure_category: event.failure_category,
          },
          created_at: now,
        },
        { session },
      );
      return { outcome: 'acknowledged', stripe_event_id: input.stripeEventId };
    });
  } finally {
    await session.endSession();
  }
}

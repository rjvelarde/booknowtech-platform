import { randomUUID } from 'node:crypto';
import type { ClientSession, Collection, Db, ObjectId } from 'mongodb';
import type { Logger } from 'pino';
import Stripe from 'stripe';

const POLL_MILLISECONDS = 1_000;
const STALE_MILLISECONDS = 5 * 60_000;
const MAX_ATTEMPTS = 8;

export interface StripeProjection {
  id?: string;
  details_submitted: boolean;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  capabilities: { card_payments: string | null; transfers: string | null };
  requirements: {
    currently_due: string[];
    eventually_due: string[];
    past_due: string[];
    pending_verification: string[];
    disabled_reason: string | null;
    current_deadline: Date | null;
  };
}

interface StripeWebhookEventDocument {
  _id: ObjectId;
  stripe_event_id: string;
  stripe_account_id: string | null;
  event_type: string;
  stripe_created_at: Date;
  sanitized_payload: StripeProjection;
  processing_status: string;
  attempt_count: number;
  next_attempt_at: Date;
  processing_started_at: Date | null;
  received_at: Date;
  received_request_id: string;
  tenant_id: ObjectId | null;
  processed_at: Date | null;
  failure_category: string | null;
  updated_at: Date;
}

interface TenantStripeAccountDocument {
  _id: ObjectId;
  tenant_id: ObjectId;
  status: string;
  active: boolean;
  last_stripe_event_id: string | null;
  last_stripe_event_created_at: Date | null;
  details_submitted: boolean;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  capabilities: StripeProjection['capabilities'];
  requirements: StripeProjection['requirements'];
  last_synced_at: Date | null;
  disconnected_at: Date | null;
  updated_at: Date;
  updated_by_source: string;
  version: number;
}

export function startStripeWebhookWorker(db: Db, stripeSecretKey: string, logger: Logger) {
  const stripe = new Stripe(stripeSecretKey, { maxNetworkRetries: 2, timeout: 10_000 });
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let active = Promise.resolve();
  const poll = async () => {
    if (stopped) return;
    active = processOne(db, stripe, logger).catch((error: unknown) =>
      logger.error({
        event: 'stripe_webhook.poll_failed',
        error_name: error instanceof Error ? error.name : 'unknown',
      }),
    );
    await active;
    if (!stopped) timer = setTimeout(() => void poll(), POLL_MILLISECONDS);
  };
  void poll();
  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await active;
    },
  };
}

async function processOne(db: Db, stripe: Stripe, logger: Logger) {
  const events = db.collection<StripeWebhookEventDocument>('stripe_webhook_events');
  const now = new Date();
  const event = await events.findOneAndUpdate(
    {
      $or: [
        { processing_status: 'pending', next_attempt_at: { $lte: now } },
        {
          processing_status: 'processing',
          processing_started_at: { $lte: new Date(now.valueOf() - STALE_MILLISECONDS) },
        },
      ],
    },
    { $set: { processing_status: 'processing', processing_started_at: now, updated_at: now } },
    { sort: { next_attempt_at: 1, received_at: 1 }, returnDocument: 'after' },
  );
  if (!event) return;
  try {
    const accountId = event.stripe_account_id;
    if (!accountId) throw new Error('unresolved_account');
    const accountRecord = await db
      .collection<TenantStripeAccountDocument>('tenant_stripe_accounts')
      .findOne({ stripe_account_id: accountId, active: true });
    if (!accountRecord) throw new Error('unresolved_account');
    let projection = event.sanitized_payload;
    const lastCreated = accountRecord.last_stripe_event_created_at;
    if (
      event.event_type === 'account.updated' &&
      lastCreated &&
      event.stripe_created_at.valueOf() === lastCreated.valueOf() &&
      accountRecord.last_stripe_event_id !== event.stripe_event_id
    ) {
      projection = sanitize(await stripe.accounts.retrieve(accountId));
    }
    const session = db.client.startSession();
    try {
      await session.withTransaction(async () => {
        const current = await db
          .collection<TenantStripeAccountDocument>('tenant_stripe_accounts')
          .findOne({ _id: accountRecord._id, active: true }, { session });
        const stale =
          current?.last_stripe_event_created_at instanceof Date &&
          current.last_stripe_event_created_at > event.stripe_created_at;
        if (event.event_type === 'account.application.deauthorized') {
          await db.collection<TenantStripeAccountDocument>('tenant_stripe_accounts').updateOne(
            { _id: accountRecord._id, active: true },
            {
              $set: {
                status: 'disconnected',
                active: false,
                disconnected_at: new Date(),
                last_stripe_event_id: event.stripe_event_id,
                last_stripe_event_created_at: event.stripe_created_at,
                updated_at: new Date(),
                updated_by_source: 'stripe_webhook',
              },
              $inc: { version: 1 },
            },
            { session },
          );
          await audit(
            db.collection('audit_logs'),
            accountRecord.tenant_id,
            event,
            current?.status as string,
            'disconnected',
            session,
          );
        } else if (!stale) {
          const nextStatus = deriveConnectStatus(projection);
          await db
            .collection('tenant_stripe_accounts')
            .updateOne(
              { _id: accountRecord._id },
              { $set: projectionUpdate(projection, event, nextStatus), $inc: { version: 1 } },
              { session },
            );
          if (current?.status !== nextStatus)
            await audit(
              db.collection('audit_logs'),
              accountRecord.tenant_id,
              event,
              current?.status as string,
              nextStatus,
              session,
            );
        }
        await events.updateOne(
          { _id: event._id, processing_status: 'processing' },
          {
            $set: {
              processing_status: 'processed',
              tenant_id: accountRecord.tenant_id,
              processed_at: new Date(),
              processing_started_at: null,
              failure_category: null,
              updated_at: new Date(),
            },
            $inc: { attempt_count: 1 },
          },
          { session },
        );
      });
    } finally {
      await session.endSession();
    }
    logger.info({
      event: 'stripe_webhook.processed',
      stripe_event_id: event.stripe_event_id,
      event_type: event.event_type,
    });
  } catch (reason) {
    const attempts = event.attempt_count + 1;
    const terminal = attempts >= MAX_ATTEMPTS;
    await events.updateOne(
      { _id: event._id, processing_status: 'processing' },
      {
        $set: {
          processing_status: terminal ? 'failed' : 'pending',
          next_attempt_at: new Date(Date.now() + Math.min(3_600_000, 2 ** attempts * 1_000)),
          processing_started_at: null,
          failure_category:
            reason instanceof Error ? reason.message.slice(0, 80) : 'processing_failed',
          updated_at: new Date(),
        },
        $inc: { attempt_count: 1 },
      },
    );
    logger.warn({
      event: 'stripe_webhook.retry_scheduled',
      stripe_event_id: event.stripe_event_id,
      attempt: attempts,
      terminal,
    });
  }
}

function sanitize(account: Stripe.Account): StripeProjection {
  const requirements = account.requirements;
  return {
    id: account.id,
    details_submitted: account.details_submitted,
    charges_enabled: account.charges_enabled,
    payouts_enabled: account.payouts_enabled,
    capabilities: {
      card_payments: account.capabilities?.card_payments ?? null,
      transfers: account.capabilities?.transfers ?? null,
    },
    requirements: {
      currently_due: requirements?.currently_due ?? [],
      eventually_due: requirements?.eventually_due ?? [],
      past_due: requirements?.past_due ?? [],
      pending_verification: requirements?.pending_verification ?? [],
      disabled_reason: requirements?.disabled_reason ?? null,
      current_deadline: requirements?.current_deadline
        ? new Date(requirements.current_deadline * 1_000)
        : null,
    },
  };
}
export function deriveConnectStatus(value: StripeProjection) {
  const requirements = value.requirements;
  if (requirements.disabled_reason) return 'disabled';
  if (requirements.past_due?.length || requirements.currently_due?.length)
    return value.details_submitted ? 'action_required' : 'onboarding_started';
  if (!value.details_submitted || requirements.pending_verification?.length)
    return 'pending_verification';
  if (!value.charges_enabled) return 'restricted';
  return value.payouts_enabled ? 'payouts_enabled' : 'payments_enabled';
}
function projectionUpdate(
  value: StripeProjection,
  event: StripeWebhookEventDocument,
  status: string,
) {
  return {
    status,
    details_submitted: Boolean(value.details_submitted),
    charges_enabled: Boolean(value.charges_enabled),
    payouts_enabled: Boolean(value.payouts_enabled),
    capabilities: value.capabilities,
    requirements: value.requirements,
    last_stripe_event_id: event.stripe_event_id,
    last_stripe_event_created_at: event.stripe_created_at,
    last_synced_at: new Date(),
    updated_at: new Date(),
    updated_by_source: 'stripe_webhook',
  };
}
async function audit(
  collection: Collection,
  tenantId: ObjectId,
  event: StripeWebhookEventDocument,
  before: string,
  after: string,
  session: ClientSession,
) {
  await collection.insertOne(
    {
      public_id: randomUUID(),
      event:
        after === 'disconnected'
          ? 'stripe_connect_account_disconnected'
          : after === 'restricted' || after === 'disabled'
            ? 'stripe_connect_account_restricted'
            : 'stripe_connect_readiness_changed',
      outcome: 'success',
      actor_user_id: null,
      tenant_id: tenantId,
      request_id: event.received_request_id,
      metadata: { before, after, stripe_event_id: event.stripe_event_id },
      created_at: new Date(),
    },
    { session },
  );
}

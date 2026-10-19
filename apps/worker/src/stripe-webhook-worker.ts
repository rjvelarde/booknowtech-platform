import {
  type ExternalAccountRule,
  externalAccountManifest,
  matchExternalRule,
} from '@booknowtech/shared/stripe-ownership';
import { randomUUID } from 'node:crypto';
import type { ClientSession, Collection, Db, ObjectId } from 'mongodb';
import type { Logger } from 'pino';
import Stripe from 'stripe';
import {
  type ExternalEvidenceProjection,
  type PaymentEventProjection,
  type PaymentFinalizationOptions,
  applyExternalFinancialEvidence,
  applyPaymentEvent,
} from './payment-event-finalizer.js';

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
  public_id: string;
  endpoint_kind: string;
  livemode: boolean;
  payload_hash: string;
  stripe_event_id: string;
  stripe_account_id: string | null;
  event_type: string;
  stripe_created_at: Date;
  sanitized_payload: StripeProjection | PaymentEventProjection | ExternalEvidenceProjection;
  processing_status: string;
  attempt_count: number;
  next_attempt_at: Date;
  processing_started_at: Date | null;
  processing_token?: string | null;
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

export function startStripeWebhookWorker(
  db: Db,
  stripeSecretKey: string,
  logger: Logger,
  paymentOptions: PaymentFinalizationOptions,
  environment: string,
) {
  const stripe = new Stripe(stripeSecretKey, { maxNetworkRetries: 2, timeout: 10_000 });
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let active = Promise.resolve();
  const poll = async () => {
    if (stopped) return;
    active = processStripeWebhookEvent(
      db,
      {
        retrieveAccount: (id) => stripe.accounts.retrieve(id),
        retrievePlatform: () => stripe.accounts.retrieve(),
      },
      logger,
      paymentOptions,
      { environment },
    ).catch((error: unknown) =>
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

export interface StripeAccountReader {
  retrieveAccount(accountId: string): Promise<Stripe.Account>;
  retrievePlatform?(): Promise<{ id: string }>;
}

export async function processStripeWebhookEvent(
  db: Db,
  stripe: StripeAccountReader,
  logger: Logger,
  paymentOptions?: PaymentFinalizationOptions,
  ownership?: { environment: string; manifest?: readonly ExternalAccountRule[] },
) {
  const events = db.collection<StripeWebhookEventDocument>('stripe_webhook_events');
  const now = new Date();
  const processingToken = randomUUID();
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
    {
      $set: {
        processing_status: 'processing',
        processing_started_at: now,
        processing_token: processingToken,
        updated_at: now,
      },
    },
    { sort: { next_attempt_at: 1, received_at: 1 }, returnDocument: 'after' },
  );
  if (!event) return;
  try {
    const accountId = event.stripe_account_id;
    if (!accountId) throw new Error('unresolved_account');
    if (await classifyExternalEvent(db, stripe, event, processingToken, ownership)) return;
    const paymentEvent = event.event_type.startsWith('payment_intent.');
    const externalEvidenceEvent =
      event.event_type.startsWith('refund.') || event.event_type.startsWith('charge.dispute.');
    const accountRecord = await db
      .collection<TenantStripeAccountDocument>('tenant_stripe_accounts')
      .findOne({
        stripe_account_id: accountId,
        ...(paymentEvent || externalEvidenceEvent ? {} : { active: true }),
      });
    if (!accountRecord) throw new Error('unresolved_account');
    let projection = event.sanitized_payload as StripeProjection;
    const lastCreated = accountRecord.last_stripe_event_created_at;
    const ambiguousOrder =
      lastCreated &&
      event.stripe_created_at.valueOf() === lastCreated.valueOf() &&
      accountRecord.last_stripe_event_id !== event.stripe_event_id;
    if (!paymentEvent && !externalEvidenceEvent && ambiguousOrder)
      projection = sanitize(await stripe.retrieveAccount(accountId));
    const session = db.client.startSession();
    try {
      await session.withTransaction(async () => {
        if (paymentEvent) {
          if (!paymentOptions) throw new Error('payment_finalization_unconfigured');
          await applyPaymentEvent(
            db,
            event as StripeWebhookEventDocument & { sanitized_payload: PaymentEventProjection },
            paymentOptions,
            session,
          );
          await markProcessed(events, event, processingToken, accountRecord.tenant_id, session);
          return;
        }
        if (externalEvidenceEvent) {
          await applyExternalFinancialEvidence(
            db,
            event as StripeWebhookEventDocument & {
              sanitized_payload: ExternalEvidenceProjection;
            },
            session,
          );
          await markProcessed(events, event, processingToken, accountRecord.tenant_id, session);
          return;
        }
        const current = await db
          .collection<TenantStripeAccountDocument>('tenant_stripe_accounts')
          .findOne({ _id: accountRecord._id, active: true }, { session });
        const stale =
          current?.last_stripe_event_created_at instanceof Date &&
          current.last_stripe_event_created_at > event.stripe_created_at;
        if (event.event_type === 'account.application.deauthorized' && !stale && !ambiguousOrder) {
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
              $inc: { version: 1, readiness_generation: 1 },
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
          await db.collection('tenant_stripe_accounts').updateOne(
            { _id: accountRecord._id },
            {
              $set: projectionUpdate(projection, event, nextStatus),
              $inc: { version: 1, readiness_generation: 1 },
            },
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
        await markProcessed(events, event, processingToken, accountRecord.tenant_id, session);
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
      { _id: event._id, processing_status: 'processing', processing_token: processingToken },
      {
        $set: {
          processing_status: terminal ? 'failed' : 'pending',
          next_attempt_at: new Date(Date.now() + Math.min(3_600_000, 2 ** attempts * 1_000)),
          processing_started_at: null,
          processing_token: null,
          failure_category: failureCategory(reason),
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

function failureCategory(reason: unknown): string {
  if (
    reason instanceof Error &&
    [
      'unresolved_account',
      'claim_lost',
      'stripe_account_ownership_conflict',
      'external_ownership_unverified',
    ].includes(reason.message)
  )
    return reason.message;
  return 'stripe_processing_failed';
}

async function markProcessed(
  events: Collection<StripeWebhookEventDocument>,
  event: StripeWebhookEventDocument,
  processingToken: string,
  tenantId: ObjectId,
  session: ClientSession,
) {
  const result = await events.updateOne(
    { _id: event._id, processing_status: 'processing', processing_token: processingToken },
    {
      $set: {
        processing_status: 'processed',
        tenant_id: tenantId,
        processed_at: new Date(),
        processing_started_at: null,
        processing_token: null,
        failure_category: null,
        updated_at: new Date(),
      },
      $inc: { attempt_count: 1 },
    },
    { session },
  );
  if (result.matchedCount !== 1) throw new Error('claim_lost');
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

async function classifyExternalEvent(
  db: Db,
  stripe: StripeAccountReader,
  event: StripeWebhookEventDocument,
  token: string,
  context?: { environment: string; manifest?: readonly ExternalAccountRule[] },
): Promise<boolean> {
  const manifest = context?.manifest ?? externalAccountManifest;
  if (!manifest.some((rule) => rule.accountId === event.stripe_account_id)) return false;
  // A manifest reservation and ANY retained BookNowTech reference are a conflict, including inactive accounts.
  const session = db.client.startSession();
  try {
    return await session.withTransaction(async () => {
      for (const name of ['tenant_stripe_accounts', 'payment_attempts', 'payment_ledger_entries']) {
        if (
          await db
            .collection(name)
            .findOne({ stripe_account_id: event.stripe_account_id }, { session })
        )
          throw new Error('stripe_account_ownership_conflict');
      }
      if (
        await db
          .collection('stripe_connect_operations')
          .findOne({ stripe_account_id: event.stripe_account_id }, { session })
      )
        throw new Error('stripe_account_ownership_conflict');
      if (
        await db.collection('audit_logs').findOne(
          {
            event: { $regex: '^stripe_connect_' },
            'metadata.stripe_account_id': event.stripe_account_id,
          },
          { session, maxTimeMS: 5000 },
        )
      )
        throw new Error('stripe_account_ownership_conflict');
      if (
        event.tenant_id !== null ||
        event.endpoint_kind !== 'connect' ||
        !context ||
        !stripe.retrievePlatform
      )
        throw new Error('external_ownership_unverified');
      // This is GET /v1/account with the worker credential, never a Stripe-Account header.
      const platform = await stripe.retrievePlatform();
      const rule = matchExternalRule(
        {
          accountId: event.stripe_account_id!,
          platformAccountId: platform.id,
          environment: context.environment,
          livemode: event.livemode,
          eventType: event.event_type,
          now: new Date(),
        },
        manifest,
      );
      if (!rule) throw new Error('external_ownership_unverified');
      const now = new Date();
      const classification = {
        manifest_version: rule.version,
        owning_application: rule.owningApplication,
        platform_account_id: rule.platformAccountId,
        environment: rule.environment,
        livemode: rule.livemode,
        stripe_account_id: rule.accountId,
        evidence_reference: rule.evidenceReference,
        approved_by: rule.approvedBy,
        approved_at: rule.approvedAt,
        review_at: rule.reviewAt,
        expires_at: rule.expiresAt,
        classified_at: now,
      };
      const result = await db.collection('stripe_webhook_events').updateOne(
        { _id: event._id, processing_status: 'processing', processing_token: token },
        {
          $set: {
            processing_status: 'external',
            external_disposition: classification,
            processed_at: now,
            processing_started_at: null,
            processing_token: null,
            failure_category: null,
            updated_at: now,
          },
          $inc: { attempt_count: 1 },
        },
        { session },
      );
      if (result.matchedCount !== 1) throw new Error('claim_lost');
      await db.collection('audit_logs').insertOne(
        {
          public_id: randomUUID(),
          event: 'stripe_webhook.classified_external',
          outcome: 'success',
          actor_user_id: null,
          tenant_id: null,
          request_id: event.received_request_id,
          metadata: {
            ...classification,
            classified_at: now.toISOString(),
            stripe_event_id: event.stripe_event_id,
            webhook_event_public_id: event.public_id,
            payload_hash: event.payload_hash,
            event_type: event.event_type,
          },
          created_at: now,
        },
        { session },
      );
      return true;
    });
  } finally {
    await session.endSession();
  }
}

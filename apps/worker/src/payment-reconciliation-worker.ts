import { createHash, randomUUID } from 'node:crypto';
import { type ClientSession, type Db, type Filter, ObjectId } from 'mongodb';
import type { Logger } from 'pino';

import {
  type PaymentEventProjection,
  type PaymentFinalizationOptions,
  applyPaymentEvent,
} from './payment-event-finalizer.js';

const POLL_MILLISECONDS = 1_000;
const STALE_CLAIM_MILLISECONDS = 5 * 60_000;
export const MAX_RECONCILIATION_ATTEMPTS = 5;
export const RECONCILIATION_DELAYS_MILLISECONDS = [0, 60_000, 300_000, 900_000, 1_800_000] as const;

const CANDIDATE_STATES = [
  'stripe_creation_processing',
  'requires_payment_method',
  'requires_customer_action',
  'failed_recoverable',
  'processing',
  'succeeded_unfinalized',
] as const;

interface Attempt {
  _id: ObjectId;
  public_id: string;
  tenant_id: ObjectId;
  appointment_id: ObjectId;
  tenant_stripe_account_public_id: string;
  stripe_payment_intent_id: string | null;
  stripe_payment_intent_status: string | null;
  state: string;
  expires_at: Date;
  slot_released: boolean;
  claim_token: string | null;
  claim_started_at: Date | null;
  attempt_count: number;
  next_attempt_at: Date;
  failure_category: string | null;
  request_id: string;
  correlation_id: string;
  amount_snapshot: {
    service_price_minor: number;
    provider_amount_due_now_minor: number;
    booknowtech_fee_minor: number;
    customer_total_due_now_minor: number;
    application_fee_amount_minor: number;
    remaining_service_balance_minor: number;
  };
  reconciliation_requeue_request_id?: string | null;
}

interface Account {
  public_id: string;
  tenant_id: ObjectId;
  stripe_account_id: string;
}

export interface ReconciliationPaymentIntent {
  id: string;
  status:
    | 'requires_payment_method'
    | 'requires_confirmation'
    | 'requires_action'
    | 'processing'
    | 'canceled'
    | 'succeeded';
  amount: number;
  applicationFeeAmount: number | null;
  currency: string;
}

export interface PaymentReconciliationStripe {
  retrievePaymentIntent(accountId: string, intentId: string): Promise<ReconciliationPaymentIntent>;
  cancelPaymentIntent(
    accountId: string,
    intentId: string,
    idempotencyKey: string,
  ): Promise<ReconciliationPaymentIntent>;
}

export function startPaymentReconciliationWorker(
  db: Db,
  stripe: PaymentReconciliationStripe,
  logger: Logger,
  options: PaymentFinalizationOptions,
) {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let active = Promise.resolve();
  const poll = async () => {
    if (stopped) return;
    active = processPaymentReconciliation(db, stripe, options)
      .then(() => undefined)
      .catch((error: unknown) =>
        logger.error({
          event: 'payment_reconciliation.poll_failed',
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

export async function processPaymentReconciliation(
  db: Db,
  stripe: PaymentReconciliationStripe,
  options: PaymentFinalizationOptions,
  now = new Date(),
  dependencies: {
    finalizeSuccess?: typeof finalizeRetrievedSuccess;
  } = {},
): Promise<boolean> {
  const attempt = await claimAttempt(db, now);
  if (!attempt) return false;
  const claimToken = attempt.claim_token!;
  try {
    const account = await db.collection<Account>('tenant_stripe_accounts').findOne({
      tenant_id: attempt.tenant_id,
      public_id: attempt.tenant_stripe_account_public_id,
    });
    if (!account || !attempt.stripe_payment_intent_id)
      throw new Error(account ? 'payment_intent_unresolved' : 'payment_account_unresolved');
    const intent = await stripe.retrievePaymentIntent(
      account.stripe_account_id,
      attempt.stripe_payment_intent_id,
    );
    assertIntentIdentity(attempt, intent);
    if (intent.status === 'succeeded') {
      await (dependencies.finalizeSuccess ?? finalizeRetrievedSuccess)(
        db,
        attempt,
        account,
        intent,
        options,
        claimToken,
        now,
      );
      return true;
    }
    if (intent.status === 'processing') {
      await retryOrEscalate(db, attempt, claimToken, now, 'stripe_processing', {
        state: 'processing',
        stripeStatus: 'processing',
      });
      return true;
    }
    if (now < attempt.expires_at) {
      await rescheduleKnownState(db, attempt, claimToken, intent, now);
      return true;
    }
    let authoritative = intent;
    if (intent.status !== 'canceled')
      authoritative = await stripe.cancelPaymentIntent(
        account.stripe_account_id,
        intent.id,
        `payment-expiry:${attempt.public_id}`,
      );
    if (authoritative.status === 'succeeded') {
      assertIntentIdentity(attempt, authoritative);
      await (dependencies.finalizeSuccess ?? finalizeRetrievedSuccess)(
        db,
        attempt,
        account,
        authoritative,
        options,
        claimToken,
        now,
      );
      return true;
    }
    if (authoritative.status !== 'canceled') throw new Error('payment_cancel_not_terminal');
    await commitExpiry(db, attempt, claimToken, now);
    return true;
  } catch (error) {
    await retryOrEscalate(
      db,
      attempt,
      claimToken,
      now,
      error instanceof Error ? error.message : 'stripe_retrieval_unknown',
    );
    return true;
  }
}

async function claimAttempt(db: Db, now: Date): Promise<Attempt | null> {
  const attempts = db.collection<Attempt>('payment_attempts');
  const stale = new Date(now.valueOf() - STALE_CLAIM_MILLISECONDS);
  const claimable = {
    slot_released: false,
    next_attempt_at: { $lte: now },
    $or: [{ claim_token: null }, { claim_started_at: { $lte: stale } }],
  };
  const claim = async (
    state: NonNullable<Filter<Attempt>['state']>,
    extra: Filter<Attempt> = {},
  ) => {
    const token = randomUUID();
    return attempts.findOneAndUpdate(
      { ...claimable, ...extra, state },
      { $set: { claim_token: token, claim_started_at: now, updated_at: now } },
      { sort: { next_attempt_at: 1, created_at: 1 }, returnDocument: 'after' },
    );
  };
  return (
    (await claim('succeeded_unfinalized')) ??
    (await claim({ $in: CANDIDATE_STATES.filter((state) => state !== 'succeeded_unfinalized') })) ??
    (await claim(
      { $eq: 'manual_review' },
      { reconciliation_requeue_request_id: { $type: 'string' } },
    ))
  );
}

function assertIntentIdentity(attempt: Attempt, intent: ReconciliationPaymentIntent): void {
  if (
    intent.id !== attempt.stripe_payment_intent_id ||
    intent.amount !== attempt.amount_snapshot.customer_total_due_now_minor ||
    intent.applicationFeeAmount !== attempt.amount_snapshot.application_fee_amount_minor ||
    intent.currency !== 'usd'
  )
    throw new Error('payment_attribution_mismatch');
}

async function finalizeRetrievedSuccess(
  db: Db,
  attempt: Attempt,
  account: Account,
  intent: ReconciliationPaymentIntent,
  options: PaymentFinalizationOptions,
  claimToken: string,
  now: Date,
): Promise<void> {
  const session = db.client.startSession();
  try {
    await session.withTransaction(async () => {
      const owned = await db
        .collection<Attempt>('payment_attempts')
        .findOne({ _id: attempt._id, claim_token: claimToken }, { session });
      if (!owned) throw new Error('reconciliation_claim_lost');
      if (await repairAlreadyScheduledSuccess(db, owned, claimToken, now, session)) return;
      const projection: PaymentEventProjection = {
        id: intent.id,
        status: 'succeeded',
        amount: intent.amount,
        application_fee_amount: intent.applicationFeeAmount,
        currency: intent.currency,
        last_payment_error_code: null,
      };
      await applyPaymentEvent(
        db,
        {
          _id: new ObjectId(),
          stripe_event_id: `reconciliation:${attempt.public_id}:${attempt.attempt_count + 1}`,
          stripe_account_id: account.stripe_account_id,
          event_type: 'payment_intent.succeeded',
          stripe_created_at: now,
          sanitized_payload: projection,
          received_request_id: `reconciliation:${attempt.public_id}`,
        },
        options,
        session,
      );
      await db.collection<Attempt>('payment_attempts').updateOne(
        { _id: attempt._id, claim_token: claimToken },
        {
          $set: {
            claim_token: null,
            claim_started_at: null,
            stripe_payment_intent_status: 'succeeded',
            reconciliation_requeue_request_id: null,
            updated_at: now,
          },
          $inc: { attempt_count: 1 },
        },
        { session },
      );
      await db
        .collection('payment_operations_alerts')
        .updateMany(
          { payment_attempt_id: attempt._id, status: 'open' },
          { $set: { status: 'acknowledged', acknowledged_at: now } },
          { session },
        );
    });
  } finally {
    await session.endSession();
  }
}

async function repairAlreadyScheduledSuccess(
  db: Db,
  attempt: Attempt,
  claimToken: string,
  now: Date,
  session: ClientSession,
): Promise<boolean> {
  if (attempt.state !== 'manual_review' || !attempt.reconciliation_requeue_request_id) return false;
  const [appointment, succeededEvidence] = await Promise.all([
    db
      .collection('appointments')
      .findOne(
        { _id: attempt.appointment_id, tenant_id: attempt.tenant_id, status: 'scheduled' },
        { session, projection: { _id: 1 } },
      ),
    db
      .collection('payment_ledger_entries')
      .findOne(
        { payment_attempt_id: attempt._id, entry_kind: 'payment_succeeded' },
        { session, projection: { _id: 1 } },
      ),
  ]);
  if (!appointment || !succeededEvidence) return false;
  const repaired = await db.collection<Attempt>('payment_attempts').updateOne(
    {
      _id: attempt._id,
      state: 'manual_review',
      slot_released: false,
      claim_token: claimToken,
      reconciliation_requeue_request_id: attempt.reconciliation_requeue_request_id,
    },
    {
      $set: {
        state: 'succeeded',
        stripe_payment_intent_status: 'succeeded',
        failure_category: null,
        claim_token: null,
        claim_started_at: null,
        reconciliation_requeue_request_id: null,
        updated_at: now,
      },
      $inc: { attempt_count: 1 },
    },
    { session },
  );
  if (repaired.modifiedCount !== 1) throw new Error('reconciliation_claim_lost');
  await db
    .collection('payment_operations_alerts')
    .updateMany(
      { payment_attempt_id: attempt._id, status: 'open' },
      { $set: { status: 'acknowledged', acknowledged_at: now } },
      { session },
    );
  await appendAudit(
    db,
    attempt,
    session,
    'payment_reconciliation_scheduled_success_repaired',
    'success',
    'authoritative_success_with_existing_scheduled_evidence',
  );
  return true;
}

async function rescheduleKnownState(
  db: Db,
  attempt: Attempt,
  claimToken: string,
  intent: ReconciliationPaymentIntent,
  now: Date,
): Promise<void> {
  const state =
    intent.status === 'requires_action'
      ? 'requires_customer_action'
      : intent.status === 'canceled'
        ? 'failed_terminal'
        : 'requires_payment_method';
  if (intent.status === 'canceled') {
    await commitExpiry(db, attempt, claimToken, now);
    return;
  }
  const next = new Date(Math.min(attempt.expires_at.valueOf(), retryAt(attempt, now).valueOf()));
  await db.collection<Attempt>('payment_attempts').updateOne(
    { _id: attempt._id, claim_token: claimToken },
    {
      $set: {
        state,
        stripe_payment_intent_status: intent.status,
        claim_token: null,
        claim_started_at: null,
        next_attempt_at: next,
        failure_category: null,
        updated_at: now,
      },
      $inc: { attempt_count: 1 },
    },
  );
}

async function commitExpiry(
  db: Db,
  attempt: Attempt,
  claimToken: string,
  now: Date,
): Promise<void> {
  const session = db.client.startSession();
  try {
    await session.withTransaction(async () => {
      const updated = await db.collection<Attempt>('payment_attempts').updateOne(
        { _id: attempt._id, claim_token: claimToken, slot_released: false },
        {
          $set: {
            state: 'expired',
            slot_released: true,
            stripe_payment_intent_status: 'canceled',
            claim_token: null,
            claim_started_at: null,
            failure_category: 'expired',
            reconciliation_requeue_request_id: null,
            updated_at: now,
          },
          $inc: { attempt_count: 1 },
        },
        { session },
      );
      if (updated.modifiedCount !== 1) throw new Error('reconciliation_claim_lost');
      const appointment = await db
        .collection('appointments')
        .updateOne(
          { _id: attempt.appointment_id, tenant_id: attempt.tenant_id, status: 'payment_pending' },
          { $set: { status: 'payment_expired', updated_at: now }, $inc: { version: 1 } },
          { session },
        );
      if (appointment.modifiedCount !== 1) throw new Error('appointment_state_conflict');
      await appendEvidence(db, attempt, session, 'payment_expired', 'expiry', now);
      await appendAudit(
        db,
        attempt,
        session,
        'payment_hold_expired',
        'success',
        'authoritative_unpaid',
      );
    });
  } finally {
    await session.endSession();
  }
}

async function retryOrEscalate(
  db: Db,
  attempt: Attempt,
  claimToken: string,
  now: Date,
  reason: string,
  known?: { state: string; stripeStatus: string },
): Promise<void> {
  const count = attempt.attempt_count + 1;
  if (count < MAX_RECONCILIATION_ATTEMPTS) {
    await db.collection<Attempt>('payment_attempts').updateOne(
      { _id: attempt._id, claim_token: claimToken },
      {
        $set: {
          ...(known
            ? { state: known.state, stripe_payment_intent_status: known.stripeStatus }
            : {}),
          claim_token: null,
          claim_started_at: null,
          next_attempt_at: retryAt(attempt, now),
          failure_category: reason === 'stripe_processing' ? null : 'unknown',
          updated_at: now,
        },
        $inc: { attempt_count: 1 },
      },
    );
    if (attempt.state === 'succeeded_unfinalized')
      await upsertOperationsAlert(db, attempt, reason, now);
    return;
  }
  const session = db.client.startSession();
  try {
    await session.withTransaction(async () => {
      const updated = await db.collection<Attempt>('payment_attempts').updateOne(
        { _id: attempt._id, claim_token: claimToken, slot_released: false },
        {
          $set: {
            state: 'manual_review',
            claim_token: null,
            claim_started_at: null,
            failure_category:
              attempt.state === 'succeeded_unfinalized' ? 'local_finalization' : 'unknown',
            reconciliation_requeue_request_id: null,
            updated_at: now,
          },
          $inc: { attempt_count: 1 },
        },
        { session },
      );
      if (updated.modifiedCount !== 1) throw new Error('reconciliation_claim_lost');
      await appendEvidence(db, attempt, session, 'manual_review', `exhausted:${reason}`, now);
      await appendAudit(
        db,
        attempt,
        session,
        'payment_reconciliation_exhausted',
        'failure',
        reason,
      );
      await upsertOperationsAlert(db, attempt, reason, now, session);
    });
  } finally {
    await session.endSession();
  }
}

async function upsertOperationsAlert(
  db: Db,
  attempt: Attempt,
  reason: string,
  now: Date,
  session?: ClientSession,
) {
  await db.collection('payment_operations_alerts').updateOne(
    { payment_attempt_id: attempt._id, category: 'reconciliation_actionable' },
    {
      $set: {
        priority: attempt.state === 'succeeded_unfinalized' ? 'highest' : 'standard',
        resolution_target:
          attempt.state === 'succeeded_unfinalized'
            ? 'one_hour_during_operating_hours'
            : 'same_business_day',
        status: 'open',
        reason,
      },
      $setOnInsert: {
        _id: new ObjectId(),
        public_id: randomUUID(),
        tenant_id: attempt.tenant_id,
        payment_attempt_id: attempt._id,
        payment_attempt_public_id: attempt.public_id,
        category: 'reconciliation_actionable',
        created_at: now,
      },
    },
    { upsert: true, ...(session ? { session } : {}) },
  );
}

export function retryAt(attempt: Pick<Attempt, 'public_id' | 'attempt_count'>, now: Date): Date {
  const index = Math.min(attempt.attempt_count + 1, RECONCILIATION_DELAYS_MILLISECONDS.length - 1);
  const base = RECONCILIATION_DELAYS_MILLISECONDS[index]!;
  const digest = createHash('sha256').update(`${attempt.public_id}:${index}`).digest();
  const fraction = digest.readUInt16BE(0) / 65_535;
  const jitter = (fraction * 0.3 - 0.15) * base;
  return new Date(now.valueOf() + Math.round(base + jitter));
}

async function appendEvidence(
  db: Db,
  attempt: Attempt,
  session: ClientSession,
  kind: string,
  suffix: string,
  now: Date,
) {
  const key = `reconciliation:${suffix}`;
  const ledger = db.collection('payment_ledger_entries');
  if (
    await ledger.findOne(
      {
        tenant_id: attempt.tenant_id,
        source_identity: attempt.public_id,
        source_idempotency_key: key,
      },
      { session },
    )
  )
    return;
  const sequence =
    (await ledger.countDocuments({ payment_attempt_id: attempt._id }, { session })) + 1;
  await ledger.insertOne(
    {
      _id: new ObjectId(),
      public_id: randomUUID(),
      tenant_id: attempt.tenant_id,
      appointment_id: attempt.appointment_id,
      payment_attempt_id: attempt._id,
      entry_kind: kind,
      sequence,
      currency: 'USD',
      ...attempt.amount_snapshot,
      source_identity: attempt.public_id,
      source_idempotency_key: key,
      stripe_object_id: attempt.stripe_payment_intent_id,
      stripe_event_id: null,
      effective_at: now,
      request_id: `reconciliation:${attempt.public_id}`,
      correlation_id: attempt.correlation_id,
      created_at: now,
    },
    { session },
  );
}

async function appendAudit(
  db: Db,
  attempt: Attempt,
  session: ClientSession,
  event: string,
  outcome: 'success' | 'failure',
  reason: string,
) {
  await db.collection('audit_logs').insertOne(
    {
      public_id: randomUUID(),
      event,
      outcome,
      actor_user_id: null,
      tenant_id: attempt.tenant_id,
      request_id: `reconciliation:${attempt.public_id}`,
      metadata: {
        payment_attempt_public_id: attempt.public_id,
        payment_intent_id: attempt.stripe_payment_intent_id,
        reason,
      },
      created_at: new Date(),
    },
    { session },
  );
}

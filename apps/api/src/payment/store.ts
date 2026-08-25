import { randomUUID } from 'node:crypto';
import { type ClientSession, type Collection, type Db, MongoServerError, ObjectId } from 'mongodb';

import type { AppointmentDocument } from '../admin/store.js';
import {
  type PaymentAmounts,
  type PaymentAttemptState,
  type PaymentTermsEvidence,
  type PaymentTransitionEvent,
  type ProvisionalAppointmentStatus,
  calculatePaymentAmounts,
  normalizeServicePaymentConfiguration,
  transitionPaymentAttempt,
} from './domain.js';
import type { PaymentIntentView } from '../stripe/adapter.js';

export interface TenantBookingFeeVersionDocument {
  _id: ObjectId;
  public_id: string;
  tenant_id: ObjectId;
  version: number;
  amount_minor: number;
  currency: 'USD';
  operator_id: string;
  reason: string;
  request_id: string;
  idempotency_key_hash: string;
  request_fingerprint: string;
  created_at: Date;
}

export interface TenantBookingFeeActiveDocument {
  _id: ObjectId;
  tenant_id: ObjectId;
  fee_version_id: ObjectId;
  fee_version_public_id: string;
  version: number;
  amount_minor: number;
  currency: 'USD';
  activated_at: Date;
  activated_by_operator_id: string;
  activation_request_id: string;
}

export interface ServicePaymentConfigurationVersionDocument {
  _id: ObjectId;
  public_id: string;
  tenant_id: ObjectId;
  service_id: ObjectId;
  service_public_id: string;
  version: number;
  payment_mode: 'none' | 'fixed_deposit' | 'full';
  fixed_deposit_minor: number | null;
  currency: 'USD';
  request_id: string;
  idempotency_key_hash: string;
  request_fingerprint: string;
  changed_by_user_id: ObjectId;
  changed_by_membership_id: ObjectId;
  created_at: Date;
}

export interface ServicePaymentConfigurationActiveDocument {
  _id: ObjectId;
  tenant_id: ObjectId;
  service_id: ObjectId;
  configuration_version_id: ObjectId;
  configuration_public_id: string;
  version: number;
  payment_mode: 'none' | 'fixed_deposit' | 'full';
  fixed_deposit_minor: number | null;
  currency: 'USD';
  activated_at: Date;
  activation_request_id: string;
}

interface TenantPaymentExecutionSettingDocument {
  _id: ObjectId;
  tenant_id: ObjectId;
  enabled: boolean;
  currency: 'USD';
  approved_by_operator_id: string;
  approval_request_id: string;
  updated_at: Date;
}

interface TenantStripePaymentAccountDocument {
  public_id: string;
  tenant_id: ObjectId;
  stripe_account_id: string;
  active: boolean;
  default_currency: string;
  charges_enabled: boolean;
  capabilities: { card_payments?: string };
  requirements: {
    disabled_reason?: string | null;
    currently_due?: string[];
    past_due?: string[];
  };
  disconnected_at: Date | null;
  last_synced_at: Date | null;
}

export interface PaymentAttemptDocument {
  _id: ObjectId;
  public_id: string;
  tenant_id: ObjectId;
  appointment_id: ObjectId;
  customer_id: ObjectId;
  customer_email_normalized: string;
  tenant_stripe_account_public_id: string;
  idempotency_key_hash: string;
  request_fingerprint: string;
  client_request_fingerprint: string;
  recovery_token_hash: string;
  recovery_hostname_hash: string;
  recovery_expires_at: Date;
  amount_snapshot: PaymentAmountsSnake;
  configuration_snapshot: {
    service_payment_configuration_public_id: string;
    service_payment_configuration_version: number;
    deposit_version_public_id: string | null;
    fee_configuration_public_id: string;
    fee_version: number;
  };
  payment_terms_acceptance: PaymentTermsEvidence;
  stripe_payment_intent_id: string | null;
  stripe_payment_intent_status: string | null;
  state: PaymentAttemptState;
  expires_at: Date;
  slot_released: boolean;
  claim_token: string | null;
  claim_started_at: Date | null;
  attempt_count: number;
  next_attempt_at: Date;
  failure_category:
    | 'stripe_creation'
    | 'card_declined'
    | 'terminal_payment'
    | 'expired'
    | 'stale'
    | 'local_finalization'
    | 'unknown'
    | null;
  request_id: string;
  correlation_id: string;
  created_at: Date;
  updated_at: Date;
}

export interface PaymentLedgerEntryDocument {
  _id: ObjectId;
  public_id: string;
  tenant_id: ObjectId;
  appointment_id: ObjectId;
  payment_attempt_id: ObjectId;
  entry_kind:
    | 'intent_requested'
    | 'payment_succeeded'
    | 'payment_failed_recoverable'
    | 'payment_failed_terminal'
    | 'payment_expired'
    | 'payment_stale'
    | 'refund_created_external'
    | 'refund_updated_external'
    | 'refund_failed_external'
    | 'dispute_evidence'
    | 'manual_review'
    | 'reconciliation';
  sequence: number;
  currency: 'USD';
  service_price_minor: number;
  provider_amount_due_now_minor: number;
  booknowtech_fee_minor: number;
  customer_total_due_now_minor: number;
  application_fee_amount_minor: number;
  remaining_service_balance_minor: number;
  source_identity: string;
  source_idempotency_key: string;
  stripe_object_id: string | null;
  stripe_event_id: string | null;
  effective_at: Date;
  request_id: string;
  correlation_id: string;
  created_at: Date;
}

type PaymentAmountsSnake = {
  service_price_minor: number;
  payment_mode: 'fixed_deposit' | 'full';
  fixed_deposit_minor: number | null;
  provider_amount_due_now_minor: number;
  booknowtech_fee_minor: number;
  customer_total_due_now_minor: number;
  application_fee_amount_minor: number;
  remaining_service_balance_minor: number;
  currency: 'USD';
};

export class PaymentFoundationStore {
  private readonly feeVersions: Collection<TenantBookingFeeVersionDocument>;
  private readonly activeFees: Collection<TenantBookingFeeActiveDocument>;
  private readonly serviceVersions: Collection<ServicePaymentConfigurationVersionDocument>;
  private readonly serviceActive: Collection<ServicePaymentConfigurationActiveDocument>;
  private readonly attempts: Collection<PaymentAttemptDocument>;
  private readonly ledger: Collection<PaymentLedgerEntryDocument>;
  private readonly auditLogs: Collection;
  private readonly appointments: Collection<{
    _id: ObjectId;
    tenant_id: ObjectId;
    status: ProvisionalAppointmentStatus;
  }>;

  public constructor(private readonly db: Db) {
    this.feeVersions = db.collection('tenant_booking_fee_versions');
    this.activeFees = db.collection('tenant_booking_fee_active');
    this.serviceVersions = db.collection('service_payment_configuration_versions');
    this.serviceActive = db.collection('service_payment_configuration_active');
    this.attempts = db.collection('payment_attempts');
    this.ledger = db.collection('payment_ledger_entries');
    this.auditLogs = db.collection('audit_logs');
    this.appointments = db.collection('appointments');
  }

  public async activateTenantBookingFee(input: {
    tenantId: ObjectId;
    amountMinor: number;
    operatorId: string;
    reason: string;
    requestId: string;
    idempotencyKeyHash: string;
    requestFingerprint: string;
  }): Promise<TenantBookingFeeActiveDocument> {
    assertMinor(input.amountMinor);
    const session = this.db.client.startSession();
    try {
      const result = await session.withTransaction(async () => {
        const replay = await this.feeVersions.findOne(
          { tenant_id: input.tenantId, idempotency_key_hash: input.idempotencyKeyHash },
          { session },
        );
        if (replay) {
          if (replay.request_fingerprint !== input.requestFingerprint)
            throw new Error('idempotency_conflict');
          const active = await this.activeFees.findOne(
            { tenant_id: input.tenantId, fee_version_id: replay._id },
            { session },
          );
          if (!active) throw new Error('fee_replay_not_active');
          return active;
        }
        const current = await this.activeFees.findOne({ tenant_id: input.tenantId }, { session });
        const version: TenantBookingFeeVersionDocument = {
          _id: new ObjectId(),
          public_id: randomUUID(),
          tenant_id: input.tenantId,
          version: (current?.version ?? 0) + 1,
          amount_minor: input.amountMinor,
          currency: 'USD',
          operator_id: input.operatorId,
          reason: input.reason,
          request_id: input.requestId,
          idempotency_key_hash: input.idempotencyKeyHash,
          request_fingerprint: input.requestFingerprint,
          created_at: new Date(),
        };
        await this.feeVersions.insertOne(version, { session });
        const pointer: TenantBookingFeeActiveDocument = {
          _id: current?._id ?? new ObjectId(),
          tenant_id: input.tenantId,
          fee_version_id: version._id,
          fee_version_public_id: version.public_id,
          version: version.version,
          amount_minor: version.amount_minor,
          currency: 'USD',
          activated_at: version.created_at,
          activated_by_operator_id: input.operatorId,
          activation_request_id: input.requestId,
        };
        if (current) {
          const updated = await this.activeFees.replaceOne(
            { _id: current._id, tenant_id: input.tenantId, version: current.version },
            pointer,
            { session },
          );
          if (updated.modifiedCount !== 1) throw new Error('fee_activation_conflict');
        } else await this.activeFees.insertOne(pointer, { session });
        await this.auditLogs.insertOne(
          {
            public_id: randomUUID(),
            event: 'tenant_booking_fee_version_activated',
            outcome: 'success',
            actor_user_id: null,
            tenant_id: input.tenantId,
            request_id: input.requestId,
            metadata: {
              operator_id: input.operatorId,
              prior_fee_version_public_id: current?.fee_version_public_id ?? null,
              fee_version_public_id: version.public_id,
              prior_amount_minor: current ? String(current.amount_minor) : null,
              amount_minor: String(version.amount_minor),
              version: String(version.version),
            },
            created_at: version.created_at,
          },
          { session },
        );
        return pointer;
      });
      if (!result) throw new Error('fee_activation_no_result');
      return result;
    } finally {
      await session.endSession();
    }
  }

  public async activateServicePaymentConfiguration(input: {
    tenantId: ObjectId;
    serviceId: ObjectId;
    servicePublicId: string;
    servicePriceMinor: number;
    paymentMode: 'none' | 'fixed_deposit' | 'full';
    fixedDepositMinor?: number | null;
    requestId: string;
    idempotencyKeyHash: string;
    requestFingerprint: string;
    userId: ObjectId;
    membershipId: ObjectId;
  }): Promise<ServicePaymentConfigurationVersionDocument> {
    const normalized = normalizeServicePaymentConfiguration(input);
    const session = this.db.client.startSession();
    try {
      const result = await session.withTransaction(async () => {
        const replay = await this.serviceVersions.findOne(
          {
            tenant_id: input.tenantId,
            service_id: input.serviceId,
            idempotency_key_hash: input.idempotencyKeyHash,
          },
          { session },
        );
        if (replay) {
          if (replay.request_fingerprint !== input.requestFingerprint)
            throw new Error('idempotency_conflict');
          return replay;
        }
        const current = await this.serviceActive.findOne(
          { tenant_id: input.tenantId, service_id: input.serviceId },
          { session },
        );
        const version: ServicePaymentConfigurationVersionDocument = {
          _id: new ObjectId(),
          public_id: randomUUID(),
          tenant_id: input.tenantId,
          service_id: input.serviceId,
          service_public_id: input.servicePublicId,
          version: Number(current?.version ?? 0) + 1,
          payment_mode: normalized.paymentMode,
          fixed_deposit_minor: normalized.fixedDepositMinor,
          currency: 'USD',
          request_id: input.requestId,
          idempotency_key_hash: input.idempotencyKeyHash,
          request_fingerprint: input.requestFingerprint,
          changed_by_user_id: input.userId,
          changed_by_membership_id: input.membershipId,
          created_at: new Date(),
        };
        await this.serviceVersions.insertOne(version, { session });
        await this.serviceActive.replaceOne(
          { tenant_id: input.tenantId, service_id: input.serviceId },
          {
            tenant_id: input.tenantId,
            service_id: input.serviceId,
            configuration_version_id: version._id,
            configuration_public_id: version.public_id,
            version: version.version,
            payment_mode: version.payment_mode,
            fixed_deposit_minor: version.fixed_deposit_minor,
            currency: 'USD',
            activated_at: version.created_at,
            activation_request_id: input.requestId,
          },
          { upsert: true, session },
        );
        await this.auditLogs.insertOne(
          {
            public_id: randomUUID(),
            event: 'service_payment_configuration_activated',
            outcome: 'success',
            actor_user_id: input.userId,
            tenant_id: input.tenantId,
            request_id: input.requestId,
            metadata: {
              service_public_id: input.servicePublicId,
              configuration_public_id: version.public_id,
              version: String(version.version),
              payment_mode: version.payment_mode,
              fixed_deposit_minor:
                version.fixed_deposit_minor === null ? null : String(version.fixed_deposit_minor),
            },
            created_at: version.created_at,
          },
          { session },
        );
        return version;
      });
      if (!result) throw new Error('service_payment_activation_no_result');
      return result;
    } finally {
      await session.endSession();
    }
  }

  public async insertPaymentAttempt(
    input: Omit<PaymentAttemptDocument, '_id' | 'created_at' | 'updated_at'>,
    session?: ClientSession,
  ): Promise<{ attempt: PaymentAttemptDocument; replayed: boolean }> {
    assertInitialPaymentAttempt(input);
    const existing = await this.attempts.findOne(
      { tenant_id: input.tenant_id, idempotency_key_hash: input.idempotency_key_hash },
      session ? { session } : undefined,
    );
    if (existing) {
      if (existing.request_fingerprint !== input.request_fingerprint)
        throw new Error('idempotency_conflict');
      return { attempt: existing, replayed: true };
    }
    const now = new Date();
    const attempt: PaymentAttemptDocument = {
      ...input,
      _id: new ObjectId(),
      created_at: now,
      updated_at: now,
    };
    try {
      await this.attempts.insertOne(attempt, session ? { session } : undefined);
      return { attempt, replayed: false };
    } catch (error) {
      if (!isDuplicate(error)) throw error;
      const raced = await this.attempts.findOne({
        tenant_id: input.tenant_id,
        idempotency_key_hash: input.idempotency_key_hash,
      });
      if (!raced || raced.request_fingerprint !== input.request_fingerprint)
        throw new Error('idempotency_conflict', { cause: error });
      return { attempt: raced, replayed: true };
    }
  }

  public getAttemptByPublicId(tenantId: ObjectId, attemptPublicId: string) {
    return this.attempts.findOne({ tenant_id: tenantId, public_id: attemptPublicId });
  }

  public getAttemptByIdempotency(
    tenantId: ObjectId,
    idempotencyKeyHash: string,
    session?: ClientSession,
  ) {
    return this.attempts.findOne(
      {
        tenant_id: tenantId,
        idempotency_key_hash: idempotencyKeyHash,
      },
      session ? { session } : undefined,
    );
  }

  public async createProvisionalCustomerEvidence(
    input: {
      tenantId: ObjectId;
      firstName: string;
      lastName: string;
      emailNormalized: string;
      mobilePhoneE164: string;
      customerInputHash: string;
    },
    session: ClientSession,
  ) {
    const record = {
      _id: new ObjectId(),
      public_id: randomUUID(),
      tenant_id: input.tenantId,
      first_name: input.firstName,
      last_name: input.lastName,
      email_normalized: input.emailNormalized,
      mobile_phone_e164: input.mobilePhoneE164,
      customer_input_hash: input.customerInputHash,
      created_at: new Date(),
    };
    await this.db.collection('provisional_payment_customers').insertOne(record, { session });
    return record;
  }

  public async getAttemptContext(
    tenantId: ObjectId,
    attempt: PaymentAttemptDocument,
    session?: ClientSession,
  ) {
    const options = session ? { session } : undefined;
    const [appointment, customer] = await Promise.all([
      this.db.collection<AppointmentDocument>('appointments').findOne(
        {
          _id: attempt.appointment_id,
          tenant_id: tenantId,
        },
        options,
      ),
      this.db.collection('provisional_payment_customers').findOne(
        {
          _id: attempt.customer_id,
          tenant_id: tenantId,
        },
        options,
      ),
    ]);
    if (!appointment || !customer) throw new Error('payment_attempt_context_missing');
    return { appointment, customer };
  }

  public getSnapshottedStripeAccount(
    tenantId: ObjectId,
    associationPublicId: string,
    session?: ClientSession,
  ) {
    return this.db.collection<TenantStripePaymentAccountDocument>('tenant_stripe_accounts').findOne(
      {
        tenant_id: tenantId,
        public_id: associationPublicId,
      },
      session ? { session } : undefined,
    );
  }

  public async executionSnapshot(tenantId: ObjectId, serviceId: ObjectId, session?: ClientSession) {
    const options = session ? { session } : undefined;
    const [tenantSetting, serviceConfiguration, fee, account] = await Promise.all([
      this.db
        .collection<TenantPaymentExecutionSettingDocument>('tenant_payment_execution_settings')
        .findOne({ tenant_id: tenantId, enabled: true }, options),
      this.serviceActive.findOne({ tenant_id: tenantId, service_id: serviceId }, options),
      this.activeFees.findOne({ tenant_id: tenantId }, options),
      this.db
        .collection<TenantStripePaymentAccountDocument>('tenant_stripe_accounts')
        .findOne({ tenant_id: tenantId, active: true }, options),
    ]);
    return { tenantSetting, serviceConfiguration, fee, account };
  }

  public async linkPaymentIntent(input: {
    tenantId: ObjectId;
    attemptPublicId: string;
    intent: PaymentIntentView;
  }): Promise<PaymentAttemptDocument> {
    const state = paymentIntentAttemptState(input.intent.status);
    const session = this.db.client.startSession();
    try {
      const updated = await session.withTransaction(async () => {
        const attempt = await this.attempts.findOneAndUpdate(
          {
            tenant_id: input.tenantId,
            public_id: input.attemptPublicId,
            $or: [
              { stripe_payment_intent_id: null },
              { stripe_payment_intent_id: input.intent.id },
            ],
            state: {
              $in: [
                'requested',
                'stripe_creation_processing',
                'requires_payment_method',
                'requires_customer_action',
                'processing',
                'failed_recoverable',
              ],
            },
          },
          {
            $set: {
              stripe_payment_intent_id: input.intent.id,
              stripe_payment_intent_status: input.intent.status,
              state,
              failure_category: input.intent.status === 'canceled' ? 'terminal_payment' : null,
              updated_at: new Date(),
            },
          },
          { returnDocument: 'after', session },
        );
        if (!attempt) throw new Error('payment_intent_link_conflict');
        if (state !== 'failed_terminal' || attempt.slot_released) return attempt;
        const released = await this.attempts.findOneAndUpdate(
          { _id: attempt._id, slot_released: false },
          { $set: { slot_released: true, updated_at: new Date() } },
          { returnDocument: 'after', session },
        );
        if (!released) throw new Error('payment_attempt_release_conflict');
        const appointment = await this.appointments.updateOne(
          { _id: attempt.appointment_id, tenant_id: input.tenantId, status: 'payment_pending' },
          { $set: { status: 'payment_failed', updated_at: new Date() }, $inc: { version: 1 } },
          { session },
        );
        if (appointment.modifiedCount !== 1) throw new Error('appointment_state_conflict');
        return released;
      });
      if (!updated) throw new Error('payment_intent_link_no_result');
      return updated;
    } finally {
      await session.endSession();
    }
  }

  public async markAttemptStaleInSession(
    tenantId: ObjectId,
    attempt: PaymentAttemptDocument,
    session: ClientSession,
  ): Promise<boolean> {
    if (attempt.slot_released || ['succeeded', 'succeeded_unfinalized'].includes(attempt.state))
      return false;
    const updated = await this.attempts.updateOne(
      {
        _id: attempt._id,
        tenant_id: tenantId,
        state: attempt.state,
        slot_released: false,
      },
      {
        $set: {
          state: 'stale',
          slot_released: true,
          failure_category: 'stale',
          updated_at: new Date(),
        },
      },
      { session },
    );
    if (updated.modifiedCount !== 1) return false;
    const appointment = await this.appointments.updateOne(
      {
        _id: attempt.appointment_id,
        tenant_id: tenantId,
        status: 'payment_pending',
      },
      { $set: { status: 'payment_failed', updated_at: new Date() }, $inc: { version: 1 } },
      { session },
    );
    if (appointment.modifiedCount !== 1) throw new Error('appointment_state_conflict');
    return true;
  }

  public async markAttemptStale(tenantId: ObjectId, attempt: PaymentAttemptDocument) {
    const session = this.db.client.startSession();
    try {
      return await session.withTransaction(() =>
        this.markAttemptStaleInSession(tenantId, attempt, session),
      );
    } finally {
      await session.endSession();
    }
  }

  public async appendLedgerEntry(
    input: Omit<PaymentLedgerEntryDocument, '_id' | 'public_id' | 'created_at'>,
    session?: ClientSession,
  ): Promise<PaymentLedgerEntryDocument> {
    const entry: PaymentLedgerEntryDocument = {
      ...input,
      _id: new ObjectId(),
      public_id: randomUUID(),
      created_at: new Date(),
    };
    await this.ledger.insertOne(entry, session ? { session } : undefined);
    return entry;
  }

  public async transitionAttempt(input: {
    tenantId: ObjectId;
    attemptPublicId: string;
    event: PaymentTransitionEvent;
  }): Promise<{ attempt: PaymentAttemptDocument; releaseSlot: boolean }> {
    for (let retry = 0; retry < 5; retry += 1) {
      const attempt = await this.attempts.findOne({
        tenant_id: input.tenantId,
        public_id: input.attemptPublicId,
      });
      if (!attempt) throw new Error('payment_attempt_not_found');
      const appointment = await this.appointments.findOne({
        _id: attempt.appointment_id,
        tenant_id: input.tenantId,
      });
      if (!appointment) throw new Error('provisional_appointment_not_found');
      const transition = transitionPaymentAttempt({
        attemptState: attempt.state,
        appointmentStatus: appointment.status,
        slotReleased: attempt.slot_released,
        event: input.event,
      });
      if (!transition.changed) return { attempt, releaseSlot: false };
      const session = this.db.client.startSession();
      try {
        const result = await session.withTransaction(async () => {
          const updatedAttempt = await this.attempts.findOneAndUpdate(
            {
              _id: attempt._id,
              tenant_id: input.tenantId,
              state: attempt.state,
              slot_released: attempt.slot_released,
            },
            {
              $set: {
                state: transition.attemptState,
                slot_released: transition.slotReleased,
                updated_at: new Date(),
              },
            },
            { session, returnDocument: 'after' },
          );
          if (!updatedAttempt) return null;
          const updatedAppointment = await this.appointments.updateOne(
            { _id: attempt.appointment_id, tenant_id: input.tenantId, status: appointment.status },
            {
              $set: { status: transition.appointmentStatus, updated_at: new Date() },
              $inc: { version: 1 },
            },
            { session },
          );
          if (updatedAppointment.modifiedCount !== 1) throw new Error('appointment_state_conflict');
          return updatedAttempt;
        });
        if (result) return { attempt: result, releaseSlot: transition.releaseSlot };
      } finally {
        await session.endSession();
      }
    }
    throw new Error('payment_transition_conflict');
  }
}

export function toAmountSnapshot(amounts: PaymentAmounts): PaymentAmountsSnake {
  return {
    service_price_minor: amounts.servicePriceMinor,
    payment_mode: amounts.paymentMode,
    fixed_deposit_minor: amounts.fixedDepositMinor,
    provider_amount_due_now_minor: amounts.providerAmountDueNowMinor,
    booknowtech_fee_minor: amounts.booknowtechFeeMinor,
    customer_total_due_now_minor: amounts.customerTotalDueNowMinor,
    application_fee_amount_minor: amounts.applicationFeeAmountMinor,
    remaining_service_balance_minor: amounts.remainingServiceBalanceMinor,
    currency: amounts.currency,
  };
}

function assertMinor(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid_money_amount');
}

function assertInitialPaymentAttempt(
  input: Omit<PaymentAttemptDocument, '_id' | 'created_at' | 'updated_at'>,
): void {
  if (input.state !== 'requested') throw new Error('initial_attempt_state_invalid');
  if (input.stripe_payment_intent_id !== null || input.stripe_payment_intent_status !== null)
    throw new Error('initial_attempt_stripe_fields_forbidden');
  if (input.slot_released || input.claim_token !== null || input.claim_started_at !== null)
    throw new Error('initial_attempt_recovery_fields_invalid');
  if (input.attempt_count !== 0 || input.failure_category !== null)
    throw new Error('initial_attempt_failure_fields_invalid');
  if (input.payment_terms_acceptance.payment_attempt_public_id !== input.public_id)
    throw new Error('attempt_terms_public_id_mismatch');
  if (input.payment_terms_acceptance.idempotency_key_hash !== input.idempotency_key_hash)
    throw new Error('attempt_terms_idempotency_mismatch');
  if (!/^[a-f0-9]{64}$/u.test(input.client_request_fingerprint))
    throw new Error('attempt_client_fingerprint_invalid');
  if (
    !/^[a-f0-9]{64}$/u.test(input.recovery_token_hash) ||
    !/^[a-f0-9]{64}$/u.test(input.recovery_hostname_hash) ||
    !Number.isFinite(input.recovery_expires_at.valueOf()) ||
    input.recovery_expires_at <= input.expires_at
  )
    throw new Error('attempt_checkout_recovery_invalid');
  const expectedAmounts = toAmountSnapshot(
    calculatePaymentAmounts({
      servicePriceMinor: input.amount_snapshot.service_price_minor,
      paymentMode: input.amount_snapshot.payment_mode,
      fixedDepositMinor: input.amount_snapshot.fixed_deposit_minor,
      booknowtechFeeMinor: input.amount_snapshot.booknowtech_fee_minor,
      currency: input.amount_snapshot.currency,
    }),
  );
  if (JSON.stringify(expectedAmounts) !== JSON.stringify(input.amount_snapshot))
    throw new Error('attempt_amount_snapshot_invalid');
  if (
    !Number.isFinite(input.expires_at.valueOf()) ||
    !Number.isFinite(input.next_attempt_at.valueOf())
  )
    throw new Error('attempt_timestamp_invalid');
}

function isDuplicate(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11_000;
}

function paymentIntentAttemptState(status: PaymentIntentView['status']): PaymentAttemptState {
  switch (status) {
    case 'requires_payment_method':
    case 'requires_confirmation':
      return 'requires_payment_method';
    case 'requires_action':
      return 'requires_customer_action';
    case 'processing':
      return 'processing';
    case 'canceled':
      return 'failed_terminal';
    case 'succeeded':
      return 'succeeded_unfinalized';
  }
}

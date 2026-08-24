import { randomUUID } from 'node:crypto';
import { type ClientSession, type Collection, type Db, MongoServerError, ObjectId } from 'mongodb';

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

export interface PaymentAttemptDocument {
  _id: ObjectId;
  public_id: string;
  tenant_id: ObjectId;
  appointment_id: ObjectId;
  customer_id: ObjectId;
  tenant_stripe_account_public_id: string;
  idempotency_key_hash: string;
  request_fingerprint: string;
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

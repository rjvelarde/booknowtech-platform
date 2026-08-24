import { createHash, createHmac } from 'node:crypto';

export const PAYMENT_MODES = ['none', 'fixed_deposit', 'full'] as const;
export const STRIPE_MAX_AMOUNT_MINOR = 99_999_999;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

export const PAYMENT_ATTEMPT_STATES = [
  'requested',
  'stripe_creation_processing',
  'requires_payment_method',
  'requires_customer_action',
  'processing',
  'succeeded_unfinalized',
  'succeeded',
  'failed_recoverable',
  'failed_terminal',
  'expired',
  'stale',
  'manual_review',
] as const;
export type PaymentAttemptState = (typeof PAYMENT_ATTEMPT_STATES)[number];

export type ProvisionalAppointmentStatus =
  'payment_pending' | 'payment_failed' | 'payment_expired' | 'scheduled';

export interface ServicePaymentConfiguration {
  paymentMode: PaymentMode;
  fixedDepositMinor: number | null;
}

export function normalizeServicePaymentConfiguration(input: {
  servicePriceMinor: number;
  paymentMode: PaymentMode;
  fixedDepositMinor?: number | null;
}): ServicePaymentConfiguration {
  assertMoney(input.servicePriceMinor, 'service_price_minor');
  const deposit = input.fixedDepositMinor ?? null;
  if (input.servicePriceMinor === 0) {
    if (input.paymentMode !== 'none' || (deposit !== null && deposit !== 0))
      throw new Error('zero_price_requires_none');
    return { paymentMode: 'none', fixedDepositMinor: null };
  }
  if (input.paymentMode === 'none') {
    if (deposit !== null && deposit !== 0) throw new Error('none_rejects_deposit');
    return { paymentMode: 'none', fixedDepositMinor: null };
  }
  if (input.paymentMode === 'full') {
    if (deposit !== null && deposit !== input.servicePriceMinor)
      throw new Error('full_rejects_partial_deposit');
    return { paymentMode: 'full', fixedDepositMinor: null };
  }
  if (deposit === null) throw new Error('fixed_deposit_required');
  assertMoney(deposit, 'fixed_deposit_minor');
  if (deposit === 0) return { paymentMode: 'none', fixedDepositMinor: null };
  if (deposit === input.servicePriceMinor) return { paymentMode: 'full', fixedDepositMinor: null };
  if (deposit > input.servicePriceMinor) throw new Error('deposit_exceeds_service_price');
  return { paymentMode: 'fixed_deposit', fixedDepositMinor: deposit };
}

export interface PaymentAmounts {
  servicePriceMinor: number;
  paymentMode: 'fixed_deposit' | 'full';
  fixedDepositMinor: number | null;
  providerAmountDueNowMinor: number;
  booknowtechFeeMinor: number;
  customerTotalDueNowMinor: number;
  applicationFeeAmountMinor: number;
  remainingServiceBalanceMinor: number;
  currency: 'USD';
}

export function calculatePaymentAmounts(input: {
  servicePriceMinor: number;
  paymentMode: 'fixed_deposit' | 'full';
  fixedDepositMinor?: number | null;
  booknowtechFeeMinor: number | null;
  currency: 'USD';
}): PaymentAmounts {
  if (input.currency !== 'USD') throw new Error('unsupported_currency');
  assertMoney(input.servicePriceMinor, 'service_price_minor');
  if (input.booknowtechFeeMinor === null) throw new Error('active_booking_fee_required');
  assertMoney(input.booknowtechFeeMinor, 'booknowtech_fee_minor');
  if (input.servicePriceMinor === 0) throw new Error('zero_price_requires_none');
  const normalized = normalizeServicePaymentConfiguration(input);
  if (normalized.paymentMode === 'none') throw new Error('paid_calculator_rejects_none');
  const providerAmountDueNowMinor =
    normalized.paymentMode === 'fixed_deposit'
      ? normalized.fixedDepositMinor!
      : input.servicePriceMinor;
  const customerTotalDueNowMinor = safeAdd(providerAmountDueNowMinor, input.booknowtechFeeMinor);
  if (customerTotalDueNowMinor > STRIPE_MAX_AMOUNT_MINOR)
    throw new Error('stripe_amount_out_of_range');
  return {
    servicePriceMinor: input.servicePriceMinor,
    paymentMode: normalized.paymentMode,
    fixedDepositMinor: normalized.fixedDepositMinor,
    providerAmountDueNowMinor,
    booknowtechFeeMinor: input.booknowtechFeeMinor,
    customerTotalDueNowMinor,
    applicationFeeAmountMinor: input.booknowtechFeeMinor,
    remainingServiceBalanceMinor: input.servicePriceMinor - providerAmountDueNowMinor,
    currency: 'USD',
  };
}

export interface PaymentTermsEvidence {
  version: string;
  document_sha256: string;
  accepted_at: Date;
  request_id: string;
  payment_attempt_public_id: string;
  idempotency_key_hash: string;
  ip_hash: string;
}

export function createPaymentTermsEvidence(input: {
  version: string;
  documentSha256: string;
  acceptedAt: Date;
  requestId: string;
  paymentAttemptPublicId: string;
  idempotencyKeyHash: string;
  ipAddress: string;
  ipHashSecret: string;
}): PaymentTermsEvidence {
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(input.version))
    throw new Error('invalid_payment_terms_version');
  assertHash(input.documentSha256, 'invalid_payment_terms_hash');
  assertHash(input.idempotencyKeyHash, 'invalid_idempotency_key_hash');
  if (!input.requestId || input.requestId.length > 128) throw new Error('invalid_request_id');
  if (!uuidPattern.test(input.paymentAttemptPublicId)) throw new Error('invalid_attempt_public_id');
  if (!input.ipHashSecret || input.ipHashSecret.length < 32)
    throw new Error('invalid_ip_hash_secret');
  return {
    version: input.version,
    document_sha256: input.documentSha256,
    accepted_at: new Date(input.acceptedAt),
    request_id: input.requestId,
    payment_attempt_public_id: input.paymentAttemptPublicId,
    idempotency_key_hash: input.idempotencyKeyHash,
    ip_hash: createHmac('sha256', input.ipHashSecret).update(input.ipAddress).digest('hex'),
  };
}

export interface PaymentAttemptFingerprintInput {
  tenantPublicId: string;
  servicePublicId: string;
  providerPublicId: string;
  startsAt: Date;
  durationMinutes: number;
  customerInputHash: string;
  servicePriceMinor: number;
  paymentMode: 'fixed_deposit' | 'full';
  depositVersionPublicId: string | null;
  fixedDepositMinor: number | null;
  feeVersion: number;
  feeAmountMinor: number;
  feeConfigurationPublicId: string;
  stripeAssociationPublicId: string;
  paymentTermsVersion: string;
  paymentTermsDocumentSha256: string;
  paymentConfigurationVersion: number;
}

export function hashPaymentIdempotencyKey(rawKey: string): string {
  if (!uuidPattern.test(rawKey)) throw new Error('invalid_idempotency_key');
  return createHash('sha256').update(rawKey).digest('hex');
}

export function paymentAttemptFingerprint(input: PaymentAttemptFingerprintInput): string {
  for (const [value, code] of [
    [input.tenantPublicId, 'invalid_tenant_public_id'],
    [input.servicePublicId, 'invalid_service_public_id'],
    [input.providerPublicId, 'invalid_provider_public_id'],
    [input.feeConfigurationPublicId, 'invalid_fee_configuration_public_id'],
    [input.stripeAssociationPublicId, 'invalid_stripe_association_public_id'],
  ] as const)
    if (!uuidPattern.test(value)) throw new Error(code);
  if (input.depositVersionPublicId !== null && !uuidPattern.test(input.depositVersionPublicId))
    throw new Error('invalid_deposit_version_public_id');
  if (!Number.isFinite(input.startsAt.valueOf())) throw new Error('invalid_starts_at');
  if (!Number.isSafeInteger(input.durationMinutes) || input.durationMinutes <= 0)
    throw new Error('invalid_duration_minutes');
  assertMoney(input.servicePriceMinor, 'service_price_minor');
  assertMoney(input.feeAmountMinor, 'fee_amount_minor');
  if (!Number.isSafeInteger(input.feeVersion) || input.feeVersion < 1)
    throw new Error('invalid_fee_version');
  if (
    !Number.isSafeInteger(input.paymentConfigurationVersion) ||
    input.paymentConfigurationVersion < 1
  )
    throw new Error('invalid_payment_configuration_version');
  normalizeServicePaymentConfiguration({
    servicePriceMinor: input.servicePriceMinor,
    paymentMode: input.paymentMode,
    fixedDepositMinor: input.fixedDepositMinor,
  });
  assertHash(input.customerInputHash, 'invalid_customer_input_hash');
  assertHash(input.paymentTermsDocumentSha256, 'invalid_payment_terms_hash');
  const canonical = JSON.stringify({
    schema: 1,
    tenant_public_id: input.tenantPublicId,
    service_public_id: input.servicePublicId,
    provider_public_id: input.providerPublicId,
    starts_at: input.startsAt.toISOString(),
    duration_minutes: input.durationMinutes,
    customer_input_hash: input.customerInputHash,
    service_price_minor: input.servicePriceMinor,
    payment_mode: input.paymentMode,
    deposit_version_public_id: input.depositVersionPublicId,
    fixed_deposit_minor: input.fixedDepositMinor,
    fee_version: input.feeVersion,
    fee_amount_minor: input.feeAmountMinor,
    fee_configuration_public_id: input.feeConfigurationPublicId,
    stripe_association_public_id: input.stripeAssociationPublicId,
    payment_terms_version: input.paymentTermsVersion,
    payment_terms_document_sha256: input.paymentTermsDocumentSha256,
    payment_configuration_version: input.paymentConfigurationVersion,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function authoritativeAttemptChanged(
  before: PaymentAttemptFingerprintInput,
  after: PaymentAttemptFingerprintInput,
): boolean {
  const retainedFee = {
    ...after,
    feeVersion: before.feeVersion,
    feeAmountMinor: before.feeAmountMinor,
    feeConfigurationPublicId: before.feeConfigurationPublicId,
  };
  return paymentAttemptFingerprint(before) !== paymentAttemptFingerprint(retainedFee);
}

export type PaymentTransitionEvent =
  | 'begin_stripe_creation'
  | 'require_payment_method'
  | 'require_customer_action'
  | 'begin_processing'
  | 'recoverable_failure'
  | 'retry_payment_method'
  | 'payment_succeeded'
  | 'finalization_succeeded'
  | 'terminal_failure'
  | 'expire'
  | 'mark_stale'
  | 'escalate_manual_review'
  | 'late_success';

export interface PaymentTransitionInput {
  attemptState: PaymentAttemptState;
  appointmentStatus: ProvisionalAppointmentStatus;
  slotReleased: boolean;
  event: PaymentTransitionEvent;
}

export interface PaymentTransitionResult {
  attemptState: PaymentAttemptState;
  appointmentStatus: ProvisionalAppointmentStatus;
  slotReleased: boolean;
  releaseSlot: boolean;
  changed: boolean;
}

export function transitionPaymentAttempt(input: PaymentTransitionInput): PaymentTransitionResult {
  if (input.event === 'late_success' && ['expired', 'stale'].includes(input.attemptState))
    return result(input, 'manual_review', input.appointmentStatus, false);
  if (input.event === 'payment_succeeded' && payableStates.has(input.attemptState)) {
    if (['expired', 'stale', 'failed_terminal'].includes(input.attemptState))
      return result(input, 'manual_review', input.appointmentStatus, false);
    return result(input, 'succeeded_unfinalized', 'payment_pending', false);
  }
  if (
    input.event === 'finalization_succeeded' &&
    (input.attemptState === 'succeeded_unfinalized' ||
      (input.attemptState === 'manual_review' &&
        !input.slotReleased &&
        input.appointmentStatus === 'payment_pending'))
  )
    return result(input, 'succeeded', 'scheduled', false);
  if (input.event === 'escalate_manual_review' && input.attemptState === 'succeeded_unfinalized')
    return result(input, 'manual_review', 'payment_pending', false);
  if (input.event === 'expire') {
    if (['succeeded_unfinalized', 'succeeded', 'manual_review'].includes(input.attemptState))
      return unchanged(input);
    return terminal(input, 'expired', 'payment_expired');
  }
  if (input.event === 'mark_stale' && payableStates.has(input.attemptState))
    return terminal(input, 'stale', 'payment_failed');
  if (input.event === 'terminal_failure' && payableStates.has(input.attemptState))
    return terminal(input, 'failed_terminal', 'payment_failed');
  const transitions: Partial<
    Record<PaymentTransitionEvent, { from: PaymentAttemptState[]; to: PaymentAttemptState }>
  > = {
    begin_stripe_creation: { from: ['requested'], to: 'stripe_creation_processing' },
    require_payment_method: {
      from: ['stripe_creation_processing', 'requires_customer_action', 'processing'],
      to: 'requires_payment_method',
    },
    require_customer_action: {
      from: ['stripe_creation_processing', 'requires_payment_method', 'failed_recoverable'],
      to: 'requires_customer_action',
    },
    begin_processing: {
      from: ['stripe_creation_processing', 'requires_payment_method', 'requires_customer_action'],
      to: 'processing',
    },
    recoverable_failure: {
      from: [
        'stripe_creation_processing',
        'requires_payment_method',
        'requires_customer_action',
        'processing',
      ],
      to: 'failed_recoverable',
    },
    retry_payment_method: { from: ['failed_recoverable'], to: 'requires_payment_method' },
  };
  const transition = transitions[input.event];
  if (!transition?.from.includes(input.attemptState)) return unchanged(input);
  return result(input, transition.to, 'payment_pending', false);
}

function terminal(
  input: PaymentTransitionInput,
  attemptState: PaymentAttemptState,
  appointmentStatus: ProvisionalAppointmentStatus,
): PaymentTransitionResult {
  if (input.attemptState === attemptState && input.slotReleased) return unchanged(input);
  const releaseSlot = !input.slotReleased;
  return {
    attemptState,
    appointmentStatus,
    slotReleased: true,
    releaseSlot,
    changed:
      input.attemptState !== attemptState ||
      input.appointmentStatus !== appointmentStatus ||
      releaseSlot,
  };
}

function result(
  input: PaymentTransitionInput,
  attemptState: PaymentAttemptState,
  appointmentStatus: ProvisionalAppointmentStatus,
  releaseSlot: boolean,
): PaymentTransitionResult {
  return {
    attemptState,
    appointmentStatus,
    slotReleased: input.slotReleased || releaseSlot,
    releaseSlot,
    changed: input.attemptState !== attemptState || input.appointmentStatus !== appointmentStatus,
  };
}

function unchanged(input: PaymentTransitionInput): PaymentTransitionResult {
  return {
    attemptState: input.attemptState,
    appointmentStatus: input.appointmentStatus,
    slotReleased: input.slotReleased,
    releaseSlot: false,
    changed: false,
  };
}

function assertMoney(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(code);
}

function safeAdd(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value)) throw new Error('money_overflow');
  return value;
}

function assertHash(value: string, code: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(code);
}

const payableStates = new Set<PaymentAttemptState>([
  'requested',
  'stripe_creation_processing',
  'requires_payment_method',
  'requires_customer_action',
  'processing',
  'failed_recoverable',
]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

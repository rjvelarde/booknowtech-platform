import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  type PaymentAttemptFingerprintInput,
  STRIPE_MAX_AMOUNT_MINOR,
  authoritativeAttemptChanged,
  calculatePaymentAmounts,
  createPaymentTermsEvidence,
  hashPaymentIdempotencyKey,
  normalizeServicePaymentConfiguration,
  paymentAttemptFingerprint,
  transitionPaymentAttempt,
} from './domain.js';

describe('PR 14B.1 payment amounts', () => {
  it.each([
    [10_000, 'fixed_deposit', 2_500, 125, 2_625, 7_500],
    [10_000, 'full', null, 125, 10_125, 0],
    [50_000, 'fixed_deposit', 10_000, 100, 10_100, 40_000],
  ] as const)(
    'calculates the locked formula',
    (service, paymentMode, deposit, fee, total, remaining) => {
      expect(
        calculatePaymentAmounts({
          servicePriceMinor: service,
          paymentMode,
          fixedDepositMinor: deposit,
          booknowtechFeeMinor: fee,
          currency: 'USD',
        }),
      ).toMatchObject({
        providerAmountDueNowMinor: paymentMode === 'full' ? service : deposit,
        customerTotalDueNowMinor: total,
        applicationFeeAmountMinor: fee,
        remainingServiceBalanceMinor: remaining,
      });
    },
  );

  it('normalizes accepted boundaries and rejects forbidden deposits', () => {
    expect(
      normalizeServicePaymentConfiguration({
        servicePriceMinor: 10_000,
        paymentMode: 'fixed_deposit',
        fixedDepositMinor: 0,
      }),
    ).toEqual({ paymentMode: 'none', fixedDepositMinor: null });
    expect(
      normalizeServicePaymentConfiguration({
        servicePriceMinor: 10_000,
        paymentMode: 'fixed_deposit',
        fixedDepositMinor: 10_000,
      }),
    ).toEqual({ paymentMode: 'full', fixedDepositMinor: null });
    expect(() =>
      normalizeServicePaymentConfiguration({
        servicePriceMinor: 10_000,
        paymentMode: 'fixed_deposit',
        fixedDepositMinor: 10_001,
      }),
    ).toThrow('deposit_exceeds_service_price');
    expect(() =>
      normalizeServicePaymentConfiguration({ servicePriceMinor: 0, paymentMode: 'full' }),
    ).toThrow('zero_price_requires_none');
  });

  it('rejects invalid integers and overflow', () => {
    expect(() =>
      calculatePaymentAmounts({
        servicePriceMinor: Number.MAX_SAFE_INTEGER,
        paymentMode: 'full',
        booknowtechFeeMinor: 1,
        currency: 'USD',
      }),
    ).toThrow('money_overflow');
    expect(() =>
      calculatePaymentAmounts({
        servicePriceMinor: 100.5,
        paymentMode: 'full',
        booknowtechFeeMinor: 1,
        currency: 'USD',
      }),
    ).toThrow('service_price_minor');
    expect(() =>
      calculatePaymentAmounts({
        servicePriceMinor: -1,
        paymentMode: 'full',
        booknowtechFeeMinor: 1,
        currency: 'USD',
      }),
    ).toThrow('service_price_minor');
    expect(() =>
      calculatePaymentAmounts({
        servicePriceMinor: 100,
        paymentMode: 'full',
        booknowtechFeeMinor: null,
        currency: 'USD',
      }),
    ).toThrow('active_booking_fee_required');
    expect(() =>
      calculatePaymentAmounts({
        servicePriceMinor: 100,
        paymentMode: 'full',
        booknowtechFeeMinor: 1,
        currency: 'EUR' as 'USD',
      }),
    ).toThrow('unsupported_currency');
    expect(
      calculatePaymentAmounts({
        servicePriceMinor: STRIPE_MAX_AMOUNT_MINOR - 1,
        paymentMode: 'full',
        booknowtechFeeMinor: 1,
        currency: 'USD',
      }).customerTotalDueNowMinor,
    ).toBe(STRIPE_MAX_AMOUNT_MINOR);
    expect(() =>
      calculatePaymentAmounts({
        servicePriceMinor: STRIPE_MAX_AMOUNT_MINOR,
        paymentMode: 'full',
        booknowtechFeeMinor: 1,
        currency: 'USD',
      }),
    ).toThrow('stripe_amount_out_of_range');
  });
});

describe('PR 14B.1 payment evidence and fingerprinting', () => {
  const fingerprintInput = (): PaymentAttemptFingerprintInput => ({
    tenantPublicId: randomUUID(),
    servicePublicId: randomUUID(),
    providerPublicId: randomUUID(),
    startsAt: new Date('2026-08-24T14:00:00.000Z'),
    durationMinutes: 60,
    customerInputHash: 'a'.repeat(64),
    servicePriceMinor: 10_000,
    paymentMode: 'fixed_deposit',
    depositVersionPublicId: randomUUID(),
    fixedDepositMinor: 2_500,
    feeVersion: 1,
    feeAmountMinor: 125,
    feeConfigurationPublicId: randomUUID(),
    stripeAssociationPublicId: randomUUID(),
    paymentTermsVersion: 'payments-v1',
    paymentTermsDocumentSha256: 'b'.repeat(64),
    paymentConfigurationVersion: 1,
  });

  it('creates bounded terms evidence without raw IP', () => {
    expect(hashPaymentIdempotencyKey(randomUUID())).toMatch(/^[a-f0-9]{64}$/u);
    expect(() => hashPaymentIdempotencyKey('not-a-uuid')).toThrow('invalid_idempotency_key');
    const evidence = createPaymentTermsEvidence({
      version: 'payments-v1',
      documentSha256: 'b'.repeat(64),
      acceptedAt: new Date('2026-08-24T13:59:00.000Z'),
      requestId: 'request-1',
      paymentAttemptPublicId: randomUUID(),
      idempotencyKeyHash: 'c'.repeat(64),
      ipAddress: '192.0.2.1',
      ipHashSecret: 'x'.repeat(32),
    });
    expect(evidence.ip_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(evidence)).not.toContain('192.0.2.1');
  });

  it('is deterministic, changes for authoritative facts, and ignores later fee versions', () => {
    const before = fingerprintInput();
    expect(paymentAttemptFingerprint(before)).toBe(paymentAttemptFingerprint({ ...before }));
    expect(authoritativeAttemptChanged(before, { ...before, servicePriceMinor: 10_001 })).toBe(
      true,
    );
    expect(
      authoritativeAttemptChanged(before, {
        ...before,
        feeVersion: 2,
        feeAmountMinor: 150,
        feeConfigurationPublicId: randomUUID(),
      }),
    ).toBe(false);
  });
});

describe('PR 14B.1 pure state machine', () => {
  const pending = {
    attemptState: 'requires_payment_method' as const,
    appointmentStatus: 'payment_pending' as const,
    slotReleased: false,
  };

  it('keeps recoverable failures and paid finalization/manual review blocking', () => {
    expect(transitionPaymentAttempt({ ...pending, event: 'recoverable_failure' })).toMatchObject({
      attemptState: 'failed_recoverable',
      appointmentStatus: 'payment_pending',
      releaseSlot: false,
    });
    const succeeded = transitionPaymentAttempt({ ...pending, event: 'payment_succeeded' });
    expect(transitionPaymentAttempt({ ...succeeded, event: 'expire' })).toMatchObject({
      attemptState: 'succeeded_unfinalized',
      appointmentStatus: 'payment_pending',
      releaseSlot: false,
      changed: false,
    });
    expect(
      transitionPaymentAttempt({ ...succeeded, event: 'escalate_manual_review' }),
    ).toMatchObject({
      attemptState: 'manual_review',
      appointmentStatus: 'payment_pending',
      releaseSlot: false,
    });
  });

  it.each([
    ['terminal_failure', 'failed_terminal', 'payment_failed'],
    ['expire', 'expired', 'payment_expired'],
    ['mark_stale', 'stale', 'payment_failed'],
  ] as const)('releases terminal transitions exactly once', (event, state, appointmentStatus) => {
    const first = transitionPaymentAttempt({ ...pending, event });
    expect(first).toMatchObject({
      attemptState: state,
      appointmentStatus,
      slotReleased: true,
      releaseSlot: true,
    });
    expect(transitionPaymentAttempt({ ...first, event })).toMatchObject({
      slotReleased: true,
      releaseSlot: false,
      changed: false,
    });
  });

  it('never silently schedules late success after expiry or staleness', () => {
    for (const attemptState of ['expired', 'stale'] as const) {
      expect(
        transitionPaymentAttempt({
          attemptState,
          appointmentStatus: attemptState === 'expired' ? 'payment_expired' : 'payment_failed',
          slotReleased: true,
          event: 'late_success',
        }),
      ).toMatchObject({ attemptState: 'manual_review', releaseSlot: false });
    }
    const releasedReview = transitionPaymentAttempt({
      attemptState: 'manual_review',
      appointmentStatus: 'payment_expired',
      slotReleased: true,
      event: 'finalization_succeeded',
    });
    expect(releasedReview).toMatchObject({
      attemptState: 'manual_review',
      appointmentStatus: 'payment_expired',
      changed: false,
    });
  });

  it('does not regress finalized success on duplicate success evidence', () => {
    expect(
      transitionPaymentAttempt({
        attemptState: 'succeeded',
        appointmentStatus: 'scheduled',
        slotReleased: false,
        event: 'payment_succeeded',
      }),
    ).toMatchObject({ attemptState: 'succeeded', appointmentStatus: 'scheduled', changed: false });
  });
});

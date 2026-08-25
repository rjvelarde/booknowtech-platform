import { randomUUID } from 'node:crypto';

import { ObjectId } from 'mongodb';
import { describe, expect, it, vi } from 'vitest';

import { PaymentExecutionService, stripePaymentIntentIdempotencyKey } from './execution-service.js';
import type { PaymentAttemptDocument, PaymentFoundationStore } from './store.js';

describe('PR 14B.2 PaymentIntent execution recovery', () => {
  it('uses one deterministic Stripe key and returns but does not persist the client secret', async () => {
    const attempt = attemptFixture();
    const linked = {
      ...attempt,
      state: 'requires_payment_method' as const,
      stripe_payment_intent_id: 'pi_synthetic',
      stripe_payment_intent_status: 'requires_payment_method',
    };
    const store = {
      transitionAttempt: vi.fn().mockResolvedValue({
        attempt: { ...attempt, state: 'stripe_creation_processing' },
      }),
      linkPaymentIntent: vi.fn().mockResolvedValue(linked),
    };
    const stripe = {
      createDirectChargePaymentIntent: vi.fn().mockResolvedValue({
        id: 'pi_synthetic',
        status: 'requires_payment_method',
        clientSecret: 'pi_secret_return_only',
        amount: 2_625,
        applicationFeeAmount: 125,
        currency: 'usd',
      }),
      retrievePaymentIntent: vi.fn(),
      cancelPaymentIntent: vi.fn(),
    };
    const service = new PaymentExecutionService(store as unknown as PaymentFoundationStore, stripe);
    const input = executionInput(attempt);
    const response = await service.ensurePaymentIntent(input);
    expect(response.client_secret).toBe('pi_secret_return_only');
    expect(stripe.createDirectChargePaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        connectedAccountId: 'acct_server_resolved',
        amountMinor: 2_625,
        applicationFeeAmountMinor: 125,
        receiptEmail: 'customer@example.com',
        idempotencyKey: stripePaymentIntentIdempotencyKey(input.tenantPublicId, attempt.public_id),
      }),
    );
    expect(store.linkPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: attempt.tenant_id, attemptPublicId: attempt.public_id }),
    );
    expect(JSON.stringify(linked)).not.toContain('pi_secret_return_only');
  });

  it('retrieves the same intent after local linkage instead of creating another', async () => {
    const attempt = {
      ...attemptFixture(),
      state: 'requires_payment_method' as const,
      stripe_payment_intent_id: 'pi_synthetic',
      stripe_payment_intent_status: 'requires_payment_method',
    };
    const store = { linkPaymentIntent: vi.fn().mockResolvedValue(attempt) };
    const stripe = {
      createDirectChargePaymentIntent: vi.fn(),
      retrievePaymentIntent: vi.fn().mockResolvedValue({
        id: 'pi_synthetic',
        status: 'requires_payment_method',
        clientSecret: 'pi_secret_recovered',
        amount: 2_625,
        applicationFeeAmount: 125,
        currency: 'usd',
      }),
      cancelPaymentIntent: vi.fn(),
    };
    const service = new PaymentExecutionService(store as unknown as PaymentFoundationStore, stripe);
    await service.ensurePaymentIntent(executionInput(attempt));
    expect(stripe.createDirectChargePaymentIntent).not.toHaveBeenCalled();
    expect(stripe.retrievePaymentIntent).toHaveBeenCalledWith({
      connectedAccountId: 'acct_server_resolved',
      paymentIntentId: 'pi_synthetic',
    });
  });

  it('reuses the exact Stripe key after Stripe success and a lost local-link response', async () => {
    const attempt = attemptFixture();
    const processing = { ...attempt, state: 'stripe_creation_processing' as const };
    const store = {
      transitionAttempt: vi.fn().mockResolvedValue({ attempt: processing }),
      linkPaymentIntent: vi
        .fn()
        .mockRejectedValueOnce(new Error('simulated_local_link_loss'))
        .mockResolvedValueOnce({
          ...processing,
          state: 'requires_payment_method',
          stripe_payment_intent_id: 'pi_same',
        }),
    };
    const stripe = {
      createDirectChargePaymentIntent: vi.fn().mockResolvedValue({
        id: 'pi_same',
        status: 'requires_payment_method',
        clientSecret: 'pi_secret_same',
        amount: 2_625,
        applicationFeeAmount: 125,
        currency: 'usd',
      }),
      retrievePaymentIntent: vi.fn(),
      cancelPaymentIntent: vi.fn(),
    };
    const service = new PaymentExecutionService(store as unknown as PaymentFoundationStore, stripe);
    const input = executionInput(attempt);
    await expect(service.ensurePaymentIntent(input)).rejects.toThrow('simulated_local_link_loss');
    await service.ensurePaymentIntent(input);
    expect(stripe.createDirectChargePaymentIntent).toHaveBeenCalledTimes(2);
    expect(stripe.createDirectChargePaymentIntent.mock.calls[0]?.[0].idempotencyKey).toBe(
      stripe.createDirectChargePaymentIntent.mock.calls[1]?.[0].idempotencyKey,
    );
  });
});

function executionInput(attempt: PaymentAttemptDocument) {
  return {
    tenantId: attempt.tenant_id,
    tenantPublicId: randomUUID(),
    connectedAccountId: 'acct_server_resolved',
    customerEmail: attempt.customer_email_normalized,
    appointmentPublicId: randomUUID(),
    appointmentReference: 'BNT-TEST',
    appointmentStatus: 'payment_pending' as const,
    attempt,
  };
}

function attemptFixture(): PaymentAttemptDocument {
  const now = new Date();
  return {
    _id: new ObjectId(),
    public_id: randomUUID(),
    tenant_id: new ObjectId(),
    appointment_id: new ObjectId(),
    customer_id: new ObjectId(),
    customer_email_normalized: 'customer@example.com',
    tenant_stripe_account_public_id: randomUUID(),
    idempotency_key_hash: 'a'.repeat(64),
    request_fingerprint: 'b'.repeat(64),
    client_request_fingerprint: 'e'.repeat(64),
    amount_snapshot: {
      service_price_minor: 10_000,
      payment_mode: 'fixed_deposit',
      fixed_deposit_minor: 2_500,
      provider_amount_due_now_minor: 2_500,
      booknowtech_fee_minor: 125,
      customer_total_due_now_minor: 2_625,
      application_fee_amount_minor: 125,
      remaining_service_balance_minor: 7_500,
      currency: 'USD',
    },
    configuration_snapshot: {
      service_payment_configuration_public_id: randomUUID(),
      service_payment_configuration_version: 1,
      deposit_version_public_id: randomUUID(),
      fee_configuration_public_id: randomUUID(),
      fee_version: 1,
    },
    payment_terms_acceptance: {
      version: 'payments-v1',
      document_sha256: 'c'.repeat(64),
      accepted_at: now,
      request_id: randomUUID(),
      payment_attempt_public_id: randomUUID(),
      idempotency_key_hash: 'a'.repeat(64),
      ip_hash: 'd'.repeat(64),
    },
    stripe_payment_intent_id: null,
    stripe_payment_intent_status: null,
    state: 'requested',
    expires_at: new Date(now.valueOf() + 900_000),
    slot_released: false,
    claim_token: null,
    claim_started_at: null,
    attempt_count: 0,
    next_attempt_at: now,
    failure_category: null,
    request_id: randomUUID(),
    correlation_id: randomUUID(),
    created_at: now,
    updated_at: now,
  };
}

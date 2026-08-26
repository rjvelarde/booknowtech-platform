import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({
  create: vi.fn(),
  retrieve: vi.fn(),
  cancel: vi.fn(),
  constructEvent: vi.fn(),
}));

vi.mock('stripe', () => ({
  default: class {
    public readonly paymentIntents = calls;
    public readonly accounts = {};
    public readonly accountLinks = {};
    public readonly webhooks = { constructEvent: calls.constructEvent };
  },
}));

import { StripeSdkConnectAdapter } from './adapter.js';

describe('PR 14B.2 PaymentIntent adapter', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates a cards-only immediate direct charge with exact server values', async () => {
    calls.create.mockResolvedValue(intent());
    const adapter = new StripeSdkConnectAdapter('sk_test_synthetic');
    await expect(
      adapter.createDirectChargePaymentIntent({
        connectedAccountId: 'acct_server_resolved',
        amountMinor: 2_625,
        applicationFeeAmountMinor: 125,
        receiptEmail: 'customer@example.com',
        idempotencyKey: 'bnt_pi_v1_tenant_attempt',
        metadata: {
          tenantPublicId: 'tenant-public',
          appointmentPublicId: 'appointment-public',
          paymentAttemptPublicId: 'attempt-public',
        },
      }),
    ).resolves.toMatchObject({ id: 'pi_synthetic', clientSecret: 'pi_secret_synthetic' });
    expect(calls.create).toHaveBeenCalledWith(
      {
        amount: 2_625,
        application_fee_amount: 125,
        currency: 'usd',
        capture_method: 'automatic',
        payment_method_types: ['card'],
        receipt_email: 'customer@example.com',
        metadata: {
          tenant_public_id: 'tenant-public',
          appointment_public_id: 'appointment-public',
          payment_attempt_public_id: 'attempt-public',
          schema_version: '1',
        },
      },
      { stripeAccount: 'acct_server_resolved', idempotencyKey: 'bnt_pi_v1_tenant_attempt' },
    );
  });

  it('retrieves and cancels only in the resolved connected-account context', async () => {
    calls.retrieve.mockResolvedValue(intent());
    calls.cancel.mockResolvedValue(intent({ status: 'canceled', client_secret: null }));
    const adapter = new StripeSdkConnectAdapter('sk_test_synthetic');
    await adapter.retrievePaymentIntent({
      connectedAccountId: 'acct_server_resolved',
      paymentIntentId: 'pi_synthetic',
    });
    await adapter.cancelPaymentIntent({
      connectedAccountId: 'acct_server_resolved',
      paymentIntentId: 'pi_synthetic',
      idempotencyKey: 'bnt_cancel_v1_attempt',
    });
    expect(calls.retrieve).toHaveBeenCalledWith('pi_synthetic', undefined, {
      stripeAccount: 'acct_server_resolved',
    });
    expect(calls.cancel).toHaveBeenCalledWith('pi_synthetic', undefined, {
      stripeAccount: 'acct_server_resolved',
      idempotencyKey: 'bnt_cancel_v1_attempt',
    });
  });

  it('projects only bounded payment facts from a verified PaymentIntent event', () => {
    calls.constructEvent.mockReturnValue({
      id: 'evt_payment',
      type: 'payment_intent.succeeded',
      account: 'acct_server_resolved',
      created: 1_788_000_000,
      api_version: '2025-01-01',
      livemode: false,
      data: { object: { object: 'payment_intent', ...intent({ status: 'succeeded' }) } },
    });
    const adapter = new StripeSdkConnectAdapter('sk_test_synthetic');
    expect(adapter.verifyWebhook(Buffer.from('{}'), 'signature', 'whsec_test')).toMatchObject({
      id: 'evt_payment',
      type: 'payment_intent.succeeded',
      account: 'acct_server_resolved',
      accountView: null,
      paymentIntentView: {
        id: 'pi_synthetic',
        status: 'succeeded',
        amount: 2_625,
        applicationFeeAmount: 125,
        currency: 'usd',
        lastPaymentErrorCode: null,
      },
    });
  });
});

function intent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pi_synthetic',
    status: 'requires_payment_method',
    client_secret: 'pi_secret_synthetic',
    amount: 2_625,
    application_fee_amount: 125,
    currency: 'usd',
    ...overrides,
  };
}

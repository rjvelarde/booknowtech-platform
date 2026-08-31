import { ObjectId } from 'mongodb';
import { describe, expect, it, vi } from 'vitest';

import { testEnvironment } from '../test-fixtures.js';
import { StripeAccountReadinessService } from './readiness-service.js';

const tenantId = new ObjectId();
const fresh = () => ({
  public_id: 'account-public',
  tenant_id: tenantId,
  stripe_account_id: 'acct_live',
  active: true,
  charges_enabled: true,
  capabilities: { card_payments: 'active', transfers: 'active' },
  requirements: { disabled_reason: null, currently_due: [], past_due: [] },
  disconnected_at: null,
  last_synced_at: new Date(),
  readiness_generation: 2,
});

const view = {
  id: 'acct_live',
  livemode: false,
  detailsSubmitted: true,
  chargesEnabled: true,
  payoutsEnabled: true,
  capabilities: { cardPayments: 'active', transfers: 'active' },
  requirements: {
    currentlyDue: [],
    eventuallyDue: [],
    pastDue: [],
    pendingVerification: [],
    disabledReason: null,
    currentDeadline: null,
  },
};

describe('authoritative Stripe account readiness', () => {
  it('uses a fresh projection without retrieving Stripe', async () => {
    const stripe = { retrieveAccount: vi.fn() };
    const store = { activeStripeAccount: vi.fn().mockResolvedValue(fresh()) };
    const service = new StripeAccountReadinessService(
      {
        ...testEnvironment,
        STRIPE_PAYMENT_EXECUTION_ENABLED: true,
        STRIPE_ACCOUNT_READINESS_MAX_AGE_SECONDS: 900,
      },
      store as never,
      stripe as never,
    );
    await expect(service.ensureFresh(tenantId)).resolves.toMatchObject({ readinessGeneration: 2 });
    expect(stripe.retrieveAccount).not.toHaveBeenCalled();
  });

  it('refreshes a stale projection and returns the incremented generation', async () => {
    const stale = { ...fresh(), last_synced_at: new Date(0), readiness_generation: 1 };
    const updated = { ...fresh(), readiness_generation: 2 };
    const store = {
      activeStripeAccount: vi.fn().mockResolvedValue(stale),
      claimStripeReadinessRefresh: vi.fn().mockResolvedValue(stale),
      completeStripeReadinessRefresh: vi.fn().mockResolvedValue(updated),
      failStripeReadinessRefresh: vi.fn(),
      recordStripeReadinessRefresh: vi.fn(),
    };
    const stripe = { retrieveAccount: vi.fn().mockResolvedValue(view) };
    const service = new StripeAccountReadinessService(
      {
        ...testEnvironment,
        STRIPE_PAYMENT_EXECUTION_ENABLED: true,
        STRIPE_ACCOUNT_READINESS_MAX_AGE_SECONDS: 900,
      },
      store as never,
      stripe as never,
    );
    await expect(service.ensureFresh(tenantId)).resolves.toMatchObject({ readinessGeneration: 2 });
    expect(stripe.retrieveAccount).toHaveBeenCalledOnce();
    expect(store.recordStripeReadinessRefresh).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'success', category: 'refreshed' }),
    );
  });

  it('fails closed on identity mismatch and releases the refresh lease', async () => {
    const stale = { ...fresh(), last_synced_at: new Date(0) };
    const store = {
      activeStripeAccount: vi.fn().mockResolvedValue(stale),
      claimStripeReadinessRefresh: vi.fn().mockResolvedValue(stale),
      completeStripeReadinessRefresh: vi.fn(),
      failStripeReadinessRefresh: vi.fn(),
      recordStripeReadinessRefresh: vi.fn(),
    };
    const stripe = { retrieveAccount: vi.fn().mockResolvedValue({ ...view, id: 'acct_wrong' }) };
    const service = new StripeAccountReadinessService(
      {
        ...testEnvironment,
        STRIPE_PAYMENT_EXECUTION_ENABLED: true,
        STRIPE_ACCOUNT_READINESS_MAX_AGE_SECONDS: 900,
      },
      store as never,
      stripe as never,
    );
    await expect(service.ensureFresh(tenantId)).rejects.toThrow('payment_account_refresh_failed');
    expect(store.completeStripeReadinessRefresh).not.toHaveBeenCalled();
    expect(store.failStripeReadinessRefresh).toHaveBeenCalledOnce();
    expect(store.recordStripeReadinessRefresh).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'failure',
        category: 'stripe_account_identity_mismatch',
      }),
    );
  });

  it('records wrong-mode failure and expired-lease reclaim without exposing account data', async () => {
    const stale = {
      ...fresh(),
      last_synced_at: new Date(0),
      readiness_refresh_token: 'expired-secret-token',
      readiness_refresh_started_at: new Date(0),
    };
    const store = {
      activeStripeAccount: vi.fn().mockResolvedValue(stale),
      claimStripeReadinessRefresh: vi.fn().mockResolvedValue(stale),
      completeStripeReadinessRefresh: vi.fn(),
      failStripeReadinessRefresh: vi.fn(),
      recordStripeReadinessRefresh: vi.fn(),
    };
    const stripe = { retrieveAccount: vi.fn().mockResolvedValue({ ...view, livemode: true }) };
    const service = new StripeAccountReadinessService(
      {
        ...testEnvironment,
        STRIPE_PAYMENT_EXECUTION_ENABLED: true,
        STRIPE_ACCOUNT_READINESS_MAX_AGE_SECONDS: 900,
      },
      store as never,
      stripe as never,
    );
    await expect(service.ensureFresh(tenantId)).rejects.toThrow('payment_account_refresh_failed');
    expect(store.recordStripeReadinessRefresh).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'failure',
        category: 'stripe_account_mode_mismatch',
        leaseReclaimed: true,
      }),
    );
    expect(JSON.stringify(store.recordStripeReadinessRefresh.mock.calls)).not.toContain(
      'expired-secret-token',
    );
  });

  it.each([
    ['StripeConnectionError', undefined, 'stripe_timeout'],
    ['StripeAuthenticationError', 401, 'stripe_authentication_failure'],
    ['StripeRateLimitError', 429, 'stripe_rate_limit'],
    ['StripeAPIError', 500, 'stripe_api_failure'],
  ])('records bounded %s failures', async (type, statusCode, category) => {
    const stale = { ...fresh(), last_synced_at: new Date(0) };
    const store = {
      activeStripeAccount: vi.fn().mockResolvedValue(stale),
      claimStripeReadinessRefresh: vi.fn().mockResolvedValue(stale),
      completeStripeReadinessRefresh: vi.fn(),
      failStripeReadinessRefresh: vi.fn(),
      recordStripeReadinessRefresh: vi.fn(),
    };
    const failure = Object.assign(new Error('sensitive provider response'), { type, statusCode });
    const stripe = { retrieveAccount: vi.fn().mockRejectedValue(failure) };
    const service = new StripeAccountReadinessService(
      {
        ...testEnvironment,
        STRIPE_PAYMENT_EXECUTION_ENABLED: true,
        STRIPE_ACCOUNT_READINESS_MAX_AGE_SECONDS: 900,
      },
      store as never,
      stripe as never,
    );
    await expect(service.ensureFresh(tenantId)).rejects.toThrow('payment_account_refresh_failed');
    expect(store.recordStripeReadinessRefresh).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failure', category }),
    );
    expect(JSON.stringify(store.recordStripeReadinessRefresh.mock.calls)).not.toContain(
      'sensitive provider response',
    );
  });

  it('records an authoritative unready result separately from platform failure', async () => {
    const stale = { ...fresh(), last_synced_at: new Date(0) };
    const updated = {
      ...fresh(),
      charges_enabled: false,
      readiness_generation: 3,
    };
    const store = {
      activeStripeAccount: vi.fn().mockResolvedValue(stale),
      claimStripeReadinessRefresh: vi.fn().mockResolvedValue(stale),
      completeStripeReadinessRefresh: vi.fn().mockResolvedValue(updated),
      failStripeReadinessRefresh: vi.fn(),
      recordStripeReadinessRefresh: vi.fn(),
    };
    const stripe = {
      retrieveAccount: vi.fn().mockResolvedValue({ ...view, chargesEnabled: false }),
    };
    const service = new StripeAccountReadinessService(
      {
        ...testEnvironment,
        STRIPE_PAYMENT_EXECUTION_ENABLED: true,
        STRIPE_ACCOUNT_READINESS_MAX_AGE_SECONDS: 900,
      },
      store as never,
      stripe as never,
    );
    await expect(service.ensureFresh(tenantId)).rejects.toThrow('payment_account_not_ready');
    expect(store.recordStripeReadinessRefresh).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'success', category: 'account_unready' }),
    );
  });
});

import { ObjectId } from 'mongodb';
import { describe, expect, it, vi } from 'vitest';

import { testEnvironment } from '../test-fixtures.js';
import type { StripeConnectAdapter } from './adapter.js';
import type { ConnectActor, ConnectStore } from './connect-store.js';
import { ConnectService } from './connect-service.js';

const actor: ConnectActor = {
  tenantId: new ObjectId(),
  tenantPublicId: 'tenant-public',
  tenantCurrency: 'USD',
  userId: new ObjectId(),
  membershipId: new ObjectId(),
  requestId: 'request-1',
};
const accountView = {
  id: 'acct_test',
  detailsSubmitted: false,
  chargesEnabled: false,
  payoutsEnabled: false,
  capabilities: { cardPayments: 'pending', transfers: 'pending' },
  requirements: {
    currentlyDue: ['business_profile.url'],
    eventuallyDue: [],
    pastDue: [],
    pendingVerification: [],
    disabledReason: null,
    currentDeadline: null,
  },
};

describe('ConnectService', () => {
  it('requires immutable BookNowTech acceptance before account creation', async () => {
    const createExpressAccount = vi.fn();
    const store = { hasTerms: vi.fn().mockResolvedValue(false) } as unknown as ConnectStore;
    const service = new ConnectService(environment(), store, adapter({ createExpressAccount }));
    await expect(service.onboard(actor)).rejects.toThrow('terms_required');
    expect(createExpressAccount).not.toHaveBeenCalled();
  });

  it('uses one durable operation and the narrow Express-account adapter boundary', async () => {
    const createExpressAccount = vi.fn().mockResolvedValue(accountView);
    const account = { public_id: 'configuration-public', stripe_account_id: 'acct_test' };
    const store = {
      hasTerms: vi.fn().mockResolvedValue(true),
      beginAccountOperation: vi.fn().mockResolvedValue({
        kind: 'operation',
        operation: { public_id: 'configuration-public', stripe_idempotency_key: 'stable-key' },
      }),
      completeAccount: vi.fn().mockResolvedValue(account),
    } as unknown as ConnectStore;
    const service = new ConnectService(environment(), store, adapter({ createExpressAccount }));
    await expect(service.onboard(actor)).resolves.toBe(account);
    expect(createExpressAccount).toHaveBeenCalledWith({
      tenantPublicId: 'tenant-public',
      configurationPublicId: 'configuration-public',
      currency: 'USD',
      idempotencyKey: 'stable-key',
    });
  });

  it('records a safe failed operation when Stripe account creation fails', async () => {
    const failure = new Error('processor unavailable');
    const failAccountOperation = vi.fn().mockResolvedValue(undefined);
    const store = {
      hasTerms: vi.fn().mockResolvedValue(true),
      beginAccountOperation: vi.fn().mockResolvedValue({
        kind: 'operation',
        operation: { public_id: 'configuration-public', stripe_idempotency_key: 'stable-key' },
      }),
      failAccountOperation,
    } as unknown as ConnectStore;
    const service = new ConnectService(
      environment(),
      store,
      adapter({ createExpressAccount: vi.fn().mockRejectedValue(failure) }),
    );
    await expect(service.onboard(actor)).rejects.toBe(failure);
    expect(failAccountOperation).toHaveBeenCalledWith(actor, 'configuration-public');
  });

  it('feature disablement blocks user operations without being part of webhook routing', async () => {
    const service = new ConnectService(
      { ...environment(), STRIPE_CONNECT_FOUNDATION_ENABLED: false },
      {} as ConnectStore,
      adapter(),
    );
    await expect(service.onboard(actor)).rejects.toThrow('foundation_disabled');
  });
});

function environment() {
  return {
    ...testEnvironment,
    STRIPE_SECRET_KEY: 'sk_test_foundation',
    STRIPE_PLATFORM_WEBHOOK_SECRET: 'whsec_platform_secret',
    STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec_connect_secret',
    BOOKNOWTECH_CONNECT_TERMS_VERSION: 'connect-v1',
    BOOKNOWTECH_CONNECT_TERMS_TEXT_SHA256: 'a'.repeat(64),
    STRIPE_CONNECT_FOUNDATION_ENABLED: true,
  };
}
function adapter(overrides: Partial<StripeConnectAdapter> = {}): StripeConnectAdapter {
  return {
    createExpressAccount: vi.fn(),
    createAccountLink: vi.fn(),
    retrieveAccount: vi.fn(),
    verifyWebhook: vi.fn(),
    ...overrides,
  };
}

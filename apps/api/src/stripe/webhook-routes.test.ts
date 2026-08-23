import { describe, expect, it, vi } from 'vitest';

import { buildApplication } from '../app.js';
import { StubReadinessProbe, testEnvironment } from '../test-fixtures.js';

describe('Stripe webhook raw-body boundary', () => {
  it('passes exact bytes to verification and durably ingests a verified event while feature-disabled', async () => {
    const verifyWebhook = vi.fn().mockReturnValue({
      id: 'evt_1',
      type: 'account.updated',
      account: 'acct_1',
      created: new Date(),
      apiVersion: '2025-01-01',
      livemode: false,
      accountView: null,
    });
    const ingest = vi.fn().mockResolvedValue({ duplicate: false, publicId: 'event-public' });
    const app = await buildApplication({
      environment: {
        ...testEnvironment,
        STRIPE_SECRET_KEY: 'sk_test_foundation',
        STRIPE_PLATFORM_WEBHOOK_SECRET: 'whsec_platform_secret',
        STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec_connect_secret',
        BOOKNOWTECH_CONNECT_TERMS_VERSION: 'connect-v1',
        BOOKNOWTECH_CONNECT_TERMS_TEXT_SHA256: 'a'.repeat(64),
        STRIPE_CONNECT_FOUNDATION_ENABLED: false,
      },
      readiness: new StubReadinessProbe(),
      logger: false,
      stripeAdapter: {
        verifyWebhook,
        createExpressAccount: vi.fn(),
        createAccountLink: vi.fn(),
        retrieveAccount: vi.fn(),
      },
      stripeWebhookStore: { ingest } as never,
    });
    const payload = '{ "type" : "account.updated" }';
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe/connect',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'signed' },
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(Buffer.isBuffer(verifyWebhook.mock.calls[0]?.[0])).toBe(true);
    expect((verifyWebhook.mock.calls[0]?.[0] as Buffer).toString()).toBe(payload);
    expect(verifyWebhook).toHaveBeenCalledWith(
      expect.any(Buffer),
      'signed',
      'whsec_connect_secret',
    );
    expect(ingest).toHaveBeenCalledOnce();
    await app.close();
  });

  it('rejects missing signatures before persistence', async () => {
    const ingest = vi.fn();
    const app = await buildApplication({
      environment: {
        ...testEnvironment,
        STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec_connect_secret',
        STRIPE_PLATFORM_WEBHOOK_SECRET: 'whsec_platform_secret',
      },
      readiness: new StubReadinessProbe(),
      logger: false,
      stripeAdapter: {
        verifyWebhook: vi.fn(),
        createExpressAccount: vi.fn(),
        createAccountLink: vi.fn(),
        retrieveAccount: vi.fn(),
      },
      stripeWebhookStore: { ingest } as never,
    });
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe/connect',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(response.statusCode).toBe(400);
    expect(ingest).not.toHaveBeenCalled();
    await app.close();
  });
});

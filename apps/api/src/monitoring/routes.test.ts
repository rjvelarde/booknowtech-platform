import { afterEach, describe, expect, it } from 'vitest';

import { buildApplication } from '../app.js';
import { StubReadinessProbe, testEnvironment } from '../test-fixtures.js';
import {
  type MonitoringReader,
  type MonitoringSnapshot,
  readinessFailureCategories,
} from './store.js';

const token = testEnvironment.MONITORING_TOKEN;
const sha = 'a'.repeat(40);
const now = new Date('2026-08-16T20:00:00.000Z');

function snapshot(overrides: Partial<MonitoringSnapshot> = {}): MonitoringSnapshot {
  return {
    worker: {
      service: 'worker',
      environment: 'test',
      commit_sha: sha,
      observed_at: new Date(now.valueOf() - 12_000),
    },
    pendingCount: 0,
    oldestPendingAt: null,
    processingCount: 0,
    oldestProcessingAt: null,
    terminalFailed15m: 0,
    terminalFailed24h: 0,
    stripePendingCount: 0,
    stripeOldestPendingAt: null,
    stripeProcessingCount: 0,
    stripeFailedCount: 0,
    stripeHistoricalTerminalFailedCount: 0,
    paymentManualReviewCount: 0,
    paymentOldestManualReviewAt: null,
    paymentFinalizationFailureCount: 0,
    paymentExpiryCandidateCount: 0,
    paymentReconciliationPendingCount: 0,
    paymentReconciliationProcessingCount: 0,
    paymentSucceededUnfinalizedCount: 0,
    paymentOldestSucceededUnfinalizedAt: null,
    paymentRetryExhaustedCount: 0,
    readinessFailureCount15m: 0,
    readinessOldestFailureAt: null,
    readinessNewestFailureAt: null,
    readinessFailureCounts15m: Object.fromEntries(
      readinessFailureCategories.map((category) => [category, 0]),
    ) as MonitoringSnapshot['readinessFailureCounts15m'],
    readinessUnreadyCount24h: 0,
    readinessSlowCount15m: 0,
    readinessMaxDurationMs15m: 0,
    readinessReclaimedLeaseCount24h: 0,
    ...overrides,
  };
}

describe('internal monitoring route', () => {
  const applications: Awaited<ReturnType<typeof buildApplication>>[] = [];

  afterEach(async () => Promise.all(applications.splice(0).map(async (app) => app.close())));

  async function application(reader: MonitoringReader) {
    const app = await buildApplication({
      environment: { ...testEnvironment, BUILD_VERSION: sha },
      readiness: new StubReadinessProbe(),
      monitoringReader: reader,
      monitoringNow: () => now,
      logger: false,
    });
    applications.push(app);
    return app;
  }

  it('returns the strict privacy-safe healthy shape and disables caching', async () => {
    const reader: MonitoringReader = {
      read: () =>
        Promise.resolve(
          snapshot({
            pendingCount: 2,
            oldestPendingAt: new Date(now.valueOf() - 61_000),
            processingCount: 1,
            oldestProcessingAt: new Date(now.valueOf() - 31_000),
            terminalFailed15m: 3,
            terminalFailed24h: 4,
          }),
        ),
    };
    const app = await application(reader);
    const response = await app.inject({
      method: 'GET',
      url: '/api/internal/monitoring',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({
      data: {
        environment: 'test',
        api_sha: sha,
        worker: { present: true, fresh: true, age_seconds: 12, sha },
        outbox: {
          pending_count: 2,
          oldest_pending_age_seconds: 61,
          processing_count: 1,
          oldest_processing_age_seconds: 31,
          terminal_failed_15m: 3,
          terminal_failed_24h: 4,
        },
        stripe_webhooks: {
          pending_count: 0,
          oldest_pending_age_seconds: null,
          processing_count: 0,
          failed_count: 0,
          historical_terminal_failed_count: 0,
        },
        payments: {
          manual_review_count: 0,
          oldest_manual_review_age_seconds: null,
          local_finalization_failure_count: 0,
          expiry_candidate_count: 0,
          reconciliation_pending_count: 0,
          reconciliation_processing_count: 0,
          succeeded_unfinalized_count: 0,
          oldest_succeeded_unfinalized_age_seconds: null,
          retry_exhausted_count: 0,
        },
        stripe_readiness_refresh: {
          failure_count_15m: 0,
          oldest_failure_age_seconds: null,
          newest_failure_age_seconds: null,
          failure_categories_15m: Object.fromEntries(
            readinessFailureCategories.map((category) => [category, 0]),
          ),
          unready_count_24h: 0,
          slow_count_15m: 0,
          max_duration_ms_15m: 0,
          reclaimed_lease_count_24h: 0,
        },
      },
    });
  });

  it('uses one constant 401 shape for missing, malformed, and invalid credentials', async () => {
    const app = await application({ read: () => Promise.resolve(snapshot()) });
    const headers = [undefined, 'Basic abc', 'Bearer wrong-token'];
    const responses = await Promise.all(
      headers.map(async (authorization) =>
        app.inject({
          method: 'GET',
          url: '/api/internal/monitoring',
          headers: authorization ? { authorization } : {},
        }),
      ),
    );

    for (const response of responses) {
      expect(response.statusCode).toBe(401);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toEqual({
        error: { code: 'unauthorized', message: 'Unauthorized.' },
      });
      expect(response.body).not.toContain(token);
    }
  });

  it.each([
    ['missing heartbeat', { worker: null }],
    [
      'stale heartbeat',
      { worker: { ...snapshot().worker!, observed_at: new Date(now.valueOf() - 91_000) } },
    ],
    ['wrong environment', { worker: { ...snapshot().worker!, environment: 'production' } }],
    ['malformed SHA', { worker: { ...snapshot().worker!, commit_sha: 'not-a-sha' } }],
    ['mismatched SHA', { worker: { ...snapshot().worker!, commit_sha: 'b'.repeat(40) } }],
    ['failed Stripe webhook', { stripeFailedCount: 1 }],
    ['pending Stripe webhook', { stripePendingCount: 1, stripeOldestPendingAt: now }],
    ['processing Stripe webhook', { stripeProcessingCount: 1 }],
    ['expired payment hold', { paymentExpiryCandidateCount: 1 }],
    ['reconciliation pending', { paymentReconciliationPendingCount: 1 }],
    ['reconciliation processing', { paymentReconciliationProcessingCount: 1 }],
    ['paid unfinalized', { paymentSucceededUnfinalizedCount: 1 }],
    ['manual review', { paymentManualReviewCount: 1 }],
    ['retry exhausted', { paymentRetryExhaustedCount: 1 }],
    ['readiness refresh failure', { readinessFailureCount15m: 1 }],
  ])('fails closed for %s', async (_label, overrides) => {
    const app = await application({ read: () => Promise.resolve(snapshot(overrides)) });
    const response = await app.inject({
      method: 'GET',
      url: '/api/internal/monitoring',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(503);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('exposes paid-unfinalized age without sensitive payment data', async () => {
    const app = await application({
      read: () =>
        Promise.resolve(
          snapshot({
            paymentSucceededUnfinalizedCount: 1,
            paymentOldestSucceededUnfinalizedAt: new Date(now.valueOf() - 3_600_000),
          }),
        ),
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/internal/monitoring',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().data.payments).toMatchObject({
      succeeded_unfinalized_count: 1,
      oldest_succeeded_unfinalized_age_seconds: 3_600,
    });
    expect(response.body).not.toContain('client_secret');
    expect(response.body).not.toContain('customer_email');
  });

  it('keeps acknowledged terminal history visible without degrading current health', async () => {
    const app = await application({
      read: () => Promise.resolve(snapshot({ stripeHistoricalTerminalFailedCount: 2 })),
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/internal/monitoring',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.stripe_webhooks).toMatchObject({
      failed_count: 0,
      historical_terminal_failed_count: 2,
    });
  });

  it('exposes bounded readiness categories and latency without tenant or Stripe identifiers', async () => {
    const categories = snapshot().readinessFailureCounts15m;
    categories.stripe_account_identity_mismatch = 1;
    const unsafe = snapshot({
      readinessFailureCount15m: 1,
      readinessOldestFailureAt: new Date(now.valueOf() - 45_000),
      readinessNewestFailureAt: new Date(now.valueOf() - 15_000),
      readinessFailureCounts15m: categories,
      readinessUnreadyCount24h: 2,
      readinessSlowCount15m: 1,
      readinessMaxDurationMs15m: 6_250,
      readinessReclaimedLeaseCount24h: 1,
    }) as MonitoringSnapshot & Record<string, unknown>;
    unsafe.stripe_account_id = 'acct_sensitive';
    unsafe.raw_response = 'sk_test_sensitive';
    const app = await application({ read: () => Promise.resolve(unsafe) });
    const response = await app.inject({
      method: 'GET',
      url: '/api/internal/monitoring',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().data.stripe_readiness_refresh).toMatchObject({
      failure_count_15m: 1,
      oldest_failure_age_seconds: 45,
      newest_failure_age_seconds: 15,
      failure_categories_15m: { stripe_account_identity_mismatch: 1 },
      unready_count_24h: 2,
      slow_count_15m: 1,
      max_duration_ms_15m: 6_250,
      reclaimed_lease_count_24h: 1,
    });
    expect(response.body).not.toContain('acct_sensitive');
    expect(response.body).not.toContain('sk_test_sensitive');
  });

  it('fails closed on Mongo/query failure without exposing error or business data', async () => {
    const sensitive = 'customer@example.test tenant-123 mongodb://user:password@private-host';
    const app = await application({ read: () => Promise.reject(new Error(sensitive)) });
    const response = await app.inject({
      method: 'GET',
      url: '/api/internal/monitoring',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('customer@example.test');
    expect(response.body).not.toContain('tenant-123');
    expect(response.body).not.toContain('password');
    expect(Object.keys(response.json<{ data: Record<string, unknown> }>().data)).toEqual([
      'environment',
      'api_sha',
      'worker',
      'outbox',
      'stripe_webhooks',
      'payments',
      'stripe_readiness_refresh',
    ]);
  });

  it('does not expose extra fields returned by persistence', async () => {
    const unsafe = snapshot() as MonitoringSnapshot & Record<string, unknown>;
    unsafe.tenant_id = 'tenant-secret';
    unsafe.recipient = 'customer@example.test';
    const app = await application({ read: () => Promise.resolve(unsafe) });
    const response = await app.inject({
      method: 'GET',
      url: '/api/internal/monitoring',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('tenant-secret');
    expect(response.body).not.toContain('customer@example.test');
  });
});

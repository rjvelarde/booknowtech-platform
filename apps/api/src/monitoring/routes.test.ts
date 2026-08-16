import { afterEach, describe, expect, it } from 'vitest';

import { buildApplication } from '../app.js';
import { StubReadinessProbe, testEnvironment } from '../test-fixtures.js';
import type { MonitoringReader, MonitoringSnapshot } from './store.js';

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

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatResult, verifyRelease } from './verify-release.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

describe('release verifier', () => {
  it('passes immediately when frontend, API, and fresh worker converge', async () => {
    const result = await run(sequence({ frontend: A, api: A, worker: A }));
    assert.equal(result.pass, true);
    assert.equal(result.category, 'converged');
    assert.equal(result.elapsedMs, 0);
  });

  for (const [name, values] of [
    ['frontend/API mismatch', { frontend: A, api: B, worker: B }],
    ['API/worker mismatch', { frontend: A, api: A, worker: B }],
    ['all different', { frontend: A, api: B, worker: C }],
  ]) {
    it(`fails ${name} after the bounded deadline`, async () => {
      const result = await run(sequence(values));
      assertFailure(result, 'identity_mismatch', 300_000);
    });
  }

  for (const [name, values, category] of [
    ['frontend', { frontend: 'A'.repeat(40), api: A, worker: A }, 'malformed_frontend_sha'],
    ['API', { frontend: A, api: 'short', worker: A }, 'malformed_api_sha'],
    ['worker', { frontend: A, api: A, worker: null }, 'malformed_worker_sha'],
  ]) {
    it(`rejects a malformed ${name} SHA deterministically`, async () => {
      assertFailure(await run(sequence(values)), category, 0);
    });
  }

  it('fails a missing heartbeat after the deadline', async () => {
    assertFailure(
      await run(sequence({ present: false, worker: null, age: null })),
      'worker_missing',
      300_000,
    );
  });

  it('fails a stale heartbeat after the deadline', async () => {
    assertFailure(await run(sequence({ fresh: false, age: 91 })), 'worker_stale', 300_000);
  });

  it('rejects the wrong monitoring environment immediately', async () => {
    assertFailure(await run(sequence({ environment: 'production' })), 'wrong_environment', 0);
  });

  for (const status of [401, 503]) {
    it(`fails monitoring ${status}`, async () => {
      const result = await run(sequence({ monitoringStatus: status }));
      assertFailure(
        result,
        status === 401 ? 'monitoring_unauthorized' : 'monitoring_unhealthy',
        status === 401 ? 0 : 300_000,
      );
    });
  }

  for (const endpoint of ['frontend', 'api', 'monitoring']) {
    it(`fails closed when ${endpoint} times out`, async () => {
      const result = await run(sequence({ timeout: endpoint }));
      assertFailure(result, `${endpoint}_unreachable`, 300_000);
    });
  }

  it('retries a temporary mismatch and passes on convergence', async () => {
    const result = await run(
      sequence({ frontend: A, api: B, worker: B }, { frontend: B, api: B, worker: B }),
    );
    assert.equal(result.pass, true);
    assert.equal(result.elapsedMs, 10_000);
  });

  it('never treats a persistent mismatch as success', async () => {
    assertFailure(
      await run(sequence({ frontend: A, api: B, worker: B })),
      'identity_mismatch',
      300_000,
    );
  });

  it('redacts the monitoring token and unsafe response content', async () => {
    const token = 'bnt_monitoring_staging_super-secret';
    const result = await run(
      sequence({ apiStatus: 500, unsafe: `${token} mongodb://private customer@example.test` }),
      { token },
    );
    const output = formatResult(result);
    assert.equal(output.includes(token), false);
    assert.equal(output.includes('mongodb://'), false);
    assert.equal(output.includes('customer@example.test'), false);
  });

  it('rejects incomplete monitoring identity', async () => {
    assertFailure(await run(sequence({ monitoringApi: null })), 'incomplete_identity', 0);
  });

  it('retries when API replicas disagree and then converge', async () => {
    const result = await run(sequence({ monitoringApi: B }, { frontend: A, api: A, worker: A }));
    assert.equal(result.pass, true);
    assert.equal(result.elapsedMs, 10_000);
  });

  it('rejects an otherwise malformed monitoring response', async () => {
    assertFailure(
      await run(sequence({ outbox: { pending_count: -1 } })),
      'malformed_monitoring',
      0,
    );
  });
});

async function run(fetch, overrides = {}) {
  let currentTime = 0;
  return verifyRelease(
    {
      expectedEnvironment: 'staging',
      frontendUrl: new URL('https://frontend.example.test'),
      apiUrl: new URL('https://api.example.test'),
      monitoringToken: overrides.token ?? 'test-token',
      deadlineMs: 300_000,
      retryIntervalMs: 10_000,
      requestTimeoutMs: 1_000,
    },
    {
      fetch,
      now: () => currentTime,
      sleep: async (milliseconds) => {
        currentTime += milliseconds;
      },
    },
  );
}

function sequence(...attempts) {
  let request = 0;
  return async (url, init) => {
    const attempt = attempts[Math.min(Math.floor(request / 3), attempts.length - 1)];
    request += 1;
    const endpoint =
      url.pathname === '/version.json'
        ? 'frontend'
        : url.pathname === '/api/v1/version'
          ? 'api'
          : 'monitoring';
    if (attempt.timeout === endpoint) throw new DOMException('timed out', 'TimeoutError');

    if (endpoint === 'frontend')
      return response(attempt.frontend ?? A, attempt.frontendStatus ?? 200, false, attempt.unsafe);
    if (endpoint === 'api')
      return response(attempt.api ?? A, attempt.apiStatus ?? 200, true, attempt.unsafe);

    assert.equal(init.headers.authorization.startsWith('Bearer '), true);
    const api = attempt.api ?? A;
    const body = {
      data: {
        environment: attempt.environment ?? 'staging',
        api_sha: Object.hasOwn(attempt, 'monitoringApi') ? attempt.monitoringApi : api,
        worker: {
          present: attempt.present ?? true,
          fresh: attempt.fresh ?? true,
          age_seconds: Object.hasOwn(attempt, 'age') ? attempt.age : 5,
          sha: Object.hasOwn(attempt, 'worker') ? attempt.worker : api,
        },
        outbox: attempt.outbox ?? {
          pending_count: 0,
          oldest_pending_age_seconds: null,
          processing_count: 0,
          oldest_processing_age_seconds: null,
          terminal_failed_15m: 0,
          terminal_failed_24h: 0,
        },
      },
      unsafe: attempt.unsafe,
    };
    return jsonResponse(body, attempt.monitoringStatus ?? 200);
  };
}

function response(sha, status, envelope, unsafe) {
  return jsonResponse(
    envelope ? { data: { version: sha }, unsafe } : { version: sha, unsafe },
    status,
  );
}

function jsonResponse(body, status) {
  return { status, json: async () => body };
}

function assertFailure(result, category, elapsedMs) {
  assert.equal(result.pass, false);
  assert.equal(result.category, category);
  assert.equal(result.elapsedMs, elapsedMs);
}

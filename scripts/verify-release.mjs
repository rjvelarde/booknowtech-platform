#!/usr/bin/env node

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const DEFAULT_DEADLINE_MS = 300_000;
const DEFAULT_RETRY_INTERVAL_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export async function verifyRelease(options, dependencies = {}) {
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? Date.now;
  const sleep =
    dependencies.sleep ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const startedAt = now();
  let result;

  do {
    result = await verifyOnce(options, { fetch: fetchImpl });
    if (result.pass || !result.retryable) break;

    const remaining = options.deadlineMs - (now() - startedAt);
    if (remaining <= 0) break;
    await sleep(Math.min(options.retryIntervalMs, remaining));
  } while (now() - startedAt <= options.deadlineMs);

  return publicResult(options.expectedEnvironment, result, now() - startedAt);
}

export async function verifyOnce(options, dependencies = {}) {
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const state = emptyState();

  const frontend = await requestJson(fetchImpl, new URL('/version.json', options.frontendUrl), {
    timeoutMs: options.requestTimeoutMs,
    category: 'frontend_unreachable',
  });
  if (!frontend.ok) return failure(state, frontend.category, true);
  state.frontendSha = frontend.body?.version ?? null;
  if (!validSha(state.frontendSha)) return failure(state, 'malformed_frontend_sha', false);

  const api = await requestJson(fetchImpl, new URL('/api/v1/version', options.apiUrl), {
    timeoutMs: options.requestTimeoutMs,
    category: 'api_unreachable',
  });
  if (!api.ok) return failure(state, api.category, true);
  state.apiSha = api.body?.data?.version ?? null;
  if (!validSha(state.apiSha)) return failure(state, 'malformed_api_sha', false);

  const monitoring = await requestJson(
    fetchImpl,
    new URL('/api/internal/monitoring', options.apiUrl),
    {
      timeoutMs: options.requestTimeoutMs,
      category: 'monitoring_unreachable',
      headers: { authorization: `Bearer ${options.monitoringToken}` },
      acceptedStatuses: [200, 401, 503],
    },
  );
  if (!monitoring.ok) return failure(state, monitoring.category, true);
  if (monitoring.status === 401) return failure(state, 'monitoring_unauthorized', false);

  const data = monitoring.body?.data;
  if (!data || typeof data !== 'object') return failure(state, 'malformed_monitoring', false);
  if (data.environment !== options.expectedEnvironment) {
    return failure(state, 'wrong_environment', false);
  }
  if (!validSha(data.api_sha)) {
    return failure(state, 'incomplete_identity', false);
  }
  if (data.api_sha !== state.apiSha) return failure(state, 'identity_mismatch', true);

  const worker = data.worker;
  if (!worker || typeof worker !== 'object') return failure(state, 'incomplete_identity', false);
  state.workerSha = worker.sha ?? null;
  state.workerFresh = worker.fresh === true;
  state.workerAgeSeconds = nonnegativeInteger(worker.age_seconds) ? worker.age_seconds : null;

  if (worker.present !== true) return failure(state, 'worker_missing', true);
  if (!validSha(state.workerSha)) return failure(state, 'malformed_worker_sha', false);
  if (!state.workerFresh || state.workerAgeSeconds === null) {
    return failure(state, 'worker_stale', true);
  }
  if (!validOutbox(data.outbox)) return failure(state, 'malformed_monitoring', false);
  if (monitoring.status === 503) return failure(state, 'monitoring_unhealthy', true);
  if (monitoring.status !== 200) return failure(state, 'monitoring_unavailable', true);

  if (state.frontendSha !== state.apiSha || state.apiSha !== state.workerSha) {
    return failure(state, 'identity_mismatch', true);
  }

  return { ...state, pass: true, category: 'converged', retryable: false };
}

export function loadOptions(environment = process.env) {
  const expectedEnvironment = required(environment, 'EXPECTED_ENVIRONMENT');
  if (!['staging', 'production'].includes(expectedEnvironment)) {
    throw new Error('invalid_expected_environment');
  }

  return {
    expectedEnvironment,
    frontendUrl: validBaseUrl(required(environment, 'RELEASE_FRONTEND_URL')),
    apiUrl: validBaseUrl(required(environment, 'RELEASE_API_URL')),
    monitoringToken: required(environment, 'MONITORING_TOKEN'),
    deadlineMs: boundedInteger(
      environment.RELEASE_CONVERGENCE_TIMEOUT_MS,
      DEFAULT_DEADLINE_MS,
      1,
      300_000,
    ),
    retryIntervalMs: boundedInteger(
      environment.RELEASE_RETRY_INTERVAL_MS,
      DEFAULT_RETRY_INTERVAL_MS,
      1,
      60_000,
    ),
    requestTimeoutMs: boundedInteger(
      environment.RELEASE_REQUEST_TIMEOUT_MS,
      DEFAULT_REQUEST_TIMEOUT_MS,
      1,
      60_000,
    ),
  };
}

export function formatResult(result) {
  return JSON.stringify({
    expected_environment: result.expectedEnvironment,
    frontend_sha: result.frontendSha,
    api_sha: result.apiSha,
    worker_sha: result.workerSha,
    worker_fresh: result.workerFresh,
    worker_age_seconds: result.workerAgeSeconds,
    result: result.pass ? 'PASS' : 'FAIL',
    category: result.category,
    elapsed_seconds: Math.ceil(result.elapsedMs / 1_000),
  });
}

async function requestJson(fetchImpl, url, options) {
  try {
    const response = await fetchImpl(url, {
      headers: options.headers,
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    const accepted = options.acceptedStatuses ?? [200];
    if (!accepted.includes(response.status)) {
      return { ok: false, category: options.category };
    }
    try {
      return { ok: true, status: response.status, body: await response.json() };
    } catch {
      return { ok: false, category: options.category };
    }
  } catch {
    return { ok: false, category: options.category };
  }
}

function emptyState() {
  return {
    frontendSha: null,
    apiSha: null,
    workerSha: null,
    workerFresh: false,
    workerAgeSeconds: null,
  };
}

function failure(state, category, retryable) {
  return { ...state, pass: false, category, retryable };
}

function publicResult(expectedEnvironment, result, elapsedMs) {
  return {
    expectedEnvironment,
    frontendSha: result.frontendSha,
    apiSha: result.apiSha,
    workerSha: result.workerSha,
    workerFresh: result.workerFresh,
    workerAgeSeconds: result.workerAgeSeconds,
    pass: result.pass,
    category: result.category,
    elapsedMs,
  };
}

function validSha(value) {
  return typeof value === 'string' && SHA_PATTERN.test(value);
}

function nonnegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function validOutbox(value) {
  if (!value || typeof value !== 'object') return false;
  return [
    'pending_count',
    'oldest_pending_age_seconds',
    'processing_count',
    'oldest_processing_age_seconds',
    'terminal_failed_15m',
    'terminal_failed_24h',
  ].every((key) => value[key] === null || nonnegativeInteger(value[key]));
}

function required(environment, name) {
  const value = environment[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error('missing_configuration');
  return value;
}

function validBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost') throw new Error('invalid_url');
  return url;
}

function boundedInteger(value, fallback, minimum, maximum) {
  if (value === undefined) return fallback;
  if (!/^\d+$/u.test(value)) throw new Error('invalid_configuration');
  const parsed = Number(value);
  if (parsed < minimum || parsed > maximum) throw new Error('invalid_configuration');
  return parsed;
}

async function main() {
  let result;
  try {
    const options = loadOptions();
    result = await verifyRelease(options);
  } catch {
    result = {
      expectedEnvironment: process.env.EXPECTED_ENVIRONMENT ?? null,
      ...emptyState(),
      pass: false,
      category: 'configuration',
      elapsedMs: 0,
    };
  }
  process.stdout.write(`${formatResult(result)}\n`);
  process.exitCode = result.pass ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();

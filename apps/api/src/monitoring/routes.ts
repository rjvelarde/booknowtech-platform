import { createHash, timingSafeEqual } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

import type { Environment } from '../config.js';
import type { MonitoringReader, MonitoringSnapshot } from './store.js';

export const WORKER_FRESHNESS_MILLISECONDS = 90_000;

const shaPattern = /^[a-f0-9]{40}$/u;
const unauthorized = { error: { code: 'unauthorized', message: 'Unauthorized.' } } as const;
const nullableInteger = { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] } as const;
const monitoringDataSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['environment', 'api_sha', 'worker', 'outbox', 'stripe_webhooks'],
  properties: {
    environment: { type: 'string', enum: ['development', 'test', 'staging', 'production'] },
    api_sha: { type: 'string' },
    worker: {
      type: 'object',
      additionalProperties: false,
      required: ['present', 'fresh', 'age_seconds', 'sha'],
      properties: {
        present: { type: 'boolean' },
        fresh: { type: 'boolean' },
        age_seconds: nullableInteger,
        sha: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
    },
    outbox: {
      type: 'object',
      additionalProperties: false,
      required: [
        'pending_count',
        'oldest_pending_age_seconds',
        'processing_count',
        'oldest_processing_age_seconds',
        'terminal_failed_15m',
        'terminal_failed_24h',
      ],
      properties: {
        pending_count: nullableInteger,
        oldest_pending_age_seconds: nullableInteger,
        processing_count: nullableInteger,
        oldest_processing_age_seconds: nullableInteger,
        terminal_failed_15m: nullableInteger,
        terminal_failed_24h: nullableInteger,
      },
    },
    stripe_webhooks: {
      type: 'object',
      additionalProperties: false,
      required: ['pending_count', 'oldest_pending_age_seconds', 'processing_count', 'failed_count'],
      properties: {
        pending_count: nullableInteger,
        oldest_pending_age_seconds: nullableInteger,
        processing_count: nullableInteger,
        failed_count: nullableInteger,
      },
    },
  },
} as const;
const monitoringEnvelopeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: { data: monitoringDataSchema },
} as const;
const unauthorizedSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      additionalProperties: false,
      required: ['code', 'message'],
      properties: {
        code: { type: 'string', const: 'unauthorized' },
        message: { type: 'string', const: 'Unauthorized.' },
      },
    },
  },
} as const;

export function registerMonitoringRoute(
  app: FastifyInstance,
  environment: Environment,
  reader: MonitoringReader,
  now: () => Date = () => new Date(),
): void {
  app.get(
    '/api/internal/monitoring',
    {
      schema: {
        hide: true,
        response: {
          200: monitoringEnvelopeSchema,
          401: unauthorizedSchema,
          503: monitoringEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      void reply.header('Cache-Control', 'no-store');
      if (!validAuthorization(request.headers.authorization, environment.MONITORING_TOKEN)) {
        return reply.status(401).send(unauthorized);
      }

      const observedNow = now();
      try {
        const snapshot = await reader.read(environment.ENVIRONMENT_ID, observedNow);
        const response = monitoringResponse(environment, snapshot, observedNow);
        return reply.status(response.healthy ? 200 : 503).send({ data: response.data });
      } catch (error) {
        request.log.warn({
          event: 'monitoring.query_failed',
          error_name: error instanceof Error ? error.name : 'unknown',
        });
        return reply.status(503).send({ data: unavailableData(environment) });
      }
    },
  );
}

function monitoringResponse(environment: Environment, snapshot: MonitoringSnapshot, now: Date) {
  const worker = snapshot.worker;
  const ageMilliseconds = worker ? now.valueOf() - worker.observed_at.valueOf() : null;
  const ageSeconds =
    ageMilliseconds === null ? null : Math.max(0, Math.floor(ageMilliseconds / 1_000));
  const present = worker !== null;
  const fresh =
    ageMilliseconds !== null &&
    ageMilliseconds >= 0 &&
    ageMilliseconds <= WORKER_FRESHNESS_MILLISECONDS;
  const environmentMatches = worker?.environment === environment.ENVIRONMENT_ID;
  const shaValid = worker !== null && shaPattern.test(worker.commit_sha);
  const apiShaValid = shaPattern.test(environment.BUILD_VERSION);
  const shaMatches = shaValid && worker.commit_sha === environment.BUILD_VERSION;

  return {
    healthy:
      present &&
      fresh &&
      environmentMatches &&
      apiShaValid &&
      shaMatches &&
      snapshot.stripeFailedCount === 0,
    data: {
      environment: environment.ENVIRONMENT_ID,
      api_sha: environment.BUILD_VERSION,
      worker: {
        present,
        fresh,
        age_seconds: ageSeconds,
        sha: shaValid ? worker.commit_sha : null,
      },
      outbox: {
        pending_count: snapshot.pendingCount,
        oldest_pending_age_seconds: age(now, snapshot.oldestPendingAt),
        processing_count: snapshot.processingCount,
        oldest_processing_age_seconds: age(now, snapshot.oldestProcessingAt),
        terminal_failed_15m: snapshot.terminalFailed15m,
        terminal_failed_24h: snapshot.terminalFailed24h,
      },
      stripe_webhooks: {
        pending_count: snapshot.stripePendingCount,
        oldest_pending_age_seconds: age(now, snapshot.stripeOldestPendingAt),
        processing_count: snapshot.stripeProcessingCount,
        failed_count: snapshot.stripeFailedCount,
      },
    },
  };
}

function unavailableData(environment: Environment) {
  return {
    environment: environment.ENVIRONMENT_ID,
    api_sha: environment.BUILD_VERSION,
    worker: { present: false, fresh: false, age_seconds: null, sha: null },
    outbox: {
      pending_count: null,
      oldest_pending_age_seconds: null,
      processing_count: null,
      oldest_processing_age_seconds: null,
      terminal_failed_15m: null,
      terminal_failed_24h: null,
    },
    stripe_webhooks: {
      pending_count: null,
      oldest_pending_age_seconds: null,
      processing_count: null,
      failed_count: null,
    },
  };
}

function age(now: Date, value: Date | null): number | null {
  return value === null ? null : Math.max(0, Math.floor((now.valueOf() - value.valueOf()) / 1_000));
}

function validAuthorization(header: string | undefined, expectedToken: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const actual = createHash('sha256').update(header.slice(7)).digest();
  const expected = createHash('sha256').update(expectedToken).digest();
  return timingSafeEqual(actual, expected);
}

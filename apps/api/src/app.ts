import swagger from '@fastify/swagger';
import Fastify, { type FastifyInstance, LogController } from 'fastify';

import type { AdminStore } from './admin/store.js';
import { registerAdminRoutes } from './auth/routes.js';
import { registerCatalogRoutes } from './catalog/routes.js';
import type { Environment } from './config.js';
import { resolveCorrelationId } from './correlation.js';
import { createLoggerOptions } from './logger.js';
import { registerProviderRoutes } from './provider/routes.js';
import { registerAvailabilityRoutes } from './availability/routes.js';
import type { ReadinessProbe } from './readiness.js';

interface BuildApplicationOptions {
  environment: Environment;
  readiness: ReadinessProbe;
  logger?: boolean;
  adminStore?: AdminStore;
  closeAdmin?: () => Promise<void>;
}

const dataEnvelopeSchema = {
  type: 'object',
  required: ['data'],
  properties: {
    data: { type: 'object', additionalProperties: true },
  },
} as const;

export async function buildApplication({
  environment,
  readiness,
  logger = true,
  adminStore,
  closeAdmin,
}: BuildApplicationOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: logger ? createLoggerOptions(environment) : false,
    genReqId: (request) => resolveCorrelationId(request.headers['x-request-id']),
    logController: new LogController({ disableRequestLogging: true }),
  });

  if (environment.OPENAPI_ENABLED) {
    await app.register(swagger, {
      openapi: {
        info: {
          title: 'BookNowTech API',
          version: '1.0.0',
        },
      },
    });
    app.get('/documentation/openapi.json', { schema: { hide: true } }, () => app.swagger());
  }

  app.addHook('onRequest', async (request, reply) => {
    void reply.header('x-request-id', request.id);
    request.log.info({ event: 'http.request.started', request_id: request.id });
  });

  app.addHook('onResponse', async (request, reply) => {
    request.log.info({
      event: 'http.request.completed',
      request_id: request.id,
      status_code: reply.statusCode,
    });
  });

  app.setErrorHandler((error, request, reply) => {
    if (typeof error === 'object' && error !== null && 'validation' in error && error.validation) {
      void reply.status(400).send({
        error: {
          code: 'validation_failed',
          message: 'The request is invalid.',
          request_id: request.id,
        },
      });
      return;
    }
    request.log.error({ err: error, event: 'http.request.failed', request_id: request.id });
    void reply.status(500).send({
      error: {
        code: 'internal_error',
        message: 'The request could not be completed.',
        request_id: request.id,
      },
    });
  });

  app.get(
    '/health/live',
    {
      schema: {
        operationId: 'getLiveness',
        tags: ['operations'],
        response: { 200: dataEnvelopeSchema },
      },
    },
    () => ({ data: { status: 'live' } }),
  );

  app.get(
    '/health/ready',
    {
      schema: {
        operationId: 'getReadiness',
        tags: ['operations'],
        response: {
          200: dataEnvelopeSchema,
          503: dataEnvelopeSchema,
        },
      },
    },
    async (_request, reply) => {
      try {
        await readiness.check();
        return { data: { status: 'ready' } };
      } catch {
        void reply.status(503);
        return { data: { status: 'not_ready' } };
      }
    },
  );

  app.get(
    '/api/v1/version',
    {
      schema: {
        operationId: 'getVersion',
        tags: ['operations'],
        response: { 200: dataEnvelopeSchema },
      },
    },
    () => ({ data: { version: environment.BUILD_VERSION } }),
  );

  if (environment.TENANT_ADMIN_ENABLED) {
    if (!adminStore) throw new Error('Administrative persistence is required when enabled');
    registerAdminRoutes(app, environment, adminStore);
    registerCatalogRoutes(app, environment, adminStore);
    registerProviderRoutes(app, environment, adminStore);
    registerAvailabilityRoutes(app, environment, adminStore);
  }

  app.addHook('onClose', async () => {
    await readiness.close();
    await closeAdmin?.();
  });

  return app;
}

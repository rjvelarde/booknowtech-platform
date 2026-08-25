import swagger from '@fastify/swagger';
import Fastify, { type FastifyInstance, LogController } from 'fastify';

import type { AdminStore } from './admin/store.js';
import { clientIp, isTrustedProxyAddress } from './client-ip.js';
import { registerAdminRoutes } from './auth/routes.js';
import { registerCatalogRoutes } from './catalog/routes.js';
import type { Environment } from './config.js';
import { resolveCorrelationId } from './correlation.js';
import { createLoggerOptions } from './logger.js';
import { registerProviderRoutes } from './provider/routes.js';
import { registerAvailabilityRoutes } from './availability/routes.js';
import { registerCustomerRoutes } from './customer/routes.js';
import { registerAppointmentRoutes } from './appointment/routes.js';
import { registerPublicBookingRoutes } from './public/routes.js';
import { registerNotificationRoutes } from './notification/routes.js';
import { registerPublicAppointmentManagementRoutes } from './public-management/routes.js';
import type { ReadinessProbe } from './readiness.js';
import { type RateLimiter, allowAllRateLimiter } from './rate-limit/limiter.js';
import { registerRateLimitHook } from './rate-limit/routes.js';
import { registerMonitoringRoute } from './monitoring/routes.js';
import type { MonitoringReader } from './monitoring/store.js';
import type { PublicPaidBookingOrchestrator } from './payment/public-orchestrator.js';
import type { ConnectService } from './stripe/connect-service.js';
import { registerConnectRoutes } from './stripe/connect-routes.js';
import type { StripeConnectAdapter } from './stripe/adapter.js';
import type { StripeWebhookStore } from './stripe/webhook-store.js';
import { registerStripeWebhookRoutes } from './stripe/webhook-routes.js';

interface BuildApplicationOptions {
  environment: Environment;
  readiness: ReadinessProbe;
  logger?: boolean;
  adminStore?: AdminStore;
  closeAdmin?: () => Promise<void>;
  rateLimiter?: RateLimiter;
  monitoringReader?: MonitoringReader;
  monitoringNow?: () => Date;
  connectService?: ConnectService;
  stripeAdapter?: StripeConnectAdapter;
  stripeWebhookStore?: StripeWebhookStore;
  paidBookingOrchestrator?: PublicPaidBookingOrchestrator;
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
  rateLimiter,
  monitoringReader,
  monitoringNow,
  connectService,
  stripeAdapter,
  stripeWebhookStore,
  paidBookingOrchestrator,
}: BuildApplicationOptions): Promise<FastifyInstance> {
  if (environment.STRIPE_PAYMENT_EXECUTION_ENABLED && !paidBookingOrchestrator)
    throw new Error('Payment execution enabled without paid-booking orchestration');
  const app = Fastify({
    logger: logger ? createLoggerOptions(environment) : false,
    genReqId: (request) => resolveCorrelationId(request.headers['x-request-id']),
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: isTrustedProxyAddress,
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
    request.log.info({
      event: 'http.request.started',
      request_id: request.id,
      client_ip: clientIp(request, environment),
    });
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

  registerMonitoringRoute(
    app,
    environment,
    monitoringReader ?? {
      read: async () => Promise.reject(new Error('Monitoring persistence unavailable')),
    },
    monitoringNow,
  );
  if (stripeAdapter && stripeWebhookStore)
    registerStripeWebhookRoutes(app, environment, stripeAdapter, stripeWebhookStore);

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
    const effectiveRateLimiter =
      rateLimiter ??
      (environment.NODE_ENV === 'test'
        ? allowAllRateLimiter
        : (() => {
            throw new Error(
              'Shared rate limiting is required when administrative routes are enabled',
            );
          })());
    registerRateLimitHook(app, environment, effectiveRateLimiter);
    registerAdminRoutes(app, environment, adminStore, effectiveRateLimiter);
    registerCatalogRoutes(app, environment, adminStore);
    registerProviderRoutes(app, environment, adminStore);
    registerAvailabilityRoutes(app, environment, adminStore);
    registerCustomerRoutes(app, environment, adminStore);
    registerAppointmentRoutes(app, environment, adminStore);
    registerPublicBookingRoutes(app, environment, adminStore, paidBookingOrchestrator);
    registerNotificationRoutes(app, environment, adminStore);
    registerPublicAppointmentManagementRoutes(app, environment, adminStore);
    if (connectService) registerConnectRoutes(app, environment, adminStore, connectService);
  }

  app.addHook('onClose', async () => {
    await readiness.close();
    await closeAdmin?.();
  });

  return app;
}

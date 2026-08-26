import pino from 'pino';
import { MongoClient } from 'mongodb';

import { loadWorkerEnvironment } from './config.js';
import { createWorkerLifecycle } from './lifecycle.js';
import { startNotificationWorker } from './notification-worker.js';
import { startWorkerHeartbeat } from './heartbeat.js';
import { startStripeWebhookWorker } from './stripe-webhook-worker.js';

async function start(): Promise<void> {
  const environment = loadWorkerEnvironment();
  const logger = pino({
    level: environment.LOG_LEVEL,
    base: {
      service: 'booknowtech-worker',
      environment: environment.NODE_ENV,
      version: environment.BUILD_VERSION,
    },
    redact: {
      paths: ['*.authorization', '*.cookie', '*.credential', '*.password', '*.secret', '*.token'],
      censor: '[REDACTED]',
    },
  });
  const lifecycle = createWorkerLifecycle(logger);
  const mongo = new MongoClient(environment.MONGODB_URI);
  await mongo.connect();
  const heartbeat = await startWorkerHeartbeat(
    mongo.db(environment.MONGODB_DATABASE),
    environment,
    logger,
  );
  const notificationWorker = startNotificationWorker(
    mongo.db(environment.MONGODB_DATABASE),
    environment,
    logger,
  );
  const stripeWebhookWorker = environment.STRIPE_SECRET_KEY
    ? startStripeWebhookWorker(
        mongo.db(environment.MONGODB_DATABASE),
        environment.STRIPE_SECRET_KEY,
        logger,
        {
          publicAppointmentTokenSecret: environment.PUBLIC_APPOINTMENT_TOKEN_SECRET,
          paymentTermsVersion: environment.BOOKNOWTECH_PAYMENT_TERMS_VERSION,
          paymentTermsDocumentSha256: environment.BOOKNOWTECH_PAYMENT_TERMS_TEXT_SHA256,
        },
      )
    : null;

  logger.info({ event: 'service.started' });
  const signal = await lifecycle.waitForShutdown();
  logger.info({ event: 'service.stopping', signal });
  await heartbeat.stop();
  await notificationWorker.stop();
  await stripeWebhookWorker?.stop();
  await mongo.close();
  lifecycle.dispose();
  logger.info({ event: 'service.stopped' });
}

void start().catch((error: unknown) => {
  process.stderr.write(
    `Worker startup failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
  );
  process.exitCode = 1;
});

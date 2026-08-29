import pino from 'pino';
import { MongoClient } from 'mongodb';
import Stripe from 'stripe';

import { loadWorkerEnvironment } from './config.js';
import { createWorkerLifecycle } from './lifecycle.js';
import { startNotificationWorker } from './notification-worker.js';
import { startWorkerHeartbeat } from './heartbeat.js';
import { startStripeWebhookWorker } from './stripe-webhook-worker.js';
import { startPaymentReconciliationWorker } from './payment-reconciliation-worker.js';

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
  const reconciliationStripe = environment.STRIPE_SECRET_KEY
    ? new Stripe(environment.STRIPE_SECRET_KEY, { maxNetworkRetries: 2, timeout: 10_000 })
    : null;
  const paymentReconciliationWorker = reconciliationStripe
    ? startPaymentReconciliationWorker(
        mongo.db(environment.MONGODB_DATABASE),
        {
          retrievePaymentIntent: async (accountId, intentId) =>
            toReconciliationIntent(
              await reconciliationStripe.paymentIntents.retrieve(intentId, undefined, {
                stripeAccount: accountId,
              }),
            ),
          cancelPaymentIntent: async (accountId, intentId, idempotencyKey) =>
            toReconciliationIntent(
              await reconciliationStripe.paymentIntents.cancel(intentId, undefined, {
                stripeAccount: accountId,
                idempotencyKey,
              }),
            ),
        },
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
  await paymentReconciliationWorker?.stop();
  await mongo.close();
  lifecycle.dispose();
  logger.info({ event: 'service.stopped' });
}

function toReconciliationIntent(intent: Stripe.PaymentIntent) {
  if (
    ![
      'requires_payment_method',
      'requires_confirmation',
      'requires_action',
      'processing',
      'canceled',
      'succeeded',
    ].includes(intent.status)
  )
    throw new Error('unsupported_payment_intent_status');
  return {
    id: intent.id,
    status: intent.status as
      | 'requires_payment_method'
      | 'requires_confirmation'
      | 'requires_action'
      | 'processing'
      | 'canceled'
      | 'succeeded',
    amount: intent.amount,
    applicationFeeAmount: intent.application_fee_amount,
    currency: intent.currency,
  };
}

void start().catch((error: unknown) => {
  process.stderr.write(
    `Worker startup failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
  );
  process.exitCode = 1;
});

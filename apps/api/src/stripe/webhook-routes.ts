import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

import type { Environment } from '../config.js';
import type { StripeConnectAdapter } from './adapter.js';
import type { StripeWebhookStore } from './webhook-store.js';

const MAX_WEBHOOK_BYTES = 256 * 1024;

export function registerStripeWebhookRoutes(
  app: FastifyInstance,
  environment: Environment,
  stripe: StripeConnectAdapter,
  store: StripeWebhookStore,
) {
  void app.register((scope) => {
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: MAX_WEBHOOK_BYTES },
      (_request, body, done) => done(null, body),
    );
    for (const endpointKind of ['platform', 'connect'] as const) {
      scope.post<{ Body: Buffer }>(
        `/webhooks/stripe/${endpointKind}`,
        { bodyLimit: MAX_WEBHOOK_BYTES },
        async (request, reply) => {
          const signature = request.headers['stripe-signature'];
          if (typeof signature !== 'string')
            return reply
              .status(400)
              .send({ error: { code: 'invalid_signature', message: 'Invalid webhook.' } });
          try {
            const secret =
              endpointKind === 'platform'
                ? environment.STRIPE_PLATFORM_WEBHOOK_SECRET!
                : environment.STRIPE_CONNECT_WEBHOOK_SECRET!;
            const event = stripe.verifyWebhook(request.body, signature, secret);
            if (event.livemode !== (environment.ENVIRONMENT_ID === 'production'))
              return reply
                .status(400)
                .send({ error: { code: 'mode_mismatch', message: 'Invalid webhook.' } });
            await store.ingest({
              event,
              endpointKind,
              requestId: request.id,
              payloadHash: createHash('sha256').update(request.body).digest('hex'),
            });
            return reply.status(200).send({ received: true });
          } catch (reason) {
            request.log.warn({
              event: 'stripe.webhook_rejected',
              endpoint_kind: endpointKind,
              error_name: reason instanceof Error ? reason.name : 'unknown',
            });
            return reply
              .status(400)
              .send({ error: { code: 'invalid_webhook', message: 'Invalid webhook.' } });
          }
        },
      );
    }
    return Promise.resolve();
  });
}

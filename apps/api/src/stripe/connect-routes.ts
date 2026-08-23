import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AdminStore, VerifiedAdminContext } from '../admin/store.js';
import { authenticateAdminMutation, authenticateAdminRequest } from '../auth/routes.js';
import { clientIp } from '../client-ip.js';
import type { Environment } from '../config.js';
import type { ConnectActor } from './connect-store.js';
import type { ConnectService } from './connect-service.js';

const managers = new Set(['tenant_owner', 'tenant_admin']);

export function registerConnectRoutes(
  app: FastifyInstance,
  environment: Environment,
  adminStore: AdminStore,
  service: ConnectService,
) {
  app.get('/api/v1/admin/payments/connect/status', async (request, reply) => {
    const context = await requireManager(request, reply, adminStore);
    if (!context) return;
    const result = await service.status(actor(context, request.id));
    return reply.send({ data: publicStatus(result, environment) });
  });
  app.post<{ Body: { accepted: boolean } }>(
    '/api/v1/admin/payments/connect/terms-acceptance',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['accepted'],
          properties: { accepted: { const: true } },
        },
      },
    },
    async (request, reply) => {
      const context = await requireManagerMutation(request, reply, environment, adminStore);
      if (!context) return;
      try {
        const ipHash = createHash('sha256')
          .update(`${environment.RATE_LIMIT_KEY_SECRET}|${clientIp(request, environment)}`)
          .digest('hex');
        const result = await service.acceptTerms(actor(context, request.id), ipHash);
        return reply.status(result.changed ? 201 : 200).send({
          data: {
            terms_version: environment.BOOKNOWTECH_CONNECT_TERMS_VERSION,
            accepted: true,
            changed: result.changed,
          },
        });
      } catch (reason) {
        return connectError(reply, reason, request.id);
      }
    },
  );
  app.post('/api/v1/admin/payments/connect/onboarding', async (request, reply) => {
    const context = await requireManagerMutation(request, reply, environment, adminStore);
    if (!context) return;
    try {
      const account = await service.onboard(actor(context, request.id));
      return reply.send({ data: sanitizeAccount(account) });
    } catch (reason) {
      return connectError(reply, reason, request.id);
    }
  });
  app.post('/api/v1/admin/payments/connect/account-link', async (request, reply) => {
    const context = await requireManagerMutation(request, reply, environment, adminStore);
    if (!context) return;
    try {
      const link = await service.accountLink(actor(context, request.id));
      return reply.send({ data: { url: link.url, expires_at: link.expiresAt.toISOString() } });
    } catch (reason) {
      return connectError(reply, reason, request.id);
    }
  });
}

function actor(context: VerifiedAdminContext, requestId: string): ConnectActor {
  return {
    tenantId: context.tenant!._id,
    tenantPublicId: context.tenant!.public_id,
    tenantCurrency: context.tenant!.currency,
    userId: context.user._id,
    membershipId: context.membership!._id,
    requestId,
  };
}
async function requireManager(request: FastifyRequest, reply: FastifyReply, store: AdminStore) {
  const context = await authenticateAdminRequest(request, store);
  if (!context) return error(reply, 401, 'authentication_required', request.id);
  if (!context.tenant || !context.membership)
    return error(reply, 409, 'tenant_selection_required', request.id);
  if (!managers.has(context.membership.role)) return error(reply, 403, 'forbidden', request.id);
  return context;
}
async function requireManagerMutation(
  request: FastifyRequest,
  reply: FastifyReply,
  environment: Environment,
  store: AdminStore,
) {
  const context = await authenticateAdminMutation(request, reply, environment, store);
  if (!context) return;
  if (!context.tenant || !context.membership)
    return error(reply, 409, 'tenant_selection_required', request.id);
  if (!managers.has(context.membership.role)) return error(reply, 403, 'forbidden', request.id);
  return context;
}
function publicStatus(
  result: Awaited<ReturnType<ConnectService['status']>>,
  environment: Environment,
) {
  return {
    foundation_enabled: environment.STRIPE_CONNECT_FOUNDATION_ENABLED,
    booknowtech_terms: {
      version: environment.BOOKNOWTECH_CONNECT_TERMS_VERSION,
      accepted: result.termsAccepted,
    },
    account: result.account ? sanitizeAccount(result.account) : null,
  };
}
function sanitizeAccount(account: Record<string, unknown>) {
  return {
    public_id: account.public_id,
    status: account.status,
    details_submitted: account.details_submitted,
    charges_enabled: account.charges_enabled,
    payouts_enabled: account.payouts_enabled,
    capabilities: account.capabilities,
    requirements: account.requirements,
    last_synced_at: account.last_synced_at,
  };
}
function connectError(reply: FastifyReply, reason: unknown, requestId: string) {
  const candidate = reason instanceof Error ? reason.message : '';
  const code = [
    'foundation_disabled',
    'terms_required',
    'account_required',
    'idempotency_conflict',
  ].includes(candidate)
    ? candidate
    : 'stripe_connect_unavailable';
  const status =
    code === 'foundation_disabled'
      ? 503
      : code === 'terms_required' || code === 'account_required' || code === 'idempotency_conflict'
        ? 409
        : 502;
  return error(reply, status, code, requestId);
}
function error(reply: FastifyReply, status: number, code: string, requestId: string) {
  return reply.status(status).send({
    error: { code, message: 'The request could not be completed.', request_id: requestId },
  });
}

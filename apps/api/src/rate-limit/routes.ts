import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { clientIp } from '../client-ip.js';
import type { Environment } from '../config.js';
import type { RateLimiter } from './limiter.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function registerRateLimitHook(
  app: FastifyInstance,
  environment: Environment,
  limiter: RateLimiter,
): void {
  app.addHook('preHandler', async (request, reply) => {
    const policy = policyFor(request, environment, limiter);
    if (!policy) return;
    try {
      const decision = await limiter.consume(policy);
      request.log.info({
        event: 'rate_limit.checked',
        scope: policy.scope,
        outcome: decision.allowed ? 'allowed' : 'rejected',
      });
      if (decision.allowed) return;
      void reply.header('Retry-After', String(decision.retryAfterSeconds));
      return rateLimitError(reply, request, policy.scope);
    } catch (error) {
      request.log.warn({ err: error, event: 'rate_limit.failed', scope: policy.scope });
      return unavailableError(reply, request, policy.scope);
    }
  });
}

function policyFor(request: FastifyRequest, environment: Environment, limiter: RateLimiter) {
  const route = request.routeOptions.url;
  const ip = clientIp(request, environment);
  if (route === '/api/v1/auth/login')
    return policy('admin_login_ip', 'platform', ip, 20, 15 * 60_000);
  if (!route?.startsWith('/api/v1/public/')) return null;
  const hostKey = limiter.tenantKey(request.hostname.toLowerCase());
  const ipHost = `${ip}|${request.hostname.toLowerCase()}`;
  if (route === '/api/v1/public/appointments' && request.method === 'POST')
    return policy('public_appointment_create', hostKey, ipHost, 10, 10 * 60_000);
  if (route.endsWith('/available-starts')) {
    if (route.includes('/appointments/manage/'))
      return managementPolicy(request, hostKey, ip, 'management_availability', 30, 60_000);
    return policy('public_availability', hostKey, ipHost, 60, 60_000);
  }
  if (route.includes('/appointments/manage/')) {
    const mutation = request.method !== 'GET';
    return managementPolicy(
      request,
      hostKey,
      ip,
      mutation ? 'management_mutation' : 'management_read',
      mutation ? 10 : 30,
      mutation ? 10 * 60_000 : 60_000,
    );
  }
  return policy('public_discovery', hostKey, ipHost, 120, 60_000);
}

function managementPolicy(
  request: FastifyRequest,
  tenantKey: string,
  ip: string,
  scope: string,
  limit: number,
  windowMilliseconds: number,
) {
  const raw = (request.params as { tokenPublicId?: unknown } | undefined)?.tokenPublicId;
  const tokenDimension =
    typeof raw === 'string' && UUID.test(raw) ? raw.toLowerCase() : 'malformed';
  return policy(scope, tenantKey, `${ip}|${tokenDimension}`, limit, windowMilliseconds);
}

function policy(
  scope: string,
  tenantKey: string,
  subject: string,
  limit: number,
  windowMilliseconds: number,
) {
  return { scope, tenantKey, subject, limit, windowMilliseconds };
}

function rateLimitError(reply: FastifyReply, request: FastifyRequest, scope: string) {
  if (scope === 'admin_login_ip')
    return reply.status(429).send(authEnvelope('rate_limited', request.id));
  const code = scope.startsWith('management_')
    ? 'rate_limit_exceeded'
    : 'public_rate_limit_exceeded';
  return reply.status(429).send(publicEnvelope(code, request.id));
}

function unavailableError(reply: FastifyReply, request: FastifyRequest, scope: string) {
  if (scope === 'admin_login_ip')
    return reply.status(503).send(authEnvelope('authorization_unavailable', request.id));
  return reply.status(503).send(publicEnvelope('service_unavailable', request.id));
}

function authEnvelope(code: string, requestId: string) {
  return {
    error: { code, message: 'The request could not be authorized.', request_id: requestId },
  };
}

function publicEnvelope(code: string, requestId: string) {
  return { error: { code, message: 'The request could not be completed.', request_id: requestId } };
}

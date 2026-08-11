import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AdminStore, SessionCredential, VerifiedAdminContext } from '../admin/store.js';
import type { Environment } from '../config.js';
import { hashPassword, validateReplacementPassword, verifyPassword } from './password.js';
import { type RateLimiter, allowAllRateLimiter } from '../rate-limit/limiter.js';

const SESSION_COOKIE = '__Host-bnt_admin_session';

interface LoginBody {
  email: string;
  password: string;
}

interface SelectMembershipBody {
  membership_public_id: string;
}

interface ChangePasswordBody {
  current_password: string;
  new_password: string;
}

export function registerAdminRoutes(
  app: FastifyInstance,
  environment: Environment,
  store: AdminStore,
  rateLimiter: RateLimiter = allowAllRateLimiter,
): void {
  app.post<{ Body: LoginBody }>(
    '/api/v1/auth/login',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['email', 'password'],
          properties: {
            email: { type: 'string', minLength: 3, maxLength: 320 },
            password: { type: 'string', minLength: 1, maxLength: 1024 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!validOrigin(request, environment.ADMIN_ORIGIN)) {
        return reply.status(403).send(authError('origin_rejected', request.id));
      }
      const user = await store.findUserByEmail(request.body.email);
      const valid = user ? await verifyPassword(request.body.password, user.password_hash) : false;
      if (!user || !valid) {
        let accountDecision;
        try {
          accountDecision = await rateLimiter.consume({
            scope: 'admin_login_account',
            tenantKey: 'platform',
            subject: request.body.email.trim().toLowerCase(),
            limit: 5,
            windowMilliseconds: 15 * 60_000,
          });
        } catch (error) {
          request.log.warn({
            err: error,
            event: 'rate_limit.failed',
            scope: 'admin_login_account',
          });
          return reply.status(503).send(authError('authorization_unavailable', request.id));
        }
        request.log.info({
          event: 'rate_limit.checked',
          scope: 'admin_login_account',
          outcome: accountDecision.allowed ? 'allowed' : 'rejected',
        });
        if (!accountDecision.allowed) {
          void reply.header('Retry-After', String(accountDecision.retryAfterSeconds));
          return reply.status(429).send(authError('rate_limited', request.id));
        }
        await store.audit({
          event: 'admin_login_failed',
          outcome: 'failure',
          requestId: request.id,
          metadata: { reason: 'invalid_credentials' },
        });
        return reply.status(401).send(authError('invalid_credentials', request.id));
      }

      const credential = await store.createSession(user._id, request.id);
      setSessionCookie(reply, credential);
      await store.audit({
        event: 'admin_login_succeeded',
        outcome: 'success',
        actorUserId: user._id,
        requestId: request.id,
      });
      const context = await store.hydrateSession(credential.token);
      return reply.send(sessionEnvelope(context!, credential.csrfToken, request.id));
    },
  );

  app.get('/api/v1/auth/session', async (request, reply) => {
    const context = await authenticateAdminRequest(request, store, { allowPasswordChange: true });
    if (!context) return reply.status(401).send(authError('authentication_required', request.id));
    const csrfToken = await store.rotateCsrf(context.session);
    return reply.send(sessionEnvelope(context, csrfToken, request.id));
  });

  app.post<{ Body: ChangePasswordBody }>(
    '/api/v1/auth/change-password',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['current_password', 'new_password'],
          properties: {
            current_password: { type: 'string', minLength: 1, maxLength: 256 },
            new_password: { type: 'string', minLength: 1, maxLength: 256 },
          },
        },
      },
    },
    async (request, reply) => {
      const context = await authenticateAdminMutation(request, reply, environment, store, {
        allowPasswordChange: true,
      });
      if (!context) return;
      if (!context.user.must_change_password)
        return reply.status(409).send(authError('password_change_not_required', request.id));
      let decision;
      try {
        decision = await rateLimiter.consume({
          scope: 'admin_password_change_account',
          tenantKey: 'platform',
          subject: context.user.public_id,
          limit: 5,
          windowMilliseconds: 15 * 60_000,
        });
      } catch (error) {
        request.log.warn({
          err: error,
          event: 'rate_limit.failed',
          scope: 'admin_password_change_account',
        });
        return reply.status(503).send(authError('authorization_unavailable', request.id));
      }
      if (!decision.allowed) {
        void reply.header('Retry-After', String(decision.retryAfterSeconds));
        return reply.status(429).send(authError('rate_limited', request.id));
      }
      const currentPasswordValid = await verifyPassword(
        request.body.current_password,
        context.user.password_hash,
      );
      if (!currentPasswordValid) {
        await store.audit({
          event: 'initial_owner_password_change_failed',
          outcome: 'failure',
          actorUserId: context.user._id,
          tenantId: context.tenant?._id ?? null,
          requestId: request.id,
          metadata: { reason: 'invalid_current_password' },
        });
        return reply.status(401).send(authError('invalid_credentials', request.id));
      }
      if (
        !validateReplacementPassword(request.body.new_password) ||
        request.body.new_password === request.body.current_password
      ) {
        return reply.status(400).send(authError('invalid_new_password', request.id));
      }
      const credential = await store.replaceInitialPassword({
        context,
        passwordHash: await hashPassword(request.body.new_password),
        requestId: request.id,
      });
      if (!credential)
        return reply.status(409).send(authError('password_change_not_required', request.id));
      setSessionCookie(reply, credential);
      const nextContext = await store.hydrateSession(credential.token);
      return reply.send(sessionEnvelope(nextContext!, credential.csrfToken, request.id));
    },
  );

  app.post<{ Body: SelectMembershipBody }>(
    '/api/v1/auth/select-membership',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['membership_public_id'],
          properties: { membership_public_id: { type: 'string', minLength: 1, maxLength: 128 } },
        },
      },
    },
    async (request, reply) => {
      const context = await authenticateAdminMutation(request, reply, environment, store);
      if (!context) return;
      const credential = await store.switchMembership(
        context,
        request.body.membership_public_id,
        request.id,
      );
      if (!credential) {
        await store.audit({
          event: 'admin_tenant_switch_rejected',
          outcome: 'failure',
          actorUserId: context.user._id,
          tenantId: context.tenant?._id ?? null,
          requestId: request.id,
          metadata: { reason: 'membership_not_available' },
        });
        return reply.status(403).send(authError('membership_not_available', request.id));
      }
      setSessionCookie(reply, credential);
      const nextContext = await store.hydrateSession(credential.token);
      await store.audit({
        event: 'admin_tenant_switched',
        outcome: 'success',
        actorUserId: context.user._id,
        tenantId: nextContext?.tenant?._id ?? null,
        requestId: request.id,
      });
      return reply.send(sessionEnvelope(nextContext!, credential.csrfToken, request.id));
    },
  );

  app.post('/api/v1/auth/logout', async (request, reply) => {
    const context = await authenticateAdminMutation(request, reply, environment, store, {
      allowPasswordChange: true,
    });
    if (!context) return;
    await store.revokeSession(context.session, 'logout');
    clearSessionCookie(reply);
    await store.audit({
      event: 'admin_logout',
      outcome: 'success',
      actorUserId: context.user._id,
      tenantId: context.tenant?._id ?? null,
      requestId: request.id,
    });
    return reply.status(204).send();
  });

  app.get('/api/v1/admin/tenant', async (request, reply) => {
    const context = await authenticateAdminRequest(request, store);
    if (!context) return reply.status(401).send(authError('authentication_required', request.id));
    if (!context.tenant || !context.membership) {
      return reply.status(403).send(authError('tenant_selection_required', request.id));
    }
    return reply.send({
      data: {
        tenant: {
          public_id: context.tenant.public_id,
          slug: context.tenant.slug,
          display_name: context.tenant.display_name,
        },
        role: context.membership.role,
      },
      meta: { request_id: request.id },
    });
  });
}

export async function authenticateAdminRequest(
  request: FastifyRequest,
  store: AdminStore,
  options: { allowPasswordChange?: boolean } = {},
): Promise<VerifiedAdminContext | null> {
  const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
  const context = token ? await store.hydrateSession(token) : null;
  if (context?.user.must_change_password && !options.allowPasswordChange) return null;
  return context;
}

export async function authenticateAdminMutation(
  request: FastifyRequest,
  reply: FastifyReply,
  environment: Environment,
  store: AdminStore,
  options: { allowPasswordChange?: boolean } = {},
): Promise<VerifiedAdminContext | null> {
  if (!validOrigin(request, environment.ADMIN_ORIGIN)) {
    await reply.status(403).send(authError('origin_rejected', request.id));
    return null;
  }
  const context = await authenticateAdminRequest(request, store, options);
  if (!context) {
    await reply.status(401).send(authError('authentication_required', request.id));
    return null;
  }
  const csrf =
    typeof request.headers['x-csrf-token'] === 'string'
      ? request.headers['x-csrf-token']
      : undefined;
  if (!store.verifyCsrf(context.session, csrf)) {
    await reply.status(403).send(authError('csrf_rejected', request.id));
    return null;
  }
  return context;
}

function sessionEnvelope(
  context: VerifiedAdminContext,
  csrfToken: string,
  requestId: string,
): Record<string, unknown> {
  return {
    data: {
      user: { public_id: context.user.public_id, display_name: context.user.display_name },
      must_change_password: context.user.must_change_password,
      active_tenant: context.user.must_change_password
        ? null
        : context.tenant
          ? {
              public_id: context.tenant.public_id,
              display_name: context.tenant.display_name,
              role: context.membership?.role,
            }
          : null,
      memberships: context.user.must_change_password
        ? []
        : context.memberships.map(({ membership, tenant }) => ({
            public_id: membership.public_id,
            role: membership.role,
            tenant: { public_id: tenant.public_id, display_name: tenant.display_name },
          })),
      csrf_token: csrfToken,
    },
    meta: { request_id: requestId },
  };
}

function authError(code: string, requestId: string): Record<string, unknown> {
  return {
    error: { code, message: 'The request could not be authorized.', request_id: requestId },
  };
}

function validOrigin(request: FastifyRequest, expected: string): boolean {
  const origin = request.headers.origin;
  return origin === undefined || origin === expected;
}

function setSessionCookie(reply: FastifyReply, credential: SessionCredential): void {
  const maxAge = Math.max(0, Math.floor((credential.expiresAt.getTime() - Date.now()) / 1_000));
  void reply.header(
    'set-cookie',
    `${SESSION_COOKIE}=${credential.token}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`,
  );
}

function clearSessionCookie(reply: FastifyReply): void {
  void reply.header(
    'set-cookie',
    `${SESSION_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`,
  );
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header.split(';').flatMap((part) => {
      const index = part.indexOf('=');
      if (index < 1) return [];
      return [[part.slice(0, index).trim(), part.slice(index + 1).trim()]];
    }),
  );
}

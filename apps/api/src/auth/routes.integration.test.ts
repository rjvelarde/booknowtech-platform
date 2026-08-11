import { ObjectId } from 'mongodb';
import { describe, expect, it, vi } from 'vitest';

import { AdminStore, type VerifiedAdminContext } from '../admin/store.js';
import { buildApplication } from '../app.js';
import { hashPassword, verifyPassword } from './password.js';
import { StubReadinessProbe, testEnvironment } from '../test-fixtures.js';
import type { RateLimiter } from '../rate-limit/limiter.js';

describe('administrative authentication routes', () => {
  it('applies shared IP and failed-account login limits with the generic envelope', async () => {
    const store = Object.create(AdminStore.prototype) as AdminStore;
    vi.spyOn(store, 'findUserByEmail').mockResolvedValue(null);
    vi.spyOn(store, 'audit').mockResolvedValue();
    const scopes: string[] = [];
    const limiter: RateLimiter = {
      tenantKey: () => 'platform',
      consume: (request) => {
        scopes.push(request.scope);
        const rejected = request.scope === 'admin_login_account';
        return Promise.resolve({
          allowed: !rejected,
          count: rejected ? 6 : 1,
          limit: request.limit,
          retryAfterSeconds: 321,
          bucketStartedAt: new Date(0),
        });
      },
    };
    const app = await buildApplication({
      environment: { ...testEnvironment, TENANT_ADMIN_ENABLED: true },
      readiness: new StubReadinessProbe(),
      adminStore: store,
      rateLimiter: limiter,
      logger: false,
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: testEnvironment.ADMIN_ORIGIN },
      payload: { email: 'missing@example.test', password: 'wrong' },
    });
    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('321');
    expect(response.json().error).toMatchObject({
      code: 'rate_limited',
      message: 'The request could not be authorized.',
    });
    expect(scopes).toEqual(['admin_login_ip', 'admin_login_account']);
    await app.close();
  });

  it('logs in with a host-only secure session and returns verified membership context', async () => {
    const store = Object.create(AdminStore.prototype) as AdminStore;
    const userId = new ObjectId();
    const user = {
      _id: userId,
      public_id: 'user-public',
      email_normalized: 'owner@example.test',
      display_name: 'Owner',
      password_hash: await hashPassword('correct horse battery staple'),
      must_change_password: false,
      status: 'active' as const,
      created_at: new Date(),
      updated_at: new Date(),
    };
    vi.spyOn(store, 'findUserByEmail').mockResolvedValue(user);
    vi.spyOn(store, 'createSession').mockResolvedValue({
      token: 'session-token',
      csrfToken: 'csrf-token',
      expiresAt: new Date(Date.now() + 60_000),
    });
    vi.spyOn(store, 'hydrateSession').mockResolvedValue(contextFixture(userId));
    vi.spyOn(store, 'audit').mockResolvedValue();
    const app = await buildApplication({
      environment: { ...testEnvironment, TENANT_ADMIN_ENABLED: true },
      readiness: new StubReadinessProbe(),
      adminStore: store,
      logger: false,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: testEnvironment.ADMIN_ORIGIN },
      payload: { email: 'owner@example.test', password: 'correct horse battery staple' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).toContain('__Host-bnt_admin_session=session-token');
    expect(response.headers['set-cookie']).toContain('Secure; HttpOnly; SameSite=Lax');
    expect(response.headers['set-cookie']).not.toContain('Domain=');
    expect(response.json().data.active_tenant.public_id).toBe('tenant-public');
    await app.close();
  });

  it('ignores client tenant override values and returns only session-selected context', async () => {
    const store = Object.create(AdminStore.prototype) as AdminStore;
    vi.spyOn(store, 'hydrateSession').mockResolvedValue(contextFixture(new ObjectId()));
    const app = await buildApplication({
      environment: { ...testEnvironment, TENANT_ADMIN_ENABLED: true },
      readiness: new StubReadinessProbe(),
      adminStore: store,
      logger: false,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/tenant?tenant_id=attacker-tenant',
      headers: {
        cookie: '__Host-bnt_admin_session=session-token',
        'x-tenant-id': 'attacker-tenant',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.tenant.public_id).toBe('tenant-public');
    expect(response.body).not.toContain('attacker-tenant');
    await app.close();
  });

  it('limits a first-login user to the password-change session envelope and blocks protected APIs', async () => {
    const store = Object.create(AdminStore.prototype) as AdminStore;
    const context = contextFixture(new ObjectId(), { mustChangePassword: true });
    vi.spyOn(store, 'hydrateSession').mockResolvedValue(context);
    vi.spyOn(store, 'rotateCsrf').mockResolvedValue('rotated-csrf');
    const app = await buildApplication({
      environment: { ...testEnvironment, TENANT_ADMIN_ENABLED: true },
      readiness: new StubReadinessProbe(),
      adminStore: store,
      logger: false,
    });

    const session = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie: '__Host-bnt_admin_session=session-token' },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json().data).toMatchObject({
      must_change_password: true,
      active_tenant: null,
      memberships: [],
      csrf_token: 'rotated-csrf',
    });

    const protectedResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/tenant',
      headers: { cookie: '__Host-bnt_admin_session=session-token' },
    });
    expect(protectedResponse.statusCode).toBe(401);
    expect(protectedResponse.json().error.code).toBe('authentication_required');
    await app.close();
  });

  it('replaces a temporary password through the CSRF-protected, rate-limited flow without returning it', async () => {
    const store = Object.create(AdminStore.prototype) as AdminStore;
    const userId = new ObjectId();
    const context = contextFixture(userId, {
      mustChangePassword: true,
      passwordHash: await hashPassword('Temporary password 123'),
    });
    const nextContext = contextFixture(userId);
    vi.spyOn(store, 'hydrateSession')
      .mockResolvedValueOnce(context)
      .mockResolvedValueOnce(nextContext);
    vi.spyOn(store, 'verifyCsrf').mockReturnValue(true);
    const replace = vi.spyOn(store, 'replaceInitialPassword').mockResolvedValue({
      token: 'rotated-session-token',
      csrfToken: 'rotated-csrf-token',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const limiter: RateLimiter = {
      tenantKey: () => 'platform',
      consume: () =>
        Promise.resolve({
          allowed: true,
          count: 1,
          limit: 5,
          retryAfterSeconds: 0,
          bucketStartedAt: new Date(),
        }),
    };
    const app = await buildApplication({
      environment: { ...testEnvironment, TENANT_ADMIN_ENABLED: true },
      readiness: new StubReadinessProbe(),
      adminStore: store,
      rateLimiter: limiter,
      logger: false,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: {
        origin: testEnvironment.ADMIN_ORIGIN,
        cookie: '__Host-bnt_admin_session=session-token',
        'x-csrf-token': 'csrf-token',
      },
      payload: {
        current_password: 'Temporary password 123',
        new_password: 'Replacement password 456',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).toContain('rotated-session-token');
    expect(response.json().data.must_change_password).toBe(false);
    const input = replace.mock.calls[0]?.[0];
    expect(input).toBeDefined();
    expect(input?.passwordHash).not.toContain('Replacement password 456');
    expect(await verifyPassword('Replacement password 456', input!.passwordHash)).toBe(true);
    expect(response.body).not.toContain('Temporary password 123');
    expect(response.body).not.toContain('Replacement password 456');
    await app.close();
  });

  it('rejects incorrect temporary passwords without changing the first-login requirement', async () => {
    const store = Object.create(AdminStore.prototype) as AdminStore;
    const context = contextFixture(new ObjectId(), {
      mustChangePassword: true,
      passwordHash: await hashPassword('Temporary password 123'),
    });
    vi.spyOn(store, 'hydrateSession').mockResolvedValue(context);
    vi.spyOn(store, 'verifyCsrf').mockReturnValue(true);
    const replace = vi.spyOn(store, 'replaceInitialPassword');
    const audit = vi.spyOn(store, 'audit').mockResolvedValue();
    const app = await buildApplication({
      environment: { ...testEnvironment, TENANT_ADMIN_ENABLED: true },
      readiness: new StubReadinessProbe(),
      adminStore: store,
      logger: false,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: {
        origin: testEnvironment.ADMIN_ORIGIN,
        cookie: '__Host-bnt_admin_session=session-token',
        'x-csrf-token': 'csrf-token',
      },
      payload: { current_password: 'wrong', new_password: 'Replacement password 456' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('invalid_credentials');
    expect(replace).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'initial_owner_password_change_failed',
        metadata: { reason: 'invalid_current_password' },
      }),
    );
    expect(JSON.stringify(audit.mock.calls)).not.toContain('wrong');
    await app.close();
  });

  it('rejects weak passwords, missing CSRF, and rate-limited password changes safely', async () => {
    const store = Object.create(AdminStore.prototype) as AdminStore;
    const context = contextFixture(new ObjectId(), {
      mustChangePassword: true,
      passwordHash: await hashPassword('Temporary password 123'),
    });
    vi.spyOn(store, 'hydrateSession').mockResolvedValue(context);
    const verifyCsrf = vi.spyOn(store, 'verifyCsrf').mockReturnValue(true);
    const replace = vi.spyOn(store, 'replaceInitialPassword');
    const app = await buildApplication({
      environment: { ...testEnvironment, TENANT_ADMIN_ENABLED: true },
      readiness: new StubReadinessProbe(),
      adminStore: store,
      logger: false,
    });
    const headers = {
      origin: testEnvironment.ADMIN_ORIGIN,
      cookie: '__Host-bnt_admin_session=session-token',
      'x-csrf-token': 'csrf-token',
    };
    const weak = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers,
      payload: { current_password: 'Temporary password 123', new_password: 'short' },
    });
    expect(weak.statusCode).toBe(400);
    expect(weak.json().error.code).toBe('invalid_new_password');
    expect(replace).not.toHaveBeenCalled();

    verifyCsrf.mockReturnValue(false);
    const csrf = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers,
      payload: {
        current_password: 'Temporary password 123',
        new_password: 'Replacement password 456',
      },
    });
    expect(csrf.statusCode).toBe(403);
    expect(csrf.json().error.code).toBe('csrf_rejected');
    await app.close();

    const deniedLimiter: RateLimiter = {
      tenantKey: () => 'platform',
      consume: () =>
        Promise.resolve({
          allowed: false,
          count: 6,
          limit: 5,
          retryAfterSeconds: 123,
          bucketStartedAt: new Date(),
        }),
    };
    const limitedApp = await buildApplication({
      environment: { ...testEnvironment, TENANT_ADMIN_ENABLED: true },
      readiness: new StubReadinessProbe(),
      adminStore: store,
      rateLimiter: deniedLimiter,
      logger: false,
    });
    verifyCsrf.mockReturnValue(true);
    const limited = await limitedApp.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers,
      payload: {
        current_password: 'Temporary password 123',
        new_password: 'Replacement password 456',
      },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('123');
    expect(limited.json().error.code).toBe('rate_limited');
    await limitedApp.close();
  });

  it('revokes the session, audits logout, and clears the host-only cookie', async () => {
    const store = Object.create(AdminStore.prototype) as AdminStore;
    const context = contextFixture(new ObjectId());
    vi.spyOn(store, 'hydrateSession').mockResolvedValue(context);
    vi.spyOn(store, 'verifyCsrf').mockReturnValue(true);
    const revokeSession = vi.spyOn(store, 'revokeSession').mockResolvedValue({});
    const audit = vi.spyOn(store, 'audit').mockResolvedValue();
    const app = await buildApplication({
      environment: { ...testEnvironment, TENANT_ADMIN_ENABLED: true },
      readiness: new StubReadinessProbe(),
      adminStore: store,
      logger: false,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: {
        origin: testEnvironment.ADMIN_ORIGIN,
        cookie: '__Host-bnt_admin_session=session-token',
        'x-csrf-token': 'csrf-token',
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['set-cookie']).toContain('__Host-bnt_admin_session=;');
    expect(response.headers['set-cookie']).toContain('Max-Age=0; Secure; HttpOnly; SameSite=Lax');
    expect(revokeSession).toHaveBeenCalledWith(context.session, 'logout');
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'admin_logout', outcome: 'success' }),
    );
    await app.close();
  });
});

function contextFixture(
  userId: ObjectId,
  options: { mustChangePassword?: boolean; passwordHash?: string } = {},
): VerifiedAdminContext {
  const tenantId = new ObjectId();
  const membershipId = new ObjectId();
  const now = new Date();
  const user = {
    _id: userId,
    public_id: 'user-public',
    email_normalized: 'owner@example.test',
    display_name: 'Owner',
    password_hash: options.passwordHash ?? 'not-returned',
    must_change_password: options.mustChangePassword ?? false,
    status: 'active' as const,
    created_at: now,
    updated_at: now,
  };
  const tenant = {
    _id: tenantId,
    public_id: 'tenant-public',
    slug: 'tenant-slug',
    display_name: 'Tenant A',
    legal_name: null,
    contact: { email_normalized: null, phone_e164: null, website_url: null },
    public_booking_enabled: false,
    appointment_email_settings: { enabled: false, sender_name: 'Tenant', reply_to_email: null },
    appointment_self_service: {
      enabled: false,
      cancellation_cutoff_minutes: 1440,
      reschedule_cutoff_minutes: 1440,
    },
    public_profile: {
      business_name: 'Tenant A',
      description: null,
      tagline: null,
      logo_url: null,
      primary_color: null,
      website_url: null,
      phone_e164: null,
      email_normalized: null,
    },
    booking_policy: { minimum_lead_minutes: 120, maximum_advance_days: 90 },
    public_booking_terms: {
      version: 'test-v1',
      acknowledgment_label: 'I agree to the booking terms.',
      terms_url: null,
    },
    default_timezone: 'UTC',
    default_slot_cadence_minutes: 15,
    locale: 'en-US',
    currency: 'USD',
    designation: 'customer' as const,
    version: 1,
    updated_by: null,
    status: 'active' as const,
    created_at: now,
    updated_at: now,
  };
  const membership = {
    _id: membershipId,
    public_id: 'membership-public',
    tenant_id: tenantId,
    user_id: userId,
    role: 'tenant_owner' as const,
    status: 'active' as const,
    created_at: now,
    updated_at: now,
  };
  return {
    session: {
      _id: new ObjectId(),
      public_id: 'session-public',
      token_hash: 'hash',
      audience: 'admin',
      user_id: userId,
      selected_membership_id: membershipId,
      csrf_token_hash: 'csrf-hash',
      created_at: now,
      rotated_at: now,
      last_seen_at: now,
      expires_at: new Date(now.getTime() + 60_000),
      revoked_at: null,
      revocation_reason: null,
      created_request_id: 'request-id',
    },
    user,
    tenant,
    membership,
    memberships: [{ tenant, membership }],
  };
}

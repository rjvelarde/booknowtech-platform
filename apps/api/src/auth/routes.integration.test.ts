import { ObjectId } from 'mongodb';
import { describe, expect, it, vi } from 'vitest';

import { AdminStore, type VerifiedAdminContext } from '../admin/store.js';
import { buildApplication } from '../app.js';
import { hashPassword } from './password.js';
import { StubReadinessProbe, testEnvironment } from '../test-fixtures.js';

describe('administrative authentication routes', () => {
  it('logs in with a host-only secure session and returns verified membership context', async () => {
    const store = Object.create(AdminStore.prototype) as AdminStore;
    const userId = new ObjectId();
    const user = {
      _id: userId,
      public_id: 'user-public',
      email_normalized: 'owner@example.test',
      display_name: 'Owner',
      password_hash: await hashPassword('correct horse battery staple'),
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

function contextFixture(userId: ObjectId): VerifiedAdminContext {
  const tenantId = new ObjectId();
  const membershipId = new ObjectId();
  const now = new Date();
  const user = {
    _id: userId,
    public_id: 'user-public',
    email_normalized: 'owner@example.test',
    display_name: 'Owner',
    password_hash: 'not-returned',
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
    default_timezone: 'UTC',
    default_slot_cadence_minutes: 15,
    locale: 'en-US',
    currency: 'USD',
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

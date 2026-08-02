import { ObjectId } from 'mongodb';
import { describe, expect, it, vi } from 'vitest';

import { AdminStore, type ServiceDocument, type VerifiedAdminContext } from '../admin/store.js';
import { buildApplication } from '../app.js';
import { StubReadinessProbe, testEnvironment } from '../test-fixtures.js';

describe('tenant profile and service catalog routes', () => {
  it('scopes service reads to the verified selected tenant and ignores client overrides', async () => {
    const { app, store, context } = await testApp('tenant_owner');
    const list = vi.spyOn(store, 'listServices').mockResolvedValue([]);
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/services?tenant_id=attacker',
      headers: { cookie: '__Host-bnt_admin_session=token', 'x-tenant-id': 'attacker' },
    });
    expect(response.statusCode).toBe(200);
    expect(list).toHaveBeenCalledWith(context.tenant!._id);
    await app.close();
  });

  it('allows providers to view but not create services', async () => {
    const { app, store } = await testApp('provider');
    vi.spyOn(store, 'listServices').mockResolvedValue([]);
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/admin/services', headers: authHeaders() }))
        .statusCode,
    ).toBe(200);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/services',
      headers: mutationHeaders(),
      payload: validService(),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('insufficient_role');
    await app.close();
  });

  it('does not audit or advance a repeated lifecycle transition', async () => {
    const { app, store } = await testApp('tenant_admin');
    const service = serviceFixture('active');
    vi.spyOn(store, 'transitionService').mockResolvedValue('unchanged');
    vi.spyOn(store, 'getService').mockResolvedValue(service);
    const audit = vi.spyOn(store, 'audit').mockResolvedValue();
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/services/${service.public_id}/activate`,
      headers: mutationHeaders(),
      payload: { expected_version: 1 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.changed).toBe(false);
    expect(audit).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns the same safe 404 for an unavailable service', async () => {
    const { app, store } = await testApp('tenant_owner');
    vi.spyOn(store, 'getService').mockResolvedValue(null);
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/services/tenant-b-service',
      headers: authHeaders(),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('service_not_found');
    await app.close();
  });
});

async function testApp(role: 'tenant_owner' | 'tenant_admin' | 'provider' | 'front_desk') {
  const store = Object.create(AdminStore.prototype) as AdminStore;
  const context = contextFixture(role);
  vi.spyOn(store, 'hydrateSession').mockResolvedValue(context);
  vi.spyOn(store, 'verifyCsrf').mockReturnValue(true);
  const app = await buildApplication({
    environment: { ...testEnvironment, TENANT_ADMIN_ENABLED: true },
    readiness: new StubReadinessProbe(),
    adminStore: store,
    logger: false,
  });
  return { app, store, context };
}

function contextFixture(
  role: 'tenant_owner' | 'tenant_admin' | 'provider' | 'front_desk',
): VerifiedAdminContext {
  const now = new Date();
  const userId = new ObjectId();
  const tenantId = new ObjectId();
  const membershipId = new ObjectId();
  const tenant = {
    _id: tenantId,
    public_id: 'tenant-a',
    slug: 'tenant-a',
    display_name: 'Tenant A',
    legal_name: null,
    contact: { email_normalized: null, phone_e164: null, website_url: null },
    public_booking_enabled: false,
    appointment_email_settings: { enabled: false, sender_name: 'Tenant', reply_to_email: null },
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
    version: 1,
    updated_by: null,
    status: 'active' as const,
    created_at: now,
    updated_at: now,
  };
  const user = {
    _id: userId,
    public_id: 'user',
    email_normalized: 'owner@example.test',
    display_name: 'Owner',
    password_hash: 'hash',
    status: 'active' as const,
    created_at: now,
    updated_at: now,
  };
  const membership = {
    _id: membershipId,
    public_id: 'membership',
    tenant_id: tenantId,
    user_id: userId,
    role,
    status: 'active' as const,
    created_at: now,
    updated_at: now,
  };
  return {
    session: {
      _id: new ObjectId(),
      public_id: 'session',
      token_hash: 'hash',
      audience: 'admin',
      user_id: userId,
      selected_membership_id: membershipId,
      csrf_token_hash: 'csrf',
      created_at: now,
      rotated_at: now,
      last_seen_at: now,
      expires_at: new Date(now.getTime() + 60000),
      revoked_at: null,
      revocation_reason: null,
      created_request_id: 'request',
    },
    user,
    tenant,
    membership,
    memberships: [{ tenant, membership }],
  };
}

function serviceFixture(status: 'active' | 'inactive'): ServiceDocument {
  const now = new Date();
  const userId = new ObjectId();
  return {
    _id: new ObjectId(),
    public_id: 'service-a',
    tenant_id: new ObjectId(),
    internal_code: 'WAX',
    name: 'Wax',
    description: null,
    delivery_mode: 'provider_location',
    duration_minutes: 30,
    base_price_minor: 5500,
    booking_fee_minor: 125,
    slot_cadence_minutes: null,
    currency: 'USD',
    status,
    publicly_bookable: false,
    public_display_order: 0,
    public_booking_policy: { minimum_lead_minutes: null, maximum_advance_days: null },
    version: 2,
    created_by: userId,
    updated_by: userId,
    created_at: now,
    updated_at: now,
  };
}

function authHeaders() {
  return { cookie: '__Host-bnt_admin_session=token' };
}
function mutationHeaders() {
  return { ...authHeaders(), origin: testEnvironment.ADMIN_ORIGIN, 'x-csrf-token': 'csrf' };
}
function validService() {
  return {
    internal_code: 'WAX',
    name: 'Wax',
    delivery_mode: 'provider_location',
    duration_minutes: 30,
    base_price_minor: 5500,
    booking_fee_minor: 125,
  };
}

import { ObjectId } from 'mongodb';
import { describe, expect, it, vi } from 'vitest';

import { AdminStore, type ProviderDocument, type VerifiedAdminContext } from '../admin/store.js';
import { buildApplication } from '../app.js';
import { StubReadinessProbe, testEnvironment } from '../test-fixtures.js';

describe('provider directory routes', () => {
  it('publishes stable provider operations in nonproduction OpenAPI', async () => {
    const store = Object.create(AdminStore.prototype) as AdminStore;
    const app = await buildApplication({
      environment: { ...testEnvironment, TENANT_ADMIN_ENABLED: true, OPENAPI_ENABLED: true },
      readiness: new StubReadinessProbe(),
      adminStore: store,
      logger: false,
    });
    const response = await app.inject({ method: 'GET', url: '/documentation/openapi.json' });
    expect(response.statusCode).toBe(200);
    const paths = response.json().paths;
    expect(paths['/api/v1/admin/providers'].get.operationId).toBe('listProviders');
    expect(
      paths['/api/v1/admin/providers/{providerPublicId}/service-assignments'].post.operationId,
    ).toBe('createProviderServiceAssignment');
    expect(
      paths['/api/v1/admin/services/{servicePublicId}/provider-assignments'].get.operationId,
    ).toBe('listServiceProviderAssignments');
    await app.close();
  });
  it('uses only the verified selected tenant when listing providers', async () => {
    const { app, store, context } = await testApp('tenant_owner');
    const list = vi.spyOn(store, 'listProviders').mockResolvedValue([]);
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/providers?tenant_id=attacker',
      headers: { ...authHeaders(), 'x-tenant-id': 'attacker' },
    });
    expect(response.statusCode).toBe(200);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ tenantId: context.tenant!._id }));
    await app.close();
  });

  it('allows every fixed role to read but only managers to mutate', async () => {
    const { app, store } = await testApp('provider');
    vi.spyOn(store, 'listProviders').mockResolvedValue([]);
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/admin/providers', headers: authHeaders() }))
        .statusCode,
    ).toBe(200);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/providers',
      headers: mutationHeaders(),
      payload: { display_name: 'Lisa' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('insufficient_role');
    await app.close();
  });

  it('rejects linked_user_id rather than using it for authentication linkage', async () => {
    const { app } = await testApp('tenant_owner');
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/providers',
      headers: mutationHeaders(),
      payload: { display_name: 'Lisa', linked_user_id: 'user-a' },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('does not audit a repeated provider lifecycle transition', async () => {
    const { app, store } = await testApp('tenant_admin');
    const provider = providerFixture('active');
    vi.spyOn(store, 'transitionProvider').mockResolvedValue('unchanged');
    vi.spyOn(store, 'getProvider').mockResolvedValue(provider);
    const audit = vi.spyOn(store, 'audit').mockResolvedValue();
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/providers/${provider.public_id}/activate`,
      headers: mutationHeaders(),
      payload: { expected_version: provider.version },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.changed).toBe(false);
    expect(response.json().data.version).toBe(provider.version);
    expect(audit).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns the same safe 404 when a provider is outside the tenant', async () => {
    const { app, store } = await testApp('tenant_owner');
    vi.spyOn(store, 'getProvider').mockResolvedValue(null);
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/providers/tenant-b-provider',
      headers: authHeaders(),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('provider_not_found');
    await app.close();
  });

  it('rejects an invalid provider cursor without querying the store', async () => {
    const { app, store } = await testApp('front_desk');
    const list = vi.spyOn(store, 'listProviders').mockResolvedValue([]);
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/providers?cursor=invalid',
      headers: authHeaders(),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('invalid_cursor');
    expect(list).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns inactive assignment identity instead of creating a duplicate', async () => {
    const { app, store } = await testApp('tenant_owner');
    const provider = providerFixture('active');
    const service = serviceFixture('active');
    const assignment = assignmentFixture(provider._id, service._id, 'inactive');
    vi.spyOn(store, 'getProvider').mockResolvedValue(provider);
    vi.spyOn(store, 'getService').mockResolvedValue(service);
    vi.spyOn(store, 'createAssignment').mockResolvedValue({ result: 'inactive', assignment });
    const audit = vi.spyOn(store, 'audit').mockResolvedValue();
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/providers/${provider.public_id}/service-assignments`,
      headers: mutationHeaders(),
      payload: { service_public_id: service.public_id },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({
      code: 'assignment_inactive',
      assignment_public_id: assignment.public_id,
      version: assignment.version,
    });
    expect(audit).not.toHaveBeenCalled();
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
  const user = {
    _id: userId,
    public_id: 'user',
    email_normalized: 'owner@example.test',
    display_name: 'Owner',
    password_hash: 'hash',
    must_change_password: false,
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
function providerFixture(status: 'active' | 'inactive'): ProviderDocument {
  const now = new Date();
  const actor = new ObjectId();
  return {
    _id: new ObjectId(),
    public_id: 'provider-a',
    tenant_id: new ObjectId(),
    internal_code: 'LISA',
    display_name: 'Lisa',
    first_name: 'Lisa',
    last_name: null,
    email_normalized: null,
    phone_e164: null,
    photo_url: null,
    bio: null,
    status,
    customer_selectable: true,
    accepting_new_clients: true,
    display_order: 10,
    linked_user_id: null,
    version: 2,
    created_at: now,
    updated_at: now,
    created_by: actor,
    updated_by: actor,
  };
}
function serviceFixture(status: 'active' | 'inactive') {
  const now = new Date();
  const actor = new ObjectId();
  return {
    _id: new ObjectId(),
    public_id: 'service-a',
    tenant_id: new ObjectId(),
    internal_code: 'WAX',
    name: 'Wax',
    description: null,
    delivery_mode: 'provider_location' as const,
    duration_minutes: 30,
    base_price_minor: 5500,
    booking_fee_minor: 125,
    slot_cadence_minutes: null,
    currency: 'USD',
    status,
    publicly_bookable: false,
    public_display_order: 0,
    public_booking_policy: { minimum_lead_minutes: null, maximum_advance_days: null },
    public_self_service_policy: {
      cancellation_cutoff_minutes: null,
      reschedule_cutoff_minutes: null,
    },
    version: 1,
    created_by: actor,
    updated_by: actor,
    created_at: now,
    updated_at: now,
  };
}
function assignmentFixture(
  providerId: ObjectId,
  serviceId: ObjectId,
  status: 'active' | 'inactive',
) {
  const now = new Date();
  const actor = new ObjectId();
  return {
    _id: new ObjectId(),
    public_id: 'assignment-a',
    tenant_id: new ObjectId(),
    provider_id: providerId,
    service_id: serviceId,
    status,
    buffer_before_minutes: 0,
    buffer_after_minutes: 0,
    version: 2,
    created_at: now,
    updated_at: now,
    created_by: actor,
    updated_by: actor,
  };
}
function authHeaders() {
  return { cookie: '__Host-bnt_admin_session=token' };
}
function mutationHeaders() {
  return { ...authHeaders(), origin: testEnvironment.ADMIN_ORIGIN, 'x-csrf-token': 'csrf' };
}

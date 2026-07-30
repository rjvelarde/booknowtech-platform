import { ObjectId } from 'mongodb';
import { describe, expect, it, vi } from 'vitest';

import { AdminStore, type CustomerDocument, type VerifiedAdminContext } from '../admin/store.js';
import { buildApplication } from '../app.js';
import { StubReadinessProbe, testEnvironment } from '../test-fixtures.js';

describe('customer routes', () => {
  it('scopes directory reads to the verified tenant and ignores client tenant IDs', async () => {
    const { app, store, context } = await testApp('front_desk');
    const list = vi.spyOn(store, 'listCustomers').mockResolvedValue([]);
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/customers?tenant_id=attacker',
      headers: { ...authHeaders(), 'x-tenant-id': 'attacker' },
    });
    expect(response.statusCode).toBe(200);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ tenantId: context.tenant!._id }));
    await app.close();
  });

  it('denies providers access to customer records', async () => {
    const { app } = await testApp('provider');
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/customers',
      headers: authHeaders(),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('insufficient_role');
    await app.close();
  });

  it('warns about possible duplicates without creating or merging', async () => {
    const { app, store } = await testApp('tenant_owner');
    vi.spyOn(store, 'findPossibleCustomers').mockResolvedValue([customerFixture()]);
    const create = vi.spyOn(store, 'createCustomer');
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/customers',
      headers: mutationHeaders(),
      payload: validCustomer(),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('possible_duplicate');
    expect(response.json().error.candidates[0].reasons).toContain('email_exact');
    expect(create).not.toHaveBeenCalled();
    await app.close();
  });

  it('normalizes a friendly US phone and computes display_name without storing it', async () => {
    const { app, store, context } = await testApp('tenant_admin');
    vi.spyOn(store, 'findPossibleCustomers').mockResolvedValue([]);
    const create = vi.spyOn(store, 'createCustomer').mockResolvedValue({
      ...customerFixture(),
      tenant_id: context.tenant!._id,
      preferred_name: 'May',
      mobile_phone_e164: '+14045550101',
      mobile_phone_digits: '14045550101',
    });
    vi.spyOn(store, 'audit').mockResolvedValue();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/customers',
      headers: mutationHeaders(),
      payload: { ...validCustomer(), preferred_name: 'May', mobile_phone: '(404) 555-0101' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().data.display_name).toBe('May Johnson');
    expect(create.mock.calls[0]![0].customer.mobile_phone_e164).toBe('+14045550101');
    expect(create.mock.calls[0]![0].customer).not.toHaveProperty('display_name');
    await app.close();
  });

  it('returns safe 404 and makes repeated lifecycle transitions idempotent', async () => {
    const { app, store } = await testApp('front_desk');
    const getCustomer = vi.spyOn(store, 'getCustomer').mockResolvedValue(customerFixture());
    vi.spyOn(store, 'transitionCustomer').mockResolvedValue('unchanged');
    const audit = vi.spyOn(store, 'audit').mockResolvedValue();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/customers/customer-a/activate',
      headers: mutationHeaders(),
      payload: { expected_version: 1 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.changed).toBe(false);
    expect(audit).not.toHaveBeenCalled();
    getCustomer.mockResolvedValueOnce(null);
    const missing = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/customers/tenant-b-customer',
      headers: authHeaders(),
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('customer_not_found');
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
      expires_at: new Date(now.getTime() + 60_000),
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

function customerFixture(): CustomerDocument {
  const now = new Date();
  const userId = new ObjectId();
  return {
    _id: new ObjectId(),
    public_id: 'customer-a',
    tenant_id: new ObjectId(),
    first_name: 'Maya',
    last_name: 'Johnson',
    preferred_name: null,
    first_name_normalized: 'maya',
    last_name_normalized: 'johnson',
    full_name_normalized: 'maya johnson',
    email_normalized: 'maya@example.test',
    mobile_phone_e164: '+14045550101',
    mobile_phone_digits: '14045550101',
    addresses: [],
    communication_preferences: {
      preferred_channel: 'email',
      marketing_email: 'unknown',
      marketing_sms: 'unknown',
    },
    source: 'manual',
    external_references: [],
    status: 'active',
    deactivated_at: null,
    version: 1,
    created_at: now,
    updated_at: now,
    created_by: userId,
    updated_by: userId,
  };
}

function validCustomer() {
  return { first_name: 'Maya', last_name: 'Johnson', email: 'maya@example.test' };
}
function authHeaders() {
  return { cookie: '__Host-bnt_admin_session=token' };
}
function mutationHeaders() {
  return { ...authHeaders(), origin: testEnvironment.ADMIN_ORIGIN, 'x-csrf-token': 'csrf' };
}

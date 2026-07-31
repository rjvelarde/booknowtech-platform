import { ObjectId } from 'mongodb';
import { describe, expect, it, vi } from 'vitest';

import {
  AdminStore,
  type ProviderAvailabilityScheduleDocument,
  type ProviderDocument,
  type ProviderServiceAssignmentDocument,
  type ServiceDocument,
  type VerifiedAdminContext,
} from '../admin/store.js';
import { buildApplication } from '../app.js';
import { StubReadinessProbe, testEnvironment } from '../test-fixtures.js';

describe('internal scheduling slot routes', () => {
  it('uses verified tenant context and paginates deterministic starts', async () => {
    const { app, store, context } = await testApp();
    const provider = providerFixture(context.tenant!._id);
    const service = serviceFixture(context.tenant!._id);
    const assignment = assignmentFixture(context.tenant!._id, provider._id, service._id);
    const getProvider = vi.spyOn(store, 'getProvider').mockResolvedValue(provider);
    vi.spyOn(store, 'getService').mockResolvedValue(service);
    vi.spyOn(store, 'listAssignmentsForProvider').mockResolvedValue([assignment]);
    vi.spyOn(store, 'getAvailabilitySchedule').mockResolvedValue(
      scheduleFixture(context.tenant!._id, provider._id),
    );
    vi.spyOn(store, 'listAvailabilityExceptions').mockResolvedValue([]);
    vi.spyOn(store, 'listBlockingAppointments').mockResolvedValue([]);
    vi.spyOn(store, 'getScheduleLockRevisions').mockResolvedValue([]);

    const first = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/providers/lisa/scheduling-slots?service_public_id=wax&start_date=2027-01-11&end_date=2027-01-11&limit=2&tenant_id=attacker`,
      headers: authHeaders(),
    });
    expect(first.statusCode).toBe(200);
    expect(first.headers['cache-control']).toBe('private, no-store');
    expect(first.json().data.slots).toHaveLength(2);
    expect(first.json().data.slots[0]).toMatchObject({
      starts_at: '2027-01-11T09:15:00.000Z',
      blocked_starts_at: '2027-01-11T09:10:00.000Z',
      blocked_ends_at: '2027-01-11T09:55:00.000Z',
    });
    expect(getProvider).toHaveBeenCalledWith(context.tenant!._id, 'lisa');

    const firstBody: { meta: { next_cursor: string } } = first.json();
    const second = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/providers/lisa/scheduling-slots?service_public_id=wax&start_date=2027-01-11&end_date=2027-01-11&limit=2&cursor=${encodeURIComponent(firstBody.meta.next_cursor)}`,
      headers: authHeaders(),
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().data.slots[0].starts_at).toBe('2027-01-11T09:45:00.000Z');
    await app.close();
  });

  it('uses one safe 404 for an inaccessible provider or service', async () => {
    const { app, store } = await testApp();
    vi.spyOn(store, 'getProvider').mockResolvedValue(null);
    vi.spyOn(store, 'getService').mockResolvedValue(null);
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/providers/tenant-b-provider/scheduling-slots?service_public_id=tenant-b-service&start_date=2027-01-11&end_date=2027-01-11',
      headers: authHeaders(),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('scheduling_subject_not_found');
    await app.close();
  });
});

async function testApp() {
  const store = Object.create(AdminStore.prototype) as AdminStore;
  const context = contextFixture();
  vi.spyOn(store, 'hydrateSession').mockResolvedValue(context);
  const app = await buildApplication({
    environment: { ...testEnvironment, TENANT_ADMIN_ENABLED: true },
    readiness: new StubReadinessProbe(),
    adminStore: store,
    logger: false,
  });
  return { app, store, context };
}

function contextFixture(): VerifiedAdminContext {
  const now = new Date();
  const userId = new ObjectId(),
    tenantId = new ObjectId(),
    membershipId = new ObjectId();
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
    version: 3,
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
    role: 'tenant_owner' as const,
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
      expires_at: new Date(now.valueOf() + 60000),
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

function providerFixture(tenantId: ObjectId): ProviderDocument {
  const now = new Date(),
    actor = new ObjectId();
  return {
    _id: new ObjectId(),
    public_id: 'lisa',
    tenant_id: tenantId,
    internal_code: 'LISA',
    display_name: 'Lisa',
    first_name: 'Lisa',
    last_name: null,
    email_normalized: null,
    phone_e164: null,
    photo_url: null,
    bio: null,
    status: 'active',
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

function serviceFixture(tenantId: ObjectId): ServiceDocument {
  const now = new Date(),
    actor = new ObjectId();
  return {
    _id: new ObjectId(),
    public_id: 'wax',
    tenant_id: tenantId,
    internal_code: 'WAX',
    name: 'Brazilian Wax',
    description: null,
    delivery_mode: 'provider_location',
    duration_minutes: 30,
    base_price_minor: 5500,
    booking_fee_minor: 125,
    slot_cadence_minutes: null,
    currency: 'USD',
    status: 'active',
    publicly_bookable: false,
    public_display_order: 0,
    public_booking_policy: { minimum_lead_minutes: null, maximum_advance_days: null },
    version: 2,
    created_by: actor,
    updated_by: actor,
    created_at: now,
    updated_at: now,
  };
}

function assignmentFixture(
  tenantId: ObjectId,
  providerId: ObjectId,
  serviceId: ObjectId,
): ProviderServiceAssignmentDocument {
  const now = new Date(),
    actor = new ObjectId();
  return {
    _id: new ObjectId(),
    public_id: 'assignment',
    tenant_id: tenantId,
    provider_id: providerId,
    service_id: serviceId,
    status: 'active',
    buffer_before_minutes: 5,
    buffer_after_minutes: 10,
    version: 2,
    created_at: now,
    updated_at: now,
    created_by: actor,
    updated_by: actor,
  };
}

function scheduleFixture(
  tenantId: ObjectId,
  providerId: ObjectId,
): ProviderAvailabilityScheduleDocument {
  const now = new Date(),
    actor = new ObjectId();
  return {
    _id: new ObjectId(),
    public_id: 'schedule',
    tenant_id: tenantId,
    provider_id: providerId,
    timezone: 'UTC',
    weekly_hours: [{ day_of_week: 1, start_minute: 540, end_minute: 720 }],
    breaks: [],
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

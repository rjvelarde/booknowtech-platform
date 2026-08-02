import { ObjectId } from 'mongodb';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AdminStore,
  type ProviderDocument,
  type ProviderServiceAssignmentDocument,
  type ServiceDocument,
  type TenantDocument,
} from '../admin/store.js';
import { buildApplication } from '../app.js';
import { StubReadinessProbe, testEnvironment } from '../test-fixtures.js';
import { normalizePublicHostname, publicRequestFingerprint } from './routes.js';

describe('public booking discovery', () => {
  afterEach(() => vi.restoreAllMocks());

  it('normalizes only an exact supported tenant hostname', () => {
    expect(normalizePublicHostname('BRAZILIAN-WAX.booknowtech.com.')).toBe('brazilian-wax');
    expect(normalizePublicHostname('brazilian-wax.localhost:8080')).toBe('brazilian-wax');
    expect(normalizePublicHostname('admin.booknowtech.com')).toBeNull();
    expect(normalizePublicHostname('tenant.attacker.booknowtech.com')).toBeNull();
    expect(normalizePublicHostname('booknowtech.com.attacker.test')).toBeNull();
  });

  it('creates a deterministic validator-compatible public request fingerprint', () => {
    const request = {
      service_public_id: 'service-public',
      provider_public_id: 'provider-public',
      starts_at: '2027-02-02T15:00:00.000Z',
    };
    const fingerprint = publicRequestFingerprint(request);

    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(publicRequestFingerprint(request)).toBe(fingerprint);
    expect(
      publicRequestFingerprint({ ...request, starts_at: '2027-02-02T15:15:00.000Z' }),
    ).not.toBe(fingerprint);
  });

  it('returns only approved public fields and supports ETag revalidation', async () => {
    const { app, store, tenant } = await testApp();
    const getTenant = vi.spyOn(store, 'getPublicTenantBySlug').mockResolvedValue(tenant);

    const first = await app.inject({
      method: 'GET',
      url: '/api/v1/public/booking-context?tenant_id=attacker',
      headers: { host: 'brazilian-wax.booknowtech.com' },
    });

    expect(first.statusCode).toBe(200);
    expect(getTenant).toHaveBeenCalledWith('brazilian-wax');
    expect(first.headers['cache-control']).toBe('public, max-age=60, stale-while-revalidate=60');
    expect(first.headers.etag).toBeTruthy();
    expect(first.json().data).toEqual({
      business: {
        public_id: tenant.public_id,
        name: 'Brazilian Wax Demo',
        description: 'Appointment-based waxing services.',
        tagline: null,
        logo_url: null,
        primary_color: '#176CAB',
        website_url: null,
        phone: null,
        email: null,
      },
      timezone: 'America/New_York',
      locale: 'en-US',
      currency: 'USD',
      booking_terms: tenant.public_booking_terms,
    });
    expect(first.body).not.toContain('legal_name');
    expect(first.body).not.toContain('tenant_id');

    const second = await app.inject({
      method: 'GET',
      url: '/api/v1/public/booking-context',
      headers: {
        host: 'brazilian-wax.booknowtech.com',
        'if-none-match': first.headers.etag!,
      },
    });
    expect(second.statusCode).toBe(304);
    await app.close();
  });

  it('uses safe indistinguishable errors for unpublished businesses and private resources', async () => {
    const { app, store, tenant } = await testApp();
    vi.spyOn(store, 'getPublicTenantBySlug')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(tenant);
    vi.spyOn(store, 'getService').mockResolvedValue(null);

    const missingBusiness = await app.inject({
      method: 'GET',
      url: '/api/v1/public/booking-context',
      headers: { host: 'unknown.booknowtech.com' },
    });
    expect(missingBusiness.statusCode).toBe(404);
    expect(missingBusiness.json().error.code).toBe('public_business_not_found');
    expect(missingBusiness.headers['cache-control']).toBe('no-store');

    const privateService = await app.inject({
      method: 'GET',
      url: '/api/v1/public/services/private/providers',
      headers: { host: 'brazilian-wax.booknowtech.com' },
    });
    expect(privateService.statusCode).toBe(404);
    expect(privateService.json().error.code).toBe('public_resource_not_found');
    await app.close();
  });

  it('lists only the provider projection returned by tenant-scoped eligibility lookup', async () => {
    const { app, store, tenant } = await testApp();
    const service = serviceFixture(tenant._id);
    const provider = providerFixture(tenant._id);
    const assignment = assignmentFixture(tenant._id, provider._id, service._id);
    vi.spyOn(store, 'getPublicTenantBySlug').mockResolvedValue(tenant);
    vi.spyOn(store, 'getService').mockResolvedValue(service);
    const eligible = vi
      .spyOn(store, 'listPublicProvidersForService')
      .mockResolvedValue([{ provider, assignment }]);

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/public/services/${service.public_id}/providers`,
      headers: { host: 'brazilian-wax.booknowtech.com' },
    });
    expect(response.statusCode).toBe(200);
    expect(eligible).toHaveBeenCalledWith(tenant._id, service._id);
    expect(response.json().data.items).toEqual([
      { public_id: 'lisa', display_name: 'Lisa', bio: null, photo_url: null },
    ]);
    expect(response.body).not.toContain('email_normalized');
    expect(response.body).not.toContain('linked_user_id');
    await app.close();
  });

  it('rejects invalid public writes safely and applies the stricter submission limit', async () => {
    const { app, store, tenant } = await testApp();
    vi.spyOn(store, 'getPublicTenantBySlug').mockResolvedValue(tenant);
    const body = {
      service_public_id: '5c71e00f-5761-49f4-a17a-7b66cc55cdac',
      provider_public_id: 'b32a897d-cf3d-465b-92bb-54dc5152d14f',
      starts_at: '2027-02-02T15:00:00.000Z',
      customer: {
        first_name: 'Taylor',
        last_name: 'Guest',
        email: 'taylor@example.test',
        mobile_phone: '(843) 555-0104',
        preferred_contact_channel: 'email',
        customer_location_address: null,
        appointment_note: null,
      },
      consent: { booking_terms_version: 'test-v1', booking_terms_accepted: true },
      website: 'bot-value',
    };

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/public/appointments',
        headers: {
          host: 'brazilian-wax.booknowtech.com',
          'idempotency-key': `550e8400-e29b-41d4-a716-44665544000${attempt}`,
        },
        payload: body,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('invalid_public_booking_request');
      expect(response.body).not.toContain('taylor@example.test');
    }
    const limited = await app.inject({
      method: 'POST',
      url: '/api/v1/public/appointments',
      headers: {
        host: 'brazilian-wax.booknowtech.com',
        'idempotency-key': '550e8400-e29b-41d4-a716-446655440009',
      },
      payload: body,
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('public_rate_limit_exceeded');
    expect(limited.headers['retry-after']).toBe('600');
    await app.close();
  });

  it('rejects cross-origin public appointment submissions without exposing tenant data', async () => {
    const { app } = await testApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/public/appointments',
      headers: {
        host: 'brazilian-wax.booknowtech.com',
        origin: 'https://attacker.example',
        'idempotency-key': '550e8400-e29b-41d4-a716-446655440020',
      },
      payload: {
        service_public_id: 'service-public',
        provider_public_id: 'provider-public',
        starts_at: '2027-02-02T15:00:00.000Z',
        customer: {
          first_name: 'Taylor',
          last_name: 'Guest',
          email: 'taylor@example.test',
          mobile_phone: '(843) 555-0104',
          preferred_contact_channel: 'email',
          customer_location_address: null,
          appointment_note: null,
        },
        consent: { booking_terms_version: 'test-v1', booking_terms_accepted: true },
        website: '',
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('invalid_public_booking_request');
    expect(response.body).not.toContain('taylor@example.test');
    await app.close();
  });
});

async function testApp() {
  const store = Object.create(AdminStore.prototype) as AdminStore;
  const tenant = tenantFixture();
  const app = await buildApplication({
    environment: { ...testEnvironment, TENANT_ADMIN_ENABLED: true },
    readiness: new StubReadinessProbe(),
    adminStore: store,
    logger: false,
  });
  return { app, store, tenant };
}

function tenantFixture(): TenantDocument {
  const now = new Date();
  return {
    _id: new ObjectId(),
    public_id: 'tenant-public',
    slug: 'brazilian-wax',
    display_name: 'Administrative name',
    legal_name: 'Private LLC',
    contact: {
      email_normalized: 'private@example.test',
      phone_e164: '+18435550100',
      website_url: 'https://private.example.test',
    },
    public_booking_enabled: true,
    appointment_email_settings: { enabled: false, sender_name: 'Tenant', reply_to_email: null },
    public_profile: {
      business_name: 'Brazilian Wax Demo',
      description: 'Appointment-based waxing services.',
      tagline: null,
      logo_url: null,
      primary_color: '#176CAB',
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
    default_timezone: 'America/New_York',
    default_slot_cadence_minutes: 15,
    locale: 'en-US',
    currency: 'USD',
    version: 2,
    updated_by: null,
    status: 'active',
    created_at: now,
    updated_at: now,
  };
}

function serviceFixture(tenantId: ObjectId): ServiceDocument {
  const now = new Date(),
    actor = new ObjectId();
  return {
    _id: new ObjectId(),
    public_id: 'wax',
    tenant_id: tenantId,
    internal_code: 'PRIVATE-CODE',
    name: 'Brazilian Wax',
    description: null,
    delivery_mode: 'provider_location',
    duration_minutes: 30,
    base_price_minor: 5500,
    booking_fee_minor: 125,
    slot_cadence_minutes: 15,
    currency: 'USD',
    status: 'active',
    publicly_bookable: true,
    public_display_order: 10,
    public_booking_policy: { minimum_lead_minutes: null, maximum_advance_days: null },
    version: 2,
    created_by: actor,
    updated_by: actor,
    created_at: now,
    updated_at: now,
  };
}

function providerFixture(tenantId: ObjectId): ProviderDocument {
  const now = new Date(),
    actor = new ObjectId();
  return {
    _id: new ObjectId(),
    public_id: 'lisa',
    tenant_id: tenantId,
    internal_code: 'PRIVATE-LISA',
    display_name: 'Lisa',
    first_name: 'Lisa',
    last_name: null,
    email_normalized: 'private@example.test',
    phone_e164: '+18435550101',
    photo_url: null,
    bio: null,
    status: 'active',
    customer_selectable: true,
    accepting_new_clients: true,
    display_order: 10,
    linked_user_id: new ObjectId(),
    version: 1,
    created_at: now,
    updated_at: now,
    created_by: actor,
    updated_by: actor,
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
    version: 1,
    created_at: now,
    updated_at: now,
    created_by: actor,
    updated_by: actor,
  };
}

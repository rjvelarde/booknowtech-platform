import { ObjectId } from 'mongodb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fallbackTenantSlug } from '@booknowtech/shared';

import {
  AdminStore,
  type ProviderDocument,
  type ProviderServiceAssignmentDocument,
  type ServiceDocument,
  type TenantDocument,
} from '../admin/store.js';
import { buildApplication } from '../app.js';
import type { PublicPaidBookingOrchestrator } from '../payment/public-orchestrator.js';
import { StubReadinessProbe, testEnvironment } from '../test-fixtures.js';
import { publicRequestFingerprint, publicSettingsValidationField } from './routes.js';

describe('public booking discovery', () => {
  afterEach(() => vi.restoreAllMocks());

  it('normalizes only an exact supported tenant hostname', () => {
    expect(fallbackTenantSlug('BRAZILIAN-WAX.booknowtech.com.')).toBe('brazilian-wax');
    expect(fallbackTenantSlug('brazilian-wax.localhost:8080')).toBe('brazilian-wax');
    expect(fallbackTenantSlug('admin.booknowtech.com')).toBeNull();
    expect(fallbackTenantSlug('tenant.attacker.booknowtech.com')).toBeNull();
    expect(fallbackTenantSlug('booknowtech.com.attacker.test')).toBeNull();
  });

  it.each([
    'admin.booknowtech.com',
    'booknowtech.com',
    'tenant.attacker.booknowtech.com',
    'tenant_booknowtech.com',
  ])('returns the same safe 404 for unsupported public host %s', async (host) => {
    const { app, store } = await testApp();
    const lookup = vi.spyOn(store, 'getPublicTenantBySlug');

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/public/booking-context',
      headers: { host },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('public_business_not_found');
    expect(lookup).not.toHaveBeenCalled();
    await app.close();
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

  it('accepts blank optional public-booking fields and identifies an invalid field safely', () => {
    const tenant = tenantFixture();
    const input = {
      expected_version: tenant.version,
      public_booking_enabled: false,
      public_profile: {
        business_name: 'Maritime Software Tech',
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
        version: '1',
        acknowledgment_label: 'I agree to the booking and cancellation terms.',
        terms_url: null,
      },
      appointment_self_service: {
        enabled: false,
        cancellation_cutoff_minutes: 1440,
        reschedule_cutoff_minutes: 1440,
      },
    };

    expect(publicSettingsValidationField(input, tenant, 'booknowtech.com')).toBeNull();
    expect(
      publicSettingsValidationField(
        {
          ...input,
          public_profile: { ...input.public_profile, website_url: 'http://example.com' },
        },
        tenant,
        'booknowtech.com',
      ),
    ).toBe('public_profile.website_url');
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
      payment_checkout: null,
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

  it('keeps custom-host public routes behind TenantHostResolver', async () => {
    const { app, store, tenant } = await testApp();
    const customLookup = vi
      .spyOn(store, 'getPublicTenantByCustomHostname')
      .mockResolvedValue(tenant);
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/public/booking-context',
      headers: { host: 'book.customer-domain.com' },
    });
    expect(response.statusCode).toBe(200);
    expect(customLookup).toHaveBeenCalledWith('book.customer-domain.com', 'production');
    expect(response.json().data.business.name).toBe('Brazilian Wax Demo');
    await app.close();
  });

  it('publishes the immutable payments-v2 artifact URL with its configured acceptance evidence', async () => {
    const { app, store, tenant } = await testApp(
      {
        ...testEnvironment,
        STRIPE_PAYMENT_EXECUTION_ENABLED: true,
        STRIPE_PUBLISHABLE_KEY: 'pk_test_synthetic',
        BOOKNOWTECH_PAYMENT_TERMS_VERSION: 'payments-v2',
        BOOKNOWTECH_PAYMENT_TERMS_TEXT_SHA256:
          '6f8ce120b1ee45828913d23c7553bf80bb9ef19ad56ce68dc7590a081b6b906b',
      },
      {} as PublicPaidBookingOrchestrator,
    );
    vi.spyOn(store, 'getPublicTenantBySlug').mockResolvedValue(tenant);
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/public/booking-context',
      headers: { host: 'brazilian-wax.booknowtech.com' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.payment_checkout).toMatchObject({
      terms_version: 'payments-v2',
      terms_document_sha256: '6f8ce120b1ee45828913d23c7553bf80bb9ef19ad56ce68dc7590a081b6b906b',
      terms_url: '/legal/BOOKNOWTECH_PAYMENT_TERMS_paymentsv2.md',
    });
    await app.close();
  });

  it('serves the configured staging suffix and rejects the production suffix', async () => {
    const { app, store, tenant } = await testApp({
      ...testEnvironment,
      BOOKING_ROOT_DOMAIN: 'staging.booknowtech.com',
    });
    vi.spyOn(store, 'getPublicTenantBySlug').mockResolvedValue(tenant);
    const staging = await app.inject({
      method: 'GET',
      url: '/api/v1/public/booking-context',
      headers: { host: 'brazilian-wax.staging.booknowtech.com' },
    });
    const production = await app.inject({
      method: 'GET',
      url: '/api/v1/public/booking-context',
      headers: { host: 'brazilian-wax.booknowtech.com' },
    });
    expect(staging.statusCode).toBe(200);
    expect(production.statusCode).toBe(404);
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

  it('rejects invalid public writes safely without exposing submitted contact data', async () => {
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

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/public/appointments',
      headers: {
        host: 'brazilian-wax.booknowtech.com',
        'idempotency-key': '550e8400-e29b-41d4-a716-446655440009',
      },
      payload: body,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('invalid_public_booking_request');
    expect(response.body).not.toContain('taylor@example.test');
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

  it('recovers only with the host-scoped HttpOnly credential and reveals no state otherwise', async () => {
    const recover = vi.fn();
    const paidBooking = { recover } as unknown as PublicPaidBookingOrchestrator;
    const { app, store, tenant } = await testApp(testEnvironment, paidBooking);
    vi.spyOn(store, 'getPublicTenantBySlug').mockResolvedValue(tenant);

    const missing = await app.inject({
      method: 'GET',
      url: '/api/v1/public/payment-attempts/11111111-1111-4111-8111-111111111111',
      headers: { host: 'brazilian-wax.booknowtech.com' },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('payment_attempt_not_found');
    expect(recover).not.toHaveBeenCalled();

    recover.mockRejectedValueOnce({ status: 404, code: 'payment_attempt_not_found' });
    const invalid = await app.inject({
      method: 'GET',
      url: '/api/v1/public/payment-attempts/11111111-1111-4111-8111-111111111111',
      headers: {
        host: 'brazilian-wax.booknowtech.com',
        cookie: '__Secure-bnt_checkout_recovery=invalid_recovery_value',
      },
    });
    expect(invalid.statusCode).toBe(404);
    expect(invalid.json().error.code).toBe('payment_attempt_not_found');

    recover.mockResolvedValueOnce(paymentAttemptView());

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/public/payment-attempts/11111111-1111-4111-8111-111111111111',
      headers: {
        host: 'brazilian-wax.booknowtech.com',
        cookie: '__Secure-bnt_checkout_recovery=opaque_recovery_value',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(recover).toHaveBeenLastCalledWith({
      tenant,
      attemptPublicId: '11111111-1111-4111-8111-111111111111',
      hostname: 'brazilian-wax.booknowtech.com',
      token: 'opaque_recovery_value',
    });
    await app.close();
  });
});

async function testApp(
  environment = testEnvironment,
  paidBookingOrchestrator?: PublicPaidBookingOrchestrator,
) {
  const store = Object.create(AdminStore.prototype) as AdminStore;
  vi.spyOn(store, 'getPublicTenantByCustomHostname').mockResolvedValue(null);
  vi.spyOn(store, 'getSelfServiceTenantByCustomHostname').mockResolvedValue(null);
  vi.spyOn(store, 'getActiveCustomHostnameForTenant').mockResolvedValue(null);
  const tenant = tenantFixture();
  const app = await buildApplication({
    environment: { ...environment, TENANT_ADMIN_ENABLED: true },
    readiness: new StubReadinessProbe(),
    adminStore: store,
    ...(paidBookingOrchestrator ? { paidBookingOrchestrator } : {}),
    logger: false,
  });
  return { app, store, tenant };
}

function paymentAttemptView() {
  return {
    appointment_reference: 'BNT-RECOVER',
    appointment_status: 'payment_pending' as const,
    payment_attempt_public_id: '11111111-1111-4111-8111-111111111111',
    payment_status: 'payment_method_required' as const,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    client_secret: 'pi_test_secret_transient',
    stripe_account: 'acct_test',
    continuation_allowed: true,
    amounts: {
      service_price_minor: 10_000,
      provider_amount_due_now_minor: 2_500,
      booknowtech_fee_minor: 125,
      customer_total_due_now_minor: 2_625,
      application_fee_amount_minor: 125,
      remaining_service_balance_minor: 7_500,
      currency: 'USD' as const,
    },
  };
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
    appointment_self_service: {
      enabled: false,
      cancellation_cutoff_minutes: 1440,
      reschedule_cutoff_minutes: 1440,
    },
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
    designation: 'customer',
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
    public_self_service_policy: {
      cancellation_cutoff_minutes: null,
      reschedule_cutoff_minutes: null,
    },
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

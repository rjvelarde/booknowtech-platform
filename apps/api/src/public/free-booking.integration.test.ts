import { randomUUID } from 'node:crypto';
import { MongoClient, ObjectId } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AdminStore,
  type ProviderDocument,
  type ProviderServiceAssignmentDocument,
  type ServiceDocument,
  type TenantDocument,
} from '../admin/store.js';
import { buildApplication } from '../app.js';
import { migrateDatabase } from '../database/migrate.js';
import { StubReadinessProbe, testEnvironment } from '../test-fixtures.js';
import { PaymentFoundationStore } from '../payment/store.js';
import { PublicPaidBookingOrchestrator } from '../payment/public-orchestrator.js';
import type { StripeAccountReadinessService } from '../payment/readiness-service.js';
import type { PaymentExecutionService } from '../payment/execution-service.js';

const uri = process.env.MONGODB_TEST_URI;
(uri ? describe : describe.skip)('free public booking transaction', () => {
  const client = new MongoClient(uri ?? 'mongodb://127.0.0.1:27017');
  const db = client.db(`free_booking_${randomUUID().replaceAll('-', '')}`);
  const store = new AdminStore(db);
  const payments = new PaymentFoundationStore(db);
  const tenant = tenantFixture();
  tenant.default_timezone = 'UTC';
  tenant.appointment_email_settings.enabled = true;
  const service = serviceFixture(tenant._id);
  service.base_price_minor = 0;
  service.booking_fee_minor = 0;
  const provider = providerFixture(tenant._id);
  const assignment = assignmentFixture(tenant._id, provider._id, service._id);
  const ensureFresh = vi.fn().mockRejectedValue(new Error('Stripe unavailable'));
  const ensurePaymentIntent = vi.fn().mockRejectedValue(new Error('must not create'));
  const orchestrator = new PublicPaidBookingOrchestrator(
    testEnvironment,
    store,
    payments,
    { ensurePaymentIntent } as unknown as PaymentExecutionService,
    { ensureFresh } as unknown as StripeAccountReadinessService,
  );
  let app: Awaited<ReturnType<typeof buildApplication>>;
  const startsAt = new Date();
  startsAt.setUTCDate(startsAt.getUTCDate() + 7);
  startsAt.setUTCHours(9, 15, 0, 0);
  const headers = {
    host: 'brazilian-wax.booknowtech.com',
    origin: 'https://brazilian-wax.booknowtech.com',
    'content-type': 'application/json',
  };
  const payload = {
    service_public_id: service.public_id,
    provider_public_id: provider.public_id,
    starts_at: startsAt.toISOString(),
    website: '',
    customer: {
      first_name: 'Tour',
      last_name: 'Guest',
      email: 'tour@example.test',
      mobile_phone: '(843) 555-0104',
      preferred_contact_channel: 'email',
      customer_location_address: null,
    },
    consent: { booking_terms_version: 'test-v1', booking_terms_accepted: true },
  };
  const book = (key = randomUUID()) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/public/appointments',
      headers: { ...headers, 'idempotency-key': key },
      payload,
    });
  async function noFinancialArtifacts() {
    for (const name of ['payment_attempts', 'payment_ledger_entries'])
      expect(await db.collection(name).countDocuments()).toBe(0);
    expect(ensurePaymentIntent).not.toHaveBeenCalled();
  }
  beforeAll(async () => {
    await client.connect();
    await migrateDatabase(db);
    vi.spyOn(store, 'getPublicTenantByCustomHostname').mockResolvedValue(null);
    vi.spyOn(store, 'getActiveCustomHostnameForTenant').mockResolvedValue(null);
    vi.spyOn(store, 'getPublicTenantBySlug').mockResolvedValue(tenant);
    vi.spyOn(store, 'getService').mockResolvedValue(service);
    vi.spyOn(store, 'getProvider').mockResolvedValue(provider);
    vi.spyOn(store, 'getProviderById').mockResolvedValue(provider);
    vi.spyOn(store, 'listPublicServices').mockResolvedValue([service]);
    vi.spyOn(store, 'listPublicProvidersForService').mockResolvedValue([{ provider, assignment }]);
    vi.spyOn(store, 'findAppointmentAssignment').mockResolvedValue(assignment);
    vi.spyOn(store, 'getAvailabilitySchedule').mockResolvedValue({
      timezone: 'UTC',
      weekly_hours: Array.from({ length: 7 }, (_, i) => ({
        day_of_week: i + 1,
        start_minute: 480,
        end_minute: 1080,
      })),
      breaks: [],
    } as never);
    vi.spyOn(store, 'listAvailabilityExceptions').mockResolvedValue([]);
    app = await buildApplication({
      environment: { ...testEnvironment, TENANT_ADMIN_ENABLED: true },
      readiness: new StubReadinessProbe(),
      adminStore: store,
      paidBookingOrchestrator: orchestrator,
      logger: false,
    });
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    for (const name of ['appointments', 'customers', 'notification_outbox', 'audit_logs'])
      await db.collection(name).deleteMany({});
    service.base_price_minor = 0;
    ensureFresh.mockClear();
    ensurePaymentIntent.mockClear();
    vi.spyOn(store, 'getService').mockResolvedValue(service);
    // Any accidentally reached Stripe/fee snapshot is a hard failure for the zero path.
    vi.spyOn(payments, 'executionSnapshot').mockRejectedValue(
      new Error('no payment snapshot for zero'),
    );
  });
  afterAll(async () => {
    await app?.close();
    vi.restoreAllMocks();
    await db.dropDatabase();
    await client.close();
  });

  it('books a free-only tenant without account, flags, terms, fee, or financial records', async () => {
    const key = randomUUID();
    const result = await book(key);
    expect(result.statusCode, result.body).toBe(201);
    expect(result.json().data).toMatchObject({
      status: 'scheduled',
      confirmation_email_queued: true,
    });
    const replay = await book(key);
    expect(replay.statusCode).toBe(200);
    expect(await db.collection('appointments').countDocuments()).toBe(1);
    expect(await db.collection('notification_outbox').countDocuments()).toBe(1);
    const outbox = await db.collection('notification_outbox').findOne({});
    expect(outbox?.template_data).not.toHaveProperty('service_price_minor');
    expect(ensureFresh).not.toHaveBeenCalled();
    await noFinancialArtifacts();
  });

  it('keeps free booking available in a mixed catalog when Stripe is unavailable', async () => {
    const paid = { ...service, _id: new ObjectId(), public_id: 'paid', base_price_minor: 10000 };
    vi.spyOn(store, 'listPublicServices').mockResolvedValueOnce([service, paid]);
    vi.spyOn(payments, 'servicePaymentConfiguration').mockResolvedValue({
      payment_mode: 'full',
      fixed_deposit_minor: null,
    } as never);
    const listing = await app.inject({ method: 'GET', url: '/api/v1/public/services', headers });
    expect(
      listing.json().data.items.map((item: { payment_mode: string }) => item.payment_mode),
    ).toEqual(['none', 'full']);
    expect((await book()).statusCode).toBe(201);
    expect(ensureFresh).not.toHaveBeenCalled();
    service.base_price_minor = 10000;
    const rejected = await book();
    expect(rejected.statusCode).toBe(503);
    expect(rejected.json().error.code).toBe('payment_account_not_ready');
    await noFinancialArtifacts();
  });

  it('bypasses stale paid configuration and unavailable Stripe for a zero total', async () => {
    const config = vi
      .spyOn(payments, 'servicePaymentConfiguration')
      .mockRejectedValue(new Error('must not look up config'));
    expect((await book()).statusCode).toBe(201);
    expect(config).not.toHaveBeenCalled();
    expect(ensureFresh).not.toHaveBeenCalled();
    await noFinancialArtifacts();
  });

  it('rejects a concurrent change to positive online collection before inserting an appointment', async () => {
    vi.spyOn(store, 'getService')
      .mockResolvedValueOnce({ ...service })
      .mockResolvedValue({ ...service, base_price_minor: 10000 });
    vi.spyOn(payments, 'servicePaymentConfiguration').mockResolvedValue({
      payment_mode: 'full',
      fixed_deposit_minor: null,
    } as never);
    const result = await book();
    expect(result.statusCode).toBe(409);
    expect(result.json().error.code).toBe('payment_configuration_changed');
    expect(await db.collection('appointments').countDocuments()).toBe(0);
    expect(await db.collection('notification_outbox').countDocuments()).toBe(0);
    await noFinancialArtifacts();
  });

  it('enforces capacity under concurrent submissions and refuses later overlap', async () => {
    const results = await Promise.all([book(), book()]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect((await book()).statusCode).toBe(409);
    expect(await db.collection('appointments').countDocuments()).toBe(1);
    expect(await db.collection('notification_outbox').countDocuments()).toBe(1);
    await noFinancialArtifacts();
  });

  it('converges concurrent retries on one appointment and one notification', async () => {
    const key = randomUUID();
    const results = await Promise.all([book(key), book(key)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 201]);
    expect(await db.collection('appointments').countDocuments()).toBe(1);
    expect(await db.collection('notification_outbox').countDocuments()).toBe(1);
    await noFinancialArtifacts();
  });

  it('never returns a prior provisional payment hold as an unpaid confirmation', async () => {
    const key = randomUUID();
    expect((await book(key)).statusCode).toBe(201);
    await db.collection('appointments').updateOne({}, { $set: { status: 'payment_pending' } });
    const result = await book(key);
    expect(result.statusCode).toBe(409);
    expect(result.json().error.code).toBe('payment_attempt_stale');
    expect((await db.collection('appointments').findOne({}))?.status).toBe('payment_pending');
    expect(await db.collection('notification_outbox').countDocuments()).toBe(1);
    await noFinancialArtifacts();
  });

  it('refuses an out-of-schedule zero-total booking', async () => {
    const invalid = {
      ...payload,
      starts_at: new Date(new Date(startsAt).setUTCHours(23)).toISOString(),
    };
    const result = await app.inject({
      method: 'POST',
      url: '/api/v1/public/appointments',
      headers: { ...headers, 'idempotency-key': randomUUID() },
      payload: invalid,
    });
    expect(result.statusCode).toBe(409);
    expect(await db.collection('appointments').countDocuments()).toBe(0);
    await noFinancialArtifacts();
  });
});

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

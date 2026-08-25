import { randomUUID } from 'node:crypto';

import { MongoClient, ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AdminStore } from '../admin/store.js';
import type { Environment } from '../config.js';
import { migrateDatabase } from '../database/migrate.js';
import { testEnvironment } from '../test-fixtures.js';
import { PaymentExecutionService } from './execution-service.js';
import { PublicPaidBookingOrchestrator } from './public-orchestrator.js';
import { PaymentFoundationStore } from './store.js';

const uri = process.env.MONGODB_TEST_URI;
const suite = uri ? describe : describe.skip;

suite('PR 14B.2 paid public-booking transaction', () => {
  const client = new MongoClient(uri ?? 'mongodb://127.0.0.1:27017');
  const db = client.db(`booknowtech_paid_orchestration_${randomUUID().replaceAll('-', '')}`);
  const admin = new AdminStore(db);
  const payments = new PaymentFoundationStore(db);
  const now = new Date();
  const tenantId = new ObjectId();
  const serviceId = new ObjectId();
  const providerId = new ObjectId();
  const assignmentId = new ObjectId();
  const assignmentPublicId = randomUUID();
  const actorId = new ObjectId();
  const tenantPublicId = randomUUID();
  const servicePublicId = randomUUID();
  const providerPublicId = randomUUID();
  const associationPublicId = randomUUID();
  const startsAt = nextMondayAtNineFifteen();
  const tenant = {
    _id: tenantId,
    public_id: tenantPublicId,
    slug: 'paid-tenant',
    currency: 'USD',
    default_timezone: 'UTC',
    default_slot_cadence_minutes: 15,
    booking_policy: { minimum_lead_minutes: 120, maximum_advance_days: 90 },
    public_booking_terms: { version: 'booking-v1' },
    public_profile: { business_name: 'Paid Tenant' },
  } as never;
  const serviceRecord = {
    _id: serviceId,
    tenant_id: tenantId,
    public_id: servicePublicId,
    status: 'active',
    publicly_bookable: true,
    name: 'Service',
    duration_minutes: 30,
    base_price_minor: 10_000,
    booking_fee_minor: 999,
    slot_cadence_minutes: 15,
    currency: 'USD',
    delivery_mode: 'provider_location',
    public_booking_policy: { minimum_lead_minutes: null, maximum_advance_days: null },
  };
  const service = serviceRecord as never;
  const provider = {
    _id: providerId,
    tenant_id: tenantId,
    public_id: providerPublicId,
    status: 'active',
    customer_selectable: true,
    accepting_new_clients: true,
    display_name: 'Provider',
  } as never;
  const assignment = {
    _id: assignmentId,
    public_id: assignmentPublicId,
    tenant_id: tenantId,
    provider_id: providerId,
    service_id: serviceId,
    status: 'active',
    buffer_before_minutes: 0,
    buffer_after_minutes: 0,
  } as never;
  const stripe = {
    createDirectChargePaymentIntent: vi.fn().mockImplementation((input) => ({
      id: `pi_${input.metadata.paymentAttemptPublicId.replaceAll('-', '')}`,
      status: 'requires_payment_method',
      clientSecret: 'pi_client_secret_return_only',
      amount: 2_625,
      applicationFeeAmount: 125,
      currency: 'usd',
    })),
    retrievePaymentIntent: vi.fn().mockImplementation((input) => ({
      id: input.paymentIntentId,
      status: 'requires_payment_method',
      clientSecret: 'pi_client_secret_return_only',
      amount: 2_625,
      applicationFeeAmount: 125,
      currency: 'usd',
    })),
    cancelPaymentIntent: vi.fn(),
  };
  const environment = {
    ...testEnvironment,
    STRIPE_PAYMENTS_FOUNDATION_ENABLED: true,
    STRIPE_PAYMENT_EXECUTION_ENABLED: true,
    STRIPE_ACCOUNT_READINESS_MAX_AGE_SECONDS: 900,
    BOOKNOWTECH_PAYMENT_TERMS_VERSION: 'payments-v1',
    BOOKNOWTECH_PAYMENT_TERMS_TEXT_SHA256: 'b'.repeat(64),
    PAYMENT_IP_HASH_SECRET: 'payment-ip-hash-secret-distinct-value',
  } as Environment;

  beforeAll(async () => {
    await client.connect();
    await migrateDatabase(db);
    vi.spyOn(admin, 'getPublicTenantBySlug').mockResolvedValue(tenant);
    vi.spyOn(admin, 'getService').mockResolvedValue(service);
    vi.spyOn(admin, 'getProvider').mockResolvedValue(provider);
    vi.spyOn(admin, 'findAppointmentAssignment').mockResolvedValue(assignment);
    vi.spyOn(admin, 'getAvailabilitySchedule').mockResolvedValue({
      timezone: 'UTC',
      weekly_hours: [{ day_of_week: 1, start_minute: 540, end_minute: 720 }],
      breaks: [],
    } as never);
    vi.spyOn(admin, 'listAvailabilityExceptions').mockResolvedValue([]);
    vi.spyOn(admin, 'listBlockingAppointments').mockResolvedValue([]);
    await payments.activateTenantBookingFee({
      tenantId,
      amountMinor: 125,
      operatorId: 'operator-test',
      reason: 'Approved test booking fee',
      requestId: randomUUID(),
      idempotencyKeyHash: 'a'.repeat(64),
      requestFingerprint: 'c'.repeat(64),
    });
    await payments.activateServicePaymentConfiguration({
      tenantId,
      serviceId,
      servicePublicId,
      servicePriceMinor: 10_000,
      paymentMode: 'fixed_deposit',
      fixedDepositMinor: 2_500,
      requestId: randomUUID(),
      idempotencyKeyHash: 'd'.repeat(64),
      requestFingerprint: 'e'.repeat(64),
      userId: actorId,
      membershipId: new ObjectId(),
    });
    await db.collection('tenant_payment_execution_settings').insertOne({
      _id: new ObjectId(),
      tenant_id: tenantId,
      enabled: true,
      currency: 'USD',
      approved_by_operator_id: 'operator-test',
      approval_request_id: randomUUID(),
      updated_at: now,
    });
    await db.collection('tenant_stripe_accounts').insertOne({
      public_id: associationPublicId,
      tenant_id: tenantId,
      stripe_account_id: 'acct_serveronly',
      account_type: 'express',
      country: 'US',
      default_currency: 'USD',
      status: 'payments_enabled',
      active: true,
      details_submitted: true,
      charges_enabled: true,
      payouts_enabled: true,
      capabilities: { card_payments: 'active', transfers: 'active' },
      requirements: {
        currently_due: [],
        eventually_due: [],
        past_due: [],
        pending_verification: [],
        disabled_reason: null,
        current_deadline: null,
      },
      last_stripe_event_id: null,
      last_stripe_event_created_at: null,
      last_synced_at: new Date(),
      connected_at: now,
      disconnected_at: null,
      created_at: now,
      created_by_user_id: actorId,
      updated_at: now,
      updated_by_source: 'user',
      version: 1,
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await db.dropDatabase();
    await client.close();
  });

  it('commits one provisional graph, then creates and reuses one logical PaymentIntent', async () => {
    const orchestrator = new PublicPaidBookingOrchestrator(
      environment,
      admin,
      payments,
      new PaymentExecutionService(payments, stripe),
    );
    const idempotencyKey = randomUUID();
    const input = {
      tenant,
      body: bookingBody(),
      idempotencyKey,
      requestId: randomUUID(),
      correlationId: randomUUID(),
      ipAddress: '192.0.2.10',
      initialService: service,
      initialProvider: provider,
      initialAssignment: assignment,
    };
    const first = await orchestrator.create(input);
    const replay = await orchestrator.create(input);
    const continued = await orchestrator.continue({
      ...input,
      attemptPublicId: first.payment_attempt_public_id,
    });

    expect(first).toMatchObject({
      appointment_status: 'payment_pending',
      payment_status: 'payment_method_required',
      client_secret: 'pi_client_secret_return_only',
      amounts: { customer_total_due_now_minor: 2_625, application_fee_amount_minor: 125 },
    });
    expect(replay.payment_attempt_public_id).toBe(first.payment_attempt_public_id);
    expect(continued.payment_attempt_public_id).toBe(first.payment_attempt_public_id);
    expect(await db.collection('appointments').countDocuments()).toBe(1);
    expect(await db.collection('provisional_payment_customers').countDocuments()).toBe(1);
    expect(await db.collection('payment_attempts').countDocuments()).toBe(1);
    expect(await db.collection('payment_ledger_entries').countDocuments()).toBe(1);
    expect(await db.collection('notification_outbox').countDocuments()).toBe(0);
    expect(stripe.createDirectChargePaymentIntent).toHaveBeenCalledTimes(1);
    expect(stripe.retrievePaymentIntent).toHaveBeenCalledTimes(2);
    expect(stripe.createDirectChargePaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        connectedAccountId: 'acct_serveronly',
        amountMinor: 2_625,
        applicationFeeAmountMinor: 125,
        receiptEmail: 'customer@example.com',
      }),
    );
    expect(JSON.stringify(await db.collection('payment_attempts').findOne())).not.toContain(
      'pi_client_secret_return_only',
    );

    await expect(
      orchestrator.create({
        ...input,
        body: {
          ...bookingBody(),
          customer: { ...bookingBody().customer, appointment_note: 'changed request' },
        },
      }),
    ).rejects.toMatchObject({ status: 409, code: 'idempotency_key_reused' });
    expect(await db.collection('appointments').countDocuments()).toBe(1);

    serviceRecord.base_price_minor = 11_000;
    await expect(orchestrator.create(input)).rejects.toMatchObject({
      status: 409,
      code: 'payment_attempt_stale',
    });
    expect(await db.collection('payment_attempts').findOne()).toMatchObject({
      state: 'stale',
      slot_released: true,
    });
    expect(await db.collection('appointments').findOne()).toMatchObject({
      status: 'payment_failed',
    });
    expect(await db.collection('appointments').countDocuments()).toBe(1);
  });

  it('fails closed before local writes or Stripe when execution is disabled', async () => {
    serviceRecord.base_price_minor = 10_000;
    const before = await db.collection('payment_attempts').countDocuments();
    const orchestrator = new PublicPaidBookingOrchestrator(
      { ...environment, STRIPE_PAYMENT_EXECUTION_ENABLED: false },
      admin,
      payments,
      new PaymentExecutionService(payments, stripe),
    );
    await expect(
      orchestrator.create({
        tenant,
        body: bookingBody(),
        idempotencyKey: randomUUID(),
        requestId: randomUUID(),
        correlationId: randomUUID(),
        ipAddress: '192.0.2.10',
        initialService: service,
        initialProvider: provider,
        initialAssignment: assignment,
      }),
    ).rejects.toMatchObject({ status: 503, code: 'payment_execution_disabled' });
    expect(await db.collection('payment_attempts').countDocuments()).toBe(before);
    expect(stripe.createDirectChargePaymentIntent).toHaveBeenCalledTimes(1);
  });

  it('converges concurrent requests on one local graph and one Stripe idempotency key', async () => {
    const beforeAppointments = await db.collection('appointments').countDocuments();
    const beforeAttempts = await db.collection('payment_attempts').countDocuments();
    const beforeCreates = stripe.createDirectChargePaymentIntent.mock.calls.length;
    const orchestrator = new PublicPaidBookingOrchestrator(
      environment,
      admin,
      payments,
      new PaymentExecutionService(payments, stripe),
    );
    const input = {
      tenant,
      body: bookingBody(),
      idempotencyKey: randomUUID(),
      requestId: randomUUID(),
      correlationId: randomUUID(),
      ipAddress: '192.0.2.10',
      initialService: service,
      initialProvider: provider,
      initialAssignment: assignment,
    };

    const results = await Promise.all([orchestrator.create(input), orchestrator.create(input)]);

    expect(results[0]?.payment_attempt_public_id).toBe(results[1]?.payment_attempt_public_id);
    expect(await db.collection('appointments').countDocuments()).toBe(beforeAppointments + 1);
    expect(await db.collection('payment_attempts').countDocuments()).toBe(beforeAttempts + 1);
    const createCalls = stripe.createDirectChargePaymentIntent.mock.calls.slice(beforeCreates);
    expect(createCalls.length).toBeGreaterThanOrEqual(1);
    expect(new Set(createCalls.map(([call]) => String(call.idempotencyKey)))).toHaveLength(1);
  });

  it('stales on connected-account reassociation and cancels in the snapshotted account', async () => {
    const orchestrator = new PublicPaidBookingOrchestrator(
      environment,
      admin,
      payments,
      new PaymentExecutionService(payments, stripe),
    );
    const input = {
      tenant,
      body: bookingBody(),
      idempotencyKey: randomUUID(),
      requestId: randomUUID(),
      correlationId: randomUUID(),
      ipAddress: '192.0.2.10',
      initialService: service,
      initialProvider: provider,
      initialAssignment: assignment,
    };
    const created = await orchestrator.create(input);
    const oldAccount = await db.collection('tenant_stripe_accounts').findOne({
      tenant_id: tenantId,
      active: true,
    });
    expect(oldAccount).toBeTruthy();
    await db
      .collection('tenant_stripe_accounts')
      .updateOne(
        { _id: oldAccount!._id },
        { $set: { active: false, updated_at: new Date(), version: 2 } },
      );
    await db.collection('tenant_stripe_accounts').insertOne({
      ...oldAccount,
      _id: new ObjectId(),
      public_id: randomUUID(),
      stripe_account_id: 'acct_reassociated',
      active: true,
      created_at: new Date(),
      updated_at: new Date(),
      version: 1,
    });

    await expect(orchestrator.create(input)).rejects.toMatchObject({
      status: 409,
      code: 'payment_attempt_stale',
    });
    await vi.waitFor(() =>
      expect(stripe.cancelPaymentIntent).toHaveBeenCalledWith(
        expect.objectContaining({
          connectedAccountId: 'acct_serveronly',
          paymentIntentId: expect.stringContaining('pi_'),
        }),
      ),
    );
    expect(
      await db.collection('payment_attempts').findOne({
        public_id: created.payment_attempt_public_id,
      }),
    ).toMatchObject({ state: 'stale', slot_released: true });
  });

  it('stales an existing attempt when approved payment terms change', async () => {
    const orchestrator = new PublicPaidBookingOrchestrator(
      environment,
      admin,
      payments,
      new PaymentExecutionService(payments, stripe),
    );
    const input = {
      tenant,
      body: bookingBody(),
      idempotencyKey: randomUUID(),
      requestId: randomUUID(),
      correlationId: randomUUID(),
      ipAddress: '192.0.2.10',
      initialService: service,
      initialProvider: provider,
      initialAssignment: assignment,
    };
    const created = await orchestrator.create(input);
    const changedTerms = new PublicPaidBookingOrchestrator(
      {
        ...environment,
        BOOKNOWTECH_PAYMENT_TERMS_VERSION: 'payments-v2',
        BOOKNOWTECH_PAYMENT_TERMS_TEXT_SHA256: 'c'.repeat(64),
      },
      admin,
      payments,
      new PaymentExecutionService(payments, stripe),
    );

    await expect(changedTerms.create(input)).rejects.toMatchObject({
      status: 409,
      code: 'payment_attempt_stale',
    });
    expect(
      await db.collection('payment_attempts').findOne({
        public_id: created.payment_attempt_public_id,
      }),
    ).toMatchObject({ state: 'stale', slot_released: true });
  });

  function bookingBody() {
    return {
      service_public_id: servicePublicId,
      provider_public_id: providerPublicId,
      starts_at: startsAt.toISOString(),
      customer: {
        first_name: 'Customer',
        last_name: 'Example',
        email: 'CUSTOMER@example.com',
        mobile_phone: '+18435550104',
        preferred_contact_channel: 'email' as const,
        customer_location_address: null,
        appointment_note: null,
      },
      consent: { booking_terms_version: 'booking-v1', booking_terms_accepted: true },
      payment_terms: { version: 'payments-v1', document_sha256: 'b'.repeat(64), accepted: true },
      website: '',
    };
  }
});

function nextMondayAtNineFifteen(): Date {
  const value = new Date();
  value.setUTCHours(9, 15, 0, 0);
  value.setUTCDate(value.getUTCDate() + ((8 - value.getUTCDay()) % 7 || 7));
  return value;
}

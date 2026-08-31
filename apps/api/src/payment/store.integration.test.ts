import { randomUUID } from 'node:crypto';
import { MongoClient, ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AdminStore } from '../admin/store.js';
import { migrateDatabase } from '../database/migrate.js';
import { calculatePaymentAmounts, createPaymentTermsEvidence } from './domain.js';
import {
  PaymentFoundationStore,
  type TenantBookingFeeActiveDocument,
  type TenantBookingFeeVersionDocument,
  toAmountSnapshot,
} from './store.js';

const uri = process.env.MONGODB_TEST_URI;
const suite = uri ? describe : describe.skip;

suite('PR 14B.1 payment persistence foundation', () => {
  const client = new MongoClient(uri ?? 'mongodb://127.0.0.1:27017');
  const db = client.db(`booknowtech_payment_${randomUUID().replaceAll('-', '')}`);
  const store = new PaymentFoundationStore(db);

  beforeAll(async () => {
    await client.connect();
    await migrateDatabase(db);
    await migrateDatabase(db);
  });
  afterAll(async () => {
    await db.dropDatabase();
    await client.close();
  });

  it('creates strict collections and required uniqueness indexes', async () => {
    const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map(
      ({ name }) => name,
    );
    expect(names).toEqual(
      expect.arrayContaining([
        'tenant_booking_fee_versions',
        'tenant_booking_fee_active',
        'service_payment_configuration_versions',
        'service_payment_configuration_active',
        'tenant_payment_execution_settings',
        'provisional_payment_customers',
        'payment_attempts',
        'payment_ledger_entries',
      ]),
    );
    expect((await db.collection('payment_attempts').indexes()).map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'payment_attempts_tenant_idempotency_unique',
        'payment_attempts_stripe_intent_unique',
        'payment_attempts_tenant_appointment_unique',
        'payment_attempts_recovery_token_unique',
        'payment_attempts_worker_poll',
      ]),
    );
    expect(
      (await db.collection('payment_ledger_entries').indexes()).map(({ name }) => name),
    ).toEqual(
      expect.arrayContaining([
        'payment_ledger_logical_evidence_unique',
        'payment_ledger_attempt_sequence_unique',
      ]),
    );
  });

  it('does not synthesize payment history or reclassify existing appointments', async () => {
    const legacy = client.db(`booknowtech_payment_legacy_${randomUUID().replaceAll('-', '')}`);
    await legacy.createCollection('appointments');
    const appointment = appointmentFixture({
      _id: new ObjectId(),
      tenantId: new ObjectId(),
      customerId: new ObjectId(),
      providerId: new ObjectId(),
      publicId: randomUUID(),
      now: new Date(),
    });
    await legacy.collection('appointments').insertOne({ ...appointment, status: 'scheduled' });
    await migrateDatabase(legacy);
    expect(await legacy.collection('appointments').findOne({ _id: appointment._id })).toMatchObject(
      {
        status: 'scheduled',
      },
    );
    for (const name of [
      'tenant_booking_fee_versions',
      'service_payment_configuration_versions',
      'tenant_payment_execution_settings',
      'provisional_payment_customers',
      'payment_attempts',
      'payment_ledger_entries',
    ])
      expect(await legacy.collection(name).countDocuments()).toBe(0);
    await legacy.dropDatabase();
  });

  it('activates immutable tenant fee versions with replay and tenant isolation', async () => {
    const tenantA = new ObjectId();
    const tenantB = new ObjectId();
    const first = feeInput(tenantA, 125, 'a');
    const active = await store.activateTenantBookingFee(first);
    await expect(store.activateTenantBookingFee(first)).resolves.toEqual(active);
    await expect(
      store.activateTenantBookingFee({
        ...first,
        amountMinor: 150,
        requestFingerprint: 'b'.repeat(64),
      }),
    ).rejects.toThrow('idempotency_conflict');
    await store.activateTenantBookingFee(feeInput(tenantA, 150, 'c'));
    await store.activateTenantBookingFee(feeInput(tenantB, 100, 'd'));
    expect(
      await db.collection('tenant_booking_fee_versions').find({ tenant_id: tenantA }).toArray(),
    ).toMatchObject([
      { version: 1, amount_minor: 125 },
      { version: 2, amount_minor: 150 },
    ]);
    expect(
      await db.collection('tenant_booking_fee_active').findOne({ tenant_id: tenantA }),
    ).toMatchObject({ version: 2, amount_minor: 150 });
    expect(
      await db.collection('tenant_booking_fee_active').findOne({ tenant_id: tenantB }),
    ).toMatchObject({ version: 1, amount_minor: 100 });
    expect(
      await db.collection('audit_logs').countDocuments({
        tenant_id: tenantA,
        event: 'tenant_booking_fee_version_activated',
      }),
    ).toBe(2);
    await expect(
      db.collection('tenant_booking_fee_versions').insertOne({
        _id: new ObjectId(),
        ...feeVersionFixture(tenantA),
        percentage: 5,
      }),
    ).rejects.toThrow();
  });

  it('serializes concurrent fee activation without corrupting the active pointer', async () => {
    const tenantId = new ObjectId();
    const results = await Promise.allSettled([
      store.activateTenantBookingFee(feeInput(tenantId, 100, 'e')),
      store.activateTenantBookingFee(feeInput(tenantId, 125, 'f')),
    ]);
    expect(results.filter(({ status }) => status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    const versions = await db
      .collection<TenantBookingFeeVersionDocument>('tenant_booking_fee_versions')
      .find({ tenant_id: tenantId })
      .sort({ version: 1 })
      .toArray();
    const pointer = await db
      .collection<TenantBookingFeeActiveDocument>('tenant_booking_fee_active')
      .findOne({ tenant_id: tenantId });
    expect(pointer).toBeTruthy();
    expect(versions.some(({ _id }) => _id.equals(pointer!.fee_version_id))).toBe(true);
    expect(new Set(versions.map(({ version }) => version)).size).toBe(versions.length);
  });

  it('versions and normalizes service payment configuration', async () => {
    const tenantId = new ObjectId();
    const serviceId = new ObjectId();
    const base = serviceInput(tenantId, serviceId, 'a');
    const none = await store.activateServicePaymentConfiguration({
      ...base,
      paymentMode: 'fixed_deposit',
      fixedDepositMinor: 0,
    });
    expect(none).toMatchObject({ version: 1, payment_mode: 'none', fixed_deposit_minor: null });
    const full = await store.activateServicePaymentConfiguration({
      ...serviceInput(tenantId, serviceId, 'b'),
      paymentMode: 'fixed_deposit',
      fixedDepositMinor: 10_000,
    });
    expect(full).toMatchObject({ version: 2, payment_mode: 'full', fixed_deposit_minor: null });
    expect(
      await db.collection('audit_logs').countDocuments({
        tenant_id: tenantId,
        event: 'service_payment_configuration_activated',
      }),
    ).toBe(2);
    await expect(
      store.activateServicePaymentConfiguration({
        ...serviceInput(tenantId, serviceId, 'c'),
        paymentMode: 'fixed_deposit',
        fixedDepositMinor: 10_001,
      }),
    ).rejects.toThrow('deposit_exceeds_service_price');
    await expect(
      db.collection('service_payment_configuration_active').insertOne({
        _id: new ObjectId(),
        tenant_id: new ObjectId(),
        service_id: new ObjectId(),
        configuration_version_id: new ObjectId(),
        configuration_public_id: randomUUID(),
        version: 1,
        payment_mode: 'none',
        fixed_deposit_minor: 100,
        currency: 'USD',
        activated_at: new Date(),
        activation_request_id: randomUUID(),
      }),
    ).rejects.toThrow();
  });

  it('enforces payment attempt replay, strict secrets boundary, and ledger uniqueness', async () => {
    const fixture = await paymentFixture(db);
    const inserted = await store.insertPaymentAttempt(fixture.attempt);
    expect(inserted.replayed).toBe(false);
    expect((await store.insertPaymentAttempt(fixture.attempt)).replayed).toBe(true);
    await expect(
      store.insertPaymentAttempt({ ...fixture.attempt, request_fingerprint: 'f'.repeat(64) }),
    ).rejects.toThrow('idempotency_conflict');
    await expect(
      store.insertPaymentAttempt({
        ...fixture.attempt,
        public_id: randomUUID(),
        idempotency_key_hash: randomHex(),
        request_fingerprint: randomHex(),
      }),
    ).rejects.toThrow('attempt_terms_public_id_mismatch');
    await expect(
      store.insertPaymentAttempt({
        ...fixture.attempt,
        state: 'processing',
        idempotency_key_hash: randomHex(),
        request_fingerprint: randomHex(),
      }),
    ).rejects.toThrow('initial_attempt_state_invalid');
    await expect(
      store.insertPaymentAttempt({
        ...fixture.attempt,
        amount_snapshot: {
          ...fixture.attempt.amount_snapshot,
          customer_total_due_now_minor:
            fixture.attempt.amount_snapshot.customer_total_due_now_minor + 1,
        },
      }),
    ).rejects.toThrow('attempt_amount_snapshot_invalid');
    await expect(
      db.collection('payment_attempts').insertOne({
        ...fixture.attempt,
        _id: new ObjectId(),
        public_id: randomUUID(),
        idempotency_key_hash: '1'.repeat(64),
        client_secret: 'forbidden',
        created_at: new Date(),
        updated_at: new Date(),
      }),
    ).rejects.toThrow();

    const entry = ledgerFixture(fixture, inserted.attempt._id);
    await store.appendLedgerEntry(entry);
    await expect(store.appendLedgerEntry({ ...entry, sequence: 2 })).rejects.toThrow();
    expect('updateLedgerEntry' in store).toBe(false);
    expect('deleteLedgerEntry' in store).toBe(false);
  });

  it('rolls back attempt and ledger together in a failed transaction', async () => {
    const fixture = await paymentFixture(db);
    const session = client.startSession();
    await expect(
      session.withTransaction(async () => {
        const inserted = await store.insertPaymentAttempt(fixture.attempt, session);
        await store.appendLedgerEntry(ledgerFixture(fixture, inserted.attempt._id), session);
        throw new Error('force rollback');
      }),
    ).rejects.toThrow('force rollback');
    await session.endSession();
    expect(
      await db
        .collection('payment_attempts')
        .countDocuments({ public_id: fixture.attempt.public_id }),
    ).toBe(0);
    expect(
      await db
        .collection('payment_ledger_entries')
        .countDocuments({ tenant_id: fixture.attempt.tenant_id }),
    ).toBe(0);
  });

  it('prevents cross-tenant PaymentIntent linking and Stripe-ID authority', async () => {
    const tenantA = await paymentFixture(db);
    const tenantB = await paymentFixture(db);
    await store.insertPaymentAttempt(tenantA.attempt);
    await store.insertPaymentAttempt(tenantB.attempt);
    const intent = {
      id: 'pi_crossTenantIsolation',
      status: 'requires_payment_method' as const,
      clientSecret: 'pi_secret_transient',
      amount: 2_625,
      applicationFeeAmount: 125,
      currency: 'usd' as const,
    };

    await store.linkPaymentIntent({
      tenantId: tenantA.attempt.tenant_id,
      attemptPublicId: tenantA.attempt.public_id,
      intent,
    });
    await expect(
      store.linkPaymentIntent({
        tenantId: tenantB.attempt.tenant_id,
        attemptPublicId: tenantA.attempt.public_id,
        intent,
      }),
    ).rejects.toThrow('payment_intent_link_conflict');
    await expect(
      store.linkPaymentIntent({
        tenantId: tenantB.attempt.tenant_id,
        attemptPublicId: tenantB.attempt.public_id,
        intent,
      }),
    ).rejects.toThrow();
    expect(
      await db.collection('payment_attempts').countDocuments({
        stripe_payment_intent_id: intent.id,
      }),
    ).toBe(1);
    expect(
      JSON.stringify(
        await db.collection('payment_attempts').findOne({
          public_id: tenantA.attempt.public_id,
        }),
      ),
    ).not.toContain(intent.clientSecret);
  });

  it('blocks provisional slots and releases terminal transitions exactly once', async () => {
    const fixture = await paymentFixture(db);
    const competing = await paymentFixture(db, {
      tenantId: fixture.attempt.tenant_id,
      providerId: fixture.providerId,
    });
    await store.insertPaymentAttempt(fixture.attempt);
    await store.insertPaymentAttempt(competing.attempt);
    const admin = new AdminStore(db);
    expect(
      await admin.listBlockingAppointments({
        tenantId: fixture.attempt.tenant_id,
        providerId: fixture.providerId,
        startsBefore: new Date('2026-08-24T15:00:00.000Z'),
        endsAfter: new Date('2026-08-24T14:00:00.000Z'),
      }),
    ).toHaveLength(2);
    const first = await store.transitionAttempt({
      tenantId: fixture.attempt.tenant_id,
      attemptPublicId: fixture.attempt.public_id,
      event: 'expire',
    });
    expect(first.releaseSlot).toBe(true);
    const replay = await store.transitionAttempt({
      tenantId: fixture.attempt.tenant_id,
      attemptPublicId: fixture.attempt.public_id,
      event: 'expire',
    });
    expect(replay.releaseSlot).toBe(false);
    expect(
      await admin.listBlockingAppointments({
        tenantId: fixture.attempt.tenant_id,
        providerId: fixture.providerId,
        startsBefore: new Date('2026-08-24T15:00:00.000Z'),
        endsAfter: new Date('2026-08-24T14:00:00.000Z'),
      }),
    ).toHaveLength(1);
    expect(
      await db.collection('appointments').findOne({ _id: competing.attempt.appointment_id }),
    ).toMatchObject({ status: 'payment_pending' });
    await store.transitionAttempt({
      tenantId: competing.attempt.tenant_id,
      attemptPublicId: competing.attempt.public_id,
      event: 'terminal_failure',
    });
    expect(
      await admin.listBlockingAppointments({
        tenantId: fixture.attempt.tenant_id,
        providerId: fixture.providerId,
        startsBefore: new Date('2026-08-24T15:00:00.000Z'),
        endsAfter: new Date('2026-08-24T14:00:00.000Z'),
      }),
    ).toHaveLength(0);
    expect(
      await admin.listAppointments({
        tenantId: fixture.attempt.tenant_id,
        direction: 'ascending',
        limit: 20,
      }),
    ).toHaveLength(0);
  });

  it('allows exactly one stale-readiness refresh claim and rejects a replaced association', async () => {
    const tenantId = new ObjectId();
    const publicId = randomUUID();
    const now = new Date();
    await db.collection('tenant_stripe_accounts').insertOne({
      public_id: publicId,
      tenant_id: tenantId,
      stripe_account_id: 'acct_readinessconcurrency',
      account_type: 'express',
      country: 'US',
      default_currency: 'USD',
      status: 'payouts_enabled',
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
      last_synced_at: new Date(0),
      connected_at: now,
      disconnected_at: null,
      created_at: now,
      created_by_user_id: new ObjectId(),
      updated_at: now,
      updated_by_source: 'user',
      version: 1,
      readiness_generation: 0,
      readiness_refresh_token: null,
      readiness_refresh_started_at: null,
      last_readiness_refresh_attempt_at: null,
      last_readiness_refresh_failure_category: null,
    });
    const claims = await Promise.all(
      ['claim-a', 'claim-b'].map((token) =>
        store.claimStripeReadinessRefresh({
          tenantId,
          accountPublicId: publicId,
          token,
          staleBefore: new Date(),
          leaseExpiredBefore: new Date(Date.now() - 15_000),
        }),
      ),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    const winner = claims.find(Boolean)!;
    await db
      .collection('tenant_stripe_accounts')
      .updateOne({ public_id: publicId }, { $set: { active: false, disconnected_at: new Date() } });
    await expect(
      store.completeStripeReadinessRefresh({
        tenantId,
        accountPublicId: publicId,
        connectedAccountId: winner.stripe_account_id,
        token: winner.readiness_refresh_token!,
        projection: {
          status: 'payouts_enabled',
          details_submitted: true,
          charges_enabled: true,
          payouts_enabled: true,
          capabilities: { card_payments: 'active', transfers: 'active' },
          requirements: {},
        },
      }),
    ).resolves.toBeNull();
  });
});

function feeInput(tenantId: ObjectId, amountMinor: number, seed: string) {
  return {
    tenantId,
    amountMinor,
    operatorId: 'booknowtech-operator',
    reason: 'Approved tenant booking fee change.',
    requestId: `request-${seed}`,
    idempotencyKeyHash: seed.repeat(64),
    requestFingerprint: seed.repeat(64),
  };
}

function feeVersionFixture(tenantId: ObjectId) {
  return {
    public_id: randomUUID(),
    tenant_id: tenantId,
    version: 99,
    amount_minor: 100,
    currency: 'USD',
    operator_id: 'booknowtech-operator',
    reason: 'Approved tenant booking fee change.',
    request_id: randomUUID(),
    idempotency_key_hash: '9'.repeat(64),
    request_fingerprint: '8'.repeat(64),
    created_at: new Date(),
  };
}

function serviceInput(tenantId: ObjectId, serviceId: ObjectId, seed: string) {
  return {
    tenantId,
    serviceId,
    servicePublicId: randomUUID(),
    servicePriceMinor: 10_000,
    paymentMode: 'none' as const,
    requestId: `service-request-${seed}`,
    idempotencyKeyHash: seed.repeat(64),
    requestFingerprint: seed.repeat(64),
    userId: new ObjectId(),
    membershipId: new ObjectId(),
  };
}

async function paymentFixture(
  db: ReturnType<MongoClient['db']>,
  requested?: { tenantId: ObjectId; providerId: ObjectId },
) {
  const tenantId = requested?.tenantId ?? new ObjectId();
  const appointmentId = new ObjectId();
  const customerId = new ObjectId();
  const providerId = requested?.providerId ?? new ObjectId();
  const publicId = randomUUID();
  const now = new Date();
  await db.collection('appointments').insertOne(
    appointmentFixture({
      _id: appointmentId,
      tenantId,
      customerId,
      providerId,
      publicId,
      now,
    }),
  );
  const amounts = calculatePaymentAmounts({
    servicePriceMinor: 10_000,
    paymentMode: 'fixed_deposit',
    fixedDepositMinor: 2_500,
    booknowtechFeeMinor: 125,
    currency: 'USD',
  });
  const idempotencyKeyHash = randomHex();
  const attemptPublicId = randomUUID();
  return {
    providerId,
    attempt: {
      public_id: attemptPublicId,
      tenant_id: tenantId,
      appointment_id: appointmentId,
      customer_id: customerId,
      customer_email_normalized: 'customer@example.com',
      tenant_stripe_account_public_id: randomUUID(),
      idempotency_key_hash: idempotencyKeyHash,
      request_fingerprint: randomHex(),
      client_request_fingerprint: randomHex(),
      recovery_token_hash: randomHex(),
      recovery_hostname_hash: randomHex(),
      recovery_expires_at: new Date(Date.now() + 10_800_000),
      amount_snapshot: toAmountSnapshot(amounts),
      configuration_snapshot: {
        service_payment_configuration_public_id: randomUUID(),
        service_payment_configuration_version: 1,
        deposit_version_public_id: randomUUID(),
        fee_configuration_public_id: randomUUID(),
        fee_version: 1,
      },
      payment_terms_acceptance: createPaymentTermsEvidence({
        version: 'payments-v1',
        documentSha256: randomHex(),
        acceptedAt: now,
        requestId: randomUUID(),
        paymentAttemptPublicId: attemptPublicId,
        idempotencyKeyHash,
        ipAddress: '192.0.2.1',
        ipHashSecret: 's'.repeat(32),
      }),
      stripe_payment_intent_id: null,
      stripe_payment_intent_status: null,
      state: 'requested' as const,
      expires_at: new Date(now.valueOf() + 15 * 60_000),
      slot_released: false,
      claim_token: null,
      claim_started_at: null,
      attempt_count: 0,
      next_attempt_at: now,
      failure_category: null,
      request_id: randomUUID(),
      correlation_id: randomUUID(),
    },
  };
}

function appointmentFixture(input: {
  _id: ObjectId;
  tenantId: ObjectId;
  customerId: ObjectId;
  providerId: ObjectId;
  publicId: string;
  now: Date;
}) {
  return {
    _id: input._id,
    public_id: input.publicId,
    reference: `BNT-${input.publicId.replaceAll('-', '').slice(0, 8).toUpperCase()}`,
    tenant_id: input.tenantId,
    customer_id: input.customerId,
    provider_id: input.providerId,
    service_id: new ObjectId(),
    provider_service_assignment_id: new ObjectId(),
    starts_at: new Date('2026-08-24T14:00:00.000Z'),
    ends_at: new Date('2026-08-24T15:00:00.000Z'),
    blocked_starts_at: new Date('2026-08-24T14:00:00.000Z'),
    blocked_ends_at: new Date('2026-08-24T15:00:00.000Z'),
    timezone: 'America/New_York',
    local_start_date: '2026-08-24',
    snapshot: {
      customer_display_name: 'Provisional Customer',
      provider_display_name: 'Provider',
      service_name: 'Service',
      service_duration_minutes: 60,
      slot_cadence_minutes: 15,
      buffer_before_minutes: 0,
      buffer_after_minutes: 0,
      delivery_mode: 'provider_location',
      base_price_minor: 10_000,
      booking_fee_minor: 0,
      currency: 'USD',
      customer_note: null,
    },
    location: { mode: 'provider_location', customer_address: null },
    status: 'payment_pending',
    source: 'public_booking',
    public_submission: {
      idempotency_key_hash: randomHex(),
      request_fingerprint: randomHex(),
    },
    booking_terms: { version: 'v1', accepted_at: input.now },
    cancelled_at: null,
    cancelled_by: null,
    cancellation_reason: null,
    cancellation_detail: null,
    completed_at: null,
    completed_by: null,
    no_show_at: null,
    no_show_by: null,
    version: 1,
    created_at: input.now,
    updated_at: input.now,
    created_by: null,
    updated_by: null,
  };
}

function ledgerFixture(
  fixture: Awaited<ReturnType<typeof paymentFixture>>,
  paymentAttemptId: ObjectId,
) {
  const amounts = fixture.attempt.amount_snapshot;
  return {
    tenant_id: fixture.attempt.tenant_id,
    appointment_id: fixture.attempt.appointment_id,
    payment_attempt_id: paymentAttemptId,
    entry_kind: 'intent_requested' as const,
    sequence: 1,
    currency: 'USD' as const,
    service_price_minor: amounts.service_price_minor,
    provider_amount_due_now_minor: amounts.provider_amount_due_now_minor,
    booknowtech_fee_minor: amounts.booknowtech_fee_minor,
    customer_total_due_now_minor: amounts.customer_total_due_now_minor,
    application_fee_amount_minor: amounts.application_fee_amount_minor,
    remaining_service_balance_minor: amounts.remaining_service_balance_minor,
    source_identity: fixture.attempt.public_id,
    source_idempotency_key: 'intent-requested',
    stripe_object_id: null,
    stripe_event_id: null,
    effective_at: new Date(),
    request_id: fixture.attempt.request_id,
    correlation_id: fixture.attempt.correlation_id,
  };
}

function randomHex() {
  return randomUUID().replaceAll('-', '').padEnd(64, '0');
}

import { createHash, randomUUID } from 'node:crypto';
import { MongoClient, ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  type PaymentEventProjection,
  applyExternalFinancialEvidence,
  applyPaymentEvent,
} from '../src/payment-event-finalizer.js';

const uri = process.env.MONGODB_TEST_URI;
const suite = uri ? describe : describe.skip;
const options = {
  publicAppointmentTokenSecret: 'payment-finalization-test-secret-at-least-32-bytes',
  paymentTermsVersion: 'payment-v1',
  paymentTermsDocumentSha256: 'a'.repeat(64),
};

suite('payment webhook financial finalization', () => {
  const client = new MongoClient(uri ?? 'mongodb://127.0.0.1:27017');
  const db = client.db(`booknowtech_payment_events_${randomUUID().replaceAll('-', '')}`);

  beforeAll(async () => {
    await client.connect();
    await db.collection('payment_ledger_entries').createIndexes([
      { key: { tenant_id: 1, source_identity: 1, source_idempotency_key: 1 }, unique: true },
      { key: { tenant_id: 1, payment_attempt_id: 1, sequence: 1 }, unique: true },
    ]);
    await db.collection('notification_outbox').createIndex(
      { tenant_id: 1, appointment_id: 1, financial_finalization_key: 1 },
      {
        unique: true,
        partialFilterExpression: { financial_finalization_key: { $type: 'string' } },
      },
    );
    await db
      .collection('appointment_public_access_tokens')
      .createIndex(
        { tenant_id: 1, appointment_id: 1, purpose: 1 },
        { unique: true, partialFilterExpression: { status: 'active' } },
      );
  });
  afterAll(async () => {
    await db.dropDatabase();
    await client.close();
  });

  it('finalizes success and all customer effects exactly once across distinct event IDs', async () => {
    const seeded = await seed('succeeded_unfinalized');
    await apply(seeded, 'payment_intent.succeeded', 'succeeded');
    await apply(seeded, 'payment_intent.succeeded', 'succeeded');
    expect(
      await db.collection('payment_attempts').findOne({ _id: seeded.attemptId }),
    ).toMatchObject({ state: 'succeeded', slot_released: false });
    expect(
      await db.collection('appointments').findOne({ _id: seeded.appointmentId }),
    ).toMatchObject({ status: 'scheduled', version: 2 });
    expect(
      await db
        .collection('payment_ledger_entries')
        .countDocuments({ entry_kind: 'payment_succeeded' }),
    ).toBe(1);
    expect(await db.collection('appointment_public_access_tokens').countDocuments()).toBe(1);
    expect(await db.collection('notification_outbox').countDocuments()).toBe(1);
    expect(
      await db.collection('audit_logs').countDocuments({ event: 'payment_booking_finalized' }),
    ).toBe(1);
  });

  it('does not resurrect a released slot after late success and records manual review', async () => {
    const seeded = await seed('expired', true, 'payment_expired');
    await apply(seeded, 'payment_intent.succeeded', 'succeeded');
    expect(
      await db.collection('appointments').findOne({ _id: seeded.appointmentId }),
    ).toMatchObject({ status: 'payment_expired' });
    expect(
      await db.collection('payment_attempts').findOne({ _id: seeded.attemptId }),
    ).toMatchObject({ state: 'manual_review', slot_released: true });
    expect(await db.collection('notification_outbox').countDocuments()).toBe(0);
    expect(
      await db
        .collection('payment_ledger_entries')
        .countDocuments({ entry_kind: 'payment_succeeded' }),
    ).toBe(1);
  });

  it('lets committed success defeat a later expiry release attempt', async () => {
    const seeded = await seed('succeeded_unfinalized');
    await apply(seeded, 'payment_intent.succeeded', 'succeeded');
    const release = await db
      .collection('payment_attempts')
      .updateOne(
        { _id: seeded.attemptId, state: { $ne: 'succeeded' }, slot_released: false },
        { $set: { state: 'expired', slot_released: true } },
      );
    expect(release.modifiedCount).toBe(0);
    expect(
      await db.collection('appointments').findOne({ _id: seeded.appointmentId }),
    ).toMatchObject({
      status: 'scheduled',
    });
  });

  it('refuses success after an authoritative service-price change', async () => {
    const seeded = await seed('succeeded_unfinalized');
    await db.collection('services').updateOne({}, { $set: { base_price_minor: 11_000 } });
    await apply(seeded, 'payment_intent.succeeded', 'succeeded');
    expect(
      await db.collection('payment_attempts').findOne({ _id: seeded.attemptId }),
    ).toMatchObject({
      state: 'manual_review',
    });
    expect(
      await db.collection('appointments').findOne({ _id: seeded.appointmentId }),
    ).toMatchObject({
      status: 'payment_pending',
    });
  });

  it('keeps recoverable failures and processing blocked, then releases terminal cancellation once', async () => {
    const failed = await seed('requires_payment_method');
    await apply(failed, 'payment_intent.payment_failed', 'requires_payment_method');
    expect(
      await db.collection('payment_attempts').findOne({ _id: failed.attemptId }),
    ).toMatchObject({ state: 'failed_recoverable', slot_released: false });
    expect(
      await db.collection('appointments').findOne({ _id: failed.appointmentId }),
    ).toMatchObject({ status: 'payment_pending' });
    const processing = await seed('requires_payment_method');
    await apply(processing, 'payment_intent.processing', 'processing');
    expect(
      await db.collection('payment_attempts').findOne({ _id: processing.attemptId }),
    ).toMatchObject({ state: 'processing', slot_released: false });
    const canceled = await seed('requires_payment_method');
    await apply(canceled, 'payment_intent.canceled', 'canceled');
    await apply(canceled, 'payment_intent.canceled', 'canceled');
    expect(
      await db.collection('payment_attempts').findOne({ _id: canceled.attemptId }),
    ).toMatchObject({ state: 'failed_terminal', slot_released: true });
    expect(
      await db.collection('appointments').findOne({ _id: canceled.appointmentId }),
    ).toMatchObject({ status: 'payment_failed', version: 2 });
    expect(
      await db.collection('payment_ledger_entries').countDocuments({
        payment_attempt_id: canceled.attemptId,
        entry_kind: 'payment_failed_terminal',
      }),
    ).toBe(1);
  });

  it('classifies cancellation after the hold deadline as expiry exactly once', async () => {
    const seeded = await seed('requires_payment_method');
    await db.collection('payment_attempts').updateOne(
      { _id: seeded.attemptId },
      {
        $set: {
          expires_at: new Date(Date.now() - 1_000),
          claim_token: randomUUID(),
          claim_started_at: new Date(),
        },
      },
    );
    await apply(seeded, 'payment_intent.canceled', 'canceled');
    expect(
      await db.collection('payment_attempts').findOne({ _id: seeded.attemptId }),
    ).toMatchObject({ state: 'expired', slot_released: true, failure_category: 'expired' });
    expect(
      await db.collection('appointments').findOne({ _id: seeded.appointmentId }),
    ).toMatchObject({ status: 'payment_expired', version: 2 });
    expect(
      await db.collection('payment_ledger_entries').countDocuments({
        payment_attempt_id: seeded.attemptId,
        entry_kind: 'payment_expired',
      }),
    ).toBe(1);
    await apply(seeded, 'payment_intent.canceled', 'canceled');
    expect(
      await db.collection('payment_attempts').findOne({ _id: seeded.attemptId }),
    ).toMatchObject({ state: 'expired', slot_released: true });
    expect(
      await db.collection('payment_ledger_entries').countDocuments({
        payment_attempt_id: seeded.attemptId,
        entry_kind: 'payment_expired',
      }),
    ).toBe(1);
  });

  it('fails closed to manual review on amount or account attribution mismatch', async () => {
    const seeded = await seed('succeeded_unfinalized');
    await apply(seeded, 'payment_intent.succeeded', 'succeeded', 1);
    expect(
      await db.collection('payment_attempts').findOne({ _id: seeded.attemptId }),
    ).toMatchObject({ state: 'manual_review' });
    expect(
      await db.collection('appointments').findOne({ _id: seeded.appointmentId }),
    ).toMatchObject({ status: 'payment_pending' });
  });

  it('records external refund evidence without changing appointment cancellation state', async () => {
    const seeded = await seed('succeeded', false, 'scheduled');
    const refundId = `re_${randomUUID().replaceAll('-', '')}`;
    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
        for (const [eventType, status] of [
          ['refund.created', 'pending'],
          ['refund.updated', 'succeeded'],
        ] as const)
          await applyExternalFinancialEvidence(
            db,
            {
              _id: new ObjectId(),
              stripe_event_id: `evt_${randomUUID().replaceAll('-', '')}`,
              stripe_account_id: seeded.accountId,
              event_type: eventType,
              stripe_created_at: new Date(),
              sanitized_payload: {
                object_type: 'refund',
                id: refundId,
                payment_intent_id: seeded.intentId,
                amount: 1_000,
                currency: 'usd',
                status,
              },
              received_request_id: randomUUID(),
            },
            session,
          );
      });
    } finally {
      await session.endSession();
    }
    expect(
      await db.collection('appointments').findOne({ _id: seeded.appointmentId }),
    ).toMatchObject({
      status: 'scheduled',
    });
    expect(
      await db
        .collection('payment_ledger_entries')
        .find({ payment_attempt_id: seeded.attemptId })
        .sort({ sequence: 1 })
        .toArray(),
    ).toEqual([
      expect.objectContaining({ entry_kind: 'refund_created_external' }),
      expect.objectContaining({ entry_kind: 'refund_updated_external' }),
    ]);
    expect(
      await db.collection('payment_attempts').findOne({ _id: seeded.attemptId }),
    ).toMatchObject({
      state: 'manual_review',
    });
  });

  async function apply(
    seeded: Awaited<ReturnType<typeof seed>>,
    type: string,
    status: string,
    amountDelta = 0,
  ) {
    const session = client.startSession();
    try {
      await session.withTransaction(() =>
        applyPaymentEvent(
          db,
          {
            _id: new ObjectId(),
            stripe_event_id: `evt_${randomUUID().replaceAll('-', '')}`,
            stripe_account_id: seeded.accountId,
            event_type: type,
            stripe_created_at: new Date(),
            sanitized_payload: projection(seeded.intentId, status, amountDelta),
            received_request_id: randomUUID(),
          },
          options,
          session,
        ),
      );
    } finally {
      await session.endSession();
    }
  }

  async function seed(state: string, released = false, appointmentStatus = 'payment_pending') {
    await Promise.all(
      [
        'payment_attempts',
        'appointments',
        'payment_ledger_entries',
        'appointment_public_access_tokens',
        'notification_outbox',
        'audit_logs',
        'tenant_stripe_accounts',
        'services',
        'service_payment_configuration_active',
        'tenants',
        'providers',
        'provider_service_assignments',
        'provisional_payment_customers',
      ].map((name) => db.collection(name).deleteMany({})),
    );
    const tenantId = new ObjectId();
    const appointmentId = new ObjectId();
    const attemptId = new ObjectId();
    const serviceId = new ObjectId();
    const providerId = new ObjectId();
    const assignmentId = new ObjectId();
    const customerId = new ObjectId();
    const accountId = `acct_${randomUUID().replaceAll('-', '')}`;
    const accountPublicId = randomUUID();
    const intentId = `pi_${randomUUID().replaceAll('-', '')}`;
    const configurationPublicId = randomUUID();
    const feeConfigurationPublicId = randomUUID();
    const tenantPublicId = randomUUID();
    const servicePublicId = randomUUID();
    const providerPublicId = randomUUID();
    const assignmentPublicId = randomUUID();
    const customerInputHash = 'b'.repeat(64);
    const now = new Date();
    const appointmentPublicId = randomUUID();
    const startsAt = new Date(now.valueOf() + 86_400_000);
    await db.collection('tenant_stripe_accounts').insertOne({
      tenant_id: tenantId,
      public_id: accountPublicId,
      stripe_account_id: accountId,
      active: true,
    });
    await db.collection('services').insertOne({
      _id: serviceId,
      tenant_id: tenantId,
      status: 'active',
      public_id: servicePublicId,
      base_price_minor: 10_000,
    });
    await db.collection('service_payment_configuration_active').insertOne({
      tenant_id: tenantId,
      service_id: serviceId,
      configuration_public_id: configurationPublicId,
      version: 1,
    });
    await db.collection('tenants').insertOne({
      _id: tenantId,
      public_id: tenantPublicId,
      appointment_email_settings: { enabled: true },
      public_profile: {
        business_name: 'Business',
        logo_url: null,
        phone_e164: null,
        email_normalized: null,
        website_url: null,
      },
    });
    await db
      .collection('providers')
      .insertOne({ _id: providerId, public_id: providerPublicId, photo_url: null });
    await db.collection('provider_service_assignments').insertOne({
      _id: assignmentId,
      public_id: assignmentPublicId,
    });
    await db.collection('provisional_payment_customers').insertOne({
      _id: customerId,
      email_normalized: 'customer@example.test',
      customer_input_hash: customerInputHash,
    });
    await db.collection('appointments').insertOne({
      _id: appointmentId,
      public_id: appointmentPublicId,
      reference: 'BNT-1234ABCD',
      tenant_id: tenantId,
      provider_id: providerId,
      service_id: serviceId,
      provider_service_assignment_id: assignmentId,
      starts_at: startsAt,
      ends_at: new Date(now.valueOf() + 90_000_000),
      timezone: 'UTC',
      status: appointmentStatus,
      version: 1,
      location: { mode: 'provider_location' },
      snapshot: {
        base_price_minor: 10_000,
        customer_display_name: 'Customer',
        provider_display_name: 'Provider',
        service_name: 'Service',
        service_duration_minutes: 60,
        slot_cadence_minutes: 15,
        buffer_before_minutes: 0,
        buffer_after_minutes: 0,
        delivery_mode: 'provider_location',
      },
    });
    await db.collection('payment_attempts').insertOne({
      _id: attemptId,
      public_id: randomUUID(),
      tenant_id: tenantId,
      appointment_id: appointmentId,
      customer_id: customerId,
      tenant_stripe_account_public_id: accountPublicId,
      amount_snapshot: {
        payment_mode: 'fixed_deposit',
        fixed_deposit_minor: 2_500,
        service_price_minor: 10_000,
        provider_amount_due_now_minor: 2_500,
        booknowtech_fee_minor: 125,
        customer_total_due_now_minor: 2_625,
        application_fee_amount_minor: 125,
        remaining_service_balance_minor: 7_500,
      },
      configuration_snapshot: {
        service_payment_configuration_public_id: configurationPublicId,
        service_payment_configuration_version: 1,
        deposit_version_public_id: configurationPublicId,
        fee_configuration_public_id: feeConfigurationPublicId,
        fee_version: 1,
      },
      payment_terms_acceptance: {
        version: options.paymentTermsVersion,
        document_sha256: options.paymentTermsDocumentSha256,
      },
      stripe_payment_intent_id: intentId,
      state,
      slot_released: released,
      expires_at: new Date(now.valueOf() + 900_000),
      claim_token: null,
      correlation_id: randomUUID(),
      request_fingerprint: fingerprint({
        tenantPublicId,
        servicePublicId,
        providerPublicId,
        assignmentPublicId,
        startsAt,
        customerInputHash,
        configurationPublicId,
        feeConfigurationPublicId,
        accountPublicId,
      }),
      public_booking_origin: 'https://tenant.booknowtech.com',
    });
    return { accountId, appointmentId, attemptId, intentId };
  }
});

function projection(id: string, status: string, delta = 0): PaymentEventProjection {
  return {
    id,
    status,
    amount: 2_625 + delta,
    application_fee_amount: 125,
    currency: 'usd',
    last_payment_error_code: status === 'requires_payment_method' ? 'card_declined' : null,
  };
}

function fingerprint(input: {
  tenantPublicId: string;
  servicePublicId: string;
  providerPublicId: string;
  assignmentPublicId: string;
  startsAt: Date;
  customerInputHash: string;
  configurationPublicId: string;
  feeConfigurationPublicId: string;
  accountPublicId: string;
}) {
  const canonical = JSON.stringify({
    schema: 2,
    tenant_public_id: input.tenantPublicId,
    service_public_id: input.servicePublicId,
    provider_public_id: input.providerPublicId,
    provider_service_assignment_public_id: input.assignmentPublicId,
    starts_at: input.startsAt.toISOString(),
    duration_minutes: 60,
    slot_cadence_minutes: 15,
    buffer_before_minutes: 0,
    buffer_after_minutes: 0,
    delivery_mode: 'provider_location',
    customer_input_hash: input.customerInputHash,
    service_price_minor: 10_000,
    payment_mode: 'fixed_deposit',
    deposit_version_public_id: input.configurationPublicId,
    fixed_deposit_minor: 2_500,
    fee_version: 1,
    fee_amount_minor: 125,
    fee_configuration_public_id: input.feeConfigurationPublicId,
    stripe_association_public_id: input.accountPublicId,
    payment_terms_version: options.paymentTermsVersion,
    payment_terms_document_sha256: options.paymentTermsDocumentSha256,
    payment_configuration_version: 1,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

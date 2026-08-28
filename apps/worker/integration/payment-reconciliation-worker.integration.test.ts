import { randomUUID } from 'node:crypto';
import { MongoClient, ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  type PaymentReconciliationStripe,
  processPaymentReconciliation,
} from '../src/payment-reconciliation-worker.js';

const uri = process.env.MONGODB_TEST_URI;
const suite = uri ? describe : describe.skip;
const options = {
  publicAppointmentTokenSecret: 'a'.repeat(64),
  paymentTermsVersion: 'payments-v1',
  paymentTermsDocumentSha256: 'b'.repeat(64),
};

suite('payment reconciliation worker', () => {
  const client = new MongoClient(uri ?? 'mongodb://127.0.0.1:27017');
  const db = client.db(`booknowtech_reconciliation_${randomUUID().replaceAll('-', '')}`);
  beforeAll(async () => client.connect());
  afterAll(async () => {
    await db.dropDatabase();
    await client.close();
  });

  it('retrieves, cancels, expires, and releases an unpaid hold exactly once', async () => {
    const seeded = await seed({ state: 'requires_payment_method', expired: true });
    let cancellations = 0;
    const stripe = adapter({ status: 'requires_payment_method' }, () => {
      cancellations += 1;
      return { status: 'canceled' };
    });

    expect(await processPaymentReconciliation(db, stripe, options, seeded.now)).toBe(true);
    expect(await processPaymentReconciliation(db, stripe, options, seeded.now)).toBe(false);
    expect(cancellations).toBe(1);
    expect(
      await db.collection('payment_attempts').findOne({ _id: seeded.attemptId }),
    ).toMatchObject({
      state: 'expired',
      slot_released: true,
      stripe_payment_intent_status: 'canceled',
    });
    expect(
      await db.collection('appointments').findOne({ _id: seeded.appointmentId }),
    ).toMatchObject({ status: 'payment_expired', version: 2 });
    expect(
      await db
        .collection('payment_ledger_entries')
        .countDocuments({ payment_attempt_id: seeded.attemptId, entry_kind: 'payment_expired' }),
    ).toBe(1);
  });

  it('never releases on retrieval uncertainty and schedules a bounded retry', async () => {
    const seeded = await seed({ state: 'requires_payment_method', expired: true });
    const stripe = adapter({}, () => ({}), new Error('network_unavailable'));
    await processPaymentReconciliation(db, stripe, options, seeded.now);
    expect(
      await db.collection('payment_attempts').findOne({ _id: seeded.attemptId }),
    ).toMatchObject({
      state: 'requires_payment_method',
      slot_released: false,
      attempt_count: 1,
      claim_token: null,
      failure_category: 'unknown',
    });
    expect(
      await db.collection('appointments').findOne({ _id: seeded.appointmentId }),
    ).toMatchObject({ status: 'payment_pending' });
  });

  it('lets authoritative success supersede expiry and invokes finalization without releasing', async () => {
    const seeded = await seed({ state: 'succeeded_unfinalized', expired: true });
    let finalized = 0;
    await processPaymentReconciliation(
      db,
      adapter({ status: 'succeeded' } as never),
      options,
      seeded.now,
      {
        finalizeSuccess: () => {
          finalized += 1;
          return Promise.resolve();
        },
      },
    );
    expect(finalized).toBe(1);
    expect(
      await db.collection('appointments').findOne({ _id: seeded.appointmentId }),
    ).toMatchObject({ status: 'payment_pending' });
    expect(
      await db.collection('payment_attempts').findOne({ _id: seeded.attemptId }),
    ).toMatchObject({ slot_released: false });
  });

  it('keeps a known-processing slot and escalates after the final bounded attempt', async () => {
    const seeded = await seed({ state: 'processing', expired: true, attemptCount: 4 });
    await processPaymentReconciliation(db, adapter({ status: 'processing' }), options, seeded.now);
    expect(
      await db.collection('payment_attempts').findOne({ _id: seeded.attemptId }),
    ).toMatchObject({
      state: 'manual_review',
      slot_released: false,
      attempt_count: 5,
    });
    expect(
      await db
        .collection('payment_operations_alerts')
        .countDocuments({ payment_attempt_id: seeded.attemptId, status: 'open' }),
    ).toBe(1);
  });

  it('alerts operations immediately when known-paid finalization recovery fails', async () => {
    const seeded = await seed({ state: 'succeeded_unfinalized', expired: true });
    await processPaymentReconciliation(
      db,
      adapter({}, () => ({}), new Error('local_finalization_unavailable')),
      options,
      seeded.now,
    );
    expect(
      await db.collection('payment_attempts').findOne({ _id: seeded.attemptId }),
    ).toMatchObject({
      state: 'succeeded_unfinalized',
      slot_released: false,
      attempt_count: 1,
    });
    expect(
      await db
        .collection('payment_operations_alerts')
        .findOne({ payment_attempt_id: seeded.attemptId }),
    ).toMatchObject({
      category: 'reconciliation_actionable',
      priority: 'highest',
      resolution_target: 'one_hour_during_operating_hours',
      status: 'open',
    });
  });

  it('uses atomic claim ownership across concurrent workers', async () => {
    const seeded = await seed({ state: 'requires_payment_method', expired: true });
    let retrievals = 0;
    const stripe = adapter({ status: 'requires_payment_method' }, () => ({ status: 'canceled' }));
    const wrapped: PaymentReconciliationStripe = {
      ...stripe,
      retrievePaymentIntent: async (...args) => {
        retrievals += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return stripe.retrievePaymentIntent(...args);
      },
    };
    await Promise.all([
      processPaymentReconciliation(db, wrapped, options, seeded.now),
      processPaymentReconciliation(db, wrapped, options, seeded.now),
    ]);
    expect(retrievals).toBe(1);
  });

  it('reclaims a stale claim and still uses the snapshotted connected account', async () => {
    const seeded = await seed({ state: 'requires_payment_method', expired: true });
    await db.collection('payment_attempts').updateOne(
      { _id: seeded.attemptId },
      {
        $set: {
          claim_token: randomUUID(),
          claim_started_at: new Date(seeded.now.valueOf() - 6 * 60_000),
        },
      },
    );
    let retrievedAccount: string | null = null;
    const base = adapter({ status: 'requires_payment_method' }, () => ({ status: 'canceled' }));
    await processPaymentReconciliation(
      db,
      {
        ...base,
        retrievePaymentIntent: (account, intent) => {
          retrievedAccount = account;
          return base.retrievePaymentIntent(account, intent);
        },
      },
      options,
      seeded.now,
    );
    expect(retrievedAccount).toBe('acct_test');
    expect(
      await db.collection('payment_attempts').findOne({ _id: seeded.attemptId }),
    ).toMatchObject({
      state: 'expired',
      slot_released: true,
    });
  });

  async function seed(input: { state: string; expired: boolean; attemptCount?: number }) {
    const now = new Date('2026-08-28T12:00:00.000Z');
    const tenantId = new ObjectId();
    const appointmentId = new ObjectId();
    const attemptId = new ObjectId();
    const accountPublicId = randomUUID();
    await db.collection('tenant_stripe_accounts').insertOne({
      tenant_id: tenantId,
      public_id: accountPublicId,
      stripe_account_id: 'acct_test',
    });
    await db.collection('appointments').insertOne({
      _id: appointmentId,
      tenant_id: tenantId,
      status: 'payment_pending',
      version: 1,
    });
    await db.collection('payment_attempts').insertOne({
      _id: attemptId,
      public_id: randomUUID(),
      tenant_id: tenantId,
      appointment_id: appointmentId,
      tenant_stripe_account_public_id: accountPublicId,
      stripe_payment_intent_id: `pi_${randomUUID().replaceAll('-', '')}`,
      stripe_payment_intent_status:
        input.state === 'processing' ? 'processing' : 'requires_payment_method',
      state: input.state,
      expires_at: new Date(now.valueOf() + (input.expired ? -1 : 900_000)),
      slot_released: false,
      claim_token: null,
      claim_started_at: null,
      attempt_count: input.attemptCount ?? 0,
      next_attempt_at: now,
      failure_category: null,
      request_id: randomUUID(),
      correlation_id: randomUUID(),
      created_at: now,
      updated_at: now,
      amount_snapshot: {
        service_price_minor: 10_000,
        provider_amount_due_now_minor: 2_500,
        booknowtech_fee_minor: 125,
        customer_total_due_now_minor: 2_625,
        application_fee_amount_minor: 125,
        remaining_service_balance_minor: 7_500,
      },
    });
    return { now, attemptId, appointmentId };
  }
});

function adapter(
  retrieved: Partial<{ status: 'requires_payment_method' | 'processing' | 'succeeded' }>,
  canceled: () => Partial<{ status: 'canceled' }> = () => ({ status: 'canceled' }),
  retrievalError?: Error,
): PaymentReconciliationStripe {
  const view = (status: string) => ({
    id: '',
    status,
    amount: 2_625,
    applicationFeeAmount: 125,
    currency: 'usd',
  });
  return {
    retrievePaymentIntent: (_account, id) => {
      if (retrievalError) throw retrievalError;
      return Promise.resolve({
        ...view(retrieved.status ?? 'requires_payment_method'),
        id,
      } as never);
    },
    cancelPaymentIntent: (_account, id) =>
      Promise.resolve({ ...view(canceled().status ?? 'canceled'), id } as never),
  };
}

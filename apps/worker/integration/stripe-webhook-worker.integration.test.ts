import { randomUUID } from 'node:crypto';
import { MongoClient, ObjectId } from 'mongodb';
import pino from 'pino';
import type Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type StripeProjection, processStripeWebhookEvent } from '../src/stripe-webhook-worker.js';

const uri = process.env.MONGODB_TEST_URI;
const suite = uri ? describe : describe.skip;
const logger = pino({ enabled: false });

suite('Stripe webhook worker transaction and ordering boundaries', () => {
  const client = new MongoClient(uri ?? 'mongodb://127.0.0.1:27017');
  const db = client.db(`booknowtech_worker_${randomUUID().replaceAll('-', '')}`);

  beforeAll(async () => client.connect());
  afterAll(async () => {
    await db.dropDatabase();
    await client.close();
  });

  it('reclaims stale work and does not process the event twice', async () => {
    const { eventId, accountId, accountObjectId } = await seed({
      processingStatus: 'processing',
      stale: true,
    });
    const reader = { retrieveAccount: () => Promise.resolve(stripeAccount(accountId)) };

    await processStripeWebhookEvent(db, reader, logger);
    await processStripeWebhookEvent(db, reader, logger);

    expect(await db.collection('stripe_webhook_events').findOne({ _id: eventId })).toMatchObject({
      processing_status: 'processed',
      attempt_count: 1,
      processing_token: null,
    });
    expect(await db.collection('audit_logs').countDocuments()).toBe(0);
    expect(
      await db.collection('tenant_stripe_accounts').findOne({ _id: accountObjectId }),
    ).toMatchObject({ version: 2 });
  });

  it('does not let an older deauthorization event override newer readiness', async () => {
    const newer = new Date('2026-08-23T12:00:02.000Z');
    const { eventId, accountObjectId } = await seed({
      eventType: 'account.application.deauthorized',
      eventCreatedAt: new Date('2026-08-23T12:00:01.000Z'),
      accountLastCreatedAt: newer,
    });

    await processStripeWebhookEvent(
      db,
      { retrieveAccount: async () => Promise.reject(new Error('must not refresh older event')) },
      logger,
    );

    expect(
      await db.collection('tenant_stripe_accounts').findOne({ _id: accountObjectId }),
    ).toMatchObject({
      active: true,
      status: 'payouts_enabled',
      last_stripe_event_created_at: newer,
    });
    expect(await db.collection('stripe_webhook_events').findOne({ _id: eventId })).toMatchObject({
      processing_status: 'processed',
    });
  });

  it('refreshes equal-timestamp ambiguous deauthorization rather than guessing', async () => {
    const createdAt = new Date('2026-08-23T12:00:00.000Z');
    const { accountId, accountObjectId } = await seed({
      eventType: 'account.application.deauthorized',
      eventCreatedAt: createdAt,
      accountLastCreatedAt: createdAt,
      accountLastEventId: 'evt_previous',
    });

    await processStripeWebhookEvent(
      db,
      {
        retrieveAccount: () =>
          Promise.resolve(stripeAccount(accountId, { payouts_enabled: false })),
      },
      logger,
    );

    expect(
      await db.collection('tenant_stripe_accounts').findOne({ _id: accountObjectId }),
    ).toMatchObject({
      active: true,
      status: 'payments_enabled',
    });
  });

  it('rolls back projection changes when ownership is lost during processing', async () => {
    const createdAt = new Date('2026-08-23T12:00:00.000Z');
    const { eventId, accountId, accountObjectId } = await seed({
      eventCreatedAt: createdAt,
      accountLastCreatedAt: createdAt,
      accountLastEventId: 'evt_previous',
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const processing = processStripeWebhookEvent(
      db,
      {
        retrieveAccount: async () => {
          await blocked;
          return stripeAccount(accountId, { payouts_enabled: false });
        },
      },
      logger,
    );
    while (
      !(await db.collection('stripe_webhook_events').findOne({ _id: eventId }))?.processing_token
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    await db
      .collection('stripe_webhook_events')
      .updateOne({ _id: eventId }, { $set: { processing_token: randomUUID() } });
    release();
    await processing;

    expect(
      await db.collection('tenant_stripe_accounts').findOne({ _id: accountObjectId }),
    ).toMatchObject({
      status: 'payouts_enabled',
      last_stripe_event_id: 'evt_previous',
    });
    expect(await db.collection('stripe_webhook_events').findOne({ _id: eventId })).toMatchObject({
      processing_status: 'processing',
    });
  });

  it('stores only an allowlisted category when Stripe refresh fails', async () => {
    const createdAt = new Date('2026-08-23T12:00:00.000Z');
    const { eventId } = await seed({
      eventCreatedAt: createdAt,
      accountLastCreatedAt: createdAt,
      accountLastEventId: 'evt_previous',
    });
    await processStripeWebhookEvent(
      db,
      { retrieveAccount: async () => Promise.reject(new Error('sk_test_do_not_store')) },
      logger,
    );
    expect(await db.collection('stripe_webhook_events').findOne({ _id: eventId })).toMatchObject({
      processing_status: 'pending',
      attempt_count: 1,
      failure_category: 'stripe_processing_failed',
    });
  });

  async function seed(
    options: {
      eventType?: string;
      processingStatus?: string;
      stale?: boolean;
      eventCreatedAt?: Date;
      accountLastCreatedAt?: Date;
      accountLastEventId?: string;
    } = {},
  ) {
    const tenantId = new ObjectId();
    const accountObjectId = new ObjectId();
    const eventId = new ObjectId();
    const accountId = `acct_${randomUUID().replaceAll('-', '')}`;
    const eventCreatedAt = options.eventCreatedAt ?? new Date('2026-08-23T12:00:01.000Z');
    await db.collection('tenant_stripe_accounts').insertOne({
      _id: accountObjectId,
      tenant_id: tenantId,
      stripe_account_id: accountId,
      status: 'payouts_enabled',
      active: true,
      last_stripe_event_id: options.accountLastEventId ?? null,
      last_stripe_event_created_at: options.accountLastCreatedAt ?? null,
      details_submitted: true,
      charges_enabled: true,
      payouts_enabled: true,
      capabilities: { card_payments: 'active', transfers: 'active' },
      requirements: projection().requirements,
      last_synced_at: null,
      disconnected_at: null,
      updated_at: new Date(),
      updated_by_source: 'test',
      version: 1,
    });
    await db.collection('stripe_webhook_events').insertOne({
      _id: eventId,
      stripe_event_id: `evt_${randomUUID().replaceAll('-', '')}`,
      stripe_account_id: accountId,
      event_type: options.eventType ?? 'account.updated',
      stripe_created_at: eventCreatedAt,
      sanitized_payload: projection(),
      processing_status: options.processingStatus ?? 'pending',
      attempt_count: 0,
      next_attempt_at: new Date(0),
      processing_started_at: options.stale ? new Date(0) : null,
      processing_token: options.stale ? randomUUID() : null,
      received_at: new Date(),
      received_request_id: randomUUID(),
      tenant_id: tenantId,
      processed_at: null,
      failure_category: null,
      updated_at: new Date(),
    });
    return { eventId, accountId, accountObjectId };
  }
});

function projection(overrides: Partial<StripeProjection> = {}): StripeProjection {
  return {
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
    ...overrides,
  };
}

function stripeAccount(id: string, overrides: Partial<StripeProjection> = {}): Stripe.Account {
  const value = projection(overrides);
  return {
    id,
    object: 'account',
    details_submitted: value.details_submitted,
    charges_enabled: value.charges_enabled,
    payouts_enabled: value.payouts_enabled,
    capabilities: value.capabilities,
    requirements: {
      ...value.requirements,
      current_deadline: value.requirements.current_deadline
        ? Math.floor(value.requirements.current_deadline.valueOf() / 1_000)
        : null,
    },
  } as Stripe.Account;
}

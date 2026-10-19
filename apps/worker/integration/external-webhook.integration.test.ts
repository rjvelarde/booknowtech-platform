import { randomUUID } from 'node:crypto';
import { MongoClient, ObjectId } from 'mongodb';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { externalAccountManifest } from '@booknowtech/shared/stripe-ownership';
import { processStripeWebhookEvent } from '../src/stripe-webhook-worker.js';
const uri = process.env.MONGODB_TEST_URI;
const suite = uri ? describe : describe.skip;
suite('external-only webhook isolation transactions', () => {
  const client = new MongoClient(uri ?? 'mongodb://127.0.0.1:27017');
  const db = client.db(`booknowtech_external_${randomUUID().replaceAll('-', '')}`);
  const logger = pino({ enabled: false });
  const rule = {
    ...externalAccountManifest[0]!,
    approvedAt: '2020-01-01T00:00:00Z',
    reviewAt: '2099-01-01T00:00:00Z',
    expiresAt: '2099-01-01T00:00:00Z',
  };
  const reader = {
    retrieveAccount: vi
      .fn()
      .mockRejectedValue(new Error('must not retrieve external connected account')),
    retrievePlatform: vi.fn().mockResolvedValue({ id: rule.platformAccountId }),
  };
  const context = { environment: 'production', manifest: [rule] };
  const forbidden = [
    'tenant_stripe_accounts',
    'stripe_connect_operations',
    'customers',
    'appointments',
    'payment_attempts',
    'payment_ledger_entries',
    'tenant_booking_fee_versions',
    'service_payment_configuration_versions',
    'notification_outbox',
  ];
  beforeAll(async () => {
    await client.connect();
    await db
      .collection('stripe_webhook_events')
      .createIndex({ stripe_event_id: 1 }, { unique: true });
  });
  beforeEach(async () => {
    for (const n of [...forbidden, 'stripe_webhook_events', 'audit_logs'])
      await db.collection(n).deleteMany({});
    vi.clearAllMocks();
    reader.retrievePlatform.mockResolvedValue({ id: rule.platformAccountId });
  });
  afterAll(async () => {
    await db.dropDatabase();
    await client.close();
  });
  async function seed(overrides: Record<string, unknown> = {}) {
    const now = new Date();
    const doc = {
      _id: new ObjectId(),
      public_id: randomUUID(),
      stripe_event_id: `evt_${randomUUID().replaceAll('-', '')}`,
      stripe_account_id: rule.accountId,
      endpoint_kind: 'connect',
      livemode: true,
      payload_hash: 'a'.repeat(64),
      tenant_id: null,
      event_type: 'payment_intent.succeeded',
      stripe_created_at: now,
      sanitized_payload: { id: 'pi_external', amount: 42800, currency: 'usd' },
      processing_status: 'pending',
      attempt_count: 0,
      next_attempt_at: now,
      processing_started_at: null,
      processing_token: null,
      processed_at: null,
      failure_category: 'unresolved_account',
      received_at: now,
      received_request_id: randomUUID(),
      updated_at: now,
      ...overrides,
    };
    await db.collection('stripe_webhook_events').insertOne(doc);
    return doc;
  }
  it.each(rule.eventTypes)(
    'preserves %s evidence and creates only an atomic versioned audit',
    async (eventType) => {
      const e = await seed({ event_type: eventType });
      await processStripeWebhookEvent(db, reader, logger, undefined, context);
      const result = await db.collection('stripe_webhook_events').findOne({ _id: e._id });
      expect(result).toMatchObject({
        processing_status: 'external',
        tenant_id: null,
        processing_token: null,
        sanitized_payload: e.sanitized_payload,
        payload_hash: e.payload_hash,
        stripe_event_id: e.stripe_event_id,
        external_disposition: {
          manifest_version: rule.version,
          evidence_reference: rule.evidenceReference,
          approved_by: rule.approvedBy,
        },
      });
      expect(
        await db.collection('audit_logs').countDocuments({
          event: 'stripe_webhook.classified_external',
          'metadata.manifest_version': rule.version,
        }),
      ).toBe(1);
      for (const name of forbidden) expect(await db.collection(name).countDocuments()).toBe(0);
      expect(reader.retrieveAccount).not.toHaveBeenCalled();
    },
  );
  it('converges concurrent processing and redelivery on one disposition and audit', async () => {
    await seed();
    await Promise.all(
      Array.from({ length: 5 }, () =>
        processStripeWebhookEvent(db, reader, logger, undefined, context),
      ),
    );
    await processStripeWebhookEvent(db, reader, logger, undefined, context);
    expect(await db.collection('audit_logs').countDocuments()).toBe(1);
    expect(
      await db
        .collection('stripe_webhook_events')
        .countDocuments({ processing_status: 'external', attempt_count: 1 }),
    ).toBe(1);
  });
  it.each([true, false])(
    'quarantines current and historical association conflicts (active=%s)',
    async (active) => {
      await seed({ attempt_count: 7 });
      await db
        .collection('tenant_stripe_accounts')
        .insertOne({ stripe_account_id: rule.accountId, active });
      await processStripeWebhookEvent(db, reader, logger, undefined, context);
      expect(await db.collection('stripe_webhook_events').findOne({})).toMatchObject({
        processing_status: 'failed',
        failure_category: 'stripe_account_ownership_conflict',
      });
      expect(await db.collection('audit_logs').countDocuments()).toBe(0);
    },
  );
  it.each(['payment_attempts', 'payment_ledger_entries', 'stripe_connect_operations'])(
    'refuses retained BookNowTech references in %s',
    async (name) => {
      await seed({ attempt_count: 7 });
      await db.collection(name).insertOne({ stripe_account_id: rule.accountId });
      await processStripeWebhookEvent(db, reader, logger, undefined, context);
      expect(await db.collection('stripe_webhook_events').findOne({})).toMatchObject({
        processing_status: 'failed',
        failure_category: 'stripe_account_ownership_conflict',
      });
    },
  );
  it('keeps unknown accounts actionable and does not inherit another event acknowledgement', async () => {
    await seed({ stripe_account_id: 'acct_unregistered', attempt_count: 7 });
    await db
      .collection('stripe_webhook_failure_acknowledgements')
      .insertOne({ stripe_event_id: 'evt_other', stripe_account_id: 'acct_unregistered' });
    await processStripeWebhookEvent(db, reader, logger, undefined, context);
    expect(await db.collection('stripe_webhook_events').findOne({})).toMatchObject({
      processing_status: 'failed',
      failure_category: 'unresolved_account',
    });
  });
  it.each(['expired', 'platform', 'mode', 'environment', 'scope', 'unverified'])(
    'fails closed for %s manifest scope',
    async (kind) => {
      const manifest = [{ ...rule }];
      const ctx = { ...context, manifest };
      if (kind === 'expired') manifest[0]!.expiresAt = '2020-01-01T00:00:00Z';
      if (kind === 'platform') reader.retrievePlatform.mockResolvedValue({ id: 'acct_wrong' });
      if (kind === 'environment') ctx.environment = 'staging';
      if (kind === 'scope') manifest[0]!.eventTypes = [];
      if (kind === 'unverified') manifest[0]!.evidenceReference = '';
      await seed({ attempt_count: 7, ...(kind === 'mode' ? { livemode: false } : {}) });
      await processStripeWebhookEvent(db, reader, logger, undefined, ctx);
      expect(await db.collection('stripe_webhook_events').findOne({})).toMatchObject({
        processing_status: 'failed',
        failure_category: 'external_ownership_unverified',
      });
      expect(await db.collection('audit_logs').countDocuments()).toBe(0);
    },
  );
  it('rolls back the external disposition if its audit cannot be persisted', async () => {
    await seed({ attempt_count: 7 });
    await db.command({
      collMod: 'audit_logs',
      validator: { forbidden: { $exists: true } },
      validationLevel: 'strict',
      validationAction: 'error',
    });
    try {
      await processStripeWebhookEvent(db, reader, logger, undefined, context);
    } finally {
      await db.command({ collMod: 'audit_logs', validator: {} });
    }
    expect(await db.collection('stripe_webhook_events').findOne({})).toMatchObject({
      processing_status: 'failed',
      failure_category: 'stripe_processing_failed',
    });
    expect(
      (await db.collection('stripe_webhook_events').findOne({}))?.external_disposition,
    ).toBeUndefined();
    expect(await db.collection('audit_logs').countDocuments()).toBe(0);
  });
  it('refuses a retained association audit even when the association record is missing', async () => {
    await seed({ attempt_count: 7 });
    await db.collection('audit_logs').insertOne({
      event: 'stripe_connect_account_created',
      metadata: { stripe_account_id: rule.accountId },
    });
    await processStripeWebhookEvent(db, reader, logger, undefined, context);
    expect(await db.collection('stripe_webhook_events').findOne({})).toMatchObject({
      processing_status: 'failed',
      failure_category: 'stripe_account_ownership_conflict',
    });
    expect(
      await db
        .collection('audit_logs')
        .countDocuments({ event: 'stripe_webhook.classified_external' }),
    ).toBe(0);
  });
  it('fails closed when authoritative platform identity is unavailable', async () => {
    await seed({ attempt_count: 7 });
    reader.retrievePlatform.mockRejectedValueOnce(new Error('timeout'));
    await processStripeWebhookEvent(db, reader, logger, undefined, context);
    expect(await db.collection('stripe_webhook_events').findOne({})).toMatchObject({
      processing_status: 'failed',
      failure_category: 'stripe_processing_failed',
    });
    expect(await db.collection('audit_logs').countDocuments()).toBe(0);
  });
});

import { createHash, randomUUID } from 'node:crypto';
import { MongoClient, ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../database/migrate.js';
import { type ConnectActor, ConnectStore } from './connect-store.js';
import { StripeWebhookStore } from './webhook-store.js';

const uri = process.env.MONGODB_TEST_URI;
const suite = uri ? describe : describe.skip;

suite('Stripe Connect persistence boundaries', () => {
  const client = new MongoClient(uri ?? 'mongodb://127.0.0.1:27017');
  const db = client.db(`booknowtech_connect_${randomUUID().replaceAll('-', '')}`);
  const store = new ConnectStore(db);
  const tenantA = new ObjectId();
  const tenantB = new ObjectId();
  const actor = (tenantId = tenantA): ConnectActor => ({
    tenantId,
    tenantPublicId: randomUUID(),
    tenantCurrency: 'USD',
    userId: new ObjectId(),
    membershipId: new ObjectId(),
    requestId: randomUUID(),
  });

  beforeAll(async () => {
    await client.connect();
    await migrateDatabase(db);
  });
  afterAll(async () => {
    await db.dropDatabase();
    await client.close();
  });

  it('keeps BookNowTech acceptance immutable, tenant-scoped, and idempotent', async () => {
    const input = {
      ...actor(),
      termsVersion: 'connect-v1',
      termsHash: 'a'.repeat(64),
      ipHash: 'b'.repeat(64),
    };
    expect((await store.acceptTerms(input)).changed).toBe(true);
    expect((await store.acceptTerms({ ...input, requestId: randomUUID() })).changed).toBe(false);
    expect(
      await db
        .collection('booknowtech_connect_terms_acceptances')
        .countDocuments({ tenant_id: tenantA }),
    ).toBe(1);
    expect((await store.status(tenantB, 'connect-v1')).termsAccepted).toBe(false);
    await expect(
      db
        .collection('booknowtech_connect_terms_acceptances')
        .updateOne({ tenant_id: tenantA }, { $set: { terms_version: null } }),
    ).rejects.toThrow();
  });

  it('replays an exact account request and rejects a mismatched fingerprint', async () => {
    const input = actor(tenantB);
    const first = await store.beginAccountOperation(input);
    const replay = await store.beginAccountOperation(input);

    expect(first.kind).toBe('operation');
    expect(replay).toMatchObject({
      kind: 'operation',
      operation: { public_id: first.kind === 'operation' ? first.operation.public_id : '' },
    });
    await expect(store.beginAccountOperation({ ...input, tenantCurrency: 'EUR' })).rejects.toThrow(
      'idempotency_conflict',
    );
    expect(
      await db.collection('stripe_connect_operations').countDocuments({ tenant_id: tenantB }),
    ).toBe(1);
    expect(
      await db.collection('audit_logs').countDocuments({
        tenant_id: tenantB,
        event: 'stripe_connect_account_create_requested',
      }),
    ).toBe(1);
  });

  it('reuses the original durable account operation across new HTTP request IDs', async () => {
    const input = actor(new ObjectId());
    const first = await store.beginAccountOperation(input);
    expect(first.kind).toBe('operation');
    if (first.kind !== 'operation') return;
    await store.failAccountOperation(input, String(first.operation.public_id));

    const retry = await store.beginAccountOperation({ ...input, requestId: randomUUID() });

    expect(retry).toMatchObject({
      kind: 'operation',
      operation: {
        public_id: first.operation.public_id,
        stripe_idempotency_key: first.operation.stripe_idempotency_key,
      },
    });
    expect(
      await db.collection('stripe_connect_operations').countDocuments({
        tenant_id: input.tenantId,
        operation_type: 'create_account',
      }),
    ).toBe(1);
  });

  it('upgrades a failed legacy account operation to the v2 idempotency namespace once', async () => {
    const input = actor(new ObjectId());
    const fingerprint = createHash('sha256')
      .update(`${input.tenantPublicId}|express|US|${input.tenantCurrency}`)
      .digest('hex');
    const legacy = {
      public_id: randomUUID(),
      tenant_id: input.tenantId,
      request_id: randomUUID(),
      operation_type: 'create_account',
      request_fingerprint: fingerprint,
      stripe_idempotency_key: `bnt_connect_${input.tenantPublicId}`,
      status: 'failed',
      stripe_account_id: null,
      result_reference: null,
      failure_category: 'stripe_request_failed',
      created_by_user_id: input.userId,
      created_at: new Date(),
      completed_at: new Date(),
    };
    await db.collection('stripe_connect_operations').insertOne(legacy);

    const first = await store.beginAccountOperation(input);
    const retry = await store.beginAccountOperation({ ...input, requestId: randomUUID() });

    expect(first).toMatchObject({
      kind: 'operation',
      operation: { stripe_idempotency_key: `bnt_connect_v2_${input.tenantPublicId}` },
    });
    expect(retry).toMatchObject({
      kind: 'operation',
      operation: { stripe_idempotency_key: `bnt_connect_v2_${input.tenantPublicId}` },
    });
    expect(
      await db.collection('audit_logs').countDocuments({
        tenant_id: input.tenantId,
        event: 'stripe_connect_account_idempotency_namespace_upgraded',
      }),
    ).toBe(1);
  });

  it('deduplicates globally unique webhook IDs without crossing tenant account context', async () => {
    await db.collection('tenant_stripe_accounts').insertOne({
      public_id: randomUUID(),
      tenant_id: tenantA,
      stripe_account_id: 'acct_tenantA',
      account_type: 'express',
      country: 'US',
      default_currency: 'USD',
      status: 'onboarding_started',
      active: true,
      details_submitted: false,
      charges_enabled: false,
      payouts_enabled: false,
      capabilities: { card_payments: 'pending', transfers: 'pending' },
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
      connected_at: new Date(),
      disconnected_at: null,
      created_at: new Date(),
      created_by_user_id: new ObjectId(),
      updated_at: new Date(),
      updated_by_source: 'user',
      version: 1,
    });
    const webhookStore = new StripeWebhookStore(db);
    const event = {
      id: 'evt_global_once',
      type: 'account.updated',
      account: 'acct_tenantA',
      created: new Date(),
      apiVersion: '2025-01-01',
      livemode: false,
      accountView: null,
    };
    expect(
      (
        await webhookStore.ingest({
          event,
          endpointKind: 'connect',
          requestId: randomUUID(),
          payloadHash: 'c'.repeat(64),
        })
      ).duplicate,
    ).toBe(false);
    expect(
      (
        await webhookStore.ingest({
          event,
          endpointKind: 'connect',
          requestId: randomUUID(),
          payloadHash: 'c'.repeat(64),
        })
      ).duplicate,
    ).toBe(true);
    expect(
      await db
        .collection('stripe_webhook_events')
        .countDocuments({ stripe_event_id: event.id, tenant_id: tenantA }),
    ).toBe(1);
  });
});

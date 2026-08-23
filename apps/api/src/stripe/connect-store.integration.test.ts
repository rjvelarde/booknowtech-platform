import { randomUUID } from 'node:crypto';
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

  it('deduplicates globally unique webhook IDs without crossing tenant account context', async () => {
    await db.collection('tenant_stripe_accounts').insertOne({
      public_id: randomUUID(),
      tenant_id: tenantA,
      stripe_account_id: 'acct_tenant_a',
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
      account: 'acct_tenant_a',
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

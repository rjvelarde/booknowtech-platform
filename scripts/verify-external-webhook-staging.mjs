import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

import { externalAccountManifest } from '../apps/shared/dist/stripe-ownership.js';
import { migrateDatabase } from '../apps/api/dist/database/migrate.js';
import { MongoMonitoringReader } from '../apps/api/dist/monitoring/store.js';
import { registerMonitoringRoute } from '../apps/api/dist/monitoring/routes.js';
import { StripeSdkConnectAdapter } from '../apps/api/dist/stripe/adapter.js';
import { accountDocument } from '../apps/api/dist/stripe/connect-store.js';
import { registerStripeWebhookRoutes } from '../apps/api/dist/stripe/webhook-routes.js';
import { StripeWebhookStore } from '../apps/api/dist/stripe/webhook-store.js';
import { processStripeWebhookEvent } from '../apps/worker/dist/stripe-webhook-worker.js';

// This is an isolated in-process staging harness, not a webhook sender to production.
assert.equal(process.env.ENVIRONMENT_ID, 'staging');
assert.equal(process.env.MONGODB_DATABASE, 'booknowtech_staging');
assert.equal(process.env.BNT_STAGING_EXTERNAL_QA_APPROVED, 'true');
assert.ok(process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_'));
assert.ok(process.env.STRIPE_CONNECT_WEBHOOK_SECRET);
const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const Fastify = require('fastify');
const Stripe = require('stripe');
const { MongoClient, ObjectId } = require('mongodb');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const platform = await stripe.accounts.retrieve(); // GET /v1/account, no Stripe-Account header
const client = new MongoClient(process.env.MONGODB_URI);
const prefix = `bnt_extqa_${randomUUID().replaceAll('-', '').slice(0, 16)}_`;
const rawDb = client.db('booknowtech_staging');
// Scope every collection/validator/index/lookup to this harness prefix; never migrate service collections.
const db = new Proxy(rawDb, {
  get(target, property) {
    if (property === 'collection')
      return (name) => {
        const collection = target.collection(prefix + name);
        return new Proxy(collection, {
          get(c, key) {
            if (key === 'aggregate')
              return (pipeline, options) =>
                c.aggregate(
                  pipeline.map((stage) =>
                    stage.$lookup
                      ? {
                          ...stage,
                          $lookup: { ...stage.$lookup, from: prefix + stage.$lookup.from },
                        }
                      : stage,
                  ),
                  options,
                );
            const value = Reflect.get(c, key);
            return typeof value === 'function' ? value.bind(c) : value;
          },
        });
      };
    if (property === 'createCollection')
      return (name, options) => target.createCollection(prefix + name, options);
    if (property === 'command')
      return (command) => {
        assert.equal(typeof command.collMod, 'string');
        return target.command({ ...command, collMod: prefix + command.collMod });
      };
    if (property === 'listCollections')
      return () => ({
        toArray: async () =>
          (
            await target
              .listCollections({ name: { $regex: `^${prefix}` } }, { nameOnly: true })
              .toArray()
          ).map((row) => ({ ...row, name: row.name.slice(prefix.length) })),
      });
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
const sha = process.env.BNT_QA_SOURCE_SHA;
assert.match(sha ?? '', /^[a-f0-9]{40}$/u);
const now = new Date();
const rule = {
  ...externalAccountManifest[0],
  version: 'staging-fixture-only-v1',
  environment: 'staging',
  livemode: false,
  platformAccountId: platform.id,
  evidenceReference: 'synthetic-staging-harness-only-not-production-ownership',
  approvedAt: new Date(now.valueOf() - 60_000).toISOString(),
  reviewAt: new Date(now.valueOf() + 3_600_000).toISOString(),
  expiresAt: new Date(now.valueOf() + 3_600_000).toISOString(),
};
const environment = {
  ENVIRONMENT_ID: 'staging',
  BUILD_VERSION: sha,
  STRIPE_CONNECT_WEBHOOK_SECRET: process.env.STRIPE_CONNECT_WEBHOOK_SECRET,
  MONITORING_TOKEN: process.env.MONITORING_TOKEN,
};
const app = Fastify({ logger: false });
const reader = {
  retrievePlatform: async () => ({ id: platform.id }),
  retrieveAccount: async () => {
    throw Error('unexpected_account_retrieval');
  },
};
const logger = { info() {}, warn() {}, error() {} };
try {
  await client.connect();
  await migrateDatabase(db);
  registerStripeWebhookRoutes(
    app,
    environment,
    new StripeSdkConnectAdapter(process.env.STRIPE_SECRET_KEY),
    new StripeWebhookStore(db),
  );
  registerMonitoringRoute(app, environment, new MongoMonitoringReader(db));
  await app.ready();
  await db.collection('service_heartbeats').insertOne({
    service: 'worker',
    instance_id: randomUUID(),
    expires_at: new Date(Date.now() + 3600000),
    environment: 'staging',
    commit_sha: sha,
    observed_at: new Date(),
  });
  const registeredId = 'acct_qaRegistered';
  const view = {
    id: registeredId,
    livemode: false,
    detailsSubmitted: true,
    chargesEnabled: true,
    payoutsEnabled: true,
    capabilities: { cardPayments: 'active', transfers: 'active' },
    requirements: {
      currentlyDue: [],
      eventuallyDue: [],
      pastDue: [],
      pendingVerification: [],
      disabledReason: null,
      currentDeadline: null,
    },
  };
  await db
    .collection('tenant_stripe_accounts')
    .insertOne(
      accountDocument(
        { tenantId: new ObjectId(), tenantCurrency: 'USD', userId: new ObjectId() },
        view,
      ),
    );
  const forbidden = [
    'customers',
    'appointments',
    'payment_attempts',
    'payment_ledger_entries',
    'tenant_booking_fee_versions',
    'service_payment_configuration_versions',
  ];
  function event(account, type = 'payment_intent.succeeded') {
    return {
      id: `evt_${randomUUID().replaceAll('-', '')}`,
      object: 'event',
      type,
      account,
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      api_version: '2025-12-15.clover',
      data: {
        object:
          type === 'account.updated'
            ? {
                object: 'account',
                id: account,
                details_submitted: true,
                charges_enabled: true,
                payouts_enabled: true,
                capabilities: { card_payments: 'active', transfers: 'active' },
                requirements: {},
              }
            : {
                object: 'payment_intent',
                id: 'pi_qaExternal',
                status: 'succeeded',
                amount: 42800,
                application_fee_amount: 5000,
                currency: 'usd',
              },
      },
    };
  }
  async function send(e, invalidSignature = false) {
    const payload = JSON.stringify(e);
    const signature = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: environment.STRIPE_CONNECT_WEBHOOK_SECRET,
    });
    return app.inject({
      method: 'POST',
      url: '/webhooks/stripe/connect',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': invalidSignature ? 'invalid' : signature,
      },
      payload,
    });
  }
  const external = event(rule.accountId);
  assert.equal((await send(external, true)).statusCode, 400);
  assert.equal((await send({ ...external, livemode: true })).statusCode, 400);
  const concurrent = await Promise.all(Array.from({ length: 5 }, () => send(external)));
  assert.ok(concurrent.every((r) => r.statusCode === 200));
  assert.equal((await send({ ...external, created: external.created + 1 })).statusCode, 400);
  await processStripeWebhookEvent(db, reader, logger, undefined, {
    environment: 'staging',
    manifest: [rule],
  });
  const row = await db
    .collection('stripe_webhook_events')
    .findOne({ stripe_event_id: external.id });
  assert.equal(row.processing_status, 'external');
  assert.equal(row.external_disposition.manifest_version, rule.version);
  assert.equal(
    await db
      .collection('audit_logs')
      .countDocuments({ event: 'stripe_webhook.classified_external' }),
    1,
  );
  for (const name of forbidden) assert.equal(await db.collection(name).countDocuments(), 0);
  const registered = event(registeredId, 'account.updated');
  assert.equal((await send(registered)).statusCode, 200);
  await processStripeWebhookEvent(db, reader, logger, undefined, {
    environment: 'staging',
    manifest: [rule],
  });
  assert.equal(
    (await db.collection('stripe_webhook_events').findOne({ stripe_event_id: registered.id }))
      .processing_status,
    'processed',
  );
  const monitor = () =>
    app.inject({
      method: 'GET',
      url: '/api/internal/monitoring',
      headers: { authorization: `Bearer ${environment.MONITORING_TOKEN}` },
    });
  const healthy = await monitor();
  assert.equal(healthy.statusCode, 200);
  assert.equal(healthy.json().data.stripe_webhooks.external_count, 1);
  const unknown = event('acct_qaUnknown');
  assert.equal((await send(unknown)).statusCode, 200);
  await db
    .collection('stripe_webhook_events')
    .updateOne({ stripe_event_id: unknown.id }, { $set: { attempt_count: 7 } });
  await processStripeWebhookEvent(db, reader, logger, undefined, {
    environment: 'staging',
    manifest: [rule],
  });
  const unhealthy = await monitor();
  assert.equal(unhealthy.statusCode, 503);
  assert.equal(unhealthy.json().data.stripe_webhooks.failed_count, 1);
  // The actual production-only rule must not classify staging/test traffic.
  const outside = event(rule.accountId);
  assert.equal((await send(outside)).statusCode, 200);
  await db
    .collection('stripe_webhook_events')
    .updateOne({ stripe_event_id: outside.id }, { $set: { attempt_count: 7 } });
  await processStripeWebhookEvent(db, reader, logger, undefined, { environment: 'staging' });
  assert.equal(
    (await db.collection('stripe_webhook_events').findOne({ stripe_event_id: outside.id }))
      .failure_category,
    'external_ownership_unverified',
  );
  for (const name of forbidden) assert.equal(await db.collection(name).countDocuments(), 0);
  assert.equal(await db.collection('tenant_stripe_accounts').countDocuments(), 1);
  console.log(
    JSON.stringify({
      checked_at: new Date(),
      sha,
      scope: 'isolated-staging-prefixed-collections-harness',
      synthetic_rule: rule.version,
      production_manifest_staging_rejected: true,
      signature_mode_hash_concurrency: 'PASS',
      external_disposition_and_audit: 'PASS',
      registered_lifecycle: 'PASS',
      healthy_monitoring_http: healthy.statusCode,
      unknown_account_monitoring_http: unhealthy.statusCode,
      financial_records: 0,
      stripe_writes: 0,
      staging_service_data_modified: false,
    }),
  );
} finally {
  await app.close();
  // Remove only collections with this invocation's unique prefix, never the staging database.
  assert.match(prefix, /^bnt_extqa_[a-f0-9]{16}_$/u);
  for (const { name } of await rawDb
    .listCollections({ name: { $regex: `^${prefix}` } }, { nameOnly: true })
    .toArray()) {
    assert.ok(name.startsWith(prefix));
    await rawDb.collection(name).drop();
  }
  await client.close();
}

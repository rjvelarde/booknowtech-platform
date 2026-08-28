import { randomUUID } from 'node:crypto';

import { MongoClient, ObjectId } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { acknowledgeTerminalWebhookFailure } from './failure-acknowledgement.js';
import { MongoMonitoringReader } from './store.js';

const uri = process.env.MONGODB_TEST_URI;
const suite = uri ? describe : describe.skip;

suite('Mongo monitoring reader', () => {
  const client = new MongoClient(uri ?? 'mongodb://127.0.0.1:27017');
  const databaseName = `booknowtech_monitoring_${randomUUID().replaceAll('-', '')}`;
  const db = client.db(databaseName);
  const now = new Date('2026-08-16T20:00:00.000Z');

  beforeAll(async () => {
    await client.connect();
    await db
      .collection('service_heartbeats')
      .createIndex(
        { service: 1, environment: 1, observed_at: -1 },
        { name: 'service_heartbeats_freshness' },
      );
    await db.collection('notification_outbox').createIndexes([
      { key: { status: 1, created_at: 1 }, name: 'notification_outbox_monitor_pending' },
      {
        key: { status: 1, processing_started_at: 1 },
        name: 'notification_outbox_monitor_processing',
      },
      { key: { status: 1, failed_at: 1 }, name: 'notification_outbox_monitor_failed' },
    ]);
    await db
      .collection('stripe_webhook_events')
      .createIndex(
        { processing_status: 1, next_attempt_at: 1, received_at: 1 },
        { name: 'stripe_webhook_events_worker_poll' },
      );
    await db
      .collection('stripe_webhook_failure_acknowledgements')
      .createIndex({ stripe_webhook_event_id: 1 }, { unique: true });
    await db
      .collection('payment_attempts')
      .createIndex(
        { state: 1, failure_category: 1, updated_at: 1 },
        { name: 'payment_attempts_operations_monitor' },
      );
  });

  beforeEach(async () => {
    await Promise.all([
      db.collection('service_heartbeats').deleteMany({}),
      db.collection('notification_outbox').deleteMany({}),
      db.collection('stripe_webhook_events').deleteMany({}),
      db.collection('stripe_webhook_failure_acknowledgements').deleteMany({}),
      db.collection('payment_attempts').deleteMany({}),
      db.collection('audit_logs').deleteMany({}),
    ]);
  });

  afterAll(async () => {
    await db.dropDatabase();
    await client.close();
  });

  it('returns only the freshest environment heartbeat and bounded aggregate values', async () => {
    await db.collection('service_heartbeats').insertMany([
      {
        service: 'worker',
        environment: 'staging',
        commit_sha: 'a'.repeat(40),
        observed_at: new Date(now.valueOf() - 70_000),
      },
      {
        service: 'worker',
        environment: 'staging',
        commit_sha: 'b'.repeat(40),
        observed_at: new Date(now.valueOf() - 10_000),
      },
      {
        service: 'worker',
        environment: 'production',
        commit_sha: 'c'.repeat(40),
        observed_at: now,
      },
    ]);
    await db.collection('notification_outbox').insertMany([
      { status: 'pending', created_at: new Date(now.valueOf() - 120_000) },
      { status: 'pending', created_at: new Date(now.valueOf() - 30_000) },
      { status: 'processing', processing_started_at: new Date(now.valueOf() - 60_000) },
      { status: 'failed', failed_at: new Date(now.valueOf() - 10 * 60_000) },
      { status: 'failed', failed_at: new Date(now.valueOf() - 60 * 60_000) },
      { status: 'failed', failed_at: new Date(now.valueOf() - 25 * 60 * 60_000) },
    ]);
    await db.collection('stripe_webhook_events').insertMany([
      {
        processing_status: 'pending',
        next_attempt_at: now,
        received_at: new Date(now.valueOf() - 45_000),
      },
      { processing_status: 'processing', received_at: new Date(now.valueOf() - 20_000) },
      { processing_status: 'failed', received_at: new Date(now.valueOf() - 10_000) },
    ]);
    await db.collection('payment_attempts').insertMany([
      {
        state: 'manual_review',
        failure_category: 'local_finalization',
        updated_at: new Date(now.valueOf() - 90_000),
      },
      {
        state: 'manual_review',
        failure_category: 'unknown',
        updated_at: new Date(now.valueOf() - 30_000),
      },
    ]);

    const result = await new MongoMonitoringReader(db).read('staging', now);

    expect(result).toEqual({
      worker: {
        service: 'worker',
        environment: 'staging',
        commit_sha: 'b'.repeat(40),
        observed_at: new Date(now.valueOf() - 10_000),
      },
      pendingCount: 2,
      oldestPendingAt: new Date(now.valueOf() - 120_000),
      processingCount: 1,
      oldestProcessingAt: new Date(now.valueOf() - 60_000),
      terminalFailed15m: 1,
      terminalFailed24h: 2,
      stripePendingCount: 1,
      stripeOldestPendingAt: new Date(now.valueOf() - 45_000),
      stripeProcessingCount: 1,
      stripeFailedCount: 1,
      stripeHistoricalTerminalFailedCount: 0,
      paymentManualReviewCount: 2,
      paymentOldestManualReviewAt: new Date(now.valueOf() - 90_000),
      paymentFinalizationFailureCount: 1,
      paymentExpiryCandidateCount: 0,
      paymentReconciliationPendingCount: 0,
      paymentReconciliationProcessingCount: 0,
      paymentSucceededUnfinalizedCount: 0,
      paymentOldestSucceededUnfinalizedAt: null,
      paymentRetryExhaustedCount: 0,
    });
  });

  it('preserves acknowledged terminal evidence while excluding it from actionable failures', async () => {
    const historicalId = new ObjectId();
    const historical = {
      _id: historicalId,
      public_id: randomUUID(),
      stripe_event_id: 'evt_historicalterminal',
      processing_status: 'failed',
      attempt_count: 8,
      processing_started_at: null,
      processed_at: null,
      failure_category: 'unresolved_account',
      received_at: new Date(now.valueOf() - 7 * 86_400_000),
      updated_at: new Date(now.valueOf() - 7 * 86_400_000),
    };
    const actionable = {
      ...historical,
      _id: new ObjectId(),
      public_id: randomUUID(),
      stripe_event_id: 'evt_currentactionable',
      received_at: now,
      updated_at: now,
    };
    await db.collection('stripe_webhook_events').insertMany([historical, actionable]);
    const before = await db.collection('stripe_webhook_events').findOne({ _id: historicalId });
    await acknowledgeTerminalWebhookFailure({
      client,
      database: db,
      stripeEventId: historical.stripe_event_id,
      operatorId: 'booknowtech-operator',
      reason: 'Reviewed historical pre-association event; no tenant attribution is authorized.',
      requestId: randomUUID(),
    });
    const after = await db.collection('stripe_webhook_events').findOne({ _id: historicalId });
    expect(after).toEqual(before);
    expect(
      await db.collection('audit_logs').countDocuments({
        event: 'stripe_webhook_failure.acknowledged_non_actionable',
      }),
    ).toBe(1);

    const result = await new MongoMonitoringReader(db).read('staging', now);
    expect(result.stripeFailedCount).toBe(1);
    expect(result.stripeHistoricalTerminalFailedCount).toBe(1);
  });

  it('refuses acknowledgement unless the original evidence is terminal and failed', async () => {
    await db.collection('stripe_webhook_events').insertOne({
      _id: new ObjectId(),
      public_id: randomUUID(),
      stripe_event_id: 'evt_retryablepending',
      processing_status: 'pending',
      attempt_count: 3,
      processing_started_at: null,
      processed_at: null,
      failure_category: 'unresolved_account',
    });
    await expect(
      acknowledgeTerminalWebhookFailure({
        client,
        database: db,
        stripeEventId: 'evt_retryablepending',
        operatorId: 'booknowtech-operator',
        reason: 'This must be rejected because the event remains retryable.',
        requestId: randomUUID(),
      }),
    ).rejects.toThrow('webhook_failure_not_terminal');
    expect(await db.collection('stripe_webhook_failure_acknowledgements').countDocuments()).toBe(0);
  });

  it('uses the named heartbeat and outbox indexes for the bounded query shapes', async () => {
    const heartbeatPlan = await db
      .collection('service_heartbeats')
      .find({ service: 'worker', environment: 'staging' })
      .sort({ observed_at: -1 })
      .limit(1)
      .explain('queryPlanner');
    const pendingPlan = await db
      .collection('notification_outbox')
      .find({ status: 'pending' })
      .sort({ created_at: 1 })
      .limit(1)
      .explain('queryPlanner');
    const processingPlan = await db
      .collection('notification_outbox')
      .find({ status: 'processing' })
      .sort({ processing_started_at: 1 })
      .limit(1)
      .explain('queryPlanner');
    const failedPlan = await db
      .collection('notification_outbox')
      .find({ status: 'failed', failed_at: { $gte: new Date(now.valueOf() - 24 * 60 * 60_000) } })
      .explain('queryPlanner');
    const plans = JSON.stringify([heartbeatPlan, pendingPlan, processingPlan, failedPlan]);

    expect(plans).toContain('service_heartbeats_freshness');
    expect(plans).toContain('notification_outbox_monitor_pending');
    expect(plans).toContain('notification_outbox_monitor_processing');
    expect(plans).toContain('notification_outbox_monitor_failed');
    expect(plans).not.toContain('COLLSCAN');
  });
});

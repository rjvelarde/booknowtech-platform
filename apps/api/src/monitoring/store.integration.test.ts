import { randomUUID } from 'node:crypto';

import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
      .collection('payment_attempts')
      .createIndex(
        { state: 1, failure_category: 1, updated_at: 1 },
        { name: 'payment_attempts_operations_monitor' },
      );
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
      paymentManualReviewCount: 2,
      paymentOldestManualReviewAt: new Date(now.valueOf() - 90_000),
      paymentFinalizationFailureCount: 1,
    });
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

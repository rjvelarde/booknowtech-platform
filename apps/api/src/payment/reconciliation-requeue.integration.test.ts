import { randomUUID } from 'node:crypto';
import { MongoClient, ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { requeuePaymentReconciliation } from './reconciliation-requeue.js';

const uri = process.env.MONGODB_TEST_URI;
const suite = uri ? describe : describe.skip;

suite('operator payment reconciliation requeue', () => {
  const client = new MongoClient(uri ?? 'mongodb://127.0.0.1:27017');
  const db = client.db(`booknowtech_requeue_${randomUUID().replaceAll('-', '')}`);
  beforeAll(async () => {
    await client.connect();
    await db
      .collection('payment_reconciliation_requeues')
      .createIndex({ request_id: 1 }, { unique: true });
  });
  afterAll(async () => {
    await db.dropDatabase();
    await client.close();
  });

  it('is audited, idempotent, and cannot rewrite financial evidence', async () => {
    const attemptId = new ObjectId();
    const attemptPublicId = randomUUID();
    const tenantId = new ObjectId();
    await db.collection('payment_attempts').insertOne({
      _id: attemptId,
      public_id: attemptPublicId,
      tenant_id: tenantId,
      state: 'manual_review',
      slot_released: false,
      claim_token: null,
      claim_started_at: null,
      attempt_count: 5,
      next_attempt_at: new Date(),
      failure_category: 'local_finalization',
    });
    await db.collection('payment_ledger_entries').insertOne({
      _id: new ObjectId(),
      payment_attempt_id: attemptId,
      entry_kind: 'payment_succeeded',
      immutable: true,
    });
    const input = {
      client,
      database: db,
      attemptPublicId,
      operatorId: 'booknowtech-operator',
      reason: 'Human investigation approved one bounded recovery retry.',
      requestId: randomUUID(),
      environment: 'staging' as const,
    };
    expect(await requeuePaymentReconciliation(input)).toMatchObject({ outcome: 'requeued' });
    expect(await requeuePaymentReconciliation(input)).toMatchObject({
      outcome: 'already_requeued',
    });
    expect(await db.collection('payment_attempts').findOne({ _id: attemptId })).toMatchObject({
      state: 'manual_review',
      slot_released: false,
      attempt_count: 0,
      reconciliation_requeue_request_id: input.requestId,
    });
    expect(
      await db.collection('payment_ledger_entries').findOne({ payment_attempt_id: attemptId }),
    ).toMatchObject({ entry_kind: 'payment_succeeded', immutable: true });
    expect(
      await db
        .collection('audit_logs')
        .countDocuments({ event: 'payment_reconciliation.requeued', request_id: input.requestId }),
    ).toBe(1);
    await expect(
      requeuePaymentReconciliation({
        ...input,
        reason: 'A materially different investigation reason.',
      }),
    ).rejects.toThrow('payment_reconciliation_requeue_request_conflict');
  });

  it('cannot fabricate recovery eligibility for released or non-manual attempts', async () => {
    for (const document of [
      { state: 'succeeded', slot_released: false },
      { state: 'manual_review', slot_released: true },
    ]) {
      const attemptPublicId = randomUUID();
      await db.collection('payment_attempts').insertOne({
        _id: new ObjectId(),
        public_id: attemptPublicId,
        tenant_id: new ObjectId(),
        claim_token: null,
        claim_started_at: null,
        ...document,
      });
      await expect(
        requeuePaymentReconciliation({
          client,
          database: db,
          attemptPublicId,
          operatorId: 'booknowtech-operator',
          reason: 'Human investigation approved one bounded recovery retry.',
          requestId: randomUUID(),
          environment: 'staging',
        }),
      ).rejects.toThrow('payment_reconciliation_requeue_ineligible');
    }
  });
});

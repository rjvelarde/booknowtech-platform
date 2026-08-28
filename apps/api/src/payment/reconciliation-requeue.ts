import { randomUUID } from 'node:crypto';
import { type Db, type MongoClient, ObjectId } from 'mongodb';

interface RequeueAttempt {
  _id: ObjectId;
  public_id: string;
  tenant_id: ObjectId;
  state: string;
  slot_released: boolean;
  claim_token: string | null;
}

export async function requeuePaymentReconciliation(input: {
  client: MongoClient;
  database: Db;
  attemptPublicId: string;
  operatorId: string;
  reason: string;
  requestId: string;
  environment: 'staging' | 'production';
}) {
  const session = input.client.startSession();
  try {
    return await session.withTransaction(async () => {
      const requeues = input.database.collection('payment_reconciliation_requeues');
      const existing = await requeues.findOne({ request_id: input.requestId }, { session });
      if (existing) {
        if (
          existing.payment_attempt_public_id !== input.attemptPublicId ||
          existing.operator_id !== input.operatorId ||
          existing.reason !== input.reason
        )
          throw new Error('payment_reconciliation_requeue_request_conflict');
        return { outcome: 'already_requeued', payment_attempt_public_id: input.attemptPublicId };
      }
      const attempt = await input.database
        .collection<RequeueAttempt>('payment_attempts')
        .findOne({ public_id: input.attemptPublicId }, { session });
      if (!attempt) throw new Error('payment_attempt_not_found');
      if (attempt.state !== 'manual_review' || attempt.slot_released !== false)
        throw new Error('payment_reconciliation_requeue_ineligible');
      if (attempt.claim_token !== null) throw new Error('payment_reconciliation_claim_active');
      const now = new Date();
      await requeues.insertOne(
        {
          _id: new ObjectId(),
          public_id: randomUUID(),
          payment_attempt_id: attempt._id,
          payment_attempt_public_id: attempt.public_id,
          tenant_id: attempt.tenant_id,
          operator_id: input.operatorId,
          reason: input.reason,
          request_id: input.requestId,
          environment: input.environment,
          created_at: now,
        },
        { session },
      );
      const updated = await input.database.collection<RequeueAttempt>('payment_attempts').updateOne(
        { _id: attempt._id, state: 'manual_review', slot_released: false, claim_token: null },
        {
          $set: {
            attempt_count: 0,
            next_attempt_at: now,
            claim_started_at: null,
            reconciliation_requeue_request_id: input.requestId,
            updated_at: now,
          },
        },
        { session },
      );
      if (updated.modifiedCount !== 1) throw new Error('payment_reconciliation_requeue_conflict');
      await input.database.collection('audit_logs').insertOne(
        {
          public_id: randomUUID(),
          event: 'payment_reconciliation.requeued',
          outcome: 'success',
          actor_user_id: null,
          tenant_id: attempt.tenant_id,
          request_id: input.requestId,
          metadata: {
            operator_id: input.operatorId,
            reason: input.reason,
            payment_attempt_public_id: attempt.public_id,
          },
          created_at: now,
        },
        { session },
      );
      return { outcome: 'requeued', payment_attempt_public_id: input.attemptPublicId };
    });
  } finally {
    await session.endSession();
  }
}

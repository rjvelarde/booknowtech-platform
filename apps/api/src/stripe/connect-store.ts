import { createHash, randomUUID } from 'node:crypto';
import { type ClientSession, type Db, MongoServerError, type ObjectId } from 'mongodb';

import type { ConnectAccountView } from './adapter.js';

export interface ConnectActor {
  tenantId: ObjectId;
  tenantPublicId: string;
  tenantCurrency: string;
  userId: ObjectId;
  membershipId: ObjectId;
  requestId: string;
}

export class ConnectStore {
  public constructor(private readonly db: Db) {}

  public async status(tenantId: ObjectId, termsVersion: string) {
    const [acceptance, account] = await Promise.all([
      this.db
        .collection('booknowtech_connect_terms_acceptances')
        .findOne({ tenant_id: tenantId, terms_version: termsVersion }),
      this.db.collection('tenant_stripe_accounts').findOne({ tenant_id: tenantId, active: true }),
    ]);
    return { termsAccepted: acceptance !== null, account };
  }

  public async acceptTerms(
    input: ConnectActor & { termsVersion: string; termsHash: string; ipHash: string },
  ) {
    const acceptances = this.db.collection('booknowtech_connect_terms_acceptances');
    const existing = await acceptances.findOne({
      tenant_id: input.tenantId,
      terms_version: input.termsVersion,
    });
    if (existing) return { changed: false, record: existing };
    const now = new Date();
    const record = {
      public_id: randomUUID(),
      tenant_id: input.tenantId,
      terms_version: input.termsVersion,
      accepted_at: now,
      accepted_by_user_id: input.userId,
      accepted_by_membership_id: input.membershipId,
      accepted_request_id: input.requestId,
      accepted_ip_hash: input.ipHash,
      acceptance_text_hash: input.termsHash,
      created_at: now,
    };
    const session = this.db.client.startSession();
    try {
      try {
        await session.withTransaction(async () => {
          await acceptances.insertOne(record, { session });
          await this.audit(
            input,
            'booknowtech_connect_terms_accepted',
            { terms_version: input.termsVersion },
            session,
          );
        });
        return { changed: true, record };
      } catch (error) {
        if (!(error instanceof MongoServerError && error.code === 11000)) throw error;
        return {
          changed: false,
          record: await acceptances.findOne({
            tenant_id: input.tenantId,
            terms_version: input.termsVersion,
          }),
        };
      }
    } finally {
      await session.endSession();
    }
  }

  public hasTerms(tenantId: ObjectId, termsVersion: string): Promise<boolean> {
    return this.db
      .collection('booknowtech_connect_terms_acceptances')
      .findOne({ tenant_id: tenantId, terms_version: termsVersion })
      .then(Boolean);
  }

  public activeAccount(tenantId: ObjectId) {
    return this.db
      .collection('tenant_stripe_accounts')
      .findOne({ tenant_id: tenantId, active: true });
  }

  public async beginAccountOperation(input: ConnectActor) {
    const fingerprint = createHash('sha256')
      .update(`${input.tenantPublicId}|express|US|${input.tenantCurrency}`)
      .digest('hex');
    const operationKey = {
      tenant_id: input.tenantId,
      request_id: input.requestId,
      operation_type: 'create_account',
    };
    const existingOperation = await this.db
      .collection('stripe_connect_operations')
      .findOne(operationKey);
    if (existingOperation) {
      if (existingOperation.request_fingerprint !== fingerprint)
        throw new Error('idempotency_conflict');
      return { kind: 'operation' as const, operation: existingOperation };
    }
    const existingAccount = await this.activeAccount(input.tenantId);
    if (existingAccount) return { kind: 'account' as const, account: existingAccount };
    const operation = {
      public_id: randomUUID(),
      tenant_id: input.tenantId,
      request_id: input.requestId,
      operation_type: 'create_account',
      request_fingerprint: fingerprint,
      stripe_idempotency_key: `bnt_connect_${input.tenantPublicId}`,
      status: 'pending',
      stripe_account_id: null,
      result_reference: null,
      failure_category: null,
      created_by_user_id: input.userId,
      created_at: new Date(),
      completed_at: null,
    };
    const session = this.db.client.startSession();
    try {
      await session.withTransaction(async () => {
        await this.db.collection('stripe_connect_operations').insertOne(operation, { session });
        await this.audit(input, 'stripe_connect_account_create_requested', {}, session);
      });
    } catch (error) {
      if (!(error instanceof MongoServerError && error.code === 11000)) throw error;
      const existing = await this.db.collection('stripe_connect_operations').findOne(operationKey);
      if (!existing || existing.request_fingerprint !== fingerprint)
        throw new Error('idempotency_conflict', { cause: error });
      return { kind: 'operation' as const, operation: existing };
    } finally {
      await session.endSession();
    }
    return { kind: 'operation' as const, operation };
  }

  public async completeAccount(
    input: ConnectActor,
    operationPublicId: string,
    view: ConnectAccountView,
  ) {
    const now = new Date();
    const account = accountDocument(input, view, now);
    const session = this.db.client.startSession();
    try {
      await session.withTransaction(async () => {
        await this.db
          .collection('tenant_stripe_accounts')
          .updateOne(
            { tenant_id: input.tenantId, active: true },
            { $setOnInsert: account },
            { upsert: true, session },
          );
        await this.db.collection('stripe_connect_operations').updateOne(
          { public_id: operationPublicId, tenant_id: input.tenantId },
          {
            $set: {
              status: 'completed',
              stripe_account_id: view.id,
              result_reference: account.public_id,
              completed_at: now,
            },
          },
          { session },
        );
        await this.audit(
          input,
          'stripe_connect_account_created',
          { stripe_account_id: view.id },
          session,
        );
      });
      return this.activeAccount(input.tenantId);
    } finally {
      await session.endSession();
    }
  }

  public async recordAccountLink(input: ConnectActor, accountPublicId: string, accountId: string) {
    const session = this.db.client.startSession();
    try {
      await session.withTransaction(async () => {
        await this.db.collection('stripe_connect_operations').insertOne(
          {
            public_id: randomUUID(),
            tenant_id: input.tenantId,
            request_id: input.requestId,
            operation_type: 'create_account_link',
            request_fingerprint: createHash('sha256').update(accountPublicId).digest('hex'),
            stripe_idempotency_key: null,
            status: 'completed',
            stripe_account_id: accountId,
            result_reference: accountPublicId,
            failure_category: null,
            created_by_user_id: input.userId,
            created_at: new Date(),
            completed_at: new Date(),
          },
          { session },
        );
        await this.audit(
          input,
          'stripe_connect_account_link_created',
          { stripe_account_id: accountId },
          session,
        );
      });
    } finally {
      await session.endSession();
    }
  }

  public async failAccountOperation(input: ConnectActor, operationPublicId: string) {
    const session = this.db.client.startSession();
    try {
      await session.withTransaction(async () => {
        await this.db.collection('stripe_connect_operations').updateOne(
          { public_id: operationPublicId, tenant_id: input.tenantId, status: 'pending' },
          {
            $set: {
              status: 'failed',
              failure_category: 'stripe_request_failed',
              completed_at: new Date(),
            },
          },
          { session },
        );
        await this.audit(
          input,
          'stripe_connect_account_create_failed',
          { failure_category: 'stripe_request_failed' },
          session,
          'failure',
        );
      });
    } finally {
      await session.endSession();
    }
  }

  public async audit(
    input: ConnectActor,
    event: string,
    metadata: Record<string, string | null>,
    session?: ClientSession,
    outcome: 'success' | 'failure' = 'success',
  ) {
    await this.db.collection('audit_logs').insertOne(
      {
        public_id: randomUUID(),
        event,
        outcome,
        actor_user_id: input.userId,
        tenant_id: input.tenantId,
        request_id: input.requestId,
        metadata,
        created_at: new Date(),
      },
      session ? { session } : undefined,
    );
  }
}

export function deriveStatus(view: ConnectAccountView) {
  if (view.requirements.disabledReason) return 'disabled';
  if (view.requirements.pastDue.length || view.requirements.currentlyDue.length)
    return view.detailsSubmitted ? 'action_required' : 'onboarding_started';
  if (!view.detailsSubmitted || view.requirements.pendingVerification.length)
    return 'pending_verification';
  if (!view.chargesEnabled) return 'restricted';
  return view.payoutsEnabled ? 'payouts_enabled' : 'payments_enabled';
}

export function accountDocument(input: ConnectActor, view: ConnectAccountView, now = new Date()) {
  return {
    public_id: randomUUID(),
    tenant_id: input.tenantId,
    stripe_account_id: view.id,
    account_type: 'express',
    country: 'US',
    default_currency: input.tenantCurrency,
    status: deriveStatus(view),
    active: true,
    details_submitted: view.detailsSubmitted,
    charges_enabled: view.chargesEnabled,
    payouts_enabled: view.payoutsEnabled,
    capabilities: {
      card_payments: view.capabilities.cardPayments,
      transfers: view.capabilities.transfers,
    },
    requirements: {
      currently_due: view.requirements.currentlyDue,
      eventually_due: view.requirements.eventuallyDue,
      past_due: view.requirements.pastDue,
      pending_verification: view.requirements.pendingVerification,
      disabled_reason: view.requirements.disabledReason,
      current_deadline: view.requirements.currentDeadline,
    },
    last_stripe_event_id: null,
    last_stripe_event_created_at: null,
    last_synced_at: now,
    connected_at: now,
    disconnected_at: null,
    created_at: now,
    created_by_user_id: input.userId,
    updated_at: now,
    updated_by_source: 'user',
    version: 1,
  };
}

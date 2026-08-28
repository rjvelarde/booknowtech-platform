import { randomUUID } from 'node:crypto';
import { type Db, MongoServerError, type ObjectId } from 'mongodb';

import type { VerifiedStripeEvent } from './adapter.js';

export class StripeWebhookStore {
  public constructor(private readonly db: Db) {}

  public async ingest(input: {
    event: VerifiedStripeEvent;
    endpointKind: 'platform' | 'connect';
    requestId: string;
    payloadHash: string;
  }) {
    const now = new Date();
    const account = input.event.account;
    const tenantAccount = account
      ? await this.db
          .collection<{ tenant_id: ObjectId }>('tenant_stripe_accounts')
          .findOne({ stripe_account_id: account, active: true }, { projection: { tenant_id: 1 } })
      : null;
    const supportedTypes = [
      'account.updated',
      'account.application.deauthorized',
      'payment_intent.succeeded',
      'payment_intent.payment_failed',
      'payment_intent.canceled',
      'payment_intent.processing',
      'charge.refunded',
      'refund.updated',
      'charge.dispute.created',
      'charge.dispute.updated',
      'charge.dispute.closed',
    ];
    const supported =
      input.endpointKind === 'connect' &&
      account !== null &&
      supportedTypes.includes(input.event.type) &&
      (!input.event.type.startsWith('payment_intent.') || input.event.paymentIntentView !== null) &&
      (!isExternalEvidenceType(input.event.type) || input.event.financialEvidenceView !== null);
    const sanitizedPayload = input.event.accountView
      ? sanitize(input.event.accountView)
      : input.event.paymentIntentView
        ? sanitizePaymentIntent(input.event.paymentIntentView)
        : input.event.financialEvidenceView
          ? sanitizeExternalEvidence(input.event.financialEvidenceView)
          : {};
    const document = {
      public_id: randomUUID(),
      stripe_event_id: input.event.id,
      endpoint_kind: input.endpointKind,
      stripe_account_id: account,
      tenant_id: tenantAccount?.tenant_id ?? null,
      event_type: input.event.type,
      stripe_created_at: input.event.created,
      stripe_api_version: input.event.apiVersion,
      livemode: input.event.livemode,
      payload_hash: input.payloadHash,
      sanitized_payload: sanitizedPayload,
      processing_status: supported ? 'pending' : 'unsupported',
      attempt_count: 0,
      next_attempt_at: now,
      processing_started_at: null,
      processing_token: null,
      processed_at: supported ? null : now,
      failure_category: supported && !tenantAccount ? 'unresolved_account' : null,
      received_request_id: input.requestId,
      received_at: now,
      updated_at: now,
    };
    try {
      await this.db.collection('stripe_webhook_events').insertOne(document);
      return { duplicate: false, publicId: document.public_id };
    } catch (error) {
      if (!(error instanceof MongoServerError && error.code === 11000)) throw error;
      const existing = await this.db
        .collection('stripe_webhook_events')
        .findOne(
          { stripe_event_id: input.event.id },
          { projection: { public_id: 1, payload_hash: 1 } },
        );
      if (existing?.payload_hash !== input.payloadHash)
        throw new Error('stripe_event_payload_mismatch', { cause: error });
      return { duplicate: true, publicId: existing?.public_id as string };
    }
  }
}

function isExternalEvidenceType(type: string) {
  return (
    type === 'charge.refunded' || type === 'refund.updated' || type.startsWith('charge.dispute.')
  );
}

function sanitizeExternalEvidence(view: NonNullable<VerifiedStripeEvent['financialEvidenceView']>) {
  return {
    object_type: view.objectType,
    id: view.id,
    payment_intent_id: view.paymentIntentId,
    amount: view.amount,
    currency: view.currency,
    status: view.status,
  };
}

function sanitizePaymentIntent(view: NonNullable<VerifiedStripeEvent['paymentIntentView']>) {
  return {
    id: view.id,
    status: view.status,
    amount: view.amount,
    application_fee_amount: view.applicationFeeAmount,
    currency: view.currency,
    last_payment_error_code: view.lastPaymentErrorCode,
  };
}

function sanitize(view: NonNullable<VerifiedStripeEvent['accountView']>) {
  return {
    id: view.id,
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
  };
}

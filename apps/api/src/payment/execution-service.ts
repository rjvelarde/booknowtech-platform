import type { ObjectId } from 'mongodb';

import type { StripePaymentAdapter } from '../stripe/adapter.js';
import type { PaymentAttemptDocument, PaymentFoundationStore } from './store.js';

export interface PublicPaymentAttemptResponse {
  appointment_reference: string;
  appointment_status: 'payment_pending' | 'payment_failed' | 'payment_expired' | 'scheduled';
  payment_attempt_public_id: string;
  payment_status:
    | 'payment_method_required'
    | 'customer_action_required'
    | 'processing'
    | 'recoverable_failure'
    | 'terminal_failure'
    | 'expired'
    | 'temporary_recovery'
    | 'manual_review'
    | 'succeeded';
  expires_at: string;
  client_secret: string | null;
  stripe_account: string | null;
  continuation_allowed: boolean;
  amounts: {
    service_price_minor: number;
    provider_amount_due_now_minor: number;
    booknowtech_fee_minor: number;
    customer_total_due_now_minor: number;
    application_fee_amount_minor: number;
    remaining_service_balance_minor: number;
    currency: 'USD';
  };
}

export class PaymentExecutionService {
  public constructor(
    private readonly store: PaymentFoundationStore,
    private readonly stripe: StripePaymentAdapter,
  ) {}

  public async ensurePaymentIntent(input: {
    tenantId: ObjectId;
    tenantPublicId: string;
    connectedAccountId: string;
    customerEmail: string;
    appointmentPublicId: string;
    appointmentReference: string;
    appointmentStatus: PublicPaymentAttemptResponse['appointment_status'];
    attempt: PaymentAttemptDocument;
  }): Promise<PublicPaymentAttemptResponse> {
    if (
      [
        'failed_terminal',
        'expired',
        'stale',
        'manual_review',
        'succeeded_unfinalized',
        'succeeded',
      ].includes(input.attempt.state)
    )
      return publicPaymentAttemptResponse({
        attempt: input.attempt,
        appointmentReference: input.appointmentReference,
        appointmentStatus: input.appointmentStatus,
        clientSecret: null,
        connectedAccountId: input.connectedAccountId,
      });
    const attempt = input.attempt.stripe_payment_intent_id
      ? input.attempt
      : (
          await this.store.transitionAttempt({
            tenantId: input.tenantId,
            attemptPublicId: input.attempt.public_id,
            event: 'begin_stripe_creation',
          })
        ).attempt;
    const intent = attempt.stripe_payment_intent_id
      ? await this.stripe.retrievePaymentIntent({
          connectedAccountId: input.connectedAccountId,
          paymentIntentId: attempt.stripe_payment_intent_id,
        })
      : await this.stripe.createDirectChargePaymentIntent({
          connectedAccountId: input.connectedAccountId,
          amountMinor: attempt.amount_snapshot.customer_total_due_now_minor,
          applicationFeeAmountMinor: attempt.amount_snapshot.application_fee_amount_minor,
          receiptEmail: input.customerEmail,
          idempotencyKey: stripePaymentIntentIdempotencyKey(
            input.tenantPublicId,
            attempt.public_id,
          ),
          metadata: {
            tenantPublicId: input.tenantPublicId,
            appointmentPublicId: input.appointmentPublicId,
            paymentAttemptPublicId: attempt.public_id,
          },
        });
    if (
      intent.amount !== attempt.amount_snapshot.customer_total_due_now_minor ||
      intent.applicationFeeAmount !== attempt.amount_snapshot.application_fee_amount_minor ||
      intent.currency !== 'usd'
    )
      throw new Error('payment_intent_snapshot_mismatch');
    const linked = await this.store.linkPaymentIntent({
      tenantId: input.tenantId,
      attemptPublicId: attempt.public_id,
      intent,
    });
    return publicPaymentAttemptResponse({
      attempt: linked,
      appointmentReference: input.appointmentReference,
      appointmentStatus:
        linked.state === 'failed_terminal' ? 'payment_failed' : input.appointmentStatus,
      clientSecret: intent.clientSecret,
      connectedAccountId: input.connectedAccountId,
    });
  }

  public async cancelStaleAttempt(input: {
    connectedAccountId: string;
    attempt: PaymentAttemptDocument;
  }): Promise<void> {
    if (!input.attempt.stripe_payment_intent_id) return;
    await this.stripe.cancelPaymentIntent({
      connectedAccountId: input.connectedAccountId,
      paymentIntentId: input.attempt.stripe_payment_intent_id,
      idempotencyKey: `bnt_pi_cancel_v1_${input.attempt.public_id}`,
    });
  }
}

export function stripePaymentIntentIdempotencyKey(
  tenantPublicId: string,
  attemptPublicId: string,
): string {
  return `bnt_pi_v1_${tenantPublicId}_${attemptPublicId}`;
}

export function publicPaymentAttemptResponse(input: {
  attempt: PaymentAttemptDocument;
  appointmentReference: string;
  appointmentStatus: PublicPaymentAttemptResponse['appointment_status'];
  clientSecret: string | null;
  connectedAccountId: string | null;
}): PublicPaymentAttemptResponse {
  const clientSecret = [
    'requires_payment_method',
    'requires_customer_action',
    'failed_recoverable',
  ].includes(input.attempt.state)
    ? input.clientSecret
    : null;
  return {
    appointment_reference: input.appointmentReference,
    appointment_status: input.appointmentStatus,
    payment_attempt_public_id: input.attempt.public_id,
    payment_status: publicStatus(input.attempt.state),
    expires_at: input.attempt.expires_at.toISOString(),
    client_secret: clientSecret,
    stripe_account: clientSecret ? input.connectedAccountId : null,
    continuation_allowed: clientSecret !== null,
    amounts: {
      service_price_minor: input.attempt.amount_snapshot.service_price_minor,
      provider_amount_due_now_minor: input.attempt.amount_snapshot.provider_amount_due_now_minor,
      booknowtech_fee_minor: input.attempt.amount_snapshot.booknowtech_fee_minor,
      customer_total_due_now_minor: input.attempt.amount_snapshot.customer_total_due_now_minor,
      application_fee_amount_minor: input.attempt.amount_snapshot.application_fee_amount_minor,
      remaining_service_balance_minor:
        input.attempt.amount_snapshot.remaining_service_balance_minor,
      currency: 'USD',
    },
  };
}

function publicStatus(
  state: PaymentAttemptDocument['state'],
): PublicPaymentAttemptResponse['payment_status'] {
  switch (state) {
    case 'requested':
    case 'stripe_creation_processing':
    case 'succeeded_unfinalized':
      return 'temporary_recovery';
    case 'requires_payment_method':
      return 'payment_method_required';
    case 'requires_customer_action':
      return 'customer_action_required';
    case 'processing':
      return 'processing';
    case 'failed_recoverable':
      return 'recoverable_failure';
    case 'failed_terminal':
    case 'stale':
      return 'terminal_failure';
    case 'expired':
      return 'expired';
    case 'manual_review':
      return 'manual_review';
    case 'succeeded':
      return 'succeeded';
  }
}

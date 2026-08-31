import Stripe from 'stripe';

export interface ConnectAccountView {
  id: string;
  livemode: boolean | undefined;
  detailsSubmitted: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  capabilities: { cardPayments: string | null; transfers: string | null };
  requirements: {
    currentlyDue: string[];
    eventuallyDue: string[];
    pastDue: string[];
    pendingVerification: string[];
    disabledReason: string | null;
    currentDeadline: Date | null;
  };
}

export interface VerifiedStripeEvent {
  id: string;
  type: string;
  account: string | null;
  created: Date;
  apiVersion: string | null;
  livemode: boolean;
  accountView: ConnectAccountView | null;
  paymentIntentView: PaymentIntentWebhookView | null;
  financialEvidenceView: ExternalFinancialEvidenceView | null;
}

export interface PaymentIntentWebhookView {
  id: string;
  status: ReducedPaymentIntentStatus;
  amount: number;
  applicationFeeAmount: number | null;
  currency: string;
  lastPaymentErrorCode: string | null;
}

export interface ExternalFinancialEvidenceView {
  objectType: 'refund' | 'dispute' | 'charge';
  id: string;
  paymentIntentId: string | null;
  amount: number;
  currency: string;
  status: string | null;
}

export type ReducedPaymentIntentStatus =
  | 'requires_payment_method'
  | 'requires_confirmation'
  | 'requires_action'
  | 'processing'
  | 'canceled'
  | 'succeeded';

export interface PaymentIntentView {
  id: string;
  status: ReducedPaymentIntentStatus;
  clientSecret: string | null;
  amount: number;
  applicationFeeAmount: number | null;
  currency: 'usd';
}

export interface StripeConnectAdapter {
  createExpressAccount(input: {
    tenantPublicId: string;
    configurationPublicId: string;
    currency: string;
    idempotencyKey: string;
  }): Promise<ConnectAccountView>;
  createAccountLink(input: {
    accountId: string;
    returnUrl: string;
    refreshUrl: string;
  }): Promise<{ url: string; expiresAt: Date }>;
  retrieveAccount(accountId: string): Promise<ConnectAccountView>;
  verifyWebhook(payload: Buffer, signature: string, secret: string): VerifiedStripeEvent;
}

export interface StripePaymentAdapter {
  createDirectChargePaymentIntent(input: {
    connectedAccountId: string;
    amountMinor: number;
    applicationFeeAmountMinor: number;
    receiptEmail: string;
    idempotencyKey: string;
    metadata: {
      tenantPublicId: string;
      appointmentPublicId: string;
      paymentAttemptPublicId: string;
    };
  }): Promise<PaymentIntentView>;
  retrievePaymentIntent(input: {
    connectedAccountId: string;
    paymentIntentId: string;
  }): Promise<PaymentIntentView>;
  cancelPaymentIntent(input: {
    connectedAccountId: string;
    paymentIntentId: string;
    idempotencyKey: string;
  }): Promise<PaymentIntentView>;
}

export class StripeSdkConnectAdapter implements StripeConnectAdapter {
  private readonly stripe: Stripe;
  private readonly livemode: boolean;

  public constructor(secretKey: string) {
    this.stripe = new Stripe(secretKey, { maxNetworkRetries: 2, timeout: 10_000 });
    this.livemode = secretKey.startsWith('sk_live_');
  }

  public async createExpressAccount(input: {
    tenantPublicId: string;
    configurationPublicId: string;
    currency: string;
    idempotencyKey: string;
  }): Promise<ConnectAccountView> {
    const account = await this.stripe.accounts.create(
      {
        type: 'express',
        country: 'US',
        default_currency: input.currency.toLowerCase(),
        capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
        metadata: {
          tenant_public_id: input.tenantPublicId,
          stripe_configuration_public_id: input.configurationPublicId,
          schema_version: '1',
        },
      },
      { idempotencyKey: input.idempotencyKey },
    );
    return accountView(account, this.livemode);
  }

  public async createAccountLink(input: {
    accountId: string;
    returnUrl: string;
    refreshUrl: string;
  }): Promise<{ url: string; expiresAt: Date }> {
    const link = await this.stripe.accountLinks.create({
      account: input.accountId,
      type: 'account_onboarding',
      collection_options: { fields: 'eventually_due' },
      return_url: input.returnUrl,
      refresh_url: input.refreshUrl,
    });
    return { url: link.url, expiresAt: new Date(link.expires_at * 1_000) };
  }

  public async retrieveAccount(accountId: string): Promise<ConnectAccountView> {
    return accountView(await this.stripe.accounts.retrieve(accountId), this.livemode);
  }

  public async createDirectChargePaymentIntent(input: {
    connectedAccountId: string;
    amountMinor: number;
    applicationFeeAmountMinor: number;
    receiptEmail: string;
    idempotencyKey: string;
    metadata: {
      tenantPublicId: string;
      appointmentPublicId: string;
      paymentAttemptPublicId: string;
    };
  }): Promise<PaymentIntentView> {
    const intent = await this.stripe.paymentIntents.create(
      {
        amount: input.amountMinor,
        application_fee_amount: input.applicationFeeAmountMinor,
        currency: 'usd',
        capture_method: 'automatic',
        payment_method_types: ['card'],
        receipt_email: input.receiptEmail,
        metadata: {
          tenant_public_id: input.metadata.tenantPublicId,
          appointment_public_id: input.metadata.appointmentPublicId,
          payment_attempt_public_id: input.metadata.paymentAttemptPublicId,
          schema_version: '1',
        },
      },
      { stripeAccount: input.connectedAccountId, idempotencyKey: input.idempotencyKey },
    );
    return paymentIntentView(intent);
  }

  public async retrievePaymentIntent(input: {
    connectedAccountId: string;
    paymentIntentId: string;
  }): Promise<PaymentIntentView> {
    return paymentIntentView(
      await this.stripe.paymentIntents.retrieve(input.paymentIntentId, undefined, {
        stripeAccount: input.connectedAccountId,
      }),
    );
  }

  public async cancelPaymentIntent(input: {
    connectedAccountId: string;
    paymentIntentId: string;
    idempotencyKey: string;
  }): Promise<PaymentIntentView> {
    return paymentIntentView(
      await this.stripe.paymentIntents.cancel(input.paymentIntentId, undefined, {
        stripeAccount: input.connectedAccountId,
        idempotencyKey: input.idempotencyKey,
      }),
    );
  }

  public verifyWebhook(payload: Buffer, signature: string, secret: string): VerifiedStripeEvent {
    const event = this.stripe.webhooks.constructEvent(payload, signature, secret);
    const object = event.data.object;
    return {
      id: event.id,
      type: event.type,
      account: event.account ?? null,
      created: new Date(event.created * 1_000),
      apiVersion: event.api_version ?? null,
      livemode: event.livemode,
      accountView: object.object === 'account' ? accountView(object) : null,
      paymentIntentView:
        object.object === 'payment_intent' && isReducedPaymentIntentStatus(object.status)
          ? {
              id: object.id,
              status: object.status,
              amount: object.amount,
              applicationFeeAmount: object.application_fee_amount,
              currency: object.currency,
              lastPaymentErrorCode: object.last_payment_error?.code ?? null,
            }
          : null,
      financialEvidenceView: externalFinancialEvidenceView(object),
    };
  }
}

function externalFinancialEvidenceView(value: unknown): ExternalFinancialEvidenceView | null {
  if (!value || typeof value !== 'object' || !('object' in value)) return null;
  const objectType = Reflect.get(value, 'object');
  if (objectType === 'refund') {
    const refund = value as Stripe.Refund;
    return {
      objectType: 'refund',
      id: refund.id,
      paymentIntentId:
        typeof refund.payment_intent === 'string'
          ? refund.payment_intent
          : (refund.payment_intent?.id ?? null),
      amount: refund.amount,
      currency: refund.currency,
      status: refund.status,
    };
  }
  if (objectType === 'dispute') {
    const dispute = value as Stripe.Dispute;
    return {
      objectType: 'dispute',
      id: dispute.id,
      paymentIntentId:
        typeof dispute.payment_intent === 'string'
          ? dispute.payment_intent
          : (dispute.payment_intent?.id ?? null),
      amount: dispute.amount,
      currency: dispute.currency,
      status: dispute.status,
    };
  }
  if (objectType === 'charge') {
    const charge = value as Stripe.Charge;
    return {
      objectType: 'charge',
      id: charge.id,
      paymentIntentId:
        typeof charge.payment_intent === 'string'
          ? charge.payment_intent
          : (charge.payment_intent?.id ?? null),
      amount: charge.amount_refunded,
      currency: charge.currency,
      status: charge.refunded ? 'refunded' : 'partially_refunded',
    };
  }
  return null;
}

function paymentIntentView(intent: Stripe.PaymentIntent): PaymentIntentView {
  if (intent.currency !== 'usd' || !isReducedPaymentIntentStatus(intent.status))
    throw new Error('unsupported_payment_intent_projection');
  return {
    id: intent.id,
    status: intent.status,
    clientSecret: intent.client_secret,
    amount: intent.amount,
    applicationFeeAmount: intent.application_fee_amount,
    currency: 'usd',
  };
}

function isReducedPaymentIntentStatus(value: string): value is ReducedPaymentIntentStatus {
  return [
    'requires_payment_method',
    'requires_confirmation',
    'requires_action',
    'processing',
    'canceled',
    'succeeded',
  ].includes(value);
}

function accountView(account: Stripe.Account, livemode?: boolean): ConnectAccountView {
  const requirements = account.requirements;
  return {
    id: account.id,
    livemode,
    detailsSubmitted: account.details_submitted,
    chargesEnabled: account.charges_enabled,
    payoutsEnabled: account.payouts_enabled,
    capabilities: {
      cardPayments: account.capabilities?.card_payments ?? null,
      transfers: account.capabilities?.transfers ?? null,
    },
    requirements: {
      currentlyDue: [...(requirements?.currently_due ?? [])],
      eventuallyDue: [...(requirements?.eventually_due ?? [])],
      pastDue: [...(requirements?.past_due ?? [])],
      pendingVerification: [...(requirements?.pending_verification ?? [])],
      disabledReason: requirements?.disabled_reason ?? null,
      currentDeadline: requirements?.current_deadline
        ? new Date(requirements.current_deadline * 1_000)
        : null,
    },
  };
}

import Stripe from 'stripe';

export interface ConnectAccountView {
  id: string;
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

export class StripeSdkConnectAdapter implements StripeConnectAdapter {
  private readonly stripe: Stripe;

  public constructor(secretKey: string) {
    this.stripe = new Stripe(secretKey, { maxNetworkRetries: 2, timeout: 10_000 });
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
    return accountView(account);
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
    return accountView(await this.stripe.accounts.retrieve(accountId));
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
    };
  }
}

function accountView(account: Stripe.Account): ConnectAccountView {
  const requirements = account.requirements;
  return {
    id: account.id,
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

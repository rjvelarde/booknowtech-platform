import type { Environment } from '../config.js';
import type { StripeConnectAdapter } from './adapter.js';
import type { ConnectActor, ConnectStore } from './connect-store.js';

export class ConnectService {
  public constructor(
    private readonly environment: Environment,
    private readonly store: ConnectStore,
    private readonly stripe: StripeConnectAdapter,
  ) {}

  public status(actor: ConnectActor) {
    return this.store.status(actor.tenantId, this.environment.BOOKNOWTECH_CONNECT_TERMS_VERSION!);
  }

  public acceptTerms(actor: ConnectActor, ipHash: string) {
    this.requireEnabled();
    return this.store.acceptTerms({
      ...actor,
      termsVersion: this.environment.BOOKNOWTECH_CONNECT_TERMS_VERSION!,
      termsHash: this.environment.BOOKNOWTECH_CONNECT_TERMS_TEXT_SHA256!,
      ipHash,
    });
  }

  public async onboard(actor: ConnectActor) {
    this.requireEnabled();
    if (
      !(await this.store.hasTerms(
        actor.tenantId,
        this.environment.BOOKNOWTECH_CONNECT_TERMS_VERSION!,
      ))
    )
      throw new Error('terms_required');
    const result = await this.store.beginAccountOperation(actor);
    if (result.kind === 'account') return result.account;
    const operationPublicId = String(result.operation.public_id);
    const idempotencyKey = String(result.operation.stripe_idempotency_key);
    let view;
    try {
      view = await this.stripe.createExpressAccount({
        tenantPublicId: actor.tenantPublicId,
        configurationPublicId: operationPublicId,
        currency: actor.tenantCurrency,
        idempotencyKey,
      });
    } catch (error) {
      await this.store.failAccountOperation(actor, operationPublicId);
      throw error;
    }
    const account = await this.store.completeAccount(actor, operationPublicId, view);
    if (!account) throw new Error('account_persistence_failed');
    return account;
  }

  public async accountLink(actor: ConnectActor) {
    this.requireEnabled();
    if (
      !(await this.store.hasTerms(
        actor.tenantId,
        this.environment.BOOKNOWTECH_CONNECT_TERMS_VERSION!,
      ))
    )
      throw new Error('terms_required');
    const account = await this.store.activeAccount(actor.tenantId);
    if (!account) throw new Error('account_required');
    const accountId = String(account.stripe_account_id);
    const accountPublicId = String(account.public_id);
    const origin = new URL(this.environment.ADMIN_ORIGIN);
    const returnUrl = new URL('/payments/connect/return', origin).toString();
    const refreshUrl = new URL('/payments/connect/refresh', origin).toString();
    const link = await this.stripe.createAccountLink({
      accountId,
      returnUrl,
      refreshUrl,
    });
    await this.store.recordAccountLink(actor, accountPublicId, accountId);
    return link;
  }

  private requireEnabled() {
    if (!this.environment.STRIPE_CONNECT_FOUNDATION_ENABLED) throw new Error('foundation_disabled');
  }
}

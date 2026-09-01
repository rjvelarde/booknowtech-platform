import { randomUUID } from 'node:crypto';

import type { ObjectId } from 'mongodb';

import type { Environment } from '../config.js';
import type { ConnectAccountView, StripeConnectAdapter } from '../stripe/adapter.js';
import { deriveStatus } from '../stripe/connect-store.js';
import type {
  PaymentFoundationStore,
  PaymentReadinessGrant,
  TenantStripePaymentAccountDocument,
} from './store.js';

const REFRESH_LEASE_MS = 15_000;
const FOLLOWER_WAIT_MS = 2_000;
const FOLLOWER_POLL_MS = 50;

export class StripeReadinessError extends Error {}

export class StripeAccountReadinessService {
  public constructor(
    private readonly environment: Environment,
    private readonly store: PaymentFoundationStore,
    private readonly stripe: StripeConnectAdapter,
  ) {}

  public async ensureFresh(tenantId: ObjectId): Promise<PaymentReadinessGrant> {
    if (!this.environment.STRIPE_PAYMENT_EXECUTION_ENABLED)
      throw new StripeReadinessError('payment_execution_disabled');
    const maxAgeMs = this.environment.STRIPE_ACCOUNT_READINESS_MAX_AGE_SECONDS! * 1_000;
    let account = await this.store.activeStripeAccount(tenantId);
    if (!account) throw new StripeReadinessError('payment_account_not_ready');
    const staleBefore = new Date(Date.now() - maxAgeMs);
    if (!(account.last_synced_at instanceof Date) || account.last_synced_at < staleBefore) {
      const token = randomUUID();
      const leaseReclaimed =
        typeof account.readiness_refresh_token === 'string' &&
        account.readiness_refresh_started_at instanceof Date &&
        account.readiness_refresh_started_at < new Date(Date.now() - REFRESH_LEASE_MS);
      const claimed = await this.store.claimStripeReadinessRefresh({
        tenantId,
        accountPublicId: account.public_id,
        token,
        staleBefore,
        leaseExpiredBefore: new Date(Date.now() - REFRESH_LEASE_MS),
      });
      if (claimed) account = await this.refresh(tenantId, claimed, token, leaseReclaimed);
      else {
        try {
          account = await this.waitForRefresh(tenantId, account.public_id, staleBefore);
        } catch (error) {
          if (
            error instanceof StripeReadinessError &&
            error.message === 'payment_account_refresh_in_progress'
          )
            await this.store.recordStripeReadinessRefresh({
              tenantId,
              outcome: 'failure',
              category: 'refresh_lease_exhausted',
              durationMs: FOLLOWER_WAIT_MS,
              leaseReclaimed: false,
            });
          throw error;
        }
      }
    }
    return this.grant(tenantId, account, staleBefore);
  }

  private async refresh(
    tenantId: ObjectId,
    account: TenantStripePaymentAccountDocument,
    token: string,
    leaseReclaimed: boolean,
  ) {
    const startedAt = Date.now();
    try {
      const view = await this.stripe.retrieveAccount(account.stripe_account_id);
      if (view.id !== account.stripe_account_id)
        throw new Error('stripe_account_identity_mismatch');
      if (view.livemode !== (this.environment.ENVIRONMENT_ID === 'production'))
        throw new Error('stripe_account_mode_mismatch');
      const updated = await this.store.completeStripeReadinessRefresh({
        tenantId,
        accountPublicId: account.public_id,
        connectedAccountId: account.stripe_account_id,
        token,
        projection: projection(view),
      });
      if (!updated) throw new Error('stripe_account_refresh_claim_lost');
      const ready = accountReady(updated);
      await this.store.recordStripeReadinessRefresh({
        tenantId,
        outcome: 'success',
        category: ready ? 'refreshed' : 'account_unready',
        durationMs: Date.now() - startedAt,
        leaseReclaimed,
      });
      return updated;
    } catch (error) {
      const category = refreshFailureCategory(error);
      await this.store.failStripeReadinessRefresh({
        tenantId,
        accountPublicId: account.public_id,
        token,
        category,
      });
      await this.store.recordStripeReadinessRefresh({
        tenantId,
        outcome: 'failure',
        category,
        durationMs: Date.now() - startedAt,
        leaseReclaimed,
      });
      throw new StripeReadinessError('payment_account_refresh_failed', { cause: error });
    }
  }

  private async waitForRefresh(tenantId: ObjectId, publicId: string, staleBefore: Date) {
    const deadline = Date.now() + FOLLOWER_WAIT_MS;
    do {
      await new Promise((resolve) => setTimeout(resolve, FOLLOWER_POLL_MS));
      const account = await this.store.activeStripeAccount(tenantId);
      if (!account || account.public_id !== publicId)
        throw new StripeReadinessError('payment_account_not_ready');
      if (account.last_synced_at instanceof Date && account.last_synced_at >= staleBefore)
        return account;
    } while (Date.now() < deadline);
    throw new StripeReadinessError('payment_account_refresh_in_progress');
  }

  private grant(
    tenantId: ObjectId,
    account: TenantStripePaymentAccountDocument,
    staleBefore: Date,
  ): PaymentReadinessGrant {
    if (
      !(account.last_synced_at instanceof Date) ||
      account.last_synced_at < staleBefore ||
      !accountReady(account)
    )
      throw new StripeReadinessError('payment_account_not_ready');
    return {
      tenantId,
      accountPublicId: account.public_id,
      connectedAccountId: account.stripe_account_id,
      readinessGeneration: account.readiness_generation ?? 0,
      refreshedAt: account.last_synced_at,
    };
  }
}

function projection(view: ConnectAccountView) {
  return {
    status: deriveStatus(view),
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

function refreshFailureCategory(error: unknown) {
  if (!(error instanceof Error)) return 'stripe_api_failure';
  if (
    error.message === 'stripe_account_identity_mismatch' ||
    error.message === 'stripe_account_mode_mismatch' ||
    error.message === 'stripe_account_refresh_claim_lost'
  )
    return error.message;
  const candidate = error as Error & { code?: string; statusCode?: number; type?: string };
  if (candidate.type === 'StripeAuthenticationError' || candidate.statusCode === 401)
    return 'stripe_authentication_failure';
  if (candidate.type === 'StripeRateLimitError' || candidate.statusCode === 429)
    return 'stripe_rate_limit';
  if (candidate.type === 'StripeConnectionError' || candidate.code === 'ETIMEDOUT')
    return 'stripe_timeout';
  if (candidate.type === 'StripeInvalidRequestError') return 'stripe_malformed_response';
  return 'stripe_api_failure';
}

function accountReady(account: TenantStripePaymentAccountDocument) {
  return Boolean(
    account.charges_enabled &&
    account.capabilities?.card_payments === 'active' &&
    !account.requirements?.disabled_reason &&
    !account.requirements?.currently_due?.length &&
    !account.requirements?.past_due?.length &&
    !account.disconnected_at,
  );
}

import { randomUUID } from 'node:crypto';

import type { ClientSession } from 'mongodb';

import type {
  AdminStore,
  ProviderDocument,
  ServiceDocument,
  TenantDocument,
} from '../admin/store.js';
import type { Environment } from '../config.js';
import {
  type PublicAppointmentBody,
  normalizePublicAppointment,
  publicRequestFingerprint,
  utcDateScopes,
  validatePublicCandidate,
} from '../public/routes.js';
import {
  calculatePaymentAmounts,
  createPaymentTermsEvidence,
  hashPaymentIdempotencyKey,
  paymentAttemptFingerprint,
} from './domain.js';
import {
  type PaymentExecutionService,
  type PublicPaymentAttemptResponse,
  publicPaymentAttemptResponse,
} from './execution-service.js';
import {
  CHECKOUT_RECOVERY_MAX_AGE_SECONDS,
  issueRecoveryToken,
  recoveryHostnameHash,
  recoveryTokenHash,
  recoveryTokenMatches,
} from './recovery.js';
import { toAmountSnapshot } from './store.js';
import type { PaymentFoundationStore } from './store.js';
import type { PaymentReadinessGrant } from './store.js';
import type { StripeAccountReadinessService } from './readiness-service.js';

export class PaidBookingError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    options?: ErrorOptions,
  ) {
    super(code, options);
  }
}

export class PublicPaidBookingOrchestrator {
  public constructor(
    private readonly environment: Environment,
    private readonly admin: AdminStore,
    private readonly payments: PaymentFoundationStore,
    private readonly execution: PaymentExecutionService | null,
    private readonly readiness: StripeAccountReadinessService | null = null,
  ) {}

  public async paymentMode(tenantId: TenantDocument['_id'], serviceId: ServiceDocument['_id']) {
    return (
      (await this.payments.executionSnapshot(tenantId, serviceId)).serviceConfiguration
        ?.payment_mode ?? 'none'
    );
  }

  public async assertUnpaidMode(
    tenantId: TenantDocument['_id'],
    serviceId: ServiceDocument['_id'],
    session: ClientSession,
  ): Promise<void> {
    const mode =
      (await this.payments.executionSnapshot(tenantId, serviceId, session)).serviceConfiguration
        ?.payment_mode ?? 'none';
    if (mode !== 'none') throw new PaidBookingError(409, 'payment_configuration_changed');
  }

  public async create(input: {
    tenant: TenantDocument;
    body: PublicAppointmentBody;
    idempotencyKey: string;
    requestId: string;
    correlationId: string;
    ipAddress: string;
    initialService: ServiceDocument;
    initialProvider: ProviderDocument;
    initialAssignment: {
      buffer_before_minutes: number;
      buffer_after_minutes: number;
    };
    hostname: string;
  }): Promise<PublicPaymentAttemptResponse> {
    const normalized = normalizePublicAppointment(input.body);
    if (!normalized) throw new PaidBookingError(400, 'invalid_public_booking_request');
    let readinessGrant: PaymentReadinessGrant | null = null;
    if (this.readiness) {
      try {
        readinessGrant = await this.readiness.ensureFresh(input.tenant._id);
      } catch (reason) {
        throw new PaidBookingError(503, 'payment_account_not_ready', { cause: reason });
      }
    }
    const startsAt = new Date(normalized.starts_at);
    const preliminaryStart = new Date(
      startsAt.valueOf() - input.initialAssignment.buffer_before_minutes * 60_000,
    );
    const preliminaryEnd = new Date(
      startsAt.valueOf() +
        (input.initialService.duration_minutes + input.initialAssignment.buffer_after_minutes) *
          60_000,
    );
    const local = await this.admin.withAppointmentScheduleLocks(
      input.tenant._id,
      utcDateScopes(input.initialProvider._id, preliminaryStart, preliminaryEnd),
      (session) => this.createLocal(input, normalized, startsAt, readinessGrant, session),
    );
    if ('stale' in local) {
      if (this.execution && local.stale && local.connectedAccountId)
        void this.execution
          .cancelStaleAttempt({
            connectedAccountId: local.connectedAccountId,
            attempt: local.attempt,
          })
          .catch(() => undefined);
      throw new PaidBookingError(409, 'payment_attempt_stale');
    }
    if (!this.execution) throw new PaidBookingError(503, 'payment_execution_unavailable');
    try {
      return await this.execution.ensurePaymentIntent({
        tenantId: input.tenant._id,
        tenantPublicId: input.tenant.public_id,
        connectedAccountId: local.connectedAccountId,
        customerEmail: local.attempt.customer_email_normalized,
        appointmentPublicId: local.appointment.public_id,
        appointmentReference: local.appointment.reference,
        appointmentStatus: local.appointment
          .status as PublicPaymentAttemptResponse['appointment_status'],
        attempt: local.attempt,
        readinessGrant,
      });
    } catch (reason) {
      throw new PaidBookingError(503, 'payment_temporarily_unavailable', { cause: reason });
    }
  }

  public async continue(
    input: Parameters<PublicPaidBookingOrchestrator['create']>[0] & {
      attemptPublicId: string;
    },
  ): Promise<PublicPaymentAttemptResponse> {
    const attempt = await this.payments.getAttemptByPublicId(
      input.tenant._id,
      input.attemptPublicId,
    );
    if (
      !attempt ||
      attempt.idempotency_key_hash !== hashPaymentIdempotencyKey(input.idempotencyKey)
    )
      throw new PaidBookingError(404, 'payment_attempt_not_found');
    const response = await this.create(input);
    if (response.payment_attempt_public_id !== input.attemptPublicId)
      throw new PaidBookingError(409, 'payment_attempt_mismatch');
    return response;
  }

  public async recoveryCredential(input: {
    tenant: TenantDocument;
    attemptPublicId: string;
    hostname: string;
  }) {
    const attempt = await this.payments.getAttemptByPublicId(
      input.tenant._id,
      input.attemptPublicId,
    );
    if (
      !attempt ||
      !(attempt.recovery_expires_at instanceof Date) ||
      !/^[a-f0-9]{64}$/u.test(attempt.recovery_token_hash) ||
      attempt.recovery_hostname_hash !== recoveryHostnameHash(input.hostname)
    )
      throw new PaidBookingError(404, 'payment_attempt_not_found');
    const token = issueRecoveryToken({
      secret: this.environment.CHECKOUT_RECOVERY_TOKEN_SECRET!,
      tenantPublicId: input.tenant.public_id,
      attemptPublicId: attempt.public_id,
      hostnameHash: attempt.recovery_hostname_hash,
      expiresAt: attempt.recovery_expires_at,
    });
    if (recoveryTokenHash(token) !== attempt.recovery_token_hash)
      throw new PaidBookingError(404, 'payment_attempt_not_found');
    return {
      token,
      maxAgeSeconds: Math.min(
        CHECKOUT_RECOVERY_MAX_AGE_SECONDS,
        Math.max(0, Math.floor((attempt.recovery_expires_at.valueOf() - Date.now()) / 1000)),
      ),
    };
  }

  public async recover(input: {
    tenant: TenantDocument;
    attemptPublicId: string;
    hostname: string;
    token: string;
  }): Promise<PublicPaymentAttemptResponse> {
    const attempt = await this.payments.getAttemptByPublicId(
      input.tenant._id,
      input.attemptPublicId,
    );
    if (
      !attempt ||
      !(attempt.recovery_expires_at instanceof Date) ||
      attempt.recovery_expires_at <= new Date() ||
      attempt.recovery_hostname_hash !== recoveryHostnameHash(input.hostname) ||
      !recoveryTokenMatches(attempt.recovery_token_hash, input.token)
    )
      throw new PaidBookingError(404, 'payment_attempt_not_found');
    const context = await this.payments.getAttemptContext(input.tenant._id, attempt);
    if (
      ['requires_payment_method', 'requires_customer_action', 'failed_recoverable'].includes(
        attempt.state,
      ) &&
      attempt.expires_at > new Date()
    ) {
      if (!(await this.recoverySnapshotCurrent(input.tenant, attempt, context.appointment))) {
        await this.payments.markAttemptStale(input.tenant._id, attempt);
        throw new PaidBookingError(409, 'payment_attempt_stale');
      }
      if (!this.execution) throw new PaidBookingError(503, 'payment_execution_unavailable');
      const account = await this.payments.getSnapshottedStripeAccount(
        input.tenant._id,
        attempt.tenant_stripe_account_public_id,
      );
      if (!account) throw new PaidBookingError(409, 'payment_attempt_stale');
      let readinessGrant: PaymentReadinessGrant | null = null;
      if (this.readiness) {
        try {
          readinessGrant = await this.readiness.ensureFresh(input.tenant._id);
        } catch (reason) {
          throw new PaidBookingError(503, 'payment_account_not_ready', { cause: reason });
        }
        if (readinessGrant.accountPublicId !== attempt.tenant_stripe_account_public_id)
          throw new PaidBookingError(409, 'payment_attempt_stale');
      }
      return this.execution.ensurePaymentIntent({
        tenantId: input.tenant._id,
        tenantPublicId: input.tenant.public_id,
        connectedAccountId: account.stripe_account_id,
        customerEmail: attempt.customer_email_normalized,
        appointmentPublicId: context.appointment.public_id,
        appointmentReference: context.appointment.reference,
        appointmentStatus: context.appointment
          .status as PublicPaymentAttemptResponse['appointment_status'],
        attempt,
        readinessGrant,
      });
    }
    return publicPaymentAttemptResponse({
      attempt,
      appointmentReference: context.appointment.reference,
      appointmentStatus: context.appointment
        .status as PublicPaymentAttemptResponse['appointment_status'],
      clientSecret: null,
      connectedAccountId: null,
    });
  }

  private async createLocal(
    input: Parameters<PublicPaidBookingOrchestrator['create']>[0],
    normalized: NonNullable<ReturnType<typeof normalizePublicAppointment>>,
    startsAt: Date,
    readinessGrant: PaymentReadinessGrant | null,
    session: ClientSession,
  ) {
    const tenant = await this.admin.getPublicTenantBySlug(input.tenant.slug, session);
    if (!tenant) throw new PaidBookingError(404, 'public_booking_not_found');
    const idempotencyKeyHash = hashPaymentIdempotencyKey(input.idempotencyKey);
    const replay = await this.payments.getAttemptByIdempotency(
      tenant._id,
      idempotencyKeyHash,
      session,
    );
    const clientRequestFingerprint = publicRequestFingerprint(normalized);
    if (
      replay?.client_request_fingerprint !== undefined &&
      replay.client_request_fingerprint !== clientRequestFingerprint
    )
      throw new PaidBookingError(409, 'idempotency_key_reused');
    if (tenant.public_booking_terms.version !== normalized.consent.booking_terms_version) {
      if (replay) return this.staleReplay(tenant._id, replay, session);
      throw new PaidBookingError(409, 'booking_terms_changed');
    }
    const service = await this.admin.getService(tenant._id, normalized.service_public_id, session);
    const provider = await this.admin.getProvider(
      tenant._id,
      normalized.provider_public_id,
      session,
    );
    if (!service || service.status !== 'active' || !service.publicly_bookable || !provider) {
      if (replay) return this.staleReplay(tenant._id, replay, session);
      throw new PaidBookingError(404, 'public_booking_not_found');
    }
    if (
      provider.status !== 'active' ||
      !provider.customer_selectable ||
      !provider.accepting_new_clients
    ) {
      if (replay) return this.staleReplay(tenant._id, replay, session);
      throw new PaidBookingError(404, 'public_booking_not_found');
    }
    const assignment = await this.admin.findAppointmentAssignment(
      tenant._id,
      provider._id,
      service._id,
      session,
    );
    if (!assignment || assignment.status !== 'active') {
      if (replay) return this.staleReplay(tenant._id, replay, session);
      throw new PaidBookingError(404, 'public_booking_not_found');
    }
    const snapshot = await this.payments.executionSnapshot(tenant._id, service._id, session);
    if (
      readinessGrant &&
      (!(await this.payments.readinessGrantCurrent(readinessGrant, session)) ||
        snapshot.account?.public_id !== readinessGrant.accountPublicId)
    )
      throw new PaidBookingError(503, 'payment_account_not_ready');
    const paymentTerms = normalized.payment_terms;
    if (
      !paymentTerms?.accepted ||
      paymentTerms.version !== this.environment.BOOKNOWTECH_PAYMENT_TERMS_VERSION ||
      paymentTerms.document_sha256 !== this.environment.BOOKNOWTECH_PAYMENT_TERMS_TEXT_SHA256
    ) {
      if (replay) return this.staleReplay(tenant._id, replay, session);
      throw new PaidBookingError(409, 'payment_terms_changed');
    }
    if (
      replay &&
      (!snapshot.serviceConfiguration ||
        snapshot.serviceConfiguration.payment_mode === 'none' ||
        !snapshot.account ||
        snapshot.account.public_id !== replay.tenant_stripe_account_public_id ||
        tenant.currency !== 'USD' ||
        service.currency !== 'USD' ||
        snapshot.serviceConfiguration.currency !== 'USD' ||
        snapshot.account.default_currency !== 'USD')
    )
      return this.staleReplay(tenant._id, replay, session);
    assertExecutionReady(this.environment, tenant, service, snapshot, !replay);
    const configuration = snapshot.serviceConfiguration!;
    const fee = snapshot.fee;
    const account = snapshot.account!;
    const feeAmountMinor = replay?.amount_snapshot.booknowtech_fee_minor ?? fee!.amount_minor;
    const feeVersion = replay?.configuration_snapshot.fee_version ?? fee!.version;
    const feeConfigurationPublicId =
      replay?.configuration_snapshot.fee_configuration_public_id ?? fee!.fee_version_public_id;
    const amounts = calculatePaymentAmounts({
      servicePriceMinor: service.base_price_minor,
      paymentMode: configuration.payment_mode as 'fixed_deposit' | 'full',
      fixedDepositMinor: configuration.fixed_deposit_minor,
      booknowtechFeeMinor: feeAmountMinor,
      currency: 'USD',
    });
    const customerInputHash = publicRequestFingerprint(normalized.customer);
    const fingerprint = paymentAttemptFingerprint({
      tenantPublicId: tenant.public_id,
      servicePublicId: service.public_id,
      providerPublicId: provider.public_id,
      providerServiceAssignmentPublicId: assignment.public_id,
      startsAt,
      durationMinutes: service.duration_minutes,
      slotCadenceMinutes: service.slot_cadence_minutes ?? tenant.default_slot_cadence_minutes,
      bufferBeforeMinutes: assignment.buffer_before_minutes,
      bufferAfterMinutes: assignment.buffer_after_minutes,
      deliveryMode: service.delivery_mode,
      customerInputHash,
      servicePriceMinor: service.base_price_minor,
      paymentMode: amounts.paymentMode,
      depositVersionPublicId:
        amounts.paymentMode === 'fixed_deposit' ? configuration.configuration_public_id : null,
      fixedDepositMinor: amounts.fixedDepositMinor,
      feeVersion,
      feeAmountMinor,
      feeConfigurationPublicId,
      stripeAssociationPublicId: account.public_id,
      paymentTermsVersion: paymentTerms.version,
      paymentTermsDocumentSha256: paymentTerms.document_sha256,
      paymentConfigurationVersion: configuration.version,
    });
    if (replay) {
      if (replay.request_fingerprint !== fingerprint)
        return this.staleReplay(tenant._id, replay, session);
      const context = await this.payments.getAttemptContext(tenant._id, replay, session);
      const snapshottedAccount = await this.payments.getSnapshottedStripeAccount(
        tenant._id,
        replay.tenant_stripe_account_public_id,
        session,
      );
      if (!snapshottedAccount) return this.staleReplay(tenant._id, replay, session);
      return {
        attempt: replay,
        appointment: context.appointment,
        connectedAccountId: snapshottedAccount.stripe_account_id,
      };
    }
    const candidate = await validatePublicCandidate(
      this.admin,
      tenant,
      service,
      provider,
      assignment,
      startsAt,
      session,
    );
    const customer = await this.payments.createProvisionalCustomerEvidence(
      {
        tenantId: tenant._id,
        firstName: normalized.customer.first_name,
        lastName: normalized.customer.last_name,
        emailNormalized: normalized.customer.email,
        mobilePhoneE164: normalized.customer.mobile_phone_e164,
        customerInputHash,
      },
      session,
    );
    const now = new Date();
    const appointment = await this.admin.insertAppointment(
      {
        tenant_id: tenant._id,
        customer_id: customer._id,
        provider_id: provider._id,
        service_id: service._id,
        provider_service_assignment_id: assignment._id,
        ...candidate,
        snapshot: {
          customer_display_name: `${customer.first_name} ${customer.last_name}`,
          provider_display_name: provider.display_name,
          service_name: service.name,
          service_duration_minutes: service.duration_minutes,
          slot_cadence_minutes: service.slot_cadence_minutes ?? tenant.default_slot_cadence_minutes,
          buffer_before_minutes: assignment.buffer_before_minutes,
          buffer_after_minutes: assignment.buffer_after_minutes,
          delivery_mode: service.delivery_mode,
          base_price_minor: service.base_price_minor,
          booking_fee_minor: 0,
          currency: 'USD',
          customer_note: normalized.customer.appointment_note,
        },
        location: {
          mode: service.delivery_mode,
          customer_address: normalized.customer.customer_location_address,
        },
        status: 'payment_pending',
        source: 'public_booking',
        public_submission: {
          idempotency_key_hash: idempotencyKeyHash,
          request_fingerprint: fingerprint,
        },
        booking_terms: { version: tenant.public_booking_terms.version, accepted_at: now },
        cancelled_at: null,
        cancelled_by: null,
        cancellation_reason: null,
        cancellation_detail: null,
        completed_at: null,
        completed_by: null,
        no_show_at: null,
        no_show_by: null,
        version: 1,
        created_at: now,
        updated_at: now,
        created_by: null,
        updated_by: null,
      },
      session,
    );
    const attemptPublicId = randomUUID();
    const recoveryExpiresAt = new Date(now.valueOf() + CHECKOUT_RECOVERY_MAX_AGE_SECONDS * 1000);
    const recoveryHostHash = recoveryHostnameHash(input.hostname);
    const recoveryToken = issueRecoveryToken({
      secret: this.environment.CHECKOUT_RECOVERY_TOKEN_SECRET!,
      tenantPublicId: tenant.public_id,
      attemptPublicId,
      hostnameHash: recoveryHostHash,
      expiresAt: recoveryExpiresAt,
    });
    const inserted = await this.payments.insertPaymentAttempt(
      {
        public_id: attemptPublicId,
        tenant_id: tenant._id,
        appointment_id: appointment._id,
        customer_id: customer._id,
        customer_email_normalized: customer.email_normalized,
        tenant_stripe_account_public_id: account.public_id,
        idempotency_key_hash: idempotencyKeyHash,
        request_fingerprint: fingerprint,
        client_request_fingerprint: clientRequestFingerprint,
        recovery_token_hash: recoveryTokenHash(recoveryToken),
        recovery_hostname_hash: recoveryHostHash,
        recovery_expires_at: recoveryExpiresAt,
        public_booking_origin: `https://${input.hostname}`,
        amount_snapshot: toAmountSnapshot(amounts),
        configuration_snapshot: {
          service_payment_configuration_public_id: configuration.configuration_public_id,
          service_payment_configuration_version: configuration.version,
          deposit_version_public_id:
            amounts.paymentMode === 'fixed_deposit' ? configuration.configuration_public_id : null,
          fee_configuration_public_id: fee!.fee_version_public_id,
          fee_version: fee!.version,
        },
        payment_terms_acceptance: createPaymentTermsEvidence({
          version: paymentTerms.version,
          documentSha256: paymentTerms.document_sha256,
          acceptedAt: now,
          requestId: input.requestId,
          paymentAttemptPublicId: attemptPublicId,
          idempotencyKeyHash,
          ipAddress: input.ipAddress,
          ipHashSecret: this.environment.PAYMENT_IP_HASH_SECRET!,
        }),
        stripe_payment_intent_id: null,
        stripe_payment_intent_status: null,
        state: 'requested',
        expires_at: new Date(now.valueOf() + 15 * 60_000),
        slot_released: false,
        claim_token: null,
        claim_started_at: null,
        attempt_count: 0,
        next_attempt_at: now,
        failure_category: null,
        request_id: input.requestId,
        correlation_id: input.correlationId,
      },
      session,
    );
    await this.payments.appendLedgerEntry(
      {
        tenant_id: tenant._id,
        appointment_id: appointment._id,
        payment_attempt_id: inserted.attempt._id,
        entry_kind: 'intent_requested',
        sequence: 1,
        currency: 'USD',
        service_price_minor: amounts.servicePriceMinor,
        provider_amount_due_now_minor: amounts.providerAmountDueNowMinor,
        booknowtech_fee_minor: amounts.booknowtechFeeMinor,
        customer_total_due_now_minor: amounts.customerTotalDueNowMinor,
        application_fee_amount_minor: amounts.applicationFeeAmountMinor,
        remaining_service_balance_minor: amounts.remainingServiceBalanceMinor,
        source_identity: attemptPublicId,
        source_idempotency_key: 'intent_requested',
        stripe_object_id: null,
        stripe_event_id: null,
        effective_at: now,
        request_id: input.requestId,
        correlation_id: input.correlationId,
      },
      session,
    );
    return {
      attempt: inserted.attempt,
      appointment,
      connectedAccountId: account.stripe_account_id,
    };
  }

  private async recoverySnapshotCurrent(
    tenant: TenantDocument,
    attempt: NonNullable<Awaited<ReturnType<PaymentFoundationStore['getAttemptByPublicId']>>>,
    appointment: Awaited<ReturnType<PaymentFoundationStore['getAttemptContext']>>['appointment'],
  ) {
    const [service, provider] = await Promise.all([
      this.admin.getServiceById(tenant._id, appointment.service_id),
      this.admin.getProviderById(tenant._id, appointment.provider_id),
    ]);
    if (!service || !provider) return false;
    const assignment = await this.admin.findAppointmentAssignment(
      tenant._id,
      provider._id,
      service._id,
    );
    const snapshot = await this.payments.executionSnapshot(tenant._id, service._id);
    const configuration = snapshot.serviceConfiguration;
    if (
      tenant.public_booking_terms.version !== appointment.booking_terms?.version ||
      this.environment.BOOKNOWTECH_PAYMENT_TERMS_VERSION !==
        attempt.payment_terms_acceptance.version ||
      this.environment.BOOKNOWTECH_PAYMENT_TERMS_TEXT_SHA256 !==
        attempt.payment_terms_acceptance.document_sha256 ||
      service.status !== 'active' ||
      !service.publicly_bookable ||
      provider.status !== 'active' ||
      !provider.customer_selectable ||
      !provider.accepting_new_clients ||
      !assignment ||
      assignment.status !== 'active' ||
      !assignment._id.equals(appointment.provider_service_assignment_id) ||
      service.base_price_minor !== appointment.snapshot.base_price_minor ||
      service.duration_minutes !== appointment.snapshot.service_duration_minutes ||
      service.delivery_mode !== appointment.snapshot.delivery_mode ||
      assignment.buffer_before_minutes !== appointment.snapshot.buffer_before_minutes ||
      assignment.buffer_after_minutes !== appointment.snapshot.buffer_after_minutes ||
      configuration?.configuration_public_id !==
        attempt.configuration_snapshot.service_payment_configuration_public_id ||
      configuration.version !==
        attempt.configuration_snapshot.service_payment_configuration_version ||
      snapshot.account?.public_id !== attempt.tenant_stripe_account_public_id
    )
      return false;
    try {
      return (
        JSON.stringify(
          toAmountSnapshot(
            calculatePaymentAmounts({
              servicePriceMinor: service.base_price_minor,
              paymentMode: configuration.payment_mode as 'fixed_deposit' | 'full',
              fixedDepositMinor: configuration.fixed_deposit_minor,
              booknowtechFeeMinor: attempt.amount_snapshot.booknowtech_fee_minor,
              currency: 'USD',
            }),
          ),
        ) === JSON.stringify(attempt.amount_snapshot)
      );
    } catch {
      return false;
    }
  }

  private async staleReplay(
    tenantId: TenantDocument['_id'],
    attempt: NonNullable<Awaited<ReturnType<PaymentFoundationStore['getAttemptByIdempotency']>>>,
    session: ClientSession,
  ) {
    const snapshottedAccount = await this.payments.getSnapshottedStripeAccount(
      tenantId,
      attempt.tenant_stripe_account_public_id,
      session,
    );
    return {
      stale: await this.payments.markAttemptStaleInSession(tenantId, attempt, session),
      attempt,
      connectedAccountId: snapshottedAccount?.stripe_account_id ?? null,
    };
  }
}

function assertExecutionReady(
  environment: Environment,
  tenant: TenantDocument,
  service: ServiceDocument,
  snapshot: Awaited<ReturnType<PaymentFoundationStore['executionSnapshot']>>,
  requireActiveFee: boolean,
): void {
  if (!environment.STRIPE_PAYMENT_EXECUTION_ENABLED)
    throw new PaidBookingError(503, 'payment_execution_disabled');
  if (!snapshot.tenantSetting?.enabled)
    throw new PaidBookingError(503, 'payment_execution_disabled');
  if (!snapshot.serviceConfiguration || snapshot.serviceConfiguration.payment_mode === 'none')
    throw new PaidBookingError(409, 'payment_configuration_changed');
  if (requireActiveFee && !snapshot.fee)
    throw new PaidBookingError(503, 'payment_configuration_unavailable');
  const account = snapshot.account;
  if (
    tenant.currency !== 'USD' ||
    service.currency !== 'USD' ||
    snapshot.tenantSetting.currency !== 'USD' ||
    snapshot.serviceConfiguration.currency !== 'USD' ||
    (snapshot.fee?.currency !== undefined && snapshot.fee.currency !== 'USD') ||
    account?.default_currency !== 'USD'
  )
    throw new PaidBookingError(409, 'payment_currency_unsupported');
  if (
    !account ||
    !account.charges_enabled ||
    account.capabilities?.card_payments !== 'active' ||
    account.requirements?.disabled_reason ||
    account.requirements?.currently_due?.length ||
    account.requirements?.past_due?.length ||
    account.disconnected_at ||
    !(account.last_synced_at instanceof Date) ||
    Date.now() - account.last_synced_at.valueOf() >
      environment.STRIPE_ACCOUNT_READINESS_MAX_AGE_SECONDS! * 1_000
  )
    throw new PaidBookingError(503, 'payment_account_not_ready');
}

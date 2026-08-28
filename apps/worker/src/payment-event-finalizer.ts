import { createHash, randomUUID } from 'node:crypto';
import { type ClientSession, type Db, ObjectId } from 'mongodb';
import {
  derivePublicAppointmentCredential,
  hashPublicAppointmentCredential,
} from '@booknowtech/shared';

export interface PaymentEventProjection {
  id: string;
  status: string;
  amount: number;
  application_fee_amount: number | null;
  currency: string;
  last_payment_error_code: string | null;
}
export interface ExternalEvidenceProjection {
  object_type: 'refund' | 'dispute' | 'charge';
  id: string;
  payment_intent_id: string | null;
  amount: number;
  currency: string;
  status: string | null;
}
export interface PaymentFinalizationOptions {
  publicAppointmentTokenSecret: string;
  paymentTermsVersion: string;
  paymentTermsDocumentSha256: string;
}
interface WebhookEvent {
  _id: ObjectId;
  stripe_event_id: string;
  stripe_account_id: string | null;
  event_type: string;
  stripe_created_at: Date;
  sanitized_payload: PaymentEventProjection;
  received_request_id: string;
}
interface ExternalWebhookEvent extends Omit<WebhookEvent, 'sanitized_payload'> {
  sanitized_payload: ExternalEvidenceProjection;
}
interface Amounts {
  payment_mode: 'fixed_deposit' | 'full';
  fixed_deposit_minor: number | null;
  service_price_minor: number;
  provider_amount_due_now_minor: number;
  booknowtech_fee_minor: number;
  customer_total_due_now_minor: number;
  application_fee_amount_minor: number;
  remaining_service_balance_minor: number;
}
interface Attempt {
  _id: ObjectId;
  public_id: string;
  tenant_id: ObjectId;
  appointment_id: ObjectId;
  customer_id: ObjectId;
  tenant_stripe_account_public_id: string;
  amount_snapshot: Amounts;
  configuration_snapshot: {
    service_payment_configuration_public_id: string;
    service_payment_configuration_version: number;
    deposit_version_public_id: string | null;
    fee_configuration_public_id: string;
    fee_version: number;
  };
  payment_terms_acceptance: { version: string; document_sha256: string };
  stripe_payment_intent_id: string;
  state: string;
  slot_released: boolean;
  expires_at: Date;
  claim_token: string | null;
  correlation_id: string;
  request_fingerprint: string;
  public_booking_origin?: string | null;
}
interface Appointment {
  _id: ObjectId;
  public_id: string;
  reference: string;
  tenant_id: ObjectId;
  provider_id: ObjectId;
  service_id: ObjectId;
  provider_service_assignment_id: ObjectId;
  starts_at: Date;
  ends_at: Date;
  timezone: string;
  status: string;
  version: number;
  location: { mode: string };
  snapshot: {
    base_price_minor: number;
    customer_display_name: string;
    provider_display_name: string;
    service_name: string;
    service_duration_minutes: number;
    slot_cadence_minutes: number;
    buffer_before_minutes: number;
    buffer_after_minutes: number;
    delivery_mode: string;
  };
}
interface Account {
  tenant_id: ObjectId;
  public_id: string;
  stripe_account_id: string;
  active: boolean;
}
interface Service {
  public_id: string;
  base_price_minor: number;
}
interface Configuration {
  configuration_public_id: string;
  version: number;
}
interface Tenant {
  public_id: string;
  appointment_email_settings: { enabled: boolean };
  public_profile: {
    business_name: string;
    logo_url: string | null;
    phone_e164: string | null;
    email_normalized: string | null;
    website_url: string | null;
  };
}
interface Provider {
  public_id: string;
  photo_url: string | null;
}
interface Assignment {
  public_id: string;
}
interface Customer {
  email_normalized: string;
  customer_input_hash: string;
}
interface ManagementToken {
  _id: ObjectId;
  public_id: string;
  generation: number;
}

export async function applyPaymentEvent(
  db: Db,
  event: WebhookEvent,
  options: PaymentFinalizationOptions,
  session: ClientSession,
): Promise<void> {
  const view = event.sanitized_payload;
  if (!event.stripe_account_id || !view.id.startsWith('pi_'))
    throw new Error('payment_attribution_failed');
  const account = await db
    .collection<Account>('tenant_stripe_accounts')
    .findOne({ stripe_account_id: event.stripe_account_id }, { session });
  if (!account) throw new Error('unresolved_account');
  const attempt = await db
    .collection<Attempt>('payment_attempts')
    .findOne({ stripe_payment_intent_id: view.id }, { session });
  if (!attempt) throw new Error('payment_attempt_unresolved');
  const appointment = await db
    .collection<Appointment>('appointments')
    .findOne({ _id: attempt.appointment_id }, { session });
  const attributed =
    appointment &&
    String(attempt.tenant_id) === String(account.tenant_id) &&
    String(appointment.tenant_id) === String(account.tenant_id) &&
    attempt.tenant_stripe_account_public_id === account.public_id &&
    view.amount === attempt.amount_snapshot.customer_total_due_now_minor &&
    view.currency === 'usd' &&
    view.application_fee_amount === attempt.amount_snapshot.application_fee_amount_minor;
  if (!attributed) {
    if (event.event_type === 'payment_intent.succeeded')
      await appendLedger(
        db,
        event,
        attempt,
        session,
        'payment_succeeded',
        `payment_succeeded:${view.id}`,
      );
    await manualReview(db, event, attempt, session, 'payment_attribution_mismatch');
    return;
  }
  if (event.event_type === 'payment_intent.succeeded') {
    await success(db, event, attempt, appointment, account, options, session);
    return;
  }
  if (event.event_type === 'payment_intent.payment_failed') {
    if (terminal(attempt.state)) return;
    await appendLedger(
      db,
      event,
      attempt,
      session,
      'payment_failed_recoverable',
      `payment_failed_recoverable:${view.id}:${event.stripe_event_id}`,
    );
    await db.collection<Attempt>('payment_attempts').updateOne(
      { _id: attempt._id, slot_released: false },
      {
        $set: {
          state: 'failed_recoverable',
          stripe_payment_intent_status: 'requires_payment_method',
          failure_category: 'card_declined',
          updated_at: new Date(),
        },
      },
      { session },
    );
    return;
  }
  if (event.event_type === 'payment_intent.processing') {
    if (terminal(attempt.state)) return;
    await appendLedger(
      db,
      event,
      attempt,
      session,
      'payment_processing',
      `payment_processing:${view.id}`,
    );
    await db.collection<Attempt>('payment_attempts').updateOne(
      { _id: attempt._id, slot_released: false },
      {
        $set: {
          state: 'processing',
          stripe_payment_intent_status: 'processing',
          updated_at: new Date(),
        },
      },
      { session },
    );
    return;
  }
  if (event.event_type === 'payment_intent.canceled')
    await canceled(db, event, attempt, appointment, session);
}

export async function applyExternalFinancialEvidence(
  db: Db,
  event: ExternalWebhookEvent,
  session: ClientSession,
) {
  const view = event.sanitized_payload;
  if (!event.stripe_account_id || !view.payment_intent_id)
    throw new Error('financial_evidence_unattributed');
  const account = await db
    .collection<Account>('tenant_stripe_accounts')
    .findOne({ stripe_account_id: event.stripe_account_id }, { session });
  const attempt = await db
    .collection<Attempt>('payment_attempts')
    .findOne({ stripe_payment_intent_id: view.payment_intent_id }, { session });
  if (!account || !attempt || String(account.tenant_id) !== String(attempt.tenant_id))
    throw new Error('financial_evidence_unattributed');
  const evidenceKey = `${event.event_type}:${view.id}`;
  if (
    await db.collection('payment_ledger_entries').findOne(
      {
        tenant_id: attempt.tenant_id,
        source_identity: attempt.public_id,
        source_idempotency_key: evidenceKey,
      },
      { session },
    )
  )
    return;
  const entryKind = view.object_type === 'dispute' ? 'dispute_evidence' : 'refund_updated_external';
  await appendExternalLedger(db, event, attempt, session, entryKind);
  await db.collection<Attempt>('payment_attempts').updateOne(
    { _id: attempt._id },
    {
      $set: {
        state: 'manual_review',
        failure_category: 'local_finalization',
        updated_at: new Date(),
      },
    },
    { session },
  );
  await db.collection('audit_logs').insertOne(
    {
      public_id: randomUUID(),
      event:
        view.object_type === 'dispute'
          ? 'payment_dispute_manual_review'
          : 'external_refund_manual_review',
      outcome: 'failure',
      actor_user_id: null,
      tenant_id: attempt.tenant_id,
      request_id: event.received_request_id,
      metadata: {
        stripe_event_id: event.stripe_event_id,
        stripe_object_id: view.id,
        payment_intent_id: view.payment_intent_id,
        status: view.status,
      },
      created_at: new Date(),
    },
    { session },
  );
}

async function success(
  db: Db,
  event: WebhookEvent,
  attempt: Attempt,
  appointment: Appointment,
  account: Account,
  options: PaymentFinalizationOptions,
  session: ClientSession,
) {
  if (attempt.state === 'succeeded') return;
  await appendLedger(
    db,
    event,
    attempt,
    session,
    'payment_succeeded',
    `payment_succeeded:${event.sanitized_payload.id}`,
  );
  const current = await authoritativeFactsCurrent(
    db,
    attempt,
    appointment,
    account,
    options,
    session,
  );
  if (
    !current ||
    attempt.slot_released ||
    appointment.status !== 'payment_pending' ||
    terminal(attempt.state)
  ) {
    await manualReview(db, event, attempt, session, 'late_or_stale_payment_success', false);
    return;
  }
  if (
    ![
      'succeeded_unfinalized',
      'processing',
      'requires_customer_action',
      'requires_payment_method',
      'failed_recoverable',
    ].includes(attempt.state)
  ) {
    await manualReview(db, event, attempt, session, 'ineligible_payment_success', false);
    return;
  }
  const now = new Date();
  const appointmentUpdate = await db
    .collection<Appointment>('appointments')
    .updateOne(
      { _id: appointment._id, status: 'payment_pending', version: appointment.version },
      { $set: { status: 'scheduled', updated_at: now }, $inc: { version: 1 } },
      { session },
    );
  if (appointmentUpdate.modifiedCount !== 1) throw new Error('appointment_state_conflict');
  const attemptUpdate = await db.collection<Attempt>('payment_attempts').updateOne(
    { _id: attempt._id, state: attempt.state, slot_released: false },
    {
      $set: {
        state: 'succeeded',
        stripe_payment_intent_status: 'succeeded',
        failure_category: null,
        updated_at: now,
      },
    },
    { session },
  );
  if (attemptUpdate.modifiedCount !== 1) throw new Error('payment_state_conflict');
  const token = await createManagementToken(
    db,
    account.tenant_id,
    appointment,
    options,
    now,
    session,
  );
  await enqueueConfirmation(
    db,
    account.tenant_id,
    appointment,
    attempt,
    token,
    event,
    now,
    session,
  );
  await audit(
    db,
    account.tenant_id,
    event,
    appointment.public_id,
    'payment_booking_finalized',
    'success',
    session,
  );
}

async function canceled(
  db: Db,
  event: WebhookEvent,
  attempt: Attempt,
  appointment: Appointment,
  session: ClientSession,
) {
  if (attempt.state === 'succeeded' || attempt.slot_released) return;
  if (attempt.claim_token && attempt.expires_at <= new Date()) return;
  await appendLedger(
    db,
    event,
    attempt,
    session,
    'payment_failed_terminal',
    `payment_failed_terminal:${event.sanitized_payload.id}`,
  );
  await db.collection<Attempt>('payment_attempts').updateOne(
    { _id: attempt._id, slot_released: false },
    {
      $set: {
        state: 'failed_terminal',
        slot_released: true,
        stripe_payment_intent_status: 'canceled',
        failure_category: 'terminal_payment',
        updated_at: new Date(),
      },
    },
    { session },
  );
  await db
    .collection<Appointment>('appointments')
    .updateOne(
      { _id: appointment._id, status: 'payment_pending' },
      { $set: { status: 'payment_failed', updated_at: new Date() }, $inc: { version: 1 } },
      { session },
    );
}

function terminal(state: string) {
  return ['succeeded', 'failed_terminal', 'expired', 'stale', 'manual_review'].includes(state);
}

async function authoritativeFactsCurrent(
  db: Db,
  attempt: Attempt,
  appointment: Appointment,
  account: Account,
  options: PaymentFinalizationOptions,
  session: ClientSession,
) {
  const tenant = await db
    .collection<Tenant>('tenants')
    .findOne({ _id: attempt.tenant_id }, { session });
  const service = await db
    .collection<Service>('services')
    .findOne(
      { _id: appointment.service_id, tenant_id: attempt.tenant_id, status: 'active' },
      { session },
    );
  const provider = await db
    .collection<Provider>('providers')
    .findOne({ _id: appointment.provider_id }, { session });
  const assignment = await db
    .collection<Assignment>('provider_service_assignments')
    .findOne({ _id: appointment.provider_service_assignment_id }, { session });
  const customer = await db
    .collection<Customer>('provisional_payment_customers')
    .findOne({ _id: attempt.customer_id }, { session });
  const configuration = await db
    .collection<Configuration>('service_payment_configuration_active')
    .findOne({ tenant_id: attempt.tenant_id, service_id: appointment.service_id }, { session });
  return Boolean(
    tenant &&
    service &&
    provider &&
    assignment &&
    customer &&
    service.base_price_minor === attempt.amount_snapshot.service_price_minor &&
    appointment.snapshot.base_price_minor === attempt.amount_snapshot.service_price_minor &&
    configuration?.configuration_public_id ===
      attempt.configuration_snapshot.service_payment_configuration_public_id &&
    configuration.version ===
      attempt.configuration_snapshot.service_payment_configuration_version &&
    account.public_id === attempt.tenant_stripe_account_public_id &&
    account.active &&
    attempt.payment_terms_acceptance.version === options.paymentTermsVersion &&
    attempt.payment_terms_acceptance.document_sha256 === options.paymentTermsDocumentSha256 &&
    attempt.request_fingerprint ===
      authoritativeFingerprint(
        tenant,
        service,
        provider,
        assignment,
        customer,
        appointment,
        attempt,
      ),
  );
}

function authoritativeFingerprint(
  tenant: Tenant,
  service: Service,
  provider: Provider,
  assignment: Assignment,
  customer: Customer,
  appointment: Appointment,
  attempt: Attempt,
) {
  const canonical = JSON.stringify({
    schema: 2,
    tenant_public_id: tenant.public_id,
    service_public_id: service.public_id,
    provider_public_id: provider.public_id,
    provider_service_assignment_public_id: assignment.public_id,
    starts_at: appointment.starts_at.toISOString(),
    duration_minutes: appointment.snapshot.service_duration_minutes,
    slot_cadence_minutes: appointment.snapshot.slot_cadence_minutes,
    buffer_before_minutes: appointment.snapshot.buffer_before_minutes,
    buffer_after_minutes: appointment.snapshot.buffer_after_minutes,
    delivery_mode: appointment.snapshot.delivery_mode,
    customer_input_hash: customer.customer_input_hash,
    service_price_minor: attempt.amount_snapshot.service_price_minor,
    payment_mode: attempt.amount_snapshot.payment_mode,
    deposit_version_public_id: attempt.configuration_snapshot.deposit_version_public_id,
    fixed_deposit_minor: attempt.amount_snapshot.fixed_deposit_minor,
    fee_version: attempt.configuration_snapshot.fee_version,
    fee_amount_minor: attempt.amount_snapshot.booknowtech_fee_minor,
    fee_configuration_public_id: attempt.configuration_snapshot.fee_configuration_public_id,
    stripe_association_public_id: attempt.tenant_stripe_account_public_id,
    payment_terms_version: attempt.payment_terms_acceptance.version,
    payment_terms_document_sha256: attempt.payment_terms_acceptance.document_sha256,
    payment_configuration_version:
      attempt.configuration_snapshot.service_payment_configuration_version,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

async function appendLedger(
  db: Db,
  event: WebhookEvent,
  attempt: Attempt,
  session: ClientSession,
  entryKind: string,
  key: string,
) {
  const ledger = db.collection('payment_ledger_entries');
  if (
    await ledger.findOne(
      {
        tenant_id: attempt.tenant_id,
        source_identity: attempt.public_id,
        source_idempotency_key: key,
      },
      { session },
    )
  )
    return;
  const sequence =
    (await ledger.countDocuments({ payment_attempt_id: attempt._id }, { session })) + 1;
  await ledger.insertOne(
    {
      _id: new ObjectId(),
      public_id: randomUUID(),
      tenant_id: attempt.tenant_id,
      appointment_id: attempt.appointment_id,
      payment_attempt_id: attempt._id,
      entry_kind: entryKind,
      sequence,
      currency: 'USD',
      service_price_minor: attempt.amount_snapshot.service_price_minor,
      provider_amount_due_now_minor: attempt.amount_snapshot.provider_amount_due_now_minor,
      booknowtech_fee_minor: attempt.amount_snapshot.booknowtech_fee_minor,
      customer_total_due_now_minor: attempt.amount_snapshot.customer_total_due_now_minor,
      application_fee_amount_minor: attempt.amount_snapshot.application_fee_amount_minor,
      remaining_service_balance_minor: attempt.amount_snapshot.remaining_service_balance_minor,
      source_identity: attempt.public_id,
      source_idempotency_key: key,
      stripe_object_id: event.sanitized_payload.id,
      stripe_event_id: event.stripe_event_id,
      effective_at: event.stripe_created_at,
      request_id: event.received_request_id,
      correlation_id: attempt.correlation_id,
      created_at: new Date(),
    },
    { session },
  );
}

async function appendExternalLedger(
  db: Db,
  event: ExternalWebhookEvent,
  attempt: Attempt,
  session: ClientSession,
  entryKind: string,
) {
  const ledger = db.collection('payment_ledger_entries');
  const key = `${event.event_type}:${event.sanitized_payload.id}`;
  if (
    await ledger.findOne(
      {
        tenant_id: attempt.tenant_id,
        source_identity: attempt.public_id,
        source_idempotency_key: key,
      },
      { session },
    )
  )
    return;
  const sequence =
    (await ledger.countDocuments({ payment_attempt_id: attempt._id }, { session })) + 1;
  await ledger.insertOne(
    {
      _id: new ObjectId(),
      public_id: randomUUID(),
      tenant_id: attempt.tenant_id,
      appointment_id: attempt.appointment_id,
      payment_attempt_id: attempt._id,
      entry_kind: entryKind,
      sequence,
      currency: 'USD',
      service_price_minor: attempt.amount_snapshot.service_price_minor,
      provider_amount_due_now_minor: attempt.amount_snapshot.provider_amount_due_now_minor,
      booknowtech_fee_minor: attempt.amount_snapshot.booknowtech_fee_minor,
      customer_total_due_now_minor: attempt.amount_snapshot.customer_total_due_now_minor,
      application_fee_amount_minor: attempt.amount_snapshot.application_fee_amount_minor,
      remaining_service_balance_minor: attempt.amount_snapshot.remaining_service_balance_minor,
      source_identity: attempt.public_id,
      source_idempotency_key: key,
      stripe_object_id: event.sanitized_payload.id,
      stripe_event_id: event.stripe_event_id,
      effective_at: event.stripe_created_at,
      request_id: event.received_request_id,
      correlation_id: attempt.correlation_id,
      created_at: new Date(),
    },
    { session },
  );
}

async function manualReview(
  db: Db,
  event: WebhookEvent,
  attempt: Attempt,
  session: ClientSession,
  reason: string,
  append = true,
) {
  if (append)
    await appendLedger(
      db,
      event,
      attempt,
      session,
      'manual_review',
      `manual_review:${event.event_type}:${event.sanitized_payload.id}`,
    );
  await db.collection<Attempt>('payment_attempts').updateOne(
    { _id: attempt._id, state: { $ne: 'succeeded' } },
    {
      $set: {
        state: 'manual_review',
        stripe_payment_intent_status: event.sanitized_payload.status,
        failure_category: 'local_finalization',
        updated_at: new Date(),
      },
    },
    { session },
  );
  await audit(
    db,
    attempt.tenant_id,
    event,
    null,
    'payment_manual_review_required',
    'failure',
    session,
    reason,
  );
}

async function createManagementToken(
  db: Db,
  tenantId: ObjectId,
  appointment: Appointment,
  options: PaymentFinalizationOptions,
  now: Date,
  session: ClientSession,
): Promise<ManagementToken> {
  const tokens = db.collection<ManagementToken>('appointment_public_access_tokens');
  const existing = await tokens.findOne(
    {
      tenant_id: tenantId,
      appointment_id: appointment._id,
      purpose: 'appointment_manage',
      status: 'active',
    },
    { session },
  );
  if (existing) return existing;
  const tenant = await db.collection<Tenant>('tenants').findOne({ _id: tenantId }, { session });
  if (!tenant) throw new Error('tenant_unresolved');
  const publicId = randomUUID();
  const generation = 1;
  const credential = derivePublicAppointmentCredential(options.publicAppointmentTokenSecret, {
    version: 1,
    tokenPublicId: publicId,
    appointmentPublicId: appointment.public_id,
    generation,
    purpose: 'appointment_management',
  });
  const expiresAt = new Date(
    Math.min(appointment.starts_at.valueOf(), now.valueOf() + 180 * 86_400_000),
  );
  const token: ManagementToken & Record<string, unknown> = {
    _id: new ObjectId(),
    public_id: publicId,
    generation,
    tenant_id: tenantId,
    tenant_public_id: tenant.public_id,
    appointment_id: appointment._id,
    appointment_public_id: appointment.public_id,
    purpose: 'appointment_manage',
    token_hash: hashPublicAppointmentCredential(credential),
    status: 'active',
    issued_at: now,
    expires_at: expiresAt,
    consumed_at: null,
    revoked_at: null,
    created_at: now,
    updated_at: now,
    purge_at: new Date(expiresAt.valueOf() + 90 * 86_400_000),
    mutation: null,
  };
  await tokens.insertOne(token, { session });
  return token;
}

async function enqueueConfirmation(
  db: Db,
  tenantId: ObjectId,
  appointment: Appointment,
  attempt: Attempt,
  token: ManagementToken,
  event: WebhookEvent,
  now: Date,
  session: ClientSession,
) {
  const tenant = await db.collection<Tenant>('tenants').findOne({ _id: tenantId }, { session });
  const provider = await db
    .collection<Provider>('providers')
    .findOne({ _id: appointment.provider_id }, { session });
  const customer = await db
    .collection<Customer>('provisional_payment_customers')
    .findOne({ _id: attempt.customer_id }, { session });
  if (!tenant || !provider || !customer || !attempt.public_booking_origin)
    throw new Error('confirmation_snapshot_unavailable');
  if (!tenant.appointment_email_settings.enabled || !customer.email_normalized) return;
  await db.collection('notification_outbox').insertOne(
    {
      _id: new ObjectId(),
      public_id: randomUUID(),
      tenant_id: tenantId,
      appointment_id: appointment._id,
      appointment_public_id: appointment.public_id,
      appointment_reference: appointment.reference,
      type: 'appointment_confirmation',
      financial_finalization_key: `payment_succeeded:${attempt.public_id}`,
      channel: 'email',
      recipient: customer.email_normalized,
      template_data: {
        business_name: tenant.public_profile.business_name,
        business_logo_url: tenant.public_profile.logo_url,
        business_phone: tenant.public_profile.phone_e164,
        business_email: tenant.public_profile.email_normalized,
        business_website: tenant.public_profile.website_url,
        customer_name: appointment.snapshot.customer_display_name,
        provider_name: appointment.snapshot.provider_display_name,
        provider_photo_url: provider.photo_url,
        service_name: appointment.snapshot.service_name,
        starts_at: appointment.starts_at,
        ends_at: appointment.ends_at,
        timezone: appointment.timezone,
        location_mode: appointment.location.mode,
        service_price_minor: attempt.amount_snapshot.service_price_minor,
        provider_amount_paid_online_minor: attempt.amount_snapshot.provider_amount_due_now_minor,
        booknowtech_fee_minor: attempt.amount_snapshot.booknowtech_fee_minor,
        remaining_service_balance_minor: attempt.amount_snapshot.remaining_service_balance_minor,
        currency: 'USD',
      },
      appointment_access: { token_public_id: token.public_id, generation: token.generation },
      public_booking_origin: attempt.public_booking_origin,
      status: 'pending',
      attempt_count: 0,
      next_attempt_at: now,
      processing_started_at: null,
      delivered_at: null,
      failed_at: null,
      provider_message_id: null,
      last_error_code: null,
      request_id: event.received_request_id,
      created_at: now,
      updated_at: now,
    },
    { session },
  );
}

async function audit(
  db: Db,
  tenantId: ObjectId,
  event: WebhookEvent,
  appointmentPublicId: string | null,
  name: string,
  outcome: 'success' | 'failure',
  session: ClientSession,
  reason?: string,
) {
  await db.collection('audit_logs').insertOne(
    {
      public_id: randomUUID(),
      event: name,
      outcome,
      actor_user_id: null,
      tenant_id: tenantId,
      request_id: event.received_request_id,
      metadata: {
        stripe_event_id: event.stripe_event_id,
        payment_intent_id: event.sanitized_payload.id,
        appointment_public_id: appointmentPublicId,
        reason: reason ?? null,
      },
      created_at: new Date(),
    },
    { session },
  );
}

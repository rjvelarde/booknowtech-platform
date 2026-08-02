# PR 11 — Transactional Appointment Email Notifications Implementation Contract

**Status:** Accepted — implementation authorized  
**Scope:** Reliable appointment-created, appointment-rescheduled, and appointment-cancelled email delivery through the existing worker

## 1. Objective

PR 11 closes the largest remaining trust gap in the sellable booking workflow: after an appointment is created or changed, the customer receives a tenant-branded transactional email containing the safe appointment facts and human-readable reference.

The PR must reuse the PR 7 customer record, PR 8 appointment lifecycle and snapshots, PR 9 public branding and hostname rules, PR 10 transactional public booking workflow, and the existing Railway worker. It must not create another appointment workflow, customer identity, public session, scheduling engine, or Railway service.

The usable outcome is:

1. a booking-confirmation email after a successful Business Hub or public appointment creation;
2. a rescheduling email after a successful appointment reschedule;
3. a cancellation email after a successful appointment cancellation;
4. durable retry behavior when the email provider is temporarily unavailable;
5. staff-visible delivery status on the appointment detail page;
6. operational evidence that excludes message bodies and unnecessary customer PII.

Email delivery is asynchronous. A successfully committed appointment remains successful even if email delivery is delayed or permanently fails.

## 2. Architectural invariants

- Appointment and customer state remain authoritative. Notification state never determines appointment state.
- Notification intent is inserted in the same MongoDB transaction as the appointment create, reschedule, or cancellation mutation.
- The existing worker claims and delivers pending notification records. No new Railway service, external queue, Redis instance, cron service, or distributed cache is introduced.
- A transaction retry, public idempotency replay, HTTP retry, worker restart, or duplicate poll cannot create a duplicate logical notification.
- Tenant context comes from the appointment and its verified tenant relationship, never from an unverified job payload or browser-supplied tenant ID.
- Email content uses the immutable appointment snapshot for service, provider, duration, price facts, timezone, and customer-location facts. It must not silently adopt later catalog edits.
- The recipient is the appointment customer's normalized email captured when the notification intent is created. Later customer-record edits do not redirect an already queued email.
- Marketing consent is irrelevant to operational appointment email. No marketing permission is inferred or changed.
- Public and administrative browser sessions remain unchanged. No customer authentication or public session is introduced.
- No raw provider API token, email body, customer note, internal cancellation detail, full address, or public access token appears in ordinary logs or audit metadata.
- Existing safe errors, request IDs, role enforcement, optimistic concurrency, OpenAPI, validators, migrations, rollback, and accessibility rules remain in force.
- Material changes to these invariants require an ADR rather than an implementation-time redesign.

## 3. Approved design recommendations

| Decision              | Recommendation                                                                                                                                                                                                                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Delivery channel      | Email only. SMS, push, voice, and WhatsApp are deferred.                                                                                                                                                                                                                                     |
| Delivery architecture | MongoDB transactional outbox polled by the existing worker.                                                                                                                                                                                                                                  |
| Provider              | Use one explicitly approved transactional-email provider through one narrow provider client. Postmark is recommended for production transactional delivery; the final provider selection is an approval item.                                                                                |
| Triggered events      | Appointment created, rescheduled, and cancelled only.                                                                                                                                                                                                                                        |
| Reminders             | Deferred. PR 11 has no scheduled reminder engine.                                                                                                                                                                                                                                            |
| Recipient snapshot    | Store normalized recipient email and customer display name on the outbox record at intent creation.                                                                                                                                                                                          |
| Content snapshot      | Store a bounded, safe template-data snapshot sufficient to render the email. Do not store pre-rendered HTML or text in MongoDB.                                                                                                                                                              |
| Delivery guarantee    | At-least-once processing with application-level logical deduplication. Provider behavior is not described as exactly once.                                                                                                                                                                   |
| Retry policy          | Exponential backoff with bounded attempts and deterministic terminal failure.                                                                                                                                                                                                                |
| User-visible status   | `not_queued`, `pending`, `processing`, `sent`, or `failed`, exposed only in authenticated Business Hub appointment detail. Persisted provider acceptance remains `delivered` internally until a later migration can distinguish provider acceptance from webhook-confirmed mailbox delivery. |
| Public confirmation   | After commit, state that the appointment is booked and that a confirmation will be sent. Do not imply successful delivery before the provider accepts it.                                                                                                                                    |
| Public access tokens  | Not created. Future cancel/reschedule links require a dedicated PR with purpose-bound opaque tokens, hash-only persistence, expiry, revocation, rotation, and one-time/purpose restrictions.                                                                                                 |
| Retention             | Delivered and terminally failed operational records remain for 30 days, then TTL deletion is permitted. Domain appointment/audit records are unaffected.                                                                                                                                     |
| Tenant branding       | Use the approved public profile name, logo, primary color, public phone, public email, public website, and booking hostname. Fall back safely when optional values are absent.                                                                                                               |

## 4. Scope

### 4.1 Included

- Transactional email configuration for an eligible published or unpublished tenant.
- Notification intent creation from successful appointment create, reschedule, and cancellation transactions.
- Existing-worker polling, claiming, rendering, sending, retrying, and terminal failure handling.
- Tenant-branded responsive HTML and plain-text templates.
- Authenticated Business Hub delivery status on appointment detail.
- Owner/admin controls for sender display name and reply-to address, using existing public contact values as safe defaults.
- Migration, indexes, validator, seed data, OpenAPI, tests, operational logging, rollout, and rollback documentation.

### 4.2 Explicitly excluded

- SMS, push, voice, WhatsApp, or marketing email;
- reminders, follow-ups, recurring jobs, digest emails, campaigns, waitlists, or promotions;
- customer portal, customer login, magic links, cancellation links, rescheduling links, or public appointment access tokens;
- staff/provider notifications, invitations, password resets, or administrative authentication email;
- attachments, ICS calendar files, external calendar synchronization, or calendar subscriptions;
- payment receipts, invoices, refunds, deposits, taxes, payouts, commissions, or settlement messages;
- intake forms, waivers, documents, signatures, or file storage;
- provider choice changes, service changes, appointment workflow changes, or new appointment statuses;
- delivery webhooks, bounce suppression UI, inbound email, custom sending domains, or domain verification;
- new Railway services, external queue services, Redis, Kafka, scheduled infrastructure, or unrelated abstractions.

## 5. Data model

### 5.1 New `notification_outbox` collection

```text
_id: ObjectId
public_id: UUID string
tenant_id: ObjectId
appointment_id: ObjectId
appointment_public_id: UUID string
appointment_reference: string

notification_type:
  appointment_created |
  appointment_rescheduled |
  appointment_cancelled

channel: email
logical_key: string

recipient:
  email_normalized: string
  display_name: string

template_data:
  tenant_public_name: string
  tenant_logo_url: string | null
  tenant_primary_color: string
  tenant_public_phone: string | null
  tenant_public_email: string | null
  tenant_public_website: string | null
  public_booking_origin: string | null
  customer_display_name: string
  provider_display_name: string
  provider_photo_url: string | null
  service_name: string
  local_start: offset-qualified ISO string
  timezone: IANA timezone
  duration_minutes: integer
  appointment_reference: string
  delivery_mode: provider_location | customer_location | virtual
  location_summary: string | null
  cancellation_reason: structured reason | null

status: pending | processing | delivered | failed
attempt_count: integer
next_attempt_at: Date
claimed_at: Date | null
claim_expires_at: Date | null
claimed_by: string | null
last_error_code: string | null
provider_message_id: string | null
provider_accepted_at: Date | null
delivered_at: Date | null
failed_at: Date | null
expires_at: Date | null

source_request_id: string
created_at: Date
updated_at: Date
```

Rules:

- `logical_key` is server generated from tenant, appointment, notification type, and the appointment version produced by the mutation. Example: `{tenantPublicId}:{appointmentPublicId}:{type}:v{version}`.
- A unique tenant-scoped `logical_key` prevents duplicate intent records.
- `template_data` is immutable after insertion.
- `status`, claim fields, attempts, provider result, and timestamps are the only mutable fields.
- `recipient.email_normalized` is required and must pass the existing normalized email validation.
- Do not include the customer note, internal cancellation detail, full customer address, internal IDs, booking terms text, raw idempotency key, or management token.
- `location_summary` may contain only the public business location label/address approved for the email or the literal `Customer location`/`Virtual`. It must not copy a customer's full private address.
- `cancellation_reason` may contain the structured reason only. Internal cancellation detail remains Business Hub-only.
- Physical TTL deletion is allowed only for this operational outbox collection after its terminal retention period. Appointments, customers, and audit logs retain their existing lifecycle rules.

### 5.2 Tenant notification settings

Add to `tenants`:

```text
appointment_email_settings:
  enabled: boolean
  sender_name: string              # 1–100 characters
  reply_to_email: string | null    # normalized valid email
```

Defaults:

- `enabled=false` for all existing tenants during migration.
- Seeded staging tenants may be enabled only after a non-customer test recipient policy is approved.
- `sender_name` defaults to the tenant public name, then tenant display name.
- `reply_to_email` defaults to the explicit public email when available. It must never silently use a private administrative account email.

PR 11 does not add per-service, per-provider, or per-customer notification switches. Operational confirmation email is tenant controlled. Marketing preferences do not suppress it.

### 5.3 Appointment response addition

The authenticated appointment detail response adds:

```json
{
  "email_notifications": [
    {
      "type": "appointment_created",
      "status": "delivered",
      "attempt_count": 1,
      "updated_at": "2026-08-01T14:12:00.000Z"
    }
  ]
}
```

Do not expose recipient email, provider message ID, error details, claim data, or outbox public ID in the ordinary appointment response.

## 6. Notification intent rules

### 6.1 Eligibility

Create an email intent only when all are true:

1. the appointment mutation commits successfully;
2. tenant `appointment_email_settings.enabled=true`;
3. the active or newly created customer has a valid normalized email;
4. the event is one of the three approved notification types;
5. the same logical key does not already exist.

If email is disabled or unavailable, the appointment mutation succeeds without an outbox record. The authenticated detail response reports `not_queued` for the relevant event only where helpful; public responses do not reveal tenant email configuration.

### 6.2 Appointment creation

- Business Hub and public booking creation both qualify.
- Insert `appointment_created` in the same MongoDB transaction as the appointment and audit event.
- A PR 10 idempotency replay returns the original appointment and must not insert another outbox record.
- Existing appointments are not backfilled and receive no retrospective confirmation.

### 6.3 Rescheduling

- Insert `appointment_rescheduled` in the same transaction as the successful interval change.
- Use the retained immutable appointment snapshot and new scheduled interval.
- A no-change or rejected reschedule creates no notification.
- Each successful reschedule version has one logical notification.

### 6.4 Cancellation

- Insert `appointment_cancelled` in the same transaction as the successful cancellation.
- A repeated idempotent cancellation creates no duplicate notification.
- Include the customer-safe structured cancellation reason. Exclude internal detail and actor identity.

### 6.5 Completion and no-show

PR 11 sends no completion or no-show email. Those transitions remain unchanged.

## 7. Worker processing contract

### 7.1 Polling

- The existing worker polls `notification_outbox` for `pending` records whose `next_attempt_at <= now` and expired `processing` claims.
- Default poll interval: 5 seconds.
- Claim batch size: 10.
- Claim one record atomically with `findOneAndUpdate`, sorted by `next_attempt_at`, then `created_at`.
- Claim lease: 2 minutes.
- Each Railway replica uses its Railway-provided instance/deployment identifier when available, otherwise a generated process UUID. This identifier is operational only.
- Worker shutdown stops polling, waits up to 15 seconds for the active send, releases an unsent claim when safe, closes MongoDB, and preserves existing lifecycle logs.

### 7.2 Sending

1. Validate the claimed record against the persisted schema.
2. Render both plain text and responsive HTML from version-controlled templates.
3. Send through the approved provider with the logical key supplied as provider metadata when supported.
4. On provider acceptance, record `provider_message_id`, `provider_accepted_at`, `delivered_at`, set `status=delivered`, and set `expires_at=delivered_at + 30 days`.
5. Provider acceptance is the PR 11 meaning of `delivered`; mailbox delivery is not asserted without webhook support.

### 7.3 Retry and failure

Retry transient network failures, timeouts, provider `429`, and provider `5xx` responses.

```text
maximum attempts: 6
backoff after failure: 1m, 5m, 15m, 1h, 6h
jitter: deterministic bounded jitter derived from public_id
```

Do not retry invalid recipient, rejected sender, invalid template data, provider authentication, or other permanent `4xx` errors except `408`/`429`. Permanent errors become `failed` immediately. Exhausted transient errors become `failed` after attempt six. Set `expires_at=failed_at + 30 days`.

Ordinary logs contain event, outbox public ID, tenant public ID when available, appointment public ID, notification type, attempt count, normalized error category, duration, and request/correlation ID. They do not contain email address, names, message content, customer note, internal cancellation detail, or provider token.

## 8. Email content contract

### 8.1 Common structure

All current and future transactional appointment templates must compose one version-controlled common branded layout rather than duplicating headers, summaries, contact blocks, or responsive styles. Event templates provide only their event-specific subject, heading, support copy, and optional customer-safe reason.

- Tenant logo or initials fallback.
- Tenant public business name as the dominant identity.
- Customer-friendly heading.
- Service, provider, tenant-local date/time, timezone abbreviation where unambiguous, duration, and appointment reference.
- Delivery-mode-safe location summary.
- Tenant public contact and website when configured.
- A short statement that BookNowTech does not need to appear in customer-facing content.
- Plain-text alternative with equivalent facts and logical reading order.

### 8.2 Customer-friendly copy

Created subject:

```text
Your appointment with {Business name} is confirmed
```

Created heading:

```text
You're booked!
```

Created support copy:

```text
We look forward to seeing you. Keep this email and appointment reference for your records.
```

Rescheduled subject:

```text
Your appointment with {Business name} has been rescheduled
```

Cancelled subject:

```text
Your appointment with {Business name} has been cancelled
```

Do not include raw UTC, blocked buffer intervals, catalog booking fee calculations, customer note, internal cancellation detail, administrative actor, or unsupported cancel/reschedule links.

## 9. API and Business Hub

### 9.1 Settings endpoints

Use existing authenticated administrative conventions:

| Method | Endpoint                                   | Purpose                        |
| ------ | ------------------------------------------ | ------------------------------ |
| `GET`  | `/api/v1/admin/appointment-email-settings` | Read tenant settings           |
| `PUT`  | `/api/v1/admin/appointment-email-settings` | Update with `expected_version` |

Permissions:

| Action                           | tenant_owner | tenant_admin | front_desk | provider |
| -------------------------------- | -----------: | -----------: | ---------: | -------: |
| View settings                    |          Yes |          Yes |         No |       No |
| Update settings                  |          Yes |          Yes |         No |       No |
| View appointment delivery status |          Yes |          Yes |        Yes |       No |

Every request revalidates session membership and role, derives tenant context from the selected verified membership, requires CSRF for mutations, and uses safe `404` behavior. Body/query/header tenant IDs are ignored as authorization context.

Update payload:

```json
{
  "expected_version": 12,
  "enabled": true,
  "sender_name": "Brazilian Wax Demo",
  "reply_to_email": "appointments@example.com"
}
```

This update increments the tenant version and writes one `appointment_email_settings_updated` audit event containing prior/new enabled state and version only. Do not audit email addresses or sender content.

### 9.2 UI

- Add an `Appointment emails` section within the existing Public booking/settings area; do not add another top-level navigation item.
- Explain that confirmation, reschedule, and cancellation emails are operational, not marketing.
- Show enabled status, sender name, reply-to email, and a clear save confirmation.
- Do not add a send-test button in PR 11; avoiding test-send semantics keeps anonymous/destination controls out of scope.
- Appointment detail shows a compact `Email delivery` section with event label, status, attempt count, and last update.
- Failed status says: `Email could not be delivered. The appointment is still scheduled.` It does not expose provider error details.
- Public confirmation says: `You're booked! We'll send a confirmation email shortly.` If the tenant has email disabled, use the existing save-reference message instead. The public API may return a safe boolean `confirmation_email_queued`; it must not return delivery state or provider information.

## 10. Safe errors and validation

- Appointment mutations never return an error because notification insertion is ineligible due to missing email or disabled settings.
- If an eligible outbox insert unexpectedly fails inside the transaction, the appointment transaction fails and follows the existing safe appointment error contract; this preserves the invariant that enabled, eligible committed events have durable intent.
- Settings validation uses `400 validation_error`, `401`, `403`, safe `404`, `409 version_conflict`, and existing response envelopes.
- Worker/provider failures never become public API errors after appointment commit.
- Sender name is trimmed plain text, 1–100 characters, without control characters or HTML.
- Reply-to is null or a valid normalized email up to 320 characters.
- Template strings are escaped by default. Primary color uses the existing validated hex format.
- URLs must use the existing HTTPS validation and are rendered as attributes only after validation.

## 11. Indexes and validator

Create:

```text
notification_outbox_public_id_unique
  { public_id: 1 } unique

notification_outbox_logical_key_unique
  { tenant_id: 1, logical_key: 1 } unique

notification_outbox_pending_poll
  { status: 1, next_attempt_at: 1, created_at: 1 }

notification_outbox_appointment
  { tenant_id: 1, appointment_id: 1, created_at: 1 }

notification_outbox_claim_expiry
  { status: 1, claim_expires_at: 1 }

notification_outbox_ttl
  { expires_at: 1 } expireAfterSeconds: 0
```

The validator must require the complete record shape, reject unknown fields, enforce enums and bounded strings, and allow `expires_at=null` only before a terminal state. The migration adds tenant settings with disabled defaults and is idempotent.

No appointment index or customer index is added unless explain-plan evidence demonstrates a missing approved query path.

## 12. Configuration and Railway changes

### 12.1 API

No provider secret belongs in the API service. The API uses its existing MongoDB configuration.

### 12.2 Worker

The worker requires:

```text
MONGODB_URI=<existing Atlas connection secret>
MONGODB_DATABASE=booknowtech_staging
TRANSACTIONAL_EMAIL_PROVIDER=postmark
TRANSACTIONAL_EMAIL_TOKEN=<secret>
TRANSACTIONAL_EMAIL_FROM=<verified sender address>
```

Requirements:

- Add exact validation to the existing worker environment schema.
- Do not print or expose secrets.
- `TRANSACTIONAL_EMAIL_FROM` must be a verified sender controlled by BookNowTech for PR 11. Per-tenant From addresses and custom sending domains are deferred.
- Tenant-specific replies use validated `Reply-To`, not arbitrary `From`.
- Staging and production use separate provider credentials/streams when supported.
- No frontend build variable is added.
- No new Railway service is created.

## 13. Audit and observability

Domain audit events:

- existing appointment-created/rescheduled/cancelled audit events remain authoritative;
- `appointment_email_settings_updated` is added;
- do not add audit events for every delivery attempt;
- add one `appointment_email_delivery_failed` audit event only when a notification becomes terminally failed, containing appointment public ID, notification type, attempts, and normalized failure category—no recipient or content.

Structured worker events:

```text
notification.claimed
notification.delivery_accepted
notification.delivery_retry_scheduled
notification.delivery_failed
notification.claim_recovered
```

Metrics derivable from logs/outbox:

- pending age;
- accepted count and latency;
- retry count;
- terminal failure count;
- recovered stale claims.

PR 11 does not add a monitoring vendor or dashboard service.

## 14. Migration and seed plan

Migration command:

```shell
pnpm --filter @booknowtech/api db:migrate
```

Seed command:

```shell
pnpm --filter @booknowtech/api db:seed:development
```

Migration behavior:

1. create/update `notification_outbox` validator;
2. create required indexes idempotently;
3. add disabled appointment email settings to tenants lacking them;
4. preserve tenant versions and existing records during mechanical backfill;
5. verify validators and named indexes;
6. do not create notifications for historical appointments.

Seed behavior:

- Keep appointment email disabled by default unless a staging-only approved sink/test inbox is configured.
- Seed sender name and null reply-to deterministically.
- Do not seed a real customer's address or cause seed execution to send email.
- Seed remains idempotent and does not enqueue notifications.

## 15. Automated tests

### 15.1 API and transaction tests

- Public and Business Hub appointment creation inserts exactly one eligible intent in the same transaction.
- Transaction rollback removes both appointment/customer changes and notification intent.
- Missing customer email or disabled tenant commits appointment without intent.
- PR 10 idempotency replay creates no duplicate intent.
- Concurrent duplicate logical inserts produce one intent.
- Successful reschedule and cancellation create correct version-scoped events.
- No-change/rejected/repeated lifecycle actions create no intent.
- Completion and no-show create no intent.
- Tenant isolation and cross-tenant safe `404` behavior.
- Settings permissions, CSRF, validation, optimistic concurrency, and audit redaction.
- Appointment detail returns safe delivery summaries only.

### 15.2 Worker tests

- Atomic claim ordering and multi-worker exclusion.
- Claim lease expiry and recovery after simulated crash.
- Success stores provider acceptance once.
- Transient retry schedule and deterministic jitter.
- Permanent failure and attempt exhaustion.
- No resend of delivered records.
- Graceful shutdown with no abandoned live claim.
- Provider token and PII redaction from logs/errors.
- HTML escaping and plain-text equivalence.
- Every template renders with optional branding/contact fields absent.

### 15.3 Mongo-backed tests

- Validator accepts valid records and rejects unknown/invalid fields.
- Unique logical key prevents duplicates.
- Poll and appointment-status queries use named indexes.
- TTL index exists with `expireAfterSeconds=0`.
- Migration is idempotent.
- Transaction rollback and concurrent claim behavior use a replica-set-capable MongoDB test environment.

### 15.4 Frontend and accessibility tests

- Settings render/save/validation and role restrictions.
- Clear saved, pending, delivered, and failed states.
- Public confirmation copy reflects queued versus not queued safely.
- Keyboard operation, visible focus, semantic headings/labels, error association, and `aria-live` save/status announcements.
- Mobile layout has no horizontal scrolling and preserves touch targets.

### 15.5 Canonical gates

```shell
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm audit --audit-level=high
```

Do not weaken or skip a CI, migration, lint, type, security, or test gate.

## 16. Performance expectations

| Operation                                                          |                                       Target |
| ------------------------------------------------------------------ | -------------------------------------------: |
| Added appointment transaction work at p95                          | <= 50 ms excluding existing transaction cost |
| Outbox claim query at p95 with 100,000 retained rows               |                                    <= 100 ms |
| Time from commit to first send attempt at p95 while worker healthy |                                <= 15 seconds |
| Provider request timeout                                           |                           10 seconds maximum |
| Appointment detail notification summary at p95                     |                      <= 100 ms database time |

Use explain plans and a synthetic outbox dataset for poll and appointment-summary queries. External provider latency is reported separately and cannot be represented as application database latency.

## 17. Security and privacy

- Provider secrets exist only in the worker environment and are redacted.
- Email addresses and display names are not logged or audited.
- Message bodies are not persisted or logged.
- Template rendering escapes untrusted text and does not allow tenant-supplied HTML.
- All links are allowlisted validated HTTPS values. PR 11 creates no action links.
- Public hostname remains the tenant's active fallback booking hostname. Custom-domain provisioning remains deferred.
- Outbox access has no public API.
- Authenticated summaries never expose another tenant's notification records.
- Operational outbox PII has a bounded 30-day terminal retention period.
- The provider account must have MFA and least-privilege transactional sending access.

## 18. Rollout

1. Merge only after canonical and Mongo-backed checks pass.
2. Deploy API and worker with tenant settings disabled.
3. Run the idempotent migration and verify validator/indexes.
4. Configure worker MongoDB and approved provider secrets in Railway.
5. Redeploy worker; verify healthy polling with no pending records and no secret output.
6. Configure a staging sink/test inbox and verified From address.
7. Enable one seeded staging tenant.
8. QA public and Business Hub creation, reschedule, cancellation, idempotency replay, retry, terminal failure display, branding, plain text, mobile, and accessibility.
9. Confirm appointment creation remains successful when tenant email is disabled or customer email is absent.
10. Monitor pending age, retries, and failures before enabling another tenant.

Do not enable production tenants automatically in migration or seed.

## 19. Rollback

Application rollback order:

1. set tenant `appointment_email_settings.enabled=false`;
2. stop or redeploy the worker to the prior release;
3. deploy the prior API/frontend release;
4. retain `notification_outbox` and additive tenant fields during rollback;
5. do not drop the collection or indexes while any newer process may run;
6. inspect pending records before any later re-enable to avoid unexpected delayed sends.

Disabling email prevents new intent creation. Pending records must not be sent while their tenant is disabled; the worker revalidates current tenant enabled state immediately before sending and moves such records to terminal `failed` with normalized category `tenant_disabled`, without customer-facing effects.

Database rollback is additive: validators may remain compatible, and no destructive down migration is required. TTL cleanup continues for terminal records.

## 20. Acceptance checklist

- [ ] Creating an eligible public appointment commits one appointment and one confirmation intent atomically.
- [ ] Creating an eligible Business Hub appointment does the same.
- [ ] The customer receives tenant-branded HTML and plain-text confirmation with correct immutable appointment facts.
- [ ] Reschedule and cancellation send the approved customer-safe messages.
- [ ] PR 10 replay, HTTP retry, transaction retry, and worker retry do not create duplicate logical emails.
- [ ] Disabled tenant or missing customer email does not block appointment creation.
- [ ] Provider outage delays email without changing appointment state.
- [ ] Transient errors retry; permanent/exhausted errors become visible to staff without exposing PII.
- [ ] Worker crash recovery does not lose a durable intent.
- [ ] Cross-tenant requests cannot read settings or delivery state and return safe responses.
- [ ] Owner/admin can update settings; front desk/provider cannot.
- [ ] Appointment detail exposes only safe delivery summaries.
- [ ] Logs and audit metadata contain no recipient email, names, notes, private address, internal cancellation detail, message body, or provider secret.
- [ ] Migration, validator, indexes, TTL, seed idempotency, explain plans, and rollback are verified in staging.
- [ ] No historical appointment email is sent during migration or seed.
- [ ] No new Railway service, external queue, Redis instance, customer session, or public access token is introduced.
- [ ] Canonical CI, Mongo-backed tests, accessibility checks, desktop QA, and mobile QA pass.

## 21. Definition of Done

PR 11 is done only when:

1. every acceptance item is evidenced;
2. provider selection and secrets are approved and configured securely;
3. API, worker, frontend, migration, seed, OpenAPI, tests, and runbook are complete;
4. the staging tenant completes creation, reschedule, cancellation, retry, failure, and deduplication QA;
5. Railway API/frontend/worker deploy from the same merged commit and remain healthy;
6. Atlas validator and index verification is recorded;
7. rollback is rehearsed by disabling the tenant and proving pending work does not send;
8. remaining exclusions are not represented as partially working UI.

## 22. Decisions requiring approval before implementation

1. **Transactional provider:** Approve Postmark, or identify the approved alternative. The contract assumes a provider with an HTTPS API, verified sender support, metadata, and stable message IDs.
2. **From address:** Confirm the BookNowTech-controlled verified sender address for staging and production. Tenant-specific From domains remain deferred.
3. **Retention:** Approve 30-day TTL retention for delivered and terminally failed outbox records.
4. **Event scope:** Confirm PR 11 sends created, rescheduled, and cancelled email only—no reminders, completion, or no-show messages.
5. **Settings placement:** Confirm appointment email controls live inside the existing Public booking/settings area rather than a new top-level page.
6. **Public wording:** Approve `You're booked! We'll send a confirmation email shortly.` when intent was queued and the existing save-reference wording otherwise.
7. **Provider acceptance terminology:** Approved: Business Hub displays `Sent` for provider API acceptance. `Delivered` remains an internal persistence status only until a later webhook PR can confirm mailbox delivery and introduce accurate persisted acceptance/delivery distinctions.

Implementation is authorized subject to the approved provider credentials and sender address being supplied during staging rollout. The common branded template layout and user-facing `Sent` terminology are mandatory.

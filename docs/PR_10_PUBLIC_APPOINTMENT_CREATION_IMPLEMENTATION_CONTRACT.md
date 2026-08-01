# PR 10 — Public Appointment Creation Implementation Contract

**Status:** Accepted — implementation authorized  
**Scope:** Guest customer capture, transactional public appointment creation, and on-screen confirmation

## 1. Objective

PR 10 turns the PR 9 public discovery flow into the smallest safe public-write workflow. A guest visiting a resolved public booking hostname can choose an eligible service, provider, date, and current start; enter the required contact and location information; review the booking; submit once; and receive an on-screen confirmation.

PR 10 must reuse:

- the PR 7 tenant-scoped customer record, normalization, and duplicate-detection rules;
- the PR 8 appointment model, immutable snapshots, references, MongoDB transactions, provider/day schedule locks, and conflict prevention;
- the PR 9 hostname resolution, public publication controls, eligibility rules, policy precedence, public field allowlists, scheduling APIs, trusted-proxy handling, and rate-limiter pattern.

PR 10 does not create a second customer model, appointment engine, slot engine, conflict strategy, hostname resolver, or public session system.

The deliverable is:

1. one public appointment-submission endpoint;
2. one deterministic, tenant-local customer matching policy;
3. idempotent appointment creation without a new collection or service;
4. final transactional revalidation and schedule locking;
5. an accessible review, submission, and confirmation UI;
6. safe operational and audit evidence without unnecessary PII.

## 2. Architectural invariants

- Public tenant context comes exclusively from the existing normalized, trusted request hostname.
- Request bodies, query parameters, headers other than the defined idempotency header, browser storage, and cookies never supply tenant authorization context.
- Administrative and public sessions remain separate. Public creation does not read or create `admin_sessions`.
- The public endpoint may create or reuse one tenant customer and create one tenant appointment only. It cannot mutate catalog, provider, assignment, availability, existing customer, or existing appointment records.
- Every lookup and write includes the hostname-resolved tenant `_id` and current public eligibility predicates.
- A displayed start is advisory. Submission revalidates all business rules inside the same transactional workflow used by PR 8.
- Existing provider/day schedule locks remain the only concurrency mechanism for appointment overlap.
- `accepting_new_clients=true` is required for public creation even though it is not required for internal Business Hub creation.
- Appointment and customer records are never physically deleted.
- MongoDB ObjectIds, customer-match outcomes, contact data, internal notes, blocked intervals, lock records, and ineligibility reasons never appear in public responses.
- Existing request IDs, envelopes, safe errors, OpenAPI, validators, migrations, logging, accessibility, and rollback conventions remain in force.
- No new Railway service, variable, worker responsibility, queue, distributed cache, public session, or architectural abstraction is introduced.
- Future verified custom booking domains must continue to enter through the existing hostname-resolution abstraction; PR 10 does not provision or store them.

## 3. Approved design recommendations

| Decision                | Recommendation                                                                                                                                                                                                                                                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Idempotency transport   | Require an `Idempotency-Key` header containing a client-generated UUID for every public submission.                                                                                                                                                                                                                                     |
| Idempotency persistence | Store only a SHA-256 key hash and canonical request fingerprint on the successfully created appointment. Use a tenant-scoped partial unique index; do not add an idempotency collection.                                                                                                                                                |
| Retry behavior          | Same tenant, key, and fingerprint returns the original safe confirmation with `200` and `replayed=true`. Same key with another fingerprint returns `409 idempotency_key_reused`.                                                                                                                                                        |
| Customer matching       | Reuse one active tenant customer when the submitted identifiers resolve unambiguously to that record and no stored identifier conflicts. Exact email-and-phone agreement remains strongest; one unique match may reuse a record only when its other stored identifier is absent and the submitted identifier matches no other customer. |
| Conflicting matches     | If email and phone resolve to different records, or either identifier has multiple matches, create a separate customer. Never merge, update, reveal, or choose between matches publicly.                                                                                                                                                |
| Customer mutation       | Public submission never updates an existing customer. Corrections remain an authenticated Business Hub workflow.                                                                                                                                                                                                                        |
| Confirmation            | On-screen only in PR 10. No email or SMS delivery is implied or queued.                                                                                                                                                                                                                                                                 |
| Payment                 | The appointment is created with existing status `scheduled` without payment. Catalog price and fee snapshots remain informational facts only.                                                                                                                                                                                           |
| Terms                   | Require acceptance of the currently published booking-terms version and store its version and acceptance timestamp on the appointment. Do not store terms text on every appointment.                                                                                                                                                    |
| Communications          | Appointment-related operational contact is acknowledged separately from marketing. Marketing email/SMS remain `unknown`; no marketing opt-in is presented or inferred.                                                                                                                                                                  |
| Lost-slot behavior      | Return `409 slot_no_longer_available` with no customer/appointment persistence and direct the UI back to current times.                                                                                                                                                                                                                 |
| Any provider            | Remains deferred. A specific provider public ID is required.                                                                                                                                                                                                                                                                            |
| Public response         | Return the appointment reference and safe booking facts, including the provider's current public photo URL when configured. Do not return contact values, match results, ObjectIds, blocked intervals, or audit fields.                                                                                                                 |
| Appointment note        | Accept one optional plain-text customer note and store it only in the immutable appointment snapshot. Never copy it to the customer, audit metadata, URLs, or ordinary logs.                                                                                                                                                            |
| Future public access    | Do not mint access tokens in PR 10. A later cancellation/rescheduling PR will use purpose-bound opaque bearer tokens whose hashes—not raw values—are stored with expiry, revocation, and rotation semantics.                                                                                                                            |

## 4. Data-model changes

### 4.1 Customer records

No new customer collection or general customer field is required. PR 10 uses the PR 7 `customers` collection and existing fields:

```text
first_name
last_name
preferred_name = null
email_normalized
mobile_phone_e164
mobile_phone_digits
addresses
communication_preferences
source = public_booking
status = active
version and audit fields
```

A newly created public customer has:

```text
communication_preferences:
  preferred_channel: email | sms
  marketing_email: unknown
  marketing_sms: unknown
```

The preferred operational channel is derived deterministically from the submitted `preferred_contact_channel`. This field does not constitute marketing consent.

`first_seen_at` remains deferred. PR 10 has a reliable `created_at` for newly created customers, but a reused customer may have existed before public booking. Introducing a second acquisition timestamp without import precedence and backfill semantics would create ambiguous history.

### 4.2 Appointment additions

Extend `appointments.source`:

```text
business_hub | public_booking
```

Add nullable fields that are required only for public submissions:

```text
public_submission: null | {
  idempotency_key_hash: string       # lowercase SHA-256 hex, 64 characters
  request_fingerprint: string        # lowercase SHA-256 hex, 64 characters
}

booking_terms: null | {
  version: string                    # immutable configured version, max 64
  accepted_at: Date                  # server timestamp
}

snapshot.customer_note: null | string # plain text, trimmed, maximum 1,000 characters
```

For `source=public_booking`, both embedded objects are required. For `source=business_hub`, both remain `null` unless a later approved migration defines otherwise.

Do not store the raw idempotency key, IP address, user agent, booking terms text, marketing consent, honeypot value, or customer-match result on the appointment. `snapshot.customer_note` is the only PR 10 notes field. It is visible only through the existing authorized Business Hub appointment detail response and is excluded from public responses and audit metadata.

All existing appointment snapshots, location copying, `local_start_date` derivation, immutable human-readable reference, lifecycle, and financial non-calculation rules remain unchanged.

### 4.3 Tenant booking terms

Add to `tenants`:

```text
public_booking_terms:
  version: string                    # default "1"
  acknowledgment_label: string       # max 300; plain text only
  terms_url: null | HTTPS URL         # max 2,048
```

The label must describe booking terms and cancellation-policy acknowledgment. It must not bundle marketing consent. The existing administrative Public Booking settings page may edit these fields for `tenant_owner` and `tenant_admin` using the existing optimistic concurrency, CSRF, role, audit, and safe-404 patterns.

## 5. Deterministic customer matching

### 5.1 Normalization

Before the transaction, validate shape. Inside the transaction, rerun canonical normalization using the existing PR 7 functions:

- email: trim and lowercase to `email_normalized`;
- mobile: accept the existing US-friendly input and normalize to E.164;
- names: use existing trimmed/normalized name rules;
- address: use the existing customer address schema and server-generated address `public_id`.

### 5.2 Matching algorithm

Within the resolved tenant and transaction:

1. Query active customers matching the normalized email, capped at two.
2. Query active customers matching the normalized mobile phone, capped at two.
3. Reuse the customer when each query returns exactly one record and both records have the same `_id`.
4. If exactly one identifier uniquely matches one active customer, reuse it only when that customer's other stored identifier is absent and the submitted other identifier matches no active customer. This supports legacy/imported partial records without attaching a guest to a record containing conflicting contact data.
5. If the uniquely matched customer has a different non-null stored value for the other identifier, if email and phone resolve to different records, or if either query is ambiguous, run the existing duplicate classifier and create a separate `source=public_booking` customer.
6. Never reactivate, merge, or update a customer during public booking.

This deliberately favors privacy and ownership safety over aggressive de-duplication while avoiding unnecessary duplicates for imported records that contain only one verified contact method. It prevents a shared household email, shared phone, typo, or conflicting identity from attaching a guest appointment to the wrong master record. Matching is always tenant-local, uses exact normalized identifiers only, and never introduces a platform-wide person identity. Future configurable/fuzzy matching or merge workflows require a separately approved customer-data PR.

The public response, error, timing contract, logs, and UI do not reveal whether a customer was reused or created.

### 5.3 Transaction behavior

Customer creation and appointment creation occur in the same MongoDB transaction. If appointment validation, conflict detection, unique idempotency insertion, or commit fails, the newly created customer is rolled back. A failed public booking cannot leave an orphan customer.

## 6. Public appointment submission API

### 6.1 Endpoint

```text
POST /api/v1/public/appointments
Host: {tenant-slug}.booknowtech.com
Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000
Content-Type: application/json
```

The endpoint is anonymous, hostname scoped, request-body limited, rate limited, and exempt from administrative CSRF because it does not use an authenticated browser session. Same-origin checks and allowed content type still apply.

### 6.2 Request

```json
{
  "service_public_id": "5c71e00f-5761-49f4-a17a-7b66cc55cdac",
  "provider_public_id": "b32a897d-cf3d-465b-92bb-54dc5152d14f",
  "starts_at": "2026-08-10T13:00:00.000Z",
  "customer": {
    "first_name": "Jordan",
    "last_name": "Lee",
    "email": "jordan.lee@example.test",
    "mobile_phone": "(843) 555-0104",
    "preferred_contact_channel": "email",
    "customer_location_address": null,
    "appointment_note": "Please allow a few extra minutes for parking instructions."
  },
  "consent": {
    "booking_terms_version": "1",
    "booking_terms_accepted": true
  },
  "website": ""
}
```

`website` is a visually hidden, accessible-safe honeypot field. Normal clients submit an empty string. A non-empty value returns the same generic accepted-style failure behavior documented in the abuse section and creates nothing.

Clients cannot submit tenant, hostname, customer public ID, assignment, duration, end time, buffers, timezone, local date, price, fee, currency, appointment reference, status, source, snapshots, blocked intervals, terms label, or audit fields.

### 6.3 Required guest fields

- `first_name`: required, 1–100 characters after trimming;
- `last_name`: required, 1–100 characters after trimming;
- `email`: required, valid normalized email, maximum 320 characters;
- `mobile_phone`: required, valid under existing US/E.164 rules;
- `preferred_contact_channel`: required, `email | sms`;
- `customer_location_address`: required only when the snapshotted delivery mode is `customer_location`; prohibited otherwise;
- `appointment_note`: optional plain text, trimmed, maximum 1,000 characters; stored only on the appointment snapshot;
- booking-terms acceptance: required and must match the current tenant version.

No optional marketing checkboxes are included in PR 10.

### 6.4 Canonical fingerprint

The server canonicalizes the validated request fields in a fixed documented order after normalization and hashes the representation with SHA-256. The fingerprint includes service, provider, UTC start, normalized guest identity/contact, normalized required address, preferred channel, and terms version. It excludes hostname-derived tenant ID, honeypot, request ID, IP, user agent, and server timestamps.

### 6.5 Successful response

First creation returns `201`; an idempotent replay returns `200` with the same `data` and `replayed=true`.

```json
{
  "data": {
    "appointment_reference": "BNT-2026-000184",
    "status": "scheduled",
    "business": {
      "name": "Brazilian Wax Demo"
    },
    "service": {
      "name": "Brazilian Wax",
      "duration_minutes": 30
    },
    "provider": {
      "display_name": "Lisa",
      "photo_url": "https://cdn.example.test/providers/lisa.jpg"
    },
    "starts_at": "2026-08-10T13:00:00.000Z",
    "ends_at": "2026-08-10T13:30:00.000Z",
    "local_start": "2026-08-10T09:00:00-04:00",
    "timezone": "America/New_York",
    "location_mode": "provider_location",
    "replayed": false
  }
}
```

`provider.photo_url` is nullable, comes from the provider's current safe public profile, and is not added to the immutable appointment snapshot. The confirmation UI uses it when available and an initials avatar otherwise.

Do not return appointment UUID, customer public ID, customer name, email, phone, address, appointment note, matching decision, prices beyond already reviewed UI state, blocked intervals, terms acceptance record, or internal metadata. The reference is sufficient for on-screen confirmation and future staff support.

## 7. Transaction and conflict algorithm

1. Resolve and validate the trusted hostname using PR 9.
2. Enforce content type, body size, rate limit, idempotency-key shape, honeypot, and payload validation.
3. Resolve the active published tenant, active publicly bookable service, active eligible provider, and active provider-service assignment using tenant-scoped public IDs.
4. Compute the canonical fingerprint.
5. Check for an appointment with the tenant and idempotency-key hash. If found, compare fingerprints and return replay or conflict.
6. Compute candidate duration, buffers, blocked interval, and intersected UTC dates from current records.
7. Ensure the existing provider/day schedule-lock documents exist, then start a MongoDB transaction.
8. Increment applicable locks in deterministic PR 8 order.
9. Re-read the tenant, publication state, terms version, service, provider, assignment, schedule, breaks, closures, time off, booking policy, and idempotency record inside the transaction.
10. Require current service/provider/assignment public eligibility, including `customer_selectable=true` and `accepting_new_clients=true`.
11. Reapply service override → tenant default → platform-safe booking policy using current server time.
12. Re-run the existing deterministic slot engine for the exact UTC start and subtract current scheduled appointments.
13. If unavailable, abort with `409 slot_no_longer_available` and persist nothing.
14. Match or create the customer under Section 5.
15. Generate the appointment reference, copy the existing PR 8 snapshots/location, set `source=public_booking`, and insert the appointment with idempotency and terms data.
16. Commit. Emit one appointment audit event only after successful commit.

Driver whole-transaction retries rerun every read, rule, match, and write. Concurrent identical submissions either replay the committed appointment or lose on the unique idempotency index and then read/replay it. Concurrent different submissions for the same provider/time serialize through the existing locks; only one can commit.

## 8. Idempotency rules

- Header is required and must be a canonical UUID string.
- Keys are scoped to the resolved tenant and retained with the appointment for its lifecycle.
- Raw keys are never logged or stored.
- The tenant-scoped partial unique index applies only to public appointments with a string hash.
- Same key + same fingerprint: return original safe confirmation; no new customer, appointment, version, reference, audit event, or schedule-lock side effect.
- Same key + different fingerprint: `409 idempotency_key_reused`.
- A validation, rate-limit, honeypot, eligibility, lost-slot, or transaction failure does not consume a key.
- The frontend creates one key when the review step becomes submittable and retains it for retries of that unchanged review. Editing any fingerprinted field creates a new key.
- The submit button disables while pending. UI behavior supplements but never replaces server idempotency.

## 9. Safe errors

| Condition                                                                          | HTTP | Public code                      |
| ---------------------------------------------------------------------------------- | ---: | -------------------------------- |
| Unknown, inactive, unpublished, or cross-tenant tenant/service/provider/assignment |  404 | `public_booking_not_found`       |
| Invalid body, contact, address, terms, date, or header                             |  400 | `invalid_public_booking_request` |
| Current terms version changed                                                      |  409 | `booking_terms_changed`          |
| Same idempotency key with another fingerprint                                      |  409 | `idempotency_key_reused`         |
| Time no longer eligible or was taken                                               |  409 | `slot_no_longer_available`       |
| Rate limit exceeded                                                                |  429 | `public_rate_limit_exceeded`     |
| Unexpected internal failure                                                        |  500 | `public_booking_failed`          |

Errors include the existing request/support reference and no ObjectIds, customer existence, conflicting appointment, blocked reason, stack trace, database detail, match result, or tenant detail. Eligibility failures intentionally share one safe `404` envelope.

For `slot_no_longer_available`, the UI preserves service/provider/date, clears the selected time and idempotency key, reloads current starts, moves focus to the Time heading, and announces that the selected time is no longer available.

## 10. Security and abuse protection

- Maximum JSON body: 16 KiB.
- Accept only `application/json`.
- Reuse trusted proxy/IP derivation and hostname normalization from PR 9.
- Retain PR 9 read limits and add a stricter submission limiter: 5 attempts per 10 minutes and 20 per 24 hours for the bounded per-replica key `effective IP + normalized hostname`.
- Add a second bounded per-replica tenant-wide ceiling of 120 attempts per 10 minutes to contain distributed low-volume abuse against one tenant.
- Counters are capped and expired; they never include email, phone, name, or raw idempotency key.
- The documented limitation remains: limits are per replica, not global. If replica count or threat level requires a shared guarantee, stop for an ADR rather than introducing infrastructure inside PR 10.
- Reject non-empty honeypot submissions without logging the value. Return a generic response timing envelope and persist nothing.
- Use constant response shapes for customer creation and reuse.
- Never place guest PII in URLs, analytics, audit metadata, rate-limit keys, request logs, or error messages.
- Redact the public request body from ordinary structured HTTP logs. Log only route, hostname hash/tenant public identifier already considered safe internally, outcome code, duration, request ID, and idempotency-key hash prefix if required for diagnosis.
- Apply existing security headers, HTTPS, same-origin browser requests, and public CORS policy.

PR 10 does not add CAPTCHA. If staging evidence shows automation controls above are insufficient, CAPTCHA/vendor adoption requires a separately approved security/infrastructure decision.

## 11. Audit and operational logging

Successful first creation emits:

```text
public_appointment_created
```

Audit metadata contains appointment public ID/reference, customer public ID, provider/service public IDs, source, UTC start/end, request ID, and `customer_resolution=created|reused`. It excludes names, email, phone, address, raw/hash idempotency key, fingerprint, IP, user agent, terms text, and marketing fields.

Idempotent replays, validation errors, safe 404s, rate limits, lost slots, and failed transactions do not create audit events. Bounded operational logs/metrics record their stable outcome codes without PII. Customer creation as part of the transaction does not emit a second actor-based administrative audit event; the public appointment event is the atomic public workflow evidence.

## 12. Public UI workflow

Extend the PR 9 route without introducing a second public app:

```text
business → service → provider → date → time → details → review → confirmation
```

### 12.1 Details

- Required labeled first name, last name, email, mobile phone, and preferred contact channel.
- US-friendly phone placeholder and input guidance consistent with PR 7.
- Address fields render only for `customer_location` services.
- The hidden honeypot is excluded from keyboard navigation and assistive technology.
- No customer lookup, account prompt, marketing checkbox, payment field, or public indication of an existing customer.

### 12.2 Review

- Show tenant branding, service, provider, tenant-local date/time, duration, location mode, catalog price, and booking fee as display facts.
- Show the configured terms acknowledgment with an HTTPS terms link when present.
- State clearly that confirmation is immediate and no payment is collected.
- A single primary `Book appointment` action is disabled until required fields and terms are valid.
- Prevent repeated clicks and announce submission progress.

### 12.3 Confirmation

- Show the provider's public photo when available and an initials avatar otherwise.
- Lead with `You're booked!` and a customer-friendly sentence such as `Your appointment with Lisa at Brazilian Wax Demo is confirmed.` Show the appointment reference, business, service, provider, local date/time, timezone abbreviation/context, and location mode.
- State gently and clearly: `Email and text confirmations are not available yet. Please save this reference or take a screenshot.`
- Do not expose contact data or provide unauthenticated reschedule/cancel actions.
- Browser refresh after success must not submit automatically. The in-memory confirmation may remain visible; a deliberate new booking starts with a new idempotency key.

### 12.4 Accessibility and mobile

- Semantic headings, labels, field groups, error summaries, and one primary submit action.
- Visible keyboard focus and touch targets at least 44 CSS pixels.
- Errors associate with fields and the summary; focus moves to the summary after rejected submission.
- `aria-live` status announces validation, submission, lost slot, and confirmation without duplicating announcements.
- Review cards and forms stack without horizontal scrolling at 320 CSS pixels and above.
- Do not rely on color alone for selection, validation, progress, or success.

## 13. Administrative configuration

The existing Business Hub Public Booking screen adds booking-terms version, acknowledgment label, and optional terms URL. Permissions:

| Role           | View | Manage |
| -------------- | ---: | -----: |
| `tenant_owner` |  Yes |    Yes |
| `tenant_admin` |  Yes |    Yes |
| `front_desk`   |  Yes |     No |
| `provider`     |  Yes |     No |

Actual changes increment tenant version and emit the existing public-booking-settings audit event with changed field names only. No-op saves do not increment or audit. Changing the terms version affects only future submissions; existing appointments retain their accepted version.

## 14. Validation, migration, and indexes

Use the existing idempotent command:

```shell
pnpm --filter @booknowtech/api db:migrate
```

Migration changes:

1. update tenant validator for `public_booking_terms`;
2. update appointment validator for `source=public_booking`, `public_submission`, and `booking_terms` conditional requirements;
3. backfill existing tenants with version `1`, a conservative acknowledgment label, and `terms_url=null`;
4. keep existing appointments `source=business_hub` with both new fields `null`;
5. create the exact partial unique index:

```javascript
{
  key: { tenant_id: 1, "public_submission.idempotency_key_hash": 1 },
  name: "appointments_public_idempotency_unique",
  unique: true,
  partialFilterExpression: {
    source: "public_booking",
    "public_submission.idempotency_key_hash": { $type: "string" }
  }
}
```

Migration tests prove idempotency, validator enforcement, index equivalence, backfill behavior, rollback compatibility, and preservation of all PR 7–9 data/indexes.

Application rollback may leave additive fields and the safe unique index in place. Do not drop public appointments, customers, or index data during an application rollback.

## 15. Seed plan

Use the existing command:

```shell
pnpm --filter @booknowtech/api db:seed:development
```

Idempotently add:

- fictional terms labels/version for Brazilian Wax Demo and Braiding Demo;
- one future public-booking appointment per published demo tenant using a seeded public-booking customer;
- distinct deterministic idempotency hashes that contain no raw secrets or contact values;
- one provider/time that remains open for successful manual QA and another occupied start for lost-slot/conflict QA.

All seed names and `.test` contacts are fictional. Seed reruns do not create duplicate customers, appointments, references, audit events, or lock records.

## 16. OpenAPI contract

Document:

- endpoint, required hostname behavior, required UUID idempotency header, and 16 KiB limit;
- request/response schemas and examples for provider-location, virtual, and customer-location services;
- `201` first creation and `200` replay;
- validation, safe `404`, terms-change, idempotency conflict, lost-slot, rate-limit, and internal-error responses;
- explicit statement that the endpoint creates a scheduled appointment without payment or delivered notification;
- explicit public field allowlist and redaction behavior.

Production OpenAPI exposure remains governed by the existing nonproduction configuration; PR 10 introduces no new exposure setting.

## 17. Automated tests

### Unit

- email, phone, name, and address normalization reuse PR 7 behavior;
- exact dual-identifier customer match and every ambiguous/conflicting branch;
- no existing-customer mutation;
- canonical request fingerprint stability and field sensitivity;
- idempotency-key validation, hash storage, replay, and mismatch;
- terms-version and acknowledgment validation;
- policy boundaries and current-time behavior;
- safe response projection and PII redaction;
- honeypot and request-size behavior;
- UI validation, selected slot review, pending state, lost-slot recovery, confirmation, and accessibility announcements.

### API integration

- valid public creation for both published tenants;
- hostname tenant isolation and safe cross-tenant IDs;
- inactive/unpublished service, provider, assignment, or tenant returns safe `404`;
- `customer_selectable=false` and `accepting_new_clients=false` reject public creation;
- lead-time, maximum-window, schedule, break, closure, time-off, and appointment conflicts are revalidated;
- required address by delivery mode;
- terms-version race;
- public customer created/reused/ambiguous behavior without response differences;
- unique single-identifier match with an absent second stored identifier reuses safely, while a conflicting stored identifier creates a separate customer;
- no admin cookie/session dependence and no administrative tenant override;
- rate limits and redacted logs.

### Mongo-backed concurrency

- simultaneous requests for one provider/start yield one appointment;
- identical simultaneous key/fingerprint yields one appointment/customer/reference/audit event and one replay;
- same key/different fingerprint yields one success and one idempotency conflict;
- different keys for one start yield one success and one lost-slot conflict;
- new customer rolls back when appointment insert/commit fails;
- schedule-lock transaction retry revalidates all records;
- unique index and validators reject invalid direct writes;
- no cross-tenant matching or idempotency collision.

### Frontend

- full mobile and desktop discovery-to-confirmation flow;
- no mutation before explicit review submission;
- double-click/retry uses one key;
- editing the reviewed payload rotates the key;
- lost slot returns to Time with current starts;
- field and summary errors are keyboard/screen-reader usable;
- admin Business Hub remains unchanged outside approved terms settings.

## 18. Performance targets

- public submit handler p95 under 750 ms excluding client network latency under representative staging load;
- idempotent replay p95 under 250 ms;
- customer exact-match queries use existing tenant/email and tenant/phone indexes;
- appointment idempotency lookup uses `appointments_public_idempotency_unique`;
- conflict query and lock behavior retain PR 8 documented index plans;
- request memory is bounded by the 16 KiB body and fixed-size result caps;
- no unbounded customer, appointment, or audit query is permitted.

Record explain plans for representative 10,000-customer and appointment fixtures. A performance failure is fixed through approved indexes/query changes, not a cache or duplicated engine.

## 19. Acceptance checklist

- [ ] A guest completes service → provider → date → time → details → review → confirmation on a published tenant hostname.
- [ ] Submission creates exactly one `scheduled`, `source=public_booking` appointment with PR 8 snapshots, locks, reference, local date, terms, and idempotency facts.
- [ ] Public creation requires active/public tenant, service, provider, and assignment eligibility plus `customer_selectable` and `accepting_new_clients`.
- [ ] Lead time, maximum advance date, schedule, break, closure, time off, and current appointments are transactionally revalidated.
- [ ] A taken start returns `slot_no_longer_available`, persists nothing, and refreshes current times accessibly.
- [ ] Exact unique email-and-phone agreement reuses one tenant customer; a single unique match reuses only when the other stored identifier is absent and nonmatching elsewhere; every ambiguous/conflicting case creates a separate tenant customer without public disclosure.
- [ ] Existing customers are never changed by the public workflow.
- [ ] Same idempotency key/fingerprint returns the original confirmation without duplicate records, version changes, references, locks, or audit events.
- [ ] Same key with another fingerprint is rejected safely.
- [ ] Customer and appointment creation are atomic; failures leave neither record.
- [ ] Terms acceptance is explicit, versioned, non-marketing, and snapshotted.
- [ ] Confirmation is on-screen only and clearly states no payment or delivered notification occurred.
- [ ] Public responses/logs/errors contain no customer contact, ObjectIds, match results, blocked intervals, or internal details.
- [ ] Unknown/private/cross-tenant resources share one safe `404` contract.
- [ ] Rate, body, content-type, honeypot, and trusted-host protections pass.
- [ ] Mobile, keyboard, focus, error summary, status announcement, and 320-pixel overflow QA pass.
- [ ] Migration, validator, index, seed, transaction, and rollback tests are idempotent.
- [ ] No payment, notification, customer account, custom domain, new service, queue, cache, or Railway variable was introduced.

## 20. Rollout

1. Merge only after canonical CI, secret scan, Mongo-backed concurrency tests, accessibility tests, and build pass.
2. Keep existing production/customer tenants unpublished.
3. Deploy API and frontend from the same commit; worker has no new responsibility.
4. Run `db:migrate` and verify tenant/appointment validators plus `appointments_public_idempotency_unique` in Atlas.
5. Run the idempotent staging seed.
6. Enable submission only on the two already approved published demo tenants after smoke tests.
7. QA successful create, replay, mismatch, lost slot, conflicting create, ambiguous customer, tenant isolation, rate limit, mobile, and confirmation.
8. Monitor stable outcome counts, transaction retry/conflict rate, customer created/reused ratio, latency, and 5xx without PII.
9. Do not enable a customer tenant until terms text, public contact data, schedules, services, providers, and operational support are reviewed.

## 21. Rollback

- Roll back API and frontend together to PR 9.
- Immediately set `public_booking_enabled=false` for affected tenants if anonymous creation must stop; this also safely hides discovery.
- Existing public-created customers and appointments remain valid tenant records and visible/manageable in Business Hub.
- Do not delete appointments, customers, locks, audit events, additive fields, or the unique idempotency index as an application rollback.
- If a transaction/data defect is found, stop public submission, preserve evidence, and use an approved corrective migration/ADR.
- PR 9 read-only discovery can be re-enabled only when the deployed frontend cannot expose a submission action against the rolled-back API.

## 22. Explicit exclusions

PR 10 does not implement:

- payments, Stripe, deposits, refunds, taxes, processor/platform/partner fees, commissions, payouts, invoices, or settlement;
- email or SMS delivery, notifications, reminders, or booking-confirmation delivery;
- customer authentication, accounts, portal, saved sessions, rescheduling links, or cancellation links;
- temporary holds, waitlists, intake forms, waivers, documents, general customer/staff notes, loyalty, memberships, packages, or recurring appointments; the approved appointment-snapshot customer note is the sole exception;
- custom-domain storage, verification, provisioning, SSL onboarding, DNS automation, or offboarding;
- provider login, Any Available Provider, rooms/equipment, multi-provider appointments, or calendar integrations;
- new Railway services/variables, workers, queues, distributed caches, CAPTCHA vendors, or unrelated abstractions.

## 23. White-label domain direction

Staff administration remains centralized at:

```text
admin.booknowtech.com
```

The permanent fallback public hostname remains:

```text
tenant-slug.booknowtech.com
```

A future approved custom-domain PR may add:

```text
book.companyname.com
```

through exact verified hostname records, ownership verification, Railway domain/SSL onboarding, status/retry handling, uniqueness, removal, and fallback behavior. That PR must extend the existing hostname resolver with precedence:

```text
exact verified custom hostname
→ exact BookNowTech fallback hostname
→ safe 404
```

Booking API behavior, customer matching, idempotency, appointment creation, and Business Hub authentication must not change based on which approved public hostname resolved the tenant.

## 24. Approved decisions

1. Require a UUID `Idempotency-Key` and persist its hash/fingerprint on the appointment rather than adding an idempotency collection.
2. Reuse a customer under the conservative tenant-local rules in Section 5, including the safe partial-record case; create a separate customer for every ambiguous or conflicting case.
3. Never mutate an existing customer from anonymous public submission.
4. Return appointment reference and booking facts only; do not return customer identifiers/contact data or appointment UUID.
5. Provide on-screen confirmation only; no email/SMS delivery in PR 10.
6. Create the appointment as `scheduled` without payment.
7. Store versioned booking-terms acceptance on the appointment and keep marketing consent `unknown`.
8. Add the documented bounded per-replica submission limits without distributed infrastructure.
9. Keep Any Available Provider and custom-domain provisioning deferred.
10. Use `public_booking_enabled=false` as the immediate public-write kill switch rather than adding a feature flag.
11. Store an optional customer note only on the immutable appointment snapshot and never in customer data, public responses, audit metadata, URLs, or ordinary logs.
12. Show the provider's current public photo on confirmation with an initials fallback; do not snapshot the photo URL.
13. Defer public appointment access tokens. A future workflow must use cryptographically random, purpose-bound opaque tokens; store only token hashes with appointment/tenant scope, expiry, revocation, rotation, and one-time-use rules where appropriate. Appointment references are never authorization credentials.

These decisions are approved. Implementation must stop for an ADR if a material architectural conflict is discovered.

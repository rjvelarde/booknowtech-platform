# PR 8 — Appointment Lifecycle Foundation Implementation Contract

**Status:** Proposed — requires approval before implementation  
**Scope:** Internal Business Hub appointment management only

## 1. Objective

PR 8 introduces the first persistent appointment record and connects the existing tenant, customer, provider, provider-service assignment, service, availability, and deterministic scheduling foundations.

Authorized staff can create, view, search, reschedule, cancel, complete, and mark appointments as no-show. The server revalidates every proposed time and prevents concurrent double booking. PR 8 does not implement public booking, payments, notifications, customer authentication, or calendar integrations.

The smallest safe deliverable is:

1. one tenant-scoped `appointments` collection;
2. one technical `appointment_schedule_locks` collection used only to serialize conflicting provider/day writes;
3. internal staff APIs and an accessible agenda/detail/create workflow;
4. scheduling previews that subtract persisted scheduled appointments;
5. transactional, Mongo-backed proof that concurrent requests cannot double-book a provider.

## 2. Architectural invariants

- Tenant context comes only from the authenticated administrative session and selected, revalidated membership.
- Client-supplied tenant IDs are never authorization context and are not accepted in payloads, queries, or headers.
- Every tenant-scoped lookup includes the verified tenant `_id`; inaccessible and cross-tenant records return the existing safe `404` response.
- Existing CSRF, session, role, response-envelope, OpenAPI, validation, audit, optimistic-concurrency, and logging conventions remain unchanged.
- ObjectIds, stack traces, database errors, and another tenant's data never reach clients.
- Appointment create and scheduling changes are authoritative only after server-side eligibility and availability validation inside a transaction.
- Slot previews are advisory. The server never trusts a previously returned slot.
- Generated slots remain ephemeral; no slots or preview responses are persisted or cached.
- Lifecycle records are never physically deleted.
- No new service, queue, cache, feature flag, architectural abstraction, or Railway variable is introduced.

## 3. Approved design recommendations

| Question                         | Recommendation                                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Concurrent double-book guarantee | Serialize writes through provider/UTC-day lock documents inside MongoDB transactions, then re-read and check overlap before writing.  |
| Snapshot duration and buffers    | Yes. They define the historical customer interval and provider blocked interval.                                                      |
| Snapshot display names           | Yes: customer, provider, and service display names only. References still point to master records.                                    |
| Blocking statuses                | Only `scheduled`. Cancellation releases time immediately. Completed/no-show records are historical and should already be in the past. |
| Rescheduling identity            | Mutate the same appointment with optimistic concurrency; preserve prior values in audit history.                                      |
| Provider access                  | None in PR 8. `linked_user_id` is reserved and cannot safely enforce provider self-scope yet.                                         |
| Customer/provider history panels | Defer. They expand UI and pagination scope without being required for reliable booking.                                               |
| Price snapshot                   | Yes: catalog base price, booking fee, and currency as historical facts only; no financial calculation.                                |
| Collections                      | `appointments` plus the required technical `appointment_schedule_locks` concurrency collection.                                       |
| Smallest safe scope              | Staff agenda, detail, create, reschedule, and four-state lifecycle with transactional conflict prevention.                            |

## 4. Data model

### 4.1 `appointments`

```text
_id: ObjectId
public_id: UUID string
tenant_id: ObjectId

customer_id: ObjectId
provider_id: ObjectId
service_id: ObjectId
provider_service_assignment_id: ObjectId

starts_at: Date                  # customer-facing start, UTC
ends_at: Date                    # starts_at + snapshotted duration, UTC
blocked_starts_at: Date          # starts_at - before buffer, UTC
blocked_ends_at: Date            # ends_at + after buffer, UTC
timezone: IANA timezone string
local_start_date: YYYY-MM-DD     # derived in snapshotted timezone for agenda queries

reference: string                # immutable, human-readable tenant-scoped reference

snapshot:
  customer_display_name: string
  provider_display_name: string
  service_name: string
  service_duration_minutes: integer
  slot_cadence_minutes: integer
  buffer_before_minutes: integer
  buffer_after_minutes: integer
  delivery_mode: provider_location | customer_location | virtual
  base_price_minor: integer
  booking_fee_minor: integer
  currency: ISO-4217 string

location:
  mode: provider_location | customer_location | virtual
  customer_address: null | {
    line_1: string
    line_2: null | string
    city: string
    region: string
    postal_code: string
    country_code: string
  }

status: scheduled | completed | cancelled | no_show
source: business_hub

cancelled_at: null | Date
cancelled_by: null | ObjectId
cancellation_reason: null | customer_request | provider_unavailable | business_closed | duplicate | other
cancellation_detail: null | string       # max 500 characters; only used with other
completed_at: null | Date
completed_by: null | ObjectId
no_show_at: null | Date
no_show_by: null | ObjectId

version: positive integer
created_at: Date
updated_at: Date
created_by: ObjectId
updated_by: ObjectId
```

`reference` is generated by the server, is immutable, unique within the tenant, and is suitable for staff communication and search. The UUID `public_id` remains the stable API identifier. The reference must not encode customer PII.

`local_start_date` is always server-derived from `starts_at` in the appointment timezone. It is recomputed on every reschedule and on any future approved workflow that changes the appointment timezone; clients cannot submit it.

Master-record ObjectId references support current eligibility checks and future joins. Snapshots preserve what staff booked even after names, duration, buffers, or catalog values change. Do not snapshot email, phone, communication preferences, biography, or arbitrary metadata.

For `customer_location`, the selected customer address is copied because the operational destination must survive later customer edits. It is null for other delivery modes. PR 8 does not introduce multiple business locations.

Catalog values are historical display facts only. PR 8 performs no deposit, tax, processor fee, platform fee, payout, commission, invoice, refund, or settlement calculation.

### 4.2 `appointment_schedule_locks`

```text
_id: ObjectId
tenant_id: ObjectId
provider_id: ObjectId
utc_date: YYYY-MM-DD
revision: non-negative integer
updated_at: Date
```

These are technical serialization records, not appointments or time reservations. One document exists per tenant/provider/UTC date touched by a blocked interval. They contain no PII and are not exposed through APIs or UI.

## 5. State machine

```text
scheduled -> completed
scheduled -> cancelled
scheduled -> no_show
scheduled -> scheduled (reschedule only)
```

- `cancelled`, `completed`, and `no_show` are terminal.
- Rescheduling changes time fields and snapshot scheduling facts but does not create a `rescheduled` status.
- `confirmed` and `in_progress` are deferred.
- Repeating the same lifecycle command returns `200`, `changed=false`, does not increment `version`, and does not emit another audit event.
- A different transition from a terminal state returns `409 invalid_appointment_transition`.
- Routine completion and no-show are permitted only at or after `starts_at`.
- Before `starts_at`, only `tenant_owner` and `tenant_admin` may perform the action through an explicit override payload and strong UI confirmation. The audit event records `early_override=true`; `front_desk` cannot override.
- Reschedule is permitted only while `scheduled`.

## 6. Atomic conflict prevention

MongoDB has no unique constraint for arbitrary interval overlap. A normal read followed by insert, even inside separate transactions, is insufficient when both transactions read an empty range. PR 8 therefore uses deterministic provider/day serialization.

### 6.1 Create algorithm

1. Validate payload shape and resolve all public IDs using the selected tenant.
2. Compute the candidate blocked interval using current service duration and assignment buffers.
3. Determine every UTC calendar date intersected by `[blocked_starts_at, blocked_ends_at)`.
4. Ensure the corresponding lock documents exist with idempotent upserts before starting the transaction.
5. Start a MongoDB transaction using majority write concern and snapshot/read concern supported by the driver.
6. Update (`$inc: { revision: 1 }`) all applicable lock documents in ascending `utc_date` order.
7. Inside that same transaction, re-read the customer, provider, service, assignment, schedule, breaks, closures, and time-off records. Internal staff creation requires an active provider and active assignment; `accepting_new_clients` is not consulted because it is reserved for future public-booking eligibility.
8. Re-run deterministic slot eligibility for the exact requested start.
9. Query `appointments` for the same tenant/provider where `status=scheduled`, `blocked_starts_at < candidate.blocked_ends_at`, and `blocked_ends_at > candidate.blocked_starts_at`.
10. If any overlap exists, abort and return `409 appointment_conflict` (or `slot_no_longer_available` when the exact previewed start became unavailable).
11. Insert the appointment and commit.

Concurrent transactions writing the same lock document produce a MongoDB write conflict. The driver's bounded whole-transaction retry starts with a new snapshot, after which the losing request sees the winning appointment and returns `409`. It cannot also commit an overlapping appointment.

### 6.2 Reschedule and cancellation

- Reschedule locks the union of old and new provider/UTC dates, ordered by provider ObjectId then UTC date, before checking the new interval and updating the appointment.
- Cancellation locks every UTC date intersecting the old blocked interval before changing status, so a new booking cannot race the release.
- Completion and no-show do not release future inventory as a scheduling operation; they use the same old interval locks to keep status and preview results transactionally ordered.
- A transaction retry must re-run all reads and validation. Audit emission occurs once after a successful commit using existing audit behavior.

Mongo-backed concurrency tests require a replica-set or sharded MongoDB deployment with transaction support. CI must fail rather than silently skip these tests when the approved Mongo test configuration is expected.

## 7. Scheduling-engine integration

PR 6 becomes:

```text
provider availability
- breaks
- provider time off
- tenant closures
- scheduled appointment blocked intervals
= available service starts
```

- Only `scheduled` appointments subtract time.
- Cancelled appointments release their blocked interval immediately after commit.
- Completed and no-show appointments remain historical records; preview queries for future dates do not subtract them.
- Rescheduling removes the old blocked interval and adds the new interval atomically.
- No cache is introduced. Every preview reads current persisted inputs.
- The scheduling cursor fingerprint includes the relevant appointment schedule-lock revisions. A change to any relevant revision makes an old cursor invalid under the existing stable cursor-error convention.
- Preview range limits and performance rules from PR 6 remain in effect.

## 8. API contract

All endpoints are under `/api/v1/admin`, require the administrative session, selected tenant, CSRF on mutations, and existing envelopes.

| Method | Endpoint                                          | Purpose                                 |
| ------ | ------------------------------------------------- | --------------------------------------- |
| `GET`  | `/appointments`                                   | Cursor-paginated agenda/search          |
| `GET`  | `/appointments/:appointment_public_id`            | Detail                                  |
| `POST` | `/appointments`                                   | Create after authoritative revalidation |
| `POST` | `/appointments/:appointment_public_id/reschedule` | Atomically change scheduled interval    |
| `POST` | `/appointments/:appointment_public_id/cancel`     | Cancel                                  |
| `POST` | `/appointments/:appointment_public_id/complete`   | Complete                                |
| `POST` | `/appointments/:appointment_public_id/no-show`    | Mark no-show                            |

### 8.1 Create

```json
{
  "customer_public_id": "uuid",
  "provider_public_id": "uuid",
  "service_public_id": "uuid",
  "starts_at": "2026-08-03T14:00:00.000Z",
  "customer_address_public_id": null
}
```

The assignment is resolved server-side from provider and service. The client cannot submit duration, buffers, prices, timezone, end times, status, or snapshots. Success returns `201` with appointment detail. A duplicate retry without an idempotency key is treated as a conflict; request-level idempotency infrastructure is outside the approved architecture and is not added here.

### 8.2 Reschedule

```json
{
  "expected_version": 3,
  "starts_at": "2026-08-04T16:00:00.000Z"
}
```

Provider, service, and assignment references are retained and revalidated as active. By default, rescheduling changes only the scheduled interval. It retains the appointment's existing snapshotted service name, duration, buffers, catalog price, currency, delivery mode, timezone, and other operational terms. A future explicit change-service or change-provider workflow may refresh those snapshots, but PR 8 does not provide one. The same appointment `public_id` and human-readable `reference` are retained. Success returns `200`, `changed=true` and the updated record.

### 8.3 Lifecycle payloads

```json
{ "expected_version": 3, "early_override": false }
```

Cancellation additionally permits:

```json
{
  "expected_version": 3,
  "reason": "customer_request",
  "detail": null
}
```

Cancellation `detail` is optional for every structured reason, is trimmed, and is limited to 500 characters. It is internal-only: it is omitted from customer-facing responses and audit metadata.

### 8.4 List filters

`GET /appointments` supports:

- `view=today|upcoming|past` (default `upcoming`);
- `start_date` and `end_date` in the tenant timezone, maximum 93 days;
- repeatable or comma-delimited `status` using documented existing query conventions;
- `provider_public_id`;
- `service_public_id`;
- `customer_query` (name, normalized email, or phone through PR 7 indexes);
- `reference` exact or normalized prefix search;
- `limit` from 1–100, default 25;
- opaque `cursor`.

Upcoming/today sort by `starts_at ASC, public_id ASC`. Past sorts by `starts_at DESC, public_id DESC`. Explicit date ranges use ascending order. Status/provider/service/customer filters compose. Customer search first resolves a capped set of tenant-scoped customer IDs; it never performs an unbounded regex scan.

### 8.5 Stable errors

| HTTP  | Code                             | Meaning                                           |
| ----- | -------------------------------- | ------------------------------------------------- |
| `400` | `invalid_appointment_request`    | Malformed fields or dates                         |
| `400` | `invalid_date_range`             | Invalid or excessive list/preview range           |
| `404` | `appointment_not_found`          | Missing or inaccessible appointment               |
| `404` | `customer_not_found`             | Missing/inaccessible customer                     |
| `404` | `provider_not_found`             | Missing/inaccessible provider                     |
| `404` | `service_not_found`              | Missing/inaccessible service                      |
| `404` | `assignment_not_found`           | No tenant-scoped assignment                       |
| `409` | `inactive_customer`              | Customer is inactive                              |
| `409` | `inactive_provider`              | Provider is inactive or not accepting new clients |
| `409` | `inactive_service`               | Service is inactive                               |
| `409` | `inactive_assignment`            | Assignment is inactive                            |
| `409` | `provider_unavailable`           | Outside schedule, break, time off, or closure     |
| `409` | `slot_no_longer_available`       | Slot became invalid since preview                 |
| `409` | `appointment_conflict`           | Overlapping scheduled blocked interval            |
| `409` | `version_conflict`               | Expected version is stale                         |
| `409` | `invalid_appointment_transition` | State transition is not permitted                 |

Cross-tenant IDs use the corresponding safe `404`, never an authorization or existence-revealing response.

## 9. Permissions

| Capability              | tenant_owner | tenant_admin | front_desk | provider |
| ----------------------- | -----------: | -----------: | ---------: | -------: |
| List/detail             |          Yes |          Yes |        Yes |       No |
| Create/reschedule       |          Yes |          Yes |        Yes |       No |
| Cancel/complete/no-show |          Yes |          Yes |        Yes |       No |

Provider self-access is deferred until authenticated users can be securely linked to a provider and self-scope is enforceable on every request.

## 10. Business Hub UI

### 10.1 Routes

- `/appointments` — agenda/list
- `/appointments/new` — guided create workflow
- `/appointments/:appointment_public_id` — detail and lifecycle actions
- `/appointments/:appointment_public_id/reschedule` — reschedule workflow

### 10.2 Agenda

- Add an `Appointments` primary Business Hub navigation item.
- Default to Upcoming with Today, Past, and date-range controls.
- Provide status, provider, service, and customer search filters.
- Display local start, customer, provider, service, status, and duration.
- Use cursor-based Next/Previous controls and preserve filters in the URL.
- A graphical calendar is explicitly deferred.

### 10.3 Create/reschedule

- Search and select an existing customer.
- Select an active provider, then an active assigned service.
- Select a date/range and load generated starts from the scheduling endpoint.
- Show customer-facing time and a staff explanation of the blocked interval.
- Submit the selected UTC start; display a clear saved confirmation and link to detail.
- On stale/conflicting slots, show a readable message and refresh available starts.
- On opening forms or validation errors, scroll/focus the heading or first invalid field, following the usability correction established in PR 6.

### 10.4 Detail

Show the human-readable reference, customer, provider, service, tenant-local date/time, customer duration, provider blocked interval, timezone, status, source, version, and created/updated information. Provide valid lifecycle actions only. Cancellation uses a confirmation dialog and reason controls. Early completion/no-show presents a strong owner/admin-only override confirmation explaining that the appointment has not started. Future Payments, Documents, Notes, and Communications sections are not rendered as empty UI.

Customer and Provider detail appointment panels are deferred to keep PR 8 independently deliverable. The central agenda supplies the necessary first operational workflow.

### 10.5 Accessibility and mobile

- All fields have explicit labels, descriptions, errors, and logical focus order.
- Status is conveyed by text, not color alone.
- Confirmations/errors use accessible live regions and receive focus when appropriate.
- Dialogs trap and restore focus.
- Controls meet established touch-target and keyboard requirements.
- Agenda cards reflow without horizontal scrolling at supported mobile widths.

## 11. Audit events

Emit once per committed change:

- `appointment_created`
- `appointment_rescheduled`
- `appointment_cancelled`
- `appointment_completed`
- `appointment_no_show`

Metadata contains appointment public ID, prior/new version, prior/new status, prior/new UTC customer and blocked intervals when changed, provider/service/customer public IDs, request ID, and existing actor/tenant fields. Do not include names, contact data, addresses, cancellation detail, or other customer PII. Prior scheduling values belong in reschedule audit metadata; no separate history collection is required.

Idempotent lifecycle retries emit no duplicate event.

## 12. Validation

- All referenced records and the assignment must be active and tenant-scoped at create/reschedule time.
- Customer must be active.
- Provider must be active. Neither `accepting_new_clients` nor `customer_selectable` prevents internal Business Hub selection; both are reserved for future public-booking eligibility.
- Service and assignment must be active and operationally eligible.
- Start must be a valid generated start under current cadence, duration, buffers, timezone, schedule, breaks, time off, closures, and appointments.
- All intervals use half-open semantics `[start, end)` so adjacent blocked intervals do not conflict.
- Dates must be valid ISO timestamps and within existing scheduling preview limits.
- Customer-location services require a current customer address selection; its contents are snapshotted server-side.
- Version must be a positive integer matching the persisted record.

## 13. Migration and indexes

### 13.1 Command

Use the existing idempotent migration command:

```shell
pnpm --filter @booknowtech/api db:migrate
```

The migration creates validators and exact indexes if absent and verifies compatible definitions if present.

### 13.2 `appointments` indexes

```text
appointments_tenant_public_id_unique
  { tenant_id: 1, public_id: 1 } unique

appointments_tenant_reference_unique
  { tenant_id: 1, reference: 1 } unique

appointments_provider_conflicts
  { tenant_id: 1, provider_id: 1, status: 1,
    blocked_starts_at: 1, blocked_ends_at: 1 }

appointments_tenant_upcoming
  { tenant_id: 1, starts_at: 1, public_id: 1 }

appointments_tenant_past
  { tenant_id: 1, starts_at: -1, public_id: -1 }

appointments_tenant_status_agenda
  { tenant_id: 1, status: 1, starts_at: 1, public_id: 1 }

appointments_tenant_provider_agenda
  { tenant_id: 1, provider_id: 1, starts_at: 1, public_id: 1 }

appointments_tenant_service_agenda
  { tenant_id: 1, service_id: 1, starts_at: 1, public_id: 1 }

appointments_tenant_customer_agenda
  { tenant_id: 1, customer_id: 1, starts_at: -1, public_id: -1 }

```

The unique tenant/reference index also supports anchored appointment-reference lookup; an
equivalent duplicate index is intentionally not created.

### 13.3 Lock indexes

```text
appointment_schedule_locks_scope_unique
  { tenant_id: 1, provider_id: 1, utc_date: 1 } unique

appointment_schedule_locks_updated
  { updated_at: 1 }
```

The validator enforces required types, enums, interval ordering, lifecycle metadata consistency, and nonnegative catalog/buffer values. Rollback removes application use and may remove newly added indexes/validators only after verification; it never drops appointment or lock documents.

## 14. Seed plan

### 14.1 Command

```shell
pnpm --filter @booknowtech/api db:seed:development
```

Use deterministic appointment public IDs and tenant-scoped upserts. Seed records are inserted only when their deterministic ID is absent; reruns do not overwrite manual QA edits.

For both Brazilian Wax Demo and Braiding Demo, seed:

- one upcoming scheduled appointment;
- one past completed appointment;
- one cancelled appointment;
- one no-show appointment.

Use different eligible providers/services where available. If Braiding Demo lacks the minimum provider, assignment, and schedule prerequisites, add only those realistic prerequisites as part of the staging seed. Dates should be calculated relative to seed execution while remaining idempotent for the seeded identity. Seed intervals must not overlap and must be isolated by tenant.

Migration must run before seed. Seed output reports created, preserved, and prerequisite records without printing secrets or PII beyond existing approved demo data.

## 15. Automated tests

### 15.1 Unit and contract

- interval and half-open overlap calculations;
- snapshot derivation;
- status transition table, early-action override rules, and idempotency;
- cancellation validation;
- list filter/cursor parsing;
- stable errors and response/OpenAPI examples;
- timezone and DST behavior inherited from PR 5/6.

### 15.2 Mongo-backed integration

- create success and persisted snapshots;
- selected-tenant enforcement and safe cross-tenant `404` for every endpoint;
- all fixed-role permissions;
- inactive customer/provider/service/assignment and unassigned service rejection;
- provider schedule, breaks, time off, tenant closure, cadence, duration, and buffer enforcement;
- overlap rejection using blocked, not merely customer-facing, intervals;
- two simultaneous creates for the same provider/interval: exactly one `201`, one `409`, and one scheduled appointment;
- concurrent overlapping but different starts: exactly one commit;
- concurrent reschedule/create and cancel/create races;
- adjacent intervals succeed;
- reschedule atomic release/acquisition and version conflict;
- lifecycle transitions, terminal rejection, and repeated-action no-op behavior;
- cancelled slot becomes available; scheduled slot disappears;
- completed/no-show historical behavior;
- agenda filters, sorting, pagination, and cursor invalidation after schedule-lock revision changes;
- audit event contents, one-event behavior, and PII redaction;
- migration and seed idempotency.

Mongo tests must run against transaction-capable MongoDB. Any required GitHub secret/service configuration must be documented; the gate must not claim concurrency proof if tests were skipped.

### 15.3 Frontend

- guided customer/provider/service/start selection;
- loading, empty, conflict, stale-slot, and success states;
- agenda filters and pagination;
- detail rendering and lifecycle confirmations;
- optimistic-concurrency recovery;
- keyboard navigation, focus management, live regions, accessible names, and mobile layout.

## 16. Performance targets

Assume a representative large tenant has 100 providers, 100,000 retained appointments, 10,000 appointments per active year, and no more than 2,000 appointments per provider/year.

Measured in staging after warm connection establishment, report p50 and p95 for at least 30 representative requests:

| Operation                                        |                                           Target p95 |
| ------------------------------------------------ | ---------------------------------------------------: |
| Appointment detail                               |                                            <= 200 ms |
| Agenda first page (25)                           |                                            <= 300 ms |
| Conflict query inside transaction                |                                            <= 100 ms |
| Appointment create/reschedule, excluding network |  <= 500 ms without retry; <= 1,000 ms with one retry |
| Scheduling preview with appointments             | <= existing PR 6 target + 100 ms and <= 500 ms total |

Explain plans with representative seeded/generated test volume and confirm supporting indexes. Customer search retains PR 7 performance limits. No cache is added.

## 17. Acceptance checklist

- [ ] Staff can create an appointment for an existing tenant customer using an eligible provider, assignment, service, and current generated start.
- [ ] Server revalidation rejects stale or unavailable starts.
- [ ] Mongo concurrency tests prove two overlapping requests cannot both commit.
- [ ] Appointment snapshots and master references match the contract.
- [ ] Agenda defaults to upcoming and supports documented filters, sorting, and cursor pagination.
- [ ] Detail shows customer-facing and provider-blocked intervals in tenant-local context.
- [ ] Reschedule atomically moves the blocked interval and retains the same public ID.
- [ ] Cancel immediately releases inventory after commit.
- [ ] Routine complete/no-show is rejected before start; owner/admin strong override succeeds and is explicitly audited.
- [ ] Lifecycle retries return `changed=false` without version or audit duplication.
- [ ] Tenant isolation, safe `404`, CSRF, permissions, and optimistic concurrency pass.
- [ ] Scheduling previews subtract scheduled appointments and invalidate stale cursors.
- [ ] Audit events contain required changes and no unnecessary PII.
- [ ] Validators, indexes, migration, and seed are idempotent.
- [ ] OpenAPI, automated tests, accessibility, mobile layout, performance measurements, rollout, and rollback evidence pass.
- [ ] No new Railway variables/services, caches, queues, flags, or unrelated abstractions exist.

## 18. Rollout

1. Merge only after canonical CI, transaction-backed Mongo tests, secret scan, OpenAPI validation, and accessibility tests pass.
2. Confirm staging MongoDB supports transactions and backup/restore posture is current.
3. Run `db:migrate`; verify validators and index names/definitions.
4. Run the idempotent development seed in staging and verify all four lifecycle examples per tenant.
5. Deploy API and frontend from the same merged commit; the worker requires no PR 8 change unless canonical build packaging includes it mechanically.
6. Smoke-test tenant isolation, create, concurrent conflict, preview exclusion, reschedule, cancellation release, completion, no-show, agenda, and audit logs.
7. Record measured performance and Mongo query plans.

## 19. Rollback

1. Redeploy the prior known-good application commit.
2. Leave `appointments` and lock data intact; the prior application does not consume it.
3. Do not drop collections or delete appointment data.
4. Remove new indexes/validators only through a reviewed follow-up if they cause an operational problem and data compatibility has been verified.
5. If a partial deployment exposed PR 8 UI without matching API, roll back frontend and API together.

## 20. Explicit exclusions

PR 8 does not implement public/anonymous booking, customer login/portal, payments, Stripe, deposits, refunds, invoices, email, SMS, push, reminders, calendar integrations, recurring appointments, waitlists, packages, memberships, gift cards, commissions, payroll, intake, waivers, documents, general appointment notes, room/equipment scheduling, multi-provider appointments, group appointments, classes, overbooking, custom workflows, or reporting dashboards.

It also does not introduce persistent slots, booking holds, a generic reservation service, customer/provider appointment panels, provider self-access, multiple locations, or an appointment history collection.

## 21. Future-readiness boundary

The current fields with clear future value are stable public IDs, master references, immutable operational/catalog snapshots, source, timestamps, actors, lifecycle timestamps, and customer-location address snapshot. These support later public booking, payment display, notifications, reporting, partner APIs, commissions, and calendar payloads without implementing those workflows now.

Future requirements must use reviewed roadmap PRs or ADRs for booking holds/idempotency, global customer identity, provider authentication, multiple locations, payments, external calendar synchronization, and commissions. Do not add speculative metadata or status values in PR 8.

## 22. Decisions requiring approval

Approval of this contract specifically approves:

1. MongoDB provider/UTC-day serialization locks plus transactions as the double-book guarantee.
2. The four-state lifecycle with terminal cancelled/completed/no-show states.
3. Same-record rescheduling with audit-only prior schedule history.
4. Only `scheduled` appointments blocking provider time.
5. Immutable display, duration, buffer, timezone, delivery, address (when required), and catalog-price snapshots; rescheduling retains them and changes only the interval.
6. No provider access and no customer/provider history panels in PR 8.
7. No persistent slots, cache, booking holds, new Railway configuration, or new services.
8. Server-generated immutable tenant-scoped appointment references and server-derived `local_start_date`.
9. `accepting_new_clients` is not an internal staff-booking restriction.

No application implementation begins until these decisions and the full contract are approved.

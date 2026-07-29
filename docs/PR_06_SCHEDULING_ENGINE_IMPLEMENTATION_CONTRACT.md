# PR 6 Implementation Contract — Scheduling Engine and Slot Generation

Status: **Accepted**

## 1. Objective and user outcome

PR 6 converts PR 5 theoretical availability windows into deterministic service start times for one tenant-owned provider and one assigned service. An authenticated Business Hub user can preview the exact starts that a future booking workflow could offer, including the customer-facing service interval and the complete provider-blocked interval.

PR 6 remains a read-only scheduling calculation. A returned slot is not a reservation, hold, appointment, promise of availability, or public-booking result.

## 2. Architectural invariants

- Tenant context comes only from the authenticated `admin_sessions` record, its verified selected membership, and per-request membership revalidation.
- Every provider, service, assignment, schedule, exception, and tenant query includes the selected tenant's internal `_id`.
- A client-supplied tenant ID in a path, query, header, body, cursor, or browser storage is never accepted as authorization context.
- Cross-tenant or otherwise inaccessible provider/service identifiers return the existing safe `404` response and do not disclose which resource was invalid.
- Existing PR 2–5 authentication, CSRF, fixed-role, error-envelope, logging, audit, OpenAPI, accessibility, optimistic-concurrency, migration, and rollback patterns remain authoritative.
- No new collection, process, queue, service, feature flag, Railway variable, or architectural abstraction is introduced.
- Slot generation uses PR 5 availability as its only working-time source. PR 6 does not create a second availability engine.

## 3. Approved cadence decisions

### 3.1 Cadence ownership

Cadence is **service-level with a tenant default**:

```text
tenants.default_slot_cadence_minutes: required integer
services.slot_cadence_minutes: nullable integer
```

The effective cadence is:

```text
service.slot_cadence_minutes ?? tenant.default_slot_cadence_minutes
```

The request cannot provide or override cadence. This prevents callers from producing arbitrary schedules and guarantees that the same provider, service, date range, and stored configuration always produce the same slots.

Different services may use different cadence values. Changing cadence is an existing versioned tenant-profile or service-catalog mutation, not a scheduling-preview mutation.

### 3.2 Allowed cadence values

PR 6 permits this controlled set, expressed in minutes:

```text
5, 10, 15, 20, 30, 60
```

The tenant default is `15`. A service override is either `null` or one of the allowed values. The API and MongoDB validators enforce the same set.

### 3.3 Clock-grid alignment

Valid customer-facing starts align to a **fixed local clock grid** in the provider schedule's IANA timezone, not to the opening time of an individual availability window.

For a 15-minute cadence, valid local wall-clock minutes include `09:00`, `09:15`, `09:30`, and `09:45`. If a provider window begins at `09:07`, `09:07` is not a valid start; the first possible grid time is `09:15`, subject to buffers and duration fitting.

Fixed clock alignment is stable across providers, split shifts, breaks, closures, and partial windows. Opening-time alignment is explicitly rejected because a break or exceptional window boundary would otherwise shift every later start.

## 4. Scheduling inputs and eligibility

Slot generation requires all of the following selected-tenant records:

1. active tenant;
2. active provider;
3. active service;
4. active provider-service assignment;
5. one current provider availability schedule;
6. valid IANA schedule timezone;
7. effective cadence from service override or tenant default;
8. PR 5 recurring hours after subtracting recurring breaks;
9. active tenant holidays/closures after subtraction;
10. active provider time off after subtraction.

An absent or empty schedule returns `eligible=false` and no slots. An inactive provider, service, or assignment also returns `eligible=false` and no slots.

`customer_selectable` and `accepting_new_clients` do not affect this internal administrative preview. They remain future public-booking selection controls. PR 6 must return their values in eligibility context so staff can understand that public behavior may later differ, but it must not silently suppress internal slots.

The provider role remains selected-tenant view-only because `linked_user_id` still cannot establish self scope.

## 5. Slot calculation contract

### 5.1 Intervals

For each remaining PR 5 availability window `[window_start, window_end)`, a candidate customer-facing service start `S` is valid only when:

```text
S is aligned to the effective cadence in local wall-clock time
blocked_start = S - buffer_before_minutes
service_end = S + service.duration_minutes
blocked_end = service_end + buffer_after_minutes
blocked_start >= window_start
blocked_end <= window_end
```

All intervals are half-open. A blocked interval ending exactly at a break, closure, time-off boundary, or working-window end is valid. An interval crossing any boundary is invalid.

### 5.2 Displayed time versus occupied time

- The customer-facing time is `[starts_at, service_ends_at)`.
- The provider-blocked time is `[blocked_starts_at, blocked_ends_at)`.
- The before buffer is not shown as an earlier appointment start.
- The after buffer is not added to the displayed service duration.
- Buffers do not change price, booking fees, payroll, payouts, or service duration.

The response includes both intervals. Future conflict detection must use the blocked interval; future customer UI should ordinarily display the customer-facing interval.

### 5.3 Earliest and latest valid start

For each remaining window:

- earliest theoretical service start is `window_start + buffer_before_minutes`;
- latest theoretical service start is `window_end - service.duration_minutes - buffer_after_minutes`;
- the first returned start is the first fixed-clock-grid instant at or after the earliest theoretical start;
- the last returned start is the last fixed-clock-grid instant at or before the latest theoretical start.

If no aligned instant exists, the partial window produces zero slots. The engine never rounds outside the window and never shortens duration or buffers to force a fit.

### 5.4 Determinism and ordering

- Results are ordered by authoritative UTC `starts_at`, then provider public ID and service public ID as stable tie-breakers.
- Identical requests against unchanged stored inputs return identical ordered slots and pagination boundaries.
- Duplicate UTC starts are removed defensively.
- No random slot identifier or persistent slot record is created.

## 6. Timezone and DST behavior

PR 6 inherits the accepted PR 5 timezone contract:

- provider recurring schedules are local wall-clock rules in the schedule's IANA timezone;
- UTC timestamps are authoritative;
- every customer-facing and blocked UTC timestamp has a derived local timestamp with numeric offset;
- nonexistent spring-forward local times are omitted; availability boundaries inside the gap follow PR 5's advance-to-first-valid-instant policy;
- during fall-back overlap, both distinct UTC instants may be returned when each maps to a cadence-aligned local time and its complete blocked interval fits;
- repeated local labels remain distinguishable by numeric offset and UTC timestamp;
- UTC ordering remains monotonic across DST transitions.

Changing tenant timezone does not rewrite provider schedules. The provider schedule timezone governs generation.

## 7. Lead time and maximum advance booking

Same-day lead time and maximum advance booking are intentionally **not configured or enforced in PR 6**. Adding unused fields would create policy without an approved booking workflow.

A future booking-policy PR may represent them as tenant defaults with optional service overrides:

```text
minimum_booking_lead_minutes
maximum_advance_booking_days
```

That future PR must define clock source, rounding, staff overrides, cancellation implications, and public versus administrative behavior. PR 6 accepts explicit bounded local dates and makes no claim that every generated slot is inside a future booking horizon.

The PR 6 response explicitly states:

```json
"booking_policy_enforced": false
```

This is explanatory response metadata, not a reserved database field.

## 8. Administrative API

### 8.1 Endpoint and permissions

```http
GET /api/v1/admin/providers/{providerPublicId}/scheduling-slots
```

Query parameters:

```text
service_public_id=<UUID>   required
start_date=YYYY-MM-DD      required, provider-schedule local date
end_date=YYYY-MM-DD        required, inclusive
limit=<integer>            optional, default 200, maximum 500
cursor=<opaque string>     optional
```

| Operation                       | Owner/Admin | Front desk | Provider |
| ------------------------------- | ----------: | ---------: | -------: |
| View internal generated slots   |        View |       View |     View |
| Change tenant default cadence   |      Manage |         No |       No |
| Change service cadence override |      Manage |         No |       No |

This is an internal Business Hub endpoint only. It is not mounted under a public hostname or public-booking route.

### 8.2 Successful response

```json
{
  "data": {
    "eligible": true,
    "provider": {
      "public_id": "provider-uuid",
      "status": "active",
      "customer_selectable": true,
      "accepting_new_clients": true
    },
    "service": {
      "public_id": "service-uuid",
      "duration_minutes": 30,
      "slot_cadence_minutes": 15
    },
    "assignment": {
      "public_id": "assignment-uuid",
      "buffer_before_minutes": 5,
      "buffer_after_minutes": 10
    },
    "timezone": "America/New_York",
    "booking_policy_enforced": false,
    "slots": [
      {
        "starts_at": "2027-01-11T14:15:00.000Z",
        "service_ends_at": "2027-01-11T14:45:00.000Z",
        "blocked_starts_at": "2027-01-11T14:10:00.000Z",
        "blocked_ends_at": "2027-01-11T14:55:00.000Z",
        "local_start": "2027-01-11T09:15:00-05:00",
        "local_service_end": "2027-01-11T09:45:00-05:00",
        "local_blocked_start": "2027-01-11T09:10:00-05:00",
        "local_blocked_end": "2027-01-11T09:55:00-05:00"
      }
    ]
  },
  "meta": {
    "request_id": "request-uuid",
    "next_cursor": null
  }
}
```

An ineligible subject returns `200`, `eligible=false`, a stable machine-readable `reason`, and an empty slot list. Allowed reasons are:

```text
provider_inactive
service_inactive
assignment_inactive
schedule_missing
schedule_empty
```

Unknown, unassigned, or cross-tenant provider/service combinations use safe `404`, not an eligibility reason.

### 8.3 Error behavior

- `400 invalid_date_range`: malformed, reversed, or over-limit local dates.
- `400 invalid_limit`: limit outside `1..500`.
- `400 invalid_cursor`: malformed cursor or cursor for different query inputs.
- `401 authentication_required`: no valid administrative session.
- `403 tenant_selection_required`: no verified selected membership.
- `404 scheduling_subject_not_found`: provider/service is missing, inaccessible, cross-tenant, or not assigned.

Responses use the existing error envelope and request ID. GET requests require authentication but not CSRF.

## 9. Date range, pagination, and cursor rules

- The inclusive date range is limited to 31 provider-local dates, matching PR 5.
- The default page size is 200 slots; the maximum is 500.
- Pagination is cursor-based, never offset-based.
- The opaque cursor contains the last emitted UTC start and a query fingerprint covering provider, service, local date range, effective cadence, duration, buffers, schedule version, and relevant configuration versions.
- A cursor cannot change tenant context and is never trusted as authorization input.
- A cursor whose fingerprint no longer matches returns `400 invalid_cursor`; clients restart the preview rather than mixing results from different configurations.
- `next_cursor` is `null` when no more generated starts remain.

## 10. Performance and caching

The implementation must:

- load tenant, provider, service, assignment, schedule, and relevant exceptions with a bounded number of indexed queries;
- avoid one database query per date or slot;
- reuse timezone formatters and conversion helpers established by the PR 5 CI correction;
- stop generation once the requested page and continuation state are known;
- support the 31-day/500-slot maximum without unbounded memory growth;
- target under 500 ms at p95 for a seven-day, 200-slot staging preview and under 2 seconds for the maximum permitted request, excluding network latency.

PR 6 introduces **no application, Redis, database, CDN, or browser cache**. Results depend on mutable schedules and exceptions, request volume is administrative, and premature caching creates invalidation risk. Responses send `Cache-Control: private, no-store`. A future public-availability PR must define cache keys and invalidation using versions before adding caching.

## 11. Schema and existing mutation changes

### 11.1 `tenants`

Add required:

```text
default_slot_cadence_minutes: 5 | 10 | 15 | 20 | 30 | 60
```

The existing versioned `PATCH /api/v1/admin/business-profile` accepts this field for owner/admin and includes it in the profile response. Changing it increments tenant version and emits the existing business-profile audit event.

### 11.2 `services`

Add required nullable:

```text
slot_cadence_minutes: null | 5 | 10 | 15 | 20 | 30 | 60
```

The existing create/update/list/detail service payloads include this field. `null` means inherit the tenant default. Existing service optimistic concurrency, permissions, and audit behavior remain unchanged.

No new MongoDB collection or index is required.

## 12. Audit and logging

Slot preview is a read-only operation and does not emit a success audit event; auditing every preview would create high-volume noise without recording a business-state change.

Cadence changes use existing mutation audits:

```text
business_profile_updated
service_updated
```

Metadata identifies that cadence changed and includes prior/new versions, not full request payloads. Existing authentication/authorization failure logging remains in force. Operational logs include request ID, outcome, duration, number of generated slots, date-count, and `has_more`; they exclude session tokens, cursor contents, and customer data.

## 13. Business Hub UI

- Business Profile adds **Default scheduling interval** for owner/admin, with plain-language choices such as “Every 15 minutes.”
- Service create/edit adds **Scheduling interval**, defaulting to “Use business default (15 minutes).”
- Provider Availability adds an internal **Generated start times** preview using the existing provider, assigned-service, and local-date controls.
- Each result displays the customer-facing start and end. A staff-only details disclosure shows the complete blocked interval and buffers.
- Empty and ineligible states explain why no starts are shown without exposing inaccessible data.
- Pagination uses a keyboard-operable “Load more” control and preserves chronological order.
- Save success and failure messages use the QA-approved accessibility follow-up: visually distinct size/color plus text/icon meaning, `role=status` for success and `role=alert` for failure, without relying on color alone.
- No public page, appointment action, “Book” button, calendar drag/drop, or capacity display is added.

## 14. Migration and staging seed

Migration command:

```shell
pnpm --filter @booknowtech/api db:migrate
```

The idempotent migration:

1. backfills `tenants.default_slot_cadence_minutes=15` when missing;
2. backfills `services.slot_cadence_minutes=null` when missing;
3. applies the stricter tenant and service validators only after backfill;
4. verifies validators and existing indexes;
5. performs no destructive rewrite or collection drop.

Seed command:

```shell
pnpm --filter @booknowtech/api db:seed:development
```

Idempotent staging values:

- Brazilian Wax Demo tenant default: 15 minutes.
- Brazilian Wax: inherit tenant default (`null`).
- Brazilian Wax — First Time Client: inherit tenant default (`null`).
- Full Face: inherit tenant default (`null`).
- Chest + Stomach: 20-minute override to exercise partial windows.
- Braiding Demo tenant default: 30 minutes.
- Medium Knotless Braids: inherit tenant default (`null`).
- Virtual Consultation: 15-minute override.

The seed must not create appointments, holds, customers, or persistent slot documents.

## 15. Automated tests

### Unit tests

- tenant default and service override resolution;
- allowed cadence validation and rejection of arbitrary/request cadence;
- fixed local-clock-grid alignment when a window starts off-grid;
- duration plus before/after buffer fit;
- earliest/latest valid start calculations;
- exact-boundary half-open behavior;
- partial windows producing one or zero slots;
- multiple windows and break subtraction without duplicate starts;
- tenant closures and provider time off;
- inactive provider, service, and assignment eligibility;
- missing/empty schedule behavior;
- DST spring gap and fall overlap with UTC/local offset assertions;
- stable UTC ordering and deterministic repeated results;
- page limits, continuation cursor, invalid cursor, and changed-version cursor rejection;
- runtime regression test ensuring maximum bounded generation completes below the test budget without increasing global test timeout.

### MongoDB integration tests

- migration backfill and validator idempotency;
- tenant and service cadence persistence through existing versioned mutations;
- tenant A cannot read or infer Tenant B slots, cadence, providers, services, assignments, schedules, or exceptions;
- safe `404` for cross-tenant and unassigned combinations;
- bounded indexed exception loading;
- staging seed idempotency.

### API/UI tests

- authentication and selected-membership revalidation on every request;
- fixed-role view/manage permissions;
- OpenAPI request, success, ineligible, pagination, and error contracts;
- customer-facing and blocked interval rendering;
- accessible cadence inputs, messages, empty/error states, details disclosure, and Load more behavior;
- regression coverage for PR 2–5 login, switching, profile, catalog, providers, assignments, availability, closures, and logout.

Mongo-backed CI continues to use the declared MongoDB service and `MONGODB_TEST_URI`; no repository secret is required.

## 16. Acceptance checklist

1. Effective cadence resolves from service override or tenant default and cannot be supplied by the preview request.
2. Different services can generate different cadence-aligned starts for the same provider window.
3. Starts align to the fixed provider-local clock grid, not working-window opening time.
4. Every returned customer interval and blocked interval fits completely inside PR 5 remaining availability.
5. Buffers affect blocked time and eligibility without changing displayed service duration.
6. Partial windows deterministically produce the correct final start or no start.
7. Breaks, closures, time off, inactive entities, missing schedules, and unassigned services produce the documented results.
8. DST gap/overlap results are deterministic, UTC ordered, and locally offset-qualified.
9. Maximum date and page limits are enforced; cursors cannot cross queries, versions, or tenants.
10. Cross-tenant identifiers safely return `404` and cannot reveal resource existence.
11. Owner/admin can manage cadence through existing versioned profile/service flows; other fixed roles remain view-only.
12. Slot preview creates no database document and emits no mutation audit event.
13. Migration and seed commands are idempotent and all canonical quality/security gates pass.
14. No new Railway variable, public endpoint, service, process, feature flag, or architectural pattern is introduced.

## 17. Rollout and rollback

### Rollout

1. Merge only after canonical CI and Mongo-backed tests pass.
2. Existing Railway API pre-deploy runs the idempotent migration.
3. Verify tenant/service cadence backfills and validators in Atlas.
4. Deploy API and frontend from `main`; worker behavior is unchanged.
5. Run the development seed only in staging.
6. Smoke-test tenant switching, cadence inheritance/override, fixed-grid generation, buffers, closures, time off, DST fixtures, pagination, safe `404`, and accessibility messaging.
7. Monitor calculation duration, error rate, and maximum-slot responses by request ID.

### Rollback

- Redeploy the preceding application commit.
- Leave additive cadence fields and validators in place; prior application versions ignore the fields.
- Do not remove cadence fields, drop indexes, or rewrite schedules during emergency rollback.
- Reverting the UI/API removes slot generation without losing PR 5 availability data.
- Any destructive schema cleanup requires a separately approved migration.

## 18. Explicit exclusions

Appointments, appointment persistence, temporary holds, booking conflict detection, customers, customer authentication, public availability, public booking pages, booking-policy enforcement, lead-time enforcement, maximum-advance enforcement, pricing calculations, deposits, taxes, processor/platform/partner fees, payments, payouts, notifications, reminders, waitlists, capacity, rooms, equipment, resources, multi-provider appointments, group appointments, provider login/self scope, multi-location schedules, travel routing, calendar integrations, overbooking, staff overrides, and background slot materialization.

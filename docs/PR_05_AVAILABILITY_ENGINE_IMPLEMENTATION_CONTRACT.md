# PR 5 Implementation Contract — Availability Engine Foundation

Status: **Accepted**

## 1. Outcome

PR 5 lets authorized Business Hub users define when an active provider can theoretically perform an assigned service. It includes recurring weekly hours, recurring breaks, tenant holidays/closures, provider time off, IANA time-zone handling, assignment-level buffers, and a read-only availability preview.

It does **not** create bookings, appointment conflicts, slot cadence, capacity, resources, waitlists, payments, or public availability.

## 2. Invariants and precedence

- Tenant context comes only from the verified selected membership in `admin_sessions`; every query includes that tenant's internal `tenant_id`.
- Client tenant identifiers never authorize or scope a request. Cross-tenant identifiers return the existing safe `404`.
- Existing PR 2–4 authentication, CSRF, role, audit, error-envelope, optimistic-concurrency, and idempotent-lifecycle patterns remain authoritative.
- No feature flag or new service abstraction is introduced.
- Availability precedence is deterministic:
  1. inactive provider, service, or assignment means ineligible;
  2. recurring weekly hours establish candidate working intervals;
  3. recurring breaks are subtracted;
  4. active tenant holidays/closures are subtracted;
  5. active provider time off is subtracted;
  6. service duration plus assignment buffers must fit inside the remaining interval.
- An absent or empty provider schedule means unavailable, not “always available.”
- Buffers are scheduling inputs only. They do not calculate prices, payroll, travel charges, or appointments.

## 3. MongoDB model

### 3.1 `provider_availability_schedules`

One document per tenant/provider:

```text
_id, public_id, tenant_id, provider_id
timezone: IANA string
weekly_hours: [{ day_of_week: 1..7, start_minute: 0..1439, end_minute: 1..1440 }]
breaks: [{ day_of_week: 1..7, start_minute: 0..1439, end_minute: 1..1440 }]
version, created_at, updated_at, created_by, updated_by
```

`effective_from` is intentionally deferred. PR 5 maintains one current schedule per provider; future-dated and historical schedules require an ADR defining overlap, cancellation, selection, and retention behavior rather than a reserved field with no supported workflow.

`day_of_week` uses ISO Monday=1 through Sunday=7. Intervals are half-open `[start,end)`, require `start_minute < end_minute`, cannot overlap, and cannot span midnight. Each break must be fully contained in one working interval. Midnight is represented by `end_minute=1440`.

Indexes:

```javascript
{ key: { tenant_id: 1, provider_id: 1 }, unique: true, name: "availability_schedule_tenant_provider_unique" }
{ key: { tenant_id: 1, public_id: 1 }, unique: true, name: "availability_schedule_tenant_public_id_unique" }
```

### 3.2 `availability_exceptions`

```text
_id, public_id, tenant_id
scope: "tenant" | "provider"
provider_id: ObjectId | null
kind: "holiday" | "closure" | "time_off"
name: string | null
all_day: boolean
timezone: IANA string
starts_on: YYYY-MM-DD | null
ends_before: YYYY-MM-DD | null
starts_at: UTC Date | null
ends_at: UTC Date | null
status: "active" | "inactive"
version, created_at, updated_at, created_by, updated_by
```

All-day exceptions use local half-open dates `[starts_on, ends_before)`. Timed exceptions use UTC half-open instants `[starts_at, ends_at)`. Exactly one representation is populated. Tenant scope permits `holiday|closure`, requires `provider_id=null`, and uses the tenant timezone. Provider scope permits only `time_off` and requires a tenant-owned provider. Records are never physically deleted.

Indexes:

```javascript
{ key: { tenant_id: 1, public_id: 1 }, unique: true, name: "availability_exception_tenant_public_id_unique" }
{ key: { tenant_id: 1, scope: 1, provider_id: 1, status: 1, starts_at: 1, ends_at: 1 }, name: "availability_exception_timed_lookup" }
{ key: { tenant_id: 1, scope: 1, provider_id: 1, status: 1, starts_on: 1, ends_before: 1 }, name: "availability_exception_date_lookup" }
```

### 3.3 Existing `provider_service_assignments`

Add required integer fields:

```text
buffer_before_minutes: 0..1440, default 0
buffer_after_minutes: 0..1440, default 0
```

The assignment version increments only when either value actually changes.

## 4. Time-zone and DST contract

- Each provider schedule stores a valid IANA timezone and initially defaults to the tenant `default_timezone`.
- Recurring minutes are local wall-clock values in that schedule timezone. API results are UTC instants and include the governing timezone.
- On a spring-forward gap, a nonexistent boundary advances to the first valid instant after the gap.
- On a fall-back overlap, a start boundary uses the earlier instant and an end boundary uses the later instant.
- Changing a tenant timezone does not silently rewrite provider schedules or existing exceptions.
- Preview ranges are local dates, inclusive, limited to 31 days.

## 5. API and permissions

All endpoints live under `/api/v1/admin`, use existing envelopes, revalidate membership/role on every request, and reject unknown fields including `tenant_id`.

| Endpoint                                                                 | Owner/Admin | Front desk | Provider |
| ------------------------------------------------------------------------ | ----------: | ---------: | -------: |
| `GET /providers/:providerId/availability-schedule`                       |        View |       View |     View |
| `POST /providers/:providerId/availability-schedule`                      |      Manage |         No |       No |
| `PATCH /providers/:providerId/availability-schedule`                     |      Manage |         No |       No |
| `GET /availability-exceptions`                                           |        View |       View |     View |
| `POST /availability-exceptions`                                          |      Manage |         No |       No |
| `PATCH /availability-exceptions/:exceptionId`                            |      Manage |         No |       No |
| `POST /availability-exceptions/:exceptionId/activate`                    |      Manage |         No |       No |
| `POST /availability-exceptions/:exceptionId/deactivate`                  |      Manage |         No |       No |
| `PATCH /providers/:providerId/service-assignments/:assignmentId/buffers` |      Manage |         No |       No |
| `GET /providers/:providerId/availability-preview`                        |        View |       View |     View |

The provider role is view-only across the selected tenant because `linked_user_id` remains reserved and cannot yet establish “self” scope.

Create schedule payload: `timezone`, `weekly_hours`, and `breaks`. Patch additionally requires `expected_version` and replaces the complete rule arrays atomically. Exception mutation payloads use the discriminated fields above and patch requires `expected_version`. Buffer patch requires `expected_version`, `buffer_before_minutes`, and `buffer_after_minutes`.

Lifecycle retries follow PR 3/4: an already-active or already-inactive exception returns `200`, `changed=false`, does not increment version, and emits no duplicate audit event.

Preview query:

```text
service_public_id=<UUID>&start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
```

The service must have a tenant-owned assignment to the provider. The response identifies eligibility and returns each local date's remaining UTC windows plus `earliest_service_start_at` and `latest_service_start_at`. Every UTC `*_at` field is authoritative and is paired with a derived local timestamp containing its numeric offset (`local_start`, `local_end`, `local_earliest_service_start`, and `local_latest_service_start`). The response also identifies the IANA timezone. Windows too short for buffer-before + service duration + buffer-after are omitted. It returns start ranges, not generated slots, reservations, or a promise of bookability.

## 6. Audit events

Successful actual mutations emit:

```text
provider_availability_schedule_created
provider_availability_schedule_updated
availability_exception_created
availability_exception_updated
availability_exception_activated
availability_exception_deactivated
provider_service_buffers_updated
```

Metadata contains relevant public IDs and prior/new versions, never request secrets or full rule payloads. Failed authorization follows existing security logging; validation failures do not create success audits.

## 7. Business Hub UI

- `/providers/:providerId/availability`: weekly hours, breaks, provider timezone, assigned-service buffers, time off, and a date-range preview.
- `/availability/closures`: tenant holiday/closure list and editor.
- Provider directory/detail links to Availability.
- Owner/admin receive editable controls; front desk/provider receive the same information read-only.
- Editors use labeled controls, keyboard-operable add/remove rows, inline validation, focus management, and accessible status announcements.
- No calendar drag/drop UI is included.

## 8. Migration and seed

Migration command:

```shell
pnpm --filter @booknowtech/api db:migrate
```

The idempotent migration creates both collections and indexes, backfills assignment buffers to zero **before** applying the stricter assignment validator, then verifies indexes and validators.

Seed command:

```shell
pnpm --filter @booknowtech/api db:seed:development
```

Idempotent Brazilian Wax Demo seed:

- Lisa: Monday–Friday 09:00–17:00, break 12:00–12:30, `America/New_York`.
- Sandra: Tuesday–Saturday 10:00–18:00, break 13:00–13:30, `America/New_York`.
- Lisa/Brazilian Wax buffers: 5 before, 10 after.
- Sandra/Brazilian Wax buffers: 0 before, 10 after.
- Tenant closure: New Year's Day 2027, all day.
- Lisa time off: January 15, 2027, all day.

## 9. Automated tests

- Schema normalization, overlap/containment validation, IANA validation, date/instant discrimination, and buffer bounds.
- Authentication, CSRF, fixed-role permissions, membership revalidation, and ignored/forbidden tenant input.
- Tenant A cannot list, infer, mutate, or preview Tenant B schedules, exceptions, assignments, providers, or services.
- Create/update conflicts and stale `expected_version` return existing `409` behavior.
- Idempotent lifecycle retry produces no version increment or duplicate audit.
- Preview precedence, half-open boundaries, duration/buffer fit, missing schedule, inactive entities, and maximum range.
- DST spring gap and fall overlap fixtures.
- UI owner/admin edit flows, view-only roles, validation, empty/error states, keyboard use, and responsive layout.
- OpenAPI request/response/error examples and migration/seed idempotency.

## 10. Acceptance checklist

1. Owner/admin can create and update valid weekly hours and contained breaks.
2. Invalid timezone, overlap, cross-midnight interval, or uncontained break is rejected without mutation/audit.
3. Owner/admin can create, edit, deactivate, and reactivate tenant closures and provider time off.
4. Front desk/provider can view but cannot mutate availability.
5. Assignment buffers persist, validate, and increment version exactly once on change.
6. Preview applies the documented precedence and returns correct theoretical UTC start ranges.
7. DST fixtures follow the documented gap/overlap policy.
8. Inactive provider, service, or assignment produces no eligible window.
9. Cross-tenant reads and writes safely return `404`; forged tenant input cannot change scope.
10. Audit logs contain every actual mutation and no duplicate event for idempotent retry.
11. Migration and seed commands are idempotent; all quality gates pass.
12. Existing PR 2–4 login, switching, profile, service, provider, assignment, and logout regression checks pass.

## 11. Railway, rollout, and rollback

No Railway variable, hostname, route, worker, or networking changes are required. Use the existing same-origin `/api` path and MongoDB configuration.

Rollout: deploy migration first through the existing API pre-deploy command, verify new indexes/validators and buffer backfill, deploy API/frontend, run seed only in staging, then execute the acceptance checklist.

Rollback: redeploy the preceding application commit. Additive collections and buffer fields remain harmless and retain data. Do not drop collections or indexes during rollback. If preview behavior is defective, remove UI entry points by reverting the PR while preserving stored availability data.

## 12. Explicit exclusions

Bookings, appointment conflict detection, slot cadence, public booking, capacity, concurrent appointments, rooms/resources/equipment, provider login linkage, invitations, custom roles, overrides that add special working hours, recurring holidays, travel zones, service-area routing, multi-location schedules, deposits/payments, notifications, waitlists, calendar integrations, and physical deletion.

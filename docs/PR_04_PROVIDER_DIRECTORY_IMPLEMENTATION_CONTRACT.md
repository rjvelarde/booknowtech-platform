# PR 4 Implementation Contract - Provider Directory and Service Assignments

Status: **Accepted**

## 1. Outcome and scope

PR 4 adds tenant-scoped provider management to the Business Hub. Authorized staff can maintain a provider directory and assign existing catalog services to providers.

A provider is an operational business record, not an authenticated user account. Providers may exist and be active without a Business Hub login.

PR 4 delivers:

- provider list, detail, creation, editing, activation, and deactivation;
- provider-to-service assignment management;
- assigned services on provider detail;
- assigned providers on service detail;
- tenant-safe pagination and lookup behavior;
- representative Brazilian Wax Demo provider and assignment seed data.

## 2. Architectural invariants

- Administrative tenant context comes only from the authenticated user's verified selected membership in `admin_sessions`.
- Every provider and assignment database query includes the verified tenant's internal `tenant_id`.
- Request bodies, query parameters, headers, URLs, and browser storage never supply authoritative tenant context.
- Provider records are distinct from `users` and `roles`.
- `linked_user_id` is reserved only for future linkage. It is not accepted by PR 4 API requests, displayed as editable UI, or used for login, authentication, authorization, invitations, sessions, or provider self-service.
- Assignment removal is an idempotent transition to `inactive`. Providers and assignments are never physically deleted.
- Existing PR 2 and PR 3 patterns remain authoritative for authentication, CSRF, role checks, audit logging, validation errors, optimistic concurrency, safe `404` responses, and response envelopes.
- PR 4 introduces no feature flag and no new service or architectural abstraction.

## 3. MongoDB collections

### 3.1 `providers`

```text
providers
- _id: ObjectId
- public_id: string UUID
- tenant_id: ObjectId
- internal_code: string | null
- display_name: string
- first_name: string | null
- last_name: string | null
- email_normalized: string | null
- phone_e164: string | null
- photo_url: string | null
- bio: string | null
- status: "active" | "inactive"
- customer_selectable: boolean
- accepting_new_clients: boolean
- display_order: integer
- linked_user_id: ObjectId | null
- version: positive integer
- created_at: UTC Date
- updated_at: UTC Date
- created_by: ObjectId
- updated_by: ObjectId
```

Validation and defaults:

| Field                     | Contract                                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `public_id`               | Server-generated UUID; immutable.                                                                               |
| `tenant_id`               | Server-derived internal tenant ObjectId; immutable.                                                             |
| `internal_code`           | Optional; trim and uppercase; 1-64 characters when present; only `A-Z`, `0-9`, `.`, `_`, `-`.                   |
| `display_name`            | Required; trimmed; 1-160 characters.                                                                            |
| `first_name`, `last_name` | Nullable; trimmed; 1-100 characters when present.                                                               |
| `email_normalized`        | Nullable; trim and lowercase; maximum 320 characters; valid email syntax when present.                          |
| `phone_e164`              | Nullable; trim; E.164 format `^\+[1-9][0-9]{1,14}$` when present.                                               |
| `photo_url`               | Nullable; absolute HTTPS URL only; maximum 2,048 characters. No upload or asset management in PR 4.             |
| `bio`                     | Nullable; trimmed; maximum 4,000 characters.                                                                    |
| `status`                  | Server-set to `active` on creation. Only lifecycle endpoints change it.                                         |
| `customer_selectable`     | Required boolean; default `true` when omitted.                                                                  |
| `accepting_new_clients`   | Required boolean; default `true` when omitted. Setting `false` does not deactivate the provider or assignments. |
| `display_order`           | Nonnegative integer from 0 through 1,000,000; default `0`. Used only for stable administrative display order.   |
| `linked_user_id`          | Always `null` through PR 4 workflows. Reserved for future linkage only.                                         |
| `version`                 | Starts at `1`; increments exactly once for each successful actual mutation.                                     |
| actor/timestamps          | Server-generated and never accepted from clients.                                                               |

Indexes:

```javascript
{ key: { tenant_id: 1, public_id: 1 }, unique: true, name: "providers_tenant_public_id_unique" }

{
  key: { tenant_id: 1, internal_code: 1 },
  unique: true,
  partialFilterExpression: { internal_code: { $type: "string" } },
  name: "providers_tenant_internal_code_unique"
}

{
  key: { tenant_id: 1, status: 1, display_order: 1, display_name: 1, public_id: 1 },
  name: "providers_directory_list"
}

{ key: { tenant_id: 1, updated_at: -1, public_id: 1 }, name: "providers_updated" }
```

Inactive providers remain subject to internal-code uniqueness.

### 3.2 `provider_service_assignments`

```text
provider_service_assignments
- _id: ObjectId
- public_id: string UUID
- tenant_id: ObjectId
- provider_id: ObjectId
- service_id: ObjectId
- status: "active" | "inactive"
- version: positive integer
- created_at: UTC Date
- updated_at: UTC Date
- created_by: ObjectId
- updated_by: ObjectId
```

Validation and lifecycle:

- `tenant_id`, `provider_id`, and `service_id` are internal ObjectIds and immutable.
- New assignments start `active` with `version=1`.
- One persistent record exists per tenant/provider/service combination.
- Removing an assignment transitions it to `inactive`; no endpoint physically deletes it.
- Reassigning a previously inactive relationship uses the assignment activation endpoint.

Indexes:

```javascript
{
  key: { tenant_id: 1, provider_id: 1, service_id: 1 },
  unique: true,
  name: "provider_service_tenant_provider_service_unique"
}

{
  key: { tenant_id: 1, public_id: 1 },
  unique: true,
  name: "provider_service_tenant_public_id_unique"
}

{
  key: { tenant_id: 1, provider_id: 1, status: 1, service_id: 1 },
  name: "provider_service_by_provider"
}

{
  key: { tenant_id: 1, service_id: 1, status: 1, provider_id: 1 },
  name: "provider_service_by_service"
}

{
  key: { tenant_id: 1, updated_at: -1, public_id: 1 },
  name: "provider_service_updated"
}
```

MongoDB validators require all listed fields and enforce ObjectId, date, integer, boolean, enum, and nullability constraints. API validation remains the primary source of user-facing validation messages.

## 4. Eligibility semantics

PR 4 stores and reports eligibility inputs but does not calculate availability or create bookings.

- An inactive provider is excluded from future service eligibility.
- An inactive service is excluded from future service eligibility.
- An inactive assignment is excluded from future service eligibility.
- A provider is operationally eligible for a service only when provider, service, and assignment are all active.
- `customer_selectable=false` providers remain visible to all authorized Business Hub roles and keep their assignments. They are excluded from future public booking provider selection.
- `accepting_new_clients=false` does not deactivate the provider, alter assignments, or hide the provider from Business Hub. It is a stored policy input for a future booking workflow.
- PR 4 does not attempt to determine whether a customer is new or existing.

Administrative responses expose the relevant statuses and both booleans. They do not make a booking decision.

## 5. API conventions

All endpoints:

- use the existing `/api/v1/admin` namespace;
- require the secure administrative session and selected membership;
- use existing same-origin CSRF and origin validation for mutations;
- return the existing `{ data, meta: { request_id } }` envelope;
- return stable error codes in the existing error envelope;
- never accept `tenant_id`;
- revalidate membership and role on every request.

### 5.1 Provider endpoints

#### `GET /api/v1/admin/providers`

Permission: all four fixed roles.

Query:

```text
status=active|inactive|all   default: all
limit=1..100                default: 25
cursor=<opaque cursor>      optional
```

Ordering is always `display_order ASC`, `display_name ASC`, `public_id ASC`.

The opaque Base64URL cursor contains only the last returned ordering tuple. The backend strictly validates its types and lengths. The continuation query always includes the verified `tenant_id`; cursor contents can never alter tenant scope. Invalid cursors return `400 invalid_cursor`.

Response:

```json
{
  "data": {
    "items": [
      {
        "public_id": "uuid",
        "internal_code": "LISA",
        "display_name": "Lisa",
        "first_name": "Lisa",
        "last_name": null,
        "email": null,
        "phone": null,
        "photo_url": null,
        "bio": null,
        "status": "active",
        "customer_selectable": true,
        "accepting_new_clients": true,
        "display_order": 10,
        "version": 1,
        "updated_at": "2026-07-27T12:00:00.000Z"
      }
    ],
    "next_cursor": null
  },
  "meta": { "request_id": "request-id" }
}
```

`linked_user_id` is not returned in PR 4.

#### `POST /api/v1/admin/providers`

Permission: `tenant_owner`, `tenant_admin`.

Request:

```json
{
  "internal_code": "LISA",
  "display_name": "Lisa",
  "first_name": "Lisa",
  "last_name": null,
  "email": null,
  "phone": null,
  "photo_url": null,
  "bio": null,
  "customer_selectable": true,
  "accepting_new_clients": true,
  "display_order": 10
}
```

Omitted nullable fields become `null`. Omitted booleans become `true`; omitted `display_order` becomes `0`. Returns `201` with the provider view.

Duplicate normalized internal code within the selected tenant returns `409 internal_code_conflict`. Another tenant's matching code does not conflict and is never disclosed.

#### `GET /api/v1/admin/providers/{providerPublicId}`

Permission: all four fixed roles.

Returns the provider plus its active and inactive service assignments. A nonexistent or other-tenant ID returns the same `404 provider_not_found` response.

#### `PATCH /api/v1/admin/providers/{providerPublicId}`

Permission: `tenant_owner`, `tenant_admin`.

Request accepts one or more editable fields and requires:

```json
{
  "expected_version": 3,
  "display_name": "Lisa W.",
  "accepting_new_clients": false,
  "display_order": 20
}
```

The endpoint does not accept `status`, `tenant_id`, `linked_user_id`, IDs, actors, timestamps, or assignment fields. Returns `409 version_conflict` for a stale actual mutation.

#### `POST /api/v1/admin/providers/{providerPublicId}/activate`

#### `POST /api/v1/admin/providers/{providerPublicId}/deactivate`

Permission: `tenant_owner`, `tenant_admin`.

Request:

```json
{ "expected_version": 3 }
```

Actual transitions increment the version once, update actor/time fields, and write one audit event. If already in the requested state, return `200`, `changed=false`, the current provider, no version increment, no timestamp change, and no duplicate audit event, even when a retry carries the pre-transition version.

### 5.2 Assignment endpoints

#### `GET /api/v1/admin/providers/{providerPublicId}/service-assignments`

Permission: all four fixed roles.

Returns all active and inactive assignments for the selected-tenant provider, joined to safe service catalog views. Provider and assignment queries are tenant scoped.

#### `POST /api/v1/admin/providers/{providerPublicId}/service-assignments`

Permission: `tenant_owner`, `tenant_admin`.

Request:

```json
{ "service_public_id": "service-uuid" }
```

Behavior:

- Resolve both provider and service by verified `tenant_id` plus public ID.
- If either is missing or belongs to another tenant, return the same `404 assignment_target_not_found` response.
- If no relationship exists, create an active assignment and return `201`, `changed=true`.
- If an active relationship already exists, return `200`, `changed=false`, with no mutation or audit event.
- If an inactive relationship exists, return `409 assignment_inactive` with its safe assignment public ID and current version so the client can explicitly activate it.
- Provider or service inactive status does not prevent record creation, but the UI warns that the assignment is not operationally eligible until all three statuses are active. This preserves configuration without implying availability.

#### `POST /api/v1/admin/providers/{providerPublicId}/service-assignments/{assignmentPublicId}/activate`

#### `POST /api/v1/admin/providers/{providerPublicId}/service-assignments/{assignmentPublicId}/deactivate`

Permission: `tenant_owner`, `tenant_admin`.

Request:

```json
{ "expected_version": 2 }
```

The provider and assignment must resolve under the same verified tenant, and the assignment must belong to the provider path. Cross-tenant, mismatched, and nonexistent identifiers return the same `404 assignment_not_found` response.

Lifecycle retry semantics match providers and PR 3 services: `200`, `changed=false`, no version increment, no timestamp change, and no duplicate audit event when already in the requested state.

### 5.3 Service-side provider endpoint

#### `GET /api/v1/admin/services/{servicePublicId}/provider-assignments`

Permission: all four fixed roles.

Returns active and inactive assignment records and safe provider views for the selected-tenant service. Each item includes provider status, assignment status, `customer_selectable`, and `accepting_new_clients`. The response exposes whether the provider/service/assignment active-state triad is operationally eligible, but performs no scheduling or booking logic.

Another tenant's or nonexistent service ID returns the existing safe `404 service_not_found` response.

## 6. Permission matrix

| Endpoint capability                    | `tenant_owner` | `tenant_admin` | `front_desk` | `provider` |
| -------------------------------------- | -------------- | -------------- | ------------ | ---------- |
| List/view providers                    | Allow          | Allow          | Allow        | Allow      |
| View provider assignments              | Allow          | Allow          | Allow        | Allow      |
| View service-side provider assignments | Allow          | Allow          | Allow        | Allow      |
| Create/edit providers                  | Allow          | Allow          | Deny         | Deny       |
| Activate/deactivate providers          | Allow          | Allow          | Deny         | Deny       |
| Create/activate/deactivate assignments | Allow          | Allow          | Deny         | Deny       |

Denied mutations return `403 insufficient_role`. Hiding controls in the UI is not authorization enforcement.

## 7. Tenant-isolation rules

- Repository/store methods require an internal tenant ObjectId as an explicit argument.
- Provider reads use `{ tenant_id, public_id }`; assignment reads use `{ tenant_id, ... }` and never public ID alone.
- Provider internal-code duplicate checks and unique indexes include `tenant_id`.
- Provider/service assignment creation resolves both sides within the same tenant before inserting.
- Assignment lifecycle updates include `tenant_id`, assignment public ID, provider internal ID, expected version, and current status in the atomic filter.
- Pagination continuation queries always include `tenant_id` independently of cursor contents.
- API payload schemas set `additionalProperties=false`; `tenant_id` and `linked_user_id` are rejected.
- Browser storage contains no authoritative tenant or provider authorization context.
- Safe `404` behavior prevents probing provider, assignment, service, and internal-code existence across tenants.

Required adversarial tests prove Tenant A cannot read, create, update, activate, deactivate, assign, infer, or paginate into Tenant B provider or assignment data.

## 8. Optimistic concurrency and idempotency

- Provider and assignment creation starts at `version=1`.
- Editable provider updates require `expected_version` and atomically match tenant, public ID, and version.
- Actual provider or assignment lifecycle transitions require the expected current version and increment once.
- Stale actual mutations return `409 version_conflict` without changing data or writing a success audit event.
- Lifecycle endpoints first resolve the tenant-scoped record. If it is already in the requested state, they return `200`, `changed=false` regardless of a retry's now-stale expected version.
- Unchanged lifecycle retries do not update `updated_at`, `updated_by`, or `version`, and do not create another audit event.
- Assignment creation retries against an already active assignment are likewise unchanged and unaudited.

## 9. Audit events

Successful actual mutations write:

| Event                                     | Metadata                                                          |
| ----------------------------------------- | ----------------------------------------------------------------- |
| `provider_created`                        | provider public ID, normalized internal code or null              |
| `provider_updated`                        | provider public ID, sorted changed field names, prior/new version |
| `provider_activated`                      | provider public ID, prior/new version                             |
| `provider_deactivated`                    | provider public ID, prior/new version                             |
| `provider_service_assignment_created`     | assignment, provider, and service public IDs                      |
| `provider_service_assignment_activated`   | assignment, provider, service public IDs; prior/new version       |
| `provider_service_assignment_deactivated` | assignment, provider, service public IDs; prior/new version       |

Every event includes existing actor user ID, verified tenant ID, request ID, outcome, and timestamp conventions. Audit metadata never includes email, phone, bio, session tokens, CSRF tokens, credentials, or photo URL query strings.

Idempotent no-change retries do not write audit events. Rejected cross-tenant attempts use existing authorization/security logging conventions without disclosing target existence.

## 10. Migration

Command:

```shell
pnpm --filter @booknowtech/api db:migrate
```

The idempotent migration:

1. Creates `providers` and `provider_service_assignments` with strict validators if absent.
2. Reapplies validators with `collMod` when present.
3. Creates the exact indexes defined above by stable names.
4. Does not modify PR 2/3 user, role, tenant, session, service, or audit documents.
5. Does not create providers from users and does not populate `linked_user_id`.

Migration integration tests run twice and prove repeatability, required indexes, enum rejection, internal-code uniqueness per tenant, cross-tenant code reuse, and assignment uniqueness.

Rollback is additive: prior application revisions ignore both collections. Emergency rollback never drops either collection or its records.

## 11. Staging seed

Command:

```shell
pnpm --filter @booknowtech/api db:seed:development
```

The existing environment restriction remains: development, test, and staging only. No new seed credentials or Railway variables are introduced. The seed remains idempotent by tenant plus normalized internal code and tenant/provider/service relationship.

### Providers for Brazilian Wax Demo

| Field                   | Lisa   | Sandra   |
| ----------------------- | ------ | -------- |
| `internal_code`         | `LISA` | `SANDRA` |
| `display_name`          | Lisa   | Sandra   |
| `first_name`            | Lisa   | Sandra   |
| `last_name`             | null   | null     |
| `status`                | active | active   |
| `customer_selectable`   | true   | true     |
| `accepting_new_clients` | true   | true     |
| `display_order`         | 10     | 20       |
| `photo_url`             | null   | null     |
| `linked_user_id`        | null   | null     |

### Exact service-assignment matrix

All seeded assignments have `status=active`.

| Service internal code | Lisa         | Sandra       |
| --------------------- | ------------ | ------------ |
| `BRAZILIAN-WAX`       | Assigned     | Assigned     |
| `BRAZILIAN-FIRST`     | Assigned     | Not assigned |
| `FULL-FACE`           | Assigned     | Assigned     |
| `CHEST-STOMACH`       | Not assigned | Assigned     |

`CHEST-STOMACH` is currently an inactive service. Sandra's active assignment remains stored and visible but is not operationally eligible until the service is activated. This explicitly validates the inactive-service rule without deleting configuration.

The seed does not create or alter Business Hub users, roles, invitations, passwords, or `linked_user_id`.

## 12. Frontend routes and screens

### Routes

```text
/providers
/providers/new
/providers/:providerPublicId
/providers/:providerPublicId/edit
/services/:servicePublicId
```

All routes render inside the existing authenticated Business Hub shell and reuse its native same-origin `/api` client.

### Provider directory - `/providers`

- Paginated provider list ordered by display order then name.
- Status filter with active, inactive, and all.
- Displays photo when present and accessible fallback initials when absent.
- Displays accepting-new-clients and customer-selectable indicators.
- Owner/admin sees Add Provider; other roles receive view-only presentation.

### Create/edit provider

- Labelled fields for all editable provider attributes.
- `linked_user_id` is absent.
- Status is absent; lifecycle actions remain separate.
- Client constraints match API constraints without replacing backend validation.
- API validation and version-conflict errors are announced accessibly and preserve entered values.

### Provider detail

- Provider identity, contact, status, selection-policy fields, and biography.
- Assigned services section includes active and inactive assignments and service status.
- Owner/admin can assign a service or activate/deactivate an assignment.
- Owner/admin can activate/deactivate the provider.
- Front desk/provider role sees the same operational information without mutation controls.

### Service detail

- Existing service information remains authoritative.
- New Provider Assignments section lists assigned providers and provider/assignment status.
- The UI clearly distinguishes inactive provider, inactive service, and inactive assignment states.
- `customer_selectable` and `accepting_new_clients` are displayed as policy attributes, not booking decisions.

### Accessibility

- All inputs have programmatic labels and described validation errors.
- Status is conveyed by text, not color alone.
- Lists, pagination, dialogs, and lifecycle controls are keyboard operable with visible focus.
- Destructive-sounding actions use "Deactivate," not "Delete" or "Remove," because data is preserved.
- Dynamic success/error messages use appropriate live regions.

## 13. Automated tests

### Migration/store tests

- Migration is repeatable and creates exact validators and indexes.
- Provider internal code normalizes and is unique within one tenant, including inactive providers.
- The same code is allowed in different tenants.
- One assignment record per tenant/provider/service is enforced.
- Every store query includes tenant scope.
- Cross-tenant provider/service assignment is rejected.
- `linked_user_id` remains null and is not accepted through mutation inputs.

### API tests

- All roles can read; only owner/admin mutate.
- Client tenant overrides cannot affect scope.
- Cross-tenant and nonexistent identifiers produce equivalent safe `404` responses.
- Pagination cannot cross tenant boundaries and invalid cursors fail safely.
- Provider validation covers every field and normalization rule.
- Assignment creation, inactive conflict, activation, and deactivation behavior are exact.
- Stale actual mutations return `409`.
- Provider and assignment lifecycle retries return `200`, `changed=false`, with unchanged version/time and no duplicate audit.
- Inactive provider/service/assignment eligibility rules are represented correctly.
- `customer_selectable=false` remains visible administratively.
- `accepting_new_clients=false` preserves provider and assignments.
- OpenAPI includes every endpoint, request schema, response, and stable error code.

### Frontend tests

- Owner/admin create, edit, activate, deactivate, and manage assignments.
- Front desk/provider see no mutation controls.
- Provider form remains editable and preserves values on validation errors.
- Provider and service detail show both sides of assignments.
- Status and policy fields are accessible.
- Direct route refresh and browser back/forward navigation work.

### Seed tests

- Repeated seed runs do not duplicate providers or assignments.
- Lisa and Sandra fields and the exact assignment matrix match this contract.
- No credentials, users, roles, invitations, or linkage fields are introduced.

## 14. Acceptance checklist

- [ ] Owner/admin can list, view, create, and edit selected-tenant providers.
- [ ] Owner/admin can activate/deactivate providers with PR 3 retry semantics.
- [ ] All fixed roles can view providers and assignments.
- [ ] Front desk/provider mutations return `403` even when called directly.
- [ ] Provider fields, normalization, defaults, and limits match the schema.
- [ ] `display_order`, nullable `photo_url`, and `accepting_new_clients` persist correctly.
- [ ] `linked_user_id` remains null, unexposed, and unused by all PR 4 authentication/invitation flows.
- [ ] Internal codes are unique per tenant and reusable by another tenant.
- [ ] Providers can receive one or more existing selected-tenant services.
- [ ] Duplicate active assignment requests are idempotent.
- [ ] Assignment removal transitions to inactive and never deletes data.
- [ ] Assignment reactivation preserves the same record and public ID.
- [ ] Inactive provider, service, or assignment is excluded from operational eligibility.
- [ ] `customer_selectable=false` remains visible in Business Hub and is marked unavailable for future public selection.
- [ ] `accepting_new_clients=false` leaves provider and assignments active and unchanged.
- [ ] Tenant A cannot read, infer, modify, assign, or paginate into Tenant B data.
- [ ] Actual mutations increment version once and write one audit event.
- [ ] No-change retries leave version/time unchanged and write no duplicate audit event.
- [ ] Provider detail shows assigned services; service detail shows assigned providers.
- [ ] Lisa and Sandra seed data and assignment matrix are exact and idempotent.
- [ ] Accessibility requirements pass keyboard and screen-reader-oriented tests.
- [ ] API OpenAPI, lint, typecheck, tests, build, and secret scan pass.

## 15. Railway rollout

No new Railway variables, services, public domains, private hostnames, ports, volumes, or routing changes are required.

Keep the established values, including:

```text
VITE_API_BASE_URL=/api
API_PRIVATE_ORIGIN=http://booknowtechapi.railway.internal:8080
TENANT_ADMIN_ENABLED=true
```

Rollout sequence:

1. Merge only after all required GitHub checks pass.
2. API pre-deploy runs `pnpm --filter @booknowtech/api db:migrate`.
3. Confirm migration completes and API health remains ready.
4. Confirm frontend, API, and worker deploy the same `main` revision and remain online.
5. Run `pnpm --filter @booknowtech/api db:seed:development` once in the API staging console using the existing approved staging seed procedure; do not add permanent variables.
6. Execute the PR 4 acceptance checklist in Brazilian Wax Demo and a second tenant.
7. Verify Atlas documents, indexes, versions, assignment preservation, and audit events.
8. Confirm logs contain no credentials, session/CSRF tokens, provider contact data, or full photo URL query strings.

## 16. Rollback

Application rollback:

1. Redeploy the prior known-good API and frontend `main` revision.
2. Confirm all three Railway services remain online and PR 3 workflows still operate.
3. Leave `providers` and `provider_service_assignments` intact; the prior application ignores them.
4. Do not drop collections, indexes, or provider/assignment records during emergency rollback.

Operational disablement, if needed without an application rollback:

- Hide provider navigation only through a corrective deployment; PR 4 adds no indefinite feature flag.
- Existing PR 2/3 Business Hub and service catalog workflows remain independent of provider records and assignments.

Any later destructive cleanup or schema reversal requires a separately reviewed migration. No production data deletion is part of PR 4 rollback.

## 17. Explicit exclusions

PR 4 does not implement:

- schedules, calendars, weekly hours, time off, or availability calculations;
- appointments or public booking flows;
- customers or new-versus-existing customer determination;
- rooms, chairs, equipment, or other resources;
- provider-specific price or duration overrides;
- deposits, taxes, processor/platform/partner fees, commissions, payroll, tips, payouts, settlement, or Stripe Connect;
- provider invitations, authentication, login, self-service, or account linking;
- `linked_user_id` mutation or lookup workflows;
- photo upload, image processing, storage, or asset deletion;
- physical deletion or archival of providers or assignments;
- custom roles, new session systems, or unrelated abstractions.

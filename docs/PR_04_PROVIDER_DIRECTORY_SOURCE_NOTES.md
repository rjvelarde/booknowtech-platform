# PR 4 Source Notes - Provider Directory and Service Assignments

Source: `Untitled document.pdf` supplied July 27, 2026.

Status: Planning source only. Do not implement until the PR 4 implementation contract is reviewed and approved.

## Starting state

- PR 3 is QA-complete.
- Railway seed credentials have been removed.
- `TENANT_ADMIN_ENABLED=true` remains in place.

## Objective

Add tenant-scoped provider management so appointment businesses can define the people who perform services and assign eligible services to them.

Representative businesses:

- Brazilian wax studios
- Braiding businesses
- Acupuncture practices
- Other appointment-based service providers

## Architectural distinction

A provider record is not an authenticated user account.

A provider:

- may exist without a Business Hub login;
- may optionally be linked to a tenant user later;
- belongs to exactly one tenant;
- may perform one or more services;
- may be active or inactive.

`linked_user_id` is optional and must not be required to create or activate a provider. It is a reserved field only in PR 4. PR 4 must not use it for authentication, authorization, invitations, session selection, or provider self-service.

Additional provider catalog fields:

- `display_order` controls stable administrative presentation order and does not affect scheduling or eligibility.
- `photo_url` stores an optional provider image URL; PR 4 does not add image upload or asset management.
- `accepting_new_clients` records whether the provider is accepting new clients; PR 4 stores and manages the value but does not perform booking or availability calculations from it.

## Proposed `providers` collection

```text
providers
- _id: ObjectId
- public_id: UUID string
- tenant_id: ObjectId
- internal_code: nullable normalized string
- display_name: string
- first_name: nullable string
- last_name: nullable string
- email_normalized: nullable string
- phone_e164: nullable string
- photo_url: nullable string
- bio: nullable string
- status: active | inactive
- customer_selectable: boolean
- accepting_new_clients: boolean
- display_order: nonnegative integer
- linked_user_id: nullable ObjectId
- version: positive integer
- created_at: UTC Date
- updated_at: UTC Date
- created_by: ObjectId
- updated_by: ObjectId
```

## Proposed `provider_service_assignments` collection

```text
provider_service_assignments
- _id: ObjectId
- public_id: UUID string
- tenant_id: ObjectId
- provider_id: ObjectId
- service_id: ObjectId
- status: active | inactive
- version: positive integer
- created_at: UTC Date
- updated_at: UTC Date
- created_by: ObjectId
- updated_by: ObjectId
```

Constraints:

- Enforce one assignment per tenant/provider/service combination.
- Both provider and service must belong to the verified selected tenant.
- Deactivation preserves provider and assignment records.

## Required capabilities

- List providers.
- View a provider.
- Create a provider.
- Edit a provider.
- Activate or deactivate a provider.
- Assign services to a provider.
- Remove or deactivate service assignments.
- Show assigned services on the provider detail page.
- Show eligible providers on the service detail page.
- Preserve provider and assignment records when deactivated.

## Permissions

| Capability                       | Tenant owner | Tenant admin | Front desk | Provider role |
| -------------------------------- | ------------ | ------------ | ---------- | ------------- |
| View providers                   | Yes          | Yes          | Yes        | Yes           |
| View service assignments         | Yes          | Yes          | Yes        | Yes           |
| Create or edit providers         | Yes          | Yes          | No         | No            |
| Activate or deactivate providers | Yes          | Yes          | No         | No            |
| Manage service assignments       | Yes          | Yes          | No         | No            |

The provider role has no mutation rights in PR 4.

## Tenant isolation and authorization

- Every provider and assignment query must include `tenant_id`.
- Tenant context comes exclusively from the verified selected administrative membership.
- Client-supplied tenant IDs are never authoritative.
- Cross-tenant and nonexistent provider identifiers return equivalent safe responses.
- Pagination cursors must be tenant-bound and must not cross tenant boundaries.
- Prevent assigning a Tenant B service to a Tenant A provider.
- Prevent linking a provider to a user outside the tenant.
- Prevent detection of another tenant's provider internal code.

## Provider internal-code rules

Use the PR 3 service-code rules:

- normalize to uppercase;
- 1-64 characters;
- allow only `A-Z`, `0-9`, `.`, `_`, and `-`;
- unique within the tenant when present;
- include inactive providers in uniqueness enforcement.

Examples:

```text
LISA
PROVIDER-02
SANDRA_W
```

## Explicit exclusions

PR 4 must not add:

- calendars;
- weekly working hours;
- time off;
- availability calculations;
- appointment booking;
- customer records;
- rooms, chairs, or physical resources;
- provider-specific service prices;
- provider-specific duration overrides;
- commissions;
- payroll;
- tips;
- payouts;
- Stripe Connect;
- provider invitations;
- provider self-service profile editing;
- provider authentication or authorization through `linked_user_id`;
- provider photo upload or image asset management.

These capabilities require later approved PRs.

## Staging seed

Extend Brazilian Wax Demo with two representative providers:

```text
Lisa
internal_code=LISA
status=active
customer_selectable=true

Provider Two
internal_code=PROVIDER-02
status=active
customer_selectable=true
```

Assign both providers to appropriate wax services so later scheduling QA can test:

- customer selects a provider;
- customer selects no preference;
- the system identifies all eligible providers.

Do not add seed credentials or permanent Railway variables.

## Patterns to reuse

Reuse the established PR 2 and PR 3 patterns for:

- administrative sessions;
- fixed roles;
- session-derived tenant context;
- backend role and membership revalidation;
- validation;
- audit logging;
- optimistic concurrency and version conflicts;
- accessibility;
- safe `404` behavior.

## Required implementation-contract deliverables

The PR 4 contract must provide:

1. Exact MongoDB schemas and indexes.
2. Endpoint list and request/response payloads.
3. Permission matrix.
4. Tenant-isolation rules.
5. Optimistic-concurrency behavior.
6. Audit events.
7. Migration and seed commands.
8. Frontend routes and screens.
9. Acceptance-test checklist.
10. Railway rollout and rollback plan.

## Contract decisions still requiring precision

The source brief leaves these details for the implementation contract:

- Whether assignment removal means an idempotent transition to `inactive` only; physical deletion should remain excluded unless explicitly approved.
- Exact provider and assignment endpoint paths, filters, pagination shape, and tenant-bound cursor format.
- `linked_user_id` is reserved only; the contract must not expose a PR 4 linking workflow.
- Eligibility behavior when a provider, service, or assignment is inactive.
- Whether `customer_selectable=false` providers remain visible to all Business Hub roles while being excluded only from future public customer selection.
- Normalization and validation details for names, email, E.164 phone numbers, and biography length.
- Exact validation and default values for `display_order`, `photo_url`, and `accepting_new_clients`.
- Idempotent activate/deactivate semantics and audit behavior, following the PR 3 lifecycle pattern.
- Seed assignment matrix identifying exactly which wax services belong to each seeded provider.

# PR 7 Implementation Contract — Customer Records Foundation

Status: **Accepted**

## 1. Objective and user outcome

PR 7 introduces the tenant-owned customer master record used by future appointments, payments, waivers, communications, documents, reporting, APIs, and integrations. Authorized Business Hub staff can search, view, create, edit, deactivate, and reactivate customers while receiving deterministic warnings about likely duplicates.

PR 7 does not create appointments, customer authentication, communications, payment objects, documents, notes, or cross-business identities.

## 2. Identity decision and architectural invariants

Customers are **tenant scoped**. The same real person may have an independent customer record at Brazilian Wax Demo and Braiding Demo, even when email or phone matches. No query, duplicate check, search result, index, or API response crosses the selected tenant boundary.

This decision preserves business ownership, privacy, retention, and consent boundaries. A future global identity layer may link tenant customer public IDs after a separate ADR; PR 7 does not reserve a global-person ID or assume that matching contact information proves the same person.

All PR 2–6 invariants remain authoritative:

- tenant context comes only from the authenticated `admin_sessions` record and its revalidated selected membership;
- every customer query includes the verified internal `tenant_id`;
- tenant IDs supplied through paths, bodies, queries, headers, cursors, or browser storage are never authorization context;
- inaccessible and cross-tenant public IDs return the existing safe `404`;
- mutations use same-origin CSRF protection, fixed roles, validation, optimistic concurrency, audit events, and existing response envelopes;
- customer records are never physically deleted;
- no new service, process, queue, cache, feature flag, Railway variable, or authentication workflow is introduced.

## 3. `customers` collection

```text
customers
- _id: ObjectId
- public_id: string UUID
- tenant_id: ObjectId
- first_name: string
- last_name: string | null
- preferred_name: string | null
- first_name_normalized: string
- last_name_normalized: string | null
- full_name_normalized: string
- email_normalized: string | null
- mobile_phone_e164: string | null
- mobile_phone_digits: string | null
- addresses: CustomerAddress[]
- communication_preferences:
    preferred_channel: "email" | "sms" | "phone" | "none" | null
    marketing_email: "unknown" | "opted_in" | "opted_out"
    marketing_sms: "unknown" | "opted_in" | "opted_out"
- source: "manual" | "seed" | "import" | "public_booking" | "partner_api"
- external_references: ExternalReference[]
- status: "active" | "inactive"
- deactivated_at: UTC Date | null
- version: positive integer
- created_at: UTC Date
- updated_at: UTC Date
- created_by: ObjectId
- updated_by: ObjectId
```

### 3.1 Field rationale and validation

| Field                     | Contract and reason                                                                                                                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `public_id`               | Server-generated immutable UUID used by APIs and future relationships; internal ObjectIds never leave the API.                                                                                           |
| `tenant_id`               | Server-derived immutable ObjectId enforcing business ownership.                                                                                                                                          |
| `first_name`              | Required, trimmed, 1–100 characters. Supports directory display and future booking forms.                                                                                                                |
| `last_name`               | Nullable, trimmed, 1–100 characters when present. Nullable supports single-name customers without fabricated data.                                                                                       |
| `preferred_name`          | Nullable, trimmed, 1–100 characters. Used for respectful Business Hub display; legal identity is not implied.                                                                                            |
| normalized name fields    | Server-generated Unicode-normalized, case-folded, whitespace-collapsed search values. Never accepted from or returned to clients.                                                                        |
| `email_normalized`        | Nullable, trimmed, lowercased, valid email, maximum 320 characters. The API returns it as `email`. Shared email addresses remain permitted.                                                              |
| `mobile_phone_e164`       | Nullable canonical E.164 value. Business Hub accepts a US-friendly 10-digit input and normalizes it to `+1`; already valid E.164 is accepted. The API returns it as `mobile_phone`.                      |
| `mobile_phone_digits`     | Server-derived digits-only search value; never accepted from or returned to clients.                                                                                                                     |
| `addresses`               | Embedded customer-owned addresses, maximum 5. They are reusable contact data, not appointment-location snapshots.                                                                                        |
| communication preferences | Captures stated channel preferences only. It does not send messages or constitute a complete statutory consent ledger. Defaults are `preferred_channel=null`, marketing states `unknown`.                |
| `source`                  | Immutable creation attribution. PR 7 Business Hub creates `manual`; the development seed creates `seed`. Other enum values are reserved for approved future workflows and cannot be selected in PR 7 UI. |
| `external_references`     | Reserved structured identifiers for future imports and partner APIs. Business Hub PR 7 requests cannot set them. No generic metadata object is introduced.                                               |
| `status`                  | New customers start `active`; only lifecycle endpoints change status.                                                                                                                                    |
| `deactivated_at`          | Records the latest transition to inactive; cleared on reactivation. It is not deletion or legal erasure.                                                                                                 |
| `version`                 | Starts at 1 and increments once per actual successful mutation.                                                                                                                                          |
| actor/timestamps          | Server-generated and immutable from client input.                                                                                                                                                        |

At least one of `email_normalized` or `mobile_phone_e164` is recommended but not required. A customer may be created with a name only for walk-in and privacy-sensitive workflows.

### 3.2 Computed display name

`display_name` is a **server-computed response field** and is not stored in MongoDB or accepted in request payloads. Every API response derives it consistently as:

```text
given display name = preferred_name when present, otherwise first_name
display_name = given display name + last_name when last_name is present
```

For example, `first_name="Alexandra"`, `preferred_name="Alex"`, and `last_name="Morgan"` produces `display_name="Alex Morgan"`. The authoritative identity fields remain `first_name`, `last_name`, and `preferred_name`; clients must render the returned `display_name` rather than recreate this rule. Duplicate detection continues to use normalized `first_name + last_name`, not the preferred display name.

### 3.3 `first_seen_at` decision

`first_seen_at` is intentionally **deferred**. In PR 7, `created_at` means when the tenant customer record was created in BookNowTech. It must not be presented as the customer's first relationship or interaction with the business.

Imports may contain a historical acquisition date, while public booking may define first seen as the first submitted booking, first completed appointment, or first verified contact. Storing `first_seen_at` before those semantics and precedence rules exist would create unreliable history. The first import or public-booking contract that needs it must define its meaning, source precedence, correction rules, and backfill behavior.

### 3.4 Address subdocument

```text
CustomerAddress
- public_id: string UUID
- label: "home" | "work" | "other"
- line_1: string
- line_2: string | null
- city: string
- region: string
- postal_code: string
- country_code: two-letter ISO 3166-1 code
- is_primary: boolean
```

Address text fields are trimmed and limited to 200 characters; postal code is limited to 32 characters. Exactly zero or one address may be primary. PR 7 defaults `country_code` to `US` in the UI but does not hardcode US-only storage. Address public IDs are server-generated and stable across edits.

Future appointments must snapshot any customer-location address they use; editing the customer master record must not retroactively change historical appointments.

### 3.5 External reference subdocument

```text
ExternalReference
- system: normalized lowercase slug, 1–64 characters
- external_id: trimmed string, 1–255 characters
- recorded_at: UTC Date
```

The pair must be unique within one customer document. PR 7 only stores seed references generated by the seed script; no PR 7 endpoint accepts these values. Trusted Boater, Dockwa, vQuip, CRM, and partner API identifiers must be introduced by their approved integration PRs with system-specific ownership and uniqueness rules.

## 4. Duplicate detection

Duplicate detection is tenant-local, deterministic, advisory, and never merges records.

### 4.1 Match signals

The server normalizes the proposed values exactly as it normalizes stored values and reports these reason codes:

| Reason                      | Confidence | Rule                                                                    |
| --------------------------- | ---------- | ----------------------------------------------------------------------- |
| `email_exact`               | high       | Same non-null `email_normalized`.                                       |
| `mobile_phone_exact`        | high       | Same non-null `mobile_phone_e164`.                                      |
| `full_name_exact`           | medium     | Same non-empty `full_name_normalized`.                                  |
| `full_name_and_postal_code` | high       | Exact normalized full name and matching normalized primary postal code. |

Name-only results are warnings because unrelated people may share a name. Email and phone are deliberately not unique indexes because households, guardians, assistants, and shared business contacts may legitimately share them.

PR 7 does not use phonetic, fuzzy, edit-distance, probabilistic, AI, or cross-tenant matching. Future configurable matching requires a reviewed roadmap PR and must preserve deterministic reason codes.

### 4.2 Workflow

```http
POST /api/v1/admin/customers/duplicate-check
```

The request accepts the proposed first name, last name, email, mobile phone, and primary postal code. It returns at most five candidates ordered by confidence, last name, first name, and public ID. Each candidate includes only normal authorized directory fields and match reason codes.

Create and update operations rerun duplicate detection server-side. When a proposed create has matches and `acknowledge_possible_duplicate` is absent or false, the API returns `409 possible_duplicate` with the same candidate shape. The UI offers **Review existing customer** and **Create separate customer**. Resubmission with `acknowledge_possible_duplicate=true` reruns the check and creates the separate record; it does not suppress future warnings globally.

Updates exclude the customer being edited. An acknowledged create records the reason codes in the `customer_created` audit metadata. Duplicate-check requests are read-only operational logs and do not create audit events.

## 5. Search architecture

The directory supports deterministic prefix search over normalized:

- first name;
- last name;
- full name;
- email;
- phone digits.

`q` is trimmed and normalized. Text queries require 2–100 characters; phone queries require at least 3 digits. PR 7 does not promise arbitrary substring, fuzzy, or relevance-ranked search.

Results sort by:

```text
last_name_normalized ASC (null after names)
first_name_normalized ASC
public_id ASC
```

Pagination uses an opaque Base64URL cursor containing the last sort tuple, selected status filter, and normalized query fingerprint. It cannot supply tenant context. Default limit is 25; maximum is 100. Invalid or mismatched cursors return `400 invalid_cursor`.

Performance target with 10,000 customers in one tenant:

- directory and indexed prefix search: p95 under 250 ms at the API handler, excluding client network latency;
- detail lookup: p95 under 100 ms;
- no unbounded collection scan, regex without an anchored normalized prefix, or offset pagination.

## 6. Indexes and validator

```javascript
{
  key: { tenant_id: 1, public_id: 1 },
  unique: true,
  name: "customers_tenant_public_id_unique"
}

{
  key: { tenant_id: 1, status: 1, last_name_normalized: 1, first_name_normalized: 1, public_id: 1 },
  name: "customers_directory"
}

{ key: { tenant_id: 1, email_normalized: 1, public_id: 1 }, name: "customers_email_lookup" }

{ key: { tenant_id: 1, mobile_phone_e164: 1, public_id: 1 }, name: "customers_phone_lookup" }

{ key: { tenant_id: 1, first_name_normalized: 1, public_id: 1 }, name: "customers_first_name_search" }

{ key: { tenant_id: 1, full_name_normalized: 1, public_id: 1 }, name: "customers_full_name_search" }

{ key: { tenant_id: 1, updated_at: -1, public_id: 1 }, name: "customers_updated" }
```

`customers_directory` supplies the last-name search path. Email and phone indexes are intentionally non-unique. No Atlas Search dependency is introduced.

The MongoDB validator enforces required fields, nullability, enums, UUID strings, ObjectIds, dates, integers, embedded address shape, communication-preference shape, and array limits. API validation remains the source of user-facing error messages.

## 7. API and permissions

All endpoints use `/api/v1/admin`, the existing envelopes, verified selected membership, role revalidation, safe errors, OpenAPI schemas/examples, and same-origin CSRF for POST/PATCH lifecycle requests.

| Endpoint                                | Owner/Admin | Front desk | Provider |
| --------------------------------------- | ----------: | ---------: | -------: |
| `GET /customers`                        |        View |       View |       No |
| `GET /customers/{publicId}`             |        View |       View |       No |
| `POST /customers/duplicate-check`       |      Manage |     Manage |       No |
| `POST /customers`                       |      Manage |     Manage |       No |
| `PATCH /customers/{publicId}`           |      Manage |     Manage |       No |
| `POST /customers/{publicId}/activate`   |      Manage |     Manage |       No |
| `POST /customers/{publicId}/deactivate` |      Manage |     Manage |       No |

Provider access is deferred until a future appointment relationship and provider self-scope exist. This avoids exposing the entire tenant customer directory to a provider account.

### 7.1 Directory

```http
GET /api/v1/admin/customers?status=active|inactive|all&q=<prefix>&limit=25&cursor=<opaque>
```

Default status is `active`. Response:

```json
{
  "data": {
    "items": [
      {
        "public_id": "customer-uuid",
        "display_name": "Maya Johnson",
        "first_name": "Maya",
        "last_name": "Johnson",
        "preferred_name": null,
        "email": "maya@example.test",
        "mobile_phone": "+14045550101",
        "status": "active",
        "version": 1,
        "updated_at": "2026-07-30T12:00:00.000Z"
      }
    ],
    "next_cursor": null
  },
  "meta": { "request_id": "request-uuid" }
}
```

### 7.2 Detail

```http
GET /api/v1/admin/customers/{customerPublicId}
```

Returns all PR 7 customer fields except internal IDs and normalized search fields. `external_references` may be returned read-only to owner/admin only; front desk receives an empty or omitted integration section.

### 7.3 Create

```http
POST /api/v1/admin/customers
```

```json
{
  "first_name": "Maya",
  "last_name": "Johnson",
  "preferred_name": null,
  "email": "maya@example.test",
  "mobile_phone": "(404) 555-0101",
  "addresses": [],
  "communication_preferences": {
    "preferred_channel": "email",
    "marketing_email": "unknown",
    "marketing_sms": "unknown"
  },
  "acknowledge_possible_duplicate": false
}
```

The backend supplies tenant, source `manual`, status, version, actors, timestamps, normalized fields, and address public IDs. A successful create returns `201`.

### 7.4 Update

```http
PATCH /api/v1/admin/customers/{customerPublicId}
```

The request accepts the editable create fields plus required `expected_version`. It does not accept tenant, public ID, status, source, external references, audit fields, or normalized fields. A stale version returns the established `409 version_conflict`. No-op updates return `200`, `changed=false`, do not increment version, and do not create an audit event.

### 7.5 Lifecycle

```http
POST /api/v1/admin/customers/{customerPublicId}/deactivate
POST /api/v1/admin/customers/{customerPublicId}/activate
```

Payload:

```json
{ "expected_version": 3 }
```

An actual transition increments version once and writes one audit event. A retry when already in the requested state returns `200`, `changed=false`, with no version increment and no duplicate audit event, following PR 3–5 behavior. No DELETE endpoint exists.

### 7.6 Stable errors

- `400 invalid_customer` for field validation;
- `400 invalid_query` for invalid search parameters;
- `400 invalid_cursor` for malformed or mismatched pagination state;
- `401 authentication_required`;
- `403 tenant_selection_required` or existing role-forbidden response;
- `404 customer_not_found` for missing, inaccessible, or cross-tenant IDs;
- `409 possible_duplicate` before an unacknowledged duplicate create;
- `409 version_conflict` for stale actual mutations.

OpenAPI documents successful, validation, duplicate-warning, conflict, permission, and safe-404 examples. It remains available only under the approved nonproduction administrative API configuration.

## 8. Business Hub UI

Routes:

```text
/customers
/customers/new
/customers/{customerPublicId}
/customers/{customerPublicId}/edit
```

### Customer Directory

- Add **Customers** to the authenticated Business Hub navigation.
- Search by name, email, or phone with a labeled field and explicit submit/clear behavior.
- Filter Active, Inactive, or All; default Active.
- Display name, email, formatted US phone when applicable, status, and last update.
- Cursor-based **Load more customers** control with loading, empty, and error states.

### Create/Edit

- Accessible labels, field help, validation summary, and focus on the first invalid field.
- US phone placeholder `(555) 555-0123`; canonical storage remains E.164.
- Address editor supports up to five addresses and one primary address.
- Duplicate warning presents candidates without preselecting a merge or silently discarding input.
- **Create separate customer** requires an explicit user action.
- Opening Edit scrolls to and focuses the edit heading, following the PR 6 QA correction.

### Customer Detail

- Identity, contact, addresses, preferences, status, source, created/updated dates, and lifecycle controls.
- Placeholder tabs labelled **Appointments**, **Payments**, **Documents**, **Notes**, and **Activity** are visibly disabled with “Coming in a future release.” They create no routes, API calls, empty collections, or implied functionality.

All controls meet existing keyboard, focus, contrast, status-message, and screen-reader requirements. Provider-role navigation omits Customers and direct navigation returns the role-forbidden response without rendering cached PII.

## 9. Audit and operational logging

Audit events:

```text
customer_created
customer_updated
customer_deactivated
customer_reactivated
```

Each contains actor, selected tenant, customer public ID, request ID, outcome, prior/new version when applicable, and changed field names. It must never contain full email, phone, address lines, or duplicate candidate PII. An acknowledged duplicate creation additionally records match reason codes and `duplicate_acknowledged=true`.

Successful reads, searches, and duplicate checks do not create audit events. Existing structured operational logging records route, outcome, duration, request ID, result count, and stable error code without query text or customer PII.

## 10. Migration

PR 7 adds only the `customers` collection, validator, and indexes in Section 6. Migration is idempotent and safe on an empty or existing staging database.

```shell
pnpm --filter @booknowtech/api db:migrate
```

Migration verification must prove:

- rerunning succeeds without duplicate indexes or data changes;
- invalid documents are rejected by the validator;
- public IDs are unique within a tenant;
- duplicate email and phone values are permitted within and across tenants;
- indexes have the exact approved names and definitions;
- no appointment, payment, document, note, messaging, portal, or global-identity collection is created.

Rollback is application-first: redeploy the pre-PR 7 commit, which ignores `customers`. The collection is retained for recoverability. Index or collection removal is not part of routine rollback and requires a separately reviewed data operation.

## 11. Development seed

```shell
pnpm --filter @booknowtech/api db:seed:development
```

The idempotent seed upserts by tenant and stable seed external reference without overwriting user-edited records unless the existing seed convention explicitly reconciles that field.

Brazilian Wax Demo:

| Customer     | Contact                                     | Preferences                        | Status   |
| ------------ | ------------------------------------------- | ---------------------------------- | -------- |
| Maya Johnson | `maya.johnson@example.test`, `+14045550101` | email preferred, marketing unknown | active   |
| Elena Ruiz   | `elena.ruiz@example.test`, `+14045550102`   | SMS preferred, marketing unknown   | active   |
| Jordan Lee   | phone only, `+14045550103`                  | phone preferred                    | inactive |

Braiding Demo:

| Customer       | Contact                                       | Preferences                        | Status |
| -------------- | --------------------------------------------- | ---------------------------------- | ------ |
| Aaliyah Brooks | `aaliyah.brooks@example.test`, `+16785550101` | SMS preferred, marketing unknown   | active |
| Nia Carter     | `nia.carter@example.test`, `+16785550102`     | email preferred, marketing unknown | active |
| Sam Williams   | name only                                     | no preferred channel               | active |

All names and `.test` contacts are explicitly fictional. Seed records use source `seed`; no seed email or phone is shared across tenants, so the initial directory is clean for duplicate QA.

## 12. Automated tests

### Unit and API contract tests

- normalization of Unicode names, whitespace, email, US phone input, E.164 input, and phone digits;
- required names, nullable contact fields, maximum lengths, address limits, one-primary-address rule, enums, and rejected server-controlled fields;
- deterministic duplicate reason codes, ordering, five-result cap, self-exclusion on update, acknowledgement, and no automatic merge;
- exact email/phone duplicates remain storable after acknowledgement;
- directory status filters, every supported search field, stable ordering, pagination, malformed cursor, and cursor/query mismatch;
- permission matrix for all four fixed roles;
- safe `404` for cross-tenant detail, update, activate, and deactivate attempts;
- database queries include selected tenant at lookup and mutation layers;
- optimistic concurrency, no-op update behavior, lifecycle transitions, and idempotent retries;
- audit event count and metadata redaction;
- OpenAPI request/response/error schemas.

### Mongo-backed tests

- migration idempotency, validator rejection, and exact index definitions;
- same email, phone, and name can exist in different tenants;
- tenant A search and duplicate checks never return Tenant B;
- non-unique email/phone behavior within one tenant;
- query plans use approved indexes for representative 10,000-record fixtures;
- measured directory, prefix-search, and detail performance targets.

### Frontend tests

- directory loading, searching, filtering, empty state, errors, and pagination;
- owner/admin/front-desk controls and provider-role denial;
- create/edit validation and focus behavior;
- duplicate-warning review and explicit separate-customer action;
- lifecycle actions and idempotent responses;
- detail rendering, disabled future tabs, keyboard navigation, status announcements, and mobile-width usability;
- tenant switch clears prior customer data and reloads only the selected tenant.

## 13. Acceptance checklist

1. Owner, admin, and front desk can list, search, view, create, update, deactivate, and reactivate selected-tenant customers.
2. Provider role cannot access the customer directory or customer API.
3. A name-only customer can be created; invalid email, phone, address, and controlled fields are rejected.
4. Duplicate email, phone, name, and name-plus-postal scenarios produce deterministic warnings without merging.
5. A user can explicitly create a legitimate separate customer after reviewing the warning.
6. Search works by first name, last name, full-name prefix, email prefix, and phone digits with stable cursor pagination.
7. Tenant A cannot read, search, infer, mutate, or duplicate-match Tenant B customers; cross-tenant public IDs return safe `404`.
8. Stale updates return version conflict; actual changes increment once; no-op and repeated lifecycle requests do not increment or duplicate audit events.
9. Customer records are never physically deleted and inactive records remain searchable through the explicit filter.
10. Customer detail displays only PR 7 data; future tabs are disabled and make no API calls.
11. Audits exist for actual mutations and contain no raw customer contact or address PII.
12. Migration and seed are idempotent and Mongo-backed tests pass.
13. Search performance meets documented targets with the representative dataset.
14. Switching tenants clears previous results and loads only the new selected tenant.
15. No excluded collection, route, authentication workflow, Railway variable, service, or architectural abstraction is introduced.

## 14. Rollout and rollback

Rollout:

1. merge only after canonical CI, secret scan, Mongo-backed tests, OpenAPI validation, and accessibility tests pass;
2. deploy the API before or with the frontend;
3. run the idempotent migration once in staging;
4. run the development seed;
5. verify indexes and validators in Atlas;
6. smoke-test both tenants and all permitted roles;
7. verify cross-tenant isolation and audit redaction;
8. observe error rate, duplicate-warning rate, and search latency without logging PII.

Rollback:

1. redeploy the prior frontend and API commit;
2. verify PR 2–6 workflows remain healthy;
3. retain `customers` and its data for forward recovery;
4. do not drop customer data or indexes as an application rollback step.

No Railway variable or feature flag is required.

## 15. Explicit exclusions

PR 7 does not implement:

- appointments, bookings, scheduling conflicts, or holds;
- payments, Stripe customers, invoices, deposits, fees, payouts, or settlement;
- customer login, portal authentication, invitations, or password recovery;
- waivers, forms, intake, documents, uploads, or signatures;
- notes, activity feeds, custom fields, or generic metadata;
- email, SMS, push, reminders, notifications, or consent-delivery infrastructure;
- loyalty, memberships, packages, gift cards, or subscriptions;
- automatic merges, fuzzy matching, global people, cross-tenant profiles, or shared consent;
- Trusted Boater, Dockwa, vQuip, CRM, partner API, or public-booking integrations;
- data import/export UI, bulk operations, retention/erasure automation, or reporting.

## 16. Future-readiness boundary

The fields with present architectural value are stable tenant customer public IDs, source attribution, structured external references, address public IDs, canonical contact values, communication preferences, and lifecycle/version fields. Future appointments and integrations can reference `customers._id` internally and retain the customer `public_id` at API boundaries.

No global identity ID, Stripe ID, portal user ID, appointment history array, payment summary, document array, note array, or free-form configuration object is reserved. Those would encode unapproved ownership and lifecycle assumptions. Future systems should add their own collections and reference the tenant-owned customer record after their contracts or ADRs are approved.

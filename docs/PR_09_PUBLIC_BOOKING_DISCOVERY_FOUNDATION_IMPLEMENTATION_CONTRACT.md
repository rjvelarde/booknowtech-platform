# PR 9 — Public Booking Discovery Foundation Implementation Contract

**Status:** Accepted
**Scope:** Read-only public business, service, provider, and available-start discovery

## 1. Objective

PR 9 introduces the first public booking experience without accepting a booking. A customer visiting a tenant's BookNowTech booking hostname can resolve the business, view explicitly approved public branding, browse publicly bookable services, select an eligible provider, choose a date, and view current available appointment starts.

PR 9 reuses the tenant, catalog, provider assignment, availability, deterministic scheduling, timezone, appointment-conflict, and migration foundations delivered by PRs 3–8. It must not create a second scheduling engine or persist any public customer or booking state.

The smallest safe result is:

1. exact hostname-to-tenant resolution for `tenant-slug.booknowtech.com`;
2. explicit public tenant, service, provider, and booking-policy fields;
3. read-only public APIs that return only approved fields and safe identifiers;
4. the public flow `business -> service -> provider -> date -> available time`;
5. deterministic starts calculated from the existing scheduling engine after subtracting scheduled appointments;
6. a final informational state that clearly says booking submission is not yet available.

## 2. Architectural invariants

- The administrative application remains centralized at `admin.booknowtech.com`; PR 9 does not change administrative authentication, sessions, tenant switching, or authorization.
- Public tenant context comes only from a normalized, server-validated public hostname. A tenant ID, tenant slug, or hostname supplied through query parameters, request bodies, browser storage, or arbitrary headers is never authorization context.
- Public and administrative sessions remain separate. Public discovery requires no cookie or customer session and must not read or mutate `admin_sessions`.
- Public APIs are read-only and expose no anonymous mutation.
- Every public database query includes the tenant resolved from the request hostname and the required active/public eligibility predicates.
- Inactive, suspended, private, ineligible, unknown, and cross-tenant resources return the same safe `404` envelope.
- Public scheduling calls the existing PR 6/8 scheduling implementation. No duplicated slot algorithm, slot collection, materialized availability, hold, or cache is introduced.
- Scheduled appointments affect availability but no appointment, customer, closure, break, time-off, internal buffer, or blocked-reason record is returned publicly.
- MongoDB ObjectIds, internal codes, legal names, private contact fields, audit fields, membership data, and operational metadata never reach public responses.
- Existing response envelopes, request IDs, structured logging, OpenAPI, validation, migrations, and rollback conventions remain in force.
- No new Railway variable, service, worker responsibility, queue, distributed cache, or feature flag is introduced.
- PR 9 creates no customer, appointment, hold, booking attempt, analytics identity, or other persistent public state.

## 3. Approved design recommendations

| Decision                 | Recommendation                                                                                                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hostname normalization   | Normalize one trusted request hostname: lowercase, remove a single trailing dot and an allowed development port, reject malformed names, and match the exact BookNowTech suffix.               |
| Resolution precedence    | Exact verified custom hostname would eventually precede fallback subdomain, but PR 9 implements fallback subdomains only because custom-domain provisioning and verification do not yet exist. |
| Supported hosts          | `{tenant-slug}.booknowtech.com` plus explicit local/test host fixtures. Root, `www`, `admin`, malformed, and unrecognized hosts do not resolve.                                                |
| Public service control   | Add `publicly_bookable: boolean`, defaulting to `false`. Active status alone never publishes a service.                                                                                        |
| Any available provider   | Defer. PR 9 requires selection of one eligible provider, avoiding cross-provider de-duplication and booking semantics before PR 10.                                                            |
| Policy precedence        | Service override, then tenant default, then immutable platform-safe default. Request-level overrides are prohibited.                                                                           |
| Platform-safe defaults   | Minimum lead time `120` minutes and maximum advance window `90` tenant-local calendar days.                                                                                                    |
| Maximum advance boundary | Inclusive tenant-local date boundary, not a rolling UTC duration. A start is eligible when its tenant-local date is no later than `today + maximum_advance_days`.                              |
| Lead-time boundary       | Exact timestamp. A start must be at or after `now + minimum_booking_lead_minutes`.                                                                                                             |
| Public availability      | Reuse generated slots and PR 8 scheduled-appointment conflict subtraction, then project a safe public response.                                                                                |
| Final UI step            | Display the selected service/provider/date/time and a clear "Online booking is coming soon" message; do not show an enabled Continue/Book button.                                              |
| Pre-PR 10 exposure       | Deploy the route, but publish only explicitly enabled staging tenants. Existing and future tenants default to hidden until deliberately published.                                             |
| Public reads and audit   | Do not create audit events for ordinary anonymous reads. Emit bounded structured operational logs and metrics without customer PII.                                                            |

## 4. Data-model changes

All changes are additive to the existing `tenants` and `services` collections. No hostname, public-profile, policy, slot, or visitor collection is added.

### 4.1 Tenant public discovery fields

Add to each `tenants` document:

```text
public_booking_enabled: boolean                 # default false
public_profile:
  business_name: string                        # approved public name
  description: null | string                   # max 1,000 characters
  tagline: null | string                       # max 160 characters
  logo_url: null | HTTPS URL                   # max 2,048 characters
  primary_color: null | "#RRGGBB"
  website_url: null | HTTPS URL
  phone_e164: null | E.164 string
  email_normalized: null | email string

booking_policy:
  minimum_lead_minutes: integer                # 0..43,200
  maximum_advance_days: integer                # 1..365
```

Rationale:

- `public_booking_enabled` is a permanent tenant publication control, not an environment feature flag. It allows a tenant to withdraw public discovery without affecting Business Hub operations.
- `public_profile` prevents accidental exposure of administrative/legal contact fields. Every public field is deliberately managed and safe-listed.
- `business_name` is stored because the approved public brand may differ from the administrative display or legal name.
- `description`, `tagline`, `logo_url`, and `primary_color` provide minimal white-label presentation without implementing a general theme system.
- Public phone, email, and website are separate from administrative contact data so publishing is explicit.
- `booking_policy` stores tenant defaults used by all public discovery calls.

The existing `slug`, `default_timezone`, `locale`, and `currency` remain authoritative. PR 9 does not add multi-location or per-location timezone/currency.

### 4.2 Service public discovery fields

Add to each `services` document:

```text
publicly_bookable: boolean                     # default false
public_display_order: integer                  # default 0; range 0..100,000
public_booking_policy:
  minimum_lead_minutes: null | integer         # 0..43,200
  maximum_advance_days: null | integer         # 1..365
```

Rationale:

- `publicly_bookable` separates public publication from internal catalog status.
- `public_display_order` produces stable business-controlled ordering without using internal codes.
- Nullable overrides preserve tenant defaults unless a service has a real policy difference.
- Overrides affect public discovery only. Internal Business Hub appointment creation remains governed by PR 8.

Catalog price fields remain catalog display values only. PR 9 performs no tax, deposit, processor fee, platform fee, payout, commission, discount, invoice, refund, or settlement calculation.

### 4.3 Provider fields

No new provider field is required. Public eligibility uses the existing:

```text
status = active
customer_selectable = true
accepting_new_clients = true
```

The existing `display_order`, `display_name`, `bio`, and nullable `photo_url` support safe public display. `linked_user_id`, email, phone, internal code, audit fields, and version are never public.

## 5. Hostname resolution

### 5.1 Canonical host

The PR 9 canonical fallback host is:

```text
{tenant.slug}.booknowtech.com
```

Existing seed slugs may remain for data stability, but PR 9 seed updates should change them to customer-facing values only through an explicit idempotent migration/seed decision. Recommended staging hosts are:

```text
brazilian-wax-demo.booknowtech.com
braiding-demo.booknowtech.com
```

If preserving current slugs is preferred for migration safety, the staging hosts remain `harbor-demo.booknowtech.com` and `city-services-demo.booknowtech.com`; display names remain customer-facing. This is an approval item in section 24.

### 5.2 Normalization algorithm

For public routes, the server must:

1. obtain the effective hostname from the framework's trusted request-host handling;
2. trust forwarded-host information only from the known Railway/Caddy proxy path, never directly from an arbitrary internet client;
3. lowercase the hostname;
4. remove one terminal `.`;
5. remove a numeric port only in approved development/test handling;
6. reject user-info, schemes, paths, whitespace, control characters, empty labels, labels over 63 characters, underscores, and non-DNS input;
7. require exactly one tenant label before `.booknowtech.com`;
8. reject reserved labels including `admin`, `www`, `api`, `support`, `status`, and `book`;
9. look up the normalized slug using the existing unique slug index;
10. require `tenant.status=active` and `public_booking_enabled=true`.

Failure at any step returns the same safe `404 public_business_not_found` response.

### 5.3 Resolution precedence and custom domains

The future precedence is:

```text
exact verified custom booking hostname
-> exact BookNowTech tenant subdomain
-> safe 404
```

PR 9 implements only the second branch. It does not resolve, provision, verify, store, redirect, or issue certificates for custom domains. No `custom_domains` collection is introduced. This preserves the approved roadmap rule that custom domains are public-booking-only while keeping their provisioning in its dedicated PR.

### 5.4 Development and tests

Production code must not accept arbitrary `?tenant=` or `X-Tenant-ID` overrides. Local development may use a documented host such as:

```text
brazilian-wax-demo.booknowtech.test
```

through explicit development configuration already available to the process or local hosts-file mapping. Tests inject the Host header directly. No new Railway variable is permitted.

## 6. Public eligibility rules

### 6.1 Tenant

A tenant is publicly resolvable only when:

- hostname resolves exactly to its slug;
- `status=active`;
- `public_booking_enabled=true`.

### 6.2 Service

A service is public only when:

- it belongs to the resolved tenant;
- `status=active`;
- `publicly_bookable=true`;
- its currency equals the tenant currency under the existing invariant.

### 6.3 Provider

A provider is eligible for a public service only when all are true:

- provider belongs to the resolved tenant;
- provider `status=active`;
- provider `customer_selectable=true`;
- provider `accepting_new_clients=true`;
- service belongs to the same tenant, is active, and is publicly bookable;
- provider-service assignment belongs to the same tenant and is active.

Missing schedule, no working hours, closures, time off, breaks, booking policy, or existing appointments may yield zero starts but do not expose the reason.

### 6.4 No inference

Changing a service/provider public ID to an inactive, private, or cross-tenant value returns the identical safe `404`. List counts, timing differences, error codes, and response metadata must not reveal whether the record exists elsewhere.

## 7. Booking-policy rules

### 7.1 Precedence

For each public availability request:

```text
effective minimum lead minutes =
  service.public_booking_policy.minimum_lead_minutes
  ?? tenant.booking_policy.minimum_lead_minutes
  ?? 120

effective maximum advance days =
  service.public_booking_policy.maximum_advance_days
  ?? tenant.booking_policy.maximum_advance_days
  ?? 90
```

The platform defaults are constants in application code and migration defaults, not environment variables.

### 7.2 Lead time

- The server captures one `now` instant at request start.
- Eligible starts satisfy `starts_at >= now + effective minimum lead`.
- The server never trusts a browser clock.
- Lead-time filtering occurs after deterministic generation or as an equivalent bound passed into the same scheduling calculation.

### 7.3 Maximum advance

- Determine today's date in `tenant.default_timezone` from the captured `now`.
- The last eligible local start date is `today + effective maximum advance days`, inclusive.
- The date boundary uses the tenant timezone even when a provider schedule has an approved different timezone; returned starts still carry their schedule-local context from the existing engine.
- The API rejects requested ranges wholly outside the policy window and clips partially overlapping ranges to the eligible window without revealing internal blocks.

### 7.4 Controlled overrides

- Only `tenant_owner` and `tenant_admin` may manage tenant/service public settings through existing authenticated, CSRF-protected, optimistic-concurrency flows.
- `front_desk` and `provider` are read-only for these settings in PR 9.
- No request-level cadence, lead-time, or maximum-advance override exists.
- An override does not mutate the tenant default or another service.

## 8. Public API contract

All endpoints are under `/api/v1/public`, require no administrative session, derive tenant context only from the hostname, use existing envelopes/request IDs, and are GET-only.

| Method | Endpoint                                                                                    | Purpose                                                          |
| ------ | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `GET`  | `/api/v1/public/booking-context`                                                            | Resolve host and return approved tenant branding/policy context. |
| `GET`  | `/api/v1/public/services`                                                                   | Return active publicly bookable services.                        |
| `GET`  | `/api/v1/public/services/:service_public_id/providers`                                      | Return eligible public providers assigned to the service.        |
| `GET`  | `/api/v1/public/services/:service_public_id/providers/:provider_public_id/available-starts` | Return current safe appointment starts.                          |

Public IDs are existing UUID `public_id` values. They are identifiers, not authorization. Every lookup remains hostname/tenant scoped.

### 8.1 Booking context

```http
GET /api/v1/public/booking-context
Host: brazilian-wax-demo.booknowtech.com
```

```json
{
  "data": {
    "business": {
      "public_id": "tenant-uuid",
      "slug": "brazilian-wax-demo",
      "business_name": "Brazilian Wax Demo",
      "description": "Appointment-based waxing services.",
      "tagline": null,
      "logo_url": null,
      "primary_color": "#1261A0",
      "website_url": null,
      "phone": null,
      "email": null,
      "timezone": "America/New_York",
      "locale": "en-US",
      "currency": "USD"
    }
  },
  "meta": { "request_id": "..." }
}
```

Do not return legal name, internal administrative contact, version, status, ObjectId, booking-policy values, or publication flags.

### 8.2 Services

```json
{
  "data": {
    "items": [
      {
        "public_id": "service-uuid",
        "name": "Brazilian Wax",
        "description": null,
        "delivery_mode": "provider_location",
        "duration_minutes": 30,
        "base_price_minor": 5500,
        "booking_fee_minor": 125,
        "currency": "USD"
      }
    ]
  },
  "meta": { "request_id": "..." }
}
```

Sort by `public_display_order`, then normalized/name order, then `public_id`. PR 9 does not need pagination because each response is hard-limited to 100 published services; exceeding that limit is a configuration error recorded internally and the response remains bounded.

### 8.3 Providers

```json
{
  "data": {
    "items": [
      {
        "public_id": "provider-uuid",
        "display_name": "Lisa",
        "bio": null,
        "photo_url": null
      }
    ]
  },
  "meta": { "request_id": "..." }
}
```

Sort by `display_order`, then display name, then public ID. Limit to 100 eligible providers. Do not return email, phone, internal code, `linked_user_id`, eligibility booleans, assignment ID, buffers, or version.

### 8.4 Available starts

Query:

```text
start_date: required YYYY-MM-DD in tenant timezone
end_date: required YYYY-MM-DD in tenant timezone
limit: optional 1..100, default 50
cursor: optional opaque cursor from the same hostname/service/provider/range/policy state
```

Rules:

- maximum requested span: 14 calendar days;
- range must intersect today through the effective maximum-advance date;
- no request-level timezone, cadence, policy, tenant, or blocked-interval input;
- old/tampered/cross-query cursors return the existing safe invalid-cursor response;
- query and computation budgets inherit PR 6, with the stricter public response cap;
- scheduled appointments are subtracted through the existing PR 8 integration;
- the response never explains why a start is absent.

```json
{
  "data": {
    "items": [
      {
        "start": "2026-08-03T13:00:00.000Z",
        "end": "2026-08-03T13:30:00.000Z",
        "local_start": "2026-08-03T09:00:00-04:00",
        "timezone": "America/New_York"
      }
    ]
  },
  "meta": {
    "next_cursor": null,
    "request_id": "..."
  }
}
```

Do not return blocked start/end, buffers, closures, breaks, time off, appointment references, customer data, lock revisions, policy internals, ineligibility codes, or capacity reasons.

## 9. Reuse of scheduling and appointment conflicts

The public route must call the same deterministic scheduling function used by the administrative preview, with a public eligibility adapter that supplies:

- resolved tenant and timezone;
- eligible service and effective cadence;
- eligible provider and active assignment buffers;
- provider schedule and breaks;
- active tenant closures and provider time off;
- persisted `scheduled` appointment blocked intervals;
- the effective lead-time and maximum-advance bounds.

The route projects only safe starts after calculation. It must not fork or copy cadence alignment, DST conversion, interval subtraction, cursor fingerprinting, or appointment-conflict logic.

The final time remains advisory. PR 10 must revalidate it transactionally when creating an appointment; PR 9 makes no promise that a displayed time is reserved.

## 10. Safe errors

Use the existing error envelope and request ID.

| Condition                                      | Status | Public code                           |
| ---------------------------------------------- | -----: | ------------------------------------- |
| Unknown/malformed/reserved hostname            |  `404` | `public_business_not_found`           |
| Suspended or unpublished tenant                |  `404` | `public_business_not_found`           |
| Inactive/private/cross-tenant service          |  `404` | `public_resource_not_found`           |
| Ineligible/cross-tenant provider or assignment |  `404` | `public_resource_not_found`           |
| Invalid date/range/limit/cursor                |  `400` | `invalid_public_availability_request` |
| Valid request with no starts                   |  `200` | Empty `items`                         |
| Rate limit exceeded                            |  `429` | `public_rate_limit_exceeded`          |
| Unexpected failure                             |  `500` | `public_request_failed`               |

Messages remain generic. Logs retain request ID and safe public IDs but no client-provided free text or customer PII.

## 11. Public UI routes and workflow

The same frontend artifact supports hostname-based routing. Administrative hosts continue to render Business Hub; valid public booking hosts render the public application.

Recommended routes:

```text
/                              business landing and service list
/services/:service_public_id   service summary and provider selection
/services/:service_public_id/providers/:provider_public_id
                               date and available-time selection
/selection                     non-persistent final summary/coming-soon state
```

Workflow:

1. Resolve booking context from the current hostname.
2. Render approved brand/business information and services.
3. Select one service.
4. Select one eligible provider. Do not offer "Any available provider".
5. Select a date within the effective public policy window.
6. Load and display available starts grouped in the business/provider local context.
7. Select a time and display a summary plus an explicit message that online booking is not yet available.

The selected service/provider/date/time may live only in component/router memory or URL path/query state needed to render the read-only flow. Do not use localStorage, create a server record, set a customer cookie, or imply reservation.

If the page is refreshed at the final step, it may reconstruct and revalidate discovery from safe public IDs or return to the previous selection step. No durable draft is expected.

## 12. Accessibility and mobile behavior

- Meet WCAG 2.2 AA patterns already used by Business Hub.
- Use semantic headings, landmarks, lists, buttons, fieldsets, legends, labels, and status regions.
- Every card selection is keyboard operable with a visible focus indicator.
- Do not rely on brand color alone for selection, errors, status, or availability.
- Constrain tenant primary color to combinations that preserve approved contrast; otherwise use the platform-safe default color.
- Announce loading, empty, changed-date, selected-time, and error states without stealing focus unexpectedly.
- Preserve logical focus when navigating steps and place focus on the new page heading.
- Use native date controls where supported with text guidance and server validation.
- On narrow screens, cards and time buttons use a single-column/touch-friendly layout with at least 44-by-44 CSS-pixel targets.
- Display timezone context near dates/times and include offset-qualified values around DST transitions.
- Images require business/provider-name alt text or empty alt text when decorative; broken/absent photos fall back to initials.

## 13. Security and abuse protection

### 13.1 Host and proxy security

- Accept only exact canonical fallback suffixes.
- Do not trust arbitrary `X-Forwarded-Host`; honor forwarded host only through the application's existing trusted Railway/Caddy proxy configuration.
- Reject ambiguous/multiple Host values and conflicting forwarded-host chains.
- Use the same host normalization in route handling and cache/rate-limit keys.

### 13.2 Input and output bounds

- UUID/public-ID maximum lengths remain bounded before database queries.
- Date span is at most 14 days.
- Service/provider lists cap at 100.
- Available-start page size caps at 100.
- Cursor length caps at 2,048 bytes and is signed/fingerprinted under the existing cursor convention.
- Responses never contain unbounded descriptions, internal arrays, or free-form operational explanations.

### 13.3 Rate limits

Add a focused public-route limiter using the existing Fastify process only:

- discovery/context/catalog: 120 requests per minute per normalized client address and hostname;
- available-start generation: 30 requests per minute per normalized client address and hostname;
- small burst allowance within those limits;
- standard `Retry-After` response;
- administrative routes remain unaffected.

The limiter may use bounded in-process counters because PR 9 has one replica and explicitly excludes a distributed cache. Document that it is per replica and is not a substitute for future edge protection. The implementation must use trusted proxy configuration so a client cannot choose its own rate-limit key. If adopting the rate-limit plugin conflicts with the existing proxy model, stop for an ADR.

### 13.4 Browser protections

- No public response sets an administrative cookie.
- Preserve same-origin APIs; browser code uses `/api` only.
- Set restrictive CSP, frame-ancestors, referrer, MIME-sniffing, and permissions headers through the existing frontend server configuration.
- Allow only HTTPS image URLs. Do not proxy or fetch arbitrary image URLs server-side.
- Public endpoints return appropriate cache controls defined below and never expose secrets in the frontend bundle.

## 14. Caching policy

No application or distributed cache is added.

- `booking-context`, services, and providers: `Cache-Control: public, max-age=60, stale-while-revalidate=60` with an ETag derived from public-safe version/update state.
- available starts: `Cache-Control: no-store` because appointments and availability may change immediately.
- safe `404` responses: `Cache-Control: no-store` to avoid retaining tenant-publication transitions.
- frontend hashed assets retain existing immutable asset behavior; SPA HTML remains revalidated.

ETag handling must not expose internal version numbers or distinguish private/cross-tenant records.

## 15. Administrative configuration changes

Extend existing Business Hub profile and service forms rather than creating a new administration architecture.

### Tenant owner/admin

- manage public publication state;
- edit the approved public profile;
- edit tenant default lead time and maximum advance days;
- preview the computed fallback booking hostname;
- see a warning that public discovery does not accept bookings until PR 10.

### Service owner/admin

- toggle `publicly_bookable`;
- set public display order;
- optionally set/clear lead-time and maximum-advance overrides;
- see the effective inherited values.

Mutations use existing administrative sessions, verified tenant context, CSRF, expected version, safe `404`, audit, and role rules. Front desk and providers cannot change public configuration in PR 9.

Audit events:

```text
public_booking_profile_updated
public_booking_publication_changed
service_public_booking_updated
```

Idempotent retries return `200`, `changed=false`, do not increment version, and do not duplicate audit events.

## 16. Validation

### Tenant

- `business_name`: trimmed, 1..120 characters.
- `description`: nullable, trimmed, maximum 1,000.
- `tagline`: nullable, trimmed, maximum 160.
- URLs: nullable, absolute HTTPS, maximum 2,048; no credentials.
- `primary_color`: nullable uppercase/lowercase hex normalized to `#RRGGBB`.
- phone: nullable E.164.
- email: nullable, normalized under existing email rules.
- minimum lead: integer 0..43,200.
- maximum advance: integer 1..365.
- publication cannot be enabled unless business name, timezone, locale, currency, and valid slug are present.

### Service

- public display order: integer 0..100,000.
- overrides: null or bounded integers matching tenant fields.
- a service may be marked publicly bookable only when active and currency-consistent.
- deactivating a service automatically makes it ineligible publicly without rewriting `publicly_bookable`; reactivation restores eligibility only if all other predicates pass.

## 17. Migrations and indexes

The migration remains idempotent and runs through the existing API pre-deploy command.

### Backfill

For existing tenants:

```text
public_booking_enabled = false
public_profile.business_name = display_name
other public_profile fields = null
booking_policy.minimum_lead_minutes = 120
booking_policy.maximum_advance_days = 90
```

For existing services:

```text
publicly_bookable = false
public_display_order = 0
public_booking_policy.minimum_lead_minutes = null
public_booking_policy.maximum_advance_days = null
```

### Validators

Update strict validators for `tenants` and `services` with the exact shapes and bounds above. Migration must backfill before applying `collMod`.

### Indexes

Retain the existing unique `tenants_slug_unique` index for exact hostname lookup. Add:

```text
services_public_catalog:
  { tenant_id: 1, publicly_bookable: 1, status: 1,
    public_display_order: 1, name: 1, public_id: 1 }

providers_public_directory:
  { tenant_id: 1, status: 1, customer_selectable: 1,
    accepting_new_clients: 1, display_order: 1,
    display_name: 1, public_id: 1 }
```

Existing assignment, schedule, exception, appointment-conflict, and lock indexes remain authoritative. Do not create a public slot index or collection.

Migration verification must prove:

- repeatability;
- exact backfills;
- validator rejection of malformed fields;
- publication defaults remain false;
- new indexes exist by name;
- prior tenant/service documents remain readable;
- existing PR 2–8 indexes and validators remain intact.

## 18. Seed plan

The development seed remains prohibited outside development, test, and staging and remains idempotent.

### Brazilian Wax Demo

- public booking enabled;
- customer-facing slug decision from section 5.1;
- public business name `Brazilian Wax Demo`;
- timezone `America/New_York`, currency `USD`, locale `en-US`;
- 120-minute lead time, 90-day advance window;
- active wax services publicly bookable;
- inactive `Chest + Stomach` remains unavailable even if the seed retains a false publication field;
- Lisa and Sandra remain active, customer selectable, accepting new clients, and only appear for active assignments;
- existing hours, buffers, closures, time off, and scheduled appointments exercise availability subtraction.

### Braiding Demo

- public booking enabled for staging QA;
- public business name `Braiding Demo`;
- 240-minute lead time and 120-day advance window to exercise different defaults;
- active Medium Knotless Braids publicly bookable;
- inactive Virtual Consultation remains unavailable;
- seed at least one eligible provider, active assignment, schedule, and future starts if not already present.

The seed must not create a public visitor, booking attempt, hold, anonymous customer, payment, or notification.

## 19. Automated tests

### Unit tests

- hostname lowercasing, terminal dot, allowed development port, reserved labels, suffix confusion, malformed labels, conflicting host inputs, and exact slug extraction;
- policy precedence and bounded validation;
- exact lead-time threshold;
- inclusive tenant-local maximum-advance date across UTC boundaries;
- DST behavior inherited from PR 5/6;
- public eligibility predicates for every tenant/service/provider/assignment flag;
- safe projection excludes every private field;
- empty versus safe `404` behavior;
- stable ordering and response bounds;
- public cursor binding to tenant host, service, provider, range, policy, and scheduling revisions.

### MongoDB integration tests

- migration/backfill/validator/index idempotency;
- exact slug lookup cannot resolve another tenant;
- same public IDs in another host/tenant safely return `404`;
- inactive/unpublished tenants and private/inactive services are not inferable;
- provider eligibility requires all four approved predicates;
- scheduled appointments remove starts while cancelled/completed/no-show historical records follow PR 8 rules;
- breaks, closures, time off, buffers, schedules, cadence, and timezone use existing engine behavior;
- seed is idempotent and creates no public state collection.

### API tests

- all four public endpoints and OpenAPI examples;
- arbitrary tenant query/header/body values are ignored or rejected;
- no admin session required and no admin cookie emitted;
- safe `404` parity;
- range, limit, cursor, and rate-limit errors;
- cache-control/ETag behavior;
- request IDs and structured logging without PII;
- appointment and operational records never appear in responses.

### Frontend tests

- host selects public versus administrative application;
- branding and service rendering;
- service/provider/date/time flow;
- no Any Provider choice;
- empty/loading/error/retry states;
- final coming-soon state creates no network mutation;
- refresh/back navigation without durable state;
- keyboard/focus/status announcements;
- mobile layout and touch targets;
- color fallback and image fallback;
- regression coverage for Business Hub login, tenant switching, appointments, and logout on the admin host.

### CI

Mongo-backed CI continues using the existing MongoDB service and `MONGODB_TEST_URI`. No new GitHub secret is required. Canonical formatting, lint, strict typecheck, unit, integration, build, frontend-bundle secret check, container build, audit, and secret scan gates remain mandatory.

## 20. Performance targets

Measured against seeded staging data and documented fixtures:

- booking context p95 server time below 100 ms;
- service/provider lists p95 below 150 ms;
- one-day available-start response p95 below 300 ms;
- 14-day available-start response p95 below 750 ms;
- no response exceeds 100 starts or the existing response-size budget;
- no unbounded collection scan in `explain("executionStats")` for host, service, provider, assignment, exception, or appointment-conflict queries;
- repeated identical calculations are deterministic without a cache;
- maximum-bound unit regression completes within the existing test timeout; do not raise global timeouts to pass it.

Log calculation duration, returned-start count, normalized route, outcome, and request ID. Do not log customer IP at application info level, arbitrary host text, or appointment/customer contents.

## 21. Acceptance checklist

1. A canonical `{slug}.booknowtech.com` hostname resolves exactly one active, published tenant.
2. Root, admin, reserved, malformed, unknown, suspended, and unpublished hosts return the same safe `404`.
3. Query/header/body tenant identifiers cannot alter the resolved tenant.
4. Only explicitly approved public tenant fields are returned.
5. Only active, `publicly_bookable` services appear.
6. Providers require active provider, active assignment, `customer_selectable=true`, and `accepting_new_clients=true`.
7. Public starts reuse PR 5–8 scheduling and scheduled-appointment conflict subtraction.
8. Public responses expose no appointments, customers, breaks, closures, time off, buffers, blocked intervals/reasons, ObjectIds, or internal fields.
9. Policy precedence is service override, tenant default, then 120-minute/90-day platform defaults.
10. Lead time uses an exact server timestamp and maximum advance uses an inclusive tenant-local date boundary.
11. Requests are limited to 14 days and 100 starts with tamper-resistant query-bound cursors.
12. Safe `404`, validation, and rate-limit behavior are covered at API and Mongo layers.
13. The mobile-accessible public flow reaches a read-only time summary and performs no mutation.
14. Administrative Business Hub behavior and sessions remain unchanged.
15. Migration, indexes, validators, and seed are idempotent; publication defaults false outside explicit staging fixtures.
16. Canonical CI, Mongo tests, container build, audit, and secret scan pass.
17. No customer, appointment, hold, visitor, public session, or slot document is created.
18. No new Railway variable, service, queue, distributed cache, worker workflow, or unrelated abstraction is introduced.

## 22. Rollout

1. Merge only after all canonical and Mongo-backed checks pass.
2. Existing Railway API pre-deploy runs the additive idempotent migration.
3. Verify Atlas backfills, validators, and indexes before publishing a tenant.
4. Deploy API and frontend from `main`; worker behavior is unchanged.
5. Keep all existing tenants unpublished by migration default.
6. Run the staging seed and publish only the two staging demos.
7. Configure/test the fallback DNS wildcard separately only if it is not already present; no custom domain is attached.
8. Smoke-test valid/invalid/reserved hosts, public fields, eligibility combinations, policy boundaries, DST, existing appointment subtraction, pagination, rate limits, mobile accessibility, and final no-write state.
9. Confirm administrative login and appointment workflows remain operational regardless of public host/DNS availability.
10. Monitor safe `404`, `429`, latency, response-size, and calculation-count metrics by request ID.

PR 9 may be deployed before PR 10, but only explicitly published staging tenants are visible. Production/customer tenants remain unpublished until the appointment-submission workflow is approved and operational.

## 23. Rollback

- Set `public_booking_enabled=false` for any published tenant through the existing authenticated configuration flow.
- Redeploy the previous frontend/API commit if necessary.
- Leave additive fields, validators, and indexes in place; previous versions ignore them.
- Do not drop indexes, unset fields, change slugs, or rewrite scheduling/appointment data during emergency rollback.
- Public DNS failure or withdrawal must not affect Business Hub operation at the administrative hostname.
- Any destructive cleanup or hostname migration requires a separately approved migration/ADR.

## 24. Decisions requiring approval before implementation

1. **Seed hostname stability:** keep existing `harbor-demo` / `city-services-demo` slugs, or migrate staging to `brazilian-wax-demo` / `braiding-demo`. Recommendation: preserve existing database slugs in PR 9 and use customer-facing display names; rename only through a dedicated redirect-aware hostname migration.
2. **Public rate limiter:** approve bounded per-replica in-process rate limiting with the documented limitations. If a shared/global guarantee is required, it conflicts with the explicit no-cache/no-service scope and requires an ADR or later infrastructure PR.
3. **Public contact fields:** approve explicit public copies of phone/email/website rather than reusing administrative contact fields. Recommendation: approve to prevent accidental disclosure.
4. **Pre-PR 10 publication:** approve enabling only seeded staging tenants while all other tenants default to unpublished. Recommendation: approve.
5. **Available-start local context:** approve returning UTC start/end plus one offset-qualified local start and timezone, while withholding blocked intervals. Recommendation: approve for accessible display and DST debugging.

## 25. Explicit exclusions

Appointment submission, appointment mutation, temporary booking holds, anonymous writes, customer authentication, customer portal, guest customer creation/matching, guest checkout persistence, public session persistence, payments, Stripe customers, deposits, taxes, fees calculation, notifications, reminders, intake forms, waivers, documents, rescheduling links, cancellation links, custom-domain provisioning/verification/certificates, provider login, booking confirmation, idempotency infrastructure, Any Available Provider selection, waitlists, resources/rooms/equipment, multi-provider appointments, calendar integrations, analytics identity, loyalty, memberships, queues, distributed caches, new Railway services, new Railway variables, and unrelated abstractions.

# PR 12 Public Appointment Self-Service Runbook

## Purpose

This runbook covers deployment, staging verification, rollback, and incident handling for secure public appointment-management links.

## Required Railway variables

Configure the same cryptographically random secret on both services:

| Service | Variable                          | Requirement                                        |
| ------- | --------------------------------- | -------------------------------------------------- |
| API     | `PUBLIC_APPOINTMENT_TOKEN_SECRET` | At least 32 bytes; identical to worker value       |
| Worker  | `PUBLIC_APPOINTMENT_TOKEN_SECRET` | At least 32 bytes; identical to API value          |
| API     | `MONGODB_URI`                     | Existing production/staging replica-set connection |
| API     | `MONGODB_DATABASE`                | Existing environment database                      |
| Worker  | `MONGODB_URI`                     | Same environment as API                            |
| Worker  | `MONGODB_DATABASE`                | Same environment as API                            |
| Worker  | `TRANSACTIONAL_EMAIL_PROVIDER`    | `postmark`                                         |
| Worker  | `TRANSACTIONAL_EMAIL_TOKEN`       | Existing Postmark server token                     |
| Worker  | `TRANSACTIONAL_EMAIL_FROM`        | Verified sender address                            |

Generate the shared secret in an approved secret manager. Never place it in source control, logs, tickets, screenshots, Postmark metadata, or customer-facing documentation. A secret rotation intentionally invalidates every outstanding management link.

## Pre-deployment checks

1. Confirm API, frontend, and worker artifacts use the same reviewed commit.
2. Confirm canonical CI is green, including the Mongo-backed suite with `MONGODB_TEST_URI`.
3. Confirm the migration is additive and the token indexes include the partial active-token uniqueness rule and TTL index.
4. Confirm every existing tenant will migrate with self-service disabled.
5. Confirm the API and worker contain the same shared secret without printing either value.
6. Confirm PR 11 transactional appointment email settings remain enabled only where intended.

## Deployment and migration

1. Add `PUBLIC_APPOINTMENT_TOKEN_SECRET` to API and worker Railway services.
2. Deploy API, frontend, and worker from the same commit.
3. Run the idempotent database migration once through the normal release command:

   ```sh
   pnpm db:migrate
   ```

4. Run the migration a second time in staging to confirm repeatability.
5. Verify `appointment_public_access_tokens` has:

   - unique public ID;
   - unique token hash;
   - tenant/appointment/purpose/status lookup;
   - partial unique active token per tenant/appointment/purpose; and
   - `purge_at` TTL expiration.

6. Verify all tenants have `appointment_self_service.enabled=false`.
7. Enable only the approved staging demo tenant through Business Hub settings.

## Staging QA checklist

### Issuance and email

- [ ] Create a fresh scheduled appointment with a deliverable customer email.
- [ ] Confirm the appointment, access token, and confirmation outbox record commit together.
- [ ] Confirm exactly one active management token exists.
- [ ] Confirm MongoDB stores a lowercase SHA-256 hash and never the raw credential.
- [ ] Confirm the email contains a branded **Manage appointment** CTA and plaintext URL.
- [ ] Confirm Postmark metadata uses `notice_id` and contains no token or customer contact data.

### Link and summary

- [ ] Open the email link on the matching tenant hostname.
- [ ] Confirm the page removes `#token=...` using `history.replaceState`.
- [ ] Confirm no credential appears in cookies, local storage, session storage, rendered text, logs, or network URLs.
- [ ] Confirm business branding, reference, service, provider, date, time, duration, timezone, and cutoff messaging are correct.
- [ ] Confirm customer contact data, notes, prices, buffers, blocked intervals, ObjectIds, and audit details are absent.
- [ ] Confirm an invalid, expired, consumed, revoked, and cross-tenant link shows the same unavailable state.

### Reschedule

- [ ] Select a date and confirm the request covers exactly seven tenant-local dates.
- [ ] Compare returned times with the normal availability engine.
- [ ] Attempt two concurrent bookings for one time; confirm only one succeeds.
- [ ] Reschedule successfully and confirm the appointment snapshot fields remain unchanged.
- [ ] Confirm the original token is consumed and exactly one next-generation token is active.
- [ ] Confirm the browser continues using the one-time replacement credential in memory.
- [ ] Confirm the visible URL contains no credential.
- [ ] Confirm the reschedule email contains the replacement-generation link.
- [ ] Confirm reopening the original link produces the generic unavailable state.
- [ ] Confirm an identical idempotent replay returns the prior result without returning the replacement credential again.

### Cancellation

- [ ] Confirm cancellation cannot be submitted until `CANCEL` is entered exactly.
- [ ] Cancel and confirm status is `cancelled` with reason `customer_request` and no free-text detail.
- [ ] Confirm the active token is consumed and no replacement is issued.
- [ ] Confirm the cancellation email has no management CTA.
- [ ] Confirm repeated identical submission is safe and a different key cannot reuse the consumed token.

### Boundaries and accessibility

- [ ] Confirm actions work one millisecond before each cutoff and fail at the exact cutoff instant.
- [ ] Confirm stale version, lost slot, rate limit, and network failure states are announced and offer recovery.
- [ ] Complete the flow using keyboard only.
- [ ] Confirm focus moves to each new screen heading and destructive cancellation is never initially focused.
- [ ] Confirm loading and success updates are announced by a screen reader.
- [ ] Verify at 320 CSS pixels with no horizontal scrolling and touch targets remain usable.

## Monitoring

Monitor API error rate, `appointment_link_unavailable`, `version_conflict`, `start_unavailable`, transaction failures, worker retry/failed counts, and Postmark delivery failures. Do not add raw authorization headers, fragments, token hashes, customer email, phone, or notes to telemetry.

## Rollback

1. Disable `appointment_self_service.enabled` for the affected tenant. This immediately makes its links unusable.
2. Verify Business Hub appointment management remains operational.
3. Redeploy the previous API, frontend, and worker commit together if required.
4. Leave additive fields, indexes, token evidence, and outbox records in place.
5. Do not run a destructive down migration.
6. Rotate `PUBLIC_APPOINTMENT_TOKEN_SECRET` only when invalidating every outstanding link is the intended security response.

## CI-only Mongo coverage

GitHub Actions must supply a replica-set-capable `MONGODB_TEST_URI`. The Mongo suite verifies validators and indexes, repeatable migration, transaction rollback without orphan token/outbox records, one-active-token concurrency, and existing appointment transaction regressions. Local runs without that variable skip these tests by design; treat the GitHub Actions result as the Mongo release gate.

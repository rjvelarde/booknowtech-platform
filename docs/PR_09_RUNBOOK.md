# PR 9 — Public Booking Discovery Runbook

## Scope

PR 9 adds read-only public discovery on `tenant-slug.booknowtech.com`. It does not submit appointments or persist public customer or booking state. It introduces no Railway variables, services, queues, or caches.

## Migration and seed

Run against the intended staging database from the API service:

```shell
pnpm --filter @booknowtech/api db:migrate
pnpm --filter @booknowtech/api db:seed:development
```

The development seed still requires the existing `SEED_ADMIN_EMAIL` and 12-or-more-character `SEED_ADMIN_PASSWORD`. It preserves the current staging tenant slugs, publishes only the two seeded demo tenants, and is idempotent.

## Atlas verification

In `booknowtech_staging`, confirm tenant documents contain `public_booking_enabled`, `public_profile`, and `booking_policy`; service documents contain `publicly_bookable`, `public_display_order`, and `public_booking_policy`.

Confirm these indexes:

- `services.services_public_catalog`
- `providers.providers_public_directory`

Confirm the `tenants` and `services` validators reject unknown fields and malformed public-booking settings. Existing non-seeded tenants must have `public_booking_enabled: false`.

## Railway staging rollout

1. Deploy the API and frontend from the PR 9 branch only for staging QA.
2. Keep the worker unchanged; PR 9 adds no worker responsibility.
3. Run the migration, then the staging seed, once the API image is deployed.
4. Verify API and frontend report the same commit and remain healthy.
5. Map a test hostname to the frontend, or use the existing staging-host routing mechanism with a seeded slug.
6. After merge, return API and frontend to `main` and verify the same merged commit.

No new environment variable is required.

## Staging QA

- Unknown, reserved, unpublished, inactive, and nested hostnames return the same safe public `404` without tenant details.
- Each seeded hostname shows only its approved public business name, branding, contact copies, timezone, locale, and currency.
- Only active, publicly bookable services appear and are ordered deterministically.
- Providers appear only when the provider and assignment are active and both `customer_selectable` and `accepting_new_clients` are true.
- The workflow is usable by keyboard and on a narrow mobile viewport: business → service → provider → date → time.
- Available starts respect schedules, breaks, closures, time off, buffers, lead time, advance window, timezone/DST, and persisted scheduled appointments.
- Public responses contain UUID public identifiers only—never ObjectIds, customer data, appointment details, blocked intervals, or internal reasons.
- A chosen time ends at the informational “not reserved or submitted” state and causes no database write.
- Discovery responses emit cache headers and ETags; availability emits `Cache-Control: no-store`.
- Invalid ranges and cursors are rejected safely; range, result, and per-replica request limits are enforced.
- Administrative publication changes require an authorized owner/admin session, CSRF, optimistic concurrency, and an audit event.

## Rollback

1. Set `public_booking_enabled` to `false` for published tenants.
2. Redeploy the last known-good `main` commit for API and frontend.
3. Leave additive fields and indexes in place; they are backward compatible and do not require destructive rollback.
4. Verify public hostnames return the safe unavailable response and Business Hub remains operational.

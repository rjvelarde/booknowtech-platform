# PR 3 — Tenant Profile and Service Catalog Runbook

## Scope and invariants

PR 3 adds the first tenant-management capability to the Business Hub: business profile management and a tenant-scoped service catalog. Tenant context is derived only from the verified selected membership in `admin_sessions`. Client tenant IDs are never authorization context.

`base_price_minor` and `booking_fee_minor` are catalog values only. This PR does not calculate or model deposits, taxes, processor fees, platform or partner fees, payouts, commissions, or settlement. Quote-based, variable-duration, and multi-day services are deferred. The only service lifecycle states are `active` and `inactive`; deletion and archival are not supported.

## Permissions

| Capability                         | Owner | Admin | Front desk | Provider |
| ---------------------------------- | ----- | ----- | ---------- | -------- |
| View business profile and services | Yes   | Yes   | Yes        | Yes      |
| Edit business profile and services | Yes   | Yes   | No         | No       |
| Activate or deactivate services    | Yes   | Yes   | No         | No       |

## Migration and seed

Run the idempotent migration before the new application revision starts:

```shell
pnpm --filter @booknowtech/api db:migrate
```

The migration backfills existing tenants and creates the `services` collection, validators, and indexes. Confirm `services_tenant_internal_code_unique` is a partial unique index on `(tenant_id, internal_code)`.

For staging only, refresh the representative appointment-business catalog:

```shell
pnpm --filter @booknowtech/api db:seed:development
```

The seed is idempotent and retains the established tenant slugs while renaming the displays to Brazilian Wax Demo and Braiding Demo. Booking fees are representative staging values, not platform pricing rules.

## Railway changes

No Railway variables, domains, ports, services, or routing changes are required. Keep:

- frontend browser API base: `VITE_API_BASE_URL=/api`
- frontend private API origin: `API_PRIVATE_ORIGIN=http://booknowtechapi.railway.internal:8080`
- the existing API administrative variables and `TENANT_ADMIN_ENABLED=true`

Do not add `CATALOG_MANAGEMENT_ENABLED`.

## Rollout

1. Verify CI quality, tests, secret scan, and build.
2. Deploy the API with the migration pre-deploy command.
3. Confirm API health and that the migration completes successfully.
4. Deploy the frontend and worker from the same `main` revision.
5. Run the staging seed once with approved temporary seed credentials.
6. Verify owner/admin create and edit access, provider/front-desk view-only access, tenant switching, optimistic conflict responses, currency locking, and idempotent lifecycle retries.
7. Confirm Atlas contains the expected tenant-scoped service documents and no credentials or session secrets are logged.

## Rollback

Roll back the API and frontend to the prior known-good revision. The additive `services` collection and tenant profile fields may remain in place; the prior application ignores them. Do not drop collections or indexes during an emergency rollback. Any later destructive cleanup requires a separately reviewed migration.

## Acceptance checklist

- Business profile and service routes require a valid administrative session and selected membership.
- All four fixed roles can view the selected tenant profile and catalog.
- Only `tenant_owner` and `tenant_admin` can mutate them.
- Tenant A cannot read, create, update, activate, deactivate, or infer Tenant B services.
- Client-supplied tenant IDs are ignored as authorization context.
- Internal codes normalize to uppercase and are unique within a tenant when present.
- Delivery accepts only `provider_location`, `customer_location`, or `virtual`.
- Duration accepts integer values from 5 through 1,440 minutes.
- Monetary values are nonnegative integer minor units and are not checkout calculations.
- Tenant currency changes are rejected once any active or inactive service exists.
- Optimistic concurrency returns `409` for stale actual mutations.
- Repeating an already-completed activation/deactivation returns `200`, `changed=false`, and creates no audit event or version change.
- Successful mutations write tenant- and actor-scoped audit events.
- Forms are keyboard accessible, labelled, and expose error/status messages to assistive technology.

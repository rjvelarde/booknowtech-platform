# PR 2 Business Hub Authentication Runbook

PR 2 is internal, nonproduction staging only. The Railway environment currently named `production` is treated as staging and must receive no real production users or traffic.

## Confirmed routing

- Temporary administrative origin: `https://booknowtechfrontend-production.up.railway.app`
- Browser API base in every environment: `/api`
- Railway private API origin: `http://booknowtechapi.railway.internal:3000`
- The frontend Caddy service owns the public hostname, serves Vite assets, and proxies `/api/*` privately.

## Variables

Frontend:

```text
VITE_API_BASE_URL=/api
API_PRIVATE_ORIGIN=http://booknowtechapi.railway.internal:3000
```

API additions/changes:

```text
HOST=0.0.0.0
PORT=3000
ADMIN_ORIGIN=https://booknowtechfrontend-production.up.railway.app
TENANT_ADMIN_ENABLED=false
```

Retain the existing staging MongoDB, logging, build-version, and OpenAPI settings. Never expose `MONGODB_URI`, seed credentials, session tokens, or CSRF tokens.

## Migration and seed

Railway runs the idempotent migration before API deployment:

```shell
pnpm --filter @booknowtech/api db:migrate
```

Seed only an approved internal staging account from an operator environment:

```shell
SEED_ADMIN_EMAIL=INTERNAL_EMAIL \
SEED_ADMIN_PASSWORD=INTERACTIVE_SECRET \
pnpm --filter @booknowtech/api db:seed:development
```

Do not store seed credentials as long-lived source, build arguments, tickets, screenshots, or logs.

## Rollout

1. Deploy API with `TENANT_ADMIN_ENABLED=false`; verify health and migration.
2. Deploy frontend/Caddy; verify `/`, an SPA fallback path, and `/api/v1/version`.
3. Seed the approved internal user.
4. Set `TENANT_ADMIN_ENABLED=true` and redeploy the API.
5. Verify login, session hydration, tenant selection, switching, CSRF rejection, logout, and audit events.
6. Confirm the session cookie is `Secure`, `HttpOnly`, host-only, `SameSite=Lax`, and `Path=/`.
7. Remove `TENANT_ADMIN_ENABLED` in a focused cleanup PR after PR 2 is declared stable.

## Rollback

1. Set `TENANT_ADMIN_ENABLED=false` and redeploy the API.
2. Confirm the PR 1 placeholder returns.
3. Revoke PR 2 sessions.
4. Roll back frontend/API deployments if required.
5. Preserve collections, indexes, and audit evidence.

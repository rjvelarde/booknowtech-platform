# Railway Staging Deployment and Rollback

## Scope

PR 1 deploys three **staging-only** services from this repository. It enables no production traffic, tenant routes, customer routes, login, booking, or business job.

## Service configuration

Create three Railway services from the same GitHub repository and keep the repository root as each service's source directory:

| Railway service                | Config-as-code path      | Public network   | Health check           |
| ------------------------------ | ------------------------ | ---------------- | ---------------------- |
| `booknowtech-frontend-staging` | `/railway.frontend.toml` | Staging URL only | `/`                    |
| `booknowtech-api-staging`      | `/railway.api.toml`      | Staging URL only | `/health/ready`        |
| `booknowtech-worker-staging`   | `/railway.worker.toml`   | Disabled         | Process restart policy |

Set each service's Railway config file path to the corresponding file. Do not create a production environment from this runbook.

The PR 1 API uses a **Railway staging-only public HTTPS URL** so the documented smoke script can run from GitHub Actions or an engineer's approved workstation. No production domain or production traffic is attached. The staging API exposes only `/health/live`, `/health/ready`, `/api/v1/version`, and, when enabled, the non-production `/documentation/openapi.json`; every other route returns not found. Railway private networking may replace this only through a later approved infrastructure change that also provides an internal smoke runner.

Vite builds the frontend into `apps/frontend/dist`. Starting in PR 2, the frontend container runs Caddy to serve those assets, enable SPA fallback, and proxy `/api/*` to the API over Railway private networking. Vite's development and preview servers are not used in staging.

## Variables

Use Railway variables or secret references. Never paste values into source, build arguments, screenshots, tickets, or logs.

### Frontend

- `PORT` — supplied by Railway.
- `VITE_API_BASE_URL=/api` — identical in development, staging, and production.
- `API_PRIVATE_ORIGIN=http://booknowtechapi.railway.internal:8080` — runtime-only Caddy upstream, verified from the running API service.

### API

- `NODE_ENV=staging`
- `ENVIRONMENT_ID=staging`
- `HOST=0.0.0.0`
- `PORT` — supplied by Railway.
- `LOG_LEVEL=info`
- `MONGODB_URI` — secret reference for the isolated non-production Atlas user.
- `MONGODB_DATABASE=booknowtech_staging`
- `BOOKING_ROOT_DOMAIN=staging.booknowtech.com`
- `BUILD_VERSION` is derived automatically from Railway's `RAILWAY_GIT_COMMIT_SHA`; do not set it.
- `ADMIN_ORIGIN=https://booknowtechfrontend-production.up.railway.app`
- `TENANT_ADMIN_ENABLED=false` — temporary PR 2 rollout control.
- `OPENAPI_ENABLED=true`

### Worker

- `NODE_ENV=staging`
- `ENVIRONMENT_ID=staging`
- `LOG_LEVEL=info`
- `MONGODB_DATABASE=booknowtech_staging`
- `BOOKING_ROOT_DOMAIN=staging.booknowtech.com`
- `BUILD_VERSION` is derived automatically from Railway's `RAILWAY_GIT_COMMIT_SHA`; do not set it.

The worker intentionally has no Atlas setting in PR 1 because it performs no database work.

## Pre-deployment checklist

1. Confirm CI passed on the exact commit.
2. Confirm the Atlas database user is staging-only and least-privileged for connectivity verification.
3. Confirm Atlas network access permits only the required Railway connectivity mechanism.
4. Confirm all three Railway services use the correct config path.
5. Confirm no production custom domain or public production traffic is attached.
6. Record the current known-good Railway deployment IDs for rollback.

## Deploy

1. Deploy API and wait for `/health/live` and `/health/ready` to pass.
2. Deploy worker and confirm one structured `service.started` event.
3. Deploy frontend and confirm the BookNowTech Business Hub landing page.
4. Run:

   ```shell
   STAGING_FRONTEND_URL=https://FRONTEND-STAGING-URL \
   STAGING_API_URL=https://API-STAGING-URL \
   EXPECTED_BUILD_VERSION=GIT-COMMIT-SHA \
   node scripts/smoke-staging.mjs
   ```

5. Inspect representative API and worker logs. Confirm JSON structure, version, environment, service, event, and request correlation fields; confirm no credentials or connection strings appear.

## Atlas dependency-failure exercise

Perform only in staging during an announced test window:

1. Record the current healthy readiness result.
2. Temporarily revoke the staging API's access to its Atlas setting using a reversible Railway variable change; do not delete the Atlas project, user, or data.
3. Confirm `/health/ready` returns `503` with `{"data":{"status":"not_ready"}}` within the configured probe timeout.
4. Confirm `/health/live` still returns `200` with `{"data":{"status":"live"}}`.
5. Restore the original secret reference and confirm readiness recovers.
6. Attach redacted timestamps/status evidence to PR 1.

## Rollback

1. Identify the last known-good deployment using `GET /api/v1/version` and the recorded deployment ID.
2. Use Railway's deployment history to redeploy the previous known-good version for each affected service.
3. Do not delete or modify MongoDB data; PR 1 creates no collection.
4. Run the smoke command against the restored services with the restored expected version.
5. Confirm API/worker error rate stabilizes and logs contain no restart loop.
6. Record the rollback operator, time, from/to versions, result, and follow-up issue.

If rollback cannot restore readiness because Atlas is unavailable, keep the API out of rotation while preserving liveness and escalate through the Atlas dependency incident path. Do not bypass readiness or point staging at production data.

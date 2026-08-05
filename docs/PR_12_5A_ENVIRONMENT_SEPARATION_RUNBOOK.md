# PR 12.5A Environment Separation Runbook

## Boundary

This PR adds repository safeguards and documentation only. Operators perform Railway, Atlas,
Postmark, and DNS changes manually. Payments, custom customer domains, backups, and application
features are excluded.

The current Railway environment is staging/QA. Its default `production` label is corrected to
`staging`; this is not a live production cutover and there are no paying customers or payment
credentials.

## Required matrix

| Variable                          | Staging                    | Production                    | Service     |
| --------------------------------- | -------------------------- | ----------------------------- | ----------- |
| `NODE_ENV`                        | `staging`                  | `production`                  | API, worker |
| `ENVIRONMENT_ID`                  | `staging`                  | `production`                  | API, worker |
| `RAILWAY_ENVIRONMENT_NAME`        | Railway: `staging`         | Railway: `production`         | supplied    |
| `RAILWAY_GIT_COMMIT_SHA`          | immutable 40-character SHA | approved immutable SHA        | supplied    |
| `MONGODB_DATABASE`                | `booknowtech_staging`      | `booknowtech_production`      | API, worker |
| `BOOKING_ROOT_DOMAIN`             | `staging.booknowtech.com`  | `booknowtech.com`             | API, worker |
| `VITE_BOOKING_ROOT_DOMAIN`        | `staging.booknowtech.com`  | `booknowtech.com`             | frontend    |
| `ADMIN_ORIGIN`                    | staging administrative URL | production administrative URL | API         |
| `OPENAPI_ENABLED`                 | operator-approved          | `false`                       | API         |
| `MONGODB_URI`                     | staging runtime user       | production runtime user       | API, worker |
| `PUBLIC_APPOINTMENT_TOKEN_SECRET` | unique staging value       | independent production value  | API, worker |
| `RATE_LIMIT_KEY_SECRET`           | unique staging value       | independent production value  | API         |
| `TRANSACTIONAL_EMAIL_TOKEN`       | staging Postmark token     | production Postmark token     | worker      |
| `TRANSACTIONAL_EMAIL_FROM`        | staging verified sender    | production verified sender    | worker      |
| `POSTMARK_SERVER_ID`              | staging server ID          | production server ID          | worker      |

Operators do not set `BUILD_VERSION` in Railway. API and worker derive it from
`RAILWAY_GIT_COMMIT_SHA`; the frontend embeds the same Git value in `/version.json`.

## Rename and staging wildcard

1. Record the current Railway environment UUID, service IDs, deployments, variables by name,
   domain attachments, Atlas runtime identity, and Postmark server ID.
2. Rename the current Railway environment from `production` to `staging`; do not clone it.
3. Confirm the environment UUID, services, deployment history, private networking, and current
   domains are unchanged.
4. Configure the staging matrix above and deploy the exact CI-approved commit.
5. Add `*.staging.booknowtech.com` to the staging frontend and add the Railway-supplied DNS record.
6. Keep `*.booknowtech.com` attached to staging until staging-suffix QA passes.
7. Verify administrative login, public booking, email, management, reschedule, and cancellation on
   staging hosts. Confirm generated management links use the staging suffix.

## Seed authorization

Run only as an explicit staging operator action:

```sh
ALLOW_DEVELOPMENT_SEED=true pnpm db:seed:staging
```

The command rejects before MongoDB construction when `NODE_ENV`, `ENVIRONMENT_ID`, optional
Railway name, database name, or approval flag is wrong. Production must omit the approval flag and
all seed credentials.

## Postmark deployment readiness

Postmark verification is a promotion command, not a worker startup dependency:

```sh
pnpm --filter @booknowtech/worker verify:postmark
```

It authenticates `GET /server` with the configured server token and verifies the returned ID equals
`POSTMARK_SERVER_ID`. Run it during staging validation and production approval. Verify the sender in
Postmark separately. A provider outage blocks promotion but does not stop a running worker; normal
outbox retry remains authoritative.

## Production creation and proof

1. Create `booknowtech_production` with a separate Atlas runtime user and connection string.
2. Prove each environment user is denied access to the other database.
3. Create a separate production Postmark server, token, and verified sender.
4. Create an empty Railway `production` environment and three fresh services; do not duplicate
   staging.
5. Keep frontend public and API/worker private.
6. Enter only the reviewed production matrix. Do not add seed variables.
7. Deploy the exact SHA approved in staging, run migrations, run Postmark readiness, and verify API,
   worker, and frontend versions match.
8. Confirm production business-data counts are zero before controlled smoke data: tenants, users,
   memberships, customers, appointments, outbox, access tokens, sessions, and limiter buckets.
9. Compare secret fingerprints and prove staging and production credentials differ without exposing
   their values.
10. Move `*.booknowtech.com` only after staging-suffix QA and production isolation approval.

## Staging QA

- [ ] API and worker start with the staging matrix.
- [ ] Mismatched `NODE_ENV`, environment name, database, or booking root fails safely.
- [ ] `admin.staging.booknowtech.com` selects the administrative application.
- [ ] `{slug}.staging.booknowtech.com` selects only that staging tenant.
- [ ] Production, nested, malformed, and suffix-confusion hosts are rejected by staging.
- [ ] Booking and appointment-management links use only the staging suffix.
- [ ] `/version.json`, `/api/v1/version`, and worker startup logs show the same Git SHA.
- [ ] Seed fails without explicit approval and succeeds only against `booknowtech_staging`.
- [ ] Postmark readiness confirms the staging server ID.
- [ ] Postmark unavailability does not terminate an already-running worker.
- [ ] Logs and evidence contain no connection strings, tokens, passwords, or customer contact data.

## Promotion

Record the CI run, staging deployment IDs, QA evidence, migration result, Postmark readiness result,
and immutable SHA. A named release operator approves that SHA and deploys it unchanged to production.
Do not rebuild from a moving branch or manually enter a build version.

## Rollback

Record the previous known-good deployment IDs and SHA before promotion. For an application failure,
redeploy that immutable version for API, worker, and frontend, verify matching versions, and repeat
the minimal smoke test. Never point production at staging Atlas or Postmark, copy staging data, run
the staging seed, or destructively reverse MongoDB migrations. Restore wildcard DNS only from the
recorded pre-cutover values if domain cutover itself failed.

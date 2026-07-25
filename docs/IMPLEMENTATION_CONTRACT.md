# PR 1 Implementation Contract

## Status

Ratified for PR 1. This contract implements the stack decision assigned to PR 1 by the approved roadmap. It does not change an architectural invariant.

## Supported toolchain

- Runtime: Node.js `24.18.0` LTS.
- Language: TypeScript `7.0.2`, strict mode.
- Package manager: pnpm `11.17.0` using native pnpm workspaces.
- Lock strategy: one committed root `pnpm-lock.yaml`; exact direct dependency versions.
- Frontend: React `19.2.8` with Vite `8.1.5`.
- API: Fastify `5.10.0`.
- Worker: a separate Node.js TypeScript process with no job framework in PR 1.
- Database connectivity: official MongoDB Node.js driver against MongoDB Atlas.
- Tests: Vitest.
- Formatting/linting: Prettier and ESLint with typed TypeScript rules.
- CI: GitHub Actions.
- Deployment: three Railway staging services.

Node.js 24 is the current LTS line. Pinning the exact runtime makes local, CI, and Railway behavior reproducible; updates occur through reviewed dependency/toolchain PRs.

## Repository layout

```text
apps/
  frontend/  # Business Hub browser application
  api/       # HTTP API and Atlas readiness owner
  worker/    # Independent background process; no business jobs in PR 1
docs/        # Repository-local engineering and operations documentation
scripts/     # Deployment smoke checks
```

No shared workspace is created in PR 1 because no implementation is yet reused by two process boundaries strongly enough to justify it. Later shared packages require an approved roadmap need.

## Canonical commands

| Purpose                       | Root command                     |
| ----------------------------- | -------------------------------- |
| Locked install                | `pnpm install --frozen-lockfile` |
| Development                   | `pnpm dev`                       |
| Format                        | `pnpm format`                    |
| Formatting check              | `pnpm format:check`              |
| Lint                          | `pnpm lint`                      |
| Strict typecheck              | `pnpm typecheck`                 |
| All tests                     | `pnpm test`                      |
| Unit tests                    | `pnpm test:unit`                 |
| Integration tests             | `pnpm test:integration`          |
| All builds                    | `pnpm build`                     |
| Frontend build                | `pnpm build:frontend`            |
| API build                     | `pnpm build:api`                 |
| Worker build                  | `pnpm build:worker`              |
| Dependency audit              | `pnpm audit`                     |
| Full local CI-equivalent gate | `pnpm verify`                    |

## Process contracts

| Process  | Build                                       | Start                                       | Railway boundary                            |
| -------- | ------------------------------------------- | ------------------------------------------- | ------------------------------------------- |
| Frontend | `pnpm --filter @booknowtech/frontend build` | `pnpm --filter @booknowtech/frontend start` | Public static Business Hub service          |
| API      | `pnpm --filter @booknowtech/api build`      | `pnpm --filter @booknowtech/api start`      | Private/API HTTP service with health probes |
| Worker   | `pnpm --filter @booknowtech/worker build`   | `pnpm --filter @booknowtech/worker start`   | Non-HTTP background service                 |

Each process receives termination signals directly and must shut down cleanly. PR 1 creates no tenants, sessions, bookings, business jobs, provider integrations, public hostname resolver, or MongoDB collection.

## Endpoint ownership

The API owns:

- `GET /health/live`
- `GET /health/ready`
- `GET /api/v1/version`

Liveness represents process responsiveness only. Readiness performs a bounded Atlas ping without creating a collection. Version metadata comes from the validated `BUILD_VERSION` setting.

When `OPENAPI_ENABLED=true` outside production, the generated OpenAPI JSON is available at `/documentation/openapi.json`. A documentation UI is intentionally deferred.

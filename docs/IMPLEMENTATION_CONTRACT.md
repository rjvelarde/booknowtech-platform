# PR 1 Implementation Contract

## Status

Ratified for PR 1. This contract implements the stack decision assigned to PR 1 by the approved roadmap. It does not change an architectural invariant.

## Supported toolchain

- Runtime: Node.js `24.18.0` LTS.
- Language: TypeScript `6.0.3`, strict mode.
- Package manager: pnpm `11.17.0` using native pnpm workspaces.
- Lock strategy: one committed root `pnpm-lock.yaml`; exact direct dependency versions.
- Frontend: React `19.2.8` with Vite `8.1.5`.
- API: Fastify `5.10.0`.
- Worker: a separate Node.js TypeScript process with no job framework in PR 1.
- Database connectivity: official MongoDB Node.js driver `7.5.0` against MongoDB Atlas.
- Static staging server: `sirv-cli` `3.0.1` serving the Vite production build.
- Tests: Vitest `4.1.10`.
- Formatting/linting: Prettier `3.9.6`, ESLint `10.0.1`, and `typescript-eslint` `8.65.0` with typed rules.
- CI: GitHub Actions.
- Deployment: three Railway staging services.

Node.js 24 is the current LTS line. Pinning the exact runtime makes local, CI, and Railway behavior reproducible; updates occur through reviewed dependency/toolchain PRs.

`typescript-eslint` is pinned to `8.65.0`, whose [official TypeScript compatibility range](https://typescript-eslint.io/users/dependency-versions/) is `>=4.8.4 <6.1.0`. TypeScript `6.0.3` is the latest stable release inside that range. Typed linting remains enabled through `recommendedTypeChecked` and `projectService`. TypeScript 7 is intentionally deferred to a future reviewed toolchain-upgrade PR after official support is available.

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

| Process  | Build                                       | Start                                       | Railway boundary                   |
| -------- | ------------------------------------------- | ------------------------------------------- | ---------------------------------- |
| Frontend | `pnpm --filter @booknowtech/frontend build` | `pnpm --filter @booknowtech/frontend start` | Public static Business Hub service |
| API      | `pnpm --filter @booknowtech/api build`      | `pnpm --filter @booknowtech/api start`      | Staging-only HTTPS operational API |
| Worker   | `pnpm --filter @booknowtech/worker build`   | `pnpm --filter @booknowtech/worker start`   | Non-HTTP background service        |

Each process receives termination signals directly and must shut down cleanly. PR 1 creates no tenants, sessions, bookings, business jobs, provider integrations, public hostname resolver, or MongoDB collection.

### Frontend staging serving

Vite performs the production build only and writes browser assets to `apps/frontend/dist`. Railway runs pinned `sirv-cli` `3.0.1` against that directory; it does not run the Vite development or preview server. Railway supplies `PORT`, and the static server binds to `0.0.0.0`. Its `--single` option provides SPA fallback to `index.html` for future client-side routes; PR 1 itself contains only the landing page.

## Endpoint ownership

The API owns:

- `GET /health/live`
- `GET /health/ready`
- `GET /api/v1/version`

Liveness represents process responsiveness only. Readiness performs a bounded Atlas ping without creating a collection. Version metadata comes from the validated `BUILD_VERSION` setting.

When `OPENAPI_ENABLED=true` outside production, the generated OpenAPI JSON is available at `/documentation/openapi.json`. A documentation UI is intentionally deferred.

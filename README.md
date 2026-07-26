# BookNowTech Platform

Independent multi-tenant booking platform. PR 1 provides only the deployment and operational skeleton.

## Requirements

- Node.js `24.18.0`
- pnpm `11.17.0`
- A non-production MongoDB Atlas database for readiness checks

## Local setup

1. Install and enable Corepack, including on Node distributions that do not bundle it:

   ```shell
   npm install --global corepack@latest
   corepack enable
   corepack prepare pnpm@11.17.0 --activate
   ```

   The repository's `packageManager` field and lockfile remain pinned to pnpm `11.17.0`.

2. Copy `.env.example` to `.env` and replace placeholders with isolated local/non-production values.
3. Run `pnpm install --frozen-lockfile`.
4. Run `pnpm verify`.
5. Run `pnpm dev`.

Never commit `.env` or credentials. Server-only settings must not use the `VITE_` prefix.

See [the implementation contract](docs/IMPLEMENTATION_CONTRACT.md) for canonical commands and process boundaries.

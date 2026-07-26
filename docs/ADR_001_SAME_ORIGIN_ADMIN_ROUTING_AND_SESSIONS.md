# ADR 001 — Same-Origin Business Hub Routing and Administrative Sessions

**Status:** Accepted  
**Accepted:** 2026-07-26

## Context

The Business Hub must operate at one administrative origin. Tenant context comes only from an authenticated user's verified server-side selected membership. PR 1 deployed separate frontend and API services, so PR 2 needs same-origin browser routing and revocable administrative sessions without collapsing those process boundaries.

## Decision

- `admin.booknowtech.com/*` serves the Vite Business Hub through the frontend service.
- `admin.booknowtech.com/api/*` reaches the API through Caddy and Railway private networking.
- The browser always uses `VITE_API_BASE_URL=/api` in development, staging, and production.
- The existing frontend service runs Caddy; no fourth proxy service is added.
- The API remains a separate service. The worker remains private and unchanged.
- Administrative sessions are server-side documents in `admin_sessions`.
- The browser receives an opaque `__Host-bnt_admin_session` cookie with `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, and no `Domain` attribute.
- Raw session and CSRF tokens are never stored, logged, audited, or returned outside their required browser exchange.
- Login, tenant switching, and privilege changes rotate session and CSRF state.
- Logout and security changes revoke server-side sessions.
- Every `/api/v1/admin/...` request reloads and verifies the session, user, selected membership, fixed role, and tenant.
- Tenant identifiers supplied by bodies, queries, headers, routes, or browser storage never establish or override authorization context.
- Fixed roles are `tenant_owner`, `tenant_admin`, `provider`, and `front_desk`.
- Future OIDC, SAML, Microsoft Entra ID, and Google Workspace authentication must issue the same `admin_sessions` session type rather than create a parallel session system.

## Confirmed staging routing

- Temporary administrative origin: `https://booknowtechfrontend-production.up.railway.app`
- API private origin: `http://booknowtechapi.railway.internal:3000`

The Railway environment is currently labeled `production`, but this deployment is treated as nonproduction staging and must receive no real production traffic.

## Session collection

`admin_sessions` is platform security data, not tenant-owned business data. It stores a hashed token, `admin` audience, user reference, nullable selected membership reference, hashed CSRF token, creation/rotation/activity/expiry timestamps, revocation state, and originating request ID.

Required indexes are unique public ID, unique token hash, TTL expiry, user/revocation/expiry, and membership/revocation. TTL is cleanup only; the API rejects expiry and revocation synchronously.

## Consequences

The frontend service becomes security-relevant proxy infrastructure and must test path preservation, SPA fallback, private upstream failure, and forwarding-header trust. Sessions become individually revocable and tenant switching becomes auditable. The three-service Railway topology remains unchanged.

## Rollout and rollback

`TENANT_ADMIN_ENABLED` temporarily gates PR 2. Deploy routing and migrations while false, enable only for internal staging verification, then remove the flag after PR 2 is declared stable. Rollback disables the flag, revokes sessions, and restores prior frontend/API deployments without deleting collections or audit evidence.

## Exclusions

PR 2 excludes password reset, magic links, invitations, member management, tenant settings, custom roles, scheduling, bookings, payments, public authentication, public hostname resolution, and unrelated abstractions.

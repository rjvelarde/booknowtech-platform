# PR 12.5A Trusted Proxy and Canonical Client-IP Runbook

## Contract

Production and staging browser requests follow this path:

```text
browser -> Railway public ingress -> frontend/Caddy -> Railway private network -> API
```

The required staging contract is that Railway appends the connecting client address to
`X-Forwarded-For`; the evidence table below must confirm that behavior before production. Caddy
accepts forwarding metadata only when its immediate peer is loopback, link-local, RFC1918,
Railway's observed `100.64.0.0/10` shared-address space, or IPv6 ULA, parses
`X-Forwarded-For` from right to left, removes all `X-Forwarded-*`, `X-Real-IP`, and inbound
`X-BookNowTech-Client-IP` values, and sends one `X-BookNowTech-Client-IP` value to the API.

The API accepts that canonical header only in `staging` or `production` when its socket peer is on
the same trusted private-address policy. Development and tests use the socket address. A missing or
malformed canonical header on a trusted production path becomes `unknown`; it never falls back to a
spoofable forwarding header.

The API service must not have a public Railway domain. A public API domain would violate this
contract because the Railway edge could become an alternate trusted private path around Caddy.

The first staging probe on 2026-08-05 reported API socket peers in `100.64.0.0/10` instead of the
external client address. Railway was therefore confirmed to use this shared-address range on the
private frontend-to-API path. The range is trusted only as an immediate infrastructure peer; client
identity must still come from Caddy's sanitized canonical header.

## Staging forwarding-chain evidence

Complete this table before production promotion and attach the corresponding Railway log excerpts
to the pull request. Use unique `X-Request-ID` UUIDs so requests can be correlated without logging
credentials or appointment tokens.

| Probe                                                                     | Expected Caddy/API result                                                   | Observed                   |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------- |
| Normal request from a known IPv4 network                                  | API `http.request.started.client_ip` equals the probe's public IPv4 address | Pending staging deployment |
| Normal request from an IPv6 network                                       | API client IP is one normalized IPv6 address                                | Pending staging deployment |
| Request with fake `X-Forwarded-For`                                       | API client IP remains the real probe address                                | Pending staging deployment |
| Request with fake `X-Real-IP`                                             | API client IP remains the real probe address                                | Pending staging deployment |
| Request with fake `X-BookNowTech-Client-IP`                               | API client IP remains the real probe address                                | Pending staging deployment |
| Direct request to the API private hostname from an approved private shell | Missing canonical header resolves to `unknown`                              | Pending staging deployment |

If the first three public probes do not resolve to the known external client address, stop rollout.
Do not broaden trusted ranges and do not trust the leftmost forwarding value. Capture the Caddy
container's socket peer and the full redacted forwarding chain, then make an infrastructure decision.

## Staging verification

1. Confirm the API service has no public Railway domain and is reached by Caddy through
   `API_PRIVATE_ORIGIN` only.
2. Deploy the frontend and API from this branch; the worker is unchanged.
3. Send a request through a tenant hostname with a unique UUID in `X-Request-ID`.
4. Find the matching API `http.request.started` event and compare `client_ip` with the tester's known
   public address.
5. Repeat from a second network and, when available, an IPv6 connection.
6. Repeat while supplying fake `X-Forwarded-For`, `X-Real-IP`, and
   `X-BookNowTech-Client-IP` headers. The logged address must not change.
7. Confirm admin login, public booking, and appointment management still work and retain distinct
   rate-limit subjects for clients on different networks.
8. Confirm no forwarding header values, credentials, management tokens, cookies, or secrets appear
   in application logs.

## Automated coverage

- API unit tests cover public/private IPv4, IPv6, IPv4-mapped IPv6, loopback, link-local, RFC1918,
  IPv6 ULA, malformed/multiple values, production/staging acceptance, direct access, and test-mode
  socket fallback.
- API integration tests verify the explicit Fastify trust function and canonical helper with trusted
  and untrusted socket peers.
- The frontend container test sends spoofed forwarding headers through the real Caddy binary and
  verifies the API receives exactly one sanitized `X-BookNowTech-Client-IP` and no forwarded or
  real-IP headers.

## Rollback

1. Redeploy the previous frontend and API images together.
2. Keep the API private domain restriction in place; do not restore a public API domain as a
   workaround.
3. Confirm admin login and public booking through Caddy.
4. If only client-IP derivation is suspect, treat affected limiter subjects as `unknown` until the
   previous images are active; do not trust inbound forwarding headers directly.

No database, worker, notification, hostname, or environment-variable rollback is required.

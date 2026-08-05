# PR 12.5A Canonical Hostname Resolver Runbook

## Scope

This change extracts the existing BookNowTech fallback-hostname behavior into one shared model. It does not implement custom domains, redirects, DNS verification, Railway mapping, SSL provisioning, or hostname lifecycle state.

It does not change booking, scheduling, appointment, customer, notification, authentication, tenant eligibility, proxy trust, client-IP, rate-limit, security-header, MongoDB, public-token, or Postmark behavior.

## Canonical API

`@booknowtech/shared` exports these browser-independent pure utilities:

```text
normalizeHostname(input) -> normalized ASCII hostname or null
fallbackTenantSlug(hostname) -> exact fallback tenant label or null
fallbackBookingHostname(slug) -> production fallback hostname or null
fallbackBookingOrigin(slug) -> HTTPS production fallback origin or null
isAdministrativeHostname(hostname) -> boolean
```

The API server exposes `TenantHostResolver`:

```text
resolvePublicTenant(host, requiredCapability) -> tenant or null
publicBookingOrigin(tenant) -> approved fallback origin or null
```

For this PR, the resolver recognizes only exact fallback hosts. PR 13 may add verified custom-host persistence behind `TenantHostResolver`; route, frontend, worker, booking, and appointment consumers must not change.

## Normalization policy

- Lowercase the hostname.
- Remove exactly one trailing dot.
- Convert valid Unicode IDNA input to its ASCII A-label representation.
- Accept numeric ports from 1 through 65535 only for `.localhost` and `.example.test` development/test hosts.
- Enforce a maximum 253-character hostname and 63-character labels.
- Require DNS labels to start and end with an ASCII letter or digit and otherwise contain only letters, digits, or hyphens.
- Reject schemes, paths, credentials, query strings, fragments, whitespace, control characters, empty labels, underscores, malformed ports, and multiple trailing dots.
- Require exactly one tenant label before `.booknowtech.com`, `.localhost`, or `.example.test`.
- Reject the root hostname, nested subdomains, suffix-confusion inputs, unsupported suffixes, and reserved tenant labels `admin`, `api`, `book`, `status`, `support`, and `www`.

## Behavior characterization

Automated tests cover:

- active published fallback tenant;
- unpublished, nonexistent, and inactive tenant results;
- enabled and disabled appointment self-service capability;
- administrative, root, reserved, malformed, nested, and suffix-confusion hosts;
- mixed-case, one trailing dot, and approved test-port hosts;
- ASCII, Unicode IDNA, total-length, and label-length validation;
- safe public-route `404` responses without a tenant lookup;
- cross-host public management credentials and tenant-scoped resource lookup;
- worker-generated fallback management links; and
- frontend administrative versus public application selection.

## Intentional behavior differences

The previous public-management-only parser accepted nested `.example.test` hosts by taking the first label. The canonical resolver rejects nested test hosts, matching production behavior and the existing safe-404 contract.

Reserved labels `book`, `status`, and `support` are now rejected consistently in every consumer, as required by the accepted hostname policy. No currently configured tenant fallback hostname uses these labels.

## Staging QA

Record the deployment commit, tester, browser, and result.

- [ ] `admin.booknowtech.com` renders Business Hub and login succeeds.
- [ ] An active published `{tenant}.booknowtech.com` host renders the correct public business.
- [ ] Public services, providers, availability, and booking remain functional.
- [ ] A fresh appointment-management email link uses the matching `{tenant}.booknowtech.com` origin.
- [ ] The management summary, reschedule, rotated credential, and cancellation remain tenant-bound.
- [ ] A valid but unpublished tenant host returns the normal safe unavailable page.
- [ ] A nonexistent tenant host returns the same safe unavailable page.
- [ ] An inactive tenant host returns the same safe unavailable page.
- [ ] Root, `www`, `admin`, malformed, nested, and suffix-confusion hosts never render a public tenant.
- [ ] Mixed-case and single-trailing-dot fallback hosts resolve to the same tenant where the staging edge permits those requests.
- [ ] No cross-tenant service, provider, appointment, or management identifier resolves on another tenant host.
- [ ] Browser console and network logs show no new application errors.

## Rollback

Redeploy the previous API, frontend, and worker commits together. No database rollback, migration, DNS change, Railway environment change, or token rotation is required.

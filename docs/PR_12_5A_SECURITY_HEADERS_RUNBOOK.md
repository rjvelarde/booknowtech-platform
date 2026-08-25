# PR 12.5A Security Headers Runbook

## Scope

This runbook covers only the isolated Caddy security-header task. It does not change hostname resolution, trusted proxies, rate limiting, Railway environments, MongoDB, API/worker behavior, booking, scheduling, or appointments.

## Enforced policy

```text
Content-Security-Policy: default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' https://js.stripe.com https://*.js.stripe.com; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; font-src 'self'; connect-src 'self' https://api.stripe.com; frame-src https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com; manifest-src 'self'; upgrade-insecure-requests; block-all-mixed-content
Strict-Transport-Security: max-age=300
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
X-Frame-Options: DENY
```

The policy applies to root HTML, hashed assets, SPA fallback routes, and proxied API success/error responses.

## Known CSP exceptions

- `style-src 'unsafe-inline'` is required for the current tenant accent-color CSS custom property and existing component styling.
- `img-src https: data:` permits configured HTTPS tenant logos and safe embedded image data.

No `unsafe-eval`, wildcard script source, inline script, third-party script domain, external frame, camera, microphone, geolocation, payment, or USB permission is allowed.

## Automated verification

CI builds the frontend container with the tag `booknowtech-frontend-security-test` and runs:

```sh
pnpm test:security-headers
```

The test starts a mock API and the real Caddy container, then verifies exact headers on:

- `/` on `admin.booknowtech.com`;
- one content-hashed JavaScript or CSS asset;
- an administrative SPA fallback route;
- `/book` on `harbor-demo.booknowtech.com`;
- an appointment-management SPA route on the public host;
- a proxied API `200` response; and
- a proxied API `404` response.

## Staging browser QA

Use a fresh staging deployment and record browser, device, deployment commit, tester, and result. Do not expose appointment-management URL fragments in screenshots.

- [ ] Administrative login succeeds.
- [ ] Business Hub navigation and mutations remain functional.
- [ ] Public discovery loads on the fallback tenant hostname.
- [ ] Public services, providers, availability, and booking complete successfully.
- [ ] A fresh appointment confirmation email contains a working management link.
- [ ] Appointment summary, reschedule, rotated link, and cancellation remain functional.
- [ ] Tenant accent colors render on public booking and management screens.
- [ ] An HTTPS tenant logo renders without a CSP violation.
- [ ] The configured external business website link opens normally.
- [ ] A Postmark-delivered management link opens normally.
- [ ] Page source and browser developer tools show no inline `<script>` requirement.
- [ ] Browser console contains no unexpected CSP violations.
- [ ] Browser network panel shows no HTTP/mixed-content request.
- [ ] Embedding the staging site in a third-party `<iframe>` is blocked.
- [ ] Root HTML, a hashed asset, an SPA fallback, API success, and API error responses contain the exact policy.

## Framing check

From a separate local test page or approved QA origin, attempt:

```html
<iframe src="https://STAGING_HOST/"></iframe>
```

The browser must refuse framing because CSP contains `frame-ancestors 'none'`; `X-Frame-Options: DENY` provides legacy defense in depth.

## Rollback

1. Record the failing deployment commit, affected browser/route, console violation, and request ID if applicable.
2. Redeploy the previous known-good frontend commit. API and worker do not need rollback for a header-only defect.
3. Do not remove individual protections ad hoc in Railway configuration.
4. If CSP alone blocks a required first-party behavior, prepare a narrowly reviewed Caddy change; do not add `unsafe-eval`, wildcard scripts, or a third-party script domain without renewed approval.
5. HSTS already cached by a browser remains active for its remaining `max-age`; rollback cannot revoke it immediately.
6. Repeat root, login, public booking, and appointment-management smoke checks after rollback.

## HSTS promotion plan

HSTS is intentionally limited to `max-age=300` with no `includeSubDomains` and no `preload`.

1. Deploy `max-age=300` and observe staging plus the approved production hostname for at least one normal release cycle.
2. Confirm every served production request is HTTPS, certificate renewal is healthy, and rollback remains possible.
3. Obtain explicit approval before increasing to `max-age=86400`.
4. Observe for at least seven days and repeat certificate/domain inventory checks.
5. Obtain explicit approval before increasing to `max-age=31536000`.
6. Do not add `includeSubDomains` until every BookNowTech subdomain is inventoried and HTTPS-only.
7. Do not add `preload` in PR 12.5A.

Each promotion is a separate reviewed change with automated header assertions, staging QA, deployment evidence, and rollback acknowledgment.

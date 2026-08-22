# PR 13B DNS Ownership and Domain Lifecycle Runbook

This is an authorized Railway-console procedure for a customer-controlled public-booking subdomain. It does not modify customer DNS, call Railway APIs, inspect TLS automatically, publish a tenant, or change the canonical BookNowTech fallback.

## Preconditions

1. Use staging first. Confirm the deployed immutable commit and that `ENVIRONMENT_ID`, `MONGODB_DATABASE`, `BOOKING_ROOT_DOMAIN`, and `RAILWAY_ENVIRONMENT_NAME` are the approved staging pair.
2. Confirm `{tenant-slug}.staging.booknowtech.com` works before every lifecycle action.
3. Set `PROVISIONING_APPROVED=true`, `PROVISIONING_OPERATOR_ID`, and a specific 10–500 character `PROVISIONING_REASON` in the authorized Railway console. Generate a new lowercase UUID request ID for each intended action.
4. Use only a customer-controlled subdomain. Apex/root domains, platform domains, wildcards, administrative hosts, URLs, ports, and IP addresses are refused.

Examples below use `booking.customer.example`, tenant `customer`, and unique placeholders for request IDs.

## Issue and publish the challenge

```sh
pnpm --filter @booknowtech/api booking-domain -- issue-challenge --tenant customer --hostname booking.customer.example --request-id <lowercase-uuid>
```

Give the customer only the returned record:

```text
Name:  _booknowtech.booking.customer.example
Type:  TXT
Value: booknowtech-verification=<returned-token>
```

The token is shown once. BookNowTech stores only its environment/tenant/hostname-bound SHA-256 digest. If output is lost, replaying the request reports that the token is unavailable; issue a replacement with a new request ID. Replacement immediately invalidates the old token and any prior ownership verification.

The unverified challenge expires after 72 hours. Do not extend it; issue a replacement. Successful verification clears the challenge expiry and remains valid until replacement, completed removal, or separately authorized future reassignment.

## Verify DNS ownership

After the customer reports publication, independently view the TXT answer with an approved DNS inspection tool, then run:

```sh
pnpm --filter @booknowtech/api booking-domain -- verify --hostname booking.customer.example --request-id <lowercase-uuid>
```

Not-found, mismatch, and temporary resolver failures never activate the hostname and never disrupt fallback. Retry lookup with a new request ID. After `verified`, confirm the custom hostname still renders unavailable and fallback still works.

## Manual Railway attachment and operator attestation

PR 13B does not query Railway. In the correct Railway environment, the operator must manually:

1. Attach exactly `booking.customer.example` to the public frontend service.
2. Compare Railway's mapping target/reference with the requested hostname and correct environment.
3. Confirm Railway reports the domain mapping ready and traffic reaches the expected staging service.
4. In a browser or an independent TLS tool, confirm a valid, hostname-matching, currently valid certificate chain is served.
5. Confirm HTTPS, HSTS, CSP, and the established security headers are present.
6. Confirm the hostname remains unavailable before BookNowTech activation and the canonical fallback remains operational.

Only after those manual checks record the mapping reference:

```sh
pnpm --filter @booknowtech/api booking-domain -- begin-provisioning --hostname booking.customer.example --operator-attested-railway-mapping-reference <railway-reference> --request-id <lowercase-uuid>
```

Then explicitly attest both observations and activate:

```sh
pnpm --filter @booknowtech/api booking-domain -- activate --hostname booking.customer.example --operator-attested-railway-status ready --operator-attested-tls-status ready --request-id <lowercase-uuid>
```

The flags mean the named operator performed the checks above. They do not mean the application queried Railway or inspected TLS. CLI, operation-record, and audit result fields retain the `operator_attested` label.

## Activation QA

Confirm the custom hostname resolves only the intended tenant. Exercise booking, confirmation email, management link, reschedule, cancellation, and released-slot reuse. Confirm the canonical fallback remains operational, unknown hosts remain unavailable, and the administrative hostname remains Business Hub-only. Inspect operation/audit evidence by request ID and confirm it contains no challenge plaintext, hash, raw DNS response, credentials, or infrastructure error detail.

## Deactivate and remove

Deactivation is the immediate operational rollback and does not unpublish the tenant:

```sh
pnpm --filter @booknowtech/api booking-domain -- deactivate --hostname booking.customer.example --request-id <lowercase-uuid>
```

Confirm the custom hostname is unavailable and newly created notification origins use fallback. Previously queued notification origins remain unchanged by design.

Begin removal:

```sh
pnpm --filter @booknowtech/api booking-domain -- begin-removal --hostname booking.customer.example --request-id <lowercase-uuid>
```

Manually remove the exact mapping from the correct Railway environment. Confirm it is absent, then persist completion:

```sh
pnpm --filter @booknowtech/api booking-domain -- complete-removal --hostname booking.customer.example --request-id <lowercase-uuid>
```

Completion clears Railway/TLS observations and invalidates ownership verification. Confirm fallback remains available.

## Replay and failure safety

- Repeating an identical request ID and identical inputs returns persisted evidence without another mutation.
- Reusing a request ID with changed input returns `request_id_mismatch`.
- A new request ID against an already achieved state succeeds only when its hostname and supplied evidence agree; it records a no-op operation/audit event.
- Never bypass a refused transition with direct database updates.
- Never place tokens, hashes, raw DNS answers, database errors, or credentials in reasons, tickets, or QA evidence.
- Escalate unexpected cross-environment claims, tenant reassignment, apex/root requests, or uniqueness conflicts; they are not PR 13B procedures.

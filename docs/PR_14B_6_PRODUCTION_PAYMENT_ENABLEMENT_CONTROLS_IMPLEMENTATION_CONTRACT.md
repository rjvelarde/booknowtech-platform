# PR 14B.6 — Production Payment Enablement Controls Implementation Contract

## Purpose and stop gate

PR 14B.6 closes only the production-release blockers identified after PR 14B.5. It does not
redesign payment execution, enable production payments, add a customer-facing feature, or begin
PR 14C. Production payment execution remains disabled until the separate final release-candidate
review and explicit owner approval.

## Approved scope

1. Publicly proxy the existing `POST /webhooks/stripe/platform` and
   `POST /webhooks/stripe/connect` API routes without changing their paths or raw-body contract.
2. Add a restricted BookNowTech operator command for immutable tenant booking-fee activation.
3. Add a restricted operator command for immutable service payment-configuration activation.
4. Add a restricted operator command for tenant payment-execution enablement and disablement.
5. Add one production payment operations runbook.

## Webhook proxy contract

Only the two exact webhook paths are proxied, and only for `POST`. Method, content type, Stripe
signature header, and exact request bytes pass through unchanged. Untrusted forwarded headers are
removed and the canonical client-IP header is set using the existing trusted-proxy policy. Unknown
webhook paths and unsupported methods remain outside the API proxy and fail safely. Existing
`/api/*`, readiness, hostname, CSP, HSTS, and CORS behavior is unchanged.

## Operator authorization contract

Every mutation requires a named BookNowTech operator, a reason, a lowercase UUID request ID,
explicit approval, and the existing environment/database pairing guard. The command accepts only
public tenant/service identifiers. It derives a canonical request fingerprint and request-ID hash,
and persists a durable operation record in the same MongoDB transaction as the mutation and audit
event.

An exact request-ID replay returns the original approved result without creating another version or
audit event. Reusing the request ID with changed inputs is a conflict. Concurrent identical requests
converge on one operation; concurrent changed requests do not partially apply.

## Mutation contracts

Tenant booking fees are fixed nonnegative integer USD cents. Each successful request creates an
immutable version and atomically moves the active pointer. Percentage inputs are not accepted.
Prior versions and historical attempts or ledger entries are never mutated or recalculated.

Service payment configuration supports only `none`, `fixed_deposit`, and `full`. Existing
normalization remains authoritative: zero deposit maps to `none`, a deposit equal to service price
maps to `full`, an above-price deposit is rejected, and zero-priced services use `none`. Each change
creates an immutable version and atomically moves the active pointer.

Tenant payment execution supports only explicit `enable` and `disable`. It is tenant-level
authorization and never overrides `STRIPE_PAYMENT_EXECUTION_ENABLED` or any existing readiness
predicate. Disabling it stops new paid attempts without stopping webhook ingestion, finalization,
expiry, reconciliation, or other processing for existing financial objects.

## Persistence and audit

`payment_configuration_operations` records operation type, environment, request ID, canonical
fingerprint, operator, reason, target public identifiers, outcome, bounded result, and timestamps.
It is unique by request ID. Existing immutable fee and service configuration collections remain the
sources of historical configuration truth. Tenant execution settings remain the current tenant
authorization state. Audit evidence is appended transactionally and contains no secret or customer
payment credential.

## Verification gate

Release requires authorization, replay/conflict, transaction, and Mongo concurrency coverage;
actual Docker/Caddy proxy coverage including signed raw-body verification; canonical API/proxy and
security regression coverage; pinned verification; real replica-set integration; secret scanning;
staging deployment; real Stripe test webhook delivery through the staging hostname; one approved
staging tenant/service configuration lifecycle; and proof that the environment kill switch remains
independently authoritative.

## Explicit exclusions

No refund execution, automatic refunds, new payment method, payment-domain redesign, tax, tip,
discount, coupon, surcharge, payout control, subscription, invoice, generic support UI,
customer-managed payment configuration, production payment enablement, or PR 14C functionality is
authorized.

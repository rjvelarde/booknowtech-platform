# PR 14A — Stripe Connect Foundation Implementation Contract

## Approved outcome

PR 14A adds US-only Stripe Connect Express onboarding, immutable BookNowTech Connect Terms acceptance, webhook-authoritative account readiness, durable signed webhook processing, tenant isolation, audit evidence, monitoring, and rollout controls. It does not make a booking payable or move money.

## Hard exclusions

PR 14A must not create a financial-ledger collection or implement PaymentIntents, Charges, Checkout Sessions, payment methods, authorization, capture, deposits, balances, application fees, the historical $10 fee, refunds, transfers, payouts, subscriptions, invoices, tax, financial reporting, disputes, or appointment transitions based on payment.

A later reviewed payment-execution contract must define the concrete append-only, tenant-scoped financial ledger. Direct connected-account charges and optional `application_fee_amount` remain future architectural constraints only.

## BookNowTech acceptance boundary

BookNowTech Connect Terms acceptance is stored as an immutable `booknowtech_connect_terms_acceptances` record keyed by tenant and terms version. It includes the accepting user and membership, request, timestamp, IP hash, and exact terms-text hash. It never represents Stripe-hosted terms, identity verification, onboarding completion, or account readiness.

## Connect and tenant boundary

- Express, US, and one active account per tenant.
- Only a selected `tenant_owner` or `tenant_admin` may accept terms or start/resume onboarding.
- Tenant authority comes only from the authenticated selected membership.
- Account Links use server-generated canonical Business Hub return and refresh URLs.
- Browser returns are informational; signed webhooks are authoritative.
- Tenant suspension blocks user operations but not webhook ingestion or processing.

## Persistence

PR 14A adds only:

- `booknowtech_connect_terms_acceptances`
- `tenant_stripe_accounts`
- `stripe_connect_operations`
- `stripe_webhook_events`

Stripe event IDs and Stripe account IDs are globally unique. All application reads and writes of tenant-owned data include `tenant_id`. Events retain an allowlisted sanitized projection rather than unrestricted raw payloads.

## Webhooks and worker

`/webhooks/stripe/platform` and `/webhooks/stripe/connect` verify their distinct secrets against the exact bounded raw request bytes. Verified events are durably deduplicated before a prompt success response. The worker atomically claims events, applies monotonic account readiness, writes audit evidence, and marks processing complete in one MongoDB transaction. Stale claims are recoverable and transient failures use bounded retry.

PR 14A processes `account.updated` and the supported deauthorization event only. All payment and money-movement event types are recorded as unsupported and have no domain effect.

## Rollback

After webhook registration, setting `STRIPE_CONNECT_FOUNDATION_ENABLED=false` is the primary rollback. It disables terms/onboarding/Account Link actions while webhook ingestion and processing remain operational.

A full rollback to a pre-Stripe SHA removes the webhook endpoints and cannot process events. Stripe delivery failures and retries are expected until a compatible PR 14A release is restored or an approved incident action changes endpoint delivery. Collections and evidence are never dropped as rollback.

## Release gate

Migration convergence, immutable acceptance, role and tenant isolation, exact raw-body signature verification, duplicate/out-of-order webhook convergence, stale-claim recovery, secret redaction, feature-disable behavior, and absence of forbidden payment APIs must be proven before the staging gate is approved.

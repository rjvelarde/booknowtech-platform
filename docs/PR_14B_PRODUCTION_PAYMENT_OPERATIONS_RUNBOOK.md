# PR 14B production payment operations runbook

Production payment execution is off by default. Nothing in this runbook authorizes a live payment.
Record the approved SHA, tenant, service, operator, primary operations owner, backup owner, approval,
time window, rollback owner, and evidence location before changing configuration.

## Required owner record

- Primary payment operations owner: Robert Velarde
- Backup payment operations owner: Allan Miranda
- Operating-hours timezone: `America/New_York`
- Operating days: Monday through Friday
- Holiday calendar: U.S. federal holidays excluded
- Highest-priority escalation channel: telephone call to `843-324-3301`
- Secondary escalation channel: email; no address is recorded because none has been approved
- Same-business-day manual-review queue owner: Robert Velarde

Do not enable production execution until every placeholder above has an approved value.

## Production configuration matrix

Never paste values into tickets, logs, screenshots, command history, or this runbook.

| Service      | Variable                                   | Kind              | Required state before live execution  |
| ------------ | ------------------------------------------ | ----------------- | ------------------------------------- |
| API + worker | `STRIPE_SECRET_KEY`                        | secret            | Same approved `sk_live_…` credential  |
| API          | `STRIPE_PUBLISHABLE_KEY`                   | public client key | Matching `pk_live_…` key              |
| API          | `STRIPE_PLATFORM_WEBHOOK_SECRET`           | secret            | Live platform endpoint secret         |
| API          | `STRIPE_CONNECT_WEBHOOK_SECRET`            | secret            | Distinct live Connect endpoint secret |
| API          | `STRIPE_CONNECT_COUNTRY`                   | non-secret        | `US`                                  |
| API          | `BOOKNOWTECH_CONNECT_TERMS_VERSION`        | non-secret        | Approved published version            |
| API          | `BOOKNOWTECH_CONNECT_TERMS_TEXT_SHA256`    | integrity hash    | Exact approved terms hash             |
| API          | `STRIPE_ACCOUNT_READINESS_MAX_AGE_SECONDS` | non-secret        | Approved bounded age, 60–86400        |
| API + worker | `BOOKNOWTECH_PAYMENT_TERMS_VERSION`        | non-secret        | Identical approved version            |
| API + worker | `BOOKNOWTECH_PAYMENT_TERMS_TEXT_SHA256`    | integrity hash    | Identical approved hash               |
| API          | `PAYMENT_IP_HASH_SECRET`                   | secret            | Unique environment-specific secret    |
| API          | `CHECKOUT_RECOVERY_TOKEN_SECRET`           | secret            | Unique environment-specific secret    |
| API          | `STRIPE_PAYMENTS_FOUNDATION_ENABLED`       | flag              | `true` only for approved onboarding   |
| API          | `STRIPE_PAYMENT_EXECUTION_ENABLED`         | kill switch       | `false` until final enablement        |

## Public Stripe endpoints and registration

Register live Stripe webhook endpoints only after an unsigned POST to each public URL reaches the
API signature boundary and fails with the bounded invalid-signature response:

- `https://admin.booknowtech.com/webhooks/stripe/platform`
- `https://admin.booknowtech.com/webhooks/stripe/connect`

The Connect endpoint must listen to events on connected accounts. Subscribe only to:

- `account.updated`
- `account.application.deauthorized`
- `payment_intent.succeeded`
- `payment_intent.payment_failed`
- `payment_intent.processing`
- `payment_intent.canceled`
- `charge.refunded`
- `refund.updated`
- `charge.dispute.created`
- `charge.dispute.updated`
- `charge.dispute.closed`

Keep platform and Connect signing secrets distinct. Deliver one approved non-financial test event,
confirm one stored event/projection and green monitoring, then confirm redelivery is idempotent.

## First tenant and Connect onboarding

1. Provision the explicitly approved tenant using the audited PR 12.5B command and production
   checklist. Verify active status, fallback hostname, owner login, service, provider assignment,
   availability, and existing unpaid booking behavior.
2. With payment execution still false, set `STRIPE_PAYMENTS_FOUNDATION_ENABLED=true` and deploy the
   exact approved SHA.
3. The tenant owner accepts the exact Connect terms and completes Stripe Express onboarding.
4. Wait for signed `account.updated` processing. Confirm exactly one active association, US/USD,
   details submitted, charges enabled, active card-payments capability, no current/past-due
   requirements, no disconnection, and readiness within the configured maximum age.

## Audited payment configuration commands

Run only in the Railway API console. For every command set a named operator, a reason of at least ten
characters, and explicit approval. Generate a new lowercase UUID per materially new request. Reuse
the same request ID only to replay the exact same request.

```sh
export PAYMENT_CONFIGURATION_OPERATOR_ID="<approved.operator>"
export PAYMENT_CONFIGURATION_REASON="<approved reason naming tenant and change>"
export PAYMENT_CONFIGURATION_APPROVED=true
```

Activate a fixed tenant booking fee in USD cents:

```sh
pnpm --filter @booknowtech/api payment-configure -- \
  set-booking-fee --request-id "<uuid>" --tenant "<slug>" --amount-minor 125
```

Activate service payment configuration:

```sh
pnpm --filter @booknowtech/api payment-configure -- \
  set-service-config --request-id "<uuid>" --tenant "<slug>" \
  --service-public-id "<uuid>" --mode fixed_deposit --fixed-deposit-minor 2500
```

Allowed modes are `none`, `fixed_deposit`, and `full`. For `none` and `full`, omit
`--fixed-deposit-minor`. Zero deposit normalizes to `none`; deposit equal to price normalizes to
`full`; above-price deposit is refused.

Enable or disable tenant authorization:

```sh
pnpm --filter @booknowtech/api payment-configure -- \
  set-tenant-execution --request-id "<uuid>" --tenant "<slug>" --status enabled
```

Tenant enablement never overrides the environment kill switch or readiness predicates. Configure
fee and service first, then tenant authorization, and leave the environment switch false until the
final gate.

## Monitoring gate

Before enablement, authenticated `/api/internal/monitoring` must report the exact API/worker SHA,
fresh worker heartbeat, and zero actionable webhook failures, expiry candidates, reconciliation
pending/processing, `succeeded_unfinalized`, manual review, local-finalization failure, and retry
exhaustion. Preserve acknowledged historical evidence.

Disable new execution immediately for a missing/stale heartbeat, SHA divergence, webhook delivery
failure, growing processing backlog, any paid-but-unfinalized case, attribution/amount mismatch,
unexpected manual review, retry exhaustion, or inability to observe Stripe and BookNowTech.

## Controlled first live payment

Use one approved tenant, one service, one provider, and one controlled customer. For the canonical
example configure a $55.00 service, $25.00 fixed deposit, and $1.25 tenant fee. Confirm the UI shows
$26.25 due now, a $1.25 BookNowTech fee, and a $30.00 informational remainder. Have the primary and
backup operators watch Stripe Dashboard and canonical monitoring, then set
`STRIPE_PAYMENT_EXECUTION_ENABLED=true`.

Verify exactly one connected-account PaymentIntent, `amount=2625`, `application_fee_amount=125`, no
transfer, one attempt, one provisional appointment transitioning to `scheduled`, immutable ledger
evidence, one management token, one BookNowTech confirmation, and a Stripe-owned receipt. Disable
new execution after the approved transaction if the authorization was one-payment-only.

## Charged but not booked / manual review

Immediately disable new execution. Do not create a replacement booking, release the slot, refund,
or mark the appointment scheduled by hand. Record attempt, PaymentIntent, tenant, appointment,
request, correlation, and Stripe event public identifiers only. Confirm the worker and webhook
state, allow bounded reconciliation, and use the audited reconciliation requeue only after human
investigation. `succeeded_unfinalized` is highest priority with a one-hour target during published
operating hours. Other manual review is same-business-day. Escalation deadlines never mutate money.

## Refunds and disputes

BookNowTech cannot initiate refunds. An authorized tenant operator performs an approved refund in
the connected Stripe Dashboard. Confirm signed refund evidence arrives; do not infer appointment
cancellation. Unexpected, partial, failed, or policy-mismatched refunds remain manual review.

The connected tenant is merchant and owns dispute handling in Stripe Dashboard. BookNowTech
preserves signed evidence, alerts operations/merchant, and tracks escalation. It does not submit
evidence or move money automatically.

## Outages and delayed webhooks

- **Stripe outage:** disable new execution; preserve in-flight objects; do not infer failure from a
  timeout. Keep worker/API running and reconcile after recovery.
- **Worker outage:** disable new execution, restore the exact compatible worker SHA, verify a fresh
  heartbeat, drain signed events and reconciliation, then review every in-flight attempt.
- **Webhook delay/failure:** disable new execution when delivery is not dependable. Keep endpoints
  and signing secrets active, restore delivery, redeliver from Stripe, prove deduplication, drain the
  queue, and inspect monitoring before re-enable.

## Kill switch and compatible rollback

Set API `STRIPE_PAYMENT_EXECUTION_ENABLED=false` first. Verify new paid attempts and confirmation
setup are refused. Do not remove Stripe keys/secrets, unregister webhooks, stop the worker, delete
objects, or rewrite evidence. Webhook processing, finalization, expiry, retrieval, permitted
cancellation, reconciliation, refund/dispute evidence, and monitoring must continue.

After any live PaymentIntent exists, keep a PR 14B-compatible API and worker active until all
financial objects converge. Do not deploy a pre-14B processor unless another compatible processor
remains active. Migrations are additive; rollback requires no destructive migration.

## Sanitized evidence checklist

- approval, SHA, deployment IDs, tenant/service public IDs, named operators, and timestamps;
- redacted variable-presence matrix and Stripe endpoint/event registration screenshots;
- Connect readiness projection and test-event/redelivery evidence;
- configuration command request IDs, returned versions, operation IDs, and audit evidence;
- pre/during/post monitoring snapshots;
- PaymentIntent, charge, application-fee, attempt, appointment, ledger, token, notification, refund,
  dispute, and reconciliation public identifiers as applicable;
- kill-switch and rollback verification.

Exclude secrets, client secrets, raw webhook bodies, card/payment-method data, raw idempotency keys,
customer contact data, full Stripe objects, database connection strings, and unredacted logs.

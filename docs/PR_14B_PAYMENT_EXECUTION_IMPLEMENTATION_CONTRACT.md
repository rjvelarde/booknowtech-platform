# PR 14B — Payment Execution Implementation Contract

**Status:** Accepted — implementation authorized

**Reviewed baseline:** merged `main` at `8845b7ac2996f95f8ea6342ea362f2c7f0e64dbe`
**Scope:** the smallest safe online booking-payment increment built on PR 14A

## 1. Owner decisions and stop gate

All identified owner decisions now have a recorded answer. Payment-execution code, schema migrations, Stripe API calls, payment UI, and payment-event processing must still not begin until the complete contract is reviewed and formally approved for implementation.

### 1.1 Approved booking-fee decision

Decisions 1 and 2 are resolved as follows:

- BookNowTech supports one fixed customer booking fee in integer minor units per tenant.
- The configured amount may differ by tenant, for example `100` ($1.00 USD), `125` ($1.25 USD), or another explicitly approved amount in that tenant's currency.
- PR 14B does not support percentage booking fees. No percentage, basis-point, multiplier, or calculated booking-fee configuration is accepted or persisted.
- Each fee configuration is versioned and immutable. A change creates a new version; it never overwrites the prior version.
- Every payment attempt snapshots the exact fee amount, currency, configuration version, and stable configuration public identifier used for its calculation.
- Fee configuration changes are audited with the authorized BookNowTech operator, prior and new configuration public identifiers/versions and amounts, affected tenant, request/correlation identifier, and timestamp.
- Only an authorized BookNowTech operator workflow may create or activate a tenant fee version. Tenant membership roles, including `tenant_owner` and `tenant_admin`, do not grant mutation authority.
- Tenant owners/admins may receive read-only access to their tenant's active fee through an explicitly approved view. They may not create, edit, activate, schedule, or retire a fee version.
- A newly activated fee applies only to payment attempts created after activation. Existing and in-progress attempts retain their snapshotted fee version and amount.
- Historical payment attempts and ledger entries are never recalculated, rewritten, or deleted because a tenant fee changes.
- Existing `services.booking_fee_minor` values remain legacy catalog display facts and are not authoritative for PR 14B payment execution. They must not silently seed or override the operator-controlled tenant fee.

The economic treatment of Stripe processing fees and booking-fee refundability are recorded in Section 1.2.

### 1.2 Recorded payment-execution decisions

The following decisions resolve Decisions 3–20. They complete the owner-decision set but do not, by themselves, authorize implementation:

- **Stripe processing fees (Decision 3):** the tenant/provider bears Stripe processing fees. PR 14B adds no customer card surcharge and does not increase the customer total to recover or estimate Stripe processing costs.
- **Payment modes (Decision 4):** a service supports exactly `none`, `fixed_deposit`, or `full`. `none` creates no online payment attempt. `fixed_deposit` uses an integer-minor-unit deposit. `full` charges the approved full amount under the final amount formula.
- **Deposit configuration (Decision 4):** deposits are service-level, fixed integer minor units, versioned, audited, and snapshotted into each payment attempt. PR 14B supports no percentage deposits and accepts no percentage, basis-point, multiplier, or deposit-rounding configuration.
- **Deposit boundaries (Decision 4):** a valid `fixed_deposit` is greater than zero and strictly less than the service price. A configured zero amount maps to `none`; an amount equal to the service price maps to `full`; an amount greater than the service price is invalid and cannot be activated or used for a payment attempt.
- **Booking-fee refundability (Decision 5):** the BookNowTech booking fee is normally non-refundable for a customer-initiated cancellation. It is refundable for provider cancellation or a BookNowTech/payment-system unwind. This policy is recorded and snapshotted as applicable, but PR 14B does not execute the refund.
- **Cancellation/refund separation (Decision 6):** PR 14B does not execute cancellation-driven refunds. Appointment cancellation and financial refund are separate state transitions. A cancelled appointment must not be represented as financially refunded unless a distinct future refund transition succeeds.
- **Partial refunds (Decision 7):** partial refunds are unsupported in PR 14B.
- **Disputes and chargebacks (Decision 8):** the connected tenant/provider is the merchant and is financially responsible for disputes and chargebacks. BookNowTech records the event, alerts the responsible parties/operations, and preserves bounded evidence, but PR 14B does not automate dispute handling or evidence submission.
- **Stripe success/local failure (Decision 9):** automated reconciliation retries local finalization first. An attempt that cannot be finalized through the approved automated policy transitions to manual review; it is not silently treated as failed, duplicated, or attributed to another tenant.
- **Failed or abandoned attempts (Decision 10):** the payment-pending slot hold lasts exactly 15 minutes. Within that hold, the customer may retry using the same durable payment attempt and the same PaymentIntent where Stripe state and the approved retry policy allow. A retry does not create another appointment or PaymentIntent.
- **Expiry (Decisions 10 and 17):** when the 15-minute hold expires without payment success, the slot is released exactly once through an idempotent terminal transition. Expiry, worker retry, webhook redelivery, or concurrent cleanup cannot release or transition it twice.
- **Provisional evidence retention (Decision 10):** failed or expired provisional customer and payment-attempt evidence is retained for idempotency, reconciliation, and audit. It must not be represented in APIs, UI, notifications, reporting, or lifecycle semantics as a successfully established booking/customer relationship.
- **Payment terms (Decision 11):** the public customer accepts a separate approved BookNowTech payment-terms version/hash at checkout. Each paid attempt stores immutable version, SHA-256 document hash, server acceptance timestamp, and bounded request/attempt evidence. Tenant Connect terms acceptance remains separate and does not satisfy customer payment-terms acceptance.
- **Currency (Decision 12):** PR 14B supports USD only. All amounts are integer USD cents; there is no FX or multi-currency conversion.
- **Capture model (Decision 13):** immediate capture only. PR 14B does not implement separate authorization and later capture.
- **Attempt immutability and invalidation (Decision 14):** every payment attempt is an immutable snapshot. A change to service price, deposit rule/version, connected Stripe account, payment terms version/hash, provider, date, time, duration, or any other authoritative booking fact refuses continuation, terminally marks the stale attempt, releases its slot exactly once, and requires a new attempt. A tenant booking-fee change does not invalidate an existing attempt; that attempt retains its snapshotted fee version and amount.
- **Refund authority and scope (Decision 15):** refund initiation is outside PR 14B. When a refund workflow is implemented, its initial authority is limited to `tenant_owner` and `tenant_admin` unless a separately reviewed decision approves another role. No current appointment-cancellation permission implies refund authority.
- **Payment methods (Decision 16):** cards only. Asynchronous bank methods and other non-card payment methods are unsupported.
- **Unsupported amount components (Decision 18):** taxes, tips, discounts, coupons, and surcharges are explicitly unsupported. They are not accepted as request inputs, inferred, calculated, persisted as financial components, or sent to Stripe.
- **Receipts and confirmation (Decision 19):** Stripe owns payment-receipt delivery using the paid booking customer's email supplied on the PaymentIntent. BookNowTech owns and sends the booking confirmation only. The confirmation displays the service price, amount paid online, BookNowTech booking fee, and remaining informational service balance; it does not present the remaining amount as a BookNowTech-tracked receivable or proof of an off-platform payment. BookNowTech sends no duplicate payment receipt.
- **Reconciliation ownership (Decision 20):** BookNowTech operations owns reconciliation and manual-review cases. Bounded recovery runs immediately and at approximately 1, 5, 15, and 30 elapsed minutes before manual review. Payment-success/local-finalization failure alerts immediately, is highest priority, and targets resolution within one hour during operating hours. Other manual-review cases target the same business day.

### 1.3 Remaining unresolved decisions

None identified. Decisions 1–20 now have recorded answers.

The complete document has been reconciled with these decisions, reviewed for internal consistency, and accepted for implementation. Runtime and tenant/service execution flags remain disabled by default and are enabled only through the release gates in this contract.

## 2. Repository-grounded starting point

The merged baseline establishes these facts:

- Express connected accounts are tenant-scoped in `tenant_stripe_accounts`, with one active association per tenant.
- The application resolves Stripe account identifiers from tenant persistence; clients do not select an account.
- `StripeConnectAdapter` permits account creation, Account Links, account retrieval, and webhook verification only. It exposes no PaymentIntent, Charge, Refund, transfer, or application-fee operation.
- Platform and Connect webhook endpoints use distinct secrets, exact raw bytes, event-ID deduplication, allowlisted projections, and asynchronous worker processing.
- Payment and money-movement events are currently unsupported and have no domain effect.
- Public booking requires a tenant-scoped UUID idempotency key. Its hash and canonical request fingerprint are stored on the successfully created appointment. Same key/same fingerprint replays; changed parameters fail with `409`.
- Customer and appointment creation occur in one MongoDB transaction under provider/day schedule locks. The appointment is immediately `scheduled`; confirmation notification intent is inserted in the same transaction.
- Appointment snapshots contain `base_price_minor`, `booking_fee_minor`, and `currency`, but the contracts call them historical display facts, not financial calculations.
- Services and tenants are currency-consistent; existing code does not define deposits, fee allocation, taxes, refunds, settlement, or a financial ledger.
- Notification outbox records snapshot an approved public booking origin. Existing verified custom domains may be preferred and the canonical tenant hostname is the fallback.
- `STRIPE_PAYMENTS_FOUNDATION_ENABLED` controls customer-triggered Connect setup, not payment execution. Webhook ingestion and processing remain live when it is false.

PR 14B must extend these systems. It must not build a parallel booking, customer, scheduling, notification, tenant-resolution, or Stripe integration stack.

## 3. Approved smallest safe increment

PR 14B is limited to:

1. US and USD only.
2. Public bookings only; no Business Hub card entry.
3. Stripe PaymentIntents created as direct charges on the tenant's active Express account.
4. Service payment modes `none`, `fixed_deposit`, and `full`; deposits are fixed integer USD cents only.
5. The tenant's fixed, snapshotted BookNowTech booking fee is collected as `application_fee_amount` on each paid direct charge.
6. Cards and immediate capture only.
7. No refund creation, partial refund, cancellation-driven refund, authorization/later-capture, or asynchronous payment method.
8. No off-platform remaining-balance ledger. After a deposit, BookNowTech records only what it processed and labels the service-price remainder as informational, not as an accounts-receivable balance.
9. For `payment_mode=none`, preserve the existing unpaid public-booking transaction and confirmation behavior. Create no payment attempt or PaymentIntent, charge no Stripe-based BookNowTech booking fee, and do not require Stripe execution readiness or BookNowTech payment-terms acceptance.
10. A zero-priced service must use `payment_mode=none`. PR 14B never creates a fee-only PaymentIntent.

For `fixed_deposit` and `full`, create a durable payment-pending booking record before calling Stripe. This gives Stripe success a stable local tenant, customer, appointment, pricing snapshot, and idempotent operation target. It avoids charging first and then discovering that no durable booking identity exists.

This scope is contractually fixed but is not implementation authorization until Section 20 is satisfied.

## 4. Architectural invariants

- The hostname resolver supplies public tenant context. No body, query parameter, arbitrary header, cookie, or browser value supplies tenant or Stripe-account authority.
- Every tenant-owned read and write includes `tenant_id`.
- The active Stripe account is resolved from `tenant_stripe_accounts` and snapshotted by internal association/public identifiers. A client-supplied `acct_…` value is rejected and never used.
- Application and route code do not call the Stripe SDK. New Stripe request construction and response reduction live behind the adapter boundary.
- The server is authoritative for service, price, fee, deposit, currency, connected account, terms, provider, duration, schedule, and appointment facts.
- Money is represented only in integer minor units. Floating-point money arithmetic is prohibited.
- Payment execution fails closed when configuration, terms, account readiness, price version, tenant state, or booking facts are missing or stale.
- Account readiness alone never authorizes an appointment charge.
- External Stripe success and MongoDB commit are never treated as atomic.
- Ledger entries and acceptance evidence are append-only. Correction uses compensating entries, never mutation or deletion of financial history.
- Stripe secrets, client secrets, payment-method data, full Stripe objects, raw webhook bodies, and unnecessary PII are not persisted or logged.
- Disabling new execution does not disable signed webhook ingestion, worker processing, reconciliation, expiry, or already-created attempt recovery.
- A booking retry cannot create a second PaymentIntent. A payment retry cannot create a second appointment.

## 5. Execution-readiness contract

Creating a payment attempt for `fixed_deposit` or `full` requires all of the following at the same server-side check. `none` bypasses this paid-execution gate and uses the existing unpaid flow:

1. `STRIPE_PAYMENT_EXECUTION_ENABLED=true` in the API environment.
2. The tenant is active and public booking is enabled for the resolved hostname.
3. The tenant has payment execution enabled in tenant configuration, with an approved configuration version.
4. The service is currently public-bookable and its snapshotted payment mode is `fixed_deposit` or `full`; `fixed_deposit` has an active service-level immutable version whose amount is greater than zero and strictly less than the service price.
5. The selected provider/service assignment and slot pass existing booking validation.
6. The tenant has exactly one active Stripe account association.
7. That association is not disconnected; `charges_enabled=true`; `capabilities.card_payments=active`; no blocking current/past-due requirement or disabled reason is present; and readiness is not older than the approved maximum age.
8. The tenant currency, service currency, Stripe account default currency, deposit configuration currency, and booking-fee currency are all USD.
9. The public customer explicitly accepted the exact approved BookNowTech payment-terms version and SHA-256 document hash for this checkout. The immutable attempt snapshot contains `version`, `document_sha256`, server `accepted_at`, `request_id`, payment-attempt public ID, public idempotency-key hash, and a secret-keyed IP hash. It contains no raw IP, raw idempotency key, full user agent, Stripe credential, or unbounded session data. Tenant Connect terms acceptance remains separate and does not satisfy this predicate.
10. The server can create an immutable pricing snapshot and deterministic request fingerprint using the formula in Section 6 and the exact service, deposit, fee, account, terms, provider, and booking-fact versions/identifiers.

If any predicate fails, no Stripe request occurs. Public errors remain bounded and must not reveal account IDs, capability detail, terms evidence, or internal configuration.

## 6. Locked amount contract

One canonical pure server function uses integer USD cents and returns:

```text
service_price_minor
payment_mode = fixed_deposit | full
fixed_deposit_minor | null
provider_amount_due_now_minor
booknowtech_fee_minor
customer_total_due_now_minor
application_fee_amount_minor
remaining_service_balance_minor
currency = USD
pricing_rule_version
deposit_rule_version | null
fee_rule_version
fee_configuration_public_id
```

The formula is:

```text
if payment_mode = fixed_deposit:
  provider_amount_due_now_minor = fixed_deposit_minor

if payment_mode = full:
  provider_amount_due_now_minor = service_price_minor

customer_total_due_now_minor =
  provider_amount_due_now_minor + booknowtech_fee_minor

PaymentIntent.amount = customer_total_due_now_minor
PaymentIntent.application_fee_amount = booknowtech_fee_minor

remaining_service_balance_minor =
  service_price_minor - provider_amount_due_now_minor
```

The direct charge is created on the connected tenant/provider account. The connected tenant/provider bears Stripe processing fees. BookNowTech does not add a customer card surcharge, estimate Stripe fees, or include Stripe processing fees in `customer_total_due_now_minor`. The remaining service balance excludes the BookNowTech booking fee and is informational only.

A valid fixed deposit is greater than zero and strictly less than the service price. Zero maps to `none`; an amount equal to the service price maps to `full`; an amount greater than the service price is invalid. Percentage deposits and all percentage-deposit calculation or rounding are unsupported. Taxes, tips, discounts, coupons, and surcharges are unsupported and contribute no amount.

For `payment_mode=none`, the paid formula is not invoked: no payment attempt or PaymentIntent is created, `application_fee_amount` is not sent, and no Stripe-based BookNowTech booking fee is charged. The existing unpaid appointment and notification behavior is preserved.

A zero-priced service is valid only with `payment_mode=none`. `fixed_deposit` and `full` are rejected for a zero-priced service, and PR 14B does not create a fee-only PaymentIntent.

### 6.1 Worked examples

| Service price | Mode                      | Provider due now | Booking fee | Customer charged now | Remaining service balance |
| ------------: | ------------------------- | ---------------: | ----------: | -------------------: | ------------------------: |
|       $100.00 | `fixed_deposit` ($25.00)  |           $25.00 |       $1.25 |               $26.25 |                    $75.00 |
|       $100.00 | `full`                    |          $100.00 |       $1.25 |              $101.25 |                     $0.00 |
|       $500.00 | `fixed_deposit` ($100.00) |          $100.00 |       $1.00 |              $101.00 |                   $400.00 |

The function rejects negative values, non-integers, non-USD currency, integer overflow, an invalid fixed-deposit boundary, a missing active fee snapshot, and a total outside Stripe's supported card-PaymentIntent amount bounds.

The canonical fingerprint includes every value above plus tenant, service, provider, start, customer input hash, connected-account association public ID, terms version/hash, and payment configuration version. A changed input cannot reuse the original BookNowTech or Stripe idempotency key.

## 7. Booking and payment state model

The state model extends the existing appointment workflow without treating Stripe status as appointment status.

### 7.1 Appointment booking state

```text
payment_pending -> scheduled
payment_pending -> payment_expired
payment_pending -> payment_failed
```

Existing `scheduled`, `cancelled`, `completed`, and `no_show` lifecycle behavior remains unchanged. A `payment_pending` appointment blocks the provider interval until its approved expiry. It is not a confirmed appointment, must not generate the existing appointment-confirmation notification, and must not be publicly manageable through the existing appointment token flow.

`payment_expired` and `payment_failed` are terminal provisional appointment statuses, not `cancelled` appointments and not successful bookings. Conflict queries block `payment_pending` and `scheduled`; the single idempotent transition to either terminal provisional status releases the slot exactly once. A recoverable card decline does not transition the appointment: it remains `payment_pending` until success, a terminal payment failure, or the 15-minute expiry. Existing reporting, customer relationship views, lifecycle APIs, notifications, and management-token issuance exclude all provisional and terminal payment-failure statuses from confirmed appointments.

### 7.2 Payment attempt state

```text
requested
stripe_creation_processing
requires_payment_method
requires_customer_action
processing
succeeded_unfinalized
succeeded
failed_recoverable
failed_terminal
expired
stale
manual_review
```

`failed_recoverable` may transition back to `requires_payment_method` or `requires_customer_action` on the same PaymentIntent during the unexpired hold. All other transitions are monotonic. `failed_terminal` and `expired` release the slot through exactly one appointment transition. Browser responses are advisory; signed webhooks and direct server retrieval during reconciliation are authoritative.

An authoritative booking/configuration mismatch transitions the attempt to terminal `stale`, refuses all continuation, cancels the PaymentIntent where Stripe permits, transitions the provisional appointment to `payment_failed`, and releases the slot exactly once. The client must submit a new idempotency key and create a new attempt from current facts. A Stripe success racing after committed staleness never revives or silently confirms the stale appointment; it enters highest-priority manual review. A tenant booking-fee version change is the sole configuration exception and leaves the existing attempt valid with its original fee snapshot.

### 7.3 Ordering

1. Resolve tenant and validate the bounded public request.
2. Hash the public idempotency key and calculate a canonical fingerprint using server-authoritative inputs.
3. Under the existing schedule locks and one MongoDB transaction, revalidate availability; create/reuse the customer; create one provisional appointment; append the initial ledger/operation facts; and create one payment-attempt record with an expiry. Do not enqueue confirmation.
4. After commit, create the direct-charge PaymentIntent through the Stripe adapter using the persisted operation and deterministic Stripe idempotency key.
5. Persist the reduced Stripe result. Return only the approved public identifiers and client secret over `Cache-Control: no-store`; never persist or log the client secret.
6. The browser confirms through Stripe.js using the connected-account context supplied by server-approved configuration, not user input.
7. A signed allowed webhook records the Stripe transition. The worker claims it and, in one MongoDB transaction, appends ledger evidence, transitions the payment attempt, changes the provisional appointment to `scheduled`, creates the audit event, creates/activates any management token, and enqueues exactly one confirmation notification.
8. Identical retries replay the persisted outcome. Recovery retrieves the PaymentIntent through the adapter when webhook ordering or local state is ambiguous.

The confirmation UI may poll/read the durable attempt for prompt feedback, but it must not make the browser response the source of truth.

## 8. Idempotency contract

- Preserve the required public UUID `Idempotency-Key` and tenant-scoped hash.
- The booking/payment operation has one durable canonical request fingerprint. It includes payment configuration and connected-account association, not only the legacy appointment request.
- Same tenant + key + fingerprint returns the original attempt/appointment result.
- Same tenant + key + changed fingerprint returns `409 idempotency_key_reused`; it never updates the old PaymentIntent.
- Keys are not reusable across tenants because tenant identity is part of both lookup and derivation.
- Stripe keys are deterministic, versioned, tenant-scoped, operation-specific, and derived from immutable local operation identity, for example `bnt_pi_v1_<tenant-public-id>_<attempt-public-id>` within Stripe's length limit.
- PaymentIntent creation and expiry cancellation use distinct Stripe idempotency namespaces. PR 14B has no capture or refund operation.
- A local operation record is committed before its first Stripe call. A crash after the call is recovered with the same Stripe key and parameters.
- A provisional appointment has exactly one active initial payment attempt in PR 14B. Any later replacement-attempt policy requires explicit review.

The existing appointment partial unique index is insufficient by itself because it represents successful public appointment creation. PR 14B requires a durable operation uniqueness boundary that exists before Stripe is called.

## 9. Persistence contract

Exact JSON-schema validators and indexes require approval, but the minimum model is:

### 9.1 `payment_attempts`

Tenant-scoped durable operation records containing:

- public ID, tenant ID, provisional appointment ID, and customer ID;
- active tenant-Stripe-association public ID and reduced Stripe account ID evidence;
- public idempotency-key hash, request fingerprint, and deterministic Stripe idempotency key;
- immutable pricing snapshot and customer payment-terms acceptance containing the exact version/hash/server timestamp and bounded request/attempt evidence from Section 5;
- reduced PaymentIntent ID and approved status fields;
- attempt status, failure category/code allowlist, expiry, retry/claim facts, timestamps, and correlation/request IDs; and
- no client secret, payment method details, raw Stripe object, billing details, or full webhook payload.

Required uniqueness includes global PaymentIntent ID, tenant + public idempotency hash, and tenant + provisional appointment active-attempt rules.

### 9.2 `payment_ledger_entries`

An append-only, tenant-scoped financial evidence collection. Each entry contains:

- public ID, tenant ID, appointment ID, payment-attempt ID;
- entry kind and immutable sequence/effective timestamp;
- USD and signed integer-minor-unit components for service price, provider amount due now, BookNowTech fee, customer total due now, application fee, and remaining informational service balance;
- source operation and Stripe object/event public identifiers;
- correlation/request IDs, actor where applicable, and bounded metadata;
- creation timestamp only; no general update path and no physical delete path.

Entry kinds distinguish at minimum intent requested, payment succeeded, recoverable payment failure, terminal payment failure, staleness, expiry, externally initiated full/partial refund evidence, refund failure/update, dispute/chargeback evidence, and reconciliation/manual-review transitions. PR 14B has no BookNowTech refund execution path, but signed refund events append financial evidence. Webhook duplicates cannot append duplicate logical entries.

### 9.3 Appointment additions

Appointments retain the booking-time service snapshot and add only bounded payment linkage/state. Do not overwrite historical catalog or payment snapshots when service configuration changes. Avoid embedding mutable ledger totals as the source of truth.

### 9.4 Tenant/service and operator-controlled fee configuration

Payment mode and fixed-deposit rules require explicit versioned configuration, optimistic concurrency, authorized tenant-role enforcement, validation, audit events, and disabled-by-default migration values. The only modes are `none`, `fixed_deposit`, and `full`. Strict validation rejects percentage fields and enforces the Section 6 deposit boundaries. Historical attempts reference the exact version they used.

Booking-fee configuration is a separate BookNowTech operator boundary. The persistence model must support immutable tenant-scoped fee versions with, at minimum:

```text
public_id
tenant_id
version
amount_minor
currency
activated_at
created_at
created_by_booknowtech_operator
request_id
```

The immutable fee-version record has no mutable `status`, `effective_to`, or amount field. A separate tenant-scoped active-fee pointer identifies exactly one active version. Activation of a new version atomically creates the immutable version, updates that pointer, and appends audit evidence; it does not mutate the prior fee-version record or any historical attempt or ledger entry. Fee amounts are nonnegative bounded integers and currency must equal the tenant currency. Percentage-related fields are rejected by strict validation.

Payment-attempt creation resolves the active fee inside the server-side execution transaction and snapshots `amount_minor`, `currency`, `version`, and `public_id`. A fee version that changes after an attempt is created does not invalidate or alter that attempt; a retry reuses its original snapshot. A genuinely new attempt uses the newly active fee.

Tenant owner/admin access, if exposed, is read-only and tenant-scoped. The fee mutation endpoint or command must require a distinct authorized BookNowTech operator control plane; selected tenant membership is neither necessary nor sufficient authority. Exact operator authentication and approval controls must be reviewed before implementing this workflow.

## 10. Stripe adapter contract

Extend the adapter with these narrow operations only:

- create direct-charge PaymentIntent on a resolved connected account;
- retrieve a PaymentIntent on that same resolved account;
- cancel an unconfirmed/cancellable PaymentIntent if required by expiry policy;
- verify/project the approved payment and dispute/chargeback webhook types.

The create operation always uses immediate capture, cards only, USD, `amount=customer_total_due_now_minor`, `application_fee_amount=booknowtech_fee_minor`, and `receipt_email` equal to the paid booking customer's validated email snapshot on the resolved connected account. Stripe owns receipt delivery. The adapter exposes no refund, partial-refund, separate authorization/capture, transfer, surcharge, tax, discount, coupon, tip, or asynchronous-payment-method operation in PR 14B.

Each method accepts server-built integer amounts, currency, reduced metadata, resolved account identity, and an operation-specific idempotency key. It returns an allowlisted view. Application persistence, tenant authorization, calculation, and state transition remain outside the adapter.

Direct-charge metadata should contain opaque public identifiers and schema version only. Do not place customer contact data, notes, addresses, raw idempotency keys, internal MongoDB IDs, or secrets in Stripe metadata.

## 11. Webhook contract

Keep the two endpoint boundaries and endpoint-specific secrets. For direct charges, payment events are expected on the connected-account destination and must carry an account attribution that resolves to exactly one active/historically valid tenant association.

The payment-state allowlist for immediate card confirmation is:

```text
payment_intent.succeeded
payment_intent.payment_failed
payment_intent.canceled
payment_intent.processing
charge.dispute.created
charge.dispute.updated
charge.dispute.closed
charge.dispute.funds_withdrawn
charge.dispute.funds_reinstated
refund.created
refund.updated
refund.failed
charge.refunded
```

`payment_intent.processing` is recorded as a nonterminal payment state and does not confirm the appointment. The dispute events record bounded evidence and alert BookNowTech operations and the connected merchant; they do not automate dispute handling or evidence submission. The refund events recognize refunds initiated directly in the connected tenant's Stripe Dashboard, append amount/currency/status/application-fee evidence, and never imply appointment cancellation. A partial refund, unexpected refund, failed refund, or application-fee allocation inconsistent with the snapshotted policy enters manual review. PR 14B still exposes no refund creation API, UI, or adapter method. Unsupported signed events may be durably classified without applying another domain transition.

For each accepted event:

1. Verify signature on exact raw bytes.
2. Enforce environment live/test mode.
3. Sanitize to an approved projection.
4. Resolve Stripe account and PaymentIntent to one tenant and one attempt.
5. Deduplicate globally by event ID and enforce source/account consistency on duplicate payloads.
6. Return promptly after durable ingestion.
7. Let the worker claim and apply an idempotent transition in a transaction.
8. Treat out-of-order delivery as normal; retrieve authoritative reduced state when order is ambiguous.

Unknown account, cross-tenant linkage, amount/currency mismatch, missing attempt, or incompatible terminal state goes to `manual_review` with an operational alert. It must never be guessed into a tenant or silently marked successful.

## 12. Failure, expiry, and reconciliation

- **Local transaction fails before Stripe:** nothing is charged and the existing transaction leaves no provisional customer/appointment.
- **Local commit succeeds; Stripe creation fails:** keep a recoverable attempt and provisional slot until the approved retry/expiry policy. Retry with the same Stripe key and immutable parameters.
- **Stripe creation succeeds; response is lost:** retrieve/recreate idempotently using the persisted operation; never create another intent.
- **Authoritative facts change:** before returning a reusable client secret, accepting a continuation/retry, or applying success, compare current authoritative service price, deposit version, connected-account association, payment-terms version/hash, provider, date/time/duration, and booking facts to the immutable fingerprint. On mismatch, atomically mark the attempt `stale`, refuse continuation, release the slot exactly once, and asynchronously cancel the PaymentIntent where permitted. A new attempt with a new idempotency key is required. A booking-fee version change is excluded from this comparison because the attempt retains its fee snapshot. A late Stripe success after staleness enters highest-priority manual review.
- **Recoverable card decline/PaymentIntent failure:** `payment_intent.payment_failed` is recoverable by default during the unexpired hold. Record the bounded failure category and keep the provisional appointment `payment_pending`. Retry the same durable attempt and PaymentIntent where Stripe permits. Do not create another appointment or intent and do not release the slot merely because a decline occurred.
- **Terminal payment failure:** a PaymentIntent that Stripe reports as `canceled`, or another explicitly allowlisted non-payable terminal state, transitions the attempt to `failed_terminal`, transitions the provisional appointment to `payment_failed`, and releases the slot exactly once. Failure-code text alone never invents a terminal state. Retain provisional customer, appointment, attempt, and ledger/audit evidence without representing a successful booking/customer relationship.
- **Payment succeeds; local finalization fails:** atomically record/retain `succeeded_unfinalized` as soon as signed success or authoritative retrieval is applied. Payment success supersedes the 15-minute expiry: keep the provisional slot blocked beyond the original hold while automated reconciliation retries local finalization. If automated recovery cannot converge, transition to `manual_review`, continue blocking the paid slot, and alert BookNowTech operations for highest-priority, same-business-day review. PR 14B performs no automatic refund.
- **Webhook is delayed/lost:** reconciliation retrieves nonterminal or overdue attempts through the adapter and converges local state.
- **Browser abandons/hold expires:** at the 15-minute deadline, the expiry worker first retrieves authoritative PaymentIntent state. If it has succeeded, success supersedes expiry and the slot remains blocked for finalization. Otherwise the worker cancels the PaymentIntent where permitted, transitions the attempt/appointment to expired, releases the provisional slot exactly once, and retains the provisional evidence under Section 1. If Stripe later reports success after a committed expiry/release, do not recreate or silently confirm the booking; transition the evidence to highest-priority `manual_review` and alert BookNowTech operations. PR 14B performs no automatic refund.
- **Account becomes restricted after intent creation:** stop new attempts; continue signed event processing and reconciliation for existing attempts.

Reconciliation must use indexed bounded batches, atomic claims, stale-claim recovery, bounded backoff, monitoring counts/oldest ages, and redacted logs. It may reuse the existing worker process but must not overload the account-readiness handler with unrelated transition logic.

The bounded recovery schedule is measured from the first finalization/reconciliation failure: attempt immediately, then at approximately 1, 5, 15, and 30 elapsed minutes. Scheduling jitter may vary each delayed attempt by at most 15 percent without changing ordering. Failure after the approximately 30-minute attempt transitions to `manual_review`. Payment-success/local-finalization failures alert BookNowTech operations immediately, receive highest priority, and target resolution within one elapsed hour when the alert occurs during documented BookNowTech operating hours. All other manual-review cases target resolution by the end of the same documented BookNowTech business day. The production runbook must publish the operating-hours timezone and business-day calendar before enablement; these targets drive monitoring/escalation and never cause an automatic refund or destructive state transition.

## 13. Public API and UI boundary

The existing `POST /api/v1/public/appointments` contract cannot simply start charging while preserving its current meaning. PR 14B must version or explicitly replace its response/state contract so success distinguishes:

- `none`: payment not required, no Stripe-based BookNowTech booking fee, and appointment scheduled through the existing unpaid flow;
- payment attempt created and customer action required;
- recoverable card failure with the same attempt still retryable during the hold;
- payment succeeded and appointment scheduled;
- terminal payment failure or expiry with the slot released; and
- temporary recovery/manual-review state.

The public request still cannot submit price, fee, currency, deposit, total, tenant, Stripe account, PaymentIntent ID, or authoritative terms/configuration. A client confirmation token is an ephemeral Stripe credential, not payment authority.

A zero-priced service is offered only as `none`. The server rejects `fixed_deposit` or `full` for it and never returns a fee-only client secret. Continuation of a stale attempt returns a bounded conflict requiring the browser to restart from current booking facts with a new idempotency key; the browser cannot reprice or mutate the old attempt.

UI requirements:

- for paid modes, disclose service price, provider amount due now, BookNowTech fee, total charged now, USD, remaining informational service balance, deposit meaning, and the snapshotted refundability/payment terms before card confirmation;
- for `none`, retain the existing unpaid disclosure and confirmation behavior, suppress legacy `services.booking_fee_minor` from the payment breakdown, and do not display or charge any Stripe-based BookNowTech booking fee;
- use Stripe.js/Payment Element so raw payment credentials do not touch BookNowTech servers;
- disable duplicate submission while retaining server idempotency;
- recover a refresh/retry from the same durable attempt and PaymentIntent during the unexpired hold where Stripe permits;
- never claim “booked” until local appointment state is `scheduled`;
- avoid exposing connected-account IDs, client secrets in URLs, logs, analytics, or browser storage; and
- preserve accessible errors, focus, keyboard operation, and mobile layout.

## 14. Notifications and origins

Reuse `notification_outbox`. The existing appointment confirmation is enqueued only when payment finalization changes the appointment to `scheduled`, never when the provisional record is created.

The BookNowTech booking confirmation must:

- have a stable logical uniqueness key;
- use the approved snapshotted public booking origin;
- use the canonical hostname fallback when a verified custom origin is unavailable;
- render from immutable bounded payment/appointment snapshots;
- display service price, amount paid online, BookNowTech booking fee, and remaining informational service balance for a paid booking;
- avoid client secrets and raw Stripe URLs; and
- avoid claiming receipt ownership, settlement, payout, off-platform payment, or accounts-receivable status.

Stripe owns payment-receipt delivery using the customer email passed as `receipt_email` on the connected-account PaymentIntent. BookNowTech sends no separate payment receipt in PR 14B. Payment links are absent from the Payment Element flow. For `none`, the existing unpaid confirmation template and behavior remain unchanged; legacy `services.booking_fee_minor` is not rendered as a PR 14B fee or payment-breakdown charge.

## 15. Feature flags and rollback

Add a distinct `STRIPE_PAYMENT_EXECUTION_ENABLED`, default false. It gates only creation of new payment attempts and customer-triggered payment confirmation setup.

Tenant/service payment modes are also disabled by default. Effective enablement requires both environment and tenant/service gates plus Section 5 readiness.

When execution is disabled:

- no new PaymentIntent is created;
- services configured as `fixed_deposit` or `full` fail closed as temporarily unavailable for new public booking; they never silently fall back to unpaid booking;
- services configured as `none` preserve the existing unpaid public-booking flow;
- signed webhook ingestion continues;
- event processing, finalization, expiry, reconciliation, dispute evidence/alerts, and manual-review work for existing attempts continue; and
- existing nonpayment appointment behavior remains unchanged.

Rollback disables new execution first. It does not delete Stripe objects, connected accounts, payment attempts, ledger entries, webhook events, appointments, audit records, or acceptance evidence. Redeploying a pre-14B release while live payment attempts or registered payment events exist is unsafe unless a compatible processing release remains available.

## 16. Permissions and audit

- Public guests may create/confirm only their hostname-scoped attempt using the durable public idempotency contract.
- Owner/admin may configure the versioned service payment mode and fixed deposit, but never the BookNowTech booking fee.
- Only the separately authorized BookNowTech operator workflow may create or activate a tenant booking-fee version.
- No role can initiate a refund in PR 14B. A future refund workflow begins with `tenant_owner` and `tenant_admin` authority unless separately approved.
- Staff appointment cancellation must not imply refund. The UI and API must state the separate payment outcome.

Audit events must cover configuration changes, attempt requested, PaymentIntent linked, recoverable/terminal/stale failure, payment finalized, expiry/release, signed external-refund evidence, dispute/chargeback evidence and alerting, and reconciliation/manual review. PR 14B emits no BookNowTech refund-request event because it has no refund operation. Booking-fee activation audit identifies the authorized BookNowTech operator and both the prior and new immutable fee versions and amounts. Audit records contain tenant, actor/source, appointment/attempt public IDs, bounded Stripe public IDs, request/correlation IDs, prior/new state, and timestamps. They exclude contact data, payment credentials, client secrets, raw webhook bodies, and full Stripe errors.

## 17. Migration and compatibility

The eventual migration must be additive, idempotent, and safe to rerun. It must:

1. create strict validators and indexes for payment attempts and append-only ledger entries;
2. add disabled-by-default tenant/service payment configuration and immutable operator-controlled tenant booking-fee versions;
3. extend appointment validation with `payment_pending`, `payment_failed`, and `payment_expired` while leaving every existing appointment unchanged;
4. extend webhook projections/statuses only for the locked payment event set and the final reviewed dispute/chargeback evidence allowlist;
5. add no synthetic payment history or retrospective financial backfill; and
6. preserve compatibility for existing unpaid appointments and existing PR 14A evidence.

Application rollback leaves additive evidence intact. No rollback migration drops financial or audit data.

## 18. Test and release gate

Implementation is not releasable without automated proof of:

- the exact Section 6 formula and all three worked examples;
- rejection of percentage booking-fee/deposit fields, deposit boundary mapping (`0 -> none`, `service price -> full`), and above-price rejection;
- zero-priced services requiring `none`, with no fee-only PaymentIntent;
- `none` preserving the existing unpaid flow with no payment attempt, PaymentIntent, displayed legacy/Stripe booking fee, or Stripe-based BookNowTech booking fee;
- operator-only fee mutation, tenant owner/admin read-only behavior, immutable version activation, attempt snapshotting, and historical non-recalculation;
- server-authoritative pricing and stale-configuration rejection;
- execution readiness and fail-closed behavior;
- tenant/account isolation, including forged/cross-tenant account and intent IDs;
- same-key replay, changed-fingerprint conflict, crash-after-Stripe-call recovery, and concurrent submission behavior;
- customer payment-terms acceptance snapshotting with exact version/hash/server timestamp/bounded evidence and separation from tenant Connect terms;
- every authoritative-change mismatch refusing continuation, terminally staling the attempt, canceling where permitted, requiring a new key/attempt, and releasing exactly once; fee-version changes alone retain the old attempt snapshot;
- exactly one provisional appointment and one PaymentIntent per logical booking;
- a recoverable decline retaining `payment_pending` and the slot during the 15-minute hold, same-attempt/PaymentIntent retry, and terminal failure/expiry releasing exactly once;
- signed raw-body verification on both webhook boundaries;
- event deduplication, out-of-order delivery, redelivery, account attribution, and worker stale-claim recovery;
- connected-account Dashboard full/partial/failed refund events appending financial evidence without changing appointment cancellation, with unexpected/partial/policy-mismatched allocation entering manual review;
- succeeded-but-unfinalized automated reconciliation followed by highest-priority same-business-day manual review, with no automatic refund;
- immediate/1/5/15/30-minute bounded reconciliation scheduling, immediate highest-priority alerting, one-hour operating-hours target for payment-success/local failure, and same-business-day target for other manual review;
- append-only ledger enforcement and duplicate-event uniqueness;
- confirmation/outbox creation exactly once and only after finalization;
- no secret/client-secret/payment credential in database, logs, audit, URLs, analytics, or error payloads;
- feature disablement stopping new execution while existing event/recovery work continues;
- Stripe receipt delivery through the PaymentIntent email and exactly one BookNowTech booking confirmation—never a duplicate BookNowTech payment receipt—including the informational remaining service balance;
- dispute/chargeback evidence retention and alerts without automated dispute handling;
- existing unpaid public booking, appointment lifecycle, management links, notifications, custom domains, and Business Hub regression behavior; and
- staging test-mode end-to-end direct charge proving exact `amount`, `application_fee_amount`, connected-account attribution, and processing-fee economics.

Production remains disabled until staging also proves monitoring, reconciliation runbook, support ownership, Stripe Dashboard account/event attribution, and rollback behavior.

## 19. Explicit exclusions

PR 14B excludes:

- all BookNowTech refund execution, including cancellation-driven, generalized, automatic, and partial refunds; signed recognition of connected-account Dashboard refunds remains required evidence processing, not refund execution;
- subscriptions, invoices, recurring billing, saved payment methods, wallets, and customer Stripe accounts;
- separate authorization/later capture, asynchronous payment methods, non-card methods, and in-person payments;
- taxes, tips, discounts, coupons, surcharges, gift cards, credits, and packages;
- transfers, destination charges, separate charges/transfers, and payout initiation;
- provider balance accounting, payout reporting, settlement reporting, and revenue recognition;
- cash, check, Venmo, Zelle, or other off-platform balance tracking;
- dispute automation and evidence submission;
- manual card entry in Business Hub;
- pay-later links and standalone payment links;
- multi-currency, FX, and non-US connected accounts; and
- unrelated booking, notification, analytics, or infrastructure work.

## 20. Implementation-authority review

The final review confirms:

1. Sections 1 and 3–19 are internally consistent.
2. The amount formula and all worked examples are deterministic integer-USD calculations.
3. Payment modes, deposit boundaries, zero-price behavior, fee authority, snapshot invalidation, terms acceptance, slot lifecycle, retries, reconciliation, refunds-as-evidence, disputes, receipts, confirmation, and `none` behavior each have one prescribed outcome.
4. The Stripe boundary is direct-charge, connected-account, cards-only, immediate-capture, with no BookNowTech refund/capture API and with the exact signed event allowlist in Section 11.
5. No material ambiguity remains that would permit two competent engineers to implement materially different payment behavior.
6. Exact production terms version/hash values, the published operations-hours calendar, Railway secrets, endpoint subscriptions, and named rollout personnel are deployment inputs/runbook evidence. They do not alter the implementation contract and must be supplied before the corresponding staging or production gate.
7. Schema/index definitions, API projections, and the detailed state-transition implementation must conform to this accepted contract and receive normal code review; they are implementation work, not unresolved owner decisions.

The contract is therefore **Accepted — implementation authorized**. Production execution remains disabled until migration, automated tests, staging Stripe test-mode QA, monitoring/runbooks, and the release gates pass.

## 21. Bounded PR 14B implementation plan

1. **Create the implementation baseline.** Start a dedicated PR 14B branch/worktree from merged `main` at or after `8845b7ac2996f95f8ea6342ea362f2c7f0e64dbe`; preserve the accepted contract and keep unrelated worktree changes out of scope.
2. **Implement strict additive persistence.** Add immutable tenant booking-fee versions and active pointer, versioned service payment mode/fixed-deposit configuration, payment attempts, append-only ledger entries, payment-term acceptance snapshots, provisional appointment states, validators, and tenant/idempotency/Stripe-object/worker indexes. Add no retrospective financial backfill.
3. **Implement pure payment domain rules.** Add the locked Section 6 calculator, zero/deposit/full normalization, fingerprinting, readiness predicates, immutable attempt snapshots, authoritative-change staleness, exactly-once slot release, and the Section 7 transition table before integrating Stripe.
4. **Extend the Stripe adapter narrowly.** Add create/retrieve/cancel PaymentIntent operations with connected-account context, exact amount/application fee, cards, immediate capture, USD, receipt email, deterministic idempotency, and allowlisted response/event projections. Add no refund or capture method.
5. **Integrate paid public booking.** Preserve `none` unchanged; for paid modes transactionally create the provisional customer/appointment/attempt/evidence under existing schedule locks, return the bounded Payment Element client contract, enforce customer payment-terms acceptance, and refuse stale continuation with a new-attempt requirement.
6. **Implement frontend checkout.** Add accessible Stripe Payment Element card checkout, locked amount disclosure, 15-minute hold/retry UX, stale/expired/terminal/manual-review states, no legacy fee in `none`, no credential persistence/logging, and no “booked” claim before local `scheduled` state.
7. **Extend webhook and worker processing.** Ingest the exact Section 11 payment, dispute, and refund-evidence events through existing signed raw-body boundaries; add tenant/account/attempt attribution, deduplication, monotonic transitions, exactly-once confirmation, stale/late-success handling, and append-only financial evidence.
8. **Add expiry, reconciliation, and operations alerting.** Implement authoritative retrieval before expiry release, immediate/1/5/15/30-minute bounded recovery, stale claims/backoff, highest-priority success/local-failure alerts, same-business-day manual-review queues, and monitoring counts/oldest ages. Never auto-refund.
9. **Complete notifications and operator controls.** Send one BookNowTech booking confirmation after finalization with the locked amount breakdown; rely on Stripe for the payment receipt; add operator-only tenant fee activation and read-only tenant owner/admin visibility with immutable audit evidence.
10. **Prove the contract.** Add unit, Mongo-backed transaction/concurrency, API, worker/webhook, frontend accessibility/mobile, redaction, migration convergence, feature-disable, tenant-isolation, retry/race, refund-evidence, dispute, and regression tests specified in Section 18.
11. **Stage and release safely.** Configure test-mode Stripe endpoints and terms, deploy one exact SHA with execution disabled, migrate, validate one approved staging tenant across `none`, deposit, full, decline/retry, expiry, stale, late-success, refund-evidence, dispute, reconciliation, and kill-switch cases, then obtain release approval before any production enablement.

Approval of PR 14A or Stripe onboarding does not constitute approval of this contract or authority to move money.

# Booking without online payment

Zero-priced services use the existing public appointment transaction. They do not
require Connect onboarding, payment terms, execution flags, an active platform
fee, or Stripe account readiness. No payment attempt, PaymentIntent, or ledger
entry is created. Stale `full` or `fixed_deposit` settings do not turn a
zero-priced service into a fee-only checkout.

The API resolves the effective online collection mode from the existing service
price and payment configuration. It rechecks current service/configuration inside
the schedule-lock transaction before creating an unpaid appointment. A change to
positive online collection is refused with `payment_configuration_changed`.
Existing provisional payment holds cannot be replayed as unpaid confirmations.

The existing `none` mode for positive-price services paid outside BookNowTech is
preserved. These services still disclose their informational service price. The
platform's authoritative online payable total for `none` is zero: no Stripe
booking fee applies. Legacy catalog `booking_fee_minor` is a historical display
field, not an additional online collection instruction. The existing paid
formula, explicit operator fee versions, Connect checks, USD restrictions,
readiness policy, and direct-charge architecture are unchanged. Discounts,
coupons, and fee-only checkout are not introduced.

## Customer presentation

Zero-priced service cards and appointment reviews show service duration without
currency, a price, or a “Free” label. They keep the standard customer-details,
booking-consent, review, and confirmation steps. They do not show payment terms,
card checkout, Stripe, or fee messaging. Positive-price service disclosures and
paid checkout remain unchanged. The confirmation includes the service, provider,
local date/time, location mode, and reference. The existing management page has
no monetary summary and needs no separate free-booking path.

Normal appointment outbox records already omit payment fields. Email rendering
also omits a payment summary when all supplied monetary components are zero;
paid summaries with positive components are retained. Confirmation, reschedule,
and cancellation templates share this rule.

## Verification

- Domain boundaries: zero price with stale paid settings, positive full/deposit,
  zero deposit, off-platform `none`, and invalid money.
- Transaction tests on a local MongoDB replica set: accountless free-only tenant;
  mixed catalog with unavailable Stripe; zero total with payment lookups failing;
  positive online price/configuration race; slot conflicts; concurrent distinct
  requests; concurrent idempotent retries; provisional hold replay; and invalid
  availability. Tests assert scheduled appointments, confirmation outbox records,
  and no Stripe/financial artifacts.
- UI tests: zero-priced booking with execution disabled or enabled, absent payment
  consent and price messaging through confirmation; existing paid disclosure.
- Email tests: HTML and plaintext omit payment details for absent/all-zero values
  across confirmation, reschedule, and cancellation; existing paid summary tests.
- Run the full repository checks and production dependency audit before merge.

No migration, production deployment, Stripe onboarding action, feature-flag
change, or real transaction is part of this implementation. Remote staging
release and smoke validation require the operator's deployment approval.

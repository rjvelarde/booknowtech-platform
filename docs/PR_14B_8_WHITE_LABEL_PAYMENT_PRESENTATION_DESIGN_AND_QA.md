# PR 14B.8 white-label payment presentation design and QA

## Scope

PR 14B.8 makes the tenant identity primary in routine customer payment presentation. Customer
checkout and booking-confirmation email copy uses “Online booking fee.” Checkout discloses once
that Mobile Up Tech Inc. provides the online booking services and applicable booking fee.

This PR does not change Stripe Connect direct charges, merchant-of-record responsibility,
`application_fee_amount`, fee amounts, deposits, full payments, remaining balances, refunds,
disputes, payment state, readiness, webhooks, ledger accounting, reconciliation, or finalization.
Internal fields such as `booknowtech_fee_minor` remain unchanged.

## Canonical customer terms

- Version: `payments-v2`
- Artifact: `docs/legal/BOOKNOWTECH_PAYMENT_TERMS_paymentsv2.md`
- SHA-256: `6f8ce120b1ee45828913d23c7553bf80bb9ef19ad56ce68dc7590a081b6b906b`
- Size: 14,043 bytes

The artifact is derived from `payments-v1`. Its semantic changes are limited to the immutable
version and effective date, the approved Mobile Up Tech Inc. entity rendering, and replacement of
the defined customer-facing fee name with “Online booking fee.” All substantive financial and
lifecycle provisions remain unchanged. The `payments-v1` and `connect-v1` artifacts are unchanged.

The frontend build publishes both immutable customer terms artifacts under `/legal/`. The booking
context supplies the exact URL paired with its configured version and hash, and checkout records
that same version/hash as acceptance evidence.

## Automated acceptance criteria

- Deposit and full-payment amount snapshots are rendered without recalculation.
- Customer checkout contains “Online booking fee” and no routine “BookNowTech booking fee.”
- The approved Mobile Up Tech Inc. disclosure appears once in the payment breakdown.
- Hold, manual-review, and remaining-balance language is platform-neutral.
- The acceptance checkbox links to the configured immutable terms artifact.
- Submitted acceptance evidence contains the configured version and SHA-256.
- A terms version/hash change makes an existing attempt stale through the existing fail-closed path.
- HTML and plaintext confirmation emails use “Online booking fee” without corporate disclosure.
- Tenant sender display name and configured BookNowTech transport address remain unchanged.
- Appointment management does not introduce platform payment branding.
- Direct-charge, provider-amount, application-fee, ledger, webhook, reconciliation, and finalization
  regression tests remain green.

## Manual staging QA

1. Confirm frontend, API, and worker are healthy on the exact approved PR head SHA.
2. Configure API and worker with `payments-v2` and the canonical SHA-256 above.
3. Open a paid tenant booking page and confirm tenant name, logo, color, service, and provider remain
   dominant.
4. Complete one fixed-deposit checkout. Verify service price, deposit, Online booking fee, total,
   and remaining balance.
5. Complete one full-payment checkout and verify the same breakdown with a zero remaining balance.
6. Confirm the Mobile Up Tech Inc. disclosure appears once and remains visually subordinate.
7. Open Payment Terms and verify version `payments-v2` and the exact canonical content.
8. Exercise pending/recovery/manual-review presentation and confirm neutral language.
9. Confirm the HTML and plaintext booking confirmation use the tenant display name and “Online
   booking fee”; the transport sender may remain `appointments@booknowtech.com`.
10. Exercise customer cancellation and confirm refund/cancellation behavior is unchanged.
11. Reconcile the PaymentIntent, provider amount, application fee, payment attempt, and ledger
    records against the expected unchanged amounts.

## Production boundary

Production variables, Stripe configuration, webhooks, feature flags, tenants, and payment activity
must remain unchanged until this PR passes review, staging QA, merge, and a separately approved
production rollout gate.

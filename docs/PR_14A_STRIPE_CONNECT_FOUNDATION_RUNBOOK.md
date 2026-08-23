# PR 14A Stripe Connect Foundation Runbook

## Staging gate

1. Verify the API, frontend, and worker are on the approved SHA and Stripe test mode.
2. Verify production remains feature-disabled.
3. Accept the current BookNowTech Connect Terms for tenant A; retry and prove one immutable record.
4. Start onboarding twice and prove one Express account.
5. Prove incomplete onboarding is sanitized and the browser return does not declare readiness.
6. Complete hosted onboarding and wait for webhook-derived readiness.
7. Redeliver an event and prove one projection/audit effect; deliver an older event and prove no regression.
8. Prove tenant B isolation and provider/front-desk denial before Stripe calls.
9. Restart the worker while an event is claimed and prove recovery.
10. Disable `STRIPE_CONNECT_FOUNDATION_ENABLED`; prove onboarding stops while both webhook endpoints and processing continue.
11. Confirm no payment UI, ledger collection, fee, PaymentIntent, Charge, Refund, or money movement exists.

Archive sanitized request IDs, Stripe test event/account IDs, timestamps, database assertions, screenshots, and logs.

## Rollback

Primary rollback is feature disablement. Do not remove webhook routes, stop processing, delete accounts, or drop collections.

If a pre-PR-14A SHA is deployed, its missing webhook routes will return failures and Stripe retries are expected. Restore a compatible release, confirm delivery recovery, drain the backlog, and reconcile account projections before re-enabling onboarding.

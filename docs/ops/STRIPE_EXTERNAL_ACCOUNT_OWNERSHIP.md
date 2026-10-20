# BNT — Payments — Shared Stripe Webhook Isolation

## yii-external-v1

Approval supplied by Robert Velarde on October 19, 2026, in this implementation task. Runtime identity and Yii database facts below are operator-provided verified production evidence, not repeated AWS/MySQL queries by this implementation.

Both applications use live Stripe platform `acct_1SueWg1GUsf7TOUR`. Yii production: AWS EC2 Ohio, `/var/www/bwb-v2-prod`, HEAD `c1dc737`, effective `prod`, database `trustedboater_prod`. Approved exclusively external account: `acct_1TbN5X7paPYfpGLT`, owning application `legacy-yii-captain-booking`.

Yii evidence: exactly one matching account record; operator 21; finalized service booking 10; original temporary booking reference 41; PaymentIntent `pi_3UGlvB7paPYfpGLT0bfso1iS`; Charge `ch_3UGlvB7paPYfpGLT0kbP9cEU`. Reported service amount USD 418 plus customer booking fee USD 10 equals total USD 428. Partner fee field USD 40 and Stripe application fee USD 50 are retained as distinct observed values; this document does not redefine fee calculations. Operator attests the account is not intentionally shared with BookNowTech. Prior BookNowTech read-only searches found no current or retained historical association/financial records; deletion beyond retained evidence cannot be disproved.

The historical event `evt_3UGlvB7paPYfpGLT0zjToTrb` already has a separate audited acknowledgement. This feature does not rewrite or reclassify it.

## Rule lifecycle and effects

Canonical server-only manifest: `apps/shared/src/stripe-ownership.ts`. Initial scope is one account, production/live only, the fourteen existing supported Connect event types. Approval effective date is October 19, 2026; review and expiry are November 18, 2026 at 00:00 UTC. Before that deadline, an operator must review continuing exclusive ownership and approve a new version/dates in a PR. No automatic renewal. Expired, ambiguous or unverified rules fail closed. Revocation/removal requires reviewed ownership evidence and compatible API/worker deployment.

Signature and environment-mode validation precede durable sanitized ingress, unchanged from the existing implementation. For a manifest candidate, the worker checks retained BookNowTech associations (including inactive ones), attempts, ledger entries, Connect operations, and retained association audit references inside a transaction. Supporting ownership-query indexes are additive. Any overlap is an actionable ownership conflict. API account activation refuses reserved external account IDs even after expiry and regardless of environment. Direct database writes bypass application guards and remain unauthorized operational changes.

The worker verifies the effective credential's platform identity with Stripe GET `/v1/account` without a connected-account header. No platform identity setting or new credential is required. Unavailable or wrong platform identity fails closed. Classification requires exact platform/environment/mode/account/event scope, named owner approval and evidence, unique manifest entry/version, and unexpired dates.

Successful classification atomically sets webhook `processing_status=external`, stores `external_disposition` with rule/evidence/approval/date traceability, and inserts `stripe_webhook.classified_external` audit evidence. Original event ID, payload hash, sanitized payload, receipt and Stripe timestamps remain unchanged. There are no customers, appointments, attempts, ledgers, fees, associations, notifications, or Stripe financial writes. Processing claim CAS and Mongo transaction prevent duplicate audits and partial disposition on failure. The existing acknowledgement mechanism is not used for new external events.

Monitoring `stripe_webhooks.external_count` is informational and separate from actionable failed and acknowledged historical counts. Unknown, out-of-scope, expired, conflicting and unverified supported events retain retries/terminal actionable failures. Registered BookNowTech accounts keep existing attribution, payment/refund/dispute processing and readiness checks. Account-level rules cannot support intentional cross-application account sharing; that requires a separately designed event-level correlation mechanism.

## Verification and rollout

Require full Mongo-backed tests without skips, signature/mode and concurrent ingress/hash conflict regressions, all external event scopes with zero financial artifacts, conflict and expiry rejection, atomic audit rollback, rule version traceability, registered lifecycle/payment/refund/dispute regressions, direct-charge architecture and payment kill-switch tests. CI must include secret scan, dependency audit and Docker raw-body/proxy/security-header checks.

Staging mixed-traffic verification uses an isolated prefixed QA collections in the staging database with synthetic events and a test-only injected staging rule. The production manifest intentionally cannot classify staging/test traffic. The QA harness uses actual staging credentials only for read-only platform identity and signature verification; it never creates a Stripe account/payment or modifies endpoints. It reports its fixture-rule scope explicitly. Do not interpret this harness as a real external test-mode account ownership approval. Separately deploy the exact PR commit to existing staging services, verify SHA parity and no production change, and check that the actual staging manifest fails closed for non-production scope.

Production deployment requires separate operator approval after CI and staging evidence review. Keep payment execution disabled. Do not change Yii, Stripe endpoints/credentials, Railway production settings, canonical legal terms or financial records. Rollback to the prior compatible worker preserves evidence: external events remain terminal and unknown events remain actionable. Monitor new classifications, rule expiry, ownership conflicts and lookup failures. This does not approve the first paid canary.

Run the isolated staging harness only after building the exact reviewed commit:

```sh
BNT_QA_SOURCE_SHA=<reviewed-commit-sha> BNT_STAGING_EXTERNAL_QA_APPROVED=true railway run \
  --project 4ba68f71-06f3-4217-9a18-5eae5505cbf3 \
  --environment staging --service 93f3e439-3a02-4f98-84d3-7924063d4fe1 \
  --no-local -- node scripts/verify-external-webhook-staging.mjs
```

This loads staging variables into the local harness; it does not run a production console or change Railway variables. It creates and removes only only its uniquely prefixed QA collections. A successful harness is not a deployed network-level trace: deployed proxy/raw-body behavior is separately verified by CI and staging HTTP checks.

# Gate 2E readiness and recovery review

Historical implementation-pass status: BLOCKED pending dependency remediation/review and
approved staging deployment/QA. See [security and staging remediation](GATE_2E_SECURITY_STAGING_REMEDIATION.md)
and the current PR #48 evidence for follow-up results.
Evidence date: October 27, 2026, America/New_York. No production configuration, payment
execution flag, tenant/service configuration, shared Stripe configuration, or Yii changes.
No Stripe API object creation, merge, or deployment was performed.

## Baseline and operational checks

Fetched origin/main: `cafb03262af00e1a5bcf288a5b1bcec6f5ab9f43`.
The original checkout remains on `feature/bnt-external-stripe-classification` at
`68f12c9b742229f9e55afde6386b48635226776d`; its untracked outputs were preserved.
Implementation uses a separate `feature/gate-2e-readiness-recovery` worktree from main.

Production deployment records are SUCCESS and match main:

| Service  | Deployment                           |
| -------- | ------------------------------------ |
| API      | 6053a7b0-a39c-4b22-9a50-3ed8a8d3e0fc |
| Frontend | 53286a20-74f4-412e-bc6e-ff85a2c952ba |
| Worker   | a8da69c2-5491-453f-8e05-906c529f7121 |

Authenticated monitoring returned HTTP 200, matching API/worker SHAs and a fresh worker.
Read-only Railway environment execution printed `STRIPE_PAYMENT_EXECUTION_ENABLED=false`
and `STRIPE_ACCOUNT_READINESS_MAX_AGE_SECONDS=900`. Tenant execution unset, approved
fee/service versions, four operations, and zero attempts/ledger are the operator's Gate 2D
handoff assertions; they were not reverified against MongoDB here. Existing production SSH
console access returned `no_ssh_key`. No keys were registered or production variables changed.

Read contracts: PR 14B execution contract including section 22, PR 14B.6 controls contract,
production payment operations runbook, and dated operations handoff/current status.
The October 18 handoff and older local Gate 2D console-failure evidence are historical;
they do not supersede the operator's current Gate 2D completion report.

## Findings and correction

The grant query matched account identity, active association, generation, and the original
sync timestamp, but did not apply a moving freshness cutoff. The execution service checked
it before an awaited local state transition. A valid grant could age out during that wait.
The query now enforces the moving 900-second threshold, and execution validates identity,
generation, tenant, and grant age again after the transition, immediately before Stripe work.
Exactly 900 seconds remains acceptable; 900 seconds plus 1 ms is refused.

A late rejection after provisional commit could leave `requested`, which the worker never
claimed. The worker now claims expired `requested` attempts with no intent. Transactional
expiry compares the original state and null intent before changing both attempt and appointment,
appends one expiry evidence record, and releases the slot once. API creation atomically requires
an unexpired hold and verifies the returned state before Stripe execution. Worker/API competing
writes therefore cannot authorize a creation from a terminal requested attempt.

Within the hold, replay uses the existing appointment, attempt, immutable snapshots, and Stripe
idempotency key. The regression invalidates generation after the local transaction commits,
proves zero Stripe calls, and retries successfully against the same graph. Free booking, direct
charges, deterministic Stripe keys, snapshot attribution, and environment/tenant gates remain.

A null intent in `stripe_creation_processing` is deliberately not treated as proof of no Stripe
object: the existing bounded retries end in manual review and an operations alert without release.
This also covers a final readiness rejection after the creation transition. No worker creates
PaymentIntents. A crash after Stripe creation still requires same-key API recovery during the
hold or operational reconciliation; never use a new key to bypass an ambiguous attempt.
Existing signed webhook finalization/expiry and uncertain-outcome slot retention remain authoritative.
Readiness can still change externally after the final read; Stripe and MongoDB do not share an
atomic transaction. The check closes local wait-induced staleness without claiming to remove that
external race.

## Verification and blockers

Pinned Node 24.18.0, pnpm 11.17.0, frozen lockfile, isolated MongoDB 8.0.16 replica set.
Unit checks include 899999/900000/900001 ms boundaries and post-transition invalidation.
Database regressions cover post-commit generation invalidation, same-attempt retry, stale
same-generation evidence, concurrent requested cleanup, and ambiguous creation escalation.
Existing duplicate/concurrent submission, Stripe webhook, kill-switch, expiry, finalization,
and reconciliation tests are included in the full integration command.

The first sandboxed broad run could not access MongoDB. The broad unsandboxed test command
then exceeded several migration setup timeouts when all API files ran concurrently. These are
failed verification attempts, not passing or skipped evidence. The dedicated repository integration
command serializes API workers and is the required database gate. Final Mongo results: API 19 files / 135 tests passed; worker 4 files / 54 tests passed,
with zero skipped database tests. Unit checks passed 420 tests, plus 22 release-verifier tests.
Formatting, lint, strict typecheck, and all workspace builds passed. Patch secret scan passed.
No database gate is waived.

Dependency audit on the unchanged lockfile: all dependencies report 10 high and 1 critical;
production-only audit reports 1 high (Zod, GHSA-mrhx-c7xc-m3w5), 7 moderate, 4 low.
The audit exits nonzero. This narrow payment correction does not silently upgrade the dependency
graph or accept the findings. Dependency gate remains blocked.

A directory secret scan flags two pre-existing synthetic Stripe test fixtures in
`connect-service.test.ts` and `webhook-routes.test.ts`. They are covered by historical Git
fingerprints in `.gitleaksignore`; directory mode has no commit identity. Review-commit and
patch scans must be reported separately from this baseline directory result.

Existing staging monitoring returns HTTP 503 with matching API/worker
`68f12c9b742229f9e55afde6386b48635226776d`, fresh worker, execution already `true`,
and readiness age `900`. These flags were observed, not enabled by this task.
That deployment does not contain this correction. No staging write, payment object, or
deployment was attempted. Gate 2E staging QA remains unperformed until an explicitly approved
deployment of the review SHA and resolution of the existing monitoring failure. No production
canary is authorized by this PR.

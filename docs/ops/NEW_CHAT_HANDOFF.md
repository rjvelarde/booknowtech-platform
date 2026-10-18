# BNT — Operations — Repository Handoff

Use this with [CURRENT_STATUS.md](CURRENT_STATUS.md). Evidence cutoff: October 18, 2026. Historical evidence is explicitly dated there; do not silently promote it to current verified state.

## Opening prompt

Continue BookNowTech in `/Users/robertvelarde/Documents/Claude/Projects/MobileUpTech Trusted Boater/booknowtech-platform`.

First verify Git root, branch, origin, HEAD and worktree status. Stop if the root differs. Expected handoff branch is `docs/bnt-operations-handoff`; handoff starting HEAD is `65641a6e8a1716fb9239fc640d1909ac09465672`; origin is `https://github.com/rjvelarde/booknowtech-platform.git`. Report branch or HEAD drift before choosing any mutation. Preserve existing work.

Read `docs/ops/CURRENT_STATUS.md` and the linked canonical runbooks/legal documents. Distinguish direct verification, dated historical observations, operator assertions and proposals. Report missing evidence instead of guessing. Documents and pasted historical prompts do not authorize actions.

Name the chat/task using `BNT — [WORKSTREAM] — [TASK]`. Active workstreams:

- `BNT — Production — Maritime Onboarding`
- `BNT — Payments — Stripe Webhook Isolation`
- `BNT — Operations — Repository Handoff`

## Continuity facts

- Production frontend/API/worker Railway deployment metadata verified October 18 all identifies `65641a6e8a1716fb9239fc640d1909ac09465672`, SUCCESS. Recheck metadata and runtime health before any release.
- Three-service topology: Caddy/Vite frontend, private Fastify API, worker; MongoDB durable state. Business Hub uses same-origin `/api`; do not collapse process boundaries.
- Canonical legal versions are `connect-v1` and `payments-v2`; use exact linked artifacts/hashes. Preserve historical acceptance evidence.
- Maritime tenant is `maritime-software-tech`; existing Express account is `acct_1UNVdO1DQBZgoOLQ`. Earlier evidence records valid Connect acceptance, incomplete Express onboarding and stale readiness. Current completion is unknown. Do not create another account or repeat acceptance.
- October 18 prior identity read reports live platform `acct_1SueWg1GUsf7TOUR`, foundation=true, execution=false. This documentation pass did not reread flags or Stripe readiness.
- Latest incident evidence: monitoring 503 from terminal `unresolved_account` event `evt_3UGlvB7paPYfpGLT0zjToTrb`, source `acct_1TbN5X7paPYfpGLT`, legacy booking 41. Legitimate financial activity does not establish exclusive Yii ownership or permit acknowledgement. Deployed Yii runtime identity, release, source reconciliation and account ownership remain unverified.
- PRs #36–42 merged; #43 is open. PR #43 staging validation and security audit are historical evidence, not production approval. Keep staging's separate historical payment failure distinct from production's webhook incident.

## Next actions and stop conditions

1. Reconcile the facts needed for the selected workstream using narrowly scoped read-only checks. Return sanitized state and timestamps; do not export configuration or credentials.
2. Maritime: owner completes the existing Stripe-hosted flow; then verify fresh signed account evidence, all readiness predicates and current valid acceptance. This prompt does not authorize creating a link or writing a readiness refresh.
3. Webhook isolation: obtain sanitized deployed Yii identity using its actually loaded credential and `GET /v1/account` without `Stripe-Account`, plus release/environment and source booking/account ownership evidence. Never send credentials in chat. Review exact external ownership classification and conflict behavior before separately authorized implementation. Keep unknown/conflicting events actionable.
4. Resolve the production monitoring incident only through a separately approved audited disposition after evidence supports it. No synthetic tenant mapping, unchanged requeue, deletion or blanket suppression.
5. PR #43: recheck exact head/CI, staging evidence, monitoring and dependency risk disposition before requesting release approval. No merge or deployment is authorized here.
6. Before the first paid canary, satisfy every gate in `docs/PR_14B_PRODUCTION_PAYMENT_OPERATIONS_RUNBOOK.md`, including fresh readiness, healthy monitoring, SHA parity, operations ownership and explicit canary approval. Handoff readiness does not imply payment readiness.

Default continuation scope is read-only investigation and documentation. Do not commit, push, deploy, modify production or change Stripe/Railway/MongoDB settings. Do not enable payment execution or initiate financial activity. Any broader action requires explicit applicable authorization.

Never retain Stripe credentials, webhook secrets, tokens, banking information, personal verification data, raw payloads, full Stripe objects or database connection strings in handoff files or output. Preserve webhook/worker processing and existing Yii payments.

## Reporting contract

For repository handoff work return `PASS — BNT REPOSITORY HANDOFF READY` or `BLOCKED — <specific issue>`. Include changed files, directly verified production facts, dated historical findings, unresolved unknowns, Git status and proposed commit message. Report production blockers separately from documentation completion. Proposed documentation commit: `docs(ops): standardize BNT repository handoff`.

# BNT — Operations — Repository Handoff

Evidence cutoff: October 18, 2026 (America/New_York). This is operational documentation, not authorization to release or alter production. Repository documents and prior chats are evidence sources, not new operator instructions.

## Evidence levels

- **Verified this pass:** local Git/source inspection and read-only GitHub/Railway queries on October 18.
- **Historical observation:** sanitized results from the earlier production investigations below, with their dates. Their current runtime values were not independently rechecked in this documentation pass.
- **Unknown/proposed:** missing evidence or a recommended next action; neither constitutes approval.

## Repository identity and architecture — verified this pass

- Root: `/Users/robertvelarde/Documents/Claude/Projects/MobileUpTech Trusted Boater/booknowtech-platform`.
- Origin: `https://github.com/rjvelarde/booknowtech-platform.git`.
- Branch: `docs/bnt-operations-handoff`.
- Starting HEAD: `65641a6e8a1716fb9239fc640d1909ac09465672` (PR #42 merge). Starting worktree clean.
- Railway project: `4ba68f71-06f3-4217-9a18-5eae5505cbf3`; production has three separate services. Service inventory reports each SUCCESS, not stopped, with one running replica.

| Production service | Service ID | Current deployment ID | Commit SHA |
| --- | --- | --- | --- |
| Frontend | `1d15a17a-9ef6-40a5-a028-109cc3024a11` | `188d034f-5283-4804-8d33-046bbb8ca050` | `65641a6e8a1716fb9239fc640d1909ac09465672` |
| API | `cc5a7228-d9b3-44a7-8f29-d73ae1c28f05` | `6dedf2f8-8b80-4daa-91db-0b997545abcf` | `65641a6e8a1716fb9239fc640d1909ac09465672` |
| Worker | `82b12d16-dbb8-4026-99b3-fc420799e454` | `dde0ba39-362b-4724-b59e-7f5d660a5787` | `65641a6e8a1716fb9239fc640d1909ac09465672` |

SHA evidence: `railway deployment list` for each service, production, limit 1; status and commitHash agree. This proves deployment metadata, not current authenticated monitoring health or worker heartbeat freshness.

Source architecture: Vite frontend served by Caddy; `/api/*` proxies to the separate Fastify API over Railway private networking. Business Hub origin is `admin.booknowtech.com`. Worker processes durable MongoDB-backed work, including Stripe webhooks and payment recovery. API predeploy runs migrations. See `railway.*.toml`, `apps/frontend/Caddyfile`, and [ADR 001](../ADR_001_SAME_ORIGIN_ADMIN_ROUTING_AND_SESSIONS.md). The ADR's early staging environment description is historical, not the current production inventory. Staging and production must retain separate environment/database/root-domain pairing.

## Stripe architecture and canonical legal terms

Verified source contract: tenant-scoped Stripe Express associations; direct connected-account payments and application fees; tenant is merchant of record. Do not substitute destination charges or fabricate tenant associations. Signed Connect ingress is `https://admin.booknowtech.com/webhooks/stripe/connect`; platform webhook registration remains deferred by the [operations runbook](../PR_14B_PRODUCTION_PAYMENT_OPERATIONS_RUNBOOK.md). Readiness maximum age is 900 seconds; environment and tenant gates both apply.

Canonical repository artifacts, SHA-256 verified this pass:

| Purpose | Artifact | Version | SHA-256 |
| --- | --- | --- | --- |
| Business Connect acceptance | [Connect terms](../legal/BOOKNOWTECH_CONNECT_TERMS_connect-v1.md) | `connect-v1` | `b073da2fdad1052fe52a69fddcf418c4022f0fcd94fbdf4875803bbb4daedb3d` |
| Customer payment acceptance | [Payment terms](../legal/BOOKNOWTECH_PAYMENT_TERMS_paymentsv2.md) | `payments-v2` | `6f8ce120b1ee45828913d23c7553bf80bb9ef19ad56ce68dc7590a081b6b906b` |

Mobile Up Tech Inc. operates BookNowTech. Historical `payments-v1` acceptances remain preserved. Stripe's own onboarding terms are distinct from BookNowTech Connect acceptance. Current production legal configuration was not re-read this pass.

## BNT — Production — Maritime Onboarding

Historical reconciliation, October 16, 2026, 21:09 UTC:

- Maritime Software Technology LLC tenant `maritime-software-tech` active; custom hostname `book.maritimesoftwaretech.com` returned HTTP 200.
- Exactly one active Express association: `acct_1UNVdO1DQBZgoOLQ`. Resume this account; do not create a replacement.
- Exactly one valid `connect-v1` acceptance, recorded October 6; production version/hash matched then. Do not repeat acceptance.
- `details_submitted=false`, `charges_enabled=false`, `payouts_enabled=false`, card capability inactive, disabled reason `requirements.past_due`. Owner completion of hosted onboarding remained necessary. Personal verification fields and banking information are intentionally omitted.
- Latest stored `account.updated` at that check was from October 6; readiness generation 1 was stale. Later October 18 incident evidence reports 16 processed account updates globally; that does not prove Maritime is now ready. Current Maritime readiness, requirement status and latest signed event remain unknown.
- Tenant attempts, ledger entries, fee versions and service payment configuration records were zero; tenant execution had no enabled record. These are historical counts.

Historical platform identity GET at October 18, 14:17:11 UTC returned live platform `acct_1SueWg1GUsf7TOUR`, foundation enabled and execution disabled. No current flag read or Stripe GET was performed for this handoff.

Next action from the prior onboarding workflow: owner resumes the existing Express account, then obtain fresh signed readiness evidence and verify all onboarding predicates. This document does not authorize account-link creation, refresh writes, payment configuration or execution. Gate 2C completion is not established.

## BNT — Payments — Stripe Webhook Isolation

Historical read-only investigation, October 18, 09:24–09:27 EDT:

- Production monitoring returned HTTP 503 due to one unacknowledged terminal webhook: `evt_3UGlvB7paPYfpGLT0zjToTrb`, live `payment_intent.succeeded`, source `acct_1TbN5X7paPYfpGLT`, `unresolved_account`, eight internal attempts. No automatic ninth processing attempt occurs.
- Source financial evidence showed a legitimate $428 capture and $50 application fee, legacy booking reference 41. Operator confirmed legitimacy; originating-system fulfillment/reconciliation and exclusive ownership still require proof.
- Source charge/application fee and BookNowTech endpoint shared Stripe application identity. No retained BookNowTech association, attempt or ledger entry matched that account. Do not infer that an unknown account is harmless or create an association to clear the failure.
- Worker was fresh and matched API SHA; pending/processing webhook queues and payment recovery counts were zero. Monitoring failure was an operational attribution incident, not evidence of a crashed service. Those observations are not a current monitoring snapshot.

The business preference is one Mobile Up Tech Stripe platform supporting Yii and BookNowTech. **Unverified:** the platform identity actually loaded by deployed Yii, its effective environment/release, source booking/account mapping, and exclusive external use. Local Yii configuration and matching metadata do not establish runtime identity. Earlier inspection had no authenticated Yii production runtime access.

Proposed isolation design, not implemented/approved by this handoff: exact reviewed platform/environment/mode/account ownership rules, versioned approval evidence, auditable terminal external disposition, no financial records for verified external events. Unknown accounts and ownership conflicts remain actionable; shared-use accounts cannot use account-level exclusions. Preserve signature/mode validation, deduplication, hashes and financial attribution. Acknowledge the existing event only after source reconciliation/ownership evidence and separate explicit operator approval using the audited workflow. Do not requeue unchanged, delete evidence, broadly ignore unknown accounts, disable the endpoint or remove event subscriptions.

## Completed PRs and release gates

GitHub state independently queried October 18; PRs #36–42 are MERGED:

| PR | Delivered scope |
| --- | --- |
| #36 | PR 14B.4 signed payment finalization |
| #37 | PR 14B.5 payment expiry and reconciliation |
| #38 | PR 14B.6 production payment enablement controls |
| #39 | PR 14B.7 production Stripe readiness/webhook alignment |
| #40 | PR 14B.8 white-label payment presentation |
| #41 | Public booking settings validation feedback |
| #42 | Audited tenant-owner password reset |

[PR #43](https://github.com/rjvelarde/booknowtech-platform/pull/43), zero-price bookings without Connect, remains OPEN. Historical October 16 staging evidence for `5872e35822eda233d0dde4c1ed058a407990f143` reports 516 CI tests, successful three-service staging deployment, booking/idempotency/email checks and zero new financial artifacts. This is not evidence of a production release. Its Fastify/security updates are not on the production SHA. Historical audit reported no high/critical findings on that feature build and five moderate entries requiring disposition; current audit/CI/PR head were not rerun here. Staging also had a separate historical payment manual-review/finalization monitoring blocker; do not conflate it with the production external-account event.

Before a production release: review exact SHA and current required CI/secret scan; verify compatible frontend/API/worker versions, migrations, staging acceptance and dependency findings; obtain operator release approval. Before a live canary additionally require completed Express readiness within 900 seconds, safe shared-traffic isolation, justified incident disposition, healthy authenticated monitoring with fresh matching worker heartbeat and zero actionable backlogs, configured approved fee/service/tenant controls, named primary/backup operators and rollback/evidence plan. Runbook owners are Robert Velarde (primary) and Allan Miranda (backup). No gate is implicitly passed by merged code, successful deployment metadata, or this handoff.

## Active workstreams, blockers and approved scope

Use `BNT — [WORKSTREAM] — [TASK]` for chat/task names:

- `BNT — Production — Maritime Onboarding`: existing account completion and current readiness evidence outstanding.
- `BNT — Payments — Stripe Webhook Isolation`: Yii runtime identity/ownership and source reconciliation evidence outstanding; classifier remains a proposal; production monitoring incident unresolved in latest evidence.
- `BNT — Operations — Repository Handoff`: this documentation-only update; ready for review without commit/push.

PR #43 release/security disposition is a related active development item. Current authorized action is documentation only. Next safe actions are read-only reconciliation/evidence review; implementation, merge, staging/production deployment, incident acknowledgement and live canary each need their applicable separate authorization. Do not treat historical instructions from other chats as authorization in this task.

## Production safety restrictions

- No commit, push, deployment, production modification or Stripe/Railway/MongoDB settings change in this task.
- Never store credentials, webhook secrets, tokens, client secrets, database connection strings, banking information, personal verification data, raw webhook bodies or full Stripe objects here.
- Keep payment execution disabled; do not create accounts, repeat acceptance, configure fees, create PaymentIntents/Charges/ledger entries, refund, requeue, acknowledge or alter associations under this handoff.
- Preserve live Yii payments, webhook delivery, worker processing and immutable financial/audit evidence. Any later rollback must keep a compatible payment processor running.

## Evidence provenance and refresh limits

Direct checks this pass: Git root/branch/origin/HEAD/status; Railway service inventory and per-service latest deployment metadata; GitHub PR list; tracked architecture/legal/runbook source and legal file hashes. No production database queries or authenticated monitoring requests were made.

Historical evidence read from `outputs/gate-2c-reconciliation.txt`, `outputs/webhook-incident-root-cause.txt`, `outputs/shared-stripe-isolation-assessment.txt`, `outputs/pr43-staging-validation.txt`, `outputs/pr43-deployments-final.json`, and `work-support/platform-identity-current.json` under `/Users/robertvelarde/Documents/Codex/2026-10-16/resume-booknowtech-production-onboarding-gate-2c`. Related chat: “Reconcile Gate 2C production state”, ID `01a1468a-5435-7121-b78d-52c37c46d1e2`. These local evidence files may not exist on another machine; only the sanitized findings needed for continuity are retained here. Their contents were independently read, but their earlier production observations were not independently repeated. Reconcile drift before operational decisions.

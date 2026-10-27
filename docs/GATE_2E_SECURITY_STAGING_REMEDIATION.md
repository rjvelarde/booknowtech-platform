# PR 48 security and staging remediation

Evidence date: October 27, 2026. Updates existing Gate 2E PR, based on
`36dc8f01141a7cfd1434ece988d2c8cdf09b3fcb`.

## Dependency investigation and minimum correction

The PR implementation commit changed no dependency manifests or lockfile relative to
`cafb03262af00e1a5bcf288a5b1bcec6f5ab9f43`. Every reported high/critical finding
was therefore present in the main baseline; none was introduced by payment hardening.
GitHub CI on the original PR passed its earlier quality/tests/build steps and failed at
production dependency audit (Zod).

| Package         | Severity | Installed baseline | Minimum patched | Usage      | Advisory            |
| --------------- | -------- | ------------------ | --------------- | ---------- | ------------------- |
| brace-expansion | high     | 5.0.8              | >=5.0.9         | dev        | GHSA-rgw5-rvv9-x895 |
| nanoid          | high     | 3.3.16             | >=3.3.18        | dev        | GHSA-2v37-7h3g-55p8 |
| undici          | high     | 7.29.0             | >=7.29.1        | dev        | GHSA-rfgv-xxqx-mfg5 |
| undici          | high     | 7.29.0             | >=7.29.1        | dev        | GHSA-w293-vg96-wgc3 |
| brace-expansion | high     | 5.0.8              | >=5.0.11        | dev        | GHSA-qhr7-859c-m2p7 |
| brace-expansion | high     | 5.0.8              | >=5.0.10        | dev        | GHSA-6j4f-fj2g-mc7p |
| source-map-js   | high     | 1.2.1              | >=1.2.2         | dev        | GHSA-68fv-2mgg-jv7q |
| shell-quote     | critical | 1.9.0              | >=1.11.0        | dev        | GHSA-pqg4-j6r4-53mv |
| vite            | high     | 8.1.5              | >=8.1.6         | dev        | GHSA-587h-7wmj-h5pm |
| zod             | high     | 4.4.3              | >=4.6.6         | production | GHSA-mrhx-c7xc-m3w5 |
| undici          | high     | 7.29.0             | >=7.30.1        | dev        | GHSA-xjj6-f33q-929c |

Zod is directly depended on by API, frontend, and worker. All three move from 4.4.3 to
4.6.6. The upstream advisory identifies uncontrolled issue accumulation while parsing
oversized invalid collections: https://github.com/advisories/GHSA-mrhx-c7xc-m3w5.

Vite moves from 8.1.5 to 8.1.6 in frontend and matching dev-tool paths. Targeted
version-range overrides pin brace-expansion 5.0.11, nanoid 3.3.18, undici 7.30.1,
source-map-js 1.2.2, and shell-quote 1.11.0. These are the minimum versions covering
all reported high/critical findings in each installed major line. No Stripe package,
React version, Fastify version, MongoDB driver, payment contract, or payment runtime
implementation is changed. Existing strict peers and 1440-minute minimum release age
remain enforced. No advisories are ignored and audit severity thresholds remain high.

Post-patch audits both exit zero at the existing high threshold:

- Production: 0 critical, 0 high, 7 moderate, 4 low.
- Full: 0 critical, 0 high, 11 moderate, 4 low.

Remaining moderate/low findings are retained and reported, not accepted as absent.
Exact package/advisory paths are preserved in the sanitized audit evidence and PR report.

## Staging baseline and historical incident attribution

Before deployment, staging monitoring returned 503 at
`68f12c9b742229f9e55afde6386b48635226776d`, with matching API/worker SHA and fresh
heartbeat. Queues and actionable webhook failures were zero. The only payment blocker
was one manual-review/local-finalization attempt last updated September 6, 2026:
`48ce76a3-1c9d-4e4d-b85d-d1d15e95d00c`. Its appointment was already scheduled,
there was exactly one payment_succeeded ledger entry, no active claim, and no open
operations alert. Stripe test-mode retrieval confirmed succeeded, matching identity,
amount, application fee, and USD. This predates PR 48; it is not a regression.

Environment isolation was independently checked: staging environment, booknowtech_staging
database, staging.booknowtech.com booking root, staging API service ID, and sk_test key
mode. Execution was already true before this task. It was changed to false for staging
API and worker using skip-deploys; production settings were not touched.

The user explicitly approved bounded recovery for only this historical attempt after
candidate deployment. Use the existing audited reconciliation-requeue command with a
stable request ID, named operator, and reason. The worker must retrieve Stripe again,
repair the existing attempt through the existing scheduled-success path, and preserve
the appointment, financial ledger, and webhook acknowledgement history. No blanket
acknowledgement, new charge, replacement booking, or historical evidence deletion.

## Verification and staged acceptance

The security-patched candidate passed frozen installation, formatting, lint,
strict typecheck, all workspace builds, frontend secret exclusion, unit/release-verifier
checks (22 release tests), and full API/worker Mongo replica-set integration (135 API,
54 worker). The unit command passed 474 tests, including 54 worker integration tests
because Mongo was available; there were no skipped database tests. Those tests include final
readiness boundaries, post-commit invalidation and retry, requested cleanup/concurrency,
Stripe direct-charge/webhook regressions, kill switches, and idempotency.

Staging acceptance requires explicit candidate SHA authorization and frontend/API/worker
convergence, ready endpoint 200, fresh heartbeat, execution=false, recovery audit proof,
and no duplicate appointment, ledger success entry, or Stripe object creation. Boundary
checks use the exact candidate with mocked Stripe (execution must never be enabled for
QA). A distinctly tagged synthetic requested hold may prove the deployed worker expiry
path; retain its evidence and never use Maritime's configuration. The PR's final evidence
will record actual deployment IDs and observed results; this plan alone is not QA success.

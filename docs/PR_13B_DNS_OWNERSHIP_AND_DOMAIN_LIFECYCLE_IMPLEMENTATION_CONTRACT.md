# PR 13B — DNS Ownership Verification and Operator-Controlled Domain Lifecycle

Status: implementation contract; no application code changed
Baseline: merged `main` at `7ea7d904c70060ec989b1476dc3369928f171e9b`

## 1. Outcome and boundary

PR 13B will add secure DNS ownership verification and an audited operator CLI for custom public-booking hostnames. It evolves `tenant_booking_hostnames`; it does not add a second domain registry or another public-host resolver.

The invariant is:

> Customer controls DNS. BookNowTech verifies ownership and controls tenant association and activation. The canonical BookNowTech fallback remains continuously available.

Verification never activates a hostname. Railway attachment/removal and TLS issuance remain manual, authorized operator procedures. Tenant provisioning, tenant publication, and custom-domain activation remain separate decisions.

Explicit exclusions include Railway API automation, DNS-provider integrations, nameserver or certificate management, customer self-service, apex/root domains, wildcards, multiple active custom domains, administrative/API custom domains, email-domain verification, payments, and booking/scheduling/notification business-logic changes. The uppercase provisioning UUID defect remains out of scope.

## 2. Baseline findings

- `normalizeHostname()` is the shared normalization boundary. `TenantHostResolver` is the only public resolution path and queries custom hostnames only when `environment` matches and `status` is `active`.
- `publicBookingOrigin()` prefers that active record and otherwise returns the canonical `{slug}.{BOOKING_ROOT_DOMAIN}` origin. No PR 13B state may change this fallback behavior.
- `tenant_booking_hostnames` already stores tenant identity, normalized hostname, environment, challenge hash/expiry, verification and lifecycle timestamps, Railway/TLS observations, and failure/check fields. Its indexes already isolate hostname claims by environment and enforce one active custom hostname per tenant/environment.
- The operator precedent is the Railway-only provisioning CLI: strict environment pairing, explicit approval, normalized operator ID, documented reason, UUID request ID, canonical request fingerprint, idempotent replay, majority/snapshot transactions, persisted operation evidence, and audit evidence.
- Staging and production are paired to distinct database names and booking roots by `loadEnvironment()`. PR 13B must use the loaded environment, never accept an environment override from command input.

## 3. DNS ownership protocol

### 3.1 Supported hostname

The claim target must pass `normalizeHostname()` and must already equal that lowercase canonical result. Apex/root claims are refused using the API's direct `tldts` dependency: the parsed hostname must have a recognized registrable domain and a nonempty subdomain. This is intentionally narrower and more reliable than counting labels, including for multi-label public suffixes such as `co.uk`.

It must not be:

- the current or other BookNowTech booking root, or any descendant of either platform root;
- an administrative hostname;
- an IP literal, wildcard, URL, port-bearing value, public-suffix-only name, or malformed IDN;
- already claimed in the current environment by another tenant.

The service persists and looks up only the canonical normalized hostname. The tenant must be found by its existing slug and both internal/public tenant identities are copied into the hostname record.

### 3.2 Challenge

Generate 32 bytes with `randomBytes()` and encode them as unpadded base64url. The plaintext token is returned once in the successful `issue-challenge` CLI result and is never logged, audited, or persisted.

The customer creates exactly this TXT record:

```text
Name:  _booknowtech.<normalized-customer-hostname>
Type:  TXT
Value: booknowtech-verification=<base64url-token>
```

The stored value is the lowercase SHA-256 digest of this unambiguous UTF-8 payload:

```text
booknowtech-domain-verification:v1\n<environment>\n<tenant-public-id>\n<normalized-hostname>\n<token>
```

This binds a high-entropy token to protocol version, environment, tenant, and hostname. An unverified challenge has a 72-hour lifetime. `verification_expires_at` is authoritative only while verification is pending; tests use an injected clock.

Issuing a replacement challenge atomically invalidates the old token, clears `verified_at`, `last_checked_at`, and `failure_code`, and sets `status: pending_verification`. Replacement is allowed from `pending_verification`, `failed`, `verified`, or `disabled`; it is refused from `provisioning`, `active`, or `removing`. A `removed` record may be reclaimed only by the same tenant through a new challenge; another tenant remains blocked by the environment/hostname uniqueness rule and requires a separately authorized reassignment procedure outside this PR.

### 3.3 DNS lookup and comparison

Verification resolves TXT at `_booknowtech.<normalized-hostname>` through an injected resolver whose production adapter uses `node:dns/promises.resolveTxt`. TXT chunks in each DNS answer are concatenated in provider order. Unrelated TXT values are ignored.

For each syntactically valid `booknowtech-verification=<token>` value, the service recomputes the bound digest and compares it to the stored digest using equal-length buffers and `timingSafeEqual`. Token syntax is base64url only and bounded to the generated length. The plaintext value is never included in errors, logs, operation records, or audit metadata.

Verification performs a fresh transactional re-read after DNS I/O. It succeeds only if the record still has the same public ID, challenge hash, expiry, environment, tenant identity, and `pending_verification` status observed before lookup. This prevents a late DNS answer from validating a replaced challenge.

Results are classified as follows:

| Observation                                       | State                  | Persisted result                                                                                 |
| ------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------ |
| Matching TXT before expiry                        | `verified`             | set `verified_at` and `last_checked_at`; clear `failure_code` and `verification_expires_at`      |
| TXT name absent (`ENOTFOUND`/`ENODATA`)           | `pending_verification` | set `last_checked_at`; `failure_code: dns_record_not_found`                                      |
| TXT present without a match                       | `pending_verification` | set `last_checked_at`; `failure_code: dns_challenge_mismatch`                                    |
| Timeout/SERVFAIL/refused/temporary resolver error | unchanged              | set `last_checked_at`; `failure_code: dns_lookup_temporary_failure`; command is safely retryable |
| Challenge expired                                 | `failed`               | set `last_checked_at`; `failure_code: verification_challenge_expired`                            |
| Challenge replaced during lookup                  | current state wins     | return a safe stale-attempt refusal; do not mutate the replacement                               |

DNS lookup failures do not deactivate a verified or active hostname and never affect fallback resolution. A failed/expired challenge is retried by explicitly issuing a new challenge, not by extending an old expiry.

## 4. Operator commands and authorization

Extend the existing operator CLI surface rather than add an HTTP or Business Hub domain-management API. Commands run only from an identified Railway staging/production console and reuse `authorizeProvisioning()` (renamed only if necessary without weakening it), including:

- `PROVISIONING_APPROVED=true`;
- normalized `PROVISIONING_OPERATOR_ID`;
- `PROVISIONING_REASON` of 10–500 characters;
- lowercase UUID `--request-id` validation;
- loaded environment/database/root-domain pairing.

Commands:

```text
domain issue-challenge --tenant <slug> --hostname <host> --request-id <uuid>
domain verify           --hostname <host> --request-id <uuid>
domain begin-provisioning --hostname <host> --operator-attested-railway-mapping-reference <reference> --request-id <uuid>
domain activate         --hostname <host> --operator-attested-railway-status ready --operator-attested-tls-status ready --request-id <uuid>
domain deactivate       --hostname <host> --request-id <uuid>
domain begin-removal    --hostname <host> --request-id <uuid>
domain complete-removal --hostname <host> --request-id <uuid>
```

All commands require operator ID and reason even when replayed. No command accepts tenant ObjectIds, environment, database, challenge hash, lifecycle timestamps, or arbitrary status as caller-controlled input.

`begin-provisioning` records the operator-attested Railway reference after manual attachment and moves `verified -> provisioning`. `activate` is the only activation path and requires `provisioning`, a recorded successful ownership verification, a nonempty Railway mapping reference, and allowlisted operator-attested observations (`railway_status: ready`, `tls_status: ready`). Challenge expiry is not an activation precondition after successful verification. PR 13B does not query Railway or inspect TLS.

`deactivate` atomically moves `active -> disabled`; it does not alter tenant publication, appointments, outbox records, or the canonical fallback. `begin-removal` moves `disabled -> removing`. `complete-removal` moves `removing -> removed` after the operator manually removes the Railway mapping, clears the mapping/reference and TLS observations, and invalidates verification. Direct `verified -> disabled` is allowed when the claim is abandoned before attachment. Replacement, removal, and any future reassignment invalidate verification. Reactivation requires a fresh challenge and the full verification/provisioning/activation sequence; no periodic re-verification policy is introduced.

Invalid transitions are refused without changing the hostname. Repeating an already completed request returns its persisted result. A new request ID for an action whose desired state is already true returns a successful no-op only when tenant, hostname, environment, and relevant evidence agree; the no-op receives its own operation/audit evidence.

## 5. Persistence and idempotency

Add a strict `tenant_booking_hostname_operations` collection rather than overload provisioning-operation enums. Each document contains:

- `_id`, lowercase UUID `public_id`, and unique lowercase UUID `request_id`;
- `operation_type` from the command allowlist;
- SHA-256 `request_fingerprint` over operation type, environment, tenant public ID when applicable, normalized hostname, nonsecret command evidence, operator ID, and reason;
- operator ID, reason, environment, hostname public ID, tenant public ID;
- outcome (`completed`, `refused`, or `failed`), previous/new states, safe failure category;
- safe result metadata needed for deterministic replay, with Railway mapping/readiness fields explicitly named `operator_attested_*`;
- created/completed timestamps.

Indexes: unique `public_id`, unique `request_id`, lookup by hostname public ID/time, tenant/environment/time, and status/time. Validators remain strict and additive.

Each state mutation, operation record, and audit event is written in one majority/snapshot Mongo transaction. A duplicate request ID is replayed only when the fingerprint matches; otherwise return `request_id_mismatch`. After an ambiguous transaction error, re-read the operation and replay before reporting failure. DNS resolution occurs outside transactions; only its bounded, secret-free classification enters the transaction.

Challenge issuance needs special replay handling: the first successful CLI response is the only time plaintext exists, so an exact replay cannot reproduce the token. The operation persists the TXT record name and a redacted `challenge_issued` result, never the token. The CLI must clearly return `outcome: replayed, challenge_token_available: false` and direct the operator to issue a replacement challenge with a new request ID if the original output was lost. It must never silently rotate on replay.

## 6. Audit contract

Every completed, refused, or classified verification attempt writes one audit event with `actor_user_id: null`, tenant ObjectId, request ID, outcome, and string/null-only metadata. Event names:

- `booking_hostname.challenge_issued`
- `booking_hostname.verification_succeeded`
- `booking_hostname.verification_failed`
- `booking_hostname.provisioning_started`
- `booking_hostname.activated`
- `booking_hostname.deactivated`
- `booking_hostname.removal_started`
- `booking_hostname.removed`
- `booking_hostname.transition_refused`

Metadata includes operator ID, reason, hostname/tenant public IDs, normalized hostname, environment, operation type/outcome, previous/new state, safe failure code, and Railway/TLS status where relevant. It excludes the plaintext token, challenge hash, raw TXT answers, resolver messages, Mongo errors, credentials, and connection details.

## 7. Resolver and fallback invariants

PR 13B does not change hostname precedence or introduce cache/redirect logic. Only `active` custom records resolve publicly. `pending_verification`, `verified`, `provisioning`, `failed`, `disabled`, `removing`, and `removed` must render the existing unavailable experience when requested directly.

Before activation, after deactivation, during removal, after verification failures, and during every retry, the tenant’s canonical fallback remains resolvable according to its existing tenant/public-booking state. Disabling a custom domain must immediately cause `publicBookingOrigin()` to select the fallback for newly created outbox notices; already persisted notices retain their snapshotted origin by design.

## 8. Implementation shape

- Shared: reuse `normalizeHostname()` and administrative/root helpers; add only narrowly reusable custom-claim validation if both CLI input and service need it.
- API: add a `domain-management` module with input validation, DNS adapter interface, service/state machine, safe errors, and CLI integration.
- Store: keep public lookups in the existing `AdminStore`; domain-management writes use typed repository methods or a focused store, but never duplicate public resolution logic.
- Migration: evolve `tenant_booking_hostnames` additively only if required and add the strict operation collection/indexes. No destructive rewrite or new domain registry.
- Tests: unit tests inject clock, entropy, and DNS; integration tests use the isolated Mongo replica set and verify transactions, replay, races, validators, and indexes.
- Documentation: add an operator runbook containing the exact TXT instructions, manual Railway/TLS checkpoints, safe retry procedure, fallback checks, and rollback/deactivation procedure.

## 9. Required automated evidence

At minimum, tests must prove:

1. normalization, reserved/platform-root/apex/wildcard rejection, IDN canonical handling, environment isolation, and tenant association;
2. 256-bit token generation, bound hash format, token returned once, no plaintext persistence/audit/logging, expiry, and atomic replacement;
3. split TXT chunk handling, unrelated TXT handling, match/mismatch/not-found/transient classifications, constant-time digest comparison, and stale lookup protection;
4. verification never activates; every allowed and refused state transition; activation readiness preconditions; one-active-per-tenant enforcement under concurrency;
5. request replay, mismatched-fingerprint conflict, ambiguous-commit recovery, and transaction rollback at each evidence stage;
6. complete secret-free operation and audit evidence for successes, failures, refusals, and no-ops;
7. only active/current-environment custom hosts resolve; all other custom/unknown/admin/cross-environment hosts remain unavailable;
8. canonical fallback and repository-aware `publicBookingOrigin()` continuity through every lifecycle state;
9. notification origins remain snapshotted and the worker does not reconstruct tenant origins;
10. migration idempotency plus real Mongo validator and unique/partial-index enforcement;
11. existing canonical `pnpm verify`, Caddy proxy/security-header contracts, and all integration tests remain green.

## 10. Staging QA gate

Use a nonproduction subdomain and internal-QA tenant. Record commit SHA, operator/request IDs, timestamps, DNS queries, Railway/TLS observations, and sanitized command results.

1. Confirm staging environment/database/root pairing and canonical fallback availability before any domain action.
2. Issue a challenge; confirm only the customer-created TXT value is exposed and no plaintext token exists in Mongo/audit/log output.
3. Verify not-found and mismatch classifications without disrupting fallback.
4. Publish the correct TXT record and verify ownership; confirm the custom host is still unavailable.
5. Manually attach the domain in Railway, observe routing and a valid certificate, record provisioning evidence, then explicitly activate.
6. Confirm the custom host resolves only the intended tenant; exercise booking, confirmation email, management link, reschedule, cancellation, and released-slot reuse. Confirm admin and unknown hosts retain existing behavior.
7. Confirm the canonical fallback remains operational while the custom hostname is active.
8. Deactivate; confirm the custom hostname becomes unavailable immediately and fallback continues. Confirm newly queued notifications use fallback while previously queued origins remain unchanged.
9. Manually remove Railway mapping, complete removal, and confirm fallback, unknown-host safety, TLS/security headers on supported hosts, and Business Hub isolation.
10. Replay representative request IDs and confirm deterministic, secret-free results; reuse one request ID with changed input and confirm `request_id_mismatch` with no mutation.

Production rollout is blocked until automated evidence and the full staging gate pass. The operational rollback for a faulty activation is the audited `deactivate` command; application rollback must not reactivate a disabled hostname or remove the canonical fallback.

## 11. Acceptance gate

PR 13B is complete only when the implementation matches this contract, no excluded automation is introduced, all automated checks pass with zero unexplained skips, staging QA passes, the operator runbook is usable without source-code interpretation, and the canonical fallback is demonstrated continuously available across the entire domain lifecycle.

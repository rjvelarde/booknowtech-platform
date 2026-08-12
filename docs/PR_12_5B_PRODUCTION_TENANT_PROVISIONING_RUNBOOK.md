# PR 12.5B audited tenant provisioning runbook

This runbook closes PR 12.5B. The supported interface is the restricted `tenant-provision` CLI run
inside the Railway API service. It does not authorize production execution by itself. Production
provisioning requires separate documented approval after merge and staging acceptance.

## Preconditions and evidence

Record the approved operator identity, reason, designation, tenant and initial-owner details,
immutable application SHA, environment, database name, and current API/frontend/worker deployment
IDs outside this repository. Use a unique normalized owner email that is not already in `users`.

Confirm the API service has its normal validated environment plus:

- `ENVIRONMENT_ID` and `RAILWAY_ENVIRONMENT_NAME` matching the target environment;
- the target environment's `MONGODB_URI`, `MONGODB_DATABASE`, `BOOKING_ROOT_DOMAIN`, and admin origin;
- an immutable `RAILWAY_GIT_COMMIT_SHA` from the approved deployment;
- no development seed variables in production.

Never pass or persist Atlas credentials, Postmark tokens, application secrets, or a password in the
JSON input, command arguments, logs, screenshots, audit records, or onboarding evidence.

## Input and dry validation

Prepare a mode-appropriate temporary JSON file in the Railway API console. It contains business,
contact, locale, designation, and initial-owner identity only. Use `designation: customer` unless
the approved purpose explicitly requires `internal_qa`. Do not include a password.

Generate and record a UUID. Dry validation constructs no Mongo client:

```bash
PROVISIONING_APPROVED=true \
PROVISIONING_OPERATOR_ID="approved.operator" \
PROVISIONING_REASON="Documented approval reason of at least ten characters." \
pnpm --filter @booknowtech/api tenant-provision -- \
  create --request-id "REPLACE-UUID" --input /tmp/tenant.json --dry-validate
```

Confirm the redacted result has the intended slug, fallback hostname, and environment. A fallback
hostname must use only the target environment's canonical root domain.

## Create and first login

Run the same command without `--dry-validate`, retaining the same approved operator and reason but
using a new request ID for the actual create operation. Enter the temporary password only at the
masked TTY prompts. Record the request ID, returned tenant/owner public IDs, fallback hostname,
deployment SHA, timestamp, and outcome. Repeating the exact request with the same ID must replay the
committed public result; changed input with that ID must fail safely.

Transfer the temporary password through the approved out-of-band channel. The owner must sign in and
replace it immediately. Confirm tenant navigation is unavailable before replacement and available
afterward. Do not email or record the temporary password.

Configure profile, service, provider assignment, availability, email, and self-service through the
existing Business Hub operations. Creation and reactivation leave public booking disabled. Enable
it only through the existing setting after explicit launch approval.

## Status operations

Use a new request ID per intended state change:

```bash
PROVISIONING_APPROVED=true \
PROVISIONING_OPERATOR_ID="approved.operator" \
PROVISIONING_REASON="Documented status-change approval reason." \
pnpm --filter @booknowtech/api tenant-provision -- \
  set-status --request-id "REPLACE-UUID" --tenant "tenant-slug" --status suspended
```

Suspension disables public booking, suspends active tenant roles, and revokes selected sessions and
active appointment-management tokens. It preserves business data and evidence. Reactivation uses
`--status active`, restores only roles suspended by the tenant-status operation, and never
automatically republishes public booking.

## Internal-QA cleanup

Only tenants created with `designation: internal_qa` are eligible:

```bash
PROVISIONING_APPROVED=true \
PROVISIONING_OPERATOR_ID="approved.operator" \
PROVISIONING_REASON="Documented internal QA cleanup approval reason." \
pnpm --filter @booknowtech/api tenant-provision -- \
  deactivate-internal-qa --request-id "REPLACE-UUID" --tenant "tenant-slug"
```

Cleanup refuses while scheduled appointments remain. Handle them through the existing appointment
lifecycle; never edit or delete them directly. Successful cleanup must report zero active
appointments, tokens, sessions, and pending/processing outbox records. It disables public booking,
email, and self-service, suspends the tenant and roles, revokes access, and conditionally moves
pending or stale-processing QA outbox work to terminal `failed` with
`last_error_code=internal_qa_deactivated`. Delivered notifications and all lifecycle/audit evidence
remain intact.

## Staging QA checklist

- [x] Dedicated `internal_qa` tenant created with public booking initially disabled.
- [x] Mandatory first-login password replacement enforced and completed.
- [x] Existing customer tenant suspension hid its membership, revoked sessions, disabled public
      booking, preserved appointments, replayed the same request, rejected changed-input reuse, and
      restored only the intended role without republishing.
- [x] Non-internal-QA cleanup rejected with `tenant_designation_conflict`.
- [x] Internal-QA booking, confirmation email, management link, and cancellation lifecycle exercised.
- [x] Cleanup refusal retained an active tenant with two scheduled appointments, one active token,
      one active session, and replayed without mutation.
- [x] Both appointments cancelled through supported lifecycle operations and evidence retained.
- [x] Final cleanup suspended the tenant and role, revoked two sessions, and reported all four final
      verification counts as zero.
- [x] CI directly exercised terminal outbox failure/reclaim prevention and active token revocation;
      manual cleanup observed zero for both because the worker/token lifecycle completed first.
- [x] No plaintext password, credential, token, connection string, or secret appeared in captured
      CLI output or application evidence.

Staging cleanup request IDs and screenshots belong in the approved external evidence repository,
not in source control.

## Production QA checklist (manual after merge and approval)

- [ ] Record explicit production approval, immutable SHA, deployment IDs, operator, and reason.
- [ ] Verify production guards and absence of development seed variables before Mongo construction.
- [ ] Dry-validate `BookNowTech Internal QA` with `designation: internal_qa` and the production root.
- [ ] Create once and replay the same request; verify safe conflict handling and one evidence chain.
- [ ] Verify public booking starts disabled and no business objects beyond tenant/owner/role are made.
- [ ] Complete forced password replacement and confirm prior sessions rotate/revoke.
- [ ] Configure through Business Hub, explicitly publish, and exercise booking, delivery, management,
      reschedule/rotated-link, cancellation, and cancellation-email flows on production fallback hosts
      and production Postmark.
- [ ] Exercise cleanup refusal before lifecycle completion, then supported cleanup afterward.
- [ ] Verify zero active appointments/tokens/sessions/pending-or-processing outbox work, tenant
      unavailability, terminal undelivered QA work, and retained delivered/lifecycle/audit evidence.
- [ ] Verify logs and persisted evidence contain no plaintext password or secret.
- [ ] Do not provision the first customer until production QA evidence is approved.

## Migration and deployment

Before enabling the CLI on a target environment, record deployment IDs and run once from the API
service:

```bash
pnpm --filter @booknowtech/api db:migrate
```

The migration is additive and repeatable. It applies tenant/user/role/provisioning validators and
indexes plus the session, appointment-token, and tenant-outbox cleanup indexes. Deploy API,
frontend, and worker from the same approved SHA. Provisioning creates no infrastructure, domain,
service, provider, schedule, customer, or appointment.

## Rollback

Stop new provisioning first. Suspend and keep non-public any tenant already created. Roll back the
application services to the recorded common known-good revision. Do not drop or rewrite additive
fields, validators, indexes, provisioning operations, appointments, outbox history, or audit logs.
Do not repair through ad hoc Atlas edits; use supported known-good tooling or a separately reviewed
incident procedure.

## Explicit exclusions

This release does not add tenant deletion, public signup, invitations, account recovery,
subscriptions/payments, custom domains or DNS/SSL automation, platform-operator HTTP/UI surfaces,
general membership management, seed/copy operations, new appointment lifecycle, new notification
lifecycle, or infrastructure changes.

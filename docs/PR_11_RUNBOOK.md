# PR 11 staging runbook

PR 11 adds transactional appointment email processing to the existing worker. It adds no Railway service, queue, cache, domain, or public route.

## Railway worker variables

Set these only on `@booknowtech/worker`:

- `MONGODB_URI`: the existing Atlas staging URI.
- `MONGODB_DATABASE`: `booknowtech_staging`.
- `TRANSACTIONAL_EMAIL_PROVIDER`: `postmark`.
- `TRANSACTIONAL_EMAIL_TOKEN`: the nonproduction Postmark server token.
- `TRANSACTIONAL_EMAIL_FROM`: a verified staging sender address.

Never add the provider token to the frontend or API service. Deploy API and worker from the same commit after applying the migration.

## Rollout

1. Keep every tenant's appointment email setting disabled.
2. Run `pnpm --filter @booknowtech/api db:migrate` once; confirm `notification_outbox` and its indexes exist.
3. Deploy API, worker, and frontend from the same revision.
4. Enable appointment emails only for the Brazilian Wax staging tenant.
5. Create, reschedule, and cancel a staging appointment that has a customer email.
6. Confirm one outbox record per actual lifecycle change, the worker logs only notification IDs, and Business Hub shows `Sent` after provider acceptance.
7. Confirm an idempotent cancellation retry creates no second notification.

## Rollback

Disable appointment emails for every tenant first. Roll back API, frontend, and worker to the prior common revision. Retain the outbox collection for diagnosis; do not delete records. Pending records remain inert while the prior worker is running.

## Atlas verification

In `notification_outbox`, filter by an appointment reference:

```json
{ "appointment_reference": "BNT-REPLACE" }
```

Verify immutable template data, attempt count, internal delivery state, and timestamps. Customer email addresses and provider responses must not appear in application logs or audit metadata.

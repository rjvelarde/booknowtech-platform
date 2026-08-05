# PR 12.5A Shared Production Rate Limiter Runbook

## Scope

This runbook covers the MongoDB-backed fixed-window limiter for admin login and anonymous public
routes. It does not change booking, scheduling, authentication, host routing, Railway structure, or
environment separation.

## Required API variable

Set `RATE_LIMIT_KEY_SECRET` on the API service only. Generate at least 32 cryptographically random
bytes, for example:

```bash
openssl rand -base64 48
```

Use the same value for every API replica in the environment. Never place it on the frontend or
worker. Rotation starts fresh rate-limit buckets and is a controlled abuse-control reset.

## Storage contract

Migration creates `request_rate_limits` with strict validation, unique bucket identity
`{ scope, tenant_key, subject_hash, bucket_started_at }`, and TTL cleanup on `expires_at`. The bucket
timestamp—not TTL deletion—determines correctness. Documents expire at two window lengths.

Subjects are HMAC-SHA-256 values. Documents and metrics must never contain raw IP addresses, email
addresses, phone numbers, credentials, appointment tokens, or token hashes.

## Initial policies

| Surface                       | Limit | Window     | Safe rejection code          |
| ----------------------------- | ----: | ---------- | ---------------------------- |
| Admin login by IP             |    20 | 15 minutes | `rate_limited`               |
| Failed admin login by account |     5 | 15 minutes | `rate_limited`               |
| Public discovery/catalog      |   120 | 1 minute   | `public_rate_limit_exceeded` |
| Public availability           |    60 | 1 minute   | `public_rate_limit_exceeded` |
| Public appointment creation   |    10 | 10 minutes | `public_rate_limit_exceeded` |
| Management read               |    30 | 1 minute   | `rate_limit_exceeded`        |
| Management availability       |    30 | 1 minute   | `rate_limit_exceeded`        |
| Management mutation           |    10 | 10 minutes | `rate_limit_exceeded`        |

Every `429` includes an integer `Retry-After` equal to the seconds remaining in the fixed window.
Mongo evaluation failures return a safe `503`; anonymous traffic never bypasses the limiter.

## Railway rollout

1. Add `RATE_LIMIT_KEY_SECRET` to the API service without exposing its value in screenshots or logs.
2. Run the database migration once before deploying the API.
3. Confirm `request_rate_limits_bucket_unique` and `request_rate_limits_expiry_ttl` exist.
4. Deploy one API replica and exercise the staging checklist below.
5. Scale to two replicas and repeat a limited request burst; the combined accepted count must not
   exceed the configured limit.
6. Restart or redeploy one replica during a live bucket and confirm the count does not reset.

## Staging QA

- [ ] Normal admin login succeeds and successful logins do not consume the account-failure limit.
- [ ] Repeated failed login returns the existing generic `429` envelope and integer `Retry-After`.
- [ ] Public discovery, availability, appointment creation, management read, availability,
      reschedule, and cancellation work below their limits.
- [ ] A controlled burst above each representative limit returns the documented safe code without
      identifying whether a tenant, account, appointment, or token exists.
- [ ] The same subject across two API replicas shares one counter.
- [ ] Restarting one replica does not reset a live counter.
- [ ] A new fixed window accepts requests even if the previous document has not yet been TTL-deleted.
- [ ] `rate_limit.checked` metrics contain only `scope` and bounded `outcome` values.
- [ ] Mongo documents contain only HMAC subject hashes and bounded tenant keys.
- [ ] No raw IP, email, phone, credential, token, cookie, or authorization value appears in limiter
      documents, metrics, or application logs.

## Failure and rollback

If Mongo latency or false rejection is unacceptable, redeploy the previous API image. Do not add an
in-process bypass and do not remove the secret or indexes as a workaround. Existing limiter
documents are safe to retain until TTL cleanup; they contain no raw subjects. No frontend, worker,
Mongo schema rollback, or Railway restructuring is required.

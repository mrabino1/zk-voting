# Platform super-admin API

Internal only. This file is not part of the public docs set, the bot catalog, OpenAPI, the README, or any docs build. Do not link it from the UI or from `docs/*.md` outside `docs/internal/`.

Base path: `/api/_sa/v1/`.

A missing, invalid, expired, or revoked key, an IP allowlist miss, a missing scope, a missing super-admin session, a CSRF failure, or a stale step-up all return HTTP 404 `{ "error": "not found", "nfp": true }`. The specific reason is written to the audit log and is not returned. Rate limit on an otherwise valid key returns HTTP 429. An authorized mutation while this process is standby returns HTTP 503 `STANDBY`.

## Session gate for key management

Key create, list, get, revoke, and rotate accept only a signed-in `platform_super_admin` cookie session.

- Cookie: `zk-voting.sid` (HttpOnly, SameSite=Lax), issued by the normal sign-in paths.
- CSRF: `GET /api/_sa/v1/session` returns `csrfToken`. State-changing key routes, and key list/get, require header `x-csrf-token` equal to that value. A cross-site `Sec-Fetch-Site` is rejected. An `Origin` header, when present, must be one of the configured origins.
- Step-up: the session's `stepUpAt` (set at sign-in) must be inside `SUPER_ADMIN_STEP_UP_MS` (default 15 minutes, minimum 60 seconds). `POST /api/_sa/v1/step-up` with the CSRF header refreshes it. This is the same session a super admin already holds; it does not accept a key.

A key cannot call these routes, even if the same request also has a session cookie. `apikeys` is not a grantable scope.

## Keys

`POST /api/_sa/v1/keys`

```json
{
  "name": "oncall health",
  "scopes": ["read:health"],
  "expiresIn": "24h",
  "ipAllowlist": ["127.0.0.0/8"],
  "rateLimit": { "limit": 60, "windowSeconds": 60 }
}
```

`expiresIn`: `1h`, `24h`, `7d`, `30d`, `90d`, or `never`. `never` requires `allowNeverExpires: true`. Omitted expiry defaults to 30 days. An explicit `expiresAt` ISO timestamp is accepted when `expiresIn` is omitted, must be in the future, and is capped at 10 years.

The token `zksa_<keyId>_<secret>` is returned once (`shownOnce: true`). `keyId` is 16 hex characters. `secret` is 32 random bytes, base64url. Only SHA-256 of the secret is stored, or HMAC-SHA-256 when `SUPER_ADMIN_API_PEPPER` is set. Comparison is constant-time. The token is never written to the audit log or the diagnostic log tail.

Send it as `Authorization: Bearer <token>`. There is no server-side auth cache: revoke updates the store before the response, and a standby process re-reads the key row from disk on every request.

`GET /api/_sa/v1/keys` and `GET /api/_sa/v1/keys/:id` return `id`, `name`, `scopes`, `createdAt`, `expiresAt`, `lastUsedAt`, masked `lastUsedIp`, and `status` (`active`, `expired`, `revoked`).

`POST /api/_sa/v1/keys/:id/revoke` is immediate.

`POST /api/_sa/v1/keys/:id/rotate` revokes the current key and returns a new token once, copying scopes, allowlist, and rate limit. A revoked key cannot be rotated.

## Scopes

Deny by default. A key holds an explicit list. There is no wildcard. Write does not imply read. A key may be read-only, write-only, or both.

| Resource | Read | Write |
| --- | --- | --- |
| health | `read:health` grantable | `write:health` reserved, not grantable, no route |
| config | `read:config` grantable | `write:config` grantable |
| store | `read:store` grantable | `write:store` reserved, not grantable, no route |
| elections | `read:elections` grantable | `write:elections` grantable |
| users | `read:users` grantable | `write:users` grantable |
| l2 | `read:l2` grantable | `write:l2` grantable |
| l1 | `read:l1` grantable | `write:l1` reserved, not grantable, no route |
| mail | `read:mail` grantable | `write:mail` grantable |
| logs | `read:logs` grantable | `write:logs` grantable |
| audit | `read:audit` grantable | none (the log is append-only) |
| apikeys | session only | session only |

Reserved names exist so a later change can implement them without adding a wildcard. Nothing in this API deploys or redeploys L1 contracts.

A signed-in super admin session may call the grantable read and write routes (writes still need CSRF and a fresh step-up). It still cannot mint scopes outside this table.

### Read routes

| Scope | Method and path | Returns |
| --- | --- | --- |
| `read:health` | `GET /health` | version, schema version, build, uptime, mode, lease holder |
| `read:config` | `GET /config` | non-secret effective config; secret fields are booleans `*Set` |
| `read:store` | `GET /store` | aggregate counts and schema version |
| `read:elections` | `GET /elections`, `GET /elections/:id` | election and poll metadata: ids, status, timestamps, eligible and cast counts, flags. No ballots, choices, or eligibility lists |
| `read:users` | `GET /users`, `GET /users/:handle` | handle, role, status, createdAt, masked email, passkey count |
| `read:l2` | `GET /l2` | explorer height, lag, archive index summary, hash-check summary, node lease mode. Sequencer and prover are not attached to this process |
| `read:l1` | `GET /l1` | public contract addresses, deployment-record status, settlement status counts. No publisher key |
| `read:mail` | `GET /mail` | SES configured flags and send/failure counts. No bodies or recipients |
| `read:logs` | `GET /logs` | bounded redacted tail |
| `read:audit` | `GET /audit`, `GET /audit/verify` | audit page and hash-chain check |

`GET /audit` filters: `keyId`, `sessionUser`, `from`, `to`, `result` (`success`, `failure`, or a status code), `after` (seq cursor), `limit` (max 200).

### Write routes

Every write accepts `dryRun=1` (query or body). Dry-run returns the projected after-summary and does not persist. Each write is audited with a before/after summary that contains no secrets. Repeating a pause, an already-cleared terms flag, or the same role is idempotent.

| Scope | Method and path | Effect |
| --- | --- | --- |
| `write:config` | `POST /config` | Allowlist only: `feedbackRateWindowSeconds` (minimum 3600), `logLevel` (`error`, `warn`, `info`, `debug`), `archiveEnabled` (boolean operator flag recorded by this Node). Any other field is rejected. Secrets, keys, and the pepper cannot be set |
| `write:mail` | `POST /mail/test` | Sends a fixed test message to the platform super admin contact email only. No recipient or body is accepted |
| `write:mail` | `POST /mail/resend-terms` | `{ "handle" }` clears `termsNotifiedHash` so the next sign-in can send the terms notice again. It does not send arbitrary mail |
| `write:users` | `POST /users/:handle/suspend` and `/unsuspend` | Suspend drops that person's sessions. A platform super admin cannot be suspended here |
| `write:users` | `POST /users/:handle/role` | `{ "role" }` must be an existing role other than `platform_super_admin`. Cannot promote to or demote from `platform_super_admin`. Does not create users |
| `write:users` | `POST /users/:handle/sessions/revoke` | Deletes that handle's sessions. Does not return session ids |
| `write:elections` | `POST /elections/:id/lifecycle` | `{ "action": "pause" \| "resume" \| "close" \| "extend", "cutoffTime" }`. Pause sets a metadata hold that ballot submit honors. Close moves `cutoffTime` to now. Extend moves `cutoffTime` later. No ballots, eligibility, tallies, or disqualification records |
| `write:l2` | `POST /l2/archive` | Runs the archive job against this Node's data directory with object-store credentials blanked. Without a bucket it skips and does not prune. It does not seal blocks |
| `write:l2` | `POST /l2/verify` | SHA-256 of local block files, compared with the previous baseline. Digests are not returned |
| `write:l2` | `POST /l2/heartbeat` | Renews this Node's writer lease when this process holds it. `chainSealed` is always false |
| `write:logs` | `POST /logs/level` | `{ "level" }` same set as config log level |

`write:store`, `write:l1`, and `write:health` are reserved and rejected at key creation.

## Audit and the writer lease

Every call, including auth failures, appends a hash-chained row: timestamp, key id or session handle, method, path, scope, result code, source IP, user agent, request id, and for writes a before/after summary. The hash is SHA-256 of the previous hash plus a canonical JSON body. `GET /audit/verify` walks the chain and reports tampering.

Only the active writer appends to that chain or updates `lastUsedAt`, and it does so before the HTTP response. A standby process does not mutate `zk-voting.json`. It keeps a process-local side log (`standbyLocalCount` on `GET /audit`) that is not part of the verifiable chain and is discarded when the process exits. Key authentication on standby re-reads the key row from disk, so a revoke by the writer is visible on the next request without a standby write. Authorized writes on standby return HTTP 503 `STANDBY` with `Retry-After: 2`. Auth failures on standby stay HTTP 404.

## Hard exclusions

No route, field, or log line may reveal or allow reconstructing ballot secrecy or voter identity. That includes ballots, votes, choices, nullifiers tied to a person, identity commitments, voter-to-ballot mappings, registration lists, proofs, witnesses, guardian or ceremony keys, session cookies, passkey credentials, API keys, SES or AWS credentials, and the full `SUPER_ADMIN_EMAIL`. Responses are passed through a redaction scanner before they are sent. The one-time `token` field exists only on create and rotate.

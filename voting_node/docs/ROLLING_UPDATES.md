# Rolling updates

NOT FOR PROFIT. This is the handover used when Coolify (or any other runner) starts the new
**Node** container before it stops the old one. Old and new share one data volume on one host.
Only one of them writes.

The **L2 operator** is not overlapped: it has no writer lease. Recreate its container (stop, then
start). While it is down the Node answers ballot requests with 503 and voters retry; nothing is
lost, because ballots the operator had accepted are in its state file and everything committed
is on L1.

## Failure modes

| Overlap | What goes wrong | What this repo does |
| --- | --- | --- |
| Two Node writers | Torn store, duplicate votes or registrations | Node lease. Mutations on the standby return HTTP 503 |
| Two rollup ticks | Two closes or two finalizes sent to L1 | Only the lease holder runs the rollup tick; L1 refuses a second close or finalize anyway |
| Crash, no SIGTERM | The lock directory is left behind | Steal after the lease TTL (default 8s) and bump the fencing epoch |
| Healthcheck that fails while standby | Coolify never marks the new container healthy, so it never stops the old one | `/health` is HTTP 200 with `ok: true` for active and standby |
| Two operators | Conflicting batches on L1 | Not supported. Run one operator; L1 accepts only batches that extend the committed chain |

File locks only work when both containers mount the **same** Docker volume on the **same** host.
They do not coordinate two hosts, and they are not reliable on NFS. If the volume cannot be
shared, stop the old container first.

## Lease

`l2/lease/lease.mjs` is the lock. `mkdir` of `dataDir/leases/node.lock` is the atomic acquire. The
owner file records `ownerId`, `epoch`, `pid`, `heartbeat` and `ttlMs`; the epoch file is
`leases/node.epoch`.

A new container that cannot get the lease starts **standby**:

- It serves reads.
- `/health` stays ready (`ok: true`, `mode: "standby"`).
- It does not mutate the store or run the rollup tick.
- It polls about once a second.

The old container, on SIGTERM, stops accepting new writes, finishes in-flight writes, deletes the
lock directory and exits 0 within `stop_grace_period: 30s`. A graceful release does **not** bump
the epoch. A crashed holder is taken over after the TTL: the steal renames the lock directory
aside (only one rename wins), bumps the epoch and creates a new lock. Writes call `assertFence()`;
a stale owner is rejected.

## Idempotency

- A second ballot for the same nullifier is rejected (`NULLIFIER_USED`, HTTP 409). After the
  cutoff the code is `CLOSED`. Standby mutations are HTTP 503 `STANDBY` with `Retry-After: 2`.
- A vote pass is recorded in the poll book before its signature is returned, so a handover cannot
  issue a second pass.
- L1 calls the tick makes (roll sync, close, finalize) are refused by the contract when they have
  already happened.

## Health

Do not require `mode=active` in the healthcheck. Both modes are success.

```json
{"ok":true,"ready":true,"mode":"active","acceptingWrites":true,"epoch":1}
```

`mode` is `active` or `standby`; the header is `x-zk-voting-mode`. Clients
(`apps/node/public/standby-retry.js` and the classic pages) retry HTTP 503 a few times, honoring
`Retry-After` (capped at 5s). The voter sees a short pause.

## Coolify settings

Apply these on the `node` service.

| Setting | Value |
| --- | --- |
| Update strategy | Rolling update: start the new container, wait until it is healthy, then SIGTERM the old one |
| Health path | `http://127.0.0.1:3000/health` |
| Health success | HTTP 200 and `ok` is not `false`. This matches active **and** standby |
| Do not | Require `mode=active`, or treat standby as unhealthy |
| Stop grace | 30 seconds (`stop_grace_period: 30s` in `docker-compose.yml`) |
| Health interval / start period | Interval 10s, `start_period` 25s, retries 12 |
| Volumes | The existing `node-data` volume, shared by old and new during the overlap. Not a fresh volume per container |
| One host | Required. Two hosts do not share this file lock. Use stop-then-start instead |

For the `l2` service use stop-then-start.

`docker-compose.rolling.yml` is the overlap smoke: `node-next` on host port 3001, same volume. The
first container stays `mode: "active"`; the second stays `mode: "standby"` and still returns
HTTP 200.

## The rollup contract

ZkVotingRollup is deployed **once** per chain ([`L2_VPS_SETUP.md`](./L2_VPS_SETUP.md)). Container
start and a rolling update only read its address; nothing in a container deploys it.

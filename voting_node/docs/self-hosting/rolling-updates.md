# Rolling updates

**NOT FOR PROFIT** — civic public good. Not a commercial product.

A rolling update starts the new container, waits until it is healthy, then stops the old one. zk-voting supports this on **one host**.

## How it stays safe

- Old and new Node containers mount the **same** `node-data` volume.
- The Node takes a file **writer lease** before writing.
- The L2 operator has no writer lease, so it is not overlapped: recreate its container instead. While it is down the Node answers ballot requests with 503 and voters retry.
- The new container starts in **standby**: `/health` returns HTTP 200 with `"mode":"standby"`. It serves reads and answers writes with HTTP 503 `maintenance handover` and `Retry-After: 2`. The web app retries those automatically.
- On `SIGTERM` the old container flushes, releases the lease, and exits within `stop_grace_period: 30s`. The standby takes over. If the old one crashes, the lease expires after `WRITER_LEASE_TTL_MS` (default 8 seconds).

## Coolify settings

| Setting | Value |
| --- | --- |
| Strategy | Rolling update (start new, wait healthy, stop old) |
| Node health | `http://127.0.0.1:3000/health`, HTTP 200 |
| Grace period | 30 seconds |
| Volumes | The existing `node-data`, not a new volume |

Never require `mode=active` in a probe.

## Not supported

- **Two hosts.** File leases do not cross machines. Stop the old host before starting a new one.
- **Different volumes per container.** Both containers must see the same files.

## Try it locally

`docker-compose.rolling.yml` starts a second Node (`node-next`, port 3001) on the same volume:

```bash
docker compose up -d --build     # the normal stack first
docker compose -f docker-compose.yml -f docker-compose.rolling.yml up -d --no-build node-next
curl -fsS http://127.0.0.1:3001/health   # "mode":"standby"
docker compose stop node                 # node-next takes the lease
```

Failure modes and fencing: `docs/ROLLING_UPDATES.md`.

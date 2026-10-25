# Health checks

**NOT FOR PROFIT** — civic public good. Not a commercial product.

## Endpoints

| Service | URL | Healthy |
| --- | --- | --- |
| `node` | `GET http://127.0.0.1:3000/health` (also `/api/health`) | HTTP 200 and `"ok": true` |
| `l2` | `GET http://127.0.0.1:8546/health` | HTTP 200 and `"ok": true` |
| `tailscale` (optional) | `GET http://127.0.0.1:9002/healthz` inside the sidecar | HTTP 200 once the node has a tailnet IP |

## What `/health` returns

```json
{
  "ok": true,
  "ready": true,
  "mode": "active",
  "acceptingWrites": true,
  "app": "zk-voting",
  "chainId": 27427,
  "voteFqdn": "vote.example.org",
  "chainConfigured": true,
  "disclosure": { "...": "..." }
}
```

- `mode` is `active` for the process that holds the writer lease and `standby` for a second process waiting to take over during a rolling update. **Both are healthy.** A standby serves reads and answers writes with HTTP 503 and `Retry-After: 2`.
- The response header `x-republic-mode` carries the same value.

## Built-in probes

The image and both Compose files already define health checks, so you normally do not need to configure anything:

```yaml
healthcheck:
  test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
  interval: 10s
  timeout: 5s
  retries: 12
  start_period: 25s
```

The image also installs `curl` and `wget`, because some platforms (Coolify) run their own `curl ... || wget ...` probe inside the container.

## Rules for PaaS probes

- Path `/health`, port `3000`, success = HTTP 200.
- Never require `mode=active`. During a rolling update the new container is `standby` until the old one exits, so that rule deadlocks the rollout.
- Give the first boot at least 25 seconds (`start_period`).

## Monitoring

Point an uptime monitor at `https://vote.example.org/health`. Alert on non-200 responses or `"ok": false`. Watch disk space on the `l2-data` volume; enable the [archive](./configuration.md#archive-s3--r2) to keep it bounded.

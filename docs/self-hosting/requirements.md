# Requirements

**NOT FOR PROFIT** — civic public good. Not a commercial product.

## Host

| Size | CPU | Memory | Disk | Good for |
| --- | --- | --- | --- | --- |
| Demo / evaluation | 1 vCPU | 1 GB | 5 GB | Trying the app on a laptop or a small VPS. |
| Small jurisdiction | 2 vCPU | 2 GB | 20 GB | A club, school, or town with thousands of voters. |
| Large jurisdiction | 4+ vCPU | 4+ GB | 50+ GB SSD | Tens of thousands of voters; see `docs/LOAD_TEST.md`. |

The production image boots with a 384 MB memory cap in CI. Leave headroom for the L2 sequencer and prover.

## Software

- Linux host with **Docker Engine 24+** and the **Compose v2** plugin (`docker compose`, not `docker-compose`).
- Git, to clone the repository.
- No database server. No Redis. The Node writes one JSON file on a Docker volume.
- To develop without Docker: **Node.js 22** (22.23.4 or newer) and npm.

## Network

| Port | Service | Expose publicly? |
| --- | --- | --- |
| 3000 | `node` web app and API | Only behind a TLS reverse proxy (Coolify, Caddy, nginx, Traefik) or the Tailscale sidecar. |
| 8546 | `l2` JSON-RPC | No. Keep it on the Compose network or `127.0.0.1`. |
| 443 | your reverse proxy | Yes, for a public voting site. |

## Domain and HTTPS

Passkeys (WebAuthn) only work on **HTTPS** origins, or on `localhost` for a demo.

- Pick a voting hostname you control, for example `vote.example.org`, and point DNS at the host.
- Set `VOTE_FQDN=vote.example.org`. The Node derives the passkey relying party, allowed origin, and the links printed on official PDFs from it.
- Terminate TLS in front of the Node. Coolify, Dokploy, and CapRover do this for you. The [Tailscale sidecar](./tailscale.md) can also issue a certificate for a `*.ts.net` name.

## Email (optional for a demo, required in production)

Sign-in MFA and Terms PDFs are sent through **AWS SES** (or an SES-compatible endpoint). Leave the SES variables empty for a local demo: no mail is sent.

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
- No Redis. Node application state is either JSON files on a persistent volume or Postgres via `DATABASE_URL`. See [Storage](#storage).
- To develop without Docker: **Node.js 24.7** or newer and npm.

## Storage

The Node keeps its working set in memory and persists it to one backend, chosen when the process starts. Leave `DATABASE_URL` empty for the default JSON files. Set `DATABASE_URL` to use Postgres. The process logs which backend it opened, and `/health` reports it as `db.backend` (`json` or `postgres`). Names and defaults for each variable are in the [configuration reference](./configuration.md#storage).

### JSON files on a persistent volume

This is the default. With `DATABASE_URL` empty, the Node writes application state as files under `DATA_DIR`. The image uses `/data` for that directory, and Compose mounts the `node-data` volume there. The code takes this path whenever Postgres is not configured, including local development.

| Path under `DATA_DIR` | What it holds |
| --- | --- |
| `zk-voting.json` | Accounts and passkeys, sessions, elections, registrations, ballots, receipts, ceremony metadata, site settings, plugin state. |
| `l2-chain.json` | Explorer chain. |
| `chain-vote-queue.json` | Ballot submission queue. On this backend that file is the live queue; a copy is also kept inside `zk-voting.json`. |
| `receipt-pdf.secret` | Key for locked receipt and outcome PDFs. Created when `RECEIPT_PDF_SECRET` is empty. |
| `vote-pass.key.json` | Vote-pass signing key. Created on first use when `VOTE_PASS_RSA_JWK` is empty. |

Keep the `node-data` volume, or another persistent mount on `DATA_DIR`. That directory is the copy that survives a restart and a replacement container.

### Postgres via `DATABASE_URL`

Set `DATABASE_URL` to a Postgres connection string (`postgres://` or `postgresql://`). Add `sslmode=require` when the server expects TLS. Use Postgres for any deployment that does not give the Node a persistent volume, so application state survives a container whose disk is discarded on redeploy. You run the database server yourself. Compose forwards `DATABASE_URL` to the `node` service; the database runs outside that file. Treat the URL as a secret: keep it out of git and out of the image.

On boot the Node creates its tables (`zkv_*`) and applies idempotent migrations. From then on it stores the same records as rows: the store document, the explorer chain, the ballot queue, and secrets such as the receipt PDF key (`zkv_secrets`).

The first boot against an empty database imports three files from `DATA_DIR` once: `zk-voting.json` (the store, including any ballot-queue fields saved inside it), `l2-chain.json`, and `receipt-pdf.secret`. Later boots read the database. The files stay on disk as the leftover of that import. `chain-vote-queue.json` is not part of the import, so a queue that exists only in that sidecar is not carried over. `vote-pass.key.json` is not imported either; the first vote-pass on Postgres creates a new key in `zkv_secrets`.

`DATA_DIR` still holds ceremony artifacts (`ceremonies/`, `ceremony-inputs/`), plugin uploads (`plugins/`), and the writer lease (`leases/`). Mount a volume there when those files must survive a redeploy. A rolling update that overlaps two Node containers on one host shares that volume so they can take the writer lease, which is a lock on the local filesystem. Application state follows `DATABASE_URL` and remains in Postgres whether or not that volume is present.

When `DATABASE_URL` is set and Postgres cannot be reached, `/health` returns HTTP 503 and `db.ok` is false.

The L2 sequencer, prover, and archive keep chain data as files on the `l2-data` volume. That store is separate from the Node backend described here.

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

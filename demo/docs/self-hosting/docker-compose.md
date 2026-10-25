# Docker Compose quickstart

**NOT FOR PROFIT** — civic public good. Not a commercial product.

This is the fastest way to run a complete zk-voting Node (web app, API, civic L2, prover, archive) on one machine.

## 1. Clone and configure

```bash
git clone https://github.com/<your-org>/zk-voting.git
cd zk-voting
cp .env.example .env
```

Replace `<your-org>` with the organization you forked into. `.env` is gitignored. The defaults in `.env.example` run a **local demo**: no outbound mail, passkeys on `localhost`, mock proofs on the L2.

For anything public, set at least:

```env
VOTE_FQDN=vote.example.org        # bare hostname you control, no https://
SUPER_ADMIN_EMAIL=clerk@example.org
EXPLORER_INGEST_SECRET=<long random string>
RECEIPT_PDF_SECRET=<long random string>
```

Generate random values with `openssl rand -hex 32`. See the [configuration reference](./configuration.md) for every variable.

## 2. Start

```bash
docker compose up -d --build
```

The first build installs npm workspaces inside the image and takes a few minutes. Later starts reuse the cached layers.

## 3. Check health

```bash
curl -fsS http://127.0.0.1:3000/health
curl -fsS http://127.0.0.1:8546/health
docker compose ps
```

Both return JSON with `"ok": true`. `docker compose ps` should show `node` and `l2` as `healthy`. Details: [Health checks](./health-checks.md).

## 4. Open the app

Open `http://localhost:3000`. Continue with [First launch](./first-launch.md) to register the first administrator.

## Everyday commands

```bash
docker compose logs -f node      # follow the web app logs
docker compose restart node      # restart one service
docker compose down              # stop (volumes are kept)
./system_actions.sh status       # host helper: status, logs, health
```

`docker compose down -v` **deletes the volumes** and every vote, roll, and block on this host. Do not run it on a real election host.

## Data

| Volume | Mounted at | Contains |
| --- | --- | --- |
| `node-data` | `/data` in `node` | `republic.json` (users, elections, receipts), receipt PDF secret. |
| `l2-data` | `/data` in `l2`, `prover`, `archive` | Sealed blocks, proofs, mempool, leases. |

Back both up before every upgrade: [Backups](./backups.md).

## Variants

- **Private or HTTPS-on-tailnet**: `docker-compose.tailscale.yml` adds a `tailscale/tailscale:stable` sidecar. See [Tailscale sidecar](./tailscale.md).
- **Rolling update smoke test**: `docker-compose.rolling.yml`. See [Rolling updates](./rolling-updates.md).
- **Host-specific mounts**: copy `docker-compose.override.example.yml` to `docker-compose.override.yml` (gitignored).

# Coolify

**NOT FOR PROFIT** — civic public good. Not a commercial product.

[Coolify](https://coolify.io) is an open-source, self-hosted PaaS. It builds the repository's Compose file, issues TLS certificates, and runs rolling updates. This is the recommended managed path.

## 1. Create the resource

1. In Coolify, open your project and choose **+ New → Public Repository** (or **Private Repository** with a GitHub App or deploy key for a private fork).
2. Repository: your fork of `zk-voting`. Branch: `master` for production, `test/unstable` for staging. See [Upgrading](./upgrading.md#release-channels).
3. Build pack: **Docker Compose**.
4. Base Directory: `/voting_node`. Docker Compose Location: `/docker-compose.yml` (this path is relative to the base directory), or `/docker-compose.tailscale.yml` if you also want the [Tailscale sidecar](./tailscale.md). The Node image is `Dockerfile` in that directory; the L2 image is `l2/Dockerfile`. Watch paths, if you set them, are `voting_node/**`.

Coolify reads every `${VAR}` and `${VAR:-default}` in the Compose file and shows it as an editable variable. A `${VAR:?}` (used by the Tailscale file for `TS_AUTHKEY`) is required: the deploy will not start until you set it.

## 2. Domain

In the resource, open the `node` service and set **Domains** to:

```text
https://vote.example.org:3000
```

The `:3000` tells Coolify's proxy which container port to route to; visitors still use port 443. Then set the matching environment variable:

```env
VOTE_FQDN=vote.example.org
TRUST_PROXY=1
```

Leave the `l2` service without a domain. It only needs to be reachable on the Compose network.

Coolify's proxy publishes the site. The `ports:` entries in `docker-compose.yml` additionally publish 3000 and 8546 on the host for plain-Compose users. On a public Coolify host, firewall those ports or remove them in your fork, because published ports bypass the proxy.

## 3. Environment

Shortcut: on any machine with a clone, run `./setup.sh --deploy coolify`. It asks the setup questions (super admin, chain id, ceremony, entropy, hostname, database, L2 identity and L1 submitter) and prints the Coolify settings: the plain variables with their values, and the secret ones (`SETUP_TOKEN`, `ZK_ENTROPY`, `DATABASE_URL`, `EXPLORER_INGEST_SECRET`, `RECEIPT_PDF_SECRET`, `L1_SUBMITTER_PRIVATE_KEY`, `L2_SALT`, `L2_ADMIN_SECRET`, `L1_RPC`) by name only. Copy each secret value from the `voting_node/.env` it wrote and mark it secret in Coolify.

Set at least these in **Environment Variables**:

| Variable | Example | Why |
| --- | --- | --- |
| `VOTE_FQDN` | `vote.example.org` | Passkeys, allowed origin, PDF links. |
| `SUPER_ADMIN_EMAIL` | `clerk@example.org` | Where `/feedback` and the first admin's mail go. |
| `IS_DEMO` | omit, or `false` | Set `true` only on the public demo. A missing or empty value is a real election and does not schedule the monthly soft-delete. |
| `EXPLORER_INGEST_SECRET` | 64 hex chars | Required in production for L2 → explorer ingest. |
| `RECEIPT_PDF_SECRET` | 64 hex chars | Stable key for locked receipt and outcome PDFs. |
| `SES_FROM_ADDRESS`, `AWS_REGION` | `vote@example.org`, `us-east-1` | Email MFA. Leave empty for a demo. |

Coolify can generate secrets for you: in your fork, use a magic variable such as `${SERVICE_HEX_32_INGEST}` as the default for `EXPLORER_INGEST_SECRET`. Full list: [Configuration reference](./configuration.md).

## 4. Health checks

The Compose file already defines health checks for `node` and `l2` (a Node.js `fetch` of `/health`), and Coolify uses them. If you also enable Coolify's own HTTP health check, use:

| Setting | Value |
| --- | --- |
| Path | `/health` |
| Port | `3000` |
| Success | HTTP 200 |

Do **not** require `"mode":"active"`. A new container starts in standby during a rolling update and would never pass. See [Rolling updates](./rolling-updates.md).

## 5. Deploy

Click **Deploy**. Watch the build log, then open `https://vote.example.org/health`. Continue with [First launch](./first-launch.md).

## Updates

Enable **Auto Deploy** on the branch, or click **Redeploy** after pulling. Volumes `node-data` and `l2-data` persist across deploys. Read [Upgrading](./upgrading.md) and take a [backup](./backups.md) first.

## Files from the repository

If you mount a file from the repository into a container (for example a custom Tailscale serve config), enable **Preserve Repository During Deployment**, or inline the file in Compose. The bundled `docker-compose.tailscale.yml` writes its serve config at start-up, so it needs neither.

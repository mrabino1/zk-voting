# Configuration reference

**NOT FOR PROFIT** — civic public good. Not a commercial product.

Every setting is an environment variable read when the process starts. Run `./setup.sh` to write `.env` from a few questions (see [First launch](./first-launch.md)), or copy `.env.example` to `.env` and edit it; Compose interpolates it. Environment variables always win over values an officer saves in the app at `/office/site`.

Never commit `.env`, and never bake secrets into an image.

## Precedence

1. Environment variable (Compose `.env`, Coolify / Dokploy UI).
2. Value saved in the app (`/office/site`), where that setting is editable there.
3. Built-in default.

## Host and URLs

| Variable | Default | Purpose |
| --- | --- | --- |
| `ZK_VOTING_PORT` | `3000` | Host port Compose publishes for `node`. |
| `ZK_VOTING_IMAGE_TAG` | `local` (`latest` in the Tailscale file) | Tag for the locally built images. |
| `VOTE_FQDN` | empty | Public voting hostname (`vote.example.org`). Bare hostname only. Empty means a `localhost` demo. |
| `RP_ID` | `localhost` | Passkey relying party. Ignored as `localhost` when `VOTE_FQDN` is set. |
| `WEBAUTHN_ORIGINS` | `http://localhost:3000,http://127.0.0.1:3000` | Allowed browser origins. `https://$VOTE_FQDN` is always added. The request origin is accepted only when the host is already allowed. |
| `WEBAUTHN_HOST_SUFFIXES` | empty | Comma-separated parent domains. A host equal to a suffix, or a subdomain of one, may run a passkey ceremony. The RP ID is the request host unless `RP_ID` is that host or a parent of it. |
| `PUBLIC_BASE_URL` | empty → `https://$VOTE_FQDN` | Origin printed in official-outcome QR codes. |
| `TRUST_PROXY` | empty | Set `1` behind a reverse proxy or Tailscale so rate limits see the real client. |

## Storage

| Variable | Default | Purpose |
| --- | --- | --- |
| `POSTGRES_USER` | required by Compose | Role created by the bundled `postgres:16-alpine` service. Compose refuses to start when this is empty. |
| `POSTGRES_PASSWORD` | required by Compose | Password for that role. Compose ships no default. The same secret, percent-encoded, goes in `DATABASE_URL`. |
| `POSTGRES_DB` | required by Compose | Database name created on first start of the `db` service. |
| `DATABASE_URL` | required by Compose | Postgres connection string. For the bundled server: `postgres://USER:PASSWORD@db:5432/DB`. When set, Node app state (accounts and passkeys, sessions, elections, registrations, ballots, receipts, ceremonies metadata, site settings, plugin state, the explorer chain, the receipt PDF secret) lives in Postgres. Tables are created on boot (`zkv_*`, idempotent migrations). Empty, outside Compose: JSON files in `DATA_DIR`. The active backend is logged at startup and shown in `/health` as `db`. |
| `DATA_DIR` | `/data` in the image | JSON store when `DATABASE_URL` is empty. With Postgres it still holds large files (ceremony artifacts, plugin uploads) and the writer lease. On the first boot against an empty database, an existing `zk-voting.json`, `l2-chain.json`, and `receipt-pdf.secret` here are imported once; the files are left in place and no longer read. |
| `PGSSLMODE` | empty | Fallback for `sslmode` when the URL has none (`require`, `verify-full`). |
| `PG_POOL_MAX` | `5` | Postgres pool size. |

`/health` returns `503` with `db.ok: false` when Postgres is configured but unreachable.

## Administration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ADMIN_HANDLE` | `admin` | Handle of the platform administrator seeded on an empty store. See [First launch](./first-launch.md). |
| `SETUP_TOKEN` | empty | **Secret.** `/setup` always asks for a setup token before creating the super admin, and `/register` cannot claim the seeded row. When this is set, type that value. When it is empty, the server prints a one-time token at boot, only on the process log, and invalidates it after the super admin is created. The token is never served over HTTP. |
| `FIRST_RUN_REDIRECT` | `true` (`false` in tests) | Send visitors to `/setup` while no super admin exists, and the super admin until they press Finish. |
| `SUPER_ADMIN_EMAIL` | empty | Contact email of that administrator. Applied on every boot by the active writer. Invalid values refuse to start. |
| `IS_DEMO` | unset (not a demo) | `true` or `1` only on the disposable public demo, which then runs the monthly soft-delete. Omit the variable for a real election. Blank, `false`, `0`, and any other value are not a demo. |
| `POLLS_ENABLED` | empty | `1` turns on token-weighted polls. |

## Secrets

| Variable | Purpose |
| --- | --- |
| `L2_BALLOT_TOKEN` | Shared by `node` and `l2`: the node's bearer token for the operator's ballot API. `./setup.sh` mints one; Compose refuses to start without it. |
| `RECEIPT_PDF_SECRET` | Key material for locked receipt and outcome PDFs. Empty: the Node creates one and keeps it in Postgres (`zkv_secrets`), or in `$DATA_DIR/receipt-pdf.secret` without `DATABASE_URL`. |
| `CREDENTIAL_PROVIDER_SECRET`, `CREDENTIAL_PROVIDER_ID` | Civil-credential connector. Empty secret means manual officer review. |
| `ROLLUP_PRIVATE_KEY`, `OPERATOR_PRIVATE_KEY` | L1 keys of the node (the jurisdiction's clerk) and of the L2 operator. Runtime only. Never in git or an image. Anvil's public test keys are refused off chain 31337. |

## Email (AWS SES)

| Variable | Purpose |
| --- | --- |
| `SES_FROM_ADDRESS`, `AWS_REGION` | Both set: every non-dev sign-in completes with a 6-digit email code, and Terms PDFs are mailed. |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Leave empty to use the host IAM role. |
| `SES_CONFIGURATION_SET`, `SES_ENDPOINT`, `SES_DRY_RUN` | Optional SES tuning. |
| `REQUIRE_EMAIL_MFA` | Forces MFA in tests. |

## Chain

| Variable | Default | Purpose |
| --- | --- | --- |
| `CHAIN_ID` | `27427` | The node's own chain id (poll signatures, wallets). Set = fixed by the environment; `/setup` shows it read-only. Empty = the super admin picks it on `/setup`. The environment always wins. Not a positive integer refuses to start. Restart after changing it. |
| `ENTROPY_CEREMONY_URL` | empty | Public entropy ceremony origin (`https://host`, or `http://localhost:…`; a bare host means https). Set = `/setup` step 3 is read-only. Not a valid URL refuses to start. See [`zk-entropy/ceremony`](../../../zk-entropy/ceremony/README.md). |
| `ZK_ENTROPY` | empty | **Secret.** A `zke1:` entropy string (closed ceremony output or local). Set = wins over the value saved on `/setup` step 4. A bad checksum refuses to start (the value is never logged). See [`ceremony-web.md`](../ceremony-web.md). |

## Rollup (civic votes)

Civic votes settle on ZkVotingRollup, one L1 contract shared by every jurisdiction
([design](../../../smart-contracts/docs/ROLLUP.md)). Polls stay on the node and need none of this.

| Variable | Default | Purpose |
| --- | --- | --- |
| `COMPOSE_PROFILES` | `local-l1` | Runs the local chain (`l1`, Anvil on 31337) and the one-shot `l1-deploy`. Remove it to use a public chain. |
| `L1_RPC` | `http://l1:8545` | Ethereum RPC for the node and the operator. |
| `L1_RPC_AUTH_TOKEN` | empty | Optional bearer token for an L1 JSON-RPC endpoint that requires auth. When set, L1 calls send `Authorization: Bearer <token>`. Empty sends no Authorization header. Never log this value. |
| `L1_CHAIN_ID` | empty | Expected L1 chain id; the node refuses an RPC on another chain. Empty = from the deployment file, else the RPC. |
| `ROLLUP_ADDRESS` | empty | The ZkVotingRollup address. Empty = from `ROLLUP_DEPLOYMENT_FILE`. |
| `ROLLUP_DEPLOYMENT_FILE` | `/deployments/local.json` | Deployment record written by `l1-deploy` (or `scripts/deploy.sh`): address, chain, jurisdiction. |
| `ROLLUP_JURISDICTION_ID` | empty | Your jurisdiction (bytes32) on the rollup. Empty = from the deployment file. |
| `ROLLUP_PRIVATE_KEY` | Anvil key 2 | **Secret.** The node account, your jurisdiction's clerk on L1: publishes, closes and finalizes civic votes. Needs a little ETH; voters never pay. |
| `ROLLUP_TICK_SECONDS` | `15` | How often the node syncs rolls, closes after the cutoff and finalizes. |
| `ROLLUP_DEPLOY_BLOCK` | empty (0) | First L1 block of the deployment; where the outcomes monitor's L1 audit starts reading events. Set it on a public chain: many RPCs refuse a log query from block 0. |
| `L2_URL` | `http://l2:8546` | Where the node reaches the operator. |
| `OPERATOR_PRIVATE_KEY` | Anvil key 1 | **Secret.** The L2 operator, registered with `setOperator`; pays L1 gas for batches. |
| `L2_BATCH_SECONDS` | `10` | How often the operator checks for work. |
| `L2_ALLOW_DEGRADED` | empty (off) | `1`: if the rollup is not usable at startup (genesis missing, rollup address or operator key missing or unusable, L1 chain id check failed, or no batch prover), the operator stays up. `/health` is HTTP 200 with `status: "degraded"` and a short `reason`, and init is retried. It does not batch or submit to L1 until init succeeds. Empty or `false` (the default) keeps the fail-fast exit, so a misconfigured operator does not look healthy. Set this when the stack should stay up while L1 is still coming online. The node stays up either way and shows the same status on its own `/health` (`l2.status`) and in diagnostics. |
| `L2_BATCH_MAX_WAIT_SECONDS` | 0 on chain 31337, 600 elsewhere | How long ballots may wait for a fuller batch. Each batch costs L1 gas; a full batch (256 ballots), a waiting roll change or close, or an approaching cutoff seals at once. |
| `L2_RPC_PORT`, `L2_RPC_BIND` | `8546`, `127.0.0.1` | Host port and interface for the operator. Its reads (`/v1/status`, `/v1/batches`) are public; the ballot API needs `L2_BALLOT_TOKEN`. |
| `L1_RPC_PORT` | `8545` | Host loopback port of the local chain. |
| `ZK_VOTING_ALLOW_MOCK_PROOFS` | `1` on the local stack | Chain 31337 only: the operator accepts ballots without a zero-knowledge eligibility proof (the node's vote pass still gates them). Refused on any other chain. |

## Polls and disclosure

| Variable | Default | Purpose |
| --- | --- | --- |
| `DISCLOSURE_INTERVAL_SECONDS` | `3600` | Hour length for public poll-ballot disclosure. `0` publishes immediately (demo only). |
| `DISCLOSURE_DELAY_SECONDS` | `1800` | Extra wait after the hour closes. Votes from 08:00–08:59 publish at 09:30. `0` publishes at the hour boundary (demo only). |
| `DISCLOSURE_MIN_BLOCK_VOTES` | `10` | Do not publish a disclosure block smaller than this. Short hours merge forward. |
| `RESULTS_MIN_VOTES` | `100` | Poll per-choice counts wait until this many voters have cast, or until `cutoffTime`. `0` leaves them open (demo only). |
| `TALLY_CHALLENGE_SECONDS` | `86400` | Wait after a poll's cutoff before its tally. Production minimum is 1 hour. |

Civic votes have no interim disclosure: only the final sum is ever decrypted, on L1.

## Feedback form

| Variable | Default |
| --- | --- |
| `FEEDBACK_RATE_WINDOW_SECONDS` | `3600` |
| `FEEDBACK_MIN_SUBMIT_MS` | `3000` |
| `FEEDBACK_MAX_BODY_BYTES` | `16384` |

## Trusted-setup ceremony

Only used if you run a Groth16 ceremony. See [Groth16 ceremony](./ceremony.md).

| Variable | Default | Purpose |
| --- | --- | --- |
| `CEREMONY_DIR` | `$DATA_DIR/ceremonies` | Every zkey, transcript, and export for each ceremony. |
| `CEREMONY_INPUT_DIR` | `$DATA_DIR/ceremony-inputs` | `.r1cs` and `.ptau` files the coordinator can pick. |
| `CEREMONY_MAX_ZKEY_MB` | `1024` | Largest contribution upload. |
| `CEREMONY_MAX_INPUT_MB` | `2048` | Largest input uploaded through the coordinator page. |
| `CEREMONY_ETH_RPC_URL` | unset | Ethereum **mainnet** JSON-RPC URL(s) for the beacon block hash, comma-separated (all must agree). `https://` only, except `http://localhost`. Read-only. Unset: beacon commit and finalize fail closed. Secret: often holds an API key; never logged. |
| `CEREMONY_BEACON_MIN_BLOCKS_AHEAD` | `32` | The committed beacon block must be at least this many blocks past the head at commit time. |

## Tailscale sidecar

Only used by `docker-compose.tailscale.yml`. See [Tailscale sidecar](./tailscale.md).

| Variable | Default | Purpose |
| --- | --- | --- |
| `TS_AUTHKEY` | required | Tailscale auth key. |
| `TS_HOSTNAME` | `zk-voting` | Tailnet machine name. |
| `TS_FUNNEL` | `false` | `true` publishes the site to the internet with Funnel. |

## Development only

`ALLOW_DEV_LOGIN`, `ALLOW_SMART_CARD_MOCK`, `ALLOW_CIVIC_ID_MOCK` enable mock sign-in paths for local testing. Dev login is always off when `NODE_ENV=production`, which the Compose files set.

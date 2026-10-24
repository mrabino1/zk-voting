# Configuration reference

**NOT FOR PROFIT** — civic public good. Not a commercial product.

Every setting is an environment variable read when the process starts. Copy `.env.example` to `.env`; Compose interpolates it. Environment variables always win over values an officer saves in the app at `/office/site`.

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
| `WEBAUTHN_ORIGINS` | `http://localhost:3000,http://127.0.0.1:3000` | Allowed browser origins. `https://$VOTE_FQDN` is always added. |
| `PUBLIC_BASE_URL` | empty → `https://$VOTE_FQDN` | Origin printed in official-outcome QR codes. |
| `TRUST_PROXY` | empty | Set `1` behind a reverse proxy or Tailscale so rate limits see the real client. |

## Administration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ADMIN_HANDLE` | `admin` | Handle of the platform administrator seeded on an empty store. See [First launch](./first-launch.md). |
| `SUPER_ADMIN_EMAIL` | empty | Contact email of that administrator. Applied on every boot by the active writer. Invalid values refuse to start. |
| `POLLS_ENABLED` | empty | `1` turns on token-weighted polls. |

## Secrets

| Variable | Purpose |
| --- | --- |
| `EXPLORER_INGEST_SECRET` | Shared by `node` and `l2`. Unset in production refuses explorer ingest. |
| `RECEIPT_PDF_SECRET` | Key material for locked receipt and outcome PDFs. Empty: the Node creates `$DATA_DIR/receipt-pdf.secret`. |
| `CREDENTIAL_PROVIDER_SECRET`, `CREDENTIAL_PROVIDER_ID` | Civil-credential connector. Empty secret means manual officer review. |
| `RELAYER_PRIVATE_KEY`, `PRIVATE_KEY`, `L1_PUBLISHER_PRIVATE_KEY` | Chain keys. Runtime only. Never in git or an image. |

## Email (AWS SES)

| Variable | Purpose |
| --- | --- |
| `SES_FROM_ADDRESS`, `AWS_REGION` | Both set: every non-dev sign-in completes with a 6-digit email code, and Terms PDFs are mailed. |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Leave empty to use the host IAM role. |
| `SES_CONFIGURATION_SET`, `SES_ENDPOINT`, `SES_DRY_RUN` | Optional SES tuning. |
| `REQUIRE_EMAIL_MFA` | Forces MFA in tests. |

## Chain and L2

| Variable | Default | Purpose |
| --- | --- | --- |
| `CHAIN_ID` | `27427` | Civic L2 chain id. |
| `CHAIN_RPC` | `http://l2:8546` | Where the Node reaches the sequencer. Empty runs without a chain. |
| `ELECTION_FACTORY_ADDRESS`, `BALLOT_INBOX_ADDRESS`, `VERIFIER_ADDRESS` | empty | Pin the one shared deployment. Forks do not redeploy. |
| `L2_RPC_PORT` | `8546` | Host port for the sequencer. Do not expose publicly. |
| `L2_BATCH_SIZE`, `L2_SKIP_EMPTY_BLOCKS`, `L2_HEARTBEAT_SECONDS` | `4`, `1`, `3600` | Sequencer tuning. |
| `DEV_MOCK_PROOF` | `true` | Mock proofs for the demo L2. |
| `DISCLOSURE_INTERVAL_SECONDS` | `3600` | Hourly public vote disclosure. `0` publishes immediately (demo only). |
| `ZK_VOTING_NODE_URL` | `http://node:3000` | Where L2 services reach the Node. The name is kept for compatibility. |
| `L1_RPC`, `L1_CHAIN_ID`, `L1_TALLY_MIRROR_ADDRESS`, `L1_SETTLEMENT_ADDRESS`, `SETTLEMENT_ADDRESS` | empty | Optional Ethereum L1 certification. Empty is a no-op. |

## Archive (S3 / R2)

| Variable | Default | Purpose |
| --- | --- | --- |
| `ARCHIVE_ENABLED` | `1` | `0` turns the hourly archive off. With no bucket it warns and deletes nothing. |
| `ARCHIVE_S3_BUCKET`, `ARCHIVE_S3_ENDPOINT`, `ARCHIVE_S3_REGION` | empty, empty, `auto` | Target bucket. A `file://` endpoint archives to disk. |
| `ARCHIVE_S3_ACCESS_KEY_ID`, `ARCHIVE_S3_SECRET_ACCESS_KEY` | empty | Bucket credentials. |
| `ARCHIVE_HOT_WINDOW_HOURS`, `ARCHIVE_INTERVAL_SECONDS` | `2`, `3600` | How much stays on the host and how often the job runs. |

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

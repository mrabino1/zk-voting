# Operator guide

**NOT FOR PROFIT** — civic public good. Not a commercial product. See [`/NOT_FOR_PROFIT.md`](../NOT_FOR_PROFIT.md).

How to host Republic / zk-voting: the Node process, Foundry contracts, Republic L2 (chainId **27427**), and the split between **`test/unstable`** and **`master`**.

This software may be run **at cost** by a government, county clerk, union, cooperative, or volunteer. It must not be sold as SaaS, wrapped in a token, or used to skim voter or jurisdiction funds. The paymaster sponsors L2 gas; voters are not a revenue line. Dollar and GB ranges: [`/voting_cost_estimate.md`](../voting_cost_estimate.md).

---

## What you are operating

1. **`apps/node`** — long-lived Node 22 process: voter / clerk / observer UI (vanilla JS in `public/`), HTTP API, optional vote relayer, JSON store (`apps/node/data/republic.json`). **No SQLite.**
2. **`smart-contracts/`** — Solidity 0.8.24, Foundry (`via_ir = true`). Factory, registries, inbox, `Tally.sol`, passkey account, L1 `RollupSettlement`.
3. **`l2/`** — Republic **civic JSON** sequencer + prover (JSON-RPC **:8546**, chainId 27427). Settles batches to L1 when configured. Not Anvil, not a hosted Lighter sequencer; Lighter is prior art (see root README).
4. **`circuits/`** — circom vote / tally. Foundry unit tests use `MockVerifier`. Proving path is **in progress** (`npm run circuits:status`). Local setup is untrusted until Poseidon + a ceremony exist.

The Node is allowed to be down. Chain records (L2, and L1 if you mirrored the tally) must still be enough for an independent verifier.

---

## Branch policy (non-negotiable)

| Line | Branch | Meaning |
| --- | --- | --- |
| Development / staging | `test/unstable` | Default. Experimental elections, MockVerifier (unit tests), optional `REPUBLIC_PROVING_PATH=1`, civic JSON L2 (`:8546`), optional Foundry Anvil (`:8545`) for Solidity. |
| Production | `master` | Only builds a jurisdiction may treat as binding. |

`system_actions.sh deploy-dev` pulls **`test/unstable`**. `deploy-prod` pulls **`master`** and **asks for confirmation** (unless you pass `--yes`, which you should not wire to an unattended cron for a live election).

Never point a production jurisdiction’s published contract addresses at a `test/unstable` deployment. Pin addresses in the Node’s election record from `master` artifacts.

---

## `system_actions.sh`

From the repository root. Numbers **1–4** are the git flow: feature branches land on `test/unstable`, then promote to `master`.

```bash
./system_actions.sh              # interactive menu
./system_actions.sh help

# Git workflow
./system_actions.sh 1            # fetch + pull, npm install, npm run dev
./system_actions.sh 2 my-feature # create feature/my-feature from test/unstable
./system_actions.sh 3            # merge feature/* into test/unstable and push
./system_actions.sh 4            # merge test/unstable → master (type MERGE)

# Data / chain (no Postgres — JSON store only)
./system_actions.sh 5            # republic.json counts
./system_actions.sh 6            # Node / L2 / CHAIN_RPC / L1_RPC reachability
./system_actions.sh 7            # local Node users (handle + role)

# Host / operator
./system_actions.sh status       # branch, SHA, dirty, pm2/systemd/compose
./system_actions.sh checkout-dev
./system_actions.sh checkout-prod
./system_actions.sh deploy-dev   # fetch, ff-only pull, npm install, build, restart
./system_actions.sh deploy-prod  # same on master; confirms
./system_actions.sh restart
./system_actions.sh logs
./system_actions.sh health       # GET $ZK_VOTING_HEALTH_URL (default :3000/health)
./system_actions.sh archive      # L2 hourly attic (on by default; no delete without a store)
```

`4` only **merges and pushes git**. It does not install, build, or restart. After a release merge, run `deploy-prod` on the host that serves the jurisdiction.

This repo has **no SQL database**. Options 5–7 read the JSON store, probe HTTP/RPC, and list local handles.

Environment overrides: `ZK_VOTING_DEV_BRANCH`, `ZK_VOTING_PROD_BRANCH`, `ZK_VOTING_APP_NAME`, `ZK_VOTING_PM2_NAME`, `ZK_VOTING_SYSTEMD_UNIT`, `ZK_VOTING_HEALTH_URL`, `ZK_VOTING_PORT`, `ZK_VOTING_LOG_LINES`, `ZK_VOTING_HOST`, `ZK_VOTING_L2_HEALTH_URL`.

Restart order: **pm2** → **systemd** unit → **docker compose**. If none are configured, `restart` warns and does not fail the machine. Install / build still run on deploy.

Deploy refuses a **dirty worktree**. Commit or stash first.

Root [`.dockerignore`](../.dockerignore) applies to every image built from this repo (Node, Republic L2, Foundry deploy). It keeps `.git`, `node_modules`, `.env` / keys, Foundry `out/` `cache/` `broadcast/`, `apps/node/data`, `l2/data`, and Circom trusted-setup files (`.ptau`, `.zkey`) out of the build context. Mount voter data and proving keys as volumes; do not `COPY` them into the image.

---

## Docker Compose

Root [`docker-compose.yml`](../docker-compose.yml) is the host path `system_actions.sh` already looks for. One command builds the Node (API + SPA) and Republic L2 (sequencer + prover), the same shape as a typical frontend Compose file: images from this tree, published ports, health checks, named volumes, `restart: unless-stopped`.

```bash
cp .env.example .env          # or paste README § Copy-paste credentials into .env
docker compose up -d --build  # or: npm run compose:up
curl -fsS http://127.0.0.1:3000/health
curl -fsS http://127.0.0.1:8546/health
./system_actions.sh health
./system_actions.sh logs
./system_actions.sh status
docker compose down           # or: npm run compose:down
```

| Service | Image | Host port | Role |
| --- | --- | --- | --- |
| `node` | `Dockerfile` | `${ZK_VOTING_PORT:-3000}` | Republic Node — voter / admin SPA + JSON API |
| `l2` | `l2/Dockerfile` | `${L2_RPC_PORT:-8546}` | Sequencer JSON-RPC (`GET /health`, `eth_chainId`) |
| `prover` | same as `l2` | none | Batch prover; writes proofs on the `l2-data` volume |
| `archive` | same as `l2` | none | Hourly L2 attic to S3/R2. Default on. Empty bucket and no `file://` sink warns and does not prune. `ARCHIVE_ENABLED=0` turns it off |

Voter JSON lives on the `node-data` volume (`DATA_DIR=/data`). L2 blocks and proofs live on `l2-data`. Secrets stay in `.env` (gitignored). Host-specific live-reload mounts belong in `docker-compose.override.yml` (also gitignored); start from [`docker-compose.override.example.yml`](../docker-compose.override.example.yml).

The Node binds `HOST=0.0.0.0` so the published port is reachable. The sequencer binds `L2_RPC_HOST=0.0.0.0` for the same reason (plain-Node local use still defaults to `127.0.0.1`). Inside the Compose network the Node reaches L2 at `http://l2:8546`. The host user should be able to run `docker compose` (membership in the `docker` group); `system_actions.sh` will use `sudo docker compose` when passwordless sudo is the only way to talk to the daemon.

The Node image installs the npm **workspaces** from the repository root (`@zk-voting/chain-client` is private and is not fetched from the public registry). L1 tally-hash env vars on the `node` service are optional; leaving them empty is a documented no-op.

Do not bake `RELAYER_PRIVATE_KEY`, prover `PRIVATE_KEY`, `L1_PUBLISHER_PRIVATE_KEY`, or paymaster keys into the image.

### Coolify rolling update

Old and new containers overlap. They must mount the **same** `node-data` and `l2-data` volumes on **one** host. Each stateful process takes a file lease (`l2/lease/lease.mjs`) before it writes. The new container starts **standby**: `/health` is HTTP 200 with `ok: true` and `"mode":"standby"`. It does not produce blocks, prove, prune, ingest, or mutate the store. Do not configure Coolify to require `mode=active` — that deadlocks the rollout. On SIGTERM the old container flushes, releases the lease, and exits 0 inside `stop_grace_period: 30s`. The standby polls and takes over. A crash is taken over after the lease TTL (default 8s).

Skip-empty blocks stay on (`L2_SKIP_EMPTY_BLOCKS=1`). Only the sequencer lease holder runs `tickProducer`, so only one process seals the hourly chain heartbeat. Archive stays on (`ARCHIVE_ENABLED=1`). Only the archive lease holder uploads or prunes; an empty bucket warns and does not delete local blocks.

| Coolify setting | Value |
| --- | --- |
| Strategy | Rolling update (start new, wait healthy, stop old) |
| Node health | `http://127.0.0.1:3000/health` — success is HTTP 200 and `ok` is not false |
| L2 health | `http://127.0.0.1:8546/health` — same success rule |
| Grace | 30 seconds |
| Volumes | Persistent `node-data` and `l2-data` already attached to this host. Not a new volume per container |
| Two hosts | Not supported. File locks do not cross hosts. Stop the old container first |

Clients retry HTTP 503 `maintenance handover` (`Retry-After: 2`). Full failure modes, fencing, and the one-time L1 deploy: [`ROLLING_UPDATES.md`](./ROLLING_UPDATES.md). Smoke the overlap with `docker-compose.rolling.yml` (`l2-next` on 8547, `node-next` on 3001).

### Forked jurisdiction Nodes

Forking this Node is **intentional**. Paste the [copy-paste credentials](../README.md#copy-paste-credentials) block (or copy [`.env.example`](../.env.example)), set `VOTE_FQDN` to the voting subdomain (below), set SES / AWS keys (or the host IAM role), and pin `ELECTION_FACTORY_ADDRESS`, `BALLOT_INBOX_ADDRESS`, and `VERIFIER_ADDRESS` from the **shared** deploy. Do not run `DeployLocal` again for a new city. Env wins over `/office/site`. Root README: [Intentional forking](../README.md#intentional-forking).

### Voting subdomain (`VOTE_FQDN`)

A jurisdiction that runs this repo publishes the Node on a **subdomain it controls**. That FQDN is the voting authority: voters open it, passkeys are bound to it, and official links use it.

```text
vote.domain.tld
```

`domain.tld` is the body’s domain. `vote` is the usual host label. Create a DNS `A`, `AAAA`, or `CNAME` for that name pointing at this host, and terminate TLS for it. This repo does not register the name. The Node itself keeps listening on `ZK_VOTING_PORT` (HTTP). Put Caddy, nginx, or the host load balancer in front.

```env
VOTE_FQDN=vote.domain.tld
```

Leave it empty for a local demo (`RP_ID` stays `localhost`).

| Derived setting | When `VOTE_FQDN` is set |
| --- | --- |
| `RP_ID` | Becomes the FQDN. The template value `localhost` does not override it. Set `RP_ID` to another public hostname only when the relying party must be a parent of the subdomain. |
| `WEBAUTHN_ORIGINS` | `https://<VOTE_FQDN>` is always accepted, including when the env list is still the localhost default. |
| `PUBLIC_BASE_URL` | Defaults to `https://<VOTE_FQDN>` when empty (official-outcome QR codes). |

Check it after the process is up:

```bash
curl -fsS http://127.0.0.1:3000/health
# "voteFqdn": "vote.domain.tld"
curl -fsS http://127.0.0.1:3000/api/config
# "vote": { "fqdn": "vote.domain.tld", "origin": "https://vote.domain.tld", ... }
```

The value is a bare hostname. `https://vote.domain.tld`, a port, or a path is rejected at startup.

---

## First-time machine

```bash
# Node 22+
node -v

# Foundry 1.8+ (solc 0.8.24, via_ir on — foundry.toml)
foundryup
cd smart-contracts && forge test

# Optional: circom 2 + snarkjs for the proving path (not a ceremony)
npm run circuits:status
# npm run circuits:compile && npm run circuits:setup   # UNTRUSTED local ptau
# Optional: viem in the Node app for ABI encoding (packages/chain-client)

git checkout test/unstable
./system_actions.sh deploy-dev
```

Optional local EVM (Foundry Anvil **:8545**) + scripts (see `smart-contracts/script/`): `DeployLocal.s.sol` prints `name=0x…` for the Node to ingest (`FACTORY=`, `VERIFIER=`, `INBOX=`). Broadcast JSON is gitignored. The civic sequencer is a different process on **:8546**.

---

## Running the pieces

### Foundry tests

```bash
cd smart-contracts
forge test
forge test --fuzz-runs 256
forge test --match-path test/invariant/*
```

From repo root: `npm run test:contracts`, `npm run test:fuzz`, `npm run test:invariant`, `npm run test:proof-helpers`.

Proving path (optional tools): `npm run circuits:status`. See [`circuits/HASH_SCHEME.md`](../circuits/HASH_SCHEME.md). `REPUBLIC_PROVING_PATH=1` on `DeployLocal` deploys `VoteVerifier` without mock fallback.

### Independent auditor (no Node private DB)

```bash
npm run test:auditor
npm run auditor -- verify --file bundle.json
node tools/auditor/cli.mjs export-node --base http://127.0.0.1:3000 --election 1
```

Public HTTP: `GET /api/elections/:id/artifacts`. Docs: [`docs/AUDITOR.md`](./AUDITOR.md).

### Node

```bash
# workspaces
npm install
npm run dev          # node --watch apps/node (Express + public/)
npm run start        # production-style Node process
npm test -w apps/node
```

Expect `GET /health`. Public pages: `/`, `/vote/:id` (UUID or short code), `/v/:shortCode`, `/e/:shortCode`, `/register`, `/elections/:id/info`, `/elections/:id/results`, `/outcomes`, `/outcomes/:id`, `/outcomes/verify`, `/receipt`, `/feedback`, `/admin`, `/back-office`, `/explorer`. Vanilla JS, not Vite/React. Every page footer: **NOT FOR PROFIT**.

### Creating elections (chain vs demo)

Clerk **Create election** in `/back-office` is `POST /api/elections`.

| Node env | What happens |
| --- | --- |
| `CHAIN_RPC` **unset** | JSON-only demo. Writes `apps/node/data/republic.json`. No factory call. |
| `CHAIN_RPC` **set** | The API also calls `ElectionFactory.createElection` through viem (`simulateContract` + `writeContract`), matching `@zk-voting/chain-client` and `CreateElection.s.sol`. Failures return **502/503** with a message the clerk UI shows. Nothing is saved locally if the factory reverts. |

Required when the chain is configured: `CHAIN_RPC`, `ELECTION_FACTORY_ADDRESS` (or `FACTORY`), `RELAYER_PRIVATE_KEY`, `VERIFIER_ADDRESS` (or `VERIFIER` from `DeployLocal`). Officer roles (clerk / registrar / disqualification / tally) default to the relayer address, matching `CreateElection.s.sol` using `msg.sender`, unless the POST body or `CLERK_ADDRESS` / `REGISTRAR_ADDRESS` / … is set.

The Node public election id is a UUID v5 bound to factory + on-chain id + jurisdiction (legacy v4 still resolves). The on-chain `electionId` is a uint256 stored as `onChainElectionId` (plus `onChainElectionAddress` / `createTxHash` when the factory ran). They can differ: `DeployLocal` already creates on-chain election `#1`. Demo mode still mints a local uint256 so Groth16 public inputs stay numeric. A copied UUID from another jurisdiction does not share the L1 slot.

Operators can still create with Foundry instead of the clerk UI:

```bash
cd smart-contracts
FACTORY=0x… START=… CUTOFF=… TITLE='County general' \
  forge script script/CreateElection.s.sol:CreateElection \
  --rpc-url "$CHAIN_RPC" --broadcast
# prints ELECTION=0x… and ELECTION_ID=…
```

Prefer the back office when you want the Node record and the factory clone created in one step.

### Republic L2

```bash
npm run l2:sequencer   # civic JSON-RPC on :8546
npm run l2:prover
./l2/bin/start-local.sh
```

`l2/genesis.json` uses **chainId 27427**, 2s period, one sequencer. This process does **not** proxy EVM to Anvil. Voters do not hold a gas token. On an EVM, `RepublicPaymaster` sponsors UserOps that hit `BallotInbox`, `VoterRegistry.register`, or `PasskeyAccountFactory`. Fund the paymaster from the **jurisdiction budget at cost**, not from voters.

Details: [`docs/L2.md`](./L2.md).

### Hourly L2 attic (S3 / Cloudflare R2)

The sequencer wakes about every 2s. With `L2_SKIP_EMPTY_BLOCKS=1` (default) it writes a block only when there is a transaction, when the disclosure hour closes, or once per `L2_HEARTBEAT_SECONDS` (default **3600**). `L2_SKIP_EMPTY_BLOCKS=0` restores a file every tick, including empty blocks. Object storage is the **attic**, not the live L2 filesystem. A sidecar / cron job (`node l2/archive/cli.mjs archive`, Compose `archive` service, `./system_actions.sh archive`, or `npm run l2:archive`) uploads **sealed hours** older than `ARCHIVE_HOT_WINDOW_HOURS` (default **2**, aligned with the disclosure hour boundary) to a path-style S3 API:

`s3://$ARCHIVE_S3_BUCKET/l2/{chainId}/YYYY/MM/DD/HH/…`

Each hour has a `manifest.json`. Block and proof objects are gzipped when `ARCHIVE_COMPRESS=1` (default). The manifest lists the sha256 and size of the **exact bytes stored** and the sha256 and size of the **raw** JSON. Local copies are deleted **only after** GET+checksum verify of those stored bytes, and only for hours the prover cursor has covered. Failed uploads leave the VPS files in place. Restore gunzips and checks the raw hash. Objects archived before compression (no `contentEncoding`, or `identity`) restore as the original JSON.

Default **`ARCHIVE_ENABLED=1`**. If `ARCHIVE_S3_BUCKET` is empty and `ARCHIVE_S3_ENDPOINT` is not a `file://` sink, the job prints a warning, exits 0, and **does not delete anything**. `ARCHIVE_ENABLED=0` turns the job off the same way.

| Variable | Default | Meaning |
| --- | --- | --- |
| `L2_SKIP_EMPTY_BLOCKS` | `1` | `0` seals every ~2s, including empty blocks |
| `L2_HEARTBEAT_SECONDS` | `3600` | One empty block after this many seconds with no other seal. `0` disables the heartbeat |
| `ARCHIVE_ENABLED` | `1` | `0` turns the job off. On with no bucket and no `file://` sink: warn and do not prune |
| `ARCHIVE_COMPRESS` | `1` | Gzip block and proof uploads. `0` stores raw JSON. Hash check is always over the stored bytes |
| `ARCHIVE_S3_BUCKET` | empty | Required to actually upload. Empty plus no `file://` sink does not prune |
| `ARCHIVE_S3_ENDPOINT` | empty | Empty = AWS. R2: `https://<accountid>.r2.cloudflarestorage.com`. Tests: `file:///path` |
| `ARCHIVE_S3_REGION` | `auto` | R2 uses `auto`; AWS e.g. `us-east-1` |
| `ARCHIVE_S3_ACCESS_KEY_ID` / `ARCHIVE_S3_SECRET_ACCESS_KEY` | empty | R2 API token or IAM user. Distinct from SES when you want |
| `ARCHIVE_HOT_WINDOW_HOURS` | `2` | Keep this many hours of block JSON on the VPS |
| `ARCHIVE_EXPLORER_SNAPSHOT` | `0` | If `1`, copy Node `l2-chain.json` into the hour prefix (does **not** prune Node `DATA_DIR`) |
| `ARCHIVE_MIN_FREE_BYTES` | `8388608` (8 MiB) | Below this, skip explorer snapshot / extra local copies; still offload sealed hours |

Restore (read-only download into a directory, never the live sequencer tree):

```bash
npm run l2:archive:restore -- --hour 2026/09/20/14 --out /tmp/l2-hour
./system_actions.sh archive-restore --hour 2026/09/20/14 --out /tmp/l2-hour
```

Cron (host already exporting archive env, or a root `.env` the CLI will read):

```bash
0 * * * * cd /opt/zk-voting && ./system_actions.sh archive
```

Node `DATA_DIR` (`republic.json`, working explorer) stays local. See [`voting_cost_estimate.md`](../voting_cost_estimate.md).

The archive job is a **sidecar**. A failed hour (hash mismatch, PUT/GET error, timeout, `ENOSPC` in the attic job, lock held) **does not stop the sequencer**. If the VPS is so full that the sequencer cannot write `blocks/N.json` or Node cannot write `republic.json`, that is a **separate** hot-path `ENOSPC` alert — free disk or configure the attic. Overlapping crons share `L2_DATA_DIR/archive/archive.lock`; the second run exits non-zero and does not prune.

#### Attic failure matrix

Mismatch or failure at any verify stage: **do not prune**; that hour exits non-zero; local files stay. Next run is retry-friendly (idempotent PUT if remote sha256 already matches).

| Symptom | Local state | Remote state | Action |
| --- | --- | --- | --- |
| PUT network / 5xx / timeout | intact | missing or partial object | retry hour; fix network/bucket |
| PUT 401/403 | intact | none | fix `ARCHIVE_S3_*` keys; no prune |
| GET missing, truncated, or sha256 ≠ pre-upload / manifest | intact | bad or incomplete object | retry PUT; no prune |
| Manifest PUT fails after objects uploaded | intact | objects may exist without a good `manifest.json` | retry; do not prune until manifest GET+sha256 verifies |
| Local file sha256 changes during the job (bitrot/truncation) | still present | may already match the pre-upload hash | **no prune**; restore that object from the attic or stop |
| `ENOSPC` writing staging manifest / index temp | intact | none for that hour | free disk; retry; never delete unverified |
| `ENOSPC` after some hours verified | those hours may already be pruned | those hours complete | abort remaining; retry the rest after freeing disk |
| Disk critically low **before** start | hot path untouched | sealed hours still offloaded | skip explorer snapshot and other large local copies; log `ENOSPC` |
| Second run while lock held | intact | unchanged | wait for the first job; overlapping cron is a no-op prune-wise |
| No bucket and no `file://` sink | intact | none | warn and exit 0; never prune |
| Gzip stored sha256 mismatch, or raw hash mismatch on restore | intact (upload) | bad or incomplete object | no prune; restore refuses the object |
| Pre-compression object (no `contentEncoding`) | n/a | raw JSON | restore writes those bytes and checks `sha256` |
| Archive process crash / Compose `archive` restart | sequencer still producing | last complete hour only | restart sidecar; sequencer does not import this job |

### Block explorer

Node route `/explorer` plus `GET /api/explorer/blocks`. Shows what happened in block N: commitments, nullifiers, reason codes, tallies, batches — **not** ballot choices. Vote proofs and public turnout publish **once an hour**, after that hour closes, so a person leaving a voting office cannot be matched to a live jurisdiction tick. Local instant demo: `DISCLOSURE_INTERVAL_SECONDS=0`. [`docs/BLOCK_EXPLORER.md`](./BLOCK_EXPLORER.md).

### Outcomes monitor

Public SPA `/outcomes` (alias `/monitor`) plus `GET /api/outcomes` and `GET /api/outcomes/:id`. Every election is grouped **before / during / after** voting from chain and election state (`Created`/`RollFrozen`, `Open`, `Closed`/`Tallied`). The Node runs the public auditor pack (`tools/auditor` / `GET /api/elections/:id/artifacts`) plus freeze-root and L1 hash checks. During voting the page shows disclosed turnout only — never unofficial option counts. Certified counts appear only after a tally. This is not `/receipt` and not `/elections/:id/results`.

### Passkeys

WebAuthn with PRF wraps a secp256k1 smart-account key. The Merkle leaf is Poseidon(trapdoor, nullifierSecret), not the address. A person may register **up to 5** passkeys; any of them can sign in. [`docs/PASSKEYS.md`](./PASSKEYS.md).

### Emails (primary)

Up to **5** addresses per person. Exactly one is **primary** whenever any email exists. MFA (except email-as-username login) and the Terms PDF use the primary inbox. Caps are code constants — **no new env vars**. [`docs/IDENTITY.md`](./IDENTITY.md).

### Civil registration approval and credential review

A voter’s `POST /api/elections/:id/register` is **pending** until a registrar or clerk of that election’s jurisdiction approves (`POST .../registration-requests/:requestId/approve`) or denies. Officers of that jurisdiction may still insert a commitment immediately from the back office.

Smart cards and driver’s licenses / passports (up to **5** live of each) are listed at `GET /api/office/credentials`. Officers revoke an expired civil registration with `POST /api/persons/:id/methods/:methodId/revoke`. Login on a revoked or expired credential is `403 CREDENTIAL_REVOKED` / `CREDENTIAL_EXPIRED`.

A later DMV / AAMVA / national-eID connector can `POST /api/integrations/credentials/status` with `CREDENTIAL_PROVIDER_SECRET` (header `x-republic-provider-secret` or `Authorization: Bearer`). Unset secret → `501 CREDENTIAL_PROVIDER_MANUAL`. Review is **manual** until that secret is set. [`docs/IDENTITY.md`](./IDENTITY.md).

| Env | Role |
| --- | --- |
| `CREDENTIAL_PROVIDER_SECRET` | Shared secret for the status webhook. Empty = manual officer review only. |
| `CREDENTIAL_PROVIDER_ID` | Provider id recorded on updates (`manual` by default). |

### Sign in (email, Ethereum, smart card, license/passport)

Returning users sign in on `/`, `/admin`, and `/back-office` (same chrome). First-time **registration** is still `/register`. Requesting a place on an election roll waits for a **registrar or clerk** of that election’s jurisdiction to approve. Every path except gated `dev-login` completes with a **6-digit email code via AWS SES** when `SES_FROM_ADDRESS` and `AWS_REGION` are set.

**Email (username)**

1. `POST /api/auth/email/start` `{ email }`
2. SES delivers the OTP
3. `POST /api/auth/mfa/verify` `{ code }` — set `republic.sid`

**Passkey**

1. `POST /api/auth/passkey/login/begin` — discoverable / resident-key options (no username). An optional `handle` scopes `allowCredentials` when the authenticator cannot discover the passkey.
2. Browser `navigator.credentials.get` (WebAuthn assertion).
3. `POST /api/auth/passkey/login/finish` — verify assertion, then email MFA when required.
4. The credential id already maps to a Person. Roles are unchanged (`voter`, `clerk`, `platform_admin`, …).

Republic implements this with `@simplewebauthn/server`, Express, and the JSON store: challenge, assertion, then an HttpOnly session.

**Ethereum wallet**

1. Connect a wallet (EIP-1193 `eth_requestAccounts`).
2. `POST /api/auth/web3/challenge` `{ address }` — SIWE-like **login** message (nonce stored on the Node; the client message is not trusted).
3. Wallet `personal_sign`s that message.
4. `POST /api/auth/web3/login` `{ address, signature }` — verify, resolve the Person, then email MFA.

Unknown passkeys, emails, cards, licenses, and wallets return `404` `UNKNOWN_CREDENTIAL` and **do not** create a person. Revoked or expired cards and licenses return `403 CREDENTIAL_REVOKED` / `CREDENTIAL_EXPIRED`. Binding a new wallet is `POST /api/identity/web3/verify` on `/register`. Extra wallets while signed in must sign `POST /api/me/eth-accounts`.

Each person sets a **vote PIN** (4–8 digits) on Identify yourself. Change it anytime. Forgot PIN emails an MFA code (`POST /api/pin/forgot` or `POST /api/me/pin/forgot`) and then the person sets a new PIN on the phone keypad. At ballot submit the keypad **layout stays 3×3+0** but the **numbers are shuffled per person**; the UI does not accept keyboard PIN entry. A signed-in vote needs a one-use `pinToken`.

`ALLOW_DEV_LOGIN=1` (or `NODE_ENV=test`) keeps `POST /api/auth/dev-login` as a **local/test fallback** only. It skips MFA. It is not the primary officer path. Production (`master`) must leave it off.

RP id, origins: [`docs/PASSKEYS.md`](./PASSKEYS.md). Person binding rules: [`docs/IDENTITY.md`](./IDENTITY.md).

### Terms of Use (`/terms`)

Public page `/terms` (nav on public, registered, and officer chrome). Canonical source is `apps/node/legal/terms.md`. The Node builds a **deterministic PDF 1.4** from that markdown (fixed CreationDate, Helvetica — no host timestamps).

| Fingerprint | What is hashed | Where it lives |
| --- | --- | --- |
| **PDF SHA-256** (canonical, 64 hex) | Exact PDF bytes (the SES attachment) | `user.termsHash`, `termsAcceptances[].pdfSha256`, `X-Pdf-SHA256` on `GET /terms.pdf` |
| Markdown SHA-256 | UTF-8 markdown body after YAML front matter | Published on `/terms` and stored as `markdownSha256` next to the PDF hash |

Acceptance (checkbox on `/register`, or “I agree” while signed in on `/terms`) writes **who, when, version, both hashes, and whether the PDF was emailed**. New-person identity APIs require `{ acceptedTerms: true }` (`TERMS_REQUIRED` otherwise). Viewing `/terms` while signed in records one `view` per session + current PDF hash. Public `GET /api/terms` does not include PII.

The PDF is emailed with **AWS SES** on first accept of a hash, using the same env as MFA. Vote-receipt PDFs use PDF Standard Security so they cannot be edited; `/receipt` checks SHA-256 of the exact bytes.

A separate public monitor at `/outcomes` (alias `/monitor`) lists every election before / during / after voting from chain and election state. It runs the public auditor pack plus freeze-root and L1 checks. During voting it shows disclosed turnout only; certified option counts appear after a tally. It is not the receipt portal.

After `cutoffTime` has fully expired **and** a certified tally is posted, the Node issues a locked **official outcome PDF** (how many people voted for each option, when voting started, when it ended). Voters who cast a ballot are subscribed to that email by default and unsubscribe only by exception on `/me`. Platform admin customizes letterhead and intro on `/admin`; the QR verification mark and SHA-256 / HMAC seals cannot be removed. Anyone can drop the file (or scan the QR at `/o/<reportId>`) on `/outcomes/verify` to confirm the bytes still match.

| Variable | Role |
| --- | --- |
| `VOTE_FQDN` | Voting subdomain, e.g. `vote.domain.tld`. When set, official links default to `https://` that host |
| `PUBLIC_BASE_URL` | Origin printed in the official-PDF QR (defaults to `https://$VOTE_FQDN`, else the first WebAuthn origin) |
| `SES_FROM_ADDRESS` | From address (required to send) |
| `AWS_REGION` (alias `SES_REGION`) | SES region |
| `SES_CONFIGURATION_SET` | Optional SESv2 configuration set |

SESv2 Simple content cannot attach files. The Node sends **raw MIME** (`multipart/mixed`) with `republic-terms.pdf`. A second accept of the same PDF hash does not resend (`already_sent_this_hash`). If SES is unset, the Node still records the accept and **captures** the message in-process (tests use `mailer.lastTermsPdf()`, same pattern as MFA OTP capture).

Store (private `apps/node/data/republic.json`, gitignored):

```
termsAcceptances: [{ id, action: "accept"|"view", userId, handle, email, sessionId,
  termsVersion, pdfSha256, markdownSha256, hashOf: "pdf-bytes", emailed, emailedAt, createdAt }]
users[].termsHash / termsVersion / termsAcceptedAt / termsEmailSentAt / termsEmailHash
```

Changing `legal/terms.md` changes both hashes. Prior rows keep the hash that was current when the person accepted. Version 2 adds the feedback assignment clause. A person who accepted version 1 keeps that PDF hash; the next acceptance stores the new one.

### Feedback (`/feedback`)

Public page `/feedback` (nav and footer on the voter SPA). `POST /api/feedback` emails the platform super admin through the same AWS SES mailer as MFA and the Terms PDF. The message is not a vote receipt. It is not written to `republic.json`, not written to civic L2, and not logged at info level.

**Inbox.** The To address is the `platform_super_admin` person’s `contactEmail`, or that person’s sign-in email if no contact email is set. There is no separate inbox env var. If neither address is set, the Node **fails closed**: it logs a warning naming the missing super-admin email, returns `503 FEEDBACK_UNAVAILABLE`, and does not drop the message silently. The visitor sees “Feedback cannot be delivered right now. Please try again later.” The same `503` is returned when SES is not configured (`SES_FROM_ADDRESS` and `AWS_REGION` both required) unless `SES_DRY_RUN=1` with those two set (capture, no SES call) or the process is allowed to capture mail (`NODE_ENV=test` or `ALLOW_CAPTURE_MAILER=1`).

The visitor must tick the checkbox that feedback becomes the property of the project’s legal owner. The server rejects a missing tick with `400 ASSIGNMENT_REQUIRED`. The acceptance record (timestamp, terms version, PDF SHA-256, markdown SHA-256) is in the email and on one info log line. That log line does not include the message, the name, or the reply address.

| Env | Role |
| --- | --- |
| `SES_FROM_ADDRESS` | From address. Required to deliver, including dry-run. |
| `AWS_REGION` (alias `SES_REGION`) | SES region. Required with the From address. |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Optional. Empty uses the host IAM role. |
| `SES_CONFIGURATION_SET` | Optional SESv2 configuration set. |
| `SES_ENDPOINT` | Optional SESv2 endpoint override. |
| `SES_DRY_RUN` | `1` captures the message and does not call SES. Still requires From + region. |
| `FEEDBACK_RATE_WINDOW_SECONDS` | Gap between accepted submissions from one IP. Default `3600`. Values below `3600` are raised to `3600` (at most one per hour). A larger value waits longer. |
| `FEEDBACK_MIN_SUBMIT_MS` | Minimum time from form open to submit. Default `3000`. |
| `FEEDBACK_MAX_BODY_BYTES` | Maximum POST body. Default `16384`. The message is also capped at 4,000 characters. |
| `TRUST_PROXY` | Set to `1` when a reverse proxy is the TCP peer, so the limit uses the client address. Unset keys the limit on the socket peer. |

**Rate limit.** One **accepted** submission per IP per window, in memory on that Node process (not shared across replicas, cleared on restart). The second accepted-path submit returns `429` with `Retry-After` (seconds) and “You can send another message in about N minutes”. A missing checkbox, honeypot hit, too-fast submit, oversized body, or fail-closed delivery does **not** consume the slot. Another IP is not affected.

Reply-To is set only when the optional address validates. Names, the message, and request metadata are stripped of control characters. HTML in the mail is escaped. The email may include User-Agent and Accept-Language. It does not include an IP address, a cookie, a voter id, or any election field.

---

## Secrets and production

- Deploy keys, paymaster keys, sequencer keys, and proving keys are **not** in git.
- `.env` is gitignored. Copy-paste the host file from the root README [Copy-paste credentials](../README.md#copy-paste-credentials). Do not paste production RPC URLs with credentials into issues.
- `RECEIPT_PDF_SECRET` (or `$DATA_DIR/receipt-pdf.secret`) is the HMAC / PDF owner-password material for locked vote-receipt PDFs **and** official outcome PDFs. It is not a voter password; readers open the PDF without one. Editing remains forbidden.
- Contract addresses for a live election are pinned in the Node’s published election record.
- After roll freeze, do not “fix” a tally in `republic.json`. If the chain rejects a proof, the UI reports failure.
- `opens_ballots` elections run a **Feldman t-of-n** guardian ceremony (`p256-feldman-dkg-v1`). The Node stores public commitments and shares encrypted to each guardian’s transport key. It does not store a tally private key. Decrypting takes `t` verified partials after cutoff. Guardians use `node apps/node/scripts/guardian.mjs`. See [`TALLY_GUARDIANS.md`](./TALLY_GUARDIANS.md). Homomorphic aggregation and a mixnet are **not selected**. The ceremony is NON-PRODUCTION. Do not use it for a binding election.

## L1 certification (tally hash on Ethereum)

After the Node tally (`POST /api/elections/:id/tally`), copy the **tally hash** — `keccak256(abi.encodePacked(counts))`, the same `countsHash` as `Tally.TallyPosted` — to Ethereum L1 `L1TallyMirror.postCertifiedResult`. The L1 slot is `(factory, onChainElectionId, jurisdictionId)`, not the public UUID, so two bodies cannot collide by copying an id. Individual ballots are not posted. Prefer a **testnet** (Sepolia) or local Anvil until a jurisdiction pins addresses on `master`. Pin `setL2Factory` to the shared ElectionFactory (legacy `postResult` then reverts `UseIdentityPost`) and grant `setJurisdictionPublisher` per body. The Node refuses to certify without that factory pin.

`RollupSettlement` is the batch-root contract. When `L1_SETTLEMENT_ADDRESS` is set, the Node/script reads `stateRoot()` and attaches it as `l2StateRoot`. That is optional court context, not a substitute for the tally hash.

### When L1 env is unset

This is the default. The Node **still tallies**. Certification is a documented no-op (`status: "skipped"`, reason `L1 env unset`). CI must **not** set mainnet keys. `GET /api/config` reports `l1CertificationConfigured: false`.

### Env (Node process)

| Variable | Required to post | Purpose |
| --- | --- | --- |
| `L1_RPC` (alias `L1_RPC_URL`) | yes | Ethereum JSON-RPC (Sepolia / Anvil). Not Republic L2. |
| `L1_TALLY_MIRROR_ADDRESS` (alias `TALLY_MIRROR`) | yes | `L1TallyMirror` from `DeployL1.s.sol` / `DeployLocal.s.sol` |
| `L1_PUBLISHER_PRIVATE_KEY` (alias `L1_PRIVATE_KEY`) | yes | Key that is `admin` or `setPublisher`'d on the mirror. **Not** the L2 prover `PRIVATE_KEY`. |
| `L1_SETTLEMENT_ADDRESS` (alias `SETTLEMENT`) | no | `RollupSettlement` — attach current L2 state root |
| `L1_CHAIN_ID` | no | Defaults to whatever the RPC reports |

Deploy the mirror, settlement, and verifier **once** (Anvil, Sepolia, or mainnet). Container start and a rolling update only read the addresses. `npm run deploy:l1 -- --check` refuses when `SETTLEMENT_ADDRESS`, `VERIFIER_ADDRESS`, `L1_TALLY_MIRROR_ADDRESS`, `L1_SETTLEMENT_ADDRESS`, `ELECTION_FACTORY_ADDRESS`, or `BALLOT_INBOX_ADDRESS` is already set, or when `deployments/<chainId>.json` (or `DEPLOYMENTS_FILE`) has `"deployed": true`. `FORCE_REDEPLOY=1` overrides that and prints a warning. Do not set it on a live election. After broadcast, `npm run deploy:l1 -- --verify` checks `eth_getCode` and prints env lines. The prover fails closed when `L1_RPC` is set but `SETTLEMENT_ADDRESS` is missing, has no code, or `L1_CHAIN_ID` does not match. Only the prover that holds the writer lease submits. Runbook: [`ROLLING_UPDATES.md`](./ROLLING_UPDATES.md).

```bash
npm run deploy:l1 -- --check
cd smart-contracts
L2_FACTORY="$ELECTION_FACTORY_ADDRESS" forge script script/DeployL1.s.sol \
  --rpc-url "$L1_RPC" --broadcast --private-key "$L1_PUBLISHER_PRIVATE_KEY"
# stdout includes TALLY_MIRROR=0x… SETTLEMENT=0x… L2_FACTORY=0x…
# DeployL1 reverts MissingL2Factory if the shared factory is not set,
# and AlreadyDeployed if an address env var or deployment record is set.
```

The historical one-shot (same script) is below. Prefer the check above so a second run cannot land new addresses.

Deploy the mirror (Anvil or Sepolia):

```bash
cd smart-contracts
L2_FACTORY="$ELECTION_FACTORY_ADDRESS" forge script script/DeployL1.s.sol \
  --rpc-url "$L1_RPC" --broadcast --private-key "$L1_PUBLISHER_PRIVATE_KEY"
# stdout includes TALLY_MIRROR=0x… SETTLEMENT=0x… L2_FACTORY=0x…
# DeployL1 reverts MissingL2Factory if the shared factory is not set.
```

Grant a **per-jurisdiction** publisher. After `setL2Factory`, a global
`setPublisher` key cannot certify an arbitrary body (admin remains
break-glass only). The factory pin cannot be unset or swapped; a wrong
pin means a new mirror deploy:

```solidity
// Prefer per-jurisdiction publishers so one body cannot certify another:
L1TallyMirror.setJurisdictionPublisher(jurisdictionId, publisher, true);
L1TallyMirror.setL2Factory(sharedElectionFactory);
// setPublisher is legacy and is ignored once the factory is pinned.
```

### After Node tally

1. Close the poll (cutoff passed). Tally operator posts counts. Sum must equal accepted ballots.
2. If the three required L1 vars are set, `POST /api/elections/:id/tally` also calls `postCertifiedResult` (factory + jurisdiction + public UUID hash). The JSON includes `l1Certification` (`posted` / `skipped` / `failed` / `already_posted`). A failed L1 tx **does not** roll back the Node tally.
3. Retry without re-tallying. `AlreadyPosted` with the **same** hash is success (`already_posted`); the Node keeps the original L1 tx hash. If L1 already holds a **different** hash, status is `already_posted_mismatch` — do not treat that as a certified match.

```bash
# HTTP (tally_operator session)
curl -X POST http://127.0.0.1:3000/api/elections/1/certify-l1

# Public record
curl http://127.0.0.1:3000/api/elections/1/l1

# CLI against L1 (no Node auth). Unset env → exit 0 no-op.
npm run certify:l1 -- --election-id 1 --counts 2,0
npm run certify:l1 -- --election-id 1 --from-store

# Foundry (same no-op wrapper if env unset)
./smart-contracts/script/certify_l1.sh
# or, when env is set:
# COUNTS=2,0 ELECTION_ID=1 ./smart-contracts/script/certify_l1.sh
```

Back office: **Post counts**, then **Certify hash on L1** if you skipped or failed.

Do not put mainnet publisher keys in CI, Compose files committed to git, or `test/unstable` sample env.

## Disqualification operations

Only `DISQUALIFICATION_OFFICER_ROLE` (and the jurisdiction’s bound officers) may write `DisqualificationRegistry`. Every mark has a **reason code** from the public catalog, an evidence **hash**, issuer, and timestamp. No silent deletes: revocation is an event. After `rollFrozen`, new marks revert unless the election was created with `lateUpdateAllowed` (default false, discouraged).

The operator’s job is to keep the Node, sequencer, and paymaster up — not to invent who is eligible.

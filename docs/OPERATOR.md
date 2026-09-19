# Operator guide

**NOT FOR PROFIT** — civic public good. Not a commercial product. See [`/NOT_FOR_PROFIT.md`](../NOT_FOR_PROFIT.md).

How to host Republic / zk-voting: the Node process, Foundry contracts, Republic L2 (chainId **27427**), and the split between **`test/unstable`** and **`master`**.

This software may be run **at cost** by a government, county clerk, union, cooperative, or volunteer. It must not be sold as SaaS, wrapped in a token, or used to skim voter or jurisdiction funds. The paymaster sponsors L2 gas; voters are not a revenue line.

---

## What you are operating

1. **`apps/node`** — long-lived Node 22 process: voter / clerk / observer UI (vanilla JS in `public/`), HTTP API, optional vote relayer, JSON store (`apps/node/data/republic.json`). Same operational shape as DealPunchList (`dealpunchlist-node`). **No SQLite.**
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

From the repository root:

```bash
./system_actions.sh              # interactive menu
./system_actions.sh help
./system_actions.sh status       # branch, SHA, dirty, pm2/systemd/compose
./system_actions.sh checkout-dev
./system_actions.sh checkout-prod
./system_actions.sh deploy-dev   # fetch, ff-only pull, npm install, build, restart
./system_actions.sh deploy-prod  # same on master; confirms
./system_actions.sh restart
./system_actions.sh logs
./system_actions.sh health       # GET $ZK_VOTING_HEALTH_URL (default :3000/health)
```

Environment overrides: `ZK_VOTING_DEV_BRANCH`, `ZK_VOTING_PROD_BRANCH`, `ZK_VOTING_APP_NAME`, `ZK_VOTING_PM2_NAME`, `ZK_VOTING_SYSTEMD_UNIT`, `ZK_VOTING_HEALTH_URL`, `ZK_VOTING_PORT`, `ZK_VOTING_LOG_LINES`.

Restart order: **pm2** → **systemd** unit → **docker compose**. If none are configured, `restart` warns and does not fail the machine. Install / build still run on deploy.

Deploy refuses a **dirty worktree**. Commit or stash first.

Root [`.dockerignore`](../.dockerignore) applies to every image built from this repo (Node, Republic L2, Foundry deploy). It keeps `.git`, `node_modules`, `.env` / keys, Foundry `out/` `cache/` `broadcast/`, `apps/node/data`, `l2/data`, and Circom trusted-setup files (`.ptau`, `.zkey`) out of the build context. Mount voter data and proving keys as volumes; do not `COPY` them into the image.

---

## Docker Compose

Root [`docker-compose.yml`](../docker-compose.yml) is the host path `system_actions.sh` already looks for. One command builds the Node (API + SPA) and Republic L2 (sequencer + prover), the same shape as a typical frontend Compose file: images from this tree, published ports, health checks, named volumes, `restart: unless-stopped`.

```bash
cp .env.example .env          # optional; defaults are enough for a local demo
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

Voter JSON lives on the `node-data` volume (`DATA_DIR=/data`). L2 blocks and proofs live on `l2-data`. Secrets stay in `.env` (gitignored). Host-specific live-reload mounts belong in `docker-compose.override.yml` (also gitignored); start from [`docker-compose.override.example.yml`](../docker-compose.override.example.yml).

The Node binds `HOST=0.0.0.0` so the published port is reachable. The sequencer binds `L2_RPC_HOST=0.0.0.0` for the same reason (plain-Node local use still defaults to `127.0.0.1`). Inside the Compose network the Node reaches L2 at `http://l2:8546`. The host user should be able to run `docker compose` (membership in the `docker` group); `system_actions.sh` will use `sudo docker compose` when passwordless sudo is the only way to talk to the daemon.

The Node image installs the npm **workspaces** from the repository root (`@zk-voting/chain-client` is private and is not fetched from the public registry). L1 tally-hash env vars on the `node` service are optional; leaving them empty is a documented no-op.

Do not bake `RELAYER_PRIVATE_KEY`, prover `PRIVATE_KEY`, `L1_PUBLISHER_PRIVATE_KEY`, or paymaster keys into the image.

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

Expect `GET /health`. Public pages: `/`, `/vote/:id` (UUID v4 or short code), `/v/:shortCode`, `/e/:shortCode`, `/register`, `/elections/:id/info`, `/elections/:id/results`, `/admin`, `/back-office`, `/explorer`. Vanilla JS, not Vite/React. Every page footer: **NOT FOR PROFIT**.

### Creating elections (chain vs demo)

Clerk **Create election** in `/back-office` is `POST /api/elections`.

| Node env | What happens |
| --- | --- |
| `CHAIN_RPC` **unset** | JSON-only demo. Writes `apps/node/data/republic.json`. No factory call. |
| `CHAIN_RPC` **set** | The API also calls `ElectionFactory.createElection` through viem (`simulateContract` + `writeContract`), matching `@zk-voting/chain-client` and `CreateElection.s.sol`. Failures return **502/503** with a message the clerk UI shows. Nothing is saved locally if the factory reverts. |

Required when the chain is configured: `CHAIN_RPC`, `ELECTION_FACTORY_ADDRESS` (or `FACTORY`), `RELAYER_PRIVATE_KEY`, `VERIFIER_ADDRESS` (or `VERIFIER` from `DeployLocal`). Officer roles (clerk / registrar / disqualification / tally) default to the relayer address, matching `CreateElection.s.sol` using `msg.sender`, unless the POST body or `CLERK_ADDRESS` / `REGISTRAR_ADDRESS` / … is set.

The Node public election id is a UUID v4; the on-chain `electionId` is a uint256 stored as `onChainElectionId` (plus `onChainElectionAddress` / `createTxHash` when the factory ran). They can differ: `DeployLocal` already creates on-chain election `#1`. Demo mode still mints a local uint256 so Groth16 public inputs stay numeric.

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

### Block explorer

Node route `/explorer` plus `GET /api/explorer/blocks`. Shows what happened in block N: commitments, nullifiers, reason codes, tallies, batches — **not** ballot choices. Vote proofs and public turnout publish **once an hour**, after that hour closes, so a person leaving a voting office cannot be matched to a live jurisdiction tick. Local instant demo: `DISCLOSURE_INTERVAL_SECONDS=0`. [`docs/BLOCK_EXPLORER.md`](./BLOCK_EXPLORER.md).

### Passkeys

WebAuthn with PRF wraps a secp256k1 smart-account key. The Merkle leaf is Poseidon(trapdoor, nullifierSecret), not the address. [`docs/PASSKEYS.md`](./PASSKEYS.md).

### Sign in (email, Ethereum, smart card, license/passport)

Returning users sign in on `/`, `/admin`, and `/back-office` (same chrome). First-time **registration** is still `/register`. Every path except gated `dev-login` completes with a **6-digit email code via AWS SES** when `SES_FROM_ADDRESS` and `AWS_REGION` are set.

**Email (username)**

1. `POST /api/auth/email/start` `{ email }`
2. SES delivers the OTP
3. `POST /api/auth/mfa/verify` `{ code }` — set `republic.sid`

**Passkey (DFC-shaped ceremony, Republic stack)**

1. `POST /api/auth/passkey/login/begin` — discoverable / resident-key options (no username). An optional `handle` scopes `allowCredentials` when the authenticator cannot discover the passkey.
2. Browser `navigator.credentials.get` (WebAuthn assertion).
3. `POST /api/auth/passkey/login/finish` — verify assertion, then email MFA when required.
4. The credential id already maps to a Person. Roles are unchanged (`voter`, `clerk`, `platform_admin`, …).

This mirrors Daily Family Call’s challenge → assertion → HttpOnly session shape. Republic implements it with `@simplewebauthn/server`, Express, and the JSON store — it does not vendor DFC.

**Ethereum wallet**

1. Connect a wallet (EIP-1193 `eth_requestAccounts`).
2. `POST /api/auth/web3/challenge` `{ address }` — SIWE-like **login** message (nonce stored on the Node; the client message is not trusted).
3. Wallet `personal_sign`s that message.
4. `POST /api/auth/web3/login` `{ address, signature }` — verify, resolve the Person, then email MFA.

Unknown passkeys, emails, cards, licenses, and wallets return `404` `UNKNOWN_CREDENTIAL` and **do not** create a person. Binding a new wallet is `POST /api/identity/web3/verify` on `/register`.

`ALLOW_DEV_LOGIN=1` (or `NODE_ENV=test`) keeps `POST /api/auth/dev-login` as a **local/test fallback** only. It skips MFA. It is not the primary officer path. Production (`master`) must leave it off.

RP id, origins: [`docs/PASSKEYS.md`](./PASSKEYS.md). Person binding rules: [`docs/IDENTITY.md`](./IDENTITY.md).

### Terms of Use (`/terms`)

Public page `/terms` (nav on public, registered, and officer chrome). Canonical source is `apps/node/legal/terms.md`. The Node builds a **deterministic PDF 1.4** from that markdown (fixed CreationDate, Helvetica — no host timestamps).

| Fingerprint | What is hashed | Where it lives |
| --- | --- | --- |
| **PDF SHA-256** (canonical, 64 hex) | Exact PDF bytes (the SES attachment) | `user.termsHash`, `termsAcceptances[].pdfSha256`, `X-Pdf-SHA256` on `GET /terms.pdf` |
| Markdown SHA-256 | UTF-8 markdown body after YAML front matter | Published on `/terms` and stored as `markdownSha256` next to the PDF hash |

Acceptance (checkbox on `/register`, or “I agree” while signed in on `/terms`) writes **who, when, version, both hashes, and whether the PDF was emailed**. New-person identity APIs require `{ acceptedTerms: true }` (`TERMS_REQUIRED` otherwise). Viewing `/terms` while signed in records one `view` per session + current PDF hash. Public `GET /api/terms` does not include PII.

The PDF is emailed with **AWS SES** on first accept of a hash, using the same env as MFA:

| Variable | Role |
| --- | --- |
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

Changing `legal/terms.md` changes both hashes. Prior rows keep the hash that was current when the person accepted.

---

## Secrets and production

- Deploy keys, paymaster keys, sequencer keys, and proving keys are **not** in git.
- `.env` is gitignored. Do not paste production RPC URLs with credentials into issues.
- Contract addresses for a live election are pinned in the Node’s published election record.
- After roll freeze, do not “fix” a tally in `republic.json`. If the chain rejects a proof, the UI reports failure.
- `opens_ballots` elections store a **threshold-1** P-256 private JWK in the Node data file (`tallyGuardians`). That key decrypts every ballot. It is a demo, labeled NON-PRODUCTION. Do not use it for a binding election. Production guardians / mixnet are not this host’s JSON file.

## L1 certification (tally hash on Ethereum)

After the Node tally (`POST /api/elections/:id/tally`), copy the **tally hash** — `keccak256(abi.encodePacked(counts))`, the same `countsHash` as `Tally.TallyPosted` — to Ethereum L1 `L1TallyMirror.postResult`. Individual ballots are not posted. Prefer a **testnet** (Sepolia) or local Anvil until a jurisdiction pins addresses on `master`.

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

Deploy the mirror (Anvil or Sepolia):

```bash
cd smart-contracts
forge script script/DeployL1.s.sol --rpc-url "$L1_RPC" --broadcast --private-key "$L1_PUBLISHER_PRIVATE_KEY"
# stdout includes TALLY_MIRROR=0x… and SETTLEMENT=0x…
```

Grant a dedicated publisher if the broadcaster is not the mirror admin:

```solidity
L1TallyMirror.setPublisher(publisher, true);
```

### After Node tally

1. Close the poll (cutoff passed). Tally operator posts counts. Sum must equal accepted ballots.
2. If the three required L1 vars are set, `POST /api/elections/:id/tally` also calls `postResult`. The JSON includes `l1Certification` (`posted` / `skipped` / `failed` / `already_posted`). A failed L1 tx **does not** roll back the Node tally.
3. Retry without re-tallying. `AlreadyPosted` is success (`already_posted`); the Node keeps the original L1 tx hash.

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

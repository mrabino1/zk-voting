# Operator guide

**NOT FOR PROFIT** — civic public good. Not a commercial product. See [`/NOT_FOR_PROFIT.md`](../NOT_FOR_PROFIT.md).

How to host Republic / zk-voting: the Node process, Foundry contracts, Republic L2 (chainId **27427**), and the split between **`test/unstable`** and **`master`**.

This software may be run **at cost** by a government, county clerk, union, cooperative, or volunteer. It must not be sold as SaaS, wrapped in a token, or used to skim voter or jurisdiction funds. The paymaster sponsors L2 gas; voters are not a revenue line.

---

## What you are operating

1. **`apps/node`** — long-lived Node 22 process: voter / clerk / observer UI, HTTP API, optional vote relayer, SQLite (`apps/node/data/republic.sqlite`). Same operational shape as DealPunchList (`dealpunchlist-node`).
2. **`smart-contracts/`** — Solidity 0.8.24, Foundry. Factory, registries, inbox, tally verifier, passkey account, L1 `RollupSettlement`.
3. **`l2/`** — Republic sequencer + prover. Settles batches to L1. Not a hosted Lighter sequencer; Lighter is prior art (see root README).
4. **`circuits/`** — circom vote / tally. Local and CI use `MockVerifier` until a Poseidon hasher and Groth16 keys exist.

The Node is allowed to be down. Chain records (L2, and L1 if you mirrored the tally) must still be enough for an independent verifier.

---

## Branch policy (non-negotiable)

| Line | Branch | Meaning |
| --- | --- | --- |
| Development / staging | `test/unstable` | Default. Experimental elections, MockVerifier, Anvil, local L2. |
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

## First-time machine

```bash
# Node 22+
node -v

# Foundry 1.8+ (solc 0.8.24 comes via foundry.toml)
foundryup
cd smart-contracts && forge test

# Optional: circom 2 + snarkjs when you leave MockVerifier
# Optional: viem in the Node app for ABI encoding (packages/chain-client)

git checkout test/unstable
./system_actions.sh deploy-dev
```

Local Anvil + scripts (see `smart-contracts/script/`): `DeployLocal.s.sol` prints `name=0x…` for the Node to ingest. Broadcast JSON is gitignored.

---

## Running the pieces

### Foundry tests

```bash
cd smart-contracts
forge test
forge test --fuzz-runs 256
forge test --match-path test/invariant/*
```

From repo root: `npm run test:contracts`, `npm run test:fuzz`, `npm run test:invariant`.

### Node

```bash
# workspaces
npm install
npm run dev          # apps/node Vite + API when scripts exist
npm run start        # production-style Node process
npm test -w apps/node
```

Expect `GET /health`. Public SPA routes include `/`, `/vote/:id`, `/register`, `/admin`, `/back-office`, `/explorer`, `/elections/:id/info`, `/elections/:id/results`. Every page footer: **NOT FOR PROFIT**.

### Republic L2

```bash
npm run l2:sequencer   # node l2/sequencer/index.mjs
npm run l2:prover      # node l2/prover/index.mjs
```

`l2/genesis.json` uses **chainId 27427**, 2s period, one sequencer. Voters do not hold the gas token; `RepublicPaymaster` sponsors UserOps that hit `BallotInbox`, `VoterRegistry.register`, or `PasskeyAccountFactory`. Fund the paymaster from the **jurisdiction budget at cost**, not from voters.

Details: [`docs/L2.md`](./L2.md).

### Block explorer

Node route `/explorer` plus `GET /api/explorer/blocks`. Shows what happened in block N: commitments, nullifiers, reason codes, tallies, batches — **not** ballot choices. Vote proofs and public turnout publish **once an hour**, after that hour closes, so a person leaving a voting office cannot be matched to a live jurisdiction tick. Local instant demo: `DISCLOSURE_INTERVAL_SECONDS=0`. [`docs/BLOCK_EXPLORER.md`](./BLOCK_EXPLORER.md).

### Passkeys

WebAuthn with PRF wraps a secp256k1 smart-account key. The Merkle leaf is Poseidon(trapdoor, nullifierSecret), not the address. [`docs/PASSKEYS.md`](./PASSKEYS.md).

### Sign in (passkey and Ethereum wallet)

Returning users sign in on `/`, `/admin`, and `/back-office` (same chrome). First-time **registration** is still `/register`.

**Passkey (DFC-shaped ceremony, Republic stack)**

1. `POST /api/auth/passkey/login/begin` — discoverable / resident-key options (no username). An optional `handle` scopes `allowCredentials` when the authenticator cannot discover the passkey.
2. Browser `navigator.credentials.get` (WebAuthn assertion).
3. `POST /api/auth/passkey/login/finish` — verify assertion, set `republic.sid`.
4. The credential id already maps to a Person. Roles are unchanged (`voter`, `clerk`, `platform_admin`, …).

This mirrors Daily Family Call’s challenge → assertion → HttpOnly session shape. Republic implements it with `@simplewebauthn/server`, Express, and the JSON store — it does not vendor DFC.

**Ethereum wallet**

1. Connect a wallet (EIP-1193 `eth_requestAccounts`).
2. `POST /api/auth/web3/challenge` `{ address }` — SIWE-like **login** message (nonce stored on the Node; the client message is not trusted).
3. Wallet `personal_sign`s that message.
4. `POST /api/auth/web3/login` `{ address, signature }` — verify, resolve the Person who already has that web3 method or verified ETH address, set the same session cookie.

Unknown passkeys and unknown wallets return `404` `UNKNOWN_CREDENTIAL` and **do not** create a person. Binding a new wallet is `POST /api/identity/web3/verify` on `/register`.

`ALLOW_DEV_LOGIN=1` (or `NODE_ENV=test`) keeps `POST /api/auth/dev-login` as a **local/test fallback** only. It is not the primary officer path. Production (`master`) must leave it off.

RP id, origins: [`docs/PASSKEYS.md`](./PASSKEYS.md). Person binding rules: [`docs/IDENTITY.md`](./IDENTITY.md).

---

## Secrets and production

- Deploy keys, paymaster keys, sequencer keys, and proving keys are **not** in git.
- `.env` is gitignored. Do not paste production RPC URLs with credentials into issues.
- Contract addresses for a live election are pinned in the Node’s published election record.
- After roll freeze, do not “fix” a tally in SQLite. If the chain rejects a proof, the UI reports failure.

## Disqualification operations

Only `DISQUALIFICATION_OFFICER_ROLE` (and the jurisdiction’s bound officers) may write `DisqualificationRegistry`. Every mark has a **reason code** from the public catalog, an evidence **hash**, issuer, and timestamp. No silent deletes: revocation is an event. After `rollFrozen`, new marks revert unless the election was created with `lateUpdateAllowed` (default false, discouraged).

The operator’s job is to keep the Node, sequencer, and paymaster up — not to invent who is eligible.

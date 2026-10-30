# zk-voting

**NOT FOR PROFIT**: civic public good, not a commercial product. License: AGPL-3.0-or-later ([`LICENSE`](./LICENSE)).

A zero-knowledge, Ethereum-settled voting and polling system that anyone can self-host, fork and rebrand.

## Quick start: clone and launch

```bash
git clone https://github.com/mrabino1/zk-voting.git
cd zk-voting
./setup.sh            # or: cd voting_node && npm run setup
```

`./setup.sh` asks six short questions and writes `voting_node/.env`:

1. **Super admin**: handle, contact email, and a setup token (`SETUP_TOKEN`) that guards `/setup` until you claim it.
2. **Chain id**: 27427 (civic L2, default), 1, 11155111, 31337 or your own; or leave it for the `/setup` page.
3. **Entropy ceremony**: is there one, and its host (for example `ceremony.zk-voting.org`).
4. **Setup entropy**: if the ceremony is closed, paste its validated `zke1:ceremony:…` output; otherwise generate local entropy now or skip.
5. **Site and environment**: public hostname (`VOTE_FQDN`), port, reverse proxy, database (JSON or Postgres), product name. Missing app secrets are generated.
6. **L2 identity and L1 settlement**: `L1_RPC`, `L1_SUBMITTER_PRIVATE_KEY` (secret), and a new `L2_UUID`, `L2_SALT` (secret) and `L2_ADMIN_SECRET` (secret), from which it derives `L2_OPERATOR_ADDRESS` and `L2_ID` and checks the submitter balance (warning when low).

It never prints a secret, keeps your answers as the defaults when you run it again (a re-run with nothing changed writes nothing), and ends with the exact launch command: `docker compose up -d --build` here, the Coolify settings (`--deploy coolify`), or `npm run dev`. Then open `/setup` in the browser to create the super admin passkey and finish. Options: `./setup.sh --help` (`-y` takes every default). Details: [First launch](./voting_node/docs/self-hosting/first-launch.md), [L2 identity and settlement](./voting_node/docs/L2-IDENTITY-AND-SETTLEMENT.md).

## What is in this repository

This repository is a monorepo with four parts:

| Folder | What it is | Served at |
| --- | --- | --- |
| [`voting_node/`](./voting_node) | The full application: Node app (`apps/node`), shared packages, circuits, civic L2, tools, docs, Docker Compose files. Its [README](./voting_node/README.md) is the full product and developer guide. | demo.zk-voting.org (Coolify base directory `/voting_node`) |
| [`site/`](./site) | Static informational landing page (HTML/CSS served by nginx). | zk-voting.org (Coolify base directory `/site`) |
| [`zk-entropy/`](./zk-entropy) | Entropy library + CLI (keyboard, mouse, `crypto.getRandomValues`, jitter; portable `zke1:` strings) and the public entropy-ceremony web app in [`zk-entropy/ceremony`](./zk-entropy/ceremony). | ceremony.zk-voting.org (Coolify base directory `/zk-entropy`, Dockerfile `ceremony/Dockerfile`) |
| [`smart-contracts/`](./smart-contracts) | Solidity smart contracts (Foundry, vendored `forge-std`). Hand-owned: changes to contract code are made by maintainers only. | Ethereum L1 / EVM venues |

`circuits` at the root is a symlink to `voting_node/circuits`, so the Foundry tests in `smart-contracts/` can still read `../circuits/fixtures`.

## Build and test each part

```bash
# app
cd voting_node && npm ci && npm run build
docker compose up -d --build        # from voting_node/

# contracts (needs Foundry)
cd smart-contracts && forge test --via-ir # or: npm run test:contracts from voting_node/

# site
docker build -t zk-voting-site site

# entropy library + ceremony app
cd zk-entropy && npm test && npm run test:all
docker build -f zk-entropy/ceremony/Dockerfile -t zk-entropy-ceremony zk-entropy
```

## Guardian key ceremony scripts

[`scripts/ceremony/`](./scripts/ceremony) creates a 4096-bit RSA ceremony and backup key, encrypts the private key, and splits that passphrase into guardian shares. The key is not wired into contracts or the application. Guide: [`docs/ceremony/guardian-key-ceremony.md`](./docs/ceremony/guardian-key-ceremony.md).

```bash
bash scripts/ceremony/ssss.sh selftest
bash scripts/ceremony/roundtrip.sh
```

## Canonical contract addresses

The zk-voting maintainers will acknowledge the following Ethereum mainnet (L1) contracts as canonical. **None is deployed yet.** Every entry is **TBD** until it is published here, in a signed release, and on [zk-voting.org](https://zk-voting.org).

| Contract | Role | Ethereum mainnet address |
| --- | --- | --- |
| Batch submitter / `RollupSettlement` | Accepts each L2's vote batches (state roots) | **TBD** |
| `L1TallyMirror` | Final election results, keyed by `electionKey = hash(l2Id, electionUuid)` | **TBD** |
| `ZkVotingMailbox` | L1 ↔ L2 messages (advisory) | **TBD** |
| L2 registry (`ZkVotingL2Registry`, proposed) | Registers each operator's L2 (`l2Id`) and its election keys | **TBD** |

When an address is published it will link to etherscan.io (for example `https://etherscan.io/address/<address>`).

> **Warning:** always check an address against at least two official sources (this README on `master`, a signed release, zk-voting.org) before you use it. Do not send funds to, or approve, any address that is not listed here. Anyone can deploy look-alike contracts.

How L2s, elections and these contracts fit together: [`voting_node/docs/L2-IDENTITY-AND-SETTLEMENT.md`](./voting_node/docs/L2-IDENTITY-AND-SETTLEMENT.md). Proposed contract changes: [`docs/proposals/L2-REGISTRY-AND-ELECTION-KEYS.md`](./docs/proposals/L2-REGISTRY-AND-ELECTION-KEYS.md).

## Branches

- `master`: production. Coolify builds the demo from `/voting_node` and the main site from `/site`.
- `test/unstable`: the development line, on the same monorepo layout. Coolify TEST builds the app from `/voting_node`.

Community: [community.zk-voting.org](https://community.zk-voting.org). Contributing: [`CONTRIBUTING.md`](./CONTRIBUTING.md).

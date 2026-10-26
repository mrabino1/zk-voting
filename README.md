# zk-voting

**NOT FOR PROFIT**: civic public good, not a commercial product. License: AGPL-3.0-or-later ([`LICENSE`](./LICENSE)).

A zero-knowledge, Ethereum-settled voting and polling system that anyone can self-host, fork and rebrand. This repository is a monorepo with four parts:

| Folder | What it is | Served at |
| --- | --- | --- |
| [`demo/`](./demo) | The full application: Node app (`apps/node`), shared packages, circuits, civic L2, tools, docs, Docker Compose files. Its [README](./demo/README.md) is the full product and developer guide. | demo.zk-voting.org (Coolify base directory `/demo`) |
| [`site/`](./site) | Static informational landing page (HTML/CSS served by nginx). | zk-voting.org (Coolify base directory `/site`) |
| [`zk-entropy/`](./zk-entropy) | Entropy library + CLI (keyboard, mouse, `crypto.getRandomValues`, jitter; portable `zke1:` strings) and the public entropy-ceremony web app in [`zk-entropy/ceremony`](./zk-entropy/ceremony). | ceremony.zk-voting.org (Coolify base directory `/zk-entropy`, Dockerfile `ceremony/Dockerfile`) |
| [`smart-contracts/`](./smart-contracts) | Solidity smart contracts (Foundry, vendored `forge-std`). Hand-owned: changes to contract code are made by maintainers only. | Ethereum L1 / EVM venues |

`circuits` at the root is a symlink to `demo/circuits`, so the Foundry tests in `smart-contracts/` can still read `../circuits/fixtures`.

## Quick start

```bash
# app
cd demo && npm ci && npm run build
docker compose up -d --build        # from demo/

# contracts (needs Foundry)
cd smart-contracts && forge test --via-ir # or: npm run test:contracts from demo/

# site
docker build -t zk-voting-site site

# entropy library + ceremony app
cd zk-entropy && npm test && npm run test:all
docker build -f zk-entropy/ceremony/Dockerfile -t zk-entropy-ceremony zk-entropy
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

How L2s, elections and these contracts fit together: [`demo/docs/L2-IDENTITY-AND-SETTLEMENT.md`](./demo/docs/L2-IDENTITY-AND-SETTLEMENT.md). Proposed contract changes: [`docs/proposals/L2-REGISTRY-AND-ELECTION-KEYS.md`](./docs/proposals/L2-REGISTRY-AND-ELECTION-KEYS.md).

## Branches

- `master`: production. Coolify builds the demo from `/demo` and the main site from `/site`.
- `test/unstable`: the development line, on the same monorepo layout. Coolify TEST builds the app from `/demo`.

Community: [community.zk-voting.org](https://community.zk-voting.org). Contributing: [`CONTRIBUTING.md`](./CONTRIBUTING.md).

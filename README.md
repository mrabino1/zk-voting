# zk-voting

**NOT FOR PROFIT**: civic public good, not a commercial product. License: AGPL-3.0-or-later ([`LICENSE`](./LICENSE)).

A zero-knowledge, Ethereum-settled voting and polling system that anyone can self-host, fork and rebrand. This repository is a monorepo with three parts:

| Folder | What it is | Served at |
| --- | --- | --- |
| [`demo/`](./demo) | The full application: Node app (`apps/node`), shared packages, circuits, civic L2, tools, docs, Docker Compose files. Its [README](./demo/README.md) is the full product and developer guide. | demo.zk-voting.org (Coolify base directory `/demo`) |
| [`site/`](./site) | Static informational landing page (HTML/CSS served by nginx). | zk-voting.org (Coolify base directory `/site`) |
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
```

## Branches

- `master`: production. Coolify builds the demo from `/demo` and the main site from `/site`.
- `test/unstable`: the development line, on the same monorepo layout. Coolify TEST builds the app from `/demo`.

Community: [community.zk-voting.org](https://community.zk-voting.org). Contributing: [`CONTRIBUTING.md`](./CONTRIBUTING.md).

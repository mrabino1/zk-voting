# zk-voting

**NOT FOR PROFIT**: civic public good, not a commercial product. License: AGPL-3.0-or-later ([`LICENSE`](./LICENSE)).

A zero-knowledge, Ethereum-settled voting and polling system that anyone can self-host, fork and rebrand, the way a community runs its own Discourse.

- **Civic votes** settle on **ZkVotingRollup**, one Ethereum L1 contract shared by every jurisdiction. Ballots are encrypted in the voter's browser; an L2 operator batches them; after the cutoff, k-of-n guardians decrypt **only the final sum**, and L1 checks it. No single ballot is ever decrypted. Design: [`smart-contracts/docs/ROLLUP.md`](./smart-contracts/docs/ROLLUP.md).
- **Polls** run on your own Node: ranked choice (IRV), interim results, ERC-20 token polls. Their privacy is weaker than a civic vote's, and the app says so.

## Quick start: clone and launch

```bash
git clone https://github.com/mrabino1/zk-voting.git
cd zk-voting
./setup.sh            # or: cd voting_node && npm run setup
```

`./setup.sh` asks six short questions and writes `voting_node/.env`:

1. **Super admin**: handle, contact email, and a setup token (`SETUP_TOKEN`) that guards `/setup` until you claim it.
2. **Chain id**: the node's own chain id (27427 by default, or 1, 11155111, 31337, your own); or leave it for the `/setup` page.
3. **Entropy ceremony**: is there one, and its host (for example `ceremony.zk-voting.org`).
4. **Setup entropy**: if the ceremony is closed, paste its validated `zke1:ceremony:…` output; otherwise generate local entropy now or skip.
5. **Site and environment**: public hostname (`VOTE_FQDN`), port, reverse proxy, database (Postgres, or JSON files without Compose), product name. Missing app secrets are generated.
6. **Rollup**: a **local chain** in Docker Compose (the default: Anvil on chain 31337 with ZkVotingRollup deployed for you, nothing to pay or sign up for) or **an existing deployment** (`L1_RPC`, `ROLLUP_ADDRESS`, your jurisdiction id, the node key and the L2 operator key, with an L1 balance check). Optional `L1_RPC_AUTH_TOKEN` is a bearer token for an L1 RPC that requires auth; leave it empty when the endpoint does not.

It never prints a secret, keeps your answers as the defaults when you run it again (a re-run with nothing changed writes nothing), and ends with the exact launch command: `docker compose up -d --build` here, the Coolify settings (`--deploy coolify`), or `npm run dev`. Then open `/setup` in the browser to create the super admin passkey and finish. Options: `./setup.sh --help` (`-y` takes every default). Details: [First launch](./voting_node/docs/self-hosting/first-launch.md), [Self-hosting](./voting_node/docs/self-hosting/README.md), [Forking and staying current](./voting_node/docs/self-hosting/forking.md).

## What is in this repository

This repository is a monorepo with four parts:

| Folder | What it is | Served at |
| --- | --- | --- |
| [`voting_node/`](./voting_node) | The full application: Node app (`apps/node`), the L2 rollup operator (`l2/rollup`), shared packages, circuits, tools, docs, Docker Compose files. Its [README](./voting_node/README.md) is the full product and developer guide. | demo.zk-voting.org (Coolify base directory `/voting_node`) |
| [`site/`](./site) | Static informational landing page (HTML/CSS served by nginx). | zk-voting.org (Coolify base directory `/site`) |
| [`zk-entropy/`](./zk-entropy) | Entropy library + CLI (keyboard, mouse, `crypto.getRandomValues`, jitter; portable `zke1:` strings) and the public entropy-ceremony web app in [`zk-entropy/ceremony`](./zk-entropy/ceremony). | ceremony.zk-voting.org (Coolify base directory `/zk-entropy`, Dockerfile `ceremony/Dockerfile`) |
| [`smart-contracts/`](./smart-contracts) | `ZkVotingRollup` and its libraries and verifiers (Foundry, vendored `forge-std`). Hand-owned: changes to contract code are made by maintainers only. | Ethereum L1 |

`circuits` at the root is a symlink to `voting_node/circuits`, so the Foundry tests in `smart-contracts/` can still read `../circuits/fixtures`.

## Build and test each part

```bash
# app
cd voting_node && npm ci && npm run build
docker compose up -d --build        # from voting_node/

# contracts (needs Foundry)
cd smart-contracts && forge test        # or: npm run test:contracts from voting_node/

# site
docker build -t zk-voting-site site

# entropy library + ceremony app
cd zk-entropy && npm test && npm run test:all
docker build -f zk-entropy/ceremony/Dockerfile -t zk-entropy-ceremony zk-entropy
```

## Guardian key ceremony scripts

[`scripts/ceremony/`](./scripts/ceremony) creates a 4096-bit RSA ceremony and backup key, encrypts the private key, and splits that passphrase into guardian shares. This private key is a ceremony and backup key. It is not wired into contracts or the application. This key is separate from the ballot encryption key. This ceremony does not produce the ballot encryption key. The L2 operator gets public/ only, never a share. Guide: [`docs/ceremony/guardian-key-ceremony.md`](./docs/ceremony/guardian-key-ceremony.md).

```bash
bash scripts/ceremony/ssss.sh selftest
bash scripts/ceremony/roundtrip.sh
```

## Canonical contract address

Every jurisdiction on a public chain uses **one** ZkVotingRollup deployment; a fork does not deploy
its own. **It is not deployed on any public chain yet** (see Known limits). The address will be
published here, in a signed release, and on [zk-voting.org](https://zk-voting.org).

| Contract | Role | Ethereum mainnet address |
| --- | --- | --- |
| `ZkVotingRollup` | Jurisdictions, elections, guardian key ceremony, ballot batches, threshold decryption of the final sum, desert mode | **TBD** |

> **Warning:** check an address against at least two official sources (this README on `master`, a
> signed release, zk-voting.org) before you use it. Anyone can deploy a look-alike contract.

## Known limits

Read these before you plan a real election:

- **No batch validity circuit yet.** The circuit that proves each batch (and, recursively, each
  voter's ballot proof) is specified but not built; the design and options are in
  [`docs/proposals/batch-validity-circuit.md`](./docs/proposals/batch-validity-circuit.md). Until it is, the rollup settles only against
  `MockBatchVerifier`, which exists only on the local chain (31337). The operator refuses to start
  against a real verifier, so a public-chain civic vote is not possible yet.
- **Eligibility is gated by the Node, not proven.** Roll membership is not proven in zero
  knowledge. The Node issues one blind vote pass per voter on the roll and records who took a pass
  (a poll book, never which ballot). The ballot's 0/1 and sum-to-one proofs are real and checked.
- **Polls are weaker.** A poll is counted by your Node and can disclose interim results.
- **Docker Compose not yet run end to end.** The same processes (Anvil, `deploy.sh`, the L2
  operator and the Node) run one civic vote without Docker in `npm run test:fullstack`, and the
  voter pages are checked in Chrome, but a full `docker compose up` run is still to be done.
- **The Terms of Use are a placeholder.** `voting_node/apps/node/legal/terms.md` ships as a
  template with bracketed fields (operator name, governing law, contacts). Fill them in and have
  counsel review them before real voters accept.

## Branches

- `master`: production. Coolify builds the demo from `/voting_node` and the main site from `/site`.
- `test/unstable`: the development line, on the same monorepo layout. Coolify TEST builds the app from `/voting_node`.

Community: [community.zk-voting.org](https://community.zk-voting.org). Contributing: [`CONTRIBUTING.md`](./CONTRIBUTING.md).

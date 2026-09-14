# Contributing

**NOT FOR PROFIT** — civic public good. Not a commercial product. See [`NOT_FOR_PROFIT.md`](./NOT_FOR_PROFIT.md).

Republic / zk-voting is a public-interest election stack: private ballots, public eligibility and disqualification **process**, Ethereum settlement. There is no token, no paid tier, and no vendor lock-in. If a patch adds fees, skimmable ETH (beyond gas sponsorship), or commercialization copy, it will be rejected.

## Branches

| Branch | Role |
| --- | --- |
| **`test/unstable`** | Default development and staging. Almost all work lands here first. |
| **`master`** | Production only. Promote a build when a jurisdiction is meant to run it. |

Do not open production deploy PRs against `test/unstable`. Do not merge experimental circuits or MockVerifier defaults onto `master`.

Feature work may use short-lived branches, but the integration line the host script tracks is `test/unstable`.

## Operator script

Hosts use [`system_actions.sh`](./system_actions.sh) (DealPunchList / `dealpunchlist-node` pattern):

```bash
./system_actions.sh              # interactive menu
./system_actions.sh status
./system_actions.sh deploy-dev   # pull test/unstable, install, build, restart
./system_actions.sh deploy-prod  # pull master (confirms first)
./system_actions.sh health
```

`deploy-prod` fast-forwards **`master`**. It will refuse a dirty tree. See [`docs/OPERATOR.md`](./docs/OPERATOR.md).

## What to change where

| Area | Path | Notes |
| --- | --- | --- |
| Spec / product intent | `README.md`, `docs/ARCHITECTURE.md` | If code disagrees with ARCHITECTURE, the code is wrong. |
| Solidity | `smart-contracts/src/` | `pragma solidity ^0.8.24`, AGPL, `// NOT FOR PROFIT` on every file. |
| Foundry tests | `smart-contracts/test/` | Unit, fuzz (`--fuzz-runs 256`), invariants. |
| Circuits | `circuits/` | Self-contained circom 2. Poseidon in production; stand-in hasher is labeled. |
| Shared JS | `packages/types`, `proof-helpers`, `chain-client` | JSDoc types; optional `viem`. |
| Node app | `apps/node/` | DealPunchList-shaped API + SPA. Footer: NOT FOR PROFIT. |
| L2 | `l2/` | Own sequencer + prover, chainId **27427**. |

Do not put legal names, dates of birth, or street addresses on chain. Do not emit the selected option in an event. Do not print “I voted for X” receipts.

## Tests you should run

```bash
# Solidity (from repo root)
npm run test:contracts
# equivalent:
cd smart-contracts && forge test

# Fuzz (256 runs is the foundry.toml default)
cd smart-contracts && forge test --fuzz-runs 256
# or: npm run test:fuzz

# Invariants
cd smart-contracts && forge test --match-path 'test/invariant/*'
# or: npm run test:invariant

# Node API (when apps/node tests exist)
npm test -w apps/node
```

Install Foundry (`foundryup`) so `forge` is on `PATH`. Optimizer and solc **0.8.24** are set in `smart-contracts/foundry.toml`.

## Documentation label

Every document you add must carry a visible **NOT FOR PROFIT** label near the top (see `NOT_FOR_PROFIT.md`). Solidity files carry:

```solidity
// NOT FOR PROFIT — civic public good, not a commercial product.
```

## License

AGPL-3.0-or-later. Contributions are under the same license. This is a civic public good, not a commercial product.

# L1 on mainnet, L2 on a new server

How to deploy the L1 settlement set to Ethereum mainnet through
`ZkVotingDeployer`, then bring up the L2 on a fresh server and deploy the
election stack to it. Everything here is generic and env-driven. Nothing in
the repo provisions a server, DNS, firewall or TLS.

> **Mainnet code-size limit (read first).** `RollupSettlement` (~58 KB runtime)
> and `BallotInbox` (~27 KB) are larger than EIP-170's 24,576-byte limit,
> which mainnet still enforces. They fit the EIP-7954 caps (65,536 runtime /
> 131,072 init code) planned for the next hard fork. Until mainnet activates
> it, or the contracts are split, a mainnet deploy of those two **cannot
> succeed**. The deployer preflight refuses them up front
> (`CodeTooLarge(name, size, limit)`) instead of wasting gas. Set
> `--code-size-limit 65536` only on a chain that really enforces the larger
> cap.

## The deployer

`smart-contracts/src/deploy/ZkVotingDeployer.sol` (~6 KB) deploys creation
code passed as calldata with CREATE2 under `keccak256(namespace, label)`, so
every address is known before broadcast and the deployer never hits EIP-170
itself. The deployer is deployed through the canonical CREATE2 factory, so its
own address depends only on the namespace, the launcher and the admin.

* Only the launcher (the deploying EOA) may call it, and only until it is
  **sealed**. Sealing is one-way and happens at the end of every run.
* `ElectionFactory` is built with the deployer as temporary admin, wired in a
  single transaction (`wireElectionStack`), then handed to `ADMIN` with
  `transferAdmin`. `ADMIN` calls `acceptAdmin()`, which clears every role the
  deployer held.
* Contracts whose admin cannot be transferred (`RollupSettlement`,
  `L1TallyMirror`, `ZkVotingMailbox`, `JurisdictionRegistry`,
  `ZkVotingPaymaster`) are built with `ADMIN` directly. The deployer checks it.
* On chain id 1 the deployer reverts on any mock verifier, `allowMockVerifiers`,
  a mock-mode settlement, or a batch verifier with no code.
* Admin-only follow-ups (`acceptAdmin`, `setSponsoredTargets`, the CIVIC
  jurisdiction, `setL2Factory`, `setSettlement`) are sent by the script when
  the signer is `ADMIN`. Otherwise they are printed as `ADMIN_TODO` lines with
  calldata and saved in the record under `adminTodo`, for a multisig.

## 1. L1 (mainnet)

```sh
cd voting_node
export ADMIN=0x...            # multisig recommended
export SEQUENCER=0x... PROVER=0x...
export BATCH_VERIFIER=0x...   # a real verifier contract; never a mock
# optional now, or pin later from the L2 step:
# export L2_FACTORY=0x...

# 1. Fork rehearsal (local anvil fork; skipped when unset)
MAINNET_FORK_RPC_URL=... ./scripts/deploy-fork-dryrun.sh
# 2. Simulate against mainnet itself (no broadcast)
./scripts/deploy.sh --target l1 --via-deployer --rpc-url "$L1_RPC" --account deployer --dry-run
# 3. Broadcast, then verify on Etherscan
./scripts/deploy.sh --target l1 --via-deployer --rpc-url "$L1_RPC" --account deployer --yes \
  --verify            # needs ETHERSCAN_API_KEY
```

The record lands in `deployments/1.json`. The deploy-once guard refuses a
second run unless `--force`.

## 2. L2 on a new server

Prerequisites: Docker with the compose plugin, Foundry 1.8+, Python 3, curl,
a checkout of this repo, and the L1 record from step 1 copied to
`deployments/<L1 chain id>.json` (or `L1_DEPLOYMENTS_FILE`).

```sh
cd voting_node
./scripts/l2-vps-bootstrap.sh check      # tools, env, L1 record (read-only)
./scripts/l2-vps-bootstrap.sh env        # SETTLEMENT_ADDRESS etc. into .env
# put L1_SUBMITTER_PRIVATE_KEY, L2_ADMIN_SECRET, L2_OPERATOR_ADDRESS in your secret store / .env
./scripts/l2-vps-bootstrap.sh up         # docker compose up -d l2 prover
./scripts/l2-vps-bootstrap.sh health     # L2 /health, chain id, L1 settlement code
ADMIN=0x... ./scripts/l2-vps-bootstrap.sh deploy-l2   # election + AA stack via the deployer
```

`deploy-l2` runs `deploy.sh --target l2 --via-deployer` against
`L2_DEPLOY_RPC_URL` (default the local L2 RPC). Add `DRY_RUN=1` to simulate.
When it finishes it prints the `setL2Factory` call the L1 admin must send to
the tally mirror if L2_FACTORY was not known at the L1 step.

L2 node, sequencer and prover settings all come from `.env` (see
`.env.example`: `L2_RPC_PORT`, `L2_RPC_BIND`, `L2_BATCH_SIZE`,
`L2_ADMISSION`, `L1_RPC`, `L1_SUBMITTER_*`, ...). Keep `L2_RPC_BIND=127.0.0.1`
unless a reverse proxy you control fronts it.

## Local checks

```sh
smart-contracts/script/anvil_deployer_e2e.sh          # anvil, full stack, wiring + role handoff checks
voting_node/scripts/deploy-fork-dryrun.sh --local-sim # chain id 1 rules on an empty local anvil
```

# scripts/

Host-side helpers for a local chain, deploying ZkVotingRollup, gas economics and image checks.
**NOT FOR PROFIT** — civic public good, not a commercial product.

Nothing here names a node, a host, or a key. Every RPC URL, chain id, price source and signer
comes from a flag, the environment, or `voting_node/.env` (read as plain `KEY=VALUE`, never
executed). Flags and the environment win over `.env`. RPC URLs are printed as
`scheme://host[:port]/…`, so a key in the path or query string is never echoed.

| Script | What it does |
| --- | --- |
| [`start-anvil.sh`](./start-anvil.sh) | Start (or stop) a local Anvil chain and print its RPC URL |
| [`deploy.sh`](./deploy.sh) | Deploy ZkVotingRollup (`local` or `public`), guard against a second deploy, print the `.env` lines |
| [`get-gas-economics.sh`](./get-gas-economics.sh) | Gas price, ETH/USD, contract sizes, deploy gas, per-call gas, and the L1 bill of one civic vote |
| [`export-rollup-abi.mjs`](./export-rollup-abi.mjs) | Copy the rollup ABIs from the Foundry build into `packages/chain-client/abi/` |
| [`image-import-smoke.mjs`](./image-import-smoke.mjs) | Check that the production image can import every module it ships |
| [`migrations-verify.sh`](./migrations-verify.sh) | Production-image build and boot check |

Docker Compose does not need any of these: its `local-l1` profile starts Anvil and deploys the
rollup itself.

## Prerequisites

- Foundry (`forge`, `cast`, `anvil`):

  ```bash
  curl -L https://foundry.paradigm.xyz | bash
  foundryup
  ```

  See the [Foundry book](https://book.getfoundry.sh/getting-started/installation).
  The scripts add `~/.foundry/bin` to `PATH` if it is missing.
- `bash`, `curl`, `python3`. `jq` is optional.
- A build: `(cd ../smart-contracts && forge build)`.

## Quick start (local, without Docker)

```bash
./scripts/start-anvil.sh --background
./scripts/deploy.sh --target local          # prints ROLLUP_ADDRESS and the other .env lines
npm run l2:operator                         # with those lines and OPERATOR_PRIVATE_KEY, L2_BALLOT_TOKEN set
./scripts/start-anvil.sh --stop
```

## start-anvil.sh

```bash
./scripts/start-anvil.sh                     # foreground, Ctrl-C to stop
./scripts/start-anvil.sh --background        # prints the RPC URL on stdout
./scripts/start-anvil.sh --fork-url "$L1_RPC" --chain-id 31337
./scripts/start-anvil.sh --stop
```

| Variable | Flag | Default |
| --- | --- | --- |
| `ANVIL_HOST` | `--host` | `127.0.0.1` (a non-loopback bind prints a warning) |
| `ANVIL_PORT` | `--port` | `8545` |
| `ANVIL_CHAIN_ID` | `--chain-id` | `31337` (the only chain where the rollup accepts `MockBatchVerifier`) |
| `ANVIL_BLOCK_TIME` | `--block-time` | empty = mine on each transaction |
| `ANVIL_FORK_URL` | `--fork-url` | empty = fresh chain |
| `ANVIL_FORK_BLOCK` | `--fork-block` | latest |
| `ANVIL_ACCOUNTS` / `ANVIL_BALANCE` | | `10` / `10000` ETH |
| `ANVIL_STATE` | `--state` | empty = state is lost on stop |
| `ANVIL_LOG` | | `$TMPDIR/zk-voting-anvil.log` (pid file next to it) |
| `ANVIL_EXTRA_ARGS` | | extra `anvil` arguments |

It refuses to start when something already answers JSON-RPC on the port. The
dev accounts are Anvil's own public test accounts; the script prints no other
keys. Never fund them on a real network.

## deploy.sh

```bash
./scripts/deploy.sh --target local                       # Anvil; unlocked dev account, no key needed
./scripts/deploy.sh --target local --dry-run             # simulate only
GOVERNOR=0x… BATCH_VK=verification_key.json \
  ./scripts/deploy.sh --target public --account deployer --sender 0x… --yes --verify
```

| Target | Forge script | Deploys |
| --- | --- | --- |
| `local` (default) | `DeployLocal.s.sol` | ZkVotingRollup with `MockBatchVerifier` and a sample jurisdiction on chain 31337. Reads `OPERATOR`, `CLERK`, `JURISDICTION_ID` (optional). |
| `public` | `Deploy.s.sol` | `DesertVerifier`, `Groth16Verifier` (from `BATCH_VK`) and ZkVotingRollup with `GOVERNOR`. **Deploy once per chain.** |

`public` needs the batch circuit's verifying key from a completed ceremony. The batch circuit is
not built, so there is no `BATCH_VK` today.

| Variable | Flag | Meaning |
| --- | --- | --- |
| `DEPLOY_TARGET` | `--target` | `local` or `public` |
| `DEPLOY_RPC_URL` | `--rpc-url` | Defaults: local `http://127.0.0.1:$ANVIL_PORT`, public `$L1_RPC` (or `$ETH_RPC_URL`) |
| `DEPLOYER_ACCOUNT` | `--account` | Foundry keystore name (`cast wallet import NAME --interactive`). Preferred |
| `DEPLOYER_ADDRESS` | `--sender` | Sender for a keystore |
| `DEPLOYER_PRIVATE_KEY` | | Raw key (env or `.env`, never a flag). Not printed |
| `FORCE_REDEPLOY=1` | `--force` | Deploy even though `ROLLUP_ADDRESS` or a record with code exists (splits the chain of record) |
| `VERIFY=1` | `--verify` | Verify on Etherscan after a broadcast (`ETHERSCAN_API_KEY`) |
| | `--dry-run` | Simulate; no broadcast |
| | `--yes` | Required to broadcast to chain id 1 |

The forge script writes `smart-contracts/deployments/local.json` or `deployments/<chainId>.json`.
`npm run deploy:l1 -- --verify` checks the deployed code and prints the `.env` lines;
`--check` refuses (exit 2) when a rollup is already deployed. Anything after `--` goes to
`forge script`.

## get-gas-economics.sh

```bash
./scripts/get-gas-economics.sh --gas-gwei 2 --eth-usd 3000 --measure
L1_RPC=<node> ./scripts/get-gas-economics.sh --measure --voters 10000 --ballots 6000 --options 3
./scripts/get-gas-economics.sh --offline                       # sizes only, no network
```

| Variable | Flag | Default |
| --- | --- | --- |
| `L1_RPC` (or `ETH_RPC_URL`) | `--l1-rpc` | required unless `GAS_GWEI` or `--offline` |
| `GAS_GWEI` | `--gas-gwei` | from `eth_gasPrice` |
| `ETH_USD` | `--eth-usd` | fetched (`PRICE_API_URL`, then `PRICE_FALLBACK_URL`); 10000 if neither answers |
| `VOTERS` | `--voters` | 1000 voters on the roll |
| `BALLOTS` | `--ballots` | = voters |
| `HOURS` | `--hours` | 12 open hours |
| `BATCHES` | `--batches` | unset: shows the range from full 256-ballot batches to one every 10 s |
| `GUARDIANS` / `THRESHOLD` | `--guardians` / `--threshold` | 3 / a majority |
| `OPTIONS` | `--options` | 2 |
| `GROTH16_EXTRA_GAS` | `--groth16-gas` | 250000 per batch, an allowance for the real batch proof |
| `GAS_MATCH_CONTRACT` | `--match-contract` | all tests except fuzz |
| | `--ops-filter RE` | also list every measured function matching `RE` |

It reports contract sizes against the EIP-170 / EIP-3860 and EIP-7954 caps, deploy gas
(measured from a deployment record when one exists, otherwise a size-based floor), per-call gas
from `forge test --gas-report`, and the L1 bill of one civic vote. Exit status: `0` ok, `1` a
contract exceeds the EIP-7954 cap or there are no artifacts, `2` bad arguments. Results and their
assumptions: [`docs/voting_cost_estimate.md`](../docs/voting_cost_estimate.md).

## migrations-verify.sh

```bash
./scripts/migrations-verify.sh                 # no-op SQL check + production build + boot smoke
./scripts/migrations-verify.sh migrations      # no-op SQL search only
```

The image boots with dummy secrets and a 384 MB memory cap; `GET /health` must answer within
120 seconds. Needs Docker.

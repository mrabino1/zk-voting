# Deploying ZkVotingRollup to a public chain

**NOT FOR PROFIT** — civic public good. Not a commercial product.

> **Not possible yet.** A public deploy needs the batch circuit's verifying key from a completed
> trusted-setup ceremony (`BATCH_VK`). The batch circuit is not built, so there is no key. The
> steps below are what the deploy will look like; the scripts refuse to run without that key.
> Everything you need today runs on the local chain in Docker Compose.

There is **one** ZkVotingRollup per public chain, shared by every jurisdiction. A fork does not
deploy its own; it asks the governor for a jurisdiction on the shared deployment.

## 1. Deploy once (maintainers)

```bash
cd voting_node
GOVERNOR=0x…multisig BATCH_VK=path/to/verification_key.json \
  ./scripts/deploy.sh --target public --rpc-url "$L1_RPC" --account deployer --sender 0x… --yes --verify
```

`scripts/deploy.sh` runs `smart-contracts/script/Deploy.s.sol`: it deploys `DesertVerifier`,
`Groth16Verifier` (with `BATCH_VK`) and `ZkVotingRollup(governor, verifier, desert)`, and writes
`smart-contracts/deployments/<chainId>.json`. It refuses to redeploy when `ROLLUP_ADDRESS` or a
record with code already exists (`--force` overrides and splits the chain of record), and needs
`--yes` on mainnet. `npm run deploy:l1 -- --verify` checks the deployed code and prints the `.env`
lines.

## 2. Governor setup

The governor (ideally a multisig; handover is two-step with `transferGovernor` /
`acceptGovernor`):

- `setOperator(operator, true)` for each L2 operator account.
- `createJurisdiction(jurisdictionId, admin, name)` for each jurisdiction.

The governor cannot touch an election, a roll, a ballot or a result.

## 3. Each jurisdiction

Its admin calls `setClerk(jurisdictionId, nodeAccount, true)` for the Node's account. Then, in
`voting_node/.env` (or `./setup.sh`, step 6, "an existing deployment"):

```env
COMPOSE_PROFILES=
ROLLUP_DEPLOYMENT_FILE=
L1_RPC=https://…
L1_CHAIN_ID=1
ROLLUP_ADDRESS=0x…
ROLLUP_JURISDICTION_ID=0x…               # bytes32
ROLLUP_PRIVATE_KEY=0x…                   # the clerk account; a little ETH for gas
OPERATOR_PRIVATE_KEY=0x…                 # only if this host runs an operator
ZK_VOTING_ALLOW_MOCK_PROOFS=
```

`/setup` step 6 (`GET /api/setup/rollup`) shows the connection and the L1 balance. Anvil's public
test keys are refused on any chain but 31337.

## Host

Any Linux host with Docker runs the stack ([Requirements](./self-hosting/requirements.md)). Keep
the operator port (8546) and Postgres off the public internet; publish only the Node behind TLS.

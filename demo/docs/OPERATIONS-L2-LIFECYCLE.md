# L2 lifecycle: where the chain and the prover start

NOT FOR PROFIT — civic public good. This page explains how the pieces run.
Line numbers are for `test/unstable` at the commit that added this page.

## 1. Who starts what

| Piece | Started by | Command | Listens / reads |
|---|---|---|---|
| Sequencer (the L2 chain) | Compose service `l2` (`demo/docker-compose.yml:112`) | `node sequencer/index.mjs` (`docker-compose.yml:121`, also the image `CMD` in `demo/l2/Dockerfile`) | JSON-RPC `0.0.0.0:8546` inside the container, published on host `127.0.0.1:8546` (`docker-compose.yml:125-126`). Data in volume `l2-data:/data` (`docker-compose.yml:151`). |
| Prover / batcher | Compose service `prover` (`docker-compose.yml:166`) | `node prover/index.mjs` (`docker-compose.yml:175`) | Reads blocks over `L2_RPC_URL=http://l2:8546` (`docker-compose.yml:177`), shares `l2-data:/data` for its cursor and proof files. No port, no healthcheck. Starts only after `l2` is healthy. |
| Archive | Compose service `archive` | `node archive/cli.mjs daemon` (`docker-compose.yml:227`) | Uploads sealed hours from `l2-data` to S3/R2. |
| Node app | Compose service `node` (`docker-compose.yml:20`) | `node src/server.mjs` | Talks to the sequencer at `CHAIN_RPC` (default `http://l2:8546`, `docker-compose.yml:39`). |

Same image for sequencer and prover (`demo/l2/Dockerfile`, "Same image, different compose command").
Outside Docker: `npm run l2:sequencer` / `npm run l2:prover` (`demo/package.json`), or `demo/l2/bin/start-local.sh`.

## 2. Where chain history starts (block 0)

- `sequencer/index.mjs:7-9` calls `loadConfig()` then `ChainState.open(config)`.
- `loadConfig` (`l2/sequencer/state.mjs:332`) reads `l2/genesis.json` and `l2/config.json` (`state.mjs:334-336`); chain id 27427, `genesisStateRoot` (`state.mjs:366`).
- `ChainState.open` (`state.mjs:501-511`) creates `/data/blocks` and `/data/proofs`, loads every `/data/blocks/<n>.json`, takes the writer lease, and **only if there are no blocks** calls `writeGenesis()` (`state.mjs:507-508`).
- `writeGenesis` (`state.mjs:673-698`) writes block 0 with the current time as timestamp and `extraData = "NOT-FOR-PROFIT"`, persisted as `/data/blocks/0.json` (path builder `state.mjs:538`).
- So the chain is born the first time the `l2` container starts on an empty `l2-data` volume. Restarting reuses the volume and continues from the head. Deleting the volume starts a new chain (new genesis hash, because the timestamp differs).
- Blocks are produced on demand (a tx arrives) plus an hourly heartbeat (`L2_HEARTBEAT_SECONDS`, default 3600); empty blocks are skipped (`L2_SKIP_EMPTY_BLOCKS=1`). The block `stateRoot` is keccak of that block's tx hashes (`state.mjs:1070`), not cumulative.

## 3. When contracts are deployed

- Never automatically. The prover refuses `DEPLOY_ON_START` (`prover/settle.mjs`, `assertProverDoesNotDeploy`).
- A human runs `demo/scripts/deploy.sh --target local|l2|l1` (`scripts/deploy.sh:22-24`). It runs `forge script` (`deploy.sh:224`), needs `--yes` for chain id 1 (`deploy.sh:40,109`) and writes `deployments/<chainId>.json` (`deploy.sh:112`).
- The civic sequencer is **not an EVM**: it has no `eth_getCode`, no nonces, no receipts (`demo/docs/L2.md:64`). `--target l2` cannot deploy to it; the Solidity contracts run on Anvil (`:8545`) or on L1.

## 4. CHAIN_RPC

- `docker-compose.yml:39` defaults `CHAIN_RPC=http://l2:8546`; `apps/node/src/chain.mjs:279-306` marks the chain "configured" whenever it is set.
- The Node's viem writes (ElectionFactory, BallotInbox) need `RELAYER_PRIVATE_KEY` and `ELECTION_FACTORY_ADDRESS`; without them `createElection` returns 503 (`chain.mjs:321-328`). Against the civic sequencer those EVM writes cannot succeed anyway (no nonces/receipts).
- Operator admin writes to the civic L2 now go through `L2_CIVIC_RPC` (`docker-compose.yml:92`) with an HMAC (see `L2-IDENTITY-AND-SETTLEMENT.md`).

## 5. How batches reach L1 RollupSettlement

- `prover/index.mjs` `main` (`index.mjs:176-225`) loops: `tick` takes the prover lease, `runProverTick` (`prover/settle.mjs:281`) reads new blocks over RPC, `buildBatch` (`prover/batch.mjs:135`) builds the batch, `commitBatch` writes `/data/proofs/batch-<n>.json` and the cursor.
- Submit happens only when `L1_RPC`, `SETTLEMENT_ADDRESS`, `L1_CHAIN_ID` and a key are set and the address has code on the right chain; otherwise it fails closed or stays local-only (`settle.mjs` `assessSettlement` / `loadSettlementView`).
- **Signer:** `submitBatchL1` (`index.mjs:60-110`) signs `RollupSettlement.submitBatch` with `L1_SUBMITTER_PRIVATE_KEY` (legacy `PRIVATE_KEY`), passed in at `docker-compose.yml:188`. That address must be the contract's `sequencer`, `prover` or `admin` (`smart-contracts/src/l2/RollupSettlement.sol:67-70`). It pays the L1 gas.
- **Fixed in this change:** the prover used to send `dataHash = keccak(publicData)` and `prevStateRoot = parent block root`. RollupSettlement requires `dataHash == keccak(abi.encode(batchIndex, prev, new))` (`RollupSettlement.sol:118`) and `prev == last accepted root` (`RollupSettlement.sol:117`), so a real submit reverted (`DataHashMismatch`, then `PrevRootMismatch` after batch 0). Batches now carry `batch.settlement` with a chained root and the matching dataHash; `submitBatchL1` sends those (`index.mjs:93-104`). The cursor stores `lastSettlementRoot`.
- Before a batch, the prover checks the submitter balance (holds batches when it cannot pay for one) and re-checks admission (fails closed on forged admin txs or unknown elections).
- `mockMode` is the only mode today: the keccak settlement root is not yet what a Groth16 batch circuit proves.

## 6. Restart and archive

- Restart: the sequencer reloads `/data/blocks` (no new genesis); the prover resumes from `/data/proofs` cursor. A standby (`docker-compose.rolling.yml`, `l2-next` on 8547) waits on the writer lease and serves reads; writes get 503 until it holds the lease.
- Archive: `archive` daemon (`docker-compose.yml:218-244`), or `system_actions.sh` `cmd_archive` / `cmd_archive_restore` (`system_actions.sh:245-253`). Keeps `ARCHIVE_HOT_WINDOW_HOURS` locally, uploads older hours after a checksum.

## 7. Coolify demo-test

The Coolify `demo-test` app builds only `demo/Dockerfile` (the Node app). `CHAIN_RPC` and `ELECTION_FACTORY_ADDRESS` are empty there, so there is no `l2`, no `prover`, no chain: the app runs JSON-only (elections in the Node data store). No batch ever reaches L1 from demo-test. To run the L2, deploy the Compose file (`docs/self-hosting/coolify.md`).

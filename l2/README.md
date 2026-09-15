# NOT FOR PROFIT

**This is not a commercial sequencer, not a token, and not a business.**
Republic L2 exists so a city, county, state, nation, or any body that must
run a binding election can settle **our own application-specific ZK rollup**
on Ethereum. Jurisdictions run it **at cost**. Nobody is to make money off
this directory.

---

## What “our L2” and “our prover” means

Republic is inspired by [Lighter](https://lighter.xyz): an application-specific
ZK rollup that **proves operations** and **settles those proofs on Ethereum**.
We do **not** rent a commercial sequencer. We do **not** issue a gas token.

| Piece | Job |
| --- | --- |
| **Our sequencer** (`sequencer/`) | Accepts civic transactions (register, vote, disqualify, tally, userop), produces blocks about every **2 seconds**, chain id **27427**. Vote txs stay sealed until the hour closes. |
| **Our prover** (`prover/`) | Watches new blocks, batches them (`batchSize`, default 4), hashes public batch data, produces a Groth16-shaped proof, and calls L1 `RollupSettlement.submitBatch`. |
| **Ethereum L1** | Court-grade settlement. `RollupSettlement` stores `prevStateRoot`, `newStateRoot`, and `dataHash`. Anyone can re-derive `dataHash` from public batch data. |

Voters never hold an L2 gas token. The sequencer / paymaster / bundler is the
transaction origin. On an **EVM**, the paymaster sponsors UserOps that touch the
civic contracts. This civic sequencer is **not** Anvil and does **not** execute
Solidity; Foundry Anvil (default `:8545`) is only for compiling and testing
contracts. `eth_getBalance` for ordinary voter addresses is always `0`. The
sequencer and paymaster report a **fake** sponsored balance so tooling that
checks “can this paymaster pay?” is satisfied without introducing a token.

## What is (and is not) in a batch

A vote on this chain is **not** `vote(optionId)` from an identified key.

Batch public data — and therefore `dataHash` — contains only:

- transaction hashes
- nullifiers
- Merkle roots (eligible / disqualification)
- ballot hashes
- identity commitments (registration / disqualification)
- reason codes and evidence hashes (disqualification)
- tally `countsHash`

**Ballot plaintext is never stored in batch data.** If a client sends a
`choice` / `plaintext` field, the sequencer strips it. Encrypted ballots may
exist on the L2 inbox transaction; they are omitted from the proof batch.

## JSON-RPC (127.0.0.1:8546)

Default bind: `L2_RPC_HOST=127.0.0.1`, `L2_RPC_PORT=8546`.

| Method | Notes |
| --- | --- |
| `eth_chainId` | `0x6b23` (27427) |
| `net_version` | `"27427"` |
| `eth_blockNumber` | latest sealed block |
| `eth_getBlockByNumber` | tags `latest` / `earliest` / `pending` (`pending` does not list sealed votes) |
| `eth_getBlockByHash` | |
| `eth_getTransactionByHash` | sealed votes return `null` until the hour closes |
| `eth_getLogs` | civic events; votes expose nullifier + ballot hash, not choice |
| `eth_sendRawTransaction` | hex-encoded JSON civic tx, or opaque bytes treated as `userop` |
| `eth_call` | limited (`0x`, plus `balanceOf`-shaped selectors) |
| `eth_getBalance` | `0` for voters; fake balance for sequencer / paymaster / bundler |

Civic `eth_sendRawTransaction` payload is UTF-8 JSON hex, for example:

```json
{"type":"vote","electionId":"1","nullifier":"0x…","ballotHash":"0x…","eligibleRoot":"0x…","disqualificationRoot":"0x…"}
```

Types: `register`, `vote`, `disqualify`, `tally`, `userop`.

`stateRoot` of a block is `keccak256` of the concatenation of that block’s
transaction hashes (empty block → keccak of the empty byte string). Node’s
OpenSSL build may not expose `keccak256`; the sequencer includes the Ethereum
sponge and self-tests it.

Blocks are written under `l2/data/`. If `REPUBLIC_NODE_URL` is set, each
block is also `POST`ed to `{REPUBLIC_NODE_URL}/api/explorer/ingest`. Ingest
failures are logged and **do not** halt the chain.

## Prover and L1 settlement

```text
submitBatch(uint64 batchIndex, bytes32 prevStateRoot, bytes32 newStateRoot, bytes32 dataHash, uint256[2] a, uint256[2][2] b, uint256[2] c)
```

In development (`DEV_MOCK_PROOF=true`, the default) the proof is the
placeholder `a=[1,0]`, `b=[[1,0],[1,0]]`, `c=[1,0]`.

If `L1_RPC`, `SETTLEMENT_ADDRESS`, and `PRIVATE_KEY` are all set, the prover
submits `submitBatch` with [viem](https://viem.sh). Otherwise it writes
`l2/data/proofs/batch-N.json`.

This is **not** a proving-as-a-service company. The jurisdiction that runs an
election runs the prover.

## Run locally (pure Node)

Docker is not required. From the repository root, `docker compose up -d --build` also starts this sequencer (`l2`) and the prover (`prover`); see [`docs/OPERATOR.md`](../docs/OPERATOR.md).

```bash
./l2/bin/start-local.sh
```

That starts the sequencer and the prover. RPC: `http://127.0.0.1:8546`.

From the repo root:

```bash
npm run l2:sequencer
npm run l2:prover
```

### Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `L2_RPC_HOST` | `127.0.0.1` | RPC bind |
| `L2_RPC_PORT` | `8546` | RPC port |
| `L2_BATCH_SIZE` | `4` | blocks per proof batch |
| `DEV_MOCK_PROOF` | `true` | placeholder Groth16-shaped proof |
| `REPUBLIC_NODE_URL` | unset | Node app base URL for explorer ingest |
| `DISCLOSURE_INTERVAL_SECONDS` | `3600` | Vote txs stay sealed until this many seconds’ bucket closes. `0` publishes immediately (local demo / tests). |
| `L1_RPC` | unset | Ethereum RPC for settlement |
| `SETTLEMENT_ADDRESS` | unset | `RollupSettlement` on L1 |
| `PRIVATE_KEY` | unset | prover key authorized to call `submitBatch` |

`chainId` **27427**, block time **~2s**, genesis state root `0x00…00`.
Sequencer / paymaster addresses in `genesis.json` are placeholders.

## Layout

```text
l2/
  README.md              this file (NOT FOR PROFIT)
  genesis.json
  config.json
  sequencer/index.mjs    process entry
  sequencer/state.mjs    mempool, sealed votes, blocks, keccak, persistence
  disclosure.mjs         hourly polling-place unlinkability
  rpc/server.mjs         JSON-RPC subset
  prover/index.mjs       batch watcher + settlement
  prover/batch.mjs       public batch data + mock proof
  bin/start-local.sh     sequencer + prover
  data/                  runtime (gitignored)
```

AGPL-3.0-or-later. See `/NOT_FOR_PROFIT.md` and `/LICENSE`.

# ZK-Voting L2

**NOT FOR PROFIT.** This is not a commercial sequencer, not a token and not a business.
Jurisdictions run it at cost.

ZK-Voting is an application-specific ZK rollup in the [Lighter](https://lighter.xyz) /
zkSync Lite pattern. Ethereum L1 settles it and enforces the rules through **one contract**,
`ZkVotingRollup` ([design](../../smart-contracts/docs/ROLLUP.md)). This directory is the L2
**operator**:

| Piece | Job |
| --- | --- |
| `rollup/state.mjs` | The L2 state machine: elections, rolls, nullifiers, encrypted per-option sums. Every rule in it is a rule the batch circuit must prove. |
| `rollup/batch.mjs`, `rollup/pubdata.mjs` | Batch building and the pubdata / commitment encodings, byte for byte as the contract parses them. |
| `rollup/operator.mjs` | Follows the L1 priority queue, accepts ballots, and settles batches (commit → prove → verify → execute), retrying unfinished ones. |
| `rollup/server.mjs`, `rollup/main.mjs` | The HTTP API and the process entry point. |
| `../apps/node/public/ballot-crypto.js` | Ballot and guardian cryptography shared with the browser and the node. |

## What is public

A ballot reaches L1 only as a nullifier and a hiding commitment, inside batch pubdata. The
operator keeps each ballot's ciphertexts privately, and only so a revote can replace the earlier
vector. It forgets them when the election closes. The API never returns a ciphertext, a live
ballot count or a partial sum. The one ciphertext that leaves the operator is the final
per-option sum, carried in the CLOSE response that L1 hands to the guardians.

## API (default `127.0.0.1:8546`)

| Request | Answer |
| --- | --- |
| `GET /health`, `GET /v1/status` | L1 rollup, last batch, state root, queued requests, desert mode |
| `GET /v1/batches?limit=50` | Recent batches: number, time, root, commitment, op counts, L1 transactions |
| `GET /v1/elections/:id` | Window, joint key, roll size and root, nullifier root; ballot count only after close |
| `GET /v1/elections/:id/roll/:commitment` | Membership path for a voter's ballot proof |
| `GET /v1/receipts/:electionId/:nullifier` | `pending` → `committed` → `settled` (with batch and L1 transaction), or `rejected` |
| `GET /v1/elections/:id/desert-proof` | Arguments for `desertClose`, only once L1 is in desert mode |
| `POST /v1/ballots` | `{ electionId, nullifier, ciphertexts, proof, eligibility }`. Needs `Authorization: Bearer $L2_BALLOT_TOKEN` when that is set. |

The operator checks every ballot's validity proof before queueing it: each option encrypts 0 or
1, and they add up to exactly 1. Eligibility (membership in the roll without revealing who) is
the voter's Groth16 ballot proof. Until that circuit has a ceremony, only
`ZK_VOTING_ALLOW_MOCK_PROOFS=1` on chain 31337 accepts ballots, and the node vouches for its
authenticated voters.

## Run

Docker Compose runs all of this (`docker compose up -d --build` in `voting_node/`, with the
`local-l1` profile that `.env.example` turns on). By hand:

```bash
# L1: Anvil and the rollup with the mock batch verifier
anvil &
(cd ../../smart-contracts && make deploy-local)        # writes deployments/local.json

L1_RPC=http://127.0.0.1:8545 \
ROLLUP_ADDRESS=$(jq -r .rollup ../../smart-contracts/deployments/local.json) \
OPERATOR_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
ZK_VOTING_ALLOW_MOCK_PROOFS=1 \
npm run l2:operator
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `L1_RPC`, `L1_CHAIN_ID` | required, RPC's id | L1 endpoint |
| `L1_RPC_AUTH_TOKEN` | unset | Optional bearer token for an L1 RPC that requires auth. Empty sends no Authorization header. |
| `ROLLUP_ADDRESS` | required unless the record below names it | `ZkVotingRollup` |
| `ROLLUP_DEPLOYMENT_FILE` | unset | A deployment record (`deployments/local.json`); fills `ROLLUP_ADDRESS` |
| `OPERATOR_PRIVATE_KEY` | required | An account the governor added with `setOperator`. An Anvil dev key is refused off chain 31337 |
| `L2_DATA_DIR` | `./data` | Private operator state (`rollup-operator.json`, mode 0600) |
| `L2_RPC_HOST`, `L2_RPC_PORT` | `127.0.0.1`, `8546` | API bind |
| `L2_BATCH_SECONDS` | `10` | Batch interval |
| `L2_BALLOT_TOKEN` | unset | Bearer token for `POST /v1/ballots` |
| `ZK_VOTING_ALLOW_MOCK_PROOFS` | unset | `1`: accept ballots without an eligibility proof (chain 31337 only) |
| `L2_STANDBY_WHEN_UNCONFIGURED` | unset | `true`: when the rollup is not usable (unset, no genesis, L1 unreachable, no batch prover), serve `/health` as `"status":"standby"` and 503 elsewhere instead of exiting. No ballots, batches or L1 transactions |

## Test

```bash
npm run test:l2          # vectors, state rules, and the end-to-end run on Anvil
npm run fixture:contracts   # regenerate the JS election that smart-contracts/test/CrossLanguage.t.sol settles
```

The batch validity circuit is not built yet. The operator therefore settles only against
`MockBatchVerifier`, which the contract accepts only on chain 31337. `main.mjs` refuses to
start against a real verifier until a prover exists.

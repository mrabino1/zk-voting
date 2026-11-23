# smart-contracts

**NOT FOR PROFIT**: civic public good, not a commercial product. AGPL-3.0-or-later.

ZK-Voting settles on Ethereum through **one contract for the world**, `ZkVotingRollup`. It
follows the Lighter / zkSync Lite rollup pattern:

- L1 holds the rules: jurisdictions, elections, guardian keys, the priority queue, the batch
  chain and the certified results.
- An L2 operator orders the work and proves every batch. Ballots never touch L1, unless a voter
  chooses to force one in.
- The outcome is enforced only as a sum. L1 accepts a single threshold decryption of the
  final per-option totals, and only when turnout reaches the election's anonymity floor.

The full design, with the pubdata format and the trust model, is in [`docs/ROLLUP.md`](docs/ROLLUP.md).

## Layout

| Path | What it is |
| --- | --- |
| `src/ZkVotingRollup.sol` | The L1 contract: governance, elections, key ceremony, priority queue, batches, desert mode, results |
| `src/interfaces/IZkVotingRollup.sol` | Types, events, errors |
| `src/libraries/Guardians.sol` | k-of-n Feldman DKG and Chaum-Pedersen threshold decryption (linked library) |
| `src/libraries/Ops.sol` | L2 operation types and pubdata layout |
| `src/libraries/StateTree.sol` | L2 state commitments (Poseidon election tree and leaf) |
| `src/libraries/BabyJub.sol`, `PoseidonT3.sol` | Curve and hash shared with the circuits |
| `src/verifiers/Groth16Verifier.sol` | Batch validity verifier, verifying key fixed at deploy |
| `src/verifiers/DesertVerifier.sol` | Stateless check of an election leaf for desert mode |
| `src/verifiers/MockBatchVerifier.sol` | Accept-all verifier, refused outside chain 31337 |
| `src/token/` | Optional ERC-20 signal token for token polls. Not used by civic elections |
| `test/` | Unit, end-to-end (real DKG, ElGamal and decryption) and fuzz tests |
| `script/` | `DeployLocal` (Anvil), `Deploy` (public chain, needs the batch verifying key), `DeploySignalToken` |

## Election lifecycle on L1

1. A governor creates a jurisdiction. Its admin appoints clerks.
2. A clerk calls `createElection`, naming the registrar, officer, guardians, threshold, window,
   option count and anonymity floor.
3. Guardians call `commitGuardian`, then anyone calls `finalizeKey` (with `complainShare`,
   `openShareDispute`, `revealShare` and `expireShareDispute` for misbehaving dealers). That queues
   `CREATE_ELECTION` for the L2.
4. The registrar calls `registerVoters` and the officer calls `disqualify`, until `startTime`.
5. Voters send ballots to the operator. `forceBallot` is the censorship escape.
6. After `cutoffTime`, anyone calls `closeElection`. The operator's batch carries the final
   accumulator back to L1.
7. Guardians call `postDecryptionShares`, then anyone calls `finalizeResult(counts, guardians)`.

The operator calls `commitBatch` and `revertBatches`. Anyone calls `verifyBatch`,
`executeBatches` and, once a queued request is older than `PRIORITY_EXPIRATION`,
`activateDesertMode` and `desertClose`.

## Build and test

```bash
forge build
forge test              # 96 tests
make gas                # L1 cost of each step
make deploy-local       # Anvil, mock verifier; writes deployments/local.json
```

Approximate L1 gas from the test suite:

| Step | Gas |
| --- | --- |
| `createElection` | ~380k |
| `commitGuardian` | ~1.1M per guardian |
| `registerVoters` | ~60k + ~4k per voter |
| `commitBatch` | ~100k + pubdata calldata |
| `verifyBatch` | ~230k with Groth16 |
| `postDecryptionShares` | ~3.6M per guardian (3 options) |
| `finalizeResult` | ~1.3M (3 options, 2 of 3) |

## Status

The contracts, the L2 state machine and the pubdata format are implemented and tested
together. The batch validity circuit is specified in `docs/ROLLUP.md` but not built yet.
Until that circuit and its trusted setup exist, the rollup runs only on a local chain with
`MockBatchVerifier`.

# ZK-Voting rollup

**NOT FOR PROFIT**: civic public good, not a commercial product.

This is the design for the contracts in `src/` and for the L2 in `voting_node/l2/rollup/`.
It follows the Lighter / zkSync Lite pattern. Ethereum L1 settles the system and enforces its
rules. One L1 contract serves every jurisdiction and election in the world. An L2 operator
orders and proves the work.

## Goals

1. **One contract for the world.** `ZkVotingRollup` holds all L1 state: jurisdictions,
   elections, guardian keys, the batch chain, the priority queue and the certified results.
   Verifiers and libraries are stateless helpers with no storage of their own.
2. **L1 enforces the rules.** The operator cannot create an election, change a roll,
   censor a ballot or invent a result. Roll changes come in through the L1 priority queue,
   and every batch carries a validity proof. A ballot the operator refuses can be forced in
   from L1. If the operator stops serving the queue, anyone can freeze the rollup (desert
   mode) and finish elections from the last proven state.
3. **The outcome is enforced only as a sum.** No individual ballot, and no partial sum, is ever
   published in a form that can be decrypted. L1 accepts exactly one decryption per election:
   the final per-option totals of the homomorphic accumulator, opened by a threshold of guardians
   with Chaum-Pedersen proofs. An election below its anonymity floor (`minBallots`) is never
   decrypted.

## Actors

| Actor | Where | Can do |
| --- | --- | --- |
| Governor | L1 | Two-step handover. Adds and removes operators. Creates jurisdictions. Cannot touch an election, a roll, a ballot or a result. |
| Jurisdiction admin | L1 | Adds and removes clerks for one jurisdiction. |
| Clerk | L1 | Creates an election for their jurisdiction and names its registrar, officer and guardians. |
| Registrar | L1 | Adds identity commitments to the roll before `startTime`. |
| Officer | L1 | Disqualifies a commitment before `startTime`, with a public reason code. |
| Guardian | L1 (relayed) | Holds a Baby Jubjub identity key, not an L1 account. Runs the k-of-n Feldman DKG and posts one decryption share per option after close. Each call is signed under the identity key or proves itself, so any relayer (usually the node) can send it, and none can forge it. |
| Operator | L1 + L2 | Orders L2 operations, commits batches and reverts unexecuted ones. |
| Anyone | L1 | Verifies and executes proven batches, forces a ballot in, closes an election after cutoff, activates desert mode, finalizes a result. |
| Voter | L2 (or L1) | Sends an encrypted ballot with a ballot proof to the operator, or forces it in through L1. |

## L1 lifecycle of an election

```
createElection ──► guardians post signed Feldman commitments ──► finalizeKey
     (clerk)            (complaints / disputes / reveals)           │
                                                              ▼
                                         priority op CREATE_ELECTION (carries the joint key)
registerVoters / disqualify (until startTime)  ──► priority ops REGISTER / DISQUALIFY
ballots on L2 in [startTime, cutoffTime)        ──► L2 op BALLOT  (forceBallot ──► priority op FORCED_BALLOT)
closeElection (anyone, after cutoffTime)        ──► priority op CLOSE (on-chain op: final accumulator)
executeBatches stores the final accumulator     ──► guardians postDecryptionShares ──► finalizeResult
```

Election status on L1: `KeyGen → Scheduled → Closing → Closed → Finalized`, or `Withheld` when
`ballotCount < minBallots`, or `Halted` when desert mode freezes an election that never closed.

## L2 state

All hashes are Poseidon(2) over BN254 (`PoseidonT3.hashLeftRight`, circomlib compatible).
`fold(x0, …, xn) = H(…H(H(x0, x1), x2)…, xn)`.

- `stateRoot` is the root of a sparse Merkle tree of depth `ELECTION_TREE_DEPTH = 16`. Its key is
  `electionId` (bit `i` of the id picks the side at level `i`, leaf first). The empty leaf is 0.
- An election leaf is
  `fold(configHash, eligibleRoot, nullifierRoot, accumulatorHash, ballotCount, status)`, where
  - `configHash` is the L1 config hash reduced mod r,
  - `eligibleRoot` is an incremental Merkle tree of depth `ROLL_DEPTH = 20` over identity
    commitments in registration order (a disqualified commitment's leaf is set to 0),
  - `nullifierRoot` is a sparse Merkle tree of depth 254 keyed by nullifier, whose value is the
    ballot commitment (0 means unused),
  - `accumulatorHash = fold(c1x₀, c1y₀, c2x₀, c2y₀, c1x₁, …)` over the per-option ElGamal sums on
    Baby Jubjub (identity `(0,1)` for an empty sum),
  - `status` is 1 open or 2 closed.

A ballot is a vector of per-option ElGamal ciphertexts under the election's joint key, together with a
ballot proof. The proof shows that the voter's commitment is in `eligibleRoot`, that
`nullifier = Poseidon(nullifierSecret, electionId)`, and that the vector encrypts a one-hot choice.
A revote under the same nullifier subtracts the old vector and adds the new one, so only the last
ballot counts.

## Operations and pubdata

Pubdata is the concatenation of operations, big-endian, posted as calldata. `commitBatch` parses it.
The **request** part of a priority operation must hash (keccak256) to the queued request. The
**response** part (after the request) is written by the operator and constrained by the proof.

| Type | Op | Request bytes | Response bytes | Source |
| --- | --- | --- | --- | --- |
| `0x01` | CREATE_ELECTION | `type·1 id·4 configHash·32 start·8 cutoff·8 options·1 jointX·32 jointY·32` (118) | none | priority |
| `0x02` | REGISTER | `type·1 id·4 count·1 commitment·32×count` | none | priority |
| `0x03` | DISQUALIFY | `type·1 id·4 commitment·32 reason·2` (39) | none | priority |
| `0x04` | BALLOT | `type·1 id·4 nullifier·32 ballotCommitment·32` (69) | none | L2 |
| `0x05` | FORCED_BALLOT | `type·1 id·4 nullifier·32 ballotCommitment·32 payloadHash·32` (101) | `accepted·1` | priority |
| `0x06` | CLOSE | `type·1 id·4` (5) | `ballots·4 options·1 (c1x c1y c2x c2y)·32×4×options` | priority + on-chain op |

`ballotCommitment = fold` of the ballot vector's coordinates. It hides the choice (each
ciphertext is freshly randomized) and lets anyone rebuild the nullifier tree from pubdata alone.
The ciphertexts of an L2 ballot are **never** in pubdata. The only ciphertext L1 ever sees is
the final accumulator in a CLOSE response, and the vector of a voter who chose to force a ballot
in through L1.

## Batch lifecycle

Batches go through the same steps as zkSync Lite and Lighter:

- `commitBatch(StoredBatchInfo last, CommitBatchInfo next)`, operator only. It checks that `last` is
  the latest committed batch, that `next.timestamp` is not earlier than `last.timestamp`, not in
  the future and at most `MAX_TIMESTAMP_LAG` behind L1, and that the priority operations in
  pubdata match the queue in order. It records the on-chain operations hash and the batch commitment:

  ```
  commitment = sha256(prevStateRoot ‖ newStateRoot ‖ batchNumber ‖ timestamp ‖ sha256(pubdata)
                      ‖ priorityOpsHash ‖ onchainOpsHash) & (2²⁵³ − 1)
  ```

- `verifyBatch(StoredBatchInfo batch, uint256[8] proof)`, anyone. It runs the Groth16 batch verifier on
  the single public input `commitment`.
- `executeBatches(StoredBatchInfo[] batches, bytes[] onchainOps)`, anyone, for proven batches in
  order. It pops their priority requests, applies their CLOSE responses (storing the final
  accumulator and ballot count) and advances `executedStateRoot`.
- `revertBatches(uint64 newLastBatch)`, operator only, for committed batches that have not been
  executed.

The batch circuit proves that `newStateRoot` follows from `prevStateRoot` under the pubdata: every
priority op is applied, and every BALLOT carries a valid ballot proof for an open election at
`timestamp < cutoffTime`, with nullifier and accumulator updated. A FORCED_BALLOT is applied
when its proof is valid and the election is still open. A CLOSE response equals the leaf's
accumulator and count, and marks the leaf closed. **Status:** the contracts, the L2 state machine
(`voting_node/l2/rollup/`) and the pubdata format are implemented. The batch validity circuit is
specified here and in `voting_node/l2/rollup/README.md`, but not built. Verifying the voters'
Groth16 ballot proofs inside the batch needs a recursion-capable prover (Lighter uses Plonky2).
Until that circuit and its ceremony exist, deployments run with `MockBatchVerifier`, which
the contract accepts only on chain id 31337.

## Priority queue and desert mode

Every L1 request (create, register, disqualify, forced ballot, close) is appended to a FIFO queue
with `expiration = block.timestamp + PRIORITY_EXPIRATION` (3 days). Requests are popped
only when the batch that carried them executes.

`activateDesertMode()` is permissionless. It succeeds when the oldest unexecuted request has
expired. Desert mode is permanent. It stops all commits, verifies and executes, and it rejects
new requests. Elections that were already closed finish normally. Any other election can be
closed once with `desertClose`, which takes the election leaf and a Merkle path against
`executedStateRoot` and checks them with `DesertVerifier`. Its result is flagged `viaDesert`. An election
with no such proof stays `Halted`. Nobody can produce a result for it.

## Results: the sum, and only the sum

1. CLOSE executes and L1 stores `accumulator[option] = (c1, c2)` and `ballotCount`.
2. If `ballotCount < minBallots`, the election becomes `Withheld` and nothing else is accepted.
3. Each guardian `g` posts `D_{g,i} = s_g·c1_i` for every option `i`, with a Chaum-Pedersen proof that
   `log_G(PK_g) = log_{c1_i}(D_{g,i})`. `PK_g` is derived on L1 from the posted Feldman commitments.
4. `finalizeResult(counts, subset)`, anyone. For a set of `k` guardians, it checks
   `c2_i − Σ λ_g·D_{g,i} = counts_i·G` for every option, and that `Σ counts_i = ballotCount`. It stores
   the counts and `resultHash = keccak256(abi.encode(block.chainid, address(this), electionId, counts))`.

There is no other decryption entry point. There are no interim results, hourly partials or
per-batch ciphertexts. L1 never stores an individual ballot outside the voluntary forced path.
The pubdata of an L2 ballot is a nullifier and a hiding commitment. So even a threshold of colluding
guardians can decrypt nothing but the final totals from public data. The one-hot check in the
ballot proof makes those totals an exact count of ballots.

## Residual trust

- The operator sees ballot ciphertexts (not choices) and the time each one arrives. With a threshold
  of guardians, it could decrypt individual ballots. That is the honest-threshold assumption
  every encrypted-ballot system makes.
- A forced ballot puts its ciphertexts in L1 calldata. They are protected by the same threshold assumption.
- In desert mode, an election that is still open can only finish if someone holds the operator's
  state (the accumulator is never public), so it may stay `Halted`. Secrecy is chosen over
  liveness here, on purpose.

## What this replaces

`ElectionFactory`, `Election`, `VoterRegistry`, `DisqualificationRegistry`, `BallotInbox`, `Tally`,
`RollupSettlement`, `L1TallyMirror`, `ZkVotingMailbox`, `GuardianCeremony`, `JurisdictionRegistry`,
`PersonRegistry`, `ExternalPartyRegistry`, the passkey account-abstraction stack, the paymaster and
`ZkVotingDeployer` are removed. Their duties are now `ZkVotingRollup` operations or L2 rules. The
optional `src/token/` signal token is unrelated to civic elections and is kept as is.

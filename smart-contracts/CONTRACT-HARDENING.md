# Contract hardening

This note describes the guards added under `smart-contracts/`, and the alternatives that were left out. The vote design is unchanged.

A ballot is still a Groth16 Vote proof with public inputs `[eligibleRoot, disqRoot, nullifier, ballotHash, electionId]`. A relayer submits the ballot. The tally is one aggregate. There is no per-ballot opening. There is no clearance calldata, no voter address on the ballot transaction, and a disclosure interval still forces a batch.

## Guards

### A zero nullifier is rejected

`BallotInbox` reverts `InvalidNullifier` when the nullifier's residue modulo the BN254 scalar field is 0. That includes the literal value 0 and every multiple of the field modulus.

Zero is the unset word. If those spellings were accepted, they would all land on one spent key. A nullifier from the dev hash scheme is still a full keccak word: the inbox stores the field residue, so `n` and `n + k·r` remain one ballot. Rejecting every out-of-field word would break that path in `voting_node`.

### An admin pause that expires after 72 hours

`ElectionFactory.pause` and `unpause` stop new ballots and tally posts. Reads stay available. `isPaused` becomes false 72 hours after `pausedAt`, even if nobody calls `unpause`.

The existing factory admin is the only caller. There is no new key and no hard-coded address. The pause is off by default, so an election that nobody pauses behaves as before. The expiry is there so a lost admin key cannot freeze voting forever. A second `pause` while one is active reverts, so the window cannot be extended in place.

### A reentrancy lock on the calls that leave the contract

`BallotInbox` submission, `Tally` submission, `ZkVotingEntryPoint.handleOps`, and `ZkVotingPaymaster.withdraw` each set a lock for the duration of the call.

The Groth16 check is a staticcall, so the verifier cannot write state. `handleOps` does make a real call into the account, and `withdraw` sends ETH. The lock stops that account call from entering `handleOps` again, and stops a withdraw recipient from withdrawing a second time in the same transfer.

### The verifier return is one word

`CappedVerifierCall` staticcalls `verifyProof` and copies 32 bytes. A revert, a short return, or a zero word is `InvalidProof`. A `true` word is accepted even if extra bytes follow it.

A verifier that returns a large buffer cannot force the relayer to copy that buffer into memory. The vote verifier interface and the five public inputs are unchanged.

### A batch event that carries a count, not choices

`submitVoteBatch` emits `VoteBatchAccepted(electionId, count, relayer)` after the ballots are stored in nullifier order.

Indexers can tell a batch from a series of single votes. The event has no yes/no split. A choice total there would publish the batch tally. If any ballot in the batch is invalid, the transaction reverts and none of the nullifiers in that batch are spent.

### Bounds on one ciphertext and one option vector

`BallotInbox.MAX_BALLOT_BYTES` is 32 KiB. `Tally.MAX_TALLY_OPTIONS` is 256.

An aggregate envelope (a tag and one ciphertext pair per option) is about 2 KiB, so the ballot cap leaves room. The option cap is the length of the histogram, not one integer per ballot.

### Local deploy stays on the local chain

`DeployLocal` reverts `LocalDeployOnly` when the chain id is not 31337, unless `ZK_VOTING_ALLOW_PUBLIC_DEPLOY=1`.

That script deploys a sample election and, on the mock path, an accept-all verifier. It should not land on a public chain by accident. No address or key was added.

### Tests that pin the rules

`test/ContractHardening.t.sol` covers the zero nullifier, the shared field residue, the 32 KiB cap, the capped verifier return, the batch event, pause expiry, the option-vector cap, entry-point reentrancy, withdraw reentrancy, and the aggregate tally with no openings array. The fuzz suite assumes a nullifier residue other than 0. The invariant suite asserts that nullifier 0 stays unspent.

`submitVote` is pinned to the selector with no identity-commitment argument. `submitAggregateTally` is pinned to the selector with no openings array. `VoteAccepted` data is the ballot hash and the relayer.

## Left out

These were considered and not taken, because they would change the vote instance, the circuits, `voting_node`, or the single aggregate tally:

- Rejecting every public input that is `>= r`.
- Requiring a canonical Groth16 proof (the `A.y` coordinate in the lower half of the field). Proofs from the current toolchain are not in that form.
- Collapsing revert reasons into coarse anonymous errors.
- Adding the chain id as a sixth public input. Election-scoped nullifiers already separate replays, and the user-operation hash already binds the chain.
- Weighted votes, quadratic votes, commit-reveal, or a choice inside the vote event.
- Yes/no totals inside the batch event.
- A counting committee of three to five people in place of the single tally operator.
- An upgradeable election. Clones stay immutable. The implementation address is baked into the clone.
- A timelock on swapping the vote verifier. The verifier is fixed in the election parameters at creation, and the tally verifier is set once.
- Burning the nullifier before the proof. A failed proof reverts the whole transaction, so the nullifier is not stored. Checking the proof first keeps today's `InvalidProof` and `NullifierUsed` order.
- A minimum or maximum election duration. Creation already requires the start to be before the cutoff.

Two-step admin transfer, set-once modules, the set-once tally verifier, the relayer allowlist, and the mock-verifier gate were already in the contracts. They were left as they are.

## Storage and ABI

New storage is appended. The election clone layout is unchanged. `submitVote`, `submitVoteBatch`, `submitTally`, and `submitAggregateTally` keep their selectors.

| Contract | What was added |
| --- | --- |
| `ElectionFactory` | `pausedAt`, `pause`, `unpause`, `isPaused`, `MAX_PAUSE_DURATION` |
| `BallotInbox` | `_reentrancyLock`, `MAX_BALLOT_BYTES`, `InvalidNullifier`, `BallotTooLarge`, `VoteBatchAccepted` |
| `Tally` | `_reentrancyLock`, `MAX_TALLY_OPTIONS`, `CountsTooLong` |
| `ZkVotingEntryPoint` | `_reentrancyLock` (this contract had no storage variables) |
| `ZkVotingPaymaster` | `_reentrancyLock` |
| `DeployLocal` | `LocalDeployOnly` when the chain is not local Anvil |

# Proposal: the batch validity circuit

**NOT FOR PROFIT** — civic public good, not a commercial product.

Status: **proposal, 2026-11-23.** Nothing here is built. It is the one missing piece between the
current rollup (which settles only against `MockBatchVerifier` on chain 31337) and a civic vote
on a public chain. Contract changes it implies are for the maintainers to make by hand in
`smart-contracts/`.

## What the circuit must prove

From `smart-contracts/docs/ROLLUP.md`, `voting_node/l2/rollup/state.mjs` and
`ZkVotingRollup.commitBatch`. The L1 verifier takes one public input:

```
commitment = sha256(prevStateRoot ‖ newStateRoot ‖ batchNumber ‖ timestamp ‖ sha256(pubdata)
                    ‖ priorityOpsHash ‖ onchainOpsHash) & (2²⁵³ − 1)
```

Given that, the circuit proves that `newStateRoot` follows from `prevStateRoot` by applying the ops
in `pubdata`, in order:

| Op | Constraints |
| --- | --- |
| CREATE_ELECTION | insert a fresh election leaf at `electionId` in the depth-32 sparse tree |
| REGISTER (≤ 32 per op) | append commitments to the election's depth-20 roll tree |
| DISQUALIFY | set the commitment's roll leaf to 0 |
| BALLOT | election open and `startTime ≤ timestamp < cutoffTime`; nullifier unused (or a revote); **the voter's ballot is valid and eligible**; accumulator += vector (revote: −old +new); nullifier leaf = `ballotCommitment` |
| FORCED_BALLOT | the same, against the payload whose keccak is in the request; `accepted` byte = validity |
| CLOSE | response = the leaf's accumulator and count; status := closed |

Every hash in the state is Poseidon over BN254, and every ciphertext is on Baby Jubjub, whose base
field *is* BN254's scalar field. Both are native, cheap arithmetic in any BN254 circuit.

## The hard part: eligibility needs the voter's secret

A ballot is eligible when the voter knows `(trapdoor, nullifierSecret)` with
`Poseidon(trapdoor, nullifierSecret)` in the roll and
`nullifier = Poseidon(nullifierSecret, electionId)`. Only the voter has that witness.

If the operator proved it inside the batch, it would learn which roll entry cast which nullifier,
and with it which identity cast which ciphertext. Together with k guardians it could then decrypt
named ballots. That is a real weakening, so it is ruled out.

So each voter makes a **voter proof** in the browser, and the batch circuit must **verify those
proofs** without seeing their witnesses. That is proof recursion, and it is the whole difficulty.

Two smaller costs:

- **Ballot-proof challenges are keccak** (`ballot-crypto.js`, `bitChallenge` / `sumChallenge`).
  Re-checking those Chaum-Pedersen proofs in-circuit means about four keccak blocks per option per
  ballot. Better: fold the one-hot check into the voter proof, using Poseidon throughout, and drop
  the Chaum-Pedersen proofs from the batch statement. The operator can keep checking them off-circuit
  as a cheap pre-filter.
- **`sha256(pubdata)`** is about 69 bytes per ballot, around 280 sha256 compressions for a full
  batch of 256. That is heavy but bounded. EIP-4844 blobs with a KZG opening are the modern
  replacement and would also cut L1 calldata cost.

## Options

| | Voter proof | Batch proof | On L1 | Trusted setup | Fit |
| --- | --- | --- | --- | --- | --- |
| **A. Noir / UltraHonk, recursive** | Noir circuit, proved in the browser with bb.js (WASM) | Noir circuit that recursively verifies the voter proofs (or a binary tree of them) and applies the state transitions | Barretenberg's generated UltraHonk verifier | **None per circuit** (universal KZG SRS) | BN254 native: same Poseidon (circomlib-compatible) and Baby Jubjub as today |
| B. Plonky2 + Groth16 wrap (Lighter's path) | Plonky2 in the browser | Plonky2 recursion, wrapped in a BN254 Groth16 proof | the existing `Groth16Verifier` | Groth16 wrap needs a phase-2 ceremony | Goldilocks field: the state trees and nullifiers would move to a Goldilocks hash, or pay non-native costs |
| C. Groth16 voter proofs, aggregated (SnarkPack) | Circom/Groth16 (existing tooling) | Circom batch circuit for transitions only; voter proofs aggregated separately | Groth16 verifier + an aggregate verifier (O(log n) pairings) | Phase-2 ceremonies for both circuits | No mature EVM aggregate verifier |
| D. Voter proofs verified on L1 one by one | Circom/Groth16 | Circom transitions only | ~230k gas per ballot | Ceremony | 6,000 ballots ≈ 1.4 B gas. Ruled out |

**Recommendation: A.** It keeps every existing hash and curve, it needs no trusted-setup ceremony
(today's biggest unscheduled dependency), and it has a maintained path to an Ethereum verifier.
Proving time in the browser is the main risk: measure the voter circuit on a mid-range phone
before committing.

## Voter proof (A)

Public inputs: `chainId, rollup, electionId, eligibleRoot, nullifier, ballotCommitment, jointKey`.

Private: `trapdoor, nullifierSecret`, the roll path (depth 20), the choice, the per-option ElGamal
randomness.

Constraints:

1. `leaf = Poseidon(trapdoor, nullifierSecret)`; Merkle inclusion under `eligibleRoot`. A
   disqualified voter's leaf is 0, so there is no path.
2. `nullifier = Poseidon(nullifierSecret, electionId)`.
3. For each option `i`: `c1ᵢ = rᵢ·G`, `c2ᵢ = mᵢ·G + rᵢ·PK` with `mᵢ ∈ {0,1}` and `Σ mᵢ = 1`.
4. `ballotCommitment = fold(c1x₀, c1y₀, c2x₀, c2y₀, …)` (the existing definition).

About 20 Poseidon hashes plus about 3 Baby Jubjub scalar multiplications per option: small enough
for a browser.

`eligibleRoot` is public, and the batch circuit checks it against the election leaf at the time the
ballot is applied. Rolls are fixed at `startTime`, so a voter proving against the start-time root
always matches.

## Batch proof (A)

For a batch of up to 256 ballots and 64 priority requests:

1. Verify each voter proof (recursive verification), binding its public inputs to the BALLOT op
   (`electionId`, `nullifier`, `ballotCommitment`) and to the election leaf (`eligibleRoot`,
   `jointKey`).
2. Apply each op against Poseidon sparse-tree paths supplied by the operator, as `state.mjs` does.
3. Hash pubdata and the op chains exactly as `commitBatch` does, and expose `commitment`.

Recursion in a tree (for example 8 leaf proofs of 32 ballots each, then one root) keeps each circuit
small and lets the operator prove in parallel.

## Changes this implies

- **Contracts (maintainers):** a verifier for the chosen proof system behind `IBatchVerifier`.
  Its interface takes `uint256[8]` today; UltraHonk proofs are larger, so the interface becomes
  `bytes proof`. `Deploy.s.sol` stops needing `BATCH_VK` from a ceremony.
- **Operator:** a prover client; ballots carry the voter proof (`eligibility` in `POST /v1/ballots`
  already exists for this); `ZK_VOTING_ALLOW_MOCK_PROOFS` goes away on public chains.
- **Browser:** build the voter proof in `rollup-vote.js` (bb.js); the roll path comes from the
  operator's existing `GET /v1/elections/:id/roll/:commitment`.
- **Node:** once eligibility is proven, the vote pass and poll book stop being the gate for civic
  votes. Keep the pass as rate limiting if wanted.
- **Desert mode:** `DesertVerifier` and `desertClose` are unaffected.

## Plan

1. Voter circuit, with tests against `ballot-crypto.js` vectors (roll paths, nullifiers,
   commitments); measure browser proving time.
2. Batch circuit for a fixed small size (4 ballots + 4 requests), with differential tests against
   `state.mjs` on random op sequences.
3. Recursion tree, full size; operator prover; Solidity verifier; `CrossLanguage.t.sol`-style test
   that settles a real proof on Anvil.
4. Contract interface change (maintainers), audit, then a public testnet.

## Open questions

- Browser proving time and memory on phones for the voter proof.
- Blobs (EIP-4844) instead of calldata pubdata: cheaper on L1 and replaces in-circuit sha256 with a
  KZG opening, at the cost of a different commitment scheme in `commitBatch`.
- Revotes: the voter proof makes "the sender owns the nullifier" provable, so civic revoting could
  be turned back on.

## Tooling note

Prototyping needs the Noir toolchain (`nargo`) and Barretenberg (`bb`). The Noir v1.0.0 release
publishes no checksum file, so installing it means trusting the GitHub release over HTTPS. That
decision is left to the maintainers; nothing was installed for this proposal.

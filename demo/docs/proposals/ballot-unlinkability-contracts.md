# Proposal: on-chain ballot unlinkability (contracts and circuits)

Status: **proposal, not implemented.** `smart-contracts/` is hand-owned, so
nothing here has been changed in code. The Node side of ballot unlinkability is
done (see [`../OPERATOR.md`](../OPERATOR.md), "Ballot unlinkability"). What is
left can only be fixed in Solidity and Circom. Until it lands, the honest claim
stops at the Node.

Findings refer to the 2026-10-26 privacy audit:

- **C1**: `submitVoteWithClearance` puts the identity commitment in public calldata next to the nullifier.
- **C2**: `submitOpenedTally` publishes one opening per ballot, in inbox order.
- **D1/D3**: mock proofs and an untrusted setup.

---

## C1. Prove external clearance inside the circuit

### Problem

`BallotInbox.submitVoteWithClearance(electionId, a, b, c, publicInputs,
encryptedBallot, identityCommitment, mustAttestIds)` (`src/BallotInbox.sol`
L99-125) takes the commitment in plaintext. The roll is public:
`VoterRegistered(electionId, identityCommitment, index)`, and the registrar
knows which person holds each commitment. So every ballot cast through this
function is publicly linked: person → commitment → nullifier → ciphertext.

The commitment is also not bound to the proof, so a voter could present
someone else's cleared commitment. That is a soundness bug as well as a
privacy one.

### Option A: no circuit change (recommended first)

Fold external-party decisions into roots that `Vote(20)` already proves.

1. **Rejections → disqualification root.** When an external party rejects a
   commitment, write it into `DisqualificationRegistry` so it lands in
   `disqualificationRoot`. The circuit already proves non-membership
   (`disqLow < commitment`, `disqNext == 0 || commitment < disqNext`), and
   `publicInputs[1]` is already checked against `election.disqualificationRoot()`.
   - `ExternalPartyRegistry`: on `reject(identityCommitment, …)`, call
     `IDisqualificationRegistry(disq).disqualify(electionId, identityCommitment,
     <new ReasonCodes.EXTERNAL_PARTY_REJECTION>, evidenceHash)`. This needs the registry to hold
     the disqualifier role for elections that use it.
   - Lifting a rejection removes the entry, which updates the root.
2. **Must-attest → before roll freeze.** Make "must attest" a precondition for
   inclusion in `eligibleRoot`. `Election.freezeRoll` (or the
   `eligibleRoot` builder) skips any commitment that lacks every active
   must-attest party's attestation. Attestations after freeze are then not
   accepted for that election; they count for the next one.
3. **Delete the clearance path.**
   - Remove `submitVoteWithClearance` from `IBallotInbox` and `BallotInbox`.
   - Remove `_requireExternalClearance`.
   - Change `_requireNoActiveGates` so it never reverts on its own; the roots
     now carry the gate.
4. **Tests** (`smart-contracts/test/`):
   - A rejected commitment's proof fails with `DisqualificationRootMismatch` or
     `InvalidProof`.
   - A commitment with no attestation is not in `eligibleRoot`.
   - No function in the ABI takes an `identityCommitment` together with a
     proof.
   - Update `PrivacyUnlinkability.t.sol` to assert that no calldata decoder
     can find the commitment.

Trade-off: a mid-election rejection takes effect when the disqualification
root updates. The inbox already accepts only the current root, so this is
immediate for new ballots.

### Option B: live attestation root as a new public input

If attestations must be accepted after freeze:

- `ExternalPartyRegistry` maintains `clearanceRoot(electionId)`. This is the
  Poseidon Merkle root (depth 20) of commitments that hold every active
  must-attest attestation and no rejection. Expiry is handled by rebuilding
  the root at expiry boundaries, or by putting the expiry inside the leaf:
  `leaf = Poseidon(commitment, expiresAt)`, with `expiresAt >= now` checked
  against a public `nowBucket`.
- Circuit `vote_lib.circom`, `template Vote(levels)`:
  - Add `signal input clearanceRoot;` (public) and private
    `clearancePathElements[levels]` and `clearancePathIndices[levels]`.
  - Add `component clr = MerkleTreeInclusionProof(levels); clr.leaf <== identity.commitment; … clr.root === clearanceRoot;`.
    This uses the same `identity.commitment` as the eligibility proof, which
    fixes the soundness gap.
  - `vote.circom`:
    `component main {public [root, disqRoot, nullifier, ballotHash, electionId, clearanceRoot]} = Vote(20);`
- `BallotInbox.submitVote`:
  - Accept `publicInputs.length == 6`.
  - Check `publicInputs[5] == IExternalPartyRegistry(reg).clearanceRoot(electionId)`,
    or accept one of the last N roots so in-flight proofs survive an update.
  - When no registry is wired, require `publicInputs[5] == 0` and skip the
    check.
- Regenerate the verifier (`zk/Groth16Verifier*.sol`) and the ceremony
  artifacts. Delete `submitVoteWithClearance` as in Option A.

### Node follow-up once either option lands

- Remove `CLEARANCE_INBOX_ABI` from `packages/chain-client`.
- Remove the identity-commitment check from `POST /api/elections/:id/vote-pass`.
- The pass then only checks session and PIN, and the roots enforce clearance.

---

## C2. Never publish per-ballot openings

### Problem

`Tally.submitOpenedTally(electionId, counts, openings, a, b, c)`
(`src/Tally.sol` L123-169) requires `openings.length == acceptedBallots`, and
the proof binds `openingsHashOf(openings)` to the ordered `ballotRoot`. So
`openings[i]` is the choice of the i-th ballot. `ballotHashAt(i)` gives its
hash, and `VoteAccepted` / `ballotHashOf` give its nullifier. Anyone can read
nullifier → choice, and anyone who links a nullifier (C1, a self-submitted tx,
a leaked receipt token) reads person → choice.

The Node's guardian flow (`tallyOpen.mjs`) also decrypts each envelope one by
one (audit B3), so guardians see nullifier → choice off-chain too.

### Option A: homomorphic tally for single- and multi-choice (recommended)

- **Ballot encoding.** For each option `j`, encrypt `m_j ∈ {0,1}` with
  exponential ElGamal on BabyJubJub under the guardians' joint key
  `(tallyPubKeyX, tallyPubKeyY)`: `C_j = (r_j·G, m_j·G + r_j·H)`.
  `encryptedBallot` becomes the concatenation of the `C_j`, and `ballotHash`
  stays the hash of the ciphertext.
- **Vote circuit.** Add a well-formedness proof:
  - each `m_j·(m_j − 1) == 0`;
  - `Σ m_j == 1`, or `≤ k` for k-of-n questions;
  - the ciphertexts recompute from `(m_j, r_j)` and the public key;
  - `Poseidon(ciphertexts) == ballotHash`.
  - Add `tallyPubKeyHash` as a public input, checked against
    `TallyPublicInputs.tallyKeyHashOf`. Without this, the Node or anyone else
    could submit an encrypted "vote" for two options.
- **Aggregation.** Anyone can multiply the accepted ciphertexts per option
  (`Σ C_j`). The order does not matter, and no single ballot is opened.
- **Tally contract.**
  - Replace `submitOpenedTally` with
    `submitAggregateTally(electionId, counts, aggregateHash, partials, proofs)`.
    Guardians post `t` partial decryptions of the **aggregate only**, each
    with a Chaum-Pedersen DLEQ proof, or one Groth16 proof that covers
    aggregation and decryption.
  - Delete the `openings` parameter, `_openingsHash`, `OpenedTallyPosted` and
    `TallyScheme.OPENS_BALLOTS`.
  - The `TallyPublicInputs.instance` field `openedHash` becomes
    `aggregateHash = Poseidon(Σ C_j for all j)` over the `ballotRoot` set.
- **Node.** `tallyOpen.mjs` aggregates first and asks guardians only for
  partials of the aggregate. `scripts/guardian.mjs` refuses to decrypt any
  single envelope.

### Option B: verifiable shuffle before opening (needed for ranked/IRV)

Ranked ballots can't be summed. For them:

- Guardians, or independent mix servers, re-encrypt and permute the accepted
  ciphertexts. Each mix posts the shuffled list and a proof of shuffle
  (Bayer-Groth, or a Groth16 shuffle circuit for small n) before decryption.
- `submitOpenedTally` then takes openings of the **final shuffled list**. The
  proof binds `openingsHash` to `shuffledRoot`, not to `ballotRoot`. Add
  `submitShuffle(electionId, round, shuffledRoot, proof)` and require
  `rounds >= 2` by distinct operators.
- Until this exists, ranked/IRV elections must not use `opens_ballots`
  on-chain, and the Node keeps `ZKV_ALLOW_PLAINTEXT_BALLOTS` off in production.

### Smaller on-chain items

- **Arrival order and timing.** `_ballotHashList` and `VoteAccepted` are in
  submission order with block timestamps. The relayer should submit in hourly
  batches in random order; the Node already discloses hourly. No contract
  change is needed, but document it as a relayer requirement.
- **Relayer only (B2).** Optionally restrict `submitVote` to an allow-listed
  relayer or bundler set in `ElectionFactory`, so a voter can't self-submit
  from an identifying wallet by mistake. Today the Node is the only shipped
  client path.

---

## D1/D3. Real client proofs and a real trusted setup

- **Client proving.** The SPA sends `proof: { mock: true }` with zero a/b/c.
  Ship `vote.wasm` and `vote_final.zkey` and prove in the browser with
  snarkjs. The witness (trapdoor, nullifierSecret, path) never leaves the
  device. The Node verifies Groth16 off-chain too (`snarkjs.groth16.verify`
  with the published `verification_key.json`) before relaying, so JSON-only
  mode is no longer proof-less (audit D2).
- **Trusted setup.**
  - Phase 1: use a public Powers of Tau (for example Hermez/PSE `ptau` 2^20+).
  - Phase 2: run a multi-party ceremony for `Vote` (and `Tally` /
    well-formedness if Groth16) with independent contributors and a random
    beacon. Publish the transcript and hashes (see
    [`../CEREMONY.md`](../CEREMONY.md)).
  - Generate `Groth16Verifier.sol` from the final zkey.
  - Set `MockVerifier.acceptAll = false` and make the factory refuse mock
    verifiers on any non-dev chain id.
- **Guardian key.** Replace the NON-PRODUCTION Feldman ceremony with a
  verifiable DKG whose transcript is published. Only the aggregate (Option A)
  or the shuffled list (Option B) is ever decrypted.

---

## Checklist for the contract owner

| # | Change | Files |
|---|---|---|
| 1 | Route external-party rejections into `DisqualificationRegistry`; require must-attest before freeze | `ExternalPartyRegistry.sol`, `Election.sol` / `VoterRegistry.sol`, `DisqualificationRegistry.sol`, `ReasonCodes.sol` |
| 2 | Delete `submitVoteWithClearance` and `_requireExternalClearance` | `BallotInbox.sol`, `interfaces/IBallotInbox.sol` |
| 3 | (If live attestation needed) `clearanceRoot` public input | `circuits/vote_lib.circom`, `circuits/vote.circom`, `BallotInbox.sol`, verifier |
| 4 | Exponential-ElGamal ballots + well-formedness in `Vote` | `circuits/vote_lib.circom`, new `circuits/ballot_wf.circom` |
| 5 | Replace `submitOpenedTally` with `submitAggregateTally` (no `openings`) | `Tally.sol`, `interfaces/ITallyVerifier.sol`, `zk/TallyPublicInputs.sol` |
| 6 | Shuffle rounds before any per-ballot opening (ranked) | `Tally.sol` (new `submitShuffle`), new shuffle verifier |
| 7 | Real verifier from a multi-party phase-2 ceremony; mock refused off dev chains | `zk/Groth16Verifier*.sol`, `ElectionFactory.sol` |
| 8 | Tests proving no calldata or event carries a commitment or a per-ballot opening | `test/PrivacyUnlinkability.t.sol` and new tests |

When 1, 2, 4 and 5 (or 6 for ranked) and 7 are in, the claim "no individual
ballot can be attributed to a person" can extend from the Node to the public
chain.

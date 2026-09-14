# Circuits

**NOT FOR PROFIT** — civic public good. Not a commercial product. See [`/NOT_FOR_PROFIT.md`](../NOT_FOR_PROFIT.md).

Circom 2 circuits for Republic / zk-voting. Self-contained: **no circomlib path**. The in-circuit hasher is a labeled stand-in until Poseidon is vendored.

| File | Job |
| --- | --- |
| [`identity.circom`](./identity.circom) | `Hasher`, identity commitment, nullifier |
| [`vote.circom`](./vote.circom) | Eligible-set Merkle membership + unique nullifier + ballot / disqualification-root bind |
| [`tally.circom`](./tally.circom) | Published per-option counts match accepted ballots (plaintext / mock-homomorphic path) |

---

## Hasher: Poseidon is preferred

Production identity commitments, Merkle `hashLeftRight`, and nullifiers **must** use **Poseidon** (the same permutation the Solidity `IHasher` will call once a Poseidon hasher is wired). Poseidon is cheap in R1CS and is what Semaphore / MACI-style voting circuits use.

This directory does **not** `include` circomlib: that path is not in the repo. Until it is:

```circom
template Hasher() {
    signal input a;
    signal input b;
    signal output out;
    // STAND-IN HashLeftRight. NOT production Poseidon.
    out <== a + b + a * b;
}
```

That bilinear mix is **not collision-resistant**. It exists so the circuit topology (membership, nullifier, tally summation) can compile and so Foundry tests that use `KeccakHasher` on chain can stay honest about the *interface* (`hashLeftRight(uint256,uint256)`). **Do not** run a binding election, a trusted setup, or a ceremony on this stand-in.

Swap the body of `Hasher()` for `Poseidon(2)` (circomlib) and recompile `Vote(treeDepth)` at the election’s `ElectionParams.treeDepth` (16..32) before any proving keys are published.

---

## Vote

`Vote(levels)` private witness:

- `identityTrapdoor`
- `nullifierSecret`
- `pathElements[levels]`
- `pathIndices[levels]` (0 = current is left child, 1 = right)

Public instance — **same order** as `@zk-voting/proof-helpers` `serializePublicInputs` and `IBallotInbox.submitVote`:

```text
[root, disqRoot, nullifier, ballotHash, electionId]
```

Constraints:

1. `leaf = Hash(identityTrapdoor, nullifierSecret)` (Poseidon in production).
2. Merkle inclusion of `leaf` under `root` (the **eligible** tree: registered ∩ ¬disqualified).
3. `nullifier = Hash(nullifierSecret, electionId)`.
4. `disqRoot` is bound into the constraint system so a proof is specific to the live disqualification tree the contract publishes. A disqualified person cannot produce an accepting membership proof against the eligible root.
5. `ballotHash` is a public commitment to the encrypted ballot. Choice bits are not plaintext public inputs.

Default `component main` compiles `Vote(20)`. Recompile at 16, 24, or 32 to match a given election. The Solidity incremental tree and this template argument **must agree**.

---

## Tally

`Tally(nBallots, nOptions)` is the **mock / plaintext** path used with `MockVerifier` and local L2:

- Each `ballots[i]` is either an option index in `[0, nOptions)` or the padding sentinel `nOptions`.
- `counts[j]` equals the number of ballots equal to `j`.
- `sum(counts) === acceptedCount`.

Production tallying is homomorphic: inbox ciphertexts (ElGamal or equivalent) are multiplied, then a decryption proof (or mixnet) shows the same counts. The summation constraints stay; the ballot wires become decrypted shares. Do not publish decrypted ballots linked to nullifiers.

Default `main` is `Tally(8, 4)` for compile tests. Production compiles to the inbox size and ballot spec.

---

## Compile (when `circom` is on PATH)

Circom 2.0+ and snarkjs. Powers of tau live **outside git** (`circuits/pot*.ptau` is gitignored).

```bash
cd circuits
mkdir -p build

# R1CS + wasm witness (Vote depth 20, as in vote.circom main)
circom vote.circom --r1cs --wasm --sym -o build

circom tally.circom --r1cs --wasm --sym -o build

# identity.circom has no main; it is included by the others.
```

Groth16 (only after a real Poseidon hasher and a ceremony — **not** with the stand-in hasher):

```bash
# example; replace ptau with a trusted file for the constraint count
snarkjs groth16 setup build/vote.r1cs pot14_final.ptau build/vote_0000.zkey
snarkjs zkey contribute build/vote_0000.zkey build/vote_final.zkey
snarkjs zkey export verificationkey build/vote_final.zkey build/verification_key.json
snarkjs zkey export solidityverifier build/vote_final.zkey ../smart-contracts/src/zk/VoteVerifier.sol
```

Until those keys exist, **Foundry tests and local L2 use `MockVerifier`**. That is intentional. A mock that always accepts is not an election.

Witness inputs for `vote` (JSON for snarkjs) look like:

```json
{
  "identityTrapdoor": "…",
  "nullifierSecret": "…",
  "pathElements": ["…", "…"],
  "pathIndices": ["0", "1"],
  "root": "…",
  "disqRoot": "…",
  "nullifier": "…",
  "ballotHash": "…",
  "electionId": "1"
}
```

`pathElements` / `pathIndices` length must equal `levels`.

---

## What the Node and contracts expect

The Node (`apps/node`) may orchestrate proving in the browser or a helper; it must not be the only place a proof can be produced. `BallotInbox.submitVote` takes Groth16 `(a,b,c)` plus `publicInputs` and `encryptedBallot`. Relayer / bundler is `msg.sender`. The voter’s passkey smart-account address is **not** the Merkle leaf and is **not** sitting next to the ballot.

See [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md), [`docs/PASSKEYS.md`](../docs/PASSKEYS.md), and [`packages/proof-helpers`](../packages/proof-helpers).

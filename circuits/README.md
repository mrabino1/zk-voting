# Circuits

**NOT FOR PROFIT** — civic public good. Not a commercial product. See [`/NOT_FOR_PROFIT.md`](../NOT_FOR_PROFIT.md).

Circom 2 circuits for Republic / zk-voting. Self-contained: **no circomlib path**. The in-circuit hasher is a **gated** stand-in (`republic.hash.standin-v0`) until Poseidon is vendored. Hash versions: [`HASH_SCHEME.md`](./HASH_SCHEME.md).

**Proving path status: in progress.** Local compile / untrusted setup / export scripts exist. There is **no** published ceremony. `MockVerifier` remains the Foundry unit-test default.

| File | Job |
| --- | --- |
| [`identity.circom`](./identity.circom) | Identity commitment + nullifier (`include` of gated hasher) |
| [`hasher/standin.circom`](./hasher/standin.circom) | Selected `Hasher()` — bilinear mix, **not** Poseidon |
| [`hasher/poseidon.circom`](./hasher/poseidon.circom) | Production target (not included; compile fails if selected too early) |
| [`vote.circom`](./vote.circom) | Eligible-set Merkle membership + unique nullifier + ballot / disqualification-root bind |
| [`tally.circom`](./tally.circom) | Published per-option counts match accepted ballots (plaintext / mock-homomorphic path) |
| [`scripts/proving-path.mjs`](./scripts/proving-path.mjs) | Compile, untrusted ptau + Groth16, export verifier, demo prove |

---

## Hasher: Poseidon is the production target

Production identity commitments, Merkle `hashLeftRight`, and nullifiers **must** use **Poseidon** (`republic.hash.poseidon-bn254-x5-t3-v1`) — the same permutation Solidity `IHasher` will call once a Poseidon hasher is wired.

Until circomlib is vendored, `identity.circom` includes only `hasher/standin.circom`:

```circom
template Hasher() {
    signal input a;
    signal input b;
    signal output out;
    // STAND-IN HashLeftRight. NOT production Poseidon.
    out <== a + b + a * b;
}
```

That bilinear mix is **not collision-resistant** (`hash(x,0)==x`). It exists so the circuit topology can compile and so the local proving path can share one formula with `StandInHasher` and `@zk-voting/proof-helpers`. Foundry unit tests keep `KeccakHasher` (`keccak-dev-v1`). **Do not** run a binding election or a trusted setup on the stand-in.

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

The **nullifier still uniquely identifies the voter** and is spent **once**. `BallotInbox` rejects a second proof for that nullifier, including a new `ballotHash` (roadmap item 10: one accepted nullifier; not last-vote-counts). The circuit public-input list does not change; MockVerifier tests that resubmit any second ballot still revert.

Default `component main` compiles `Vote(20)`. Recompile at 16, 24, or 32 to match a given election. The Solidity incremental tree and this template argument **must agree**.

---

## Tally

`Tally(nBallots, nOptions)` is the **mock / plaintext** path used with `MockVerifier` and local L2:

- Each `ballots[i]` is either an option index in `[0, nOptions)` or the padding sentinel `nOptions`.
- `counts[j]` equals the number of ballots equal to `j`.
- `sum(counts) === acceptedCount`.
- `electionId` is a public input so a tally proof is specific to one poll.

**Public signals (`CIRCOM_TALLY_V1`, default `Tally(8, 4)`).** Circom puts outputs first:

```text
[total, electionId, counts[0], counts[1], counts[2], counts[3], acceptedCount]
```

**Solidity (`TALLY_SOL_MOCK_V1`, `TallyPublicInputs.sol` / `Tally.sol`):**

```text
[version=1, electionId, acceptedCount, countsHash, ballotRoot, openingsHash]
```

These encodings are versioned separately. Circom fixes `nOptions` at compile time. Solidity hashes a variable-length `counts` vector and binds `ballotRoot` / `openingsHash` for the OPENS_BALLOTS path. Do not export a Groth16 Solidity verifier from this R1CS and set `ElectionParams.verifier` to it without a translating wrapper. Foundry tests keep `MockVerifier`.

Production tallying is homomorphic: inbox ciphertexts (ElGamal or equivalent) are multiplied, then a decryption proof (or mixnet) shows the same counts. The summation constraints stay; the ballot wires become decrypted shares. Do not publish decrypted ballots linked to nullifiers.

The first vertical slice that **opens** ballots is off-circuit: Node P-256 ECIES (threshold-1 operator key, **NON-PRODUCTION**) plus `Tally.submitOpenedTally` histogram checks. See the root README “Tally encryption (honest status)”.

---

## Exact commands (proving path in progress)

Circom 2.0+ and snarkjs. Powers of tau, zkeys, and `verification_key.json` live **outside git** (`circuits/build/` is gitignored). Wrapper: `node circuits/scripts/proving-path.mjs` or `npm run circuits:*`.

```bash
# from repo root
npm run circuits:status     # tools, HASH_SCHEME, ceremony=not-done
npm run circuits:compile     # requires circom on PATH
npm run circuits:setup      # UNTRUSTED local powers-of-tau + groth16 — NOT a ceremony
npm run circuits:export      # circuits/build/vote_Groth16Verifier.sol (does not overwrite VoteVerifier.sol)
npm run circuits:prove       # demo standin-v0 witness + groth16 verify
npm run circuits:all
```

Manual equivalent (same steps the script runs):

```bash
cd circuits
mkdir -p build

circom vote.circom --r1cs --wasm --sym -o build
circom tally.circom --r1cs --wasm --sym -o build
# identity.circom has no main; it is included by the others.

# UNTRUSTED ptau — anyone who ran this knows the toxic waste
snarkjs powersoftau new bn128 12 build/pot12_0000.ptau -v
snarkjs powersoftau contribute build/pot12_0000.ptau build/pot12_0001.ptau \
  --name=republic-local-untrusted -e=republic-local-untrusted-dev-only-not-a-ceremony -v
snarkjs powersoftau prepare phase2 build/pot12_0001.ptau build/pot12_final.ptau -v

snarkjs groth16 setup build/vote.r1cs build/pot12_final.ptau build/vote_0000.zkey
snarkjs zkey contribute build/vote_0000.zkey build/vote_final.zkey \
  --name=republic-local-untrusted -e=republic-local-untrusted-dev-only-not-a-ceremony
snarkjs zkey export verificationkey build/vote_final.zkey build/vote_verification_key.json
snarkjs zkey export solidityverifier build/vote_final.zkey build/vote_Groth16Verifier.sol
```

**Do not** `export solidityverifier` onto `smart-contracts/src/zk/VoteVerifier.sol`. That file is the structural verifier with a zero VK. Deploy the generated contract and wrap it with `Groth16VerifierAdapter`.

Until a Poseidon hasher and a real ceremony exist:

- **Foundry unit tests** use `MockVerifier` (`acceptAll = true`).
- **Local proving-path integration:** `REPUBLIC_PROVING_PATH=1` (or `REPUBLIC_USE_MOCK_VERIFIER=0`) deploys `VoteVerifier` **without** a mock fallback. Dummy proofs fail.

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

`pathElements` / `pathIndices` length must equal `levels`. `npm run circuits:prove` writes `circuits/build/vote_demo.input.json` (two leaves so the first sibling is not zero).

---

## What the Node and contracts expect

The Node (`apps/node`) may orchestrate proving in the browser or a helper; it must not be the only place a proof can be produced. `BallotInbox.submitVote` takes Groth16 `(a,b,c)` plus `publicInputs` and `encryptedBallot`. Relayer / bundler is `msg.sender`. The voter’s passkey smart-account address is **not** the Merkle leaf and is **not** sitting next to the ballot.

See [`HASH_SCHEME.md`](./HASH_SCHEME.md), [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md), [`docs/PASSKEYS.md`](../docs/PASSKEYS.md), and [`packages/proof-helpers`](../packages/proof-helpers).

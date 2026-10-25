# Circuits

**NOT FOR PROFIT** — civic public good. Not a commercial product. See [`/NOT_FOR_PROFIT.md`](../NOT_FOR_PROFIT.md).

Circom 2 circuits for Republic / zk-voting. The vote hasher is **Poseidon(2)** (`republic.hash.poseidon-bn254-x5-t3-v1`), the circomlib bn254 parameter set, vendored as t=3 constants (not a full circomlib checkout). Hash versions: [`HASH_SCHEME.md`](./HASH_SCHEME.md).

**Proving path status: in progress.** Poseidon matches Circom, JS, the browser helper, and `PoseidonHasher`. A committed **untrusted** Vote(4) Groth16 fixture can be verified. There is **no** published ceremony. `MockVerifier` remains the Foundry unit-test default. Do not use the local keys for a binding election.

| File | Job |
| --- | --- |
| [`identity.circom`](./identity.circom) | Identity commitment + nullifier (`include` of Poseidon `Hasher()`) |
| [`hasher/poseidon.circom`](./hasher/poseidon.circom) | Selected `Hasher()` — Poseidon(2). Not a ceremony |
| [`hasher/standin.circom`](./hasher/standin.circom) | Legacy bilinear mix. **Not included** |
| [`mains/vote_smoke.circom`](./mains/vote_smoke.circom) | `Vote(4)` for the untrusted Groth16 fixture only |
| [`vote.circom`](./vote.circom) | Eligible-set membership + disqualification-chain non-membership + nullifier + ballot bind |
| [`tally.circom`](./tally.circom) | Published per-option counts match accepted ballots (plaintext / mock-homomorphic path) |
| [`scripts/proving-path.mjs`](./scripts/proving-path.mjs) | Compile, untrusted ptau + Groth16, export verifier, demo prove |
| [`scripts/ceremony.mjs`](./scripts/ceremony.mjs) | Phase-2 contribute / verify / beacon / export. Not a ceremony. See [`docs/CEREMONY.md`](../docs/CEREMONY.md) |

---

## Hasher: Poseidon(2)

`identity.circom` includes `hasher/poseidon.circom`. `Hasher()` is circomlib-compatible Poseidon(2). The same function is `poseidonHashLeftRight` in `@zk-voting/proof-helpers` and `PoseidonT3.hashLeftRight` in Solidity.

Foundry unit tests and the demo Node tree still use `KeccakHasher` (`keccak-dev-v1`) for Merkle links. The demo passkey screen uses `poseidonCommitmentHex` (`Poseidon(trapdoor, nullifierSecret)`), the same leaf as the circuit. Do not mix keccak leaves into a Poseidon tree.

`hasher/standin.circom` (`out = a + b + a*b`) is legacy and not included. **There is no ceremony.** Local zkeys are untrusted.

---

## Vote

`Vote(levels)` private witness:

- `identityTrapdoor`
- `nullifierSecret`
- `pathElements[levels]`
- `pathIndices[levels]` (0 = current is left child, 1 = right)
- `disqLow`, `disqNext` — indexed-chain gap around the leaf
- `disqPathElements[levels]`, `disqPathIndices[levels]` — inclusion of `Hash(disqLow, disqNext)` under `disqRoot`

Public instance — **same order** as `@zk-voting/proof-helpers` `serializePublicInputs` and `IBallotInbox.submitVote`:

```text
[root, disqRoot, nullifier, ballotHash, electionId]
```

Constraints:

1. `leaf = Hash(identityTrapdoor, nullifierSecret)` (Poseidon).
2. Merkle inclusion of `leaf` under `root` (the **eligible** tree: registered ∩ ¬disqualified).
3. `nullifier = Hash(nullifierSecret, electionId)`.
4. Non-membership of `leaf` in the disqualification chain under `disqRoot`. The chain is sorted currently-disqualified commitments with a 0 sentinel: `Hash(0, v0) … Hash(vLast, 0)`, or `Hash(0, 0)` when nobody is disqualified. The witness is one link whose open interval contains `leaf`. A disqualified leaf is a boundary, so the range check fails. See [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md). `MockVerifier` evaluates this only when a test arms the witness.
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

The first vertical slice that **opens** ballots is off-circuit: Node P-256 ECIES under a Feldman t-of-n guardian key (**NON-PRODUCTION**) plus `Tally.submitOpenedTally` histogram checks. Homomorphic aggregation versus a mixnet is not selected. See [`docs/TALLY_GUARDIANS.md`](../docs/TALLY_GUARDIANS.md) and the root README “Tally encryption (honest status)”.

---

## Exact commands (proving path in progress)

Circom 2.0+ and snarkjs. Powers of tau, zkeys, and `verification_key.json` live **outside git** (`circuits/build/` is gitignored). Wrapper: `node circuits/scripts/proving-path.mjs` or `npm run circuits:*`.

```bash
# from repo root
npm run circuits:status     # tools, Poseidon HASH_SCHEME, ceremony=not-done
npm run circuits:verify     # real Vote(4) proof, or GROTH16_KEYS_MISSING (not accept-all)
npm run circuits:smoke      # regenerate that untrusted fixture (circom + snarkjs)
npm run circuits:compile    # Vote(20) + tally; requires circom on PATH
npm run circuits:setup      # UNTRUSTED local powers-of-tau + groth16 — NOT a ceremony
npm run circuits:export     # circuits/build/vote_Groth16Verifier.sol (does not overwrite VoteVerifier.sol)
npm run circuits:prove      # demo Poseidon witness + groth16 verify
npm run circuits:all
npm run circuits:ceremony -- help   # phase-2 contribute / verify / beacon / export
npm run circuits:ceremony:toy       # published-entropy multi-contributor drill; NOT a ceremony
```

Manual equivalent (same steps the script runs):

```bash
cd circuits
mkdir -p build

circom vote.circom --r1cs --wasm --sym -o build
circom tally.circom --r1cs --wasm --sym -o build
# identity.circom has no main; it is included by the others.

# UNTRUSTED ptau — anyone who ran this knows the toxic waste.
# Power 16 is the Vote(20) default. The Vote(4) smoke fixture uses power 14.
snarkjs powersoftau new bn128 16 build/pot16_0000.ptau -v
snarkjs powersoftau contribute build/pot16_0000.ptau build/pot16_0001.ptau \
  --name=republic-local-untrusted -e=republic-local-untrusted-dev-only-not-a-ceremony -v
snarkjs powersoftau prepare phase2 build/pot16_0001.ptau build/pot16_final.ptau -v

snarkjs groth16 setup build/vote.r1cs build/pot16_final.ptau build/vote_0000.zkey
snarkjs zkey contribute build/vote_0000.zkey build/vote_final.zkey \
  --name=republic-local-untrusted -e=republic-local-untrusted-dev-only-not-a-ceremony
snarkjs zkey export verificationkey build/vote_final.zkey build/vote_verification_key.json
snarkjs zkey export solidityverifier build/vote_final.zkey build/vote_Groth16Verifier.sol
```

**Do not** `export solidityverifier` onto `smart-contracts/src/zk/VoteVerifier.sol`. That file is the structural verifier with a zero VK. Deploy the generated contract and wrap it with `Groth16VerifierAdapter`.

Ceremony status: **not done.** Phase-2 tooling (contribute, verify, beacon, export) is in [`circuits/scripts/ceremony.mjs`](./scripts/ceremony.mjs). The runbook is [`docs/CEREMONY.md`](../docs/CEREMONY.md). `npm run circuits:ceremony:toy` checks a published-entropy multi-contributor transcript. That run is not a ceremony, and the scripts cannot mark keys trusted.

- **Foundry unit tests** use `MockVerifier` (`acceptAll = true`) and `KeccakHasher`.
- **`UntrustedGroth16Test`** verifies the committed Vote(4) proof with the exported verifier. Missing files revert `GROTH16_KEYS_MISSING`.
- **Local proving-path deploy:** `REPUBLIC_PROVING_PATH=1` (or `REPUBLIC_USE_MOCK_VERIFIER=0`) deploys `PoseidonHasher` and `VoteVerifier` **without** a mock fallback. Dummy proofs fail. Set `REPUBLIC_VOTE_VERIFIER` to wrap an exported verifier. That key is still untrusted, and Vote(4) does not match election depth 20.

Witness inputs for `vote` (JSON for snarkjs) look like:

```json
{
  "identityTrapdoor": "…",
  "nullifierSecret": "…",
  "pathElements": ["…", "…"],
  "pathIndices": ["0", "1"],
  "disqLow": "0",
  "disqNext": "0",
  "disqPathElements": ["…"],
  "disqPathIndices": ["0"],
  "root": "…",
  "disqRoot": "…",
  "nullifier": "…",
  "ballotHash": "…",
  "electionId": "1"
}
```

`pathElements` / `pathIndices` length must equal `levels`. `npm run circuits:prove` writes `circuits/build/vote_demo.input.json` (Poseidon, depth 20). `npm run circuits:smoke` writes a depth-4 witness for the fixture.

---

## What the Node and contracts expect

The Node (`apps/node`) may orchestrate proving in the browser or a helper; it must not be the only place a proof can be produced. `BallotInbox.submitVote` takes Groth16 `(a,b,c)` plus `publicInputs` and `encryptedBallot`. Relayer / bundler is `msg.sender`. The voter’s passkey smart-account address is **not** the Merkle leaf and is **not** sitting next to the ballot.

See [`HASH_SCHEME.md`](./HASH_SCHEME.md), [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md), [`docs/PASSKEYS.md`](../docs/PASSKEYS.md), and [`packages/proof-helpers`](../packages/proof-helpers).

# HASH_SCHEME

**NOT FOR PROFIT** — civic public good. Not a commercial product.

Republic uses one HashLeftRight shape (`IHasher.hashLeftRight(uint256,uint256)` / Circom `Hasher()`).

**The vote circuit hasher is Poseidon(2)** (`republic.hash.poseidon-bn254-x5-t3-v1`): bn254, S-box x^5, state width t=3, the circomlib parameter set. The same permutation is implemented in:

| Place | Code |
| --- | --- |
| Circom | `circuits/hasher/poseidon.circom` (included by `identity.circom`) |
| JavaScript | `packages/proof-helpers/poseidon.js` |
| Browser | `apps/node/public/poseidon.js` (`poseidonCommitmentHex`) |
| Solidity | `PoseidonT3` / `PoseidonHasher` |

Shared check: `Poseidon(1, 2) = 7853200120776062878684798364095072458815029376092732009249414926327459813530`.

This is **not** a completed ceremony. Keys from `npm run circuits:setup` or `npm run circuits:smoke` are **untrusted**. Anyone who ran that command knows the toxic waste. Do not use them for a binding election.

Phase-2 ceremony scripts (`npm run circuits:ceremony`, runbook [`docs/CEREMONY.md`](../docs/CEREMONY.md)) also leave keys untrusted. The CI toy transcript uses published entropy. Neither one is a public ceremony.

## What is still not Poseidon

| Id | Where | Status |
| --- | --- | --- |
| `republic.hash.poseidon-bn254-x5-t3-v1` | Vote circuit, proof-helpers, `PoseidonHasher`, browser `poseidon.js` | **Wired.** Not a ceremony. |
| `republic.hash.keccak-dev-v1` | Foundry unit tests, Node Merkle, demo passkey commitment (`deriveIdentitySecrets`) | Default when `REPUBLIC_PROVING_PATH` is off. Do not mix these leaves into a Poseidon proof. |
| `republic.hash.standin-v0` | `StandInHasher`, `standInHashLeftRight`, `hasher/standin.circom` | **Legacy.** Not included by the circuit. `hash(x, 0) == x`. |

`schemeId()` on the Solidity hashers is `keccak256` of the id string.

## Groth16

`MockVerifier.acceptAll` is the Foundry unit-test and demo deploy default. It is not the proving path.

`REPUBLIC_PROVING_PATH=1` (or `REPUBLIC_USE_MOCK_VERIFIER=0`) deploys `PoseidonHasher` and a verifier with **no** mock fallback:

- no `REPUBLIC_VOTE_VERIFIER`: `VoteVerifier` with a **zero** verifying key. Dummy proofs revert `VerifierNotConfigured`.
- `REPUBLIC_VOTE_VERIFIER=<exported verifier>`: `Groth16VerifierAdapter` around that contract. Still untrusted until a ceremony, and the circuit depth must match the election (`Vote(20)` vs the Vote(4) smoke fixture).

The committed check is **Vote(4)**, not an election depth (elections are 16..32):

```bash
npm run circuits:verify
# missing fixture or snarkjs exits non-zero:
#   GROTH16_KEYS_MISSING ... This check does not use MockVerifier.acceptAll.
```

Regenerate the untrusted fixture (circom + snarkjs; zkeys stay gitignored):

```bash
npm run circuits:smoke
```

Full election circuit (heavier; default `REPUBLIC_PTAU_POWER=16`):

```bash
npm run circuits:status
npm run circuits:compile    # vote.circom is Vote(20); tally.circom does not hash ballots
npm run circuits:setup      # UNTRUSTED
npm run circuits:export     # circuits/build/*_Groth16Verifier.sol — does not overwrite VoteVerifier.sol
npm run circuits:prove
```

`npm run circuits:test` always checks the Poseidon vector and verifies the committed fixture. It runs the full Vote(20) setup only when `REPUBLIC_PROVING_PATH=1`.

Foundry also verifies the committed smoke proof against the exported Solidity verifier (`UntrustedGroth16Test`). That test fails with `GROTH16_KEYS_MISSING` if the fixture files are absent. It does not call `MockVerifier`.

## Env flags

| Variable | Default | Meaning |
| --- | --- | --- |
| `REPUBLIC_PROVING_PATH` | unset / `0` | `1` / `true`: non-mock deploy, hash scheme Poseidon. Unit tests ignore this except the documented fail-closed check. |
| `REPUBLIC_USE_MOCK_VERIFIER` | `1` | `0` / `false`: same as proving path for deploy scripts. |
| `REPUBLIC_HASH_SCHEME` | keccak-dev-v1, or Poseidon when proving path is on | Override (`poseidon`, `keccak-dev-v1`, `standin-v0`). |
| `REPUBLIC_VOTE_VERIFIER` | unset | Address of a snarkjs verifier to wrap when the proving path is on. |
| `REPUBLIC_PTAU_POWER` | `16` | Local untrusted powers-of-tau for Vote(20). |
| `REPUBLIC_SMOKE_PTAU_POWER` | `13` | Enough for the Vote(4) smoke circuit (~5k constraints). |

snarkjs JSON proofs (`pi_a` / `pi_b` / `pi_c`) need the G2 limb swap before Solidity. `snarkjsProofToSolidity` does that. Proofs already shaped as `{a,b,c}` are left alone.

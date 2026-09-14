# HASH_SCHEME

**NOT FOR PROFIT** — civic public good. Not a commercial product.

Republic uses one HashLeftRight shape everywhere (`IHasher.hashLeftRight(uint256,uint256)` / Circom `Hasher()`). The **production target is Poseidon**. Until Poseidon is vendored, two development schemes exist. They must not be mixed in one tree or one proof.

This is **not** a completed ceremony. Local Groth16 keys produced by `circuits/scripts/proving-path.mjs setup` are **untrusted**.

Stand-in `Vote(20)` currently compiles to **126 non-linear constraints** (topology-only). `Tally(8,4)` is ~80. `REPUBLIC_PTAU_POWER=10` is enough for this hasher. Poseidon `Vote(20)` will need a much larger ptau.

## Versions

| Id | Where it is used | Status |
| --- | --- | --- |
| `republic.hash.keccak-dev-v1` | Foundry unit tests, Node Merkle (`KeccakHasher`, `keccak256(left \|\| right)`) | Default for `forge test` / Node |
| `republic.hash.standin-v0` | Circom `Hasher()`, `StandInHasher`, JS `standInHashLeftRight` | Selected proving-path circuit |
| `republic.hash.poseidon-bn254-x5-t3-v1` | Poseidon(2) over bn254, x^5, t=3 | **Not wired** — `hasher/poseidon.circom` is a gate, not an include |

`schemeId()` on the Solidity hashers is `keccak256` of the id string so JS and Solidity can compare the same `bytes32`.

## Single strategy toward Poseidon

1. Keep **keccak-dev-v1** as the unit-test default so existing Foundry / Node tests keep their roots.
2. Align Circom, the proving-path JS witness builder (`@zk-voting/proof-helpers`), and `StandInHasher` on **standin-v0** so a local Groth16 proof can be produced at all.
3. Swap `include "./hasher/standin.circom"` in `identity.circom` for `hasher/poseidon.circom` **after** circomlib Poseidon is vendored. Recompile `Vote(treeDepth)`, then run a real powers-of-tau + Groth16 contribution. Do not treat `npm run circuits:setup` as that ceremony.

Stand-in formula (Fr = bn254 scalar field):

```text
out = (a + b + a*b)  mod Fr
```

Footguns (why this is not production):

- Not collision-resistant.
- `hash(x, 0) = x`, so an all-zero Merkle path is degenerate (root equals the leaf).
- Demo witnesses insert **two** leaves so the first sibling is nonzero.

## Env flags

| Variable | Default | Meaning |
| --- | --- | --- |
| `REPUBLIC_PROVING_PATH` | unset / `0` | `1` / `true`: non-mock deploy (`VoteVerifier`, no accept-all). Unit tests ignore this. |
| `REPUBLIC_USE_MOCK_VERIFIER` | `1` | `0` / `false`: same as proving path for deploy scripts. |
| `REPUBLIC_HASH_SCHEME` | keccak-dev-v1, or standin-v0 when proving path is on | Override hasher id (`standin-v0`, `keccak-dev-v1`, …) |
| `REPUBLIC_PTAU_POWER` | `12` | Local untrusted powers-of-tau size (`2^power` constraints) |

`MockVerifier.acceptAll` remains the Foundry unit-test path. `REPUBLIC_PROVING_PATH=1` is for integration / local Anvil only.

## Exact commands

From the repository root (Circom 2 + snarkjs required for compile/setup):

```bash
npm run circuits:status
npm run circuits:compile
npm run circuits:setup      # UNTRUSTED local ptau + groth16; keys gitignored
npm run circuits:export     # circuits/build/*_Groth16Verifier.sol — does not overwrite VoteVerifier.sol
npm run circuits:prove      # demo vote + tally witness, groth16 verify
# or:
npm run circuits:all
node circuits/scripts/proving-path.mjs test   # hash checks always; groth16 if tools exist
```

Equivalent CLI (what the script runs):

```bash
cd circuits
mkdir -p build
circom vote.circom --r1cs --wasm --sym -o build
circom tally.circom --r1cs --wasm --sym -o build

# UNTRUSTED — toxic waste is known
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

Deploy the generated verifier, then `Groth16VerifierAdapter(impl, 5)` so `BallotInbox` can call `IGroth16Verifier`.

Non-mock local stack:

```bash
cd smart-contracts
REPUBLIC_PROVING_PATH=1 forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
```

That deploy uses `StandInHasher` + `VoteVerifier` with **no** mock fallback. Dummy proofs fail until a real VK is installed (export + adapter). Unit tests still use `MockVerifier`.

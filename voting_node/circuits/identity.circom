pragma circom 2.0.0;

// NOT FOR PROFIT — civic public good, not a commercial product.
//
// Identity primitives for ZK-Voting.
//
// PRODUCTION HASHER: Poseidon is preferred for identity commitments,
// Merkle trees, and nullifiers. It is cheap in-circuit, matches the
// intended IHasher.hashLeftRight on chain (`PoseidonHasher`), and is
// what Semaphore / MACI-style voting circuits use.
//
// HASH_SCHEME (selected include):
//   zk-voting.hash.poseidon-bn254-x5-t3-v1 — hasher/poseidon.circom (selected)
//   zk-voting.hash.standin-v0 — hasher/standin.circom (legacy, not included)
// See circuits/HASH_SCHEME.md. Do not include both.
include "./hasher/poseidon.circom";

// identityCommitment = Hash(identityTrapdoor, nullifierSecret)
//
// The trapdoor stays on the device (WebAuthn PRF → HKDF). The
// commitment is the Merkle leaf. Neither the smart-account address
// nor a civil name is the leaf — see docs/ARCHITECTURE.md.
template IdentityCommitment() {
    signal input identityTrapdoor;
    signal input nullifierSecret;
    signal output commitment;

    component hasher = Hasher();
    hasher.a <== identityTrapdoor;
    hasher.b <== nullifierSecret;
    commitment <== hasher.out;
}

// nullifier = Hash(nullifierSecret, electionId)
//
// Revealed at vote time so the same person cannot vote twice in the
// same election. Unlinkable to the identity commitment without the
// trapdoor, and unlinkable to the passkey smart-account address.
template ComputeNullifier() {
    signal input nullifierSecret;
    signal input electionId;
    signal output nullifier;

    component hasher = Hasher();
    hasher.a <== nullifierSecret;
    hasher.b <== electionId;
    nullifier <== hasher.out;
}

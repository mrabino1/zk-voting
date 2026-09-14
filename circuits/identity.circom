pragma circom 2.0.0;

// NOT FOR PROFIT — civic public good, not a commercial product.
//
// Identity primitives for Republic / zk-voting.
//
// PRODUCTION HASHER: Poseidon is preferred for identity commitments,
// Merkle trees, and nullifiers. It is cheap in-circuit, matches the
// intended IHasher.hashLeftRight on chain once a Poseidon hasher is
// wired, and is what Semaphore / MACI-style voting circuits use.
//
// This file does NOT include circomlib (the path is not vendored here).
// Hasher() below is a STAND-IN HashLeftRight. It is NOT Poseidon, NOT
// MiMC, NOT collision-resistant, and MUST NOT be used in a binding
// election. Swap it for Poseidon(2) before any trusted setup.

// =============================================================================
// Hasher — STAND-IN. NOT production Poseidon.
// =============================================================================
// Dummy HashLeftRight: out = a + b + a*b over the scalar field.
// Same shape as IHasher.hashLeftRight(uint256, uint256) so Merkle code
// and Solidity trees can swap implementations without changing topology.
template Hasher() {
    signal input a;
    signal input b;
    signal output out;

    // Single quadratic constraint. Replace this body with Poseidon(2)
    // (circomlib poseidon.circom) for production.
    out <== a + b + a * b;
}

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

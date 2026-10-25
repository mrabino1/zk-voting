pragma circom 2.0.0;

// NOT FOR PROFIT — civic public good, not a commercial product.
//
// HASH_SCHEME: zk-voting.hash.standin-v0
//
// LEGACY. Not included by identity.circom. The selected Hasher is
// hasher/poseidon.circom (zk-voting.hash.poseidon-bn254-x5-t3-v1).
// This bilinear mix is NOT collision-resistant. hash(x, 0) == x.
// Kept so old vectors and StandInHasher tests still have a formula.
// Do not compile a ceremony against this file.

template Hasher() {
    signal input a;
    signal input b;
    signal output out;

    // STAND-IN HashLeftRight. Replace this body with Poseidon(2) before any
    // ceremony. Same shape as IHasher.hashLeftRight(uint256, uint256).
    out <== a + b + a * b;
}

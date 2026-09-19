pragma circom 2.0.0;

// NOT FOR PROFIT — civic public good, not a commercial product.
//
// HASH_SCHEME: republic.hash.standin-v0
//
// Gated HashLeftRight used by identity.circom / vote.circom / tally.circom.
// Production target is Poseidon(2) (republic.hash.poseidon-bn254-x5-t3-v1).
// That permutation is NOT vendored here. See circuits/HASH_SCHEME.md and
// hasher/poseidon.circom (documentation include; not selected).
//
// This bilinear mix is NOT collision-resistant. hash(x, 0) == x, so an
// all-zero Merkle path is degenerate. Do not run a binding election or a
// trusted setup against this Hasher.

template Hasher() {
    signal input a;
    signal input b;
    signal output out;

    // STAND-IN HashLeftRight. Replace this body with Poseidon(2) before any
    // ceremony. Same shape as IHasher.hashLeftRight(uint256, uint256).
    out <== a + b + a * b;
}

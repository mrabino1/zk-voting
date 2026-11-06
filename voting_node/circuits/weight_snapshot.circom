pragma circom 2.0.0;

// NOT FOR PROFIT — civic public good, not a commercial product.
//
// Membership of one (address, voting power) leaf under a Poseidon snapshot
// root. HashLeftRight is the civic hasher (zk-voting.hash.poseidon-bn254-x5-t3-v1).
// The Merkle rule matches packages/proof-helpers and snapshotTree.mjs.
//
// Public inputs are the root, the address, and the weight. The path is private.
// Publishing the address and the weight means this is not a secret ballot.
// It is the same kind of inclusion argument the civic eligible-set uses, applied
// to delegated token power at one Ethereum block. No Groth16 key is shipped.
// The Node checks the witness with the Poseidon implementation directly.
//
// Depth 16 is SNAPSHOT_DEPTH. Do not mix keccak leaves into this tree.

include "./vote_lib.circom";

template WeightSnapshot(levels) {
    signal input address;
    signal input weight;
    signal input pathElements[levels];
    signal input pathIndices[levels];
    signal input root;

    component leaf = Hasher();
    leaf.a <== address;
    leaf.b <== weight;

    component merkle = MerkleTreeInclusionProof(levels);
    merkle.leaf <== leaf.out;
    for (var i = 0; i < levels; i++) {
        merkle.pathElements[i] <== pathElements[i];
        merkle.pathIndices[i] <== pathIndices[i];
    }

    root === merkle.root;
}

component main {public [root, address, weight]} = WeightSnapshot(16);

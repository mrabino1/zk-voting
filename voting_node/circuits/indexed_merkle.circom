pragma circom 2.1.9;

// Indexed ballot set. One construction for the per-ballot bound root and the
// batch ballot-set root.
//
// A leaf is Poseidon(Poseidon(key, nextKey), cipherHash). The inner hash is
// the (key, nextKey) link. The outer hash binds the ciphertext that leaf
// currently contributes, so a replacement can subtract that ballot.
// Index 0 of an empty tree is the sentinel Poseidon(Poseidon(0, 0), 0).
// Every other leaf is 0. An insert updates the predecessor in place, then
// writes the new leaf into an empty slot. Depth is 20 in production and 4
// in the test main.

include "./vote_lib.circom";

template IndexedLink() {
    signal input key;
    signal input nextKey;
    signal output out;

    component h = Hasher();
    h.a <== key;
    h.b <== nextKey;
    out <== h.out;
}

template CipherHash() {
    signal input c1x;
    signal input c1y;
    signal input c2x;
    signal input c2y;
    signal output out;

    component left = Hasher();
    left.a <== c1x;
    left.b <== c1y;
    component right = Hasher();
    right.a <== c2x;
    right.b <== c2y;
    component h = Hasher();
    h.a <== left.out;
    h.b <== right.out;
    out <== h.out;
}

template ValuedLeaf() {
    signal input key;
    signal input nextKey;
    signal input cipherHash;
    signal output out;

    component link = IndexedLink();
    link.key <== key;
    link.nextKey <== nextKey;
    component h = Hasher();
    h.a <== link.out;
    h.b <== cipherHash;
    out <== h.out;
}

// 1 when low < key and (next == 0 or key < next). A key that is already a
// leaf is a boundary, so the caller cannot treat it as a first ballot.
template KeyInGap() {
    signal input low;
    signal input key;
    signal input next;
    signal output out;

    component lowLt = FieldLessThan();
    lowLt.a <== low;
    lowLt.b <== key;

    component nextIsZero = IsZero();
    nextIsZero.in <== next;
    component keyLt = FieldLessThan();
    keyLt.a <== key;
    keyLt.b <== next;
    signal strict;
    strict <== (1 - nextIsZero.out) * keyLt.out;
    signal highOk;
    highOk <== nextIsZero.out + strict;
    out <== lowLt.out * highOk;
}

// Replace oldLeaf with newLeaf on one path. Sibling ordering matches
// MerkleTreeInclusionProof.
template MerkleUpdate(levels) {
    signal input oldRoot;
    signal input oldLeaf;
    signal input newLeaf;
    signal input pathElements[levels];
    signal input pathIndices[levels];
    signal output newRoot;

    component oldProof = MerkleTreeInclusionProof(levels);
    oldProof.leaf <== oldLeaf;
    component newProof = MerkleTreeInclusionProof(levels);
    newProof.leaf <== newLeaf;
    for (var i = 0; i < levels; i++) {
        oldProof.pathElements[i] <== pathElements[i];
        oldProof.pathIndices[i] <== pathIndices[i];
        newProof.pathElements[i] <== pathElements[i];
        newProof.pathIndices[i] <== pathIndices[i];
    }
    oldProof.root === oldRoot;
    newRoot <== newProof.root;
}

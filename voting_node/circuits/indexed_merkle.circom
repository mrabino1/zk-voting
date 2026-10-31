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

// Ordered ballot digest. ct is CipherHash. The hash is Poseidon(ct(primary), n),
// then Poseidon(acc, ct(option_i)) for each option that n includes.
// n is 0..maxOpts. Unused option slots are forced to zero.
// n = 0 is Poseidon(ct(primary), 0), not ct alone.
template BallotDigest(maxOpts) {
    signal input c1x;
    signal input c1y;
    signal input c2x;
    signal input c2y;
    signal input n;
    signal input optionC1x[maxOpts];
    signal input optionC1y[maxOpts];
    signal input optionC2x[maxOpts];
    signal input optionC2y[maxOpts];
    signal output out;

    component oneHot[maxOpts + 1];
    signal hotSum[maxOpts + 1];
    signal nShift[maxOpts];
    oneHot[0] = IsZero();
    oneHot[0].in <== n;
    hotSum[0] <== oneHot[0].out;
    for (var j = 1; j <= maxOpts; j++) {
        nShift[j - 1] <== n - j;
        oneHot[j] = IsZero();
        oneHot[j].in <== nShift[j - 1];
        hotSum[j] <== hotSum[j - 1] + oneHot[j].out;
    }
    hotSum[maxOpts] === 1;

    component primary = CipherHash();
    primary.c1x <== c1x;
    primary.c1y <== c1y;
    primary.c2x <== c2x;
    primary.c2y <== c2y;
    component head = Hasher();
    head.a <== primary.out;
    head.b <== n;

    signal use[maxOpts];
    component optCt[maxOpts];
    component fold[maxOpts];
    signal acc[maxOpts + 1];
    signal z1x[maxOpts];
    signal z1y[maxOpts];
    signal z2x[maxOpts];
    signal z2y[maxOpts];
    signal take[maxOpts];
    signal keep[maxOpts];
    acc[0] <== head.out;
    for (var k = 0; k < maxOpts; k++) {
        use[k] <== 1 - hotSum[k];
        z1x[k] <== (1 - use[k]) * optionC1x[k];
        z1x[k] === 0;
        z1y[k] <== (1 - use[k]) * optionC1y[k];
        z1y[k] === 0;
        z2x[k] <== (1 - use[k]) * optionC2x[k];
        z2x[k] === 0;
        z2y[k] <== (1 - use[k]) * optionC2y[k];
        z2y[k] === 0;
        optCt[k] = CipherHash();
        optCt[k].c1x <== optionC1x[k];
        optCt[k].c1y <== optionC1y[k];
        optCt[k].c2x <== optionC2x[k];
        optCt[k].c2y <== optionC2y[k];
        fold[k] = Hasher();
        fold[k].a <== acc[k];
        fold[k].b <== optCt[k].out;
        take[k] <== use[k] * fold[k].out;
        keep[k] <== (1 - use[k]) * acc[k];
        acc[k + 1] <== take[k] + keep[k];
    }
    out <== acc[maxOpts];
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

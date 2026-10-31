pragma circom 2.1.9;

// Per-ballot proof. The device holds nullifierSecret. The public ballot hash
// is the ciphertext commitment from CipherHash, the same commitment the inbox
// computes for an EG ballot. The batch circuit never receives the secret: it
// receives voterKey, which this proof binds as Poseidon(nullifierSecret, electionId).
// Depth is 20 in production and 4 in the test main. This file has no main.

include "./indexed_merkle.circom";

template BallotMembership(levels) {
    signal input voterKey;
    signal input isReplacement;
    signal input boundRoot;
    signal input low;
    signal input nextKey;
    signal input predCipher;
    signal input oldCipher;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    signal output uniqueStep;

    signal replSq;
    replSq <== isReplacement * isReplacement;
    replSq === isReplacement;

    // First ballot: the predecessor leaf Valued(low, nextKey, predCipher) is
    // in the tree and voterKey sits strictly in that gap.
    // Replacement: Valued(voterKey, nextKey, oldCipher) is the current leaf.
    component gapLeaf = ValuedLeaf();
    gapLeaf.key <== low;
    gapLeaf.nextKey <== nextKey;
    gapLeaf.cipherHash <== predCipher;

    component memberLeaf = ValuedLeaf();
    memberLeaf.key <== voterKey;
    memberLeaf.nextKey <== nextKey;
    memberLeaf.cipherHash <== oldCipher;

    component gapRange = KeyInGap();
    gapRange.low <== low;
    gapRange.key <== voterKey;
    gapRange.next <== nextKey;

    signal oneMinus;
    oneMinus <== 1 - isReplacement;
    // First ballots must sit in the gap. A replacement proves the member leaf
    // instead, so the range is not required. After insertion the predecessor's
    // nextKey is this voterKey, and a second first ballot cannot find a gap.
    signal rangeGate;
    rangeGate <== oneMinus * (gapRange.out - 1);
    rangeGate === 0;

    component proof = MerkleTreeInclusionProof(levels);
    signal leafFromGap;
    leafFromGap <== oneMinus * gapLeaf.out;
    signal leafFromMember;
    leafFromMember <== isReplacement * memberLeaf.out;
    proof.leaf <== leafFromGap + leafFromMember;
    for (var i = 0; i < levels; i++) {
        proof.pathElements[i] <== pathElements[i];
        proof.pathIndices[i] <== pathIndices[i];
    }
    proof.root === boundRoot;

    uniqueStep <== oneMinus;
}

template PerBallot(levels) {
    signal input nullifierSecret;
    signal input electionId;
    signal input c1x;
    signal input c1y;
    signal input c2x;
    signal input c2y;
    signal input isReplacement;
    signal input boundRoot;
    signal input low;
    signal input nextKey;
    signal input predCipher;
    signal input oldC1x;
    signal input oldC1y;
    signal input oldC2x;
    signal input oldC2y;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    signal input ballotHash;

    // Intermediate. The proof's public signals are only electionId, ballotHash,
    // and boundRoot. These three stay inside the witness.
    signal submissionId;
    signal uniqueStep;
    signal link;

    component voter = Hasher();
    voter.a <== nullifierSecret;
    voter.b <== electionId;

    component cipher = CipherHash();
    cipher.c1x <== c1x;
    cipher.c1y <== c1y;
    cipher.c2x <== c2x;
    cipher.c2y <== c2y;
    cipher.out === ballotHash;

    component oldCipher = CipherHash();
    oldCipher.c1x <== oldC1x;
    oldCipher.c1y <== oldC1y;
    oldCipher.c2x <== oldC2x;
    oldCipher.c2y <== oldC2y;

    // A first ballot has no previous ciphertext.
    signal oldGateX;
    oldGateX <== (1 - isReplacement) * oldC1x;
    oldGateX === 0;
    signal oldGateY;
    oldGateY <== (1 - isReplacement) * oldC1y;
    oldGateY === 0;

    component sid = Hasher();
    sid.a <== voter.out;
    sid.b <== ballotHash;
    submissionId <== sid.out;

    component set = BallotMembership(levels);
    set.voterKey <== voter.out;
    set.isReplacement <== isReplacement;
    set.boundRoot <== boundRoot;
    set.low <== low;
    set.nextKey <== nextKey;
    set.predCipher <== predCipher;
    set.oldCipher <== oldCipher.out;
    for (var i = 0; i < levels; i++) {
        set.pathElements[i] <== pathElements[i];
        set.pathIndices[i] <== pathIndices[i];
    }
    uniqueStep <== set.uniqueStep;

    // link = Poseidon fold of the submission and the ciphertext points.
    // A replacement folds the previous points too, so the batch can subtract them.
    signal words[10];
    words[0] <== submissionId;
    words[1] <== uniqueStep;
    words[2] <== c1x;
    words[3] <== c1y;
    words[4] <== c2x;
    words[5] <== c2y;
    words[6] <== oldC1x;
    words[7] <== oldC1y;
    words[8] <== oldC2x;
    words[9] <== oldC2y;
    component fold[10];
    signal acc[11];
    acc[0] <== 0;
    for (var w = 0; w < 10; w++) {
        fold[w] = Hasher();
        fold[w].a <== acc[w];
        fold[w].b <== words[w];
        acc[w + 1] <== fold[w].out;
    }
    link <== acc[10];
}

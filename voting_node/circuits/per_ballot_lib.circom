pragma circom 2.1.9;

// Per-ballot proof. The device holds nullifierSecret. The public ballot hash
// is the ordered-vector digest, the same commitment the inbox stores for an
// EG ballot. The three public signals are electionId, ballotHash, and boundRoot.
// The batch circuit never receives the secret: it
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
    signal input optionN;
    signal input optionC1x[4];
    signal input optionC1y[4];
    signal input optionC2x[4];
    signal input optionC2y[4];
    signal input oldOptionN;
    signal input oldOptionC1x[4];
    signal input oldOptionC1y[4];
    signal input oldOptionC2x[4];
    signal input oldOptionC2y[4];
    signal input pathElements[levels];
    signal input pathIndices[levels];

    signal input ballotHash;

    // Intermediate. The proof's public signals are only electionId, ballotHash,
    // and boundRoot. submissionId and uniqueStep stay inside the witness.
    signal submissionId;
    signal uniqueStep;

    component voter = Hasher();
    voter.a <== nullifierSecret;
    voter.b <== electionId;

    component cipher = BallotDigest(4);
    cipher.c1x <== c1x;
    cipher.c1y <== c1y;
    cipher.c2x <== c2x;
    cipher.c2y <== c2y;
    cipher.n <== optionN;
    for (var p = 0; p < 4; p++) {
        cipher.optionC1x[p] <== optionC1x[p];
        cipher.optionC1y[p] <== optionC1y[p];
        cipher.optionC2x[p] <== optionC2x[p];
        cipher.optionC2y[p] <== optionC2y[p];
    }
    cipher.out === ballotHash;

    component oldCipher = BallotDigest(4);
    oldCipher.c1x <== oldC1x;
    oldCipher.c1y <== oldC1y;
    oldCipher.c2x <== oldC2x;
    oldCipher.c2y <== oldC2y;
    oldCipher.n <== oldOptionN;
    for (var q = 0; q < 4; q++) {
        oldCipher.optionC1x[q] <== oldOptionC1x[q];
        oldCipher.optionC1y[q] <== oldOptionC1y[q];
        oldCipher.optionC2x[q] <== oldOptionC2x[q];
        oldCipher.optionC2y[q] <== oldOptionC2y[q];
    }

    // A first ballot has no previous ciphertext and no previous options.
    signal oldGateX;
    oldGateX <== (1 - isReplacement) * oldC1x;
    oldGateX === 0;
    signal oldGateY;
    oldGateY <== (1 - isReplacement) * oldC1y;
    oldGateY === 0;
    signal oldCountGate;
    oldCountGate <== (1 - isReplacement) * oldOptionN;
    oldCountGate === 0;

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
}

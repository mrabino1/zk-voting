pragma circom 2.1.9;

// Shared ballot-set membership. The bound root is a Merkle root of voter keys
// Poseidon(nullifierSecret, electionId). A replacement proves membership.
// A first ballot proves a gap. Depth is a template parameter: 20 in production
// mains, 4 in the test main. This file has no main.

include "./vote_lib.circom";

template BallotMembership(levels) {
    signal input voterKey;
    signal input isReplacement;
    signal input boundRoot;
    signal input memberPathElements[levels];
    signal input memberPathIndices[levels];
    signal input gapLow;
    signal input gapNext;
    signal input gapPathElements[levels];
    signal input gapPathIndices[levels];

    signal output uniqueStep;

    signal replSq;
    replSq <== isReplacement * isReplacement;
    replSq === isReplacement;

    component member = MerkleTreeInclusionProof(levels);
    member.leaf <== voterKey;
    for (var i = 0; i < levels; i++) {
        member.pathElements[i] <== memberPathElements[i];
        member.pathIndices[i] <== memberPathIndices[i];
    }

    component chainLeaf = Hasher();
    chainLeaf.a <== gapLow;
    chainLeaf.b <== gapNext;
    component gapProof = MerkleTreeInclusionProof(levels);
    gapProof.leaf <== chainLeaf.out;
    for (var j = 0; j < levels; j++) {
        gapProof.pathElements[j] <== gapPathElements[j];
        gapProof.pathIndices[j] <== gapPathIndices[j];
    }

    component lowLt = FieldLessThan();
    lowLt.a <== gapLow;
    lowLt.b <== voterKey;
    lowLt.out === 1;

    component nextIsZero = IsZero();
    nextIsZero.in <== gapNext;
    component keyLtNext = FieldLessThan();
    keyLtNext.a <== voterKey;
    keyLtNext.b <== gapNext;
    signal notZero;
    notZero <== 1 - nextIsZero.out;
    signal strictGap;
    strictGap <== notZero * keyLtNext.out;
    signal gapOk;
    gapOk <== nextIsZero.out + strictGap;
    gapOk === 1;

    signal fromMember;
    fromMember <== isReplacement * member.root;
    signal oneMinus;
    oneMinus <== 1 - isReplacement;
    signal fromGap;
    fromGap <== oneMinus * gapProof.root;
    signal selected;
    selected <== fromMember + fromGap;
    selected === boundRoot;

    uniqueStep <== oneMinus;
}

// Insert `newLeaf` where the current leaf is 0. Same sibling path for both proofs.
template MerkleInsert(levels) {
    signal input oldRoot;
    signal input newLeaf;
    signal input pathElements[levels];
    signal input pathIndices[levels];
    signal output newRoot;

    component oldProof = MerkleTreeInclusionProof(levels);
    oldProof.leaf <== 0;
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

template PerBallot(levels) {
    signal input nullifierSecret;
    signal input electionId;
    signal input ballotHash;
    signal input isReplacement;
    signal input boundRoot;
    signal input hourlyContribution;
    signal input finalContribution;
    signal input memberPathElements[levels];
    signal input memberPathIndices[levels];
    signal input gapLow;
    signal input gapNext;
    signal input gapPathElements[levels];
    signal input gapPathIndices[levels];

    signal output submissionId;
    signal output uniqueStep;
    signal output link;

    component inner = Hasher();
    inner.a <== nullifierSecret;
    inner.b <== electionId;

    component sid = Hasher();
    sid.a <== inner.out;
    sid.b <== ballotHash;
    submissionId <== sid.out;

    component set = BallotMembership(levels);
    set.voterKey <== inner.out;
    set.isReplacement <== isReplacement;
    set.boundRoot <== boundRoot;
    for (var i = 0; i < levels; i++) {
        set.memberPathElements[i] <== memberPathElements[i];
        set.memberPathIndices[i] <== memberPathIndices[i];
        set.gapPathElements[i] <== gapPathElements[i];
        set.gapPathIndices[i] <== gapPathIndices[i];
    }
    set.gapLow <== gapLow;
    set.gapNext <== gapNext;
    uniqueStep <== set.uniqueStep;

    signal hourlyGate;
    hourlyGate <== isReplacement * hourlyContribution;
    hourlyGate === 0;

    component linkH = Hasher();
    linkH.a <== submissionId;
    linkH.b <== uniqueStep + hourlyContribution + finalContribution;
    link <== linkH.out;
}

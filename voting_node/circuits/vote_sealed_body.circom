pragma circom 2.1.9;

// Sealed vote. Public input 2 is the submission id
// Poseidon(Poseidon(nullifierSecret, electionId), ballotHash).
// The voter id stays private. Public input 5 is the ballot-set Merkle root,
// checked with the same membership statement as per_ballot.
// Production depth is 20. The smoke main is circuits/mains/vote_sealed_smoke.circom.

include "./per_ballot_lib.circom";

template VoteSealed(levels, ballotLevels) {
    signal input identityTrapdoor;
    signal input nullifierSecret;
    signal input pathElements[levels];
    signal input pathIndices[levels];
    signal input disqLow;
    signal input disqNext;
    signal input disqPathElements[levels];
    signal input disqPathIndices[levels];
    signal input choice;
    signal input choiceRandomness;
    signal input isReplacement;
    signal input memberPathElements[ballotLevels];
    signal input memberPathIndices[ballotLevels];
    signal input gapLow;
    signal input gapNext;
    signal input gapPathElements[ballotLevels];
    signal input gapPathIndices[ballotLevels];

    signal input root;
    signal input disqRoot;
    signal input nullifier;
    signal input ballotHash;
    signal input electionId;
    signal input boundRoot;

    component identity = IdentityCommitment();
    identity.identityTrapdoor <== identityTrapdoor;
    identity.nullifierSecret <== nullifierSecret;

    component merkle = MerkleTreeInclusionProof(levels);
    merkle.leaf <== identity.commitment;
    for (var i = 0; i < levels; i++) {
        merkle.pathElements[i] <== pathElements[i];
        merkle.pathIndices[i] <== pathIndices[i];
    }
    merkle.root === root;

    component voterId = Hasher();
    voterId.a <== nullifierSecret;
    voterId.b <== electionId;

    component sealedId = Hasher();
    sealedId.a <== voterId.out;
    sealedId.b <== ballotHash;
    sealedId.out === nullifier;

    component chainLeaf = Hasher();
    chainLeaf.a <== disqLow;
    chainLeaf.b <== disqNext;
    component disqMerkle = MerkleTreeInclusionProof(levels);
    disqMerkle.leaf <== chainLeaf.out;
    for (var j = 0; j < levels; j++) {
        disqMerkle.pathElements[j] <== disqPathElements[j];
        disqMerkle.pathIndices[j] <== disqPathIndices[j];
    }
    disqMerkle.root === disqRoot;

    component lowLtLeaf = FieldLessThan();
    lowLtLeaf.a <== disqLow;
    lowLtLeaf.b <== identity.commitment;
    lowLtLeaf.out === 1;

    component nextIsZero = IsZero();
    nextIsZero.in <== disqNext;
    component leafLtNext = FieldLessThan();
    leafLtNext.a <== identity.commitment;
    leafLtNext.b <== disqNext;
    signal gapHigh;
    gapHigh <== (1 - nextIsZero.out) * leafLtNext.out;
    nextIsZero.out + gapHigh === 1;

    signal choiceDiff[16];
    signal choiceAcc[16];
    choiceDiff[0] <== choice;
    choiceAcc[0] <== choiceDiff[0];
    for (var k = 1; k < 16; k++) {
        choiceDiff[k] <== choice - k;
        choiceAcc[k] <== choiceAcc[k - 1] * choiceDiff[k];
    }
    choiceAcc[15] === 0;

    component ballotTag = Hasher();
    ballotTag.a <== choice;
    ballotTag.b <== choiceRandomness;
    ballotTag.out === ballotHash;

    component set = BallotMembership(ballotLevels);
    set.voterKey <== voterId.out;
    set.isReplacement <== isReplacement;
    set.boundRoot <== boundRoot;
    set.gapLow <== gapLow;
    set.gapNext <== gapNext;
    for (var m = 0; m < ballotLevels; m++) {
        set.memberPathElements[m] <== memberPathElements[m];
        set.memberPathIndices[m] <== memberPathIndices[m];
        set.gapPathElements[m] <== gapPathElements[m];
        set.gapPathIndices[m] <== gapPathIndices[m];
    }
}

// No main. vote_sealed.circom is depth 20. mains/vote_sealed_smoke.circom is depth 4.

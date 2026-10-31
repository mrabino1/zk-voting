pragma circom 2.1.9;

// Sealed vote. Public input 2 is the submission id
// Poseidon(Poseidon(nullifierSecret, electionId), ballotHash).
// The voter id stays private. Public input 5 is the ballot-set Merkle root,
// checked with the same membership statement as per_ballot.
// Production depth is 20. The smoke main is circuits/mains/vote_sealed_smoke.circom.

include "./per_ballot_lib.circom";
include "./one_hot.circom";

template VoteSealed(levels, ballotLevels) {
    signal input identityTrapdoor;
    signal input nullifierSecret;
    signal input pathElements[levels];
    signal input pathIndices[levels];
    signal input disqLow;
    signal input disqNext;
    signal input disqPathElements[levels];
    signal input disqPathIndices[levels];
    signal input c1x;
    signal input c1y;
    signal input c2x;
    signal input c2y;
    signal input isReplacement;
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
    signal input optionR[4];
    signal input optionB[4];
    signal input primaryR;
    signal input primaryB;
    signal input pathElementsBallot[ballotLevels];
    signal input pathIndicesBallot[ballotLevels];

    signal input root;
    signal input disqRoot;
    signal input nullifier;
    signal input ballotHash;
    signal input electionId;
    signal input boundRoot;
    signal input pkX;
    signal input pkY;
    // Copies of the ciphertext, declared last so they sit after the existing
    // public words. Acceptance compares them to the blob. No Poseidon on chain.
    signal input pubC1x;
    signal input pubC1y;
    signal input pubC2x;
    signal input pubC2y;
    signal input pubN;
    signal input pubOptionC1x[4];
    signal input pubOptionC1y[4];
    signal input pubOptionC2x[4];
    signal input pubOptionC2y[4];

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

    // One commitment: the public ballot hash is the ordered ciphertext digest.
    // The same points are Enc(0) or Enc(1) under the public joint key, and a
    // vector of options sums to one. Acceptance passes pkX and pkY as public
    // inputs and checks them against the posted ceremony key.
    component cipher = BallotDigest(4);
    cipher.c1x <== c1x;
    cipher.c1y <== c1y;
    cipher.c2x <== c2x;
    cipher.c2y <== c2y;
    cipher.n <== optionN;
    for (var u = 0; u < 4; u++) {
        cipher.optionC1x[u] <== optionC1x[u];
        cipher.optionC1y[u] <== optionC1y[u];
        cipher.optionC2x[u] <== optionC2x[u];
        cipher.optionC2y[u] <== optionC2y[u];
    }
    cipher.out === ballotHash;

    component oneHot = OneHotVector();
    oneHot.pkx <== pkX;
    oneHot.pky <== pkY;
    oneHot.c1x <== c1x;
    oneHot.c1y <== c1y;
    oneHot.c2x <== c2x;
    oneHot.c2y <== c2y;
    oneHot.n <== optionN;
    oneHot.primaryR <== primaryR;
    oneHot.primaryB <== primaryB;
    for (var t = 0; t < 4; t++) {
        oneHot.optionC1x[t] <== optionC1x[t];
        oneHot.optionC1y[t] <== optionC1y[t];
        oneHot.optionC2x[t] <== optionC2x[t];
        oneHot.optionC2y[t] <== optionC2y[t];
        oneHot.optionR[t] <== optionR[t];
        oneHot.optionB[t] <== optionB[t];
    }

    pubC1x === c1x;
    pubC1y === c1y;
    pubC2x === c2x;
    pubC2y === c2y;
    pubN === optionN;
    for (var w = 0; w < 4; w++) {
        pubOptionC1x[w] === optionC1x[w];
        pubOptionC1y[w] === optionC1y[w];
        pubOptionC2x[w] === optionC2x[w];
        pubOptionC2y[w] === optionC2y[w];
    }

    component oldCipher = BallotDigest(4);
    oldCipher.c1x <== oldC1x;
    oldCipher.c1y <== oldC1y;
    oldCipher.c2x <== oldC2x;
    oldCipher.c2y <== oldC2y;
    oldCipher.n <== oldOptionN;
    for (var v = 0; v < 4; v++) {
        oldCipher.optionC1x[v] <== oldOptionC1x[v];
        oldCipher.optionC1y[v] <== oldOptionC1y[v];
        oldCipher.optionC2x[v] <== oldOptionC2x[v];
        oldCipher.optionC2y[v] <== oldOptionC2y[v];
    }
    signal oldGate;
    oldGate <== (1 - isReplacement) * oldC1x;
    oldGate === 0;
    signal oldCountGate;
    oldCountGate <== (1 - isReplacement) * oldOptionN;
    oldCountGate === 0;

    component set = BallotMembership(ballotLevels);
    set.voterKey <== voterId.out;
    set.isReplacement <== isReplacement;
    set.boundRoot <== boundRoot;
    set.low <== low;
    set.nextKey <== nextKey;
    set.predCipher <== predCipher;
    set.oldCipher <== oldCipher.out;
    for (var m = 0; m < ballotLevels; m++) {
        set.pathElements[m] <== pathElementsBallot[m];
        set.pathIndices[m] <== pathIndicesBallot[m];
    }
}

// No main. vote_sealed.circom is depth 20. mains/vote_sealed_smoke.circom is depth 4.

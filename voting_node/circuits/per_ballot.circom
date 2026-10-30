pragma circom 2.1.9;

// Per-ballot proof. The bound root is a public input of this circuit.
// It is not one of the vote circuit's five public inputs.
// isReplacement is not a free bit. It selects a membership proof or a
// non-membership proof of the voter id Poseidon(nullifierSecret, electionId)
// against boundRoot. A stale root fails one of those two checks, so the
// device re-proves against the new root as a first ballot or a replacement
// according to the set at that root.
// Depth is 4 in this main. A production ballot set uses the election tree depth.
// Local Groth16 keys are untrusted until a published ceremony.

include "./vote_lib.circom";

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

    signal replSq;
    replSq <== isReplacement * isReplacement;
    replSq === isReplacement;

    component inner = Hasher();
    inner.a <== nullifierSecret;
    inner.b <== electionId;
    signal voterKey;
    voterKey <== inner.out;

    // Sealed submission id. The vote circuit's public word stays the inner hash.
    component sid = Hasher();
    sid.a <== voterKey;
    sid.b <== ballotHash;
    submissionId <== sid.out;

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
    signal hourlyGate;
    hourlyGate <== isReplacement * hourlyContribution;
    hourlyGate === 0;

    // Keep the final contribution in the constraint system.
    signal bind;
    bind <== finalContribution + uniqueStep + submissionId;
}

component main {public [electionId, ballotHash, boundRoot, hourlyContribution, finalContribution]} = PerBallot(4);

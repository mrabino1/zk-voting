pragma circom 2.1.9;

// Hourly, final, and supplementary batch.
// Public inputs match RollupSettlement.batchPublicInputs:
//   prevStateRoot, newStateRoot, dataHash, batchIndex, each reduced mod r.
// The ballot-set root is a Merkle root of voter keys, the same construction as
// per_ballot's boundRoot. First ballots are inserted. Replacements add nothing
// to the products. secret[i] is Poseidon(nullifierSecret, electionId), not a
// free input. pointTag and tagHash are Poseidon folds.
// This file has no main.

include "./per_ballot_lib.circom";

template BatchTransition(n, levels) {
    signal input prevStateRoot;
    signal input newStateRoot;
    signal input dataHash;
    signal input batchIndex;

    signal input kind;
    signal input electionId;
    signal input previousUnique;
    signal input nextUnique;
    signal input previousHourly;
    signal input nextHourly;
    signal input previousFinal;
    signal input nextFinal;
    signal input ballotSetRoot;
    signal input chainHash;
    signal input tagHash;
    signal input boundRootHash;
    signal input pointTag;
    signal input boundRoot;
    signal input active[n];
    signal input isFirst[n];
    signal input nullifierSecret[n];
    signal input hourlyContrib[n];
    signal input finalContrib[n];
    signal input memberPathElements[n][levels];
    signal input memberPathIndices[n][levels];
    signal input gapLow[n];
    signal input gapNext[n];
    signal input gapPathElements[n][levels];
    signal input gapPathIndices[n][levels];
    signal input insertPathElements[n][levels];
    signal input insertPathIndices[n][levels];
    signal input prevC1X;
    signal input prevC1Y;
    signal input prevC2X;
    signal input prevC2Y;
    signal input nextC1X;
    signal input nextC1Y;
    signal input nextC2X;
    signal input nextC2Y;

    signal activeSq[n];
    signal firstSq[n];
    signal firstContrib[n];
    signal inactiveFirst[n];
    signal stepAcc[n + 1];
    stepAcc[0] <== 0;
    signal hourlyAcc[n + 1];
    hourlyAcc[0] <== previousHourly;
    signal finalAcc[n + 1];
    finalAcc[0] <== previousFinal;
    signal secret[n];
    component voter[n];
    component member[n];
    component chainLeaf[n];
    component gapProof[n];
    component lowLt[n];
    component nextZero[n];
    component keyLt[n];
    signal notZero[n];
    signal strictGap[n];
    signal gapOk[n];
    signal fromMember[n];
    signal fromGap[n];
    signal selected[n];
    signal boundDelta[n];
    signal lowGate[n];
    signal gapGate[n];
    signal replHour[n];
    signal hourTerm[n];
    signal finalTerm[n];
    component oldProof[n];
    component newProof[n];
    signal insertDelta[n];
    signal insertedRoot[n];
    signal keptRoot[n];
    signal running[n + 1];
    running[0] <== boundRoot;
    component tagOf[n];
    component tagFold[n];
    signal tagAcc[n + 1];
    tagAcc[0] <== 0;
    signal tagNext[n];
    signal tagTake[n];
    signal tagKeep[n];

    for (var i = 0; i < n; i++) {
        activeSq[i] <== active[i] * active[i];
        activeSq[i] === active[i];
        firstSq[i] <== isFirst[i] * isFirst[i];
        firstSq[i] === isFirst[i];
        inactiveFirst[i] <== (1 - active[i]) * isFirst[i];
        inactiveFirst[i] === 0;
        firstContrib[i] <== active[i] * isFirst[i];
        stepAcc[i + 1] <== stepAcc[i] + firstContrib[i];

        voter[i] = Hasher();
        voter[i].a <== nullifierSecret[i];
        voter[i].b <== electionId;
        secret[i] <== voter[i].out;

        member[i] = MerkleTreeInclusionProof(levels);
        member[i].leaf <== secret[i];
        chainLeaf[i] = Hasher();
        chainLeaf[i].a <== gapLow[i];
        chainLeaf[i].b <== gapNext[i];
        gapProof[i] = MerkleTreeInclusionProof(levels);
        gapProof[i].leaf <== chainLeaf[i].out;
        for (var d = 0; d < levels; d++) {
            member[i].pathElements[d] <== memberPathElements[i][d];
            member[i].pathIndices[d] <== memberPathIndices[i][d];
            gapProof[i].pathElements[d] <== gapPathElements[i][d];
            gapProof[i].pathIndices[d] <== gapPathIndices[i][d];
        }

        lowLt[i] = FieldLessThan();
        lowLt[i].a <== gapLow[i];
        lowLt[i].b <== secret[i];
        nextZero[i] = IsZero();
        nextZero[i].in <== gapNext[i];
        keyLt[i] = FieldLessThan();
        keyLt[i].a <== secret[i];
        keyLt[i].b <== gapNext[i];
        notZero[i] <== 1 - nextZero[i].out;
        strictGap[i] <== notZero[i] * keyLt[i].out;
        gapOk[i] <== nextZero[i].out + strictGap[i];
        lowGate[i] <== firstContrib[i] * (lowLt[i].out - 1);
        lowGate[i] === 0;
        gapGate[i] <== firstContrib[i] * (gapOk[i] - 1);
        gapGate[i] === 0;

        fromMember[i] <== (1 - isFirst[i]) * member[i].root;
        fromGap[i] <== isFirst[i] * gapProof[i].root;
        selected[i] <== fromMember[i] + fromGap[i];
        boundDelta[i] <== active[i] * (selected[i] - boundRoot);
        boundDelta[i] === 0;

        replHour[i] <== (1 - isFirst[i]) * hourlyContrib[i];
        replHour[i] === 0;
        hourTerm[i] <== firstContrib[i] * hourlyContrib[i];
        finalTerm[i] <== firstContrib[i] * finalContrib[i];
        hourlyAcc[i + 1] <== hourlyAcc[i] + hourTerm[i];
        finalAcc[i + 1] <== finalAcc[i] + finalTerm[i];

        oldProof[i] = MerkleTreeInclusionProof(levels);
        oldProof[i].leaf <== 0;
        newProof[i] = MerkleTreeInclusionProof(levels);
        newProof[i].leaf <== secret[i];
        for (var e = 0; e < levels; e++) {
            oldProof[i].pathElements[e] <== insertPathElements[i][e];
            oldProof[i].pathIndices[e] <== insertPathIndices[i][e];
            newProof[i].pathElements[e] <== insertPathElements[i][e];
            newProof[i].pathIndices[e] <== insertPathIndices[i][e];
        }
        insertDelta[i] <== firstContrib[i] * (oldProof[i].root - running[i]);
        insertDelta[i] === 0;
        insertedRoot[i] <== firstContrib[i] * newProof[i].root;
        keptRoot[i] <== (1 - firstContrib[i]) * running[i];
        running[i + 1] <== insertedRoot[i] + keptRoot[i];

        tagOf[i] = Hasher();
        tagOf[i].a <== secret[i];
        tagOf[i].b <== electionId;
        tagFold[i] = Hasher();
        tagFold[i].a <== tagAcc[i];
        tagFold[i].b <== tagOf[i].out;
        tagTake[i] <== firstContrib[i] * tagFold[i].out;
        tagKeep[i] <== (1 - firstContrib[i]) * tagAcc[i];
        tagNext[i] <== tagTake[i] + tagKeep[i];
        tagAcc[i + 1] <== tagNext[i];
    }

    signal step;
    step <== nextUnique - previousUnique;
    step === stepAcc[n];
    hourlyAcc[n] === nextHourly;
    finalAcc[n] === nextFinal;
    running[n] === ballotSetRoot;
    tagAcc[n] === tagHash;

    component kindIsFinal = IsZero();
    kindIsFinal.in <== kind - 2;
    signal finalGate;
    finalGate <== kindIsFinal.out * step;
    finalGate === 0;

    var pairs = n * (n - 1) / 2;
    component diffZero[pairs];
    signal pairActive[pairs];
    signal pairFirstA[pairs];
    signal bothFirst[pairs];
    signal clash[pairs];
    var p = 0;
    for (var a = 0; a < n; a++) {
        for (var b = a + 1; b < n; b++) {
            diffZero[p] = IsZero();
            diffZero[p].in <== secret[a] - secret[b];
            pairActive[p] <== active[a] * active[b];
            pairFirstA[p] <== pairActive[p] * isFirst[a];
            bothFirst[p] <== pairFirstA[p] * isFirst[b];
            clash[p] <== bothFirst[p] * diffZero[p].out;
            clash[p] === 0;
            p++;
        }
    }

    component boundFold = Hasher();
    boundFold.a <== 0;
    boundFold.b <== boundRoot;
    boundFold.out === boundRootHash;

    signal coords[8];
    coords[0] <== prevC1X;
    coords[1] <== prevC1Y;
    coords[2] <== prevC2X;
    coords[3] <== prevC2Y;
    coords[4] <== nextC1X;
    coords[5] <== nextC1Y;
    coords[6] <== nextC2X;
    coords[7] <== nextC2Y;
    component pointFold[8];
    signal pointAcc[9];
    pointAcc[0] <== 0;
    for (var c = 0; c < 8; c++) {
        pointFold[c] = Hasher();
        pointFold[c].a <== pointAcc[c];
        pointFold[c].b <== coords[c];
        pointAcc[c + 1] <== pointFold[c].out;
    }
    pointAcc[8] === pointTag;

    signal words[16];
    words[0] <== kind;
    words[1] <== electionId;
    words[2] <== batchIndex;
    words[3] <== prevStateRoot;
    words[4] <== newStateRoot;
    words[5] <== ballotSetRoot;
    words[6] <== previousHourly;
    words[7] <== nextHourly;
    words[8] <== previousFinal;
    words[9] <== nextFinal;
    words[10] <== previousUnique;
    words[11] <== nextUnique;
    words[12] <== chainHash;
    words[13] <== tagHash;
    words[14] <== boundRootHash;
    words[15] <== pointTag;

    component hasher[16];
    signal hashAcc[17];
    hashAcc[0] <== 0;
    for (var w = 0; w < 16; w++) {
        hasher[w] = Hasher();
        hasher[w].a <== hashAcc[w];
        hasher[w].b <== words[w];
        hashAcc[w + 1] <== hasher[w].out;
    }
    hashAcc[16] === dataHash;
}

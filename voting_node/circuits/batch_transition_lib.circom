pragma circom 2.1.9;

// Hourly, final, and supplementary batch.
// Public inputs match RollupSettlement.batchPublicInputs:
//   prevStateRoot, newStateRoot, dataHash, batchIndex, each reduced mod r.
// The ballot set is the indexed tree in indexed_merkle.circom. The witness
// carries the voter key bound by the per-ballot proof, never the secret.
// A first ballot updates its predecessor and inserts Valued(key, next, cipher).
// A re-vote updates that leaf from the old ciphertext to the new one and adds
// nothing to the hourly product. chainHash is the fold of per-ballot links.
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
    signal input boundList[4];
    signal input boundLen;
    signal input active[n];
    signal input isFirst[n];
    signal input voterKey[n];
    signal input submissionId[n];
    signal input ballotHash[n];
    signal input c1x[n];
    signal input c1y[n];
    signal input c2x[n];
    signal input c2y[n];
    signal input oldC1x[n];
    signal input oldC1y[n];
    signal input oldC2x[n];
    signal input oldC2y[n];
    signal input predKey[n];
    signal input predNext[n];
    signal input predCipher[n];
    signal input predOldRoot[n];
    signal input emptyOldRoot[n];
    signal input replOldRoot[n];
    signal input predPathElements[n][levels];
    signal input predPathIndices[n][levels];
    signal input emptyPathElements[n][levels];
    signal input emptyPathIndices[n][levels];
    signal input replPathElements[n][levels];
    signal input replPathIndices[n][levels];
    signal input forcedId[n];
    signal input prevC1X;
    signal input prevC1Y;
    signal input prevC2X;
    signal input prevC2Y;
    signal input nextC1X;
    signal input nextC1Y;
    signal input nextC2X;
    signal input nextC2Y;
    // Option totals are not circuit inputs. The settlement sums each ballot's
    // option ciphertexts on chain. pointTag is only the eight running coordinates.

    signal activeSq[n];
    signal firstSq[n];
    signal firstContrib[n];
    signal useReplace[n];
    signal inactiveFirst[n];
    signal stepAcc[n + 1];
    stepAcc[0] <== 0;
    component cipherOf[n];
    component oldOf[n];
    component sidOf[n];
    signal sidGate[n];
    signal hashGate[n];
    signal oldZeroX[n];
    signal oldZeroY[n];
    component gapOf[n];
    signal gapGate[n];
    component oldPredLeaf[n];
    component newPredLeaf[n];
    component newLeaf[n];
    component oldMember[n];
    component newMember[n];
    component predUp[n];
    component emptyUp[n];
    component replUp[n];
    signal predGate[n];
    signal emptyGate[n];
    signal replGate[n];
    signal inserted[n];
    signal replaced[n];
    signal stayed[n];
    signal running[n + 1];
    running[0] <== boundRoot;
    signal linkWord[n][10];
    component tagOf[n];
    component tagFold[n];
    signal tagTake[n];
    signal tagKeep[n];
    signal tagNext[n];
    signal tagAcc[n + 1];
    tagAcc[0] <== 0;
    component idFold[n];
    signal idTake[n];
    signal idKeep[n];
    signal idNext[n];
    signal idAcc[n + 1];
    idAcc[0] <== 0;

    for (var i = 0; i < n; i++) {
        activeSq[i] <== active[i] * active[i];
        activeSq[i] === active[i];
        firstSq[i] <== isFirst[i] * isFirst[i];
        firstSq[i] === isFirst[i];
        inactiveFirst[i] <== (1 - active[i]) * isFirst[i];
        inactiveFirst[i] === 0;
        firstContrib[i] <== active[i] * isFirst[i];
        useReplace[i] <== active[i] * (1 - isFirst[i]);
        stepAcc[i + 1] <== stepAcc[i] + firstContrib[i];

        cipherOf[i] = CipherHash();
        cipherOf[i].c1x <== c1x[i];
        cipherOf[i].c1y <== c1y[i];
        cipherOf[i].c2x <== c2x[i];
        cipherOf[i].c2y <== c2y[i];
        hashGate[i] <== active[i] * (cipherOf[i].out - ballotHash[i]);
        hashGate[i] === 0;

        oldOf[i] = CipherHash();
        oldOf[i].c1x <== oldC1x[i];
        oldOf[i].c1y <== oldC1y[i];
        oldOf[i].c2x <== oldC2x[i];
        oldOf[i].c2y <== oldC2y[i];
        oldZeroX[i] <== firstContrib[i] * oldC1x[i];
        oldZeroX[i] === 0;
        oldZeroY[i] <== firstContrib[i] * oldC1y[i];
        oldZeroY[i] === 0;

        // Leaf key is voterKey. An active row's submission id is Poseidon(voterKey, ballotHash),
        // the id the inbox accepted for this ciphertext. A different key cannot open that leaf.
        sidOf[i] = Hasher();
        sidOf[i].a <== voterKey[i];
        sidOf[i].b <== ballotHash[i];
        sidGate[i] <== active[i] * (sidOf[i].out - submissionId[i]);
        sidGate[i] === 0;

        gapOf[i] = KeyInGap();
        gapOf[i].low <== predKey[i];
        gapOf[i].key <== voterKey[i];
        gapOf[i].next <== predNext[i];
        gapGate[i] <== firstContrib[i] * (gapOf[i].out - 1);
        gapGate[i] === 0;

        oldPredLeaf[i] = ValuedLeaf();
        oldPredLeaf[i].key <== predKey[i];
        oldPredLeaf[i].nextKey <== predNext[i];
        oldPredLeaf[i].cipherHash <== predCipher[i];
        newPredLeaf[i] = ValuedLeaf();
        newPredLeaf[i].key <== predKey[i];
        newPredLeaf[i].nextKey <== voterKey[i];
        newPredLeaf[i].cipherHash <== predCipher[i];
        newLeaf[i] = ValuedLeaf();
        newLeaf[i].key <== voterKey[i];
        newLeaf[i].nextKey <== predNext[i];
        newLeaf[i].cipherHash <== cipherOf[i].out;

        predUp[i] = MerkleUpdate(levels);
        predUp[i].oldRoot <== predOldRoot[i];
        predUp[i].oldLeaf <== oldPredLeaf[i].out;
        predUp[i].newLeaf <== newPredLeaf[i].out;
        emptyUp[i] = MerkleUpdate(levels);
        emptyUp[i].oldRoot <== emptyOldRoot[i];
        emptyUp[i].oldLeaf <== 0;
        emptyUp[i].newLeaf <== newLeaf[i].out;
        for (var d = 0; d < levels; d++) {
            predUp[i].pathElements[d] <== predPathElements[i][d];
            predUp[i].pathIndices[d] <== predPathIndices[i][d];
            emptyUp[i].pathElements[d] <== emptyPathElements[i][d];
            emptyUp[i].pathIndices[d] <== emptyPathIndices[i][d];
        }
        predGate[i] <== firstContrib[i] * (predOldRoot[i] - running[i]);
        predGate[i] === 0;
        emptyGate[i] <== firstContrib[i] * (emptyOldRoot[i] - predUp[i].newRoot);
        emptyGate[i] === 0;

        oldMember[i] = ValuedLeaf();
        oldMember[i].key <== voterKey[i];
        oldMember[i].nextKey <== predNext[i];
        oldMember[i].cipherHash <== oldOf[i].out;
        newMember[i] = ValuedLeaf();
        newMember[i].key <== voterKey[i];
        newMember[i].nextKey <== predNext[i];
        newMember[i].cipherHash <== cipherOf[i].out;
        replUp[i] = MerkleUpdate(levels);
        replUp[i].oldRoot <== replOldRoot[i];
        replUp[i].oldLeaf <== oldMember[i].out;
        replUp[i].newLeaf <== newMember[i].out;
        for (var e = 0; e < levels; e++) {
            replUp[i].pathElements[e] <== replPathElements[i][e];
            replUp[i].pathIndices[e] <== replPathIndices[i][e];
        }
        replGate[i] <== useReplace[i] * (replOldRoot[i] - running[i]);
        replGate[i] === 0;

        inserted[i] <== firstContrib[i] * emptyUp[i].newRoot;
        replaced[i] <== useReplace[i] * replUp[i].newRoot;
        stayed[i] <== (1 - active[i]) * running[i];
        running[i + 1] <== inserted[i] + replaced[i] + stayed[i];

        linkWord[i][0] <== submissionId[i];
        linkWord[i][1] <== isFirst[i];
        linkWord[i][2] <== c1x[i];
        linkWord[i][3] <== c1y[i];
        linkWord[i][4] <== c2x[i];
        linkWord[i][5] <== c2y[i];
        linkWord[i][6] <== oldC1x[i];
        linkWord[i][7] <== oldC1y[i];
        linkWord[i][8] <== oldC2x[i];
        linkWord[i][9] <== oldC2y[i];
    }

    // The link fold is done outside the ballot loop. Circom rejects assigning
    // the same component twice, so each ballot gets its own fold components.
    component lf0[10];
    component lf1[10];
    component lf2[10];
    component lf3[10];
    signal la0[11];
    signal la1[11];
    signal la2[11];
    signal la3[11];
    la0[0] <== 0;
    la1[0] <== 0;
    la2[0] <== 0;
    la3[0] <== 0;
    for (var w0 = 0; w0 < 10; w0++) {
        lf0[w0] = Hasher();
        lf0[w0].a <== la0[w0];
        lf0[w0].b <== linkWord[0][w0];
        la0[w0 + 1] <== lf0[w0].out;
        lf1[w0] = Hasher();
        lf1[w0].a <== la1[w0];
        lf1[w0].b <== linkWord[1][w0];
        la1[w0 + 1] <== lf1[w0].out;
        lf2[w0] = Hasher();
        lf2[w0].a <== la2[w0];
        lf2[w0].b <== linkWord[2][w0];
        la2[w0 + 1] <== lf2[w0].out;
        lf3[w0] = Hasher();
        lf3[w0].a <== la3[w0];
        lf3[w0].b <== linkWord[3][w0];
        la3[w0 + 1] <== lf3[w0].out;
    }
    signal linkOut[4];
    linkOut[0] <== la0[10];
    linkOut[1] <== la1[10];
    linkOut[2] <== la2[10];
    linkOut[3] <== la3[10];

    component chainH[4];
    signal chainAcc[5];
    chainAcc[0] <== 0;
    signal chainTake[4];
    signal chainKeep[4];
    for (var c = 0; c < 4; c++) {
        chainH[c] = Hasher();
        chainH[c].a <== chainAcc[c];
        chainH[c].b <== linkOut[c];
        chainTake[c] <== active[c] * chainH[c].out;
        chainKeep[c] <== (1 - active[c]) * chainAcc[c];
        chainAcc[c + 1] <== chainTake[c] + chainKeep[c];
    }
    chainAcc[4] === chainHash;

    for (var t = 0; t < n; t++) {
        tagOf[t] = Hasher();
        tagOf[t].a <== voterKey[t];
        tagOf[t].b <== electionId;
        tagFold[t] = Hasher();
        tagFold[t].a <== tagAcc[t];
        tagFold[t].b <== tagOf[t].out;
        tagTake[t] <== firstContrib[t] * tagFold[t].out;
        tagKeep[t] <== (1 - firstContrib[t]) * tagAcc[t];
        tagNext[t] <== tagTake[t] + tagKeep[t];
        tagAcc[t + 1] <== tagNext[t];

        idFold[t] = Hasher();
        idFold[t].a <== idAcc[t];
        idFold[t].b <== forcedId[t];
        idTake[t] <== active[t] * idFold[t].out;
        idKeep[t] <== (1 - active[t]) * idAcc[t];
        idNext[t] <== idTake[t] + idKeep[t];
        idAcc[t + 1] <== idNext[t];
    }

    signal step;
    step <== nextUnique - previousUnique;
    step === stepAcc[n];
    running[n] === ballotSetRoot;

    component kindIsFinal = IsZero();
    kindIsFinal.in <== kind - 2;
    signal finalGate;
    finalGate <== kindIsFinal.out * step;
    finalGate === 0;

    component kindIsSupp = IsZero();
    kindIsSupp.in <== kind - 3;
    signal tagFromKeys;
    tagFromKeys <== (1 - kindIsSupp.out) * tagAcc[n];
    signal tagFromIds;
    tagFromIds <== kindIsSupp.out * idAcc[n];
    tagHash === tagFromKeys + tagFromIds;

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
            diffZero[p].in <== voterKey[a] - voterKey[b];
            pairActive[p] <== active[a] * active[b];
            pairFirstA[p] <== pairActive[p] * isFirst[a];
            bothFirst[p] <== pairFirstA[p] * isFirst[b];
            clash[p] <== bothFirst[p] * diffZero[p].out;
            clash[p] === 0;
            p++;
        }
    }

    // Fold every bound root the batch names. boundLen is 1..4.
    // Unused tail entries are not hashed. boundList[0] is the tree we edit.
    signal d1;
    d1 <== boundLen - 1;
    signal p12;
    p12 <== d1 * (boundLen - 2);
    signal p123;
    p123 <== p12 * (boundLen - 3);
    signal lenOk;
    lenOk <== p123 * (boundLen - 4);
    lenOk === 0;
    signal startGate;
    startGate <== boundList[0] - boundRoot;
    startGate === 0;
    component len1 = IsZero();
    len1.in <== boundLen - 1;
    component len3 = IsZero();
    len3.in <== boundLen - 3;
    component len4 = IsZero();
    len4.in <== boundLen - 4;
    signal useRoot[4];
    useRoot[0] <== 1;
    useRoot[1] <== 1 - len1.out;
    useRoot[2] <== len3.out + len4.out;
    useRoot[3] <== len4.out;
    component bFold[4];
    signal bAcc[5];
    signal bTake[4];
    signal bKeep[4];
    bAcc[0] <== 0;
    for (var r = 0; r < 4; r++) {
        bFold[r] = Hasher();
        bFold[r].a <== bAcc[r];
        bFold[r].b <== boundList[r];
        bTake[r] <== useRoot[r] * bFold[r].out;
        bKeep[r] <== (1 - useRoot[r]) * bAcc[r];
        bAcc[r + 1] <== bTake[r] + bKeep[r];
    }
    bAcc[4] === boundRootHash;

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
    for (var q = 0; q < 8; q++) {
        pointFold[q] = Hasher();
        pointFold[q].a <== pointAcc[q];
        pointFold[q].b <== coords[q];
        pointAcc[q + 1] <== pointFold[q].out;
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
    for (var u = 0; u < 16; u++) {
        hasher[u] = Hasher();
        hasher[u].a <== hashAcc[u];
        hasher[u].b <== words[u];
        hashAcc[u + 1] <== hasher[u].out;
    }
    hashAcc[16] === dataHash;
}

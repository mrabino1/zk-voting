pragma circom 2.1.9;

// Hourly, final, and supplementary batch.
// Public inputs match RollupSettlement.batchPublicInputs, in this order:
//   prevStateRoot, newStateRoot, dataHash, batchIndex, each reduced mod r.
// The other sealed words are private and are folded into dataHash with the
// same Poseidon chain as RollupSettlement.computeSealedDataHash.
// Kind 2 is the final batch and its unique-count step is zero.
// nextUnique - previousUnique equals the number of active first ballots.
// Duplicate first-ballot secrets in one batch are unsatisfiable.
// The ballot-set root is the Poseidon fold of (active, isFirst, secret).
// Local Groth16 keys are untrusted until a published ceremony.

include "./identity.circom";

template IsZero() {
    signal input in;
    signal output out;
    signal inv;
    inv <-- in == 0 ? 0 : 1 / in;
    out <== 1 - in * inv;
    in * out === 0;
}

template BatchTransition(n) {
    // Declaration order of these four is the Groth16 public instance.
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
    signal input active[n];
    signal input isFirst[n];
    signal input secret[n];

    signal activeSq[n];
    signal firstSq[n];
    signal firstContrib[n];
    signal stepAcc[n + 1];
    stepAcc[0] <== 0;
    for (var i = 0; i < n; i++) {
        activeSq[i] <== active[i] * active[i];
        activeSq[i] === active[i];
        firstSq[i] <== isFirst[i] * isFirst[i];
        firstSq[i] === isFirst[i];
        firstContrib[i] <== active[i] * isFirst[i];
        stepAcc[i + 1] <== stepAcc[i] + firstContrib[i];
    }
    signal step;
    step <== nextUnique - previousUnique;
    step === stepAcc[n];

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

    // ballotSetRoot binds every secret. An inactive slot contributes a zero leaf.
    component leafA[n];
    component leafB[n];
    signal leaf[n];
    component fold[n];
    signal rootAcc[n + 1];
    rootAcc[0] <== 0;
    for (var s = 0; s < n; s++) {
        leafA[s] = Hasher();
        leafA[s].a <== active[s];
        leafA[s].b <== isFirst[s];
        leafB[s] = Hasher();
        leafB[s].a <== leafA[s].out;
        leafB[s].b <== secret[s];
        leaf[s] <== active[s] * leafB[s].out;
        fold[s] = Hasher();
        fold[s].a <== rootAcc[s];
        fold[s].b <== leaf[s];
        rootAcc[s + 1] <== fold[s].out;
    }
    rootAcc[n] === ballotSetRoot;

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

component main {public [prevStateRoot, newStateRoot, dataHash, batchIndex]} = BatchTransition(4);

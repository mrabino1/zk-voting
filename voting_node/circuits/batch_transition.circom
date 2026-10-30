pragma circom 2.0.0;

// Whole-hour batch. Kind 2 is the final batch and carries no turnout step.
// Duplicate first ballots from the same secret are unsatisfiable.
// Local Groth16 keys are untrusted until a published ceremony.

template IsZero() {
    signal input in;
    signal output out;
    signal inv;
    inv <-- in == 0 ? 0 : 1 / in;
    out <== 1 - in * inv;
    in * out === 0;
}

template BatchTransition(n) {
    signal input kind;
    signal input previousUnique;
    signal input nextUnique;
    signal input previousHourly;
    signal input nextHourly;
    signal input previousFinal;
    signal input nextFinal;
    signal input ballotSetRoot;
    signal input active[n];
    signal input isFirst[n];
    signal input secret[n];

    component kindIsFinal = IsZero();
    kindIsFinal.in <== kind - 2;
    signal step;
    step <== nextUnique - previousUnique;
    // Final batch: the unique-count step is zero. The supplementary batch publishes it.
    signal finalGate;
    finalGate <== kindIsFinal.out * step;
    finalGate === 0;

    signal seen[n];
    for (var i = 0; i < n; i++) {
        signal activeSq;
        activeSq <== active[i] * active[i];
        activeSq === active[i];
        signal firstSq;
        firstSq <== isFirst[i] * isFirst[i];
        firstSq === isFirst[i];
        seen[i] <== active[i];
    }

    for (var i = 0; i < n; i++) {
        for (var j = i + 1; j < n; j++) {
            component diffZero = IsZero();
            diffZero.in <== secret[i] - secret[j];
            signal bothFirst;
            bothFirst <== active[i] * active[j] * isFirst[i] * isFirst[j];
            signal clash;
            clash <== bothFirst * diffZero.out;
            clash === 0;
        }
    }

    signal bind;
    bind <== ballotSetRoot + previousHourly + nextHourly + previousFinal + nextFinal + previousUnique + seen[0];
}

component main {public [kind, previousUnique, nextUnique, previousHourly, nextHourly, previousFinal, nextFinal, ballotSetRoot]} = BatchTransition(4);

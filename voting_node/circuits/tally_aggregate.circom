pragma circom 2.0.0;

// Binds the version-2 tally instance. The witness share stays private.
// It is not the joint scalar and it is not a per-ballot opening.
// This file does not check decryption. Tally.submitDecryption does:
// Chaum-Pedersen on each partial, then M = c2 - sum(lambda_i * d_i)
// for k stored partials. The share is not an output of this circuit.
// Local Groth16 keys are untrusted until a published ceremony.

template IsZero() {
    signal input in;
    signal output out;
    signal inv;
    inv <-- in == 0 ? 0 : 1 / in;
    out <== 1 - in * inv;
    in * out === 0;
}

template TallyAggregateBind() {
    signal input version;
    signal input electionId;
    signal input acceptedCount;
    signal input countsHash;
    signal input ballotRoot;
    signal input aggregateHash;
    signal input tallyKeyHash;
    signal input witnessShare;

    component sharePresent = IsZero();
    sharePresent.in <== witnessShare;
    sharePresent.out === 0;

    version === 2;

    signal bind;
    bind <== electionId + acceptedCount + countsHash + ballotRoot + aggregateHash + tallyKeyHash;
}

component main {public [version, electionId, acceptedCount, countsHash, ballotRoot, aggregateHash, tallyKeyHash]} = TallyAggregateBind();

pragma circom 2.0.0;

// Per-ballot proof. The bound root is a public input of this circuit.
// It is not one of the vote circuit's five public inputs.
// Local Groth16 keys are untrusted until a published ceremony.

include "./identity.circom";

template IsBoolean() {
    signal input in;
    signal inSq;
    inSq <== in * in;
    inSq === in;
}

template PerBallot() {
    signal input nullifierSecret;
    signal input electionId;
    signal input ballotHash;
    signal input isReplacement;
    signal input boundRoot;
    signal input hourlyContribution;
    signal input finalContribution;

    signal output submissionId;
    signal output uniqueStep;

    component flag = IsBoolean();
    flag.in <== isReplacement;

    // Same nested Poseidon as the vote circuit's submission id.
    component inner = Hasher();
    inner.a <== nullifierSecret;
    inner.b <== electionId;
    component sid = Hasher();
    sid.a <== inner.out;
    sid.b <== ballotHash;
    submissionId <== sid.out;

    // A replacement adds no unique voter. Its hourly contribution is zero
    // (a re-randomized encryption of zero, as a field stand-in).
    uniqueStep <== 1 - isReplacement;
    signal hourlyGate;
    hourlyGate <== isReplacement * hourlyContribution;
    hourlyGate === 0;

    // Bind the public words so a different root or contribution cannot reuse the proof.
    signal bind;
    bind <== boundRoot + hourlyContribution + finalContribution + uniqueStep;
}

component main {public [electionId, ballotHash, boundRoot, hourlyContribution, finalContribution]} = PerBallot();

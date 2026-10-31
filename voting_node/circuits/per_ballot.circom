pragma circom 2.1.9;

// Production per-ballot main. Depth 20. The test main is circuits/mains/per_ballot_test.circom (depth 4).
// The bound root is a Merkle root of voter keys. Local Groth16 keys are untrusted until a published ceremony.

include "./per_ballot_lib.circom";

component main {public [electionId, ballotHash, boundRoot]} = PerBallot(20);

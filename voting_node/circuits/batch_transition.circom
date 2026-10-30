pragma circom 2.1.9;

// Test batch main: 4 ballots, Merkle depth 4.
// Production depth 20 is circuits/mains/batch_transition_prod.circom.
// Local Groth16 keys are untrusted until a published ceremony.

include "./batch_transition_lib.circom";

component main {public [prevStateRoot, newStateRoot, dataHash, batchIndex]} = BatchTransition(4, 4);

pragma circom 2.1.9;

// Production batch main: 4 ballots, Merkle depth 20.

include "../batch_transition_lib.circom";

component main {public [prevStateRoot, newStateRoot, dataHash, batchIndex]} = BatchTransition(4, 20);

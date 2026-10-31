pragma circom 2.1.9;

// Production sealed vote. Eligible depth 20, ballot-set depth 20.
// Public input 2 is the submission id. The voter id is private.
// Public input 5 is the ballot-set Merkle root.

include "./vote_sealed_body.circom";

component main {public [root, disqRoot, nullifier, ballotHash, electionId, boundRoot, pkX, pkY, pubC1x, pubC1y, pubC2x, pubC2y, pubN, pubOptionC1x, pubOptionC1y, pubOptionC2x, pubOptionC2y]} = VoteSealed(20, 20);

pragma circom 2.1.9;

// Sealed vote smoke main. Eligible depth 4 and ballot-set depth 4.

include "../vote_sealed_body.circom";

component main {public [root, disqRoot, nullifier, ballotHash, electionId, boundRoot]} = VoteSealed(4, 4);

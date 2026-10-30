pragma circom 2.1.9;

// Test per-ballot main. Depth 4. Production is circuits/per_ballot.circom (depth 20).

include "../per_ballot_lib.circom";

component main {public [electionId, ballotHash, boundRoot, hourlyContribution, finalContribution]} = PerBallot(4);

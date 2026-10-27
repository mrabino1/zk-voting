pragma circom 2.0.0;

// NOT FOR PROFIT — civic public good, not a commercial product.
//
// Shallow Vote(4) used only to produce an UNTRUSTED local Groth16 fixture.
// Same Poseidon Hasher and public-input order as Vote(20). Not an election
// depth (elections are 16..32). Not a ceremony. See circuits/fixtures/untrusted/README.md.

include "../vote_lib.circom";

component main {public [root, disqRoot, nullifier, ballotHash, electionId]} = Vote(4);

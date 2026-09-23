pragma circom 2.0.0;

// NOT FOR PROFIT — civic public good, not a commercial product.
//
// Election vote circuit. Default depth 20 (~1M leaves). Recompile Vote(16)..Vote(32)
// to match ElectionParams.treeDepth. Hasher is Poseidon(2), not the legacy stand-in.
// Local Groth16 keys are untrusted until a published ceremony. See HASH_SCHEME.md.

include "./vote_lib.circom";

component main {public [root, disqRoot, nullifier, ballotHash, electionId]} = Vote(20);

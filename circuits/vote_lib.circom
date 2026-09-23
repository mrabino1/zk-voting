pragma circom 2.0.0;

// NOT FOR PROFIT — civic public good, not a commercial product.
//
// Vote circuit: eligible-set membership + unique nullifier + ballot bind.
//
// HASH_SCHEME: republic.hash.poseidon-bn254-x5-t3-v1 via identity.circom →
// hasher/poseidon.circom (circomlib Poseidon(2)). Merkle paths on chain and in
// this circuit must use the same HashLeftRight. There is no ceremony in this
// file. Do not mix keccak-dev-v1 or standin-v0 leaves into a Poseidon proof.
// Compile circuits/vote.circom (Vote(20)) or circuits/mains/vote_smoke.circom (Vote(4)).
//
// Public statement (matches packages/proof-helpers serializePublicInputs):
//   [root, disqRoot, nullifier, ballotHash, electionId]
//
// Private witness:
//   identityTrapdoor, nullifierSecret, pathElements, pathIndices
//
// The eligible Merkle root is `registered ∩ ¬currently-disqualified`,
// rebuilt in registration order (VoterRegistry / Node freeze). Membership
// in that tree is the exclusion: a disqualified leaf has no path, so this
// inclusion constraint fails. This circuit does NOT add a separate
// non-membership proof against the disqualification event log.
// disqRoot is bound so BallotInbox can reject a proof that does not name
// the live disqualification log. See docs/ARCHITECTURE.md.

include "./identity.circom";

// Merkle inclusion. pathIndices[i] is 0 (current is left child) or 1
// (current is right child). Sibling is pathElements[i].
template MerkleTreeInclusionProof(levels) {
    signal input leaf;
    signal input pathElements[levels];
    signal input pathIndices[levels];
    signal output root;

    signal hashes[levels + 1];
    hashes[0] <== leaf;

    component hashers[levels];
    signal left[levels];
    signal right[levels];
    signal leftFromCurrent[levels];
    signal leftFromSibling[levels];
    signal rightFromCurrent[levels];
    signal rightFromSibling[levels];

    for (var i = 0; i < levels; i++) {
        // Boolean: pathIndices[i] ∈ {0, 1}
        pathIndices[i] * (pathIndices[i] - 1) === 0;

        // left  = (1 - s) * current + s * sibling
        // right = s * current + (1 - s) * sibling
        // Split into quadratic pieces (R1CS allows one multiplication per constraint).
        leftFromCurrent[i] <== (1 - pathIndices[i]) * hashes[i];
        leftFromSibling[i] <== pathIndices[i] * pathElements[i];
        left[i] <== leftFromCurrent[i] + leftFromSibling[i];

        rightFromCurrent[i] <== pathIndices[i] * hashes[i];
        rightFromSibling[i] <== (1 - pathIndices[i]) * pathElements[i];
        right[i] <== rightFromCurrent[i] + rightFromSibling[i];

        hashers[i] = Hasher();
        hashers[i].a <== left[i];
        hashers[i].b <== right[i];
        hashes[i + 1] <== hashers[i].out;
    }

    root <== hashes[levels];
}

// Vote(levels) — levels is the Merkle depth (ElectionParams.treeDepth, 16..32).
template Vote(levels) {
    // ---- private ----
    signal input identityTrapdoor;
    signal input nullifierSecret;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    // ---- public (declaration order == Groth16 / BallotInbox publicInputs) ----
    // serializePublicInputs: [root, disqRoot, nullifier, ballotHash, electionId]
    signal input root;
    signal input disqRoot;
    signal input nullifier;
    signal input ballotHash;
    signal input electionId;

    // Leaf = Hash(trapdoor, nullifierSecret). Poseidon preferred in production.
    component identity = IdentityCommitment();
    identity.identityTrapdoor <== identityTrapdoor;
    identity.nullifierSecret <== nullifierSecret;

    component merkle = MerkleTreeInclusionProof(levels);
    merkle.leaf <== identity.commitment;
    for (var i = 0; i < levels; i++) {
        merkle.pathElements[i] <== pathElements[i];
        merkle.pathIndices[i] <== pathIndices[i];
    }
    merkle.root === root;

    // nullifier === Hash(nullifierSecret, electionId)
    component nullifierCheck = ComputeNullifier();
    nullifierCheck.nullifierSecret <== nullifierSecret;
    nullifierCheck.electionId <== electionId;
    nullifierCheck.nullifier === nullifier;

    // Bind disqRoot into the constraint system so a proof is specific to
    // both the eligible tree and the disqualification log the contract
    // currently publishes. Exclusion is membership in `root`
    // (eligible = registered ∩ ¬currently-disqualified). There is no
    // non-membership gate on the disqualification log in this template.
    // Hash(disqRoot, computedRoot) must equal Hash(disqRoot, public root).
    component disqBindComputed = Hasher();
    disqBindComputed.a <== disqRoot;
    disqBindComputed.b <== merkle.root;

    component disqBindPublic = Hasher();
    disqBindPublic.a <== disqRoot;
    disqBindPublic.b <== root;

    disqBindComputed.out === disqBindPublic.out;

    // ballotHash is the public commitment / hash of the encrypted ballot
    // (ElGamal or hashed commitment). Choice bits stay off this circuit
    // in v1; well-formedness of option encodings is a later constraint.
    // Force the signal into R1CS so it cannot be dropped from the instance.
    signal ballotHashSquared;
    ballotHashSquared <== ballotHash * ballotHash;
    ballotHashSquared === ballotHash * ballotHash;
}

// No `main` here. circuits/vote.circom compiles Vote(20). The untrusted
// Groth16 fixture compiles Vote(4) from circuits/mains/vote_smoke.circom.
// ElectionParams.treeDepth is 16..32 and must match the compiled template.

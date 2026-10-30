pragma circom 2.0.0;

// NOT FOR PROFIT — civic public good, not a commercial product.
//
// Vote circuit: eligible-set membership + disqualification non-membership
// + unique nullifier + ballot bind.
//
// HASH_SCHEME: zk-voting.hash.poseidon-bn254-x5-t3-v1 via identity.circom →
// hasher/poseidon.circom (circomlib Poseidon(2)). Merkle paths on chain and in
// this circuit must use the same HashLeftRight. There is no ceremony in this
// file. Do not mix keccak-dev-v1 or standin-v0 leaves into a Poseidon proof.
// Compile circuits/vote.circom (Vote(20)) or circuits/mains/vote_smoke.circom (Vote(4)).
//
// Public statement (matches packages/proof-helpers serializePublicInputs):
//   [root, disqRoot, nullifier, ballotHash, electionId]
//
// Private witness:
//   identityTrapdoor, nullifierSecret,
//   pathElements, pathIndices,                         // eligible inclusion
//   disqLow, disqNext, disqPathElements, disqPathIndices,
//   choice, choiceRandomness                           // ballot tag, randomness private
//
// Disqualification non-membership (indexed chain against disqRoot)
// ---------------------------------------------------------------
// disqRoot is the incremental Merkle root of a sorted chain of the
// currently-disqualified identity commitments, bookended by a 0 sentinel.
// Commitments of 0 are rejected on chain and are not valid leaves.
//
//   sorted = v0 < v1 < … < v_{k-1}     (k = 0 when nobody is disqualified)
//   leaf 0     = Hash(0, v0)           or Hash(0, 0) when k = 0
//   leaf i+1   = Hash(v_i, v_{i+1})    for i < k-1
//   leaf k     = Hash(v_{k-1}, 0)      0 means "no successor"
//
// The prover shows one chain leaf Hash(disqLow, disqNext) included under
// disqRoot such that:
//
//   disqLow < identityCommitment
//   AND (disqNext == 0 OR identityCommitment < disqNext)
//
// A commitment that appears in the chain is a boundary, not a gap, so the
// range constraint is unsatisfiable. Comparison is integer order on the
// bn254 scalar field (every signal is < p < 2^254).
//
// Soundness is relative to a well-formed chain. The registry must insert
// exactly those links. An officer who omits a person from the chain can
// publish a root that does not bar them; that is the same roll trust as
// eligibleRoot. The circuit no longer treats disqRoot as an unbound label.
//
// Eligible membership is still required: root is
// registered ∩ ¬currently-disqualified, in registration order.
// See docs/ARCHITECTURE.md.

include "./identity.circom";

// n-bit little-endian decomposition. n <= 254 so every field element fits
// (bn254 prime < 2^254). `var` doublings stay inside the compiler's field
// arithmetic for the linear combination; the bit hints are witnesses.
template Num2Bits(n) {
    signal input in;
    signal output out[n];

    var lc = 0;
    var e2 = 1;
    for (var i = 0; i < n; i++) {
        out[i] <-- (in >> i) & 1;
        out[i] * (out[i] - 1) === 0;
        lc += out[i] * e2;
        e2 = e2 + e2;
    }
    lc === in;
}

// 1 iff a < b as integers in [0, 2^254).
template FieldLessThan() {
    signal input a;
    signal input b;
    signal output out;

    component na = Num2Bits(254);
    component nb = Num2Bits(254);
    na.in <== a;
    nb.in <== b;

    signal eqPrefix[255];
    signal ltAcc[255];
    eqPrefix[254] <== 1;
    ltAcc[254] <== 0;

    signal aLtBBit[254];
    signal diff[254];
    signal diffSq[254];
    signal bitEq[254];
    signal eqTimesLt[254];
    signal eqTimesBitEq[254];

    for (var i = 0; i < 254; i++) {
        var bit = 253 - i;
        aLtBBit[i] <== (1 - na.out[bit]) * nb.out[bit];
        diff[i] <== na.out[bit] - nb.out[bit];
        diffSq[i] <== diff[i] * diff[i];
        bitEq[i] <== 1 - diffSq[i];
        eqTimesLt[i] <== eqPrefix[bit + 1] * aLtBBit[i];
        ltAcc[bit] <== ltAcc[bit + 1] + eqTimesLt[i];
        eqTimesBitEq[i] <== eqPrefix[bit + 1] * bitEq[i];
        eqPrefix[bit] <== eqTimesBitEq[i];
    }

    out <== ltAcc[0];
}

template IsZero() {
    signal input in;
    signal output out;

    signal inv;
    inv <-- in == 0 ? 0 : 1 / in;
    out <== 1 - in * inv;
    in * out === 0;
}

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
    // Indexed-chain non-membership witness against disqRoot.
    signal input disqLow;
    signal input disqNext;
    signal input disqPathElements[levels];
    signal input disqPathIndices[levels];
    // ballotHash = Poseidon(choice, choiceRandomness). Randomness stays private
    // so the tag is hiding. choice is one index in 0..15.
    signal input choice;
    signal input choiceRandomness;

    // ---- public (declaration order == Groth16 / BallotInbox publicInputs) ----
    // serializePublicInputs: [root, disqRoot, nullifier, ballotHash, electionId]
    signal input root;
    signal input disqRoot;
    signal input nullifier;
    signal input ballotHash;
    signal input electionId;

    // Leaf = Hash(trapdoor, nullifierSecret). Poseidon, matching the demo passkey leaf.
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

    // Public input 2 is the once-only voter id Poseidon(nullifierSecret, electionId).
    // An election with no settlement spends that word, so a new ballot hash
    // cannot mint a second voter. A linked settlement spends the nested id
    // Poseidon(Poseidon(nullifierSecret, electionId), ballotHash). This tree's
    // Poseidon permutation is t = 3 (two inputs). A three-input Poseidon is not here.
    component voterId = Hasher();
    voterId.a <== nullifierSecret;
    voterId.b <== electionId;
    voterId.out === nullifier;

    component sealedId = Hasher();
    sealedId.a <== voterId.out;
    sealedId.b <== ballotHash;
    signal submissionId;
    submissionId <== sealedId.out;

    // Non-membership: Hash(disqLow, disqNext) is in the disqualification chain,
    // and the identity commitment sits strictly inside that gap.
    component chainLeaf = Hasher();
    chainLeaf.a <== disqLow;
    chainLeaf.b <== disqNext;

    component disqMerkle = MerkleTreeInclusionProof(levels);
    disqMerkle.leaf <== chainLeaf.out;
    for (var j = 0; j < levels; j++) {
        disqMerkle.pathElements[j] <== disqPathElements[j];
        disqMerkle.pathIndices[j] <== disqPathIndices[j];
    }
    disqMerkle.root === disqRoot;

    component lowLtLeaf = FieldLessThan();
    lowLtLeaf.a <== disqLow;
    lowLtLeaf.b <== identity.commitment;
    lowLtLeaf.out === 1;

    component nextIsZero = IsZero();
    nextIsZero.in <== disqNext;

    component leafLtNext = FieldLessThan();
    leafLtNext.a <== identity.commitment;
    leafLtNext.b <== disqNext;

    // next == 0 OR commitment < next. A member of the chain is not in any gap.
    signal gapHigh;
    gapHigh <== (1 - nextIsZero.out) * leafLtNext.out;
    nextIsZero.out + gapHigh === 1;

    // The ElGamal body after an "AG" tag is not checked here. A ceremony
    // circuit has to constrain the curve. A public Poseidon(choice) with no
    // private randomness would be brute-forceable.
    signal choiceDiff[16];
    signal choiceAcc[16];
    choiceDiff[0] <== choice;
    choiceAcc[0] <== choiceDiff[0];
    for (var k = 1; k < 16; k++) {
        choiceDiff[k] <== choice - k;
        choiceAcc[k] <== choiceAcc[k - 1] * choiceDiff[k];
    }
    choiceAcc[15] === 0;

    component ballotTag = Hasher();
    ballotTag.a <== choice;
    ballotTag.b <== choiceRandomness;
    ballotTag.out === ballotHash;
}

// No `main` here. circuits/vote.circom compiles Vote(20). The untrusted
// Groth16 fixture compiles Vote(4) from circuits/mains/vote_smoke.circom.
// ElectionParams.treeDepth is 16..32 and must match the compiled template.

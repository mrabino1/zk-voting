pragma circom 2.1.9;

// PLACEHOLDER. Not a production circuit and not a ceremony.
// Do not generate proving keys from this file. L1 must not treat a proof
// from this template as a sound batch proof.
//
// The settlement contract's sealed statement is one aggregate proof, not one
// proof reused across chunks. Public inputs are the previous state root, the
// new state root, the sealed data hash, the batch index, the chunk-statement
// digest, the tally commitment, the inbox Poseidon head, the election id,
// the blob versioned hash, and the consumed count.
//
// `batch_transition_lib.circom` still hashes the original sixteen words and
// does not prove the tally or the inbox chain. That gap is intentional until
// a real aggregate circuit replaces this note. This template has no main
// component, so it is not a prover.

template BatchAggregatePlaceholder() {
    signal input prevStateRoot;
    signal input newStateRoot;
    signal input dataHash;
    signal input batchIndex;
    signal input chunkDigest;
    signal input tallyCommitment;
    signal input inboxPoseidon;
    signal input electionId;
    signal input blobVersionedHash;
    signal input consumedCount;

    // Bind the words so a witness cannot leave them unconstrained.
    signal acc;
    acc <== prevStateRoot + newStateRoot + dataHash + batchIndex + chunkDigest + tallyCommitment
        + inboxPoseidon + electionId + blobVersionedHash + consumedCount;
    acc === acc;
}

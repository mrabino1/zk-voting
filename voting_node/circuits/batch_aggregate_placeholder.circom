pragma circom 2.1.9;

// PLACEHOLDER. Not a production circuit and not a ceremony.
// Do not generate proving keys from this file. L1 must not treat a proof
// from this template as a sound batch proof.
//
// The settlement contract's sealed statement is one aggregate proof, not one
// proof reused across chunks. Public inputs, in order, are:
//   prevStateRoot, newStateRoot, dataHash, batchIndex, chunkDigest,
//   tallyCommitment, inboxPoseidon, electionId, blobVersionedHash,
//   consumedCount, blobY.
//
// `dataHash` is not a free field. A production circuit must recompute it as
// the same Poseidon chain `RollupSettlement.computeSealedDataHash` builds:
// kind, electionId, batchIndex, prevStateRoot, newStateRoot, ballotSetRoot,
// previousHourly, hourlyProduct, previousFinal, finalProduct, previousUnique,
// nextUnique, chainHash, tagHash, boundRootHash, the eight-point fold,
// prevConsumed, nextConsumed, prevPoseidon, nextPoseidon, chunkDigest,
// tallyCommitment, blobVersionedHash, dataLength, blobZ, blobY, and the
// keccak of the blob commitment and opening, each reduced mod r.
// `blobZ` is keccak(versionedHash, nextPoseidon, chunkDigest) mod the
// BLS12-381 scalar modulus, derived on L1. The placeholder does not
// recompute that hash. Shipping it as a verifier would not check the tally.
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
    signal input blobY;

    // No constraints. Placeholder only.
    signal acc;
    acc <== prevStateRoot + newStateRoot + dataHash + batchIndex + chunkDigest + tallyCommitment
        + inboxPoseidon + electionId + blobVersionedHash + consumedCount + blobY;
}

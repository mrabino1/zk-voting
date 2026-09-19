/**
 * @fileoverview Incremental Merkle tree matching Solidity IncrementalMerkleTree.
 *
 * NOT FOR PROFIT — civic public good, not a commercial product.
 *
 * Depth 16..32. Hasher is selected by HASH_SCHEME (keccak-dev-v1 or standin-v0).
 * Poseidon throws until wired.
 */

"use strict";

const {
  HASH_SCHEMES,
  normalizeHashScheme,
  standInHashLeftRight,
} = require("./hash-scheme");

function toFieldWord(value, toBigInt) {
  if (typeof value === "bigint") return value;
  return toBigInt(value);
}

function createMerkleHelpers({ toBigInt, keccakHashLeftRight, toHex32 }) {
  function hashLeftRightField(left, right, scheme) {
    const id = normalizeHashScheme(scheme);
    if (id === HASH_SCHEMES.STANDIN_V0) {
      return standInHashLeftRight(left, right);
    }
    if (id === HASH_SCHEMES.KECCAK_DEV_V1) {
      return toBigInt(keccakHashLeftRight(left, right));
    }
    if (id === HASH_SCHEMES.POSEIDON_BN254_X5_T3_V1) {
      throw new Error(
        "Poseidon hasher is not wired (republic.hash.poseidon-bn254-x5-t3-v1). See circuits/HASH_SCHEME.md",
      );
    }
    throw new Error(`unknown hash scheme: ${scheme}`);
  }

  function computeZeros(depth, scheme) {
    const zeros = [0n];
    for (let i = 0; i < depth; i += 1) {
      zeros.push(hashLeftRightField(zeros[i], zeros[i], scheme));
    }
    return zeros;
  }

  function createTree(depth, scheme = HASH_SCHEMES.KECCAK_DEV_V1) {
    const d = Number(depth);
    if (!Number.isInteger(d) || d < 16 || d > 32) {
      throw new Error("treeDepth must be 16..32");
    }
    const id = normalizeHashScheme(scheme);
    const zeros = computeZeros(d, id);
    return {
      depth: d,
      scheme: id,
      zeros,
      nextIndex: 0,
      filledSubtrees: zeros.slice(0, d),
      currentRoot: zeros[d],
      leaves: [],
    };
  }

  function insertLeaf(tree, leaf) {
    const cap = 2 ** tree.depth;
    if (tree.nextIndex >= cap) throw new Error("merkle tree full");
    const index = tree.nextIndex;
    let currentIndex = index;
    let currentHash = toFieldWord(leaf, toBigInt);
    for (let i = 0; i < tree.depth; i += 1) {
      if (currentIndex % 2 === 0) {
        tree.filledSubtrees[i] = currentHash;
        currentHash = hashLeftRightField(currentHash, tree.zeros[i], tree.scheme);
      } else {
        currentHash = hashLeftRightField(tree.filledSubtrees[i], currentHash, tree.scheme);
      }
      currentIndex = Math.floor(currentIndex / 2);
    }
    tree.leaves.push(toFieldWord(leaf, toBigInt));
    tree.nextIndex = index + 1;
    tree.currentRoot = currentHash;
    return { index, root: currentHash };
  }

  function merkleProof(leaves, index, depth, scheme) {
    const id = normalizeHashScheme(scheme);
    const zeros = computeZeros(depth, id);
    const pathElements = [];
    const pathIndices = [];
    let idx = Number(index);
    let layer = leaves.map((x) => toFieldWord(leafOrZero(x), toBigInt));
    for (let level = 0; level < depth; level += 1) {
      const bit = idx & 1;
      pathIndices.push(bit);
      if (bit === 0) {
        const rightIdx = idx + 1;
        pathElements.push(rightIdx < layer.length ? layer[rightIdx] : zeros[level]);
      } else {
        pathElements.push(layer[idx - 1]);
      }
      const next = [];
      for (let i = 0; i < layer.length; i += 2) {
        const left = layer[i];
        const right = i + 1 < layer.length ? layer[i + 1] : zeros[level];
        next.push(hashLeftRightField(left, right, id));
      }
      layer = next;
      idx >>= 1;
    }
    return {
      pathElements,
      pathIndices,
      root: layer[0] ?? zeros[depth],
    };
  }

  function leafOrZero(x) {
    return x == null ? 0n : x;
  }

  function verifyInclusion(leaf, pathElements, pathIndices, root, scheme) {
    if (pathElements.length !== pathIndices.length) return false;
    let h = toFieldWord(leaf, toBigInt);
    for (let i = 0; i < pathElements.length; i += 1) {
      const s = toFieldWord(pathIndices[i], toBigInt);
      const sib = toFieldWord(pathElements[i], toBigInt);
      if (s === 0n) h = hashLeftRightField(h, sib, scheme);
      else if (s === 1n) h = hashLeftRightField(sib, h, scheme);
      else return false;
    }
    return h === toFieldWord(root, toBigInt);
  }

  function identityCommitment(trapdoor, nullifierSecret, scheme) {
    return hashLeftRightField(trapdoor, nullifierSecret, scheme);
  }

  function computeNullifier(nullifierSecret, electionId, scheme) {
    return hashLeftRightField(nullifierSecret, electionId, scheme);
  }

  /**
   * Witness for Vote(levels) using standin-v0 (or an explicit scheme).
   * Inserts a sibling leaf so the first Merkle level is not degenerate.
   */
  function buildVoteWitness(opts = {}) {
    const depth = Number(opts.depth ?? 20);
    const scheme = normalizeHashScheme(opts.scheme ?? HASH_SCHEMES.STANDIN_V0);
    const trapdoor = toFieldWord(opts.identityTrapdoor ?? 2n, toBigInt);
    const nullifierSecret = toFieldWord(opts.nullifierSecret ?? 3n, toBigInt);
    const siblingTrapdoor = toFieldWord(opts.siblingTrapdoor ?? 5n, toBigInt);
    const siblingNullifierSecret = toFieldWord(opts.siblingNullifierSecret ?? 7n, toBigInt);
    const electionId = toFieldWord(opts.electionId ?? 1n, toBigInt);
    const ballotHash = toFieldWord(opts.ballotHash ?? 7n, toBigInt);

    const tree = createTree(depth, scheme);
    const leaf = identityCommitment(trapdoor, nullifierSecret, scheme);
    const sibling = identityCommitment(siblingTrapdoor, siblingNullifierSecret, scheme);
    insertLeaf(tree, leaf);
    insertLeaf(tree, sibling);

    const proof = merkleProof(tree.leaves, 0, depth, scheme);
    if (proof.root !== tree.currentRoot) {
      throw new Error("vote witness: rebuilt root does not match incremental root");
    }
    if (!verifyInclusion(leaf, proof.pathElements, proof.pathIndices, proof.root, scheme)) {
      throw new Error("vote witness: inclusion check failed");
    }

    const disqTree = createTree(depth, scheme);
    const disqRoot = opts.disqRoot != null ? toFieldWord(opts.disqRoot, toBigInt) : disqTree.currentRoot;
    const nullifier = computeNullifier(nullifierSecret, electionId, scheme);

    return {
      scheme,
      depth,
      identityTrapdoor: trapdoor,
      nullifierSecret,
      pathElements: proof.pathElements,
      pathIndices: proof.pathIndices,
      root: proof.root,
      disqRoot,
      nullifier,
      ballotHash,
      electionId,
      leaf,
    };
  }

  function voteWitnessToSnarkInput(witness) {
    return {
      identityTrapdoor: witness.identityTrapdoor.toString(),
      nullifierSecret: witness.nullifierSecret.toString(),
      pathElements: witness.pathElements.map((x) => x.toString()),
      pathIndices: witness.pathIndices.map((x) => x.toString()),
      root: witness.root.toString(),
      disqRoot: witness.disqRoot.toString(),
      nullifier: witness.nullifier.toString(),
      ballotHash: witness.ballotHash.toString(),
      electionId: witness.electionId.toString(),
    };
  }

  function tallyDemoInput() {
    // Tally(8, 4): pad sentinel is 4.
    return {
      ballots: ["0", "1", "0", "4", "4", "4", "4", "4"],
      counts: ["2", "1", "0", "0"],
      acceptedCount: "3",
    };
  }

  function hashLeftRightHex(left, right, scheme) {
    const field = hashLeftRightField(left, right, scheme);
    return toHex32(field);
  }

  return {
    hashLeftRightField,
    computeZeros,
    createTree,
    insertLeaf,
    merkleProof,
    verifyInclusion,
    identityCommitment,
    computeNullifier,
    buildVoteWitness,
    voteWitnessToSnarkInput,
    tallyDemoInput,
    hashLeftRightHex,
  };
}

module.exports = { createMerkleHelpers };

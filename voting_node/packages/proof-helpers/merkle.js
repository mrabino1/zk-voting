/**
 * @fileoverview Incremental Merkle tree matching Solidity IncrementalMerkleTree.
 *
 * NOT FOR PROFIT — civic public good, not a commercial product.
 *
 * Depth 16..32 for election trees. Hasher is keccak-dev-v1 (tests),
 * poseidon-bn254-x5-t3-v1 (vote circuit), or legacy standin-v0.
 */

"use strict";

const {
  HASH_SCHEMES,
  normalizeHashScheme,
  standInHashLeftRight,
} = require("./hash-scheme");
const { poseidonHashLeftRight } = require("./poseidon");

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
      return poseidonHashLeftRight(left, right);
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

  function createTree(depth, scheme = HASH_SCHEMES.KECCAK_DEV_V1, opts = {}) {
    const d = Number(depth);
    const minDepth = opts.minDepth == null ? 16 : Number(opts.minDepth);
    if (!Number.isInteger(d) || d < minDepth || d > 32) {
      throw new Error(`treeDepth must be ${minDepth}..32`);
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
   * Sorted currently-disqualified commitments. Zero is the chain sentinel
   * and is not a member. Duplicates are rejected.
   * @param {Array<bigint|string|number>} commitments
   */
  function sortedDisqualified(commitments) {
    const vals = (commitments || []).map((c) => toFieldWord(c, toBigInt));
    for (const v of vals) {
      if (v === 0n) throw new Error("disqualified commitment must be non-zero");
    }
    vals.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (let i = 1; i < vals.length; i += 1) {
      if (vals[i] === vals[i - 1]) throw new Error("duplicate disqualified commitment");
    }
    return vals;
  }

  /**
   * Indexed chain leaves: Hash(0, v0), Hash(v0, v1), …, Hash(vLast, 0).
   * An empty set is the single leaf Hash(0, 0).
   */
  function disqChainLeaves(commitments, scheme) {
    const sorted = sortedDisqualified(commitments);
    const chain = [0n, ...sorted];
    const leaves = [];
    for (let i = 0; i < chain.length; i += 1) {
      const next = i + 1 < chain.length ? chain[i + 1] : 0n;
      leaves.push(hashLeftRightField(chain[i], next, scheme));
    }
    return { sorted, leaves };
  }

  /**
   * Gap covering `target`, or null when `target` is a chain member.
   * @returns {{index: number, low: bigint, next: bigint}|null}
   */
  function disqGap(commitments, target, scheme) {
    const sorted = sortedDisqualified(commitments);
    const t = toFieldWord(target, toBigInt);
    if (sorted.includes(t)) return null;
    const chain = [0n, ...sorted];
    for (let i = 0; i < chain.length; i += 1) {
      const next = i + 1 < chain.length ? chain[i + 1] : 0n;
      if (chain[i] < t && (next === 0n || t < next)) {
        return { index: i, low: chain[i], next };
      }
    }
    return null;
  }

  /**
   * True when Hash(low, next) is included under disqRoot and `leaf` sits
   * strictly in that gap. A disqualified leaf fails this check.
   */
  function verifyDisqNonMembership(leaf, low, next, pathElements, pathIndices, disqRoot, scheme) {
    const target = toFieldWord(leaf, toBigInt);
    const lo = toFieldWord(low, toBigInt);
    const hi = toFieldWord(next, toBigInt);
    if (!(lo < target)) return false;
    if (!(hi === 0n || target < hi)) return false;
    const chainLeaf = hashLeftRightField(lo, hi, scheme);
    return verifyInclusion(chainLeaf, pathElements, pathIndices, disqRoot, scheme);
  }

  /**
   * Witness for Vote(levels). Default scheme is Poseidon, matching the circuit.
   * Depth may be 1..15 only for the untrusted Vote(4) smoke fixture.
   *
   * `disqualifiedCommitments` are identity commitments in the disqualification
   * chain (not the eligible tree). The voter's own leaf must not be one of them.
   */
  function buildVoteWitness(opts = {}) {
    const depth = Number(opts.depth ?? 20);
    const scheme = normalizeHashScheme(opts.scheme ?? HASH_SCHEMES.POSEIDON_BN254_X5_T3_V1);
    const trapdoor = toFieldWord(opts.identityTrapdoor ?? 2n, toBigInt);
    const nullifierSecret = toFieldWord(opts.nullifierSecret ?? 3n, toBigInt);
    const siblingTrapdoor = toFieldWord(opts.siblingTrapdoor ?? 5n, toBigInt);
    const siblingNullifierSecret = toFieldWord(opts.siblingNullifierSecret ?? 7n, toBigInt);
    const electionId = toFieldWord(opts.electionId ?? 1n, toBigInt);
    const choice = toFieldWord(opts.choice ?? 0n, toBigInt);
    const choiceRandomness = toFieldWord(opts.choiceRandomness ?? 9n, toBigInt);
    if (choice < 0n || choice > 15n) {
      throw new Error("vote witness: choice must be an integer in 0..15");
    }
    const tag = hashLeftRightField(choice, choiceRandomness, scheme);
    let ballotHash = tag;
    if (opts.ballotHash != null) {
      ballotHash = toFieldWord(opts.ballotHash, toBigInt);
      const callerBoundChoice = opts.choice != null || opts.choiceRandomness != null;
      if (callerBoundChoice && ballotHash !== tag) {
        throw new Error("vote witness: ballotHash is not Hash(choice, choiceRandomness)");
      }
    }

    const tree = createTree(depth, scheme, { minDepth: Math.min(16, depth) });
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

    const disqualified = opts.disqualifiedCommitments ?? [];
    if (sortedDisqualified(disqualified).includes(leaf)) {
      throw new Error("disqualified voter cannot prove non-membership against disqRoot");
    }
    const chain = disqChainLeaves(disqualified, scheme);
    const gap = disqGap(disqualified, leaf, scheme);
    if (!gap) {
      throw new Error("disqualified voter cannot prove non-membership against disqRoot");
    }
    const disqTree = createTree(depth, scheme, { minDepth: Math.min(16, depth) });
    for (const chainLeaf of chain.leaves) insertLeaf(disqTree, chainLeaf);
    const disqProof = merkleProof(chain.leaves, gap.index, depth, scheme);
    if (disqProof.root !== disqTree.currentRoot) {
      throw new Error("vote witness: disq chain root mismatch");
    }
    if (
      !verifyDisqNonMembership(
        leaf,
        gap.low,
        gap.next,
        disqProof.pathElements,
        disqProof.pathIndices,
        disqProof.root,
        scheme,
      )
    ) {
      throw new Error("vote witness: disqualification non-membership check failed");
    }
    const disqRoot = opts.disqRoot != null ? toFieldWord(opts.disqRoot, toBigInt) : disqProof.root;
    if (opts.disqRoot != null && disqRoot !== disqProof.root) {
      throw new Error("vote witness: disqRoot does not match the disqualification chain");
    }

    const nullifier = computeNullifier(nullifierSecret, electionId, scheme);

    return {
      scheme,
      depth,
      identityTrapdoor: trapdoor,
      nullifierSecret,
      pathElements: proof.pathElements,
      pathIndices: proof.pathIndices,
      disqLow: gap.low,
      disqNext: gap.next,
      disqPathElements: disqProof.pathElements,
      disqPathIndices: disqProof.pathIndices,
      root: proof.root,
      disqRoot,
      nullifier,
      ballotHash,
      electionId,
      choice,
      choiceRandomness,
      leaf,
    };
  }

  function voteWitnessToSnarkInput(witness) {
    return {
      identityTrapdoor: witness.identityTrapdoor.toString(),
      nullifierSecret: witness.nullifierSecret.toString(),
      pathElements: witness.pathElements.map((x) => x.toString()),
      pathIndices: witness.pathIndices.map((x) => x.toString()),
      disqLow: witness.disqLow.toString(),
      disqNext: witness.disqNext.toString(),
      disqPathElements: witness.disqPathElements.map((x) => x.toString()),
      disqPathIndices: witness.disqPathIndices.map((x) => x.toString()),
      root: witness.root.toString(),
      disqRoot: witness.disqRoot.toString(),
      nullifier: witness.nullifier.toString(),
      ballotHash: witness.ballotHash.toString(),
      electionId: witness.electionId.toString(),
      choice: witness.choice.toString(),
      choiceRandomness: witness.choiceRandomness.toString(),
    };
  }

  function tallyDemoInput() {
    // Tally(8, 4): pad sentinel is 4. electionId is a public input.
    return {
      electionId: "1",
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
    sortedDisqualified,
    disqChainLeaves,
    disqGap,
    verifyDisqNonMembership,
    buildVoteWitness,
    voteWitnessToSnarkInput,
    tallyDemoInput,
    hashLeftRightHex,
  };
}

module.exports = { createMerkleHelpers };

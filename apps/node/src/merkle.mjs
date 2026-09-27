// NOT FOR PROFIT — civic public good, not a commercial product.
// Incremental Merkle tree. Default HASH_SCHEME is republic.hash.keccak-dev-v1
// (keccak256 left||right), matching Solidity KeccakHasher used by Foundry tests.
// Vote-circuit proofs use Poseidon via @zk-voting/proof-helpers. This tree stays keccak-dev-v1.
// The disqualification root is the same indexed chain as the circuit (sentinel 0,
// then sorted commitments), hashed with keccak here. Depth 16..32.

import { concat, keccak256, pad, toHex } from 'viem';

export const ZERO = `0x${'00'.repeat(32)}`;

export function toBytes32(value) {
  if (value === undefined || value === null || value === '') {
    throw new Error('empty bytes32');
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return pad(toHex(BigInt(value)), { size: 32 }).toLowerCase();
  }
  const s = String(value).trim();
  if (s.startsWith('0x') || s.startsWith('0X')) {
    return pad(s.toLowerCase(), { size: 32 });
  }
  if (/^\d+$/.test(s)) {
    return pad(toHex(BigInt(s)), { size: 32 }).toLowerCase();
  }
  if (/^[0-9a-fA-F]+$/.test(s)) {
    return pad(`0x${s.toLowerCase()}`, { size: 32 });
  }
  throw new Error('cannot coerce bytes32');
}

export function hashLeftRight(left, right) {
  return keccak256(concat([toBytes32(left), toBytes32(right)]));
}

const ZERO_CACHE = new Map();

/** Zero-subtree hashes for one depth. The array is shared and must not be mutated. */
export function computeZeros(depth) {
  const d = Number(depth);
  const cached = ZERO_CACHE.get(d);
  if (cached) return cached;
  const zeros = [ZERO];
  for (let i = 0; i < d; i += 1) {
    zeros.push(hashLeftRight(zeros[i], zeros[i]));
  }
  ZERO_CACHE.set(d, zeros);
  return zeros;
}

export function emptyTree(depth) {
  const d = Number(depth);
  if (!Number.isInteger(d) || d < 16 || d > 32) {
    throw new Error('treeDepth must be 16..32');
  }
  const zeros = computeZeros(d);
  return {
    depth: d,
    nextIndex: 0,
    filled: [],
    leaves: [],
    root: zeros[d],
  };
}

function asUint(value) {
  return BigInt(toBytes32(value));
}

/**
 * Indexed disqualification chain under keccak-dev-v1.
 * leaf 0 = Hash(0, v0) or Hash(0, 0); later links Hash(v_i, v_{i+1}); last Hash(vLast, 0).
 * @param {Array<string|bigint|number>} commitments currently disqualified identity commitments
 */
export function disqualificationChain(commitments) {
  const sorted = (commitments || []).map(asUint);
  for (const v of sorted) {
    if (v === 0n) throw new Error('disqualified commitment must be non-zero');
  }
  sorted.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] === sorted[i - 1]) throw new Error('duplicate disqualified commitment');
  }
  const chain = [0n, ...sorted];
  const leaves = [];
  for (let i = 0; i < chain.length; i += 1) {
    const next = i + 1 < chain.length ? chain[i + 1] : 0n;
    leaves.push(hashLeftRight(chain[i], next));
  }
  return { sorted, leaves };
}

/** Gap covering `target`, or null when `target` is disqualified. */
export function disqualificationGap(commitments, target) {
  const { sorted, leaves } = disqualificationChain(commitments);
  const t = asUint(target);
  if (sorted.includes(t)) return null;
  const chain = [0n, ...sorted];
  for (let i = 0; i < chain.length; i += 1) {
    const next = i + 1 < chain.length ? chain[i + 1] : 0n;
    if (chain[i] < t && (next === 0n || t < next)) {
      return { index: i, low: chain[i], next, chainLeaf: leaves[i] };
    }
  }
  return null;
}

export function disqualificationTree(depth, commitments) {
  const tree = emptyTree(depth);
  const { leaves } = disqualificationChain(commitments);
  for (const leaf of leaves) insertLeaf(tree, leaf);
  return tree;
}

export function insertLeaf(tree, leaf) {
  const cap = 2 ** tree.depth;
  if (tree.nextIndex >= cap) {
    throw new Error('merkle tree full');
  }
  const zeros = computeZeros(tree.depth);
  let current = toBytes32(leaf);
  tree.leaves.push(current);
  let index = tree.nextIndex;
  for (let level = 0; level < tree.depth; level += 1) {
    if (index % 2 === 0) {
      tree.filled[level] = current;
      current = hashLeftRight(current, zeros[level]);
    } else {
      current = hashLeftRight(tree.filled[level], current);
    }
    index = Math.floor(index / 2);
  }
  tree.root = current;
  const leafIndex = tree.nextIndex;
  tree.nextIndex += 1;
  return { leafIndex, root: tree.root };
}

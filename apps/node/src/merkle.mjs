// NOT FOR PROFIT — civic public good, not a commercial product.
// Incremental Merkle tree. Default HASH_SCHEME is republic.hash.keccak-dev-v1
// (keccak256 left||right), matching Solidity KeccakHasher used by Foundry tests.
// Vote-circuit proofs use Poseidon via @zk-voting/proof-helpers. This tree stays keccak-dev-v1. Depth 16..32.

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

export function computeZeros(depth) {
  const zeros = [ZERO];
  for (let i = 0; i < depth; i += 1) {
    zeros.push(hashLeftRight(zeros[i], zeros[i]));
  }
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

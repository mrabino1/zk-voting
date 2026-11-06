// NOT FOR PROFIT — civic public good, not a commercial product.
//
// Poseidon Merkle commitment of (address, voting power) at one Ethereum block.
// The hash is zk-voting.hash.poseidon-bn254-x5-t3-v1, the same HashLeftRight
// the civic vote circuit uses. Depth 16 matches circuits/weight_snapshot.circom.
//
// This is a membership argument, not a secret ballot. The address and the
// weight are public. The path is the witness. The Node checks it directly.
// There is no Groth16 ceremony for this circuit.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { F, poseidonHashLeftRight } = require('../../../packages/proof-helpers/poseidon.js');

export const SNAPSHOT_DEPTH = 16;
export const SNAPSHOT_SCHEME = 'zk-voting.hash.poseidon-bn254-x5-t3-v1';
export const WEIGHT_HOLD = 'balance_hold';
export const WEIGHT_VOTES = 'erc20_votes';

function hash(left, right) {
  return poseidonHashLeftRight(left, right);
}

export function snapshotZeros(depth = SNAPSHOT_DEPTH) {
  const zeros = [0n];
  for (let i = 0; i < depth; i += 1) zeros.push(hash(zeros[i], zeros[i]));
  return zeros;
}

export function addressToField(address) {
  const n = BigInt(address);
  if (n <= 0n || n >= F) throw new Error('address does not fit the poseidon field');
  return n;
}

export function weightToField(weight) {
  const n = typeof weight === 'bigint' ? weight : BigInt(weight);
  if (n < 0n || n >= F) throw new Error('weight does not fit the poseidon field');
  return n;
}

export function snapshotLeaf(address, weight) {
  return hash(addressToField(address), weightToField(weight));
}

export function compareAddresses(a, b) {
  const left = String(a).toLowerCase();
  const right = String(b).toLowerCase();
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Incremental Poseidon tree. Insertion order is the sorted address order.
 * An empty tree's root is the depth-16 zero hash, so nobody can prove a leaf.
 */
export function buildSnapshotTree(rows, depth = SNAPSHOT_DEPTH) {
  const ordered = [...(rows || [])].sort((a, b) => compareAddresses(a.address, b.address));
  if (ordered.length > 2 ** depth) {
    const err = new Error('snapshot has too many delegates for the Poseidon tree');
    err.code = 'SNAPSHOT_TOO_LARGE';
    throw err;
  }
  const seen = new Set();
  const zeros = snapshotZeros(depth);
  const filled = zeros.slice(0, depth);
  const leaves = [];
  let root = zeros[depth];
  ordered.forEach((row, index) => {
    const key = String(row.address).toLowerCase();
    if (seen.has(key)) {
      const err = new Error('duplicate delegate in snapshot');
      err.code = 'SNAPSHOT_DUPLICATE';
      throw err;
    }
    seen.add(key);
    const leaf = snapshotLeaf(row.address, row.weight);
    let cursor = index;
    let current = leaf;
    for (let level = 0; level < depth; level += 1) {
      if (cursor % 2 === 0) {
        filled[level] = current;
        current = hash(current, zeros[level]);
      } else {
        current = hash(filled[level], current);
      }
      cursor = Math.floor(cursor / 2);
    }
    leaves.push(leaf);
    root = current;
  });
  return { depth, scheme: SNAPSHOT_SCHEME, root, leaves, ordered, zeros };
}

export function fieldToHex(value) {
  return `0x${BigInt(value).toString(16).padStart(64, '0')}`;
}

function merkleProof(leaves, index, depth) {
  const zeros = snapshotZeros(depth);
  const pathElements = [];
  const pathIndices = [];
  let idx = Number(index);
  let layer = leaves.map((leaf) => BigInt(leaf));
  for (let level = 0; level < depth; level += 1) {
    const bit = idx & 1;
    pathIndices.push(bit);
    if (bit === 0) {
      const right = idx + 1;
      pathElements.push(right < layer.length ? layer[right] : zeros[level]);
    } else {
      pathElements.push(layer[idx - 1]);
    }
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i];
      const right = i + 1 < layer.length ? layer[i + 1] : zeros[level];
      next.push(hash(left, right));
    }
    layer = next;
    idx >>= 1;
  }
  return { pathElements, pathIndices, root: layer[0] ?? zeros[depth] };
}

export function proofForAddress(rows, address) {
  const tree = buildSnapshotTree(rows);
  const index = tree.ordered.findIndex(
    (row) => String(row.address).toLowerCase() === String(address).toLowerCase(),
  );
  if (index < 0) return null;
  const proof = merkleProof(tree.leaves, index, tree.depth);
  if (proof.root !== tree.root) {
    throw new Error('snapshot proof root does not match the incremental root');
  }
  const row = tree.ordered[index];
  return {
    address: row.address,
    weight: String(row.weight),
    index,
    depth: tree.depth,
    scheme: tree.scheme,
    root: fieldToHex(tree.root),
    pathElements: proof.pathElements.map((item) => item.toString()),
    pathIndices: proof.pathIndices,
  };
}

export function verifySnapshotProof({ address, weight, pathElements, pathIndices, root }) {
  if (!Array.isArray(pathElements) || !Array.isArray(pathIndices)) return false;
  if (pathElements.length !== pathIndices.length || pathElements.length !== SNAPSHOT_DEPTH) return false;
  let current = snapshotLeaf(address, weight);
  for (let i = 0; i < pathElements.length; i += 1) {
    const bit = Number(pathIndices[i]);
    const sibling = BigInt(pathElements[i]);
    if (bit === 0) current = hash(current, sibling);
    else if (bit === 1) current = hash(sibling, current);
    else return false;
  }
  const expected = typeof root === 'bigint' ? root : BigInt(root);
  return current === expected;
}

export function snapshotRootOf(rows) {
  return fieldToHex(buildSnapshotTree(rows).root);
}

export function normalizeWeightSource(raw) {
  if (raw == null || raw === '' || raw === WEIGHT_HOLD) return WEIGHT_HOLD;
  if (raw === WEIGHT_VOTES) return WEIGHT_VOTES;
  const err = new Error('weightSource must be balance_hold or erc20_votes');
  err.code = 'INVALID_CHOICES';
  throw err;
}

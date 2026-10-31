/**
 * Indexed ballot set. Same leaves as circuits/indexed_merkle.circom and
 * IndexedRoot.empty: leaf = Poseidon(Poseidon(key, nextKey), cipherHash).
 * Index 0 of an empty tree is the sentinel. Every other leaf is 0.
 * An insert updates the predecessor in place, then writes the new leaf
 * into the first empty slot. pathIndices bit 0 means the current node is
 * the left child.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { poseidonHashLeftRight } = require("../../../packages/proof-helpers/poseidon.js");

const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function mod(n) {
  const x = typeof n === "bigint" ? n : BigInt(n);
  if (x < 0n) throw new Error("negative field element");
  return x % FIELD;
}

function H(left, right) {
  return poseidonHashLeftRight(mod(left), mod(right));
}

export function ciphertextHash(c1x, c1y, c2x, c2y) {
  return H(H(c1x, c1y), H(c2x, c2y));
}

/** n = 0 ordered digest. Poseidon(ct, 0), the same value the inbox stores for a 130-byte EG ballot. */
export function cipherHash(c1x, c1y, c2x, c2y) {
  return H(ciphertextHash(c1x, c1y, c2x, c2y), 0n);
}

export function ballotDigest(c1x, c1y, c2x, c2y, options = []) {
  let h = H(ciphertextHash(c1x, c1y, c2x, c2y), BigInt(options.length));
  for (const option of options) {
    h = H(h, ciphertextHash(option[0], option[1], option[2], option[3]));
  }
  return h;
}

export function voterKey(secret, electionId) {
  return H(secret, electionId);
}

export function valuedLeaf(key, nextKey, cipher) {
  return H(H(key, nextKey), cipher);
}

export function emptyRoot(depth) {
  let h = valuedLeaf(0n, 0n, 0n);
  let sibling = 0n;
  for (let i = 0; i < depth; i += 1) {
    h = H(h, sibling);
    sibling = H(sibling, sibling);
  }
  return h;
}

export function createTree(depth) {
  if (!Number.isInteger(depth) || depth < 1 || depth > 20) {
    throw new Error("depth must be 1..20");
  }
  const size = 1 << depth;
  const leaves = new Array(size).fill(0n);
  leaves[0] = valuedLeaf(0n, 0n, 0n);
  const nodes = new Map();
  nodes.set(0n, { key: 0n, nextKey: 0n, cipher: 0n, index: 0 });
  return { depth, leaves, nextSlot: 1, nodes };
}

export function rootOf(tree) {
  let nodes = tree.leaves.slice();
  while (nodes.length > 1) {
    const parent = new Array(nodes.length >> 1);
    for (let i = 0; i < parent.length; i += 1) {
      parent[i] = H(nodes[i * 2], nodes[i * 2 + 1]);
    }
    nodes = parent;
  }
  return nodes[0];
}

export function pathOf(leaves, depth, index) {
  const pathElements = [];
  const pathIndices = [];
  let nodes = leaves.slice();
  let idx = index;
  for (let level = 0; level < depth; level += 1) {
    pathElements.push(nodes[idx ^ 1]);
    pathIndices.push(idx & 1);
    const parent = new Array(nodes.length >> 1);
    for (let i = 0; i < parent.length; i += 1) {
      parent[i] = H(nodes[i * 2], nodes[i * 2 + 1]);
    }
    nodes = parent;
    idx >>= 1;
  }
  return { pathElements, pathIndices };
}

export function rootFromPath(leaf, pathElements, pathIndices) {
  let cur = mod(leaf);
  for (let i = 0; i < pathElements.length; i += 1) {
    const sibling = pathElements[i];
    const onRight = pathIndices[i] === 1;
    cur = H(onRight ? sibling : cur, onRight ? cur : sibling);
  }
  return cur;
}

export function predecessor(tree, key) {
  const want = mod(key);
  let best = null;
  for (const node of tree.nodes.values()) {
    if (node.key < want && (best === null || node.key > best.key)) best = node;
  }
  if (!best) throw new Error("no predecessor");
  return best;
}

export function inGap(low, key, next) {
  return low < key && (next === 0n || key < next);
}

/** Membership of the current gap, before any insert. */
export function gapWitness(tree, key) {
  const want = mod(key);
  const pred = predecessor(tree, want);
  return {
    low: pred.key,
    nextKey: pred.nextKey,
    predCipher: pred.cipher,
    path: pathOf(tree.leaves, tree.depth, pred.index),
    root: rootOf(tree),
    open: inGap(pred.key, want, pred.nextKey),
  };
}

/**
 * First ballot. Updates the predecessor's next key, then writes the new
 * leaf at the first empty slot.
 */
export function insert(tree, key, cipher) {
  const want = mod(key);
  const tag = mod(cipher);
  if (tree.nodes.has(want)) throw new Error("key already present");
  const gap = gapWitness(tree, want);
  if (!gap.open) throw new Error("key is not in a gap");
  const pred = tree.nodes.get(gap.low);
  const slot = tree.nextSlot;
  if (slot >= tree.leaves.length) throw new Error("tree full");
  const predPath = gap.path;
  tree.leaves[pred.index] = valuedLeaf(pred.key, want, pred.cipher);
  pred.nextKey = want;
  const emptyPath = pathOf(tree.leaves, tree.depth, slot);
  tree.leaves[slot] = valuedLeaf(want, gap.nextKey, tag);
  tree.nextSlot = slot + 1;
  tree.nodes.set(want, { key: want, nextKey: gap.nextKey, cipher: tag, index: slot });
  return {
    low: gap.low,
    nextKey: gap.nextKey,
    predCipher: gap.predCipher,
    predIndex: pred.index,
    slot,
    predPath,
    emptyPath,
    root: rootOf(tree),
  };
}

/** Re-vote. The member path is the leaf before the ciphertext changes. */
export function replace(tree, key, newCipher) {
  const want = mod(key);
  const node = tree.nodes.get(want);
  if (!node || want === 0n) throw new Error("missing key");
  const memberPath = pathOf(tree.leaves, tree.depth, node.index);
  const oldCipher = node.cipher;
  const nextKey = node.nextKey;
  const tag = mod(newCipher);
  tree.leaves[node.index] = valuedLeaf(want, nextKey, tag);
  node.cipher = tag;
  return { nextKey, oldCipher, path: memberPath, root: rootOf(tree) };
}

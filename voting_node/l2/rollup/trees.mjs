// NOT FOR PROFIT — civic public good, not a commercial product.
// Poseidon Merkle trees of the L2 state. Same hashing as smart-contracts/src/libraries/StateTree.sol:
// empty leaves are 0, an empty subtree of height h is zeros[h] with zeros[h+1] = H(zeros[h], zeros[h]),
// and bit i of a key picks the side at level i, counting from the leaves.

import { poseidon2 } from '../../apps/node/public/ballot-crypto.js';

const zeroCache = [0n];
export function zeros(height) {
  while (zeroCache.length <= height) {
    const z = zeroCache[zeroCache.length - 1];
    zeroCache.push(poseidon2(z, z));
  }
  return zeroCache[height];
}

/**
 * Sparse Merkle tree keyed by a bigint (election id or nullifier). Only non-empty nodes are
 * stored, keyed `level:index`, so a depth-254 tree costs 254 hashes per update.
 */
export class SparseMerkleTree {
  constructor(depth, nodes = new Map()) {
    this.depth = depth;
    this.nodes = nodes;
  }

  node(level, index) {
    return this.nodes.get(`${level}:${index}`) ?? zeros(level);
  }

  get root() {
    return this.node(this.depth, 0n);
  }

  get(key) {
    return this.node(0, BigInt(key));
  }

  set(key, value) {
    let index = BigInt(key);
    let h = BigInt(value);
    this._store(0, index, h);
    for (let level = 0; level < this.depth; level += 1) {
      const sibling = this.node(level, index ^ 1n);
      h = index & 1n ? poseidon2(sibling, h) : poseidon2(h, sibling);
      index >>= 1n;
      this._store(level + 1, index, h);
    }
    return h;
  }

  /** Siblings from the leaf level up, as StateTree.rootFrom expects. */
  siblings(key) {
    let index = BigInt(key);
    const out = [];
    for (let level = 0; level < this.depth; level += 1) {
      out.push(this.node(level, index ^ 1n));
      index >>= 1n;
    }
    return out;
  }

  _store(level, index, h) {
    const k = `${level}:${index}`;
    if (h === zeros(level)) this.nodes.delete(k);
    else this.nodes.set(k, h);
  }

  toJSON() {
    return { depth: this.depth, nodes: [...this.nodes].map(([k, v]) => [k, v.toString()]) };
  }

  static fromJSON(j) {
    return new SparseMerkleTree(j.depth, new Map(j.nodes.map(([k, v]) => [k, BigInt(v)])));
  }
}

/** Append-only roll of identity commitments; a disqualified leaf is set to 0. */
export class RollTree {
  constructor(depth, tree = new SparseMerkleTree(depth), size = 0) {
    this.tree = tree;
    this.size = size;
  }

  get root() {
    return this.tree.root;
  }

  append(commitment) {
    if (this.size >= 2 ** this.tree.depth) throw new Error('roll is full');
    const index = this.size;
    this.tree.set(BigInt(index), BigInt(commitment));
    this.size += 1;
    return index;
  }

  clear(index) {
    this.tree.set(BigInt(index), 0n);
  }

  path(index) {
    return { index, siblings: this.tree.siblings(BigInt(index)) };
  }

  toJSON() {
    return { size: this.size, tree: this.tree.toJSON() };
  }

  static fromJSON(j) {
    const tree = SparseMerkleTree.fromJSON(j.tree);
    return new RollTree(tree.depth, tree, j.size);
  }
}

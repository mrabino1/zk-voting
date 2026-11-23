// NOT FOR PROFIT — civic public good, not a commercial product.
// The L2 must commit to exactly what smart-contracts/test/Libraries.t.sol pins.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as bc from '../../../apps/node/public/ballot-crypto.js';
import { batchCommitment, chain } from '../batch.mjs';
import { SparseMerkleTree } from '../trees.mjs';
import { ELECTION_TREE_DEPTH, RollupState } from '../state.mjs';

test('Poseidon matches circomlib and PoseidonT3.sol', () => {
  assert.equal(bc.poseidon2(1n, 2n), 7853200120776062878684798364095072458815029376092732009249414926327459813530n);
});

test('empty state root, leaf hash and election-tree root match StateTree.sol', () => {
  assert.equal(new RollupState().root, 0x2f68a1c58e257e42a17a6c61dff5551ed560b9922ab119d5ac8e184c9734ead9n);
  const leaf = bc.fold([1n, 2n, 3n, 4n, 5n, 1n]);
  assert.equal(leaf, 0x22f6494107874b90eeb92cd9e7895770488fd988d89100a27b97b6eec3e261d1n);
  const tree = new SparseMerkleTree(ELECTION_TREE_DEPTH);
  tree.set(7n, leaf);
  assert.equal(tree.root, 0x2b12c3ee812dcc2b478ac596838067e137849d61e868de64b5cddcf63cc94ee1n);
});

test('batch commitment and op-hash chain match ZkVotingRollup.commitBatch', () => {
  const c = batchCommitment({
    prevStateRoot: 1n,
    newStateRoot: 2n,
    batchNumber: 3n,
    timestamp: 4n,
    pubdata: Uint8Array.of(1, 2, 3, 4, 5),
    priorityOpsHash: 5n,
    onchainOpsHash: 6n,
  });
  assert.equal(c, 0x14687ab94b3179a58e72e0fadab37f5609d6fe760b4b38a683c05899b90e4b07n);
  assert.equal(chain(7n, 8n), 0x24cd397636bedc6cf9b490d0edd57c769c19b367fb7d5c2344ae1ddc7d21c144n);
});

test('a sparse path recomputes the root', () => {
  const tree = new SparseMerkleTree(ELECTION_TREE_DEPTH);
  tree.set(5n, 11n);
  tree.set(9n, 22n);
  let h = tree.get(9n);
  tree.siblings(9n).forEach((s, i) => {
    h = (9n >> BigInt(i)) & 1n ? bc.poseidon2(s, h) : bc.poseidon2(h, s);
  });
  assert.equal(h, tree.root);
});

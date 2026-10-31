/**
 * The node ballot set matches circuits/indexed_merkle.circom.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  cipherHash,
  createTree,
  emptyRoot,
  gapWitness,
  inGap,
  insert,
  replace,
  rootFromPath,
  rootOf,
  valuedLeaf,
  voterKey,
} from "../src/indexedBallotSet.mjs";

test("empty indexed root matches the iterative depth fold", () => {
  const tree = createTree(4);
  assert.equal(rootOf(tree), emptyRoot(4));
  assert.notEqual(emptyRoot(20), 0n);
  assert.notEqual(emptyRoot(20), emptyRoot(4));
  assert.equal(tree.leaves[0], valuedLeaf(0n, 0n, 0n));
  assert.equal(tree.leaves[1], 0n);
});

test("insert updates the predecessor and a second first has no gap", () => {
  const tree = createTree(4);
  const key = voterKey(7n, 11n);
  const cipher = cipherHash(1n, 2n, 3n, 4n);
  const before = gapWitness(tree, key);
  assert.equal(before.open, true);
  assert.equal(before.low, 0n);
  assert.equal(before.nextKey, 0n);
  const placed = insert(tree, key, cipher);
  assert.equal(placed.slot, 1);
  assert.equal(placed.nextKey, 0n);
  assert.equal(
    rootFromPath(valuedLeaf(0n, 0n, 0n), placed.predPath.pathElements, placed.predPath.pathIndices),
    emptyRoot(4),
  );
  assert.equal(
    rootFromPath(valuedLeaf(key, 0n, cipher), placed.emptyPath.pathElements, placed.emptyPath.pathIndices),
    placed.root,
  );
  const again = gapWitness(tree, key);
  assert.equal(again.open, false);
  assert.equal(again.nextKey, key);
  assert.equal(inGap(again.low, key, again.nextKey), false);
  assert.throws(() => insert(tree, key, cipherHash(5n, 6n, 7n, 8n)), /not a gap|already present/);
});

test("a later key updates its predecessor and a re-vote replaces the ciphertext", () => {
  const tree = createTree(4);
  const first = voterKey(3n, 9n);
  const second = voterKey(8n, 9n);
  assert.ok(first < second || second < first);
  const low = first < second ? first : second;
  const high = first < second ? second : first;
  insert(tree, low, cipherHash(1n, 2n, 3n, 4n));
  const highGap = gapWitness(tree, high);
  assert.equal(highGap.open, true);
  assert.equal(highGap.low, low);
  const placed = insert(tree, high, cipherHash(4n, 3n, 2n, 1n));
  assert.equal(tree.nodes.get(low).nextKey, high);
  const member = replace(tree, low, cipherHash(9n, 8n, 7n, 6n));
  assert.equal(
    rootFromPath(
      valuedLeaf(low, high, cipherHash(1n, 2n, 3n, 4n)),
      member.path.pathElements,
      member.path.pathIndices,
    ),
    placed.root,
  );
  assert.equal(tree.nodes.get(low).cipher, cipherHash(9n, 8n, 7n, 6n));
  assert.equal(rootOf(tree), member.root);
});

// NOT FOR PROFIT — civic public good, not a commercial product.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

import { ZERO, computeZeros, emptyTree, hashLeftRight, insertLeaf, toBytes32 } from '../src/merkle.mjs';
import { Store } from '../src/store.mjs';

function expectedRoot(depth, commitments) {
  const tree = emptyTree(depth);
  for (const commitment of commitments) insertLeaf(tree, toBytes32(commitment));
  return tree.root;
}

async function openStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'republic-eligible-'));
  const store = await Store.open({ dataDir: dir, adminHandle: 'admin' });
  return { dir, store };
}

async function makeElection(store, treeDepth = 16) {
  return store.createElection({
    title: 'Eligible append',
    startTime: 1,
    cutoffTime: 10_000,
    maxParticipants: 0,
    treeDepth,
    jurisdictionId: 'demo',
    ballotSpecHash: `0x${'ab'.repeat(32)}`,
    ballotMethod: 'plurality',
    questions: [{ id: 'q1', type: 'YES_NO', prompt: '?', options: [] }],
  });
}

describe('eligible tree append', () => {
  const dirs = [];
  after(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  test('computeZeros is stable and cached', () => {
    const zeros = computeZeros(16);
    assert.equal(zeros, computeZeros(16));
    let acc = ZERO;
    for (let level = 0; level < 16; level += 1) {
      assert.equal(zeros[level], acc);
      acc = hashLeftRight(acc, acc);
    }
    assert.equal(zeros[16], acc);
  });

  test('each registration matches a full rebuild of the eligible set', async () => {
    const { dir, store } = await openStore();
    dirs.push(dir);
    const election = await makeElection(store, 16);
    const commitments = Array.from({ length: 32 }, (_, i) => String(i + 1));
    for (const commitment of commitments) {
      await store.registerCommitment(election.id, commitment);
      assert.equal(store.requireElection(election.id).eligibleRoot, expectedRoot(16, commitments.slice(0, commitments.indexOf(commitment) + 1)));
    }
    const live = store.requireElection(election.id);
    const root = live.eligibleRoot;
    const leaves = live.eligibleTree.leaves.slice();
    store.rebuildEligibleTree(live);
    assert.equal(live.eligibleRoot, root);
    assert.deepEqual(live.eligibleTree.leaves, leaves);
  });

  test('register after disqualify still matches registered ∩ ¬disqualified', async () => {
    const { dir, store } = await openStore();
    dirs.push(dir);
    const election = await makeElection(store, 16);
    for (const commitment of ['1', '2', '3', '4']) {
      await store.registerCommitment(election.id, commitment);
    }
    await store.disqualify(election.id, { identityCommitment: '2', reasonCode: 1, issuer: 'test' });
    assert.equal(store.requireElection(election.id).eligibleRoot, expectedRoot(16, ['1', '3', '4']));
    await store.registerCommitment(election.id, '5');
    await store.registerCommitment(election.id, '6');
    const live = store.requireElection(election.id);
    assert.equal(live.eligibleRoot, expectedRoot(16, ['1', '3', '4', '5', '6']));
    assert.equal(live.eligibleCount, 5);
    assert.equal(live.participantCount, 6);
  });
});

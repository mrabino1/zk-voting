// Store-level poll results gate. Choice blocks go through presentResults,
// the publisher behind GET /api/elections/:id/results.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import { toBytes32 } from '../src/merkle.mjs';
import { presentResults } from '../src/results.mjs';
import { Store } from '../src/store.mjs';

const H0 = 1_699_999_200;
const HOUR = 3600;
const DELAY = 1800;
const H1 = H0 + HOUR;
const PUBLISH_AT = H1 + HOUR + DELAY;

function passHash(n) {
  return n.toString(16).padStart(64, '0');
}

function publisherConfig(now) {
  return {
    nowFn: () => now,
    resultsMinVotes: 100,
    disclosureIntervalSeconds: HOUR,
    disclosureDelaySeconds: DELAY,
    disclosureMinBlockVotes: 10,
  };
}

async function openStore(dir) {
  return Store.open({
    dataDir: dir,
    databaseUrl: '',
    quiet: true,
    allowRevote: true,
    resultsMinVotes: 100,
    disclosureIntervalSeconds: HOUR,
    disclosureDelaySeconds: DELAY,
    disclosureMinBlockVotes: 10,
  });
}

async function createPoll(store, cutoffTime) {
  return store.createElection({
    title: 'Results gate',
    startTime: H0 - 60,
    cutoffTime,
    maxParticipants: 0,
    treeDepth: 16,
    jurisdictionId: 'demo',
    ballotSpecHash: `0x${'ab'.repeat(32)}`,
    ballotMethod: 'plurality',
    electionType: 0,
    questions: [
      {
        id: 'q1',
        type: 'YES_NO',
        prompt: 'Adopt the measure?',
        options: [
          { id: 'yes', label: 'Yes' },
          { id: 'no', label: 'No' },
        ],
      },
    ],
  });
}

function published(store, electionId, now) {
  const election = store.requireElection(electionId);
  return presentResults(election, { store, config: publisherConfig(now) }, { now });
}

async function castFirst(store, electionId, n, acceptedAt) {
  await store.acceptVote({
    electionId,
    nullifier: toBytes32(n + 1),
    ballotHash: toBytes32(10_000 + n),
    acceptedAt,
    spentPassHash: passHash(n),
  });
}

async function castMany(store, electionId, from, count, acceptedAt) {
  for (let n = from; n < from + count; n += 1) {
    await castFirst(store, electionId, n, acceptedAt);
  }
}

describe('poll results gate', () => {
  test('99 first ballots plus re-votes stay shut with no choice blocks', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-gate-'));
    try {
      const store = await openStore(dir);
      const poll = await createPoll(store, H0 + 10 * HOUR);
      await castMany(store, poll.id, 0, 9, H0 + 10);
      await castMany(store, poll.id, 9, 90, H1 + 10);
      const election = store.requireElection(poll.id);
      assert.equal(election.acceptedBallots, 99);
      assert.equal(election.resultsGateOpenedAt ?? null, null);
      for (let n = 0; n < 50; n += 1) {
        await store.replaceVote(
          {
            electionId: poll.id,
            nullifier: toBytes32(n + 1),
            ballotHash: toBytes32(80_000 + n),
            acceptedAt: H1 + 500,
            spentPassHash: passHash(n),
          },
          { encryptedBallot: `0x${'cd'.repeat(32)}` },
        );
      }
      const after = store.requireElection(poll.id);
      assert.equal(after.acceptedBallots, 99);
      assert.equal(after.resultsGateOpenedAt ?? null, null);
      const body = published(store, poll.id, PUBLISH_AT);
      assert.equal(body.choiceBlocks.gateOpen, false);
      assert.equal(body.choiceBlocks.blocks.length, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('the 100th first ballot opens the gate through the results publisher', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-gate-'));
    try {
      const store = await openStore(dir);
      const poll = await createPoll(store, H0 + 10 * HOUR);
      await castMany(store, poll.id, 0, 9, H0 + 10);
      await castMany(store, poll.id, 9, 90, H1 + 10);
      const closed = published(store, poll.id, PUBLISH_AT);
      assert.equal(store.requireElection(poll.id).acceptedBallots, 99);
      assert.equal(closed.choiceBlocks.gateOpen, false);
      assert.equal(closed.choiceBlocks.blocks.length, 0);

      await castFirst(store, poll.id, 99, H1 + 20);
      const election = store.requireElection(poll.id);
      assert.equal(election.acceptedBallots, 100);
      assert.equal(election.resultsGateOpenedAt, H1);

      const beforeDelay = published(store, poll.id, H1 + DELAY);
      assert.equal(beforeDelay.choiceBlocks.gateOpen, true);
      assert.equal(beforeDelay.choiceBlocks.blocks.length, 0);

      const opened = published(store, poll.id, PUBLISH_AT);
      assert.equal(opened.choiceBlocks.gateOpen, true);
      assert.equal(opened.choiceBlocks.blocks.length, 1);
      const block = opened.choiceBlocks.blocks[0];
      assert.equal(block.hourStart, H0);
      assert.equal(block.hourEnd, H1 + HOUR);
      assert.equal(block.publishedAt, PUBLISH_AT);
      assert.equal(block.ballots, 100);
      assert.equal(opened.choiceBlocks.blocks.some((row) => row.hourEnd <= H1), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('the scheduled end opens the gate with fewer than 100 first ballots', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-gate-'));
    try {
      const store = await openStore(dir);
      const cutoff = H0 + 4 * HOUR;
      const poll = await createPoll(store, cutoff);
      await castMany(store, poll.id, 0, 8, H0 + 10);
      const election = store.requireElection(poll.id);
      assert.equal(election.acceptedBallots, 8);
      assert.equal(election.resultsGateOpenedAt ?? null, null);
      const before = published(store, poll.id, cutoff - 1);
      assert.equal(before.choiceBlocks.gateOpen, false);
      assert.equal(before.choiceBlocks.blocks.length, 0);
      const ended = published(store, poll.id, cutoff);
      assert.equal(ended.choiceBlocks.gateOpen, true);
      assert.equal(ended.choiceBlocks.blocks.length, 1);
      assert.equal(ended.choiceBlocks.blocks[0].ballots, 8);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('removing a ballot after the gate opens leaves published blocks, including after reload', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-gate-'));
    try {
      const store = await openStore(dir);
      const poll = await createPoll(store, H0 + 10 * HOUR);
      await castMany(store, poll.id, 0, 9, H0 + 10);
      await castMany(store, poll.id, 9, 91, H1 + 10);
      const opened = store.requireElection(poll.id);
      assert.equal(opened.acceptedBallots, 100);
      assert.equal(opened.resultsGateOpenedAt, H1);
      const before = published(store, poll.id, PUBLISH_AT);
      assert.equal(before.choiceBlocks.gateOpen, true);
      assert.equal(before.choiceBlocks.blocks.length, 1);
      const publishedAt = before.choiceBlocks.blocks[0].publishedAt;
      const hourStart = before.choiceBlocks.blocks[0].hourStart;

      const removed = await store.revertAcceptedVote({
        electionId: poll.id,
        nullifier: toBytes32(100),
      });
      assert.equal(removed, true);
      const after = store.requireElection(poll.id);
      assert.equal(after.acceptedBallots, 99);
      assert.equal(after.resultsGateOpenedAt, H1);
      const stayed = published(store, poll.id, PUBLISH_AT);
      assert.equal(stayed.choiceBlocks.gateOpen, true);
      assert.equal(stayed.choiceBlocks.blocks.length, 1);
      assert.equal(stayed.choiceBlocks.blocks[0].publishedAt, publishedAt);
      assert.equal(stayed.choiceBlocks.blocks[0].hourStart, hourStart);

      const reloaded = await openStore(dir);
      const again = reloaded.requireElection(poll.id);
      assert.equal(again.acceptedBallots, 99);
      assert.equal(again.resultsGateOpenedAt, H1);
      const afterReload = published(reloaded, poll.id, PUBLISH_AT);
      assert.equal(afterReload.choiceBlocks.gateOpen, true);
      assert.equal(afterReload.choiceBlocks.blocks.length, 1);
      assert.equal(afterReload.choiceBlocks.blocks[0].publishedAt, publishedAt);
      assert.equal(afterReload.choiceBlocks.blocks[0].hourStart, hourStart);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a soft-deleted ballot does not count toward opening the results gate', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-gate-'));
    const H2 = H0 + 2 * HOUR;
    try {
      const store = await openStore(dir);
      const poll = await createPoll(store, H0 + 10 * HOUR);
      await castMany(store, poll.id, 0, 99, H0 + 10);
      const hidden = store.data.votes.find((vote) => vote.nullifier === toBytes32(1));
      assert.ok(hidden);
      hidden.is_deleted = true;
      await castFirst(store, poll.id, 99, H1 + 20);
      const mid = store.requireElection(poll.id);
      assert.equal(mid.acceptedBallots, 100);
      assert.equal(store.visibleAcceptedBallots(mid), 99);
      assert.equal(mid.resultsGateOpenedAt ?? null, null);
      const closed = published(store, poll.id, H2 + HOUR + DELAY);
      assert.equal(closed.choiceBlocks.gateOpen, false);
      assert.equal(closed.choiceBlocks.blocks.length, 0);
      await castFirst(store, poll.id, 100, H2 + 30);
      const opened = store.requireElection(poll.id);
      assert.equal(store.visibleAcceptedBallots(opened), 100);
      assert.equal(opened.resultsGateOpenedAt, H2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('reopening a store backfills past a soft-deleted row to the 100th visible hour', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-gate-'));
    const H2 = H0 + 2 * HOUR;
    try {
      const store = await openStore(dir);
      const poll = await createPoll(store, H0 + 10 * HOUR);
      await castMany(store, poll.id, 0, 99, H0 + 10);
      await castFirst(store, poll.id, 99, H1 + 20);
      const hidden = store.data.votes.find((vote) => vote.nullifier === toBytes32(100));
      assert.ok(hidden);
      hidden.is_deleted = true;
      await castFirst(store, poll.id, 100, H2 + 30);
      const election = store.requireElection(poll.id);
      assert.equal(store.visibleAcceptedBallots(election), 100);
      delete election.resultsGateOpenedAt;
      await store.persist();
      const reloaded = await openStore(dir);
      const again = reloaded.requireElection(poll.id);
      assert.equal(again.acceptedBallots, 101);
      assert.equal(reloaded.visibleAcceptedBallots(again), 100);
      assert.equal(again.resultsGateOpenedAt, H2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('reopening a store with no latch backfills the 100th visible ballot hour', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-gate-'));
    const H2 = H0 + 2 * HOUR;
    try {
      const store = await openStore(dir);
      const poll = await createPoll(store, H0 + 10 * HOUR);
      await castMany(store, poll.id, 0, 99, H0 + 10);
      await castFirst(store, poll.id, 99, H1 + 20);
      await castFirst(store, poll.id, 100, H2 + 30);
      const election = store.requireElection(poll.id);
      assert.equal(election.resultsGateOpenedAt, H1);
      delete election.resultsGateOpenedAt;
      await store.persist();
      const reloaded = await openStore(dir);
      const again = reloaded.requireElection(poll.id);
      assert.equal(again.acceptedBallots, 101);
      assert.equal(again.resultsGateOpenedAt, H1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a latch hour in the future does not open the results gate', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-gate-'));
    try {
      const store = await openStore(dir);
      const poll = await createPoll(store, H0 + 10 * HOUR);
      await castMany(store, poll.id, 0, 8, H0 + 10);
      const election = store.requireElection(poll.id);
      election.resultsGateOpenedAt = H1;
      await store.persist();
      const early = published(store, poll.id, H0 + 10);
      assert.equal(early.choiceBlocks.gateOpen, false);
      assert.equal(early.choiceBlocks.blocks.length, 0);
      const reached = published(store, poll.id, H1);
      assert.equal(reached.choiceBlocks.gateOpen, true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

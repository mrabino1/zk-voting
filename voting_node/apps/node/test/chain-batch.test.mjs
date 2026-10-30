// NOT FOR PROFIT — civic public good, not a commercial product.
// BallotInbox batches: one hourly batch, a final drain past 64, one in-flight
// flush, a nullifier that is not queued twice, a failed batch that stays
// queued while the next election flushes, and a mined marker that is not resent.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createChain } from '../src/chain.mjs';

const INBOX = '0x0000000000000000000000000000000000000001';

function emptyQueue() {
  return { rows: [], batchAt: {}, inFlight: {}, deadLetter: [], attempts: {} };
}

function memoryQueue() {
  const saved = emptyQueue();
  return {
    saved,
    loadChainVoteQueue() {
      return JSON.parse(JSON.stringify(saved));
    },
    async saveChainVoteQueue(doc) {
      const next = doc && typeof doc === 'object' ? doc : {};
      saved.rows = next.rows || [];
      saved.batchAt = next.batchAt || {};
      saved.inFlight = next.inFlight || {};
      saved.deadLetter = next.deadLetter || [];
      saved.attempts = next.attempts || {};
    },
  };
}

function openChain({ interval = 3600, gate, queueStore, batches, writeSubmitBatch, settleInFlight, nullifierSpent } = {}) {
  const sent = batches || [];
  const chain = createChain(
    {
      chainRpc: 'http://127.0.0.1:9',
      ballotInboxAddress: INBOX,
      disclosureIntervalSeconds: interval,
      chainId: 31337,
      nowFn: () => 10_000,
      quiet: true,
    },
    {
      queueStore,
      settleInFlight,
      nullifierSpent,
      writeSubmitBatch:
        writeSubmitBatch ||
        (async ({ batch }) => {
          sent.push(batch);
          if (gate) await gate;
          return { hash: '0xabc', batched: true, count: batch.length };
        }),
    },
  );
  return { chain, sent };
}

function vote(n, { cutoffTime = 99_999, now = 3600, startTime = 0, electionId = '7' } = {}) {
  return {
    electionId,
    proof: { accept: true },
    publicInputs: [1n, 2n, BigInt(n), 4n, 5n],
    encryptedBallot: '0x01',
    startTime,
    cutoffTime,
    now,
  };
}

describe('BallotInbox batch sending', () => {
  test('an elapsed hour sends one batch and leaves the 65th ballot queued', async () => {
    const queueStore = memoryQueue();
    const { chain, sent } = openChain({ queueStore });
    for (let n = 1; n <= 65; n += 1) {
      const queued = await chain.submitVote(vote(n, { cutoffTime: 99_999, now: 100 }));
      assert.equal(queued.submitted, false);
    }
    assert.equal(sent.length, 0);
    const flushed = await chain.flushVoteQueue(3600);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].length, 64);
    assert.equal(flushed[0].final, undefined);
    assert.equal(queueStore.saved.rows.length, 1);
    const again = await chain.flushVoteQueue(3600);
    assert.equal(again[0].submitted, false);
    assert.equal(sent.length, 1);
  });

  test('cutoff drains more than 64 ballots in two batches', async () => {
    const queueStore = memoryQueue();
    const { chain, sent } = openChain({ queueStore });
    for (let n = 1; n <= 65; n += 1) {
      await chain.submitVote(vote(n, { cutoffTime: 5000, now: 100 }));
    }
    const flushed = await chain.flushVoteQueue(5000);
    assert.equal(sent.length, 2);
    assert.equal(sent[0].length, 64);
    assert.equal(sent[1].length, 1);
    assert.equal(flushed[0].final, true);
    assert.equal(queueStore.saved.rows.length, 0);
  });

  test('two concurrent flushes send one transaction', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const { chain, sent } = openChain({ gate });
    await chain.submitVote(vote(1, { cutoffTime: 99_999, now: 100 }));
    const first = chain.flushVoteQueue(3600);
    const second = chain.flushVoteQueue(3600);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sent.length, 1);
    release();
    const [a, b] = await Promise.all([first, second]);
    const flags = [a[0], b[0]].map((row) => Boolean(row.inFlight));
    assert.equal(flags.filter(Boolean).length, 1);
    assert.equal(sent.length, 1);
  });

  test('the same nullifier is not queued twice, and a restart still has the row', async () => {
    const queueStore = memoryQueue();
    const { chain, sent } = openChain({ queueStore });
    const first = await chain.submitVote(vote(9, { now: 100 }));
    const second = await chain.submitVote(vote(9, { now: 100 }));
    assert.equal(first.duplicate, undefined);
    assert.equal(second.duplicate, true);
    assert.equal(queueStore.saved.rows.length, 1);
    assert.equal(sent.length, 0);
    const restarted = openChain({ queueStore, batches: sent });
    const flushed = await restarted.chain.flushVoteQueue(3600);
    assert.equal(flushed[0].batched, true);
    assert.equal(sent.length, 1);
    assert.equal(queueStore.saved.rows.length, 0);
  });

  test('a thrown batch stays queued and the next election still flushes', async () => {
    const queueStore = memoryQueue();
    const sent = [];
    let seen = null;
    const { chain } = openChain({
      queueStore,
      batches: sent,
      writeSubmitBatch: async ({ electionId, batch }) => {
        if (String(electionId) === '7') {
          seen = JSON.parse(JSON.stringify(queueStore.saved.inFlight));
          throw new Error('inbox down');
        }
        sent.push(batch);
        return { hash: '0xok', batched: true, count: batch.length };
      },
    });
    await chain.submitVote(vote(1, { now: 100 }));
    await chain.submitVote(vote(2, { now: 100, electionId: '8' }));
    const flushed = await chain.flushVoteQueue(3600);
    assert.deepEqual(seen['7'].nullifiers, ['1']);
    assert.equal(seen['7'].txHash, null);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].length, 1);
    assert.equal(queueStore.saved.rows.length, 1);
    assert.equal(String(queueStore.saved.rows[0].electionKey), '7');
    assert.equal(queueStore.saved.attempts['7'], 1);
    assert.deepEqual(queueStore.saved.inFlight, {});
    assert.equal(flushed.find((row) => row.electionId === '7').error, 'inbox down');
    assert.equal(flushed.find((row) => row.electionId === '8').batched, true);
  });

  test('the third thrown batch is dead-lettered so a later ballot can flush', async () => {
    const queueStore = memoryQueue();
    const sent = [];
    let fail = true;
    const { chain } = openChain({
      queueStore,
      batches: sent,
      writeSubmitBatch: async ({ batch }) => {
        if (fail) throw new Error('inbox down');
        sent.push(batch);
        return { hash: '0xok', batched: true, count: batch.length };
      },
    });
    await chain.submitVote(vote(4, { now: 100 }));
    const first = await chain.flushVoteQueue(3600);
    const second = await chain.flushVoteQueue(3600);
    assert.equal(first[0].error, 'inbox down');
    assert.equal(second[0].error, 'inbox down');
    assert.equal(queueStore.saved.rows.length, 1);
    const third = await chain.flushVoteQueue(3600);
    assert.equal(third[0].deadLetter, true);
    assert.equal(queueStore.saved.rows.length, 0);
    assert.equal(queueStore.saved.deadLetter.length, 1);
    assert.deepEqual(queueStore.saved.deadLetter[0].nullifiers, ['4']);
    assert.equal(sent.length, 0);
    fail = false;
    await chain.submitVote(vote(5, { now: 100 }));
    const recovered = await chain.flushVoteQueue(3600);
    assert.equal(recovered[0].batched, true);
    assert.equal(sent.length, 1);
    assert.equal(queueStore.saved.rows.length, 0);
  });

  test('a mined in-flight marker is not sent again', async () => {
    const queueStore = memoryQueue();
    const first = openChain({ queueStore });
    await first.chain.submitVote(vote(3, { now: 100 }));
    queueStore.saved.inFlight = { '7': { txHash: '0xabc', nullifiers: ['3'] } };
    const restarted = openChain({
      queueStore,
      settleInFlight: async (marker) => {
        assert.equal(marker.txHash, '0xabc');
        return 'mined';
      },
    });
    const flushed = await restarted.chain.flushVoteQueue(3600);
    assert.equal(restarted.sent.length, 0);
    assert.equal(queueStore.saved.rows.length, 0);
    assert.deepEqual(queueStore.saved.inFlight, {});
    assert.equal(flushed[0].queued, false);
  });

  test('an unknown receipt stays in flight and is not resent', async () => {
    const queueStore = memoryQueue();
    const first = openChain({ queueStore });
    await first.chain.submitVote(vote(3, { now: 100 }));
    queueStore.saved.inFlight = { '7': { txHash: '0xabc', nullifiers: ['3'] } };
    const restarted = openChain({
      queueStore,
      settleInFlight: async () => 'unknown',
    });
    const flushed = await restarted.chain.flushVoteQueue(3600);
    assert.equal(restarted.sent.length, 0);
    assert.equal(queueStore.saved.rows.length, 1);
    assert.equal(queueStore.saved.inFlight['7'].txHash, '0xabc');
    assert.equal(flushed[0].pending, true);
  });

  test('a marker with no hash and spent nullifiers is dropped', async () => {
    const queueStore = memoryQueue();
    const first = openChain({ queueStore });
    await first.chain.submitVote(vote(3, { now: 100 }));
    queueStore.saved.inFlight = { '7': { txHash: null, nullifiers: ['3'] } };
    const restarted = openChain({
      queueStore,
      nullifierSpent: async () => true,
    });
    await restarted.chain.flushVoteQueue(3600);
    assert.equal(restarted.sent.length, 0);
    assert.equal(queueStore.saved.rows.length, 0);
    assert.deepEqual(queueStore.saved.inFlight, {});
  });
});

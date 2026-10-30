// NOT FOR PROFIT — civic public good, not a commercial product.
// BallotInbox batches: one hourly batch, a final drain past 64, one in-flight
// flush, and a nullifier that is not queued twice.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createChain } from '../src/chain.mjs';

const INBOX = '0x0000000000000000000000000000000000000001';

function memoryQueue() {
  const saved = { rows: [], batchAt: {} };
  return {
    saved,
    loadChainVoteQueue() {
      return {
        rows: saved.rows.map((row) => JSON.parse(JSON.stringify(row))),
        batchAt: { ...saved.batchAt },
      };
    },
    async saveChainVoteQueue(rows, batchAt) {
      saved.rows = rows;
      saved.batchAt = batchAt;
    },
  };
}

function openChain({ interval = 3600, gate, queueStore, batches } = {}) {
  const sent = batches || [];
  const chain = createChain(
    {
      chainRpc: 'http://127.0.0.1:9',
      ballotInboxAddress: INBOX,
      disclosureIntervalSeconds: interval,
      chainId: 31337,
      nowFn: () => 10_000,
    },
    {
      queueStore,
      writeSubmitBatch: async ({ batch }) => {
        sent.push(batch);
        if (gate) await gate;
        return { hash: '0xabc', batched: true, count: batch.length };
      },
    },
  );
  return { chain, sent };
}

function vote(n, { cutoffTime = 99_999, now = 3600, startTime = 0 } = {}) {
  return {
    electionId: '7',
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
});

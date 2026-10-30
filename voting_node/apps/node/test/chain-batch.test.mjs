// NOT FOR PROFIT — civic public good, not a commercial product.
// BallotInbox batches: one hourly batch, a final drain past 64, one in-flight
// flush, a nullifier that is not queued twice, a failed batch that stays
// queued while the next election flushes, and a mined marker that is not resent.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import { createChain, REVERT_RETRY_BACKOFF_SECONDS } from '../src/chain.mjs';
import { toBytes32 } from '../src/merkle.mjs';
import { Store } from '../src/store.mjs';

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
      saved.backoffUntil = next.backoffUntil || {};
      saved.splitLimit = next.splitLimit || {};
      saved.transportStrikes = next.transportStrikes || {};
      saved.alerts = next.alerts || [];
      saved.supplementary = next.supplementary || [];
    },
  };
}

function openChain({ interval = 3600, gate, queueStore, batches, writeSubmitBatch, settleInFlight, nullifierSpent, receiptTimeoutSeconds } = {}) {
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
      receiptTimeoutSeconds,
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
    assert.equal(queueStore.saved.attempts['7'], undefined);
    assert.equal(queueStore.saved.deadLetter.length, 0);
    assert.ok(chain.diagnostics().alerts.some((item) => item.kind === 'chain_transport'));
    assert.deepEqual(queueStore.saved.inFlight, {});
    assert.equal(flushed.find((row) => row.electionId === '7').error, 'inbox down');
    assert.equal(flushed.find((row) => row.electionId === '8').batched, true);
  });

  test('a transport outage keeps the batch queued and backs off', async () => {
    const queueStore = memoryQueue();
    const { chain } = openChain({
      queueStore,
      writeSubmitBatch: async () => {
        throw new Error('inbox down');
      },
    });
    await chain.submitVote(vote(4, { now: 100 }));
    const first = await chain.flushVoteQueue(3600);
    const second = await chain.flushVoteQueue(3600);
    assert.equal(first[0].error, 'inbox down');
    assert.equal(second[0].backoff, true);
    assert.equal(queueStore.saved.rows.length, 1);
    assert.equal(queueStore.saved.deadLetter.length, 0);
    assert.ok(chain.diagnostics().alerts.some((item) => item.kind === 'chain_transport'));
    const later = await chain.flushVoteQueue(3600 + 31);
    assert.equal(later[0].error, 'inbox down');
    assert.equal(queueStore.saved.rows.length, 1);
    assert.equal(queueStore.saved.deadLetter.length, 0);
  });

  test('only an isolated revert is dead-lettered, and a replay puts it back', async () => {
    const queueStore = memoryQueue();
    const sent = [];
    const { chain } = openChain({
      queueStore,
      batches: sent,
      nullifierSpent: async () => false,
      writeSubmitBatch: async ({ batch }) => {
        const err = new Error('execution reverted');
        err.revert = true;
        if (batch.length === 1 && batch[0].inputs[2] === 2n) throw err;
        if (batch.some((row) => row.inputs[2] === 2n)) throw err;
        sent.push(batch);
        return { hash: '0xok', batched: true, count: batch.length };
      },
    });
    await chain.submitVote(vote(1, { now: 100 }));
    await chain.submitVote(vote(2, { now: 100 }));
    await chain.submitVote(vote(3, { now: 100 }));
    const first = await chain.flushVoteQueue(3600);
    assert.equal(queueStore.saved.deadLetter.length, 0);
    assert.equal(first[0].backoff, true);
    const immediate = await chain.flushVoteQueue(3600);
    assert.equal(immediate[0].backoff, true);
    await chain.flushVoteQueue(3600 + REVERT_RETRY_BACKOFF_SECONDS);
    const isolated = await chain.flushVoteQueue(3600 + REVERT_RETRY_BACKOFF_SECONDS * 2);
    assert.equal(isolated[0].deadLetter, true);
    assert.equal(queueStore.saved.deadLetter.length, 1);
    assert.equal(queueStore.saved.deadLetter[0].nullifier, '2');
    assert.equal(queueStore.saved.rows.length, 0);
    assert.deepEqual(sent.map((batch) => batch.map((row) => row.inputs[2].toString())).flat().sort(), ['1', '3']);
    const replayed = await chain.replayDeadLetter('7', '2');
    assert.equal(replayed.restored, 1);
    assert.equal(chain.deadLettersFor('7').length, 0);
    assert.equal(queueStore.saved.rows.length, 1);
    assert.equal(chain.diagnostics().deadLetter.length, 0);
  });

  test('replay keeps a dead letter it cannot put back', async () => {
    const queueStore = memoryQueue();
    queueStore.saved.deadLetter = [
      { electionKey: '7', nullifier: '2', error: 'revert', at: 1 },
      { electionKey: '7', nullifier: '9', error: 'revert', at: 1, row: { nullifier: 'nope' } },
    ];
    const { chain } = openChain({ queueStore });
    const replayed = await chain.replayDeadLetter('7');
    assert.equal(replayed.restored, 0);
    assert.equal(replayed.kept, 2);
    assert.equal(chain.deadLettersFor('7').length, 2);
    assert.equal(queueStore.saved.rows.length, 0);
  });

  test('a revert drops spent nullifiers and does not dead-letter the hour', async () => {
    const queueStore = memoryQueue();
    const sent = [];
    const { chain } = openChain({
      queueStore,
      batches: sent,
      nullifierSpent: async (_electionId, nullifier) => BigInt(nullifier) === 2n,
      writeSubmitBatch: async ({ batch }) => {
        if (batch.some((row) => row.inputs[2] === 2n)) {
          const err = new Error('execution reverted');
          err.revert = true;
          throw err;
        }
        sent.push(batch);
        return { hash: '0xok', batched: true, count: batch.length };
      },
    });
    await chain.submitVote(vote(1, { now: 100 }));
    await chain.submitVote(vote(2, { now: 100 }));
    await chain.flushVoteQueue(3600);
    assert.equal(queueStore.saved.deadLetter.length, 0);
    assert.equal(queueStore.saved.rows.length, 0);
    assert.deepEqual(sent.map((batch) => batch.map((row) => String(row.inputs[2]))), [['1']]);
  });

  test('a broadcast hash is saved before the receipt, and a stale receipt is resent', async () => {
    const queueStore = memoryQueue();
    const { chain } = openChain({
      queueStore,
      writeSubmitBatch: async ({ onHash }) => {
        await onHash('0xhash');
        throw new Error('timeout waiting for receipt');
      },
    });
    await chain.submitVote(vote(6, { now: 100 }));
    const flushed = await chain.flushVoteQueue(3600);
    assert.equal(flushed[0].pending, true);
    assert.equal(queueStore.saved.inFlight['7'].txHash, '0xhash');
    assert.equal(queueStore.saved.rows.length, 1);
    assert.equal(queueStore.saved.deadLetter.length, 0);

    const restarted = openChain({
      queueStore,
      settleInFlight: async () => 'unknown',
      nullifierSpent: async () => false,
      receiptTimeoutSeconds: 600,
    });
    const resent = await restarted.chain.flushVoteQueue(3600 + 601);
    assert.equal(resent[0].batched, true);
    assert.equal(restarted.sent.length, 1);
    assert.equal(queueStore.saved.rows.length, 0);
  });

  test('dropQueuedVote removes one nullifier and leaves the rest', async () => {
    const queueStore = memoryQueue();
    const { chain } = openChain({ queueStore });
    await chain.submitVote(vote(8, { now: 100 }));
    await chain.submitVote(vote(9, { now: 100 }));
    assert.equal(await chain.dropQueuedVote('7', 8), true);
    assert.equal(queueStore.saved.rows.length, 1);
    assert.equal(queueStore.saved.rows[0].nullifier, '9');
    assert.equal(await chain.dropQueuedVote('7', 8), false);
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

  test('the JSON sidecar wins over the embedded queue on reload', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-queue-'));
    try {
      const store = await Store.open({ dataDir: dir, quiet: true });
      await store.saveChainVoteQueue({
        rows: [{ electionKey: '7', nullifier: '9', a: ['1', '2'], b: [['1', '2'], ['3', '4']], c: ['5', '6'], inputs: ['1', '2', '9', '4', '5'], encryptedBallot: '0x01' }],
        batchAt: {},
        inFlight: {},
        deadLetter: [],
        attempts: {},
      });
      store.data.chainVoteQueue = [];
      await store.persist();
      const reloaded = await Store.open({ dataDir: dir, quiet: true });
      assert.equal(reloaded.loadChainVoteQueue().rows.length, 1);
      assert.equal(reloaded.loadChainVoteQueue().rows[0].nullifier, '9');
      assert.equal(reloaded.data.chainVoteQueue.length, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('chain ballot payloads are stored out of arrival order', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-payload-order-'));
    try {
      const store = await Store.open({ dataDir: dir, quiet: true });
      const order = [];
      for (let i = 1; i <= 12; i += 1) {
        store.upsertChainBallotPayload('7', i, {
          proof: { accept: true },
          publicInputs: [],
          encryptedBallot: '0x01',
          startTime: 0,
          cutoffTime: 99,
        });
        order.push(String(i));
      }
      const stored = store.data.chainBallotPayloads.map((row) => BigInt(row.nullifier).toString());
      assert.deepEqual([...stored].sort((a, b) => Number(a) - Number(b)), order);
      assert.notDeepEqual(stored, order);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('revertAcceptedVote deletes the chain payload', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-payload-revert-'));
    try {
      const store = await Store.open({ dataDir: dir, quiet: true });
      const nullifier = toBytes32(4);
      store.data.votes.push({
        electionId: '7',
        nullifier,
        ballotHash: toBytes32(1),
        publishedBallotHash: toBytes32(1),
        relayer: 'node',
        acceptedAt: 0,
      });
      store.upsertChainBallotPayload('7', 4, {
        proof: { accept: true },
        publicInputs: [],
        encryptedBallot: '0x01',
        startTime: 0,
        cutoffTime: 99,
      });
      assert.ok(store.chainBallotPayload('7', 4));
      assert.equal(await store.revertAcceptedVote({ electionId: '7', nullifier: 4 }), true);
      assert.equal(store.chainBallotPayload('7', 4), null);
      assert.equal(store.data.votes.length, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a mined nullifier leaves the supplementary hold', async () => {
    const queueStore = memoryQueue();
    queueStore.saved.deadLetter = [{
      electionKey: '7',
      nullifier: '4',
      error: 'revert',
      at: 1,
      row: {
        nullifier: '4',
        a: ['1', '2'],
        b: [['1', '2'], ['3', '4']],
        c: ['5', '6'],
        inputs: ['1', '2', '4', '4', '5'],
        encryptedBallot: '0x01',
      },
    }];
    const { chain } = openChain({ queueStore, nullifierSpent: async () => false });
    assert.equal((await chain.holdSupplementary('7', ['4'])).moved, 1);
    assert.equal(chain.supplementaryFor('7').length, 1);
    await chain.submitVote(vote(4, { now: 100 }));
    await chain.flushVoteQueue(3600);
    assert.equal(chain.supplementaryFor('7').length, 0);
    assert.equal(chain.pendingFor('7').inFlight.length, 0);
  });

  test('a mined nullifier drops its chain payload', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-payload-mined-'));
    try {
      const store = await Store.open({ dataDir: dir, quiet: true });
      store.upsertChainBallotPayload('7', 4, {
        proof: { accept: true },
        publicInputs: [],
        encryptedBallot: '0x01',
        startTime: 0,
        cutoffTime: 99,
      });
      const { chain } = openChain({ queueStore: store });
      await chain.submitVote(vote(4, { now: 100 }));
      await chain.flushVoteQueue(3600);
      assert.equal(store.chainBallotPayload('7', 4), null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

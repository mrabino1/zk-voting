// A sealed choice row must not consume the block hash. A later block can
// import the choice once that block's timestamp is at the deadline.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import { Explorer, OUTCOMES_ONLY_KEY_CAP } from '../src/explorer.mjs';

function policy(now, cutoff) {
  return {
    electionContext(id) {
      if (String(id) === 'poll-1') {
        return { known: true, vote: false, endTime: cutoff, resultsSealed: false };
      }
      return {
        known: true,
        vote: true,
        endTime: cutoff,
        resultsSealed: now < cutoff,
      };
    },
  };
}

describe('explorer ingest', () => {
  test('a skipped choice row does not mark the block seen', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'explorer-ingest-'));
    try {
      const explorer = await Explorer.open({ dataDir: tmp, databaseUrl: '', chainId: 27427, quiet: true });
      const cutoff = 100;
      let now = 50;
      explorer.disclosurePolicy = () => policy(now, cutoff);
      const early = {
        hash: '0x' + '11'.repeat(32),
        timestamp: 50,
        transactions: [
          {
            hash: '0x' + '22'.repeat(32),
            civicType: 'tally',
            civic: { type: 'tally', electionId: 'vote-1', counts: [1, 0] },
          },
        ],
      };
      const first = await explorer.ingest({ block: early }, now, 0);
      assert.equal(first.duplicate, false);
      assert.equal(first.imported, 0);
      assert.equal(explorer.chain.seenBlockHashes.includes(early.hash), false);
      now = 100;
      const later = {
        hash: '0x' + '33'.repeat(32),
        timestamp: cutoff,
        transactions: [
          {
            hash: '0x' + '44'.repeat(32),
            civicType: 'tally',
            civic: { type: 'tally', electionId: 'vote-1', counts: [1, 0] },
          },
        ],
      };
      const released = await explorer.ingest({ block: later }, now, 0);
      assert.equal(released.imported, 1);
      assert.equal(explorer.chain.seenBlockHashes.includes(early.hash), false);
      assert.equal(explorer.chain.seenBlockHashes.includes(later.hash), true);
      assert.equal(explorer.chain.ingestedTxHashes.includes('0x' + '44'.repeat(32)), false);
      const again = await explorer.ingest({ block: later }, now, 0);
      assert.equal(again.duplicate, true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('a mixed block ingested twice stores poll_params once', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'explorer-ingest-'));
    try {
      const explorer = await Explorer.open({ dataDir: tmp, databaseUrl: '', chainId: 27427, quiet: true });
      const cutoff = 100;
      const now = 50;
      explorer.disclosurePolicy = () => policy(now, cutoff);
      const block = {
        hash: '0x' + '55'.repeat(32),
        timestamp: now,
        transactions: [
          {
            hash: '0x' + '66'.repeat(32),
            civicType: 'tally',
            civic: { type: 'tally', electionId: 'vote-1', counts: [1, 0] },
          },
          {
            hash: '0x' + '77'.repeat(32),
            civicType: 'poll_params',
            civic: { type: 'poll_params', electionId: 'poll-1', floor: 100 },
          },
        ],
      };
      const first = await explorer.ingest({ block }, now, 0);
      assert.equal(first.imported, 1);
      assert.equal(explorer.chain.seenBlockHashes.includes(block.hash), false);
      const second = await explorer.ingest({ block }, now, 0);
      assert.equal(second.duplicate, false);
      const params = Object.values(explorer.chain.txs).filter((tx) => tx.type === 'poll_params');
      assert.equal(params.length, 1);
      assert.equal(explorer.chain.ingestedTxHashes.includes('0x' + '77'.repeat(32)), true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('an outcomes body ingested twice stores poll_params once', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'explorer-ingest-'));
    try {
      const explorer = await Explorer.open({ dataDir: tmp, databaseUrl: '', chainId: 27427, quiet: true });
      const cutoff = 100;
      const now = 50;
      explorer.disclosurePolicy = () => policy(now, cutoff);
      const blockHash = '0x' + '88'.repeat(32);
      const body = {
        block: { hash: blockHash, timestamp: now },
        outcomes: {
          tally: [{ electionId: 'vote-1', counts: [1, 0] }],
          poll_params: [{ electionId: 'poll-1', floor: 100 }],
        },
      };
      const first = await explorer.ingest(body, now, 0);
      assert.equal(first.imported, 1);
      assert.equal(explorer.chain.seenBlockHashes.includes(blockHash), false);
      const second = await explorer.ingest(body, now, 0);
      assert.equal(second.duplicate, false);
      assert.equal(second.imported, 0);
      const params = Object.values(explorer.chain.txs).filter((tx) => tx.type === 'poll_params');
      assert.equal(params.length, 1);
      assert.equal(explorer.chain.ingestedTxHashes.length, 1);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('a newer poll row is appended and readers follow block order', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'explorer-ingest-'));
    try {
      const explorer = await Explorer.open({ dataDir: tmp, databaseUrl: '', chainId: 27427, quiet: true });
      const now = 50;
      explorer.disclosurePolicy = () => policy(now, 100);
      const p1 = { outcomes: { poll_params: [{ electionId: 'poll-1', floor: 1 }] } };
      const p2 = { outcomes: { poll_params: [{ electionId: 'poll-1', floor: 2 }] } };
      const first = await explorer.ingest(p1, now, 0);
      const published = explorer.chain.blocks.map((block) => ({
        hash: block.hash,
        parentHash: block.parentHash,
        transactions: [...block.transactions],
      }));
      const second = await explorer.ingest(p2, now, 0);
      const replay = await explorer.ingest(p2, now, 0);
      assert.equal(first.imported, 1);
      assert.equal(second.imported, 1);
      assert.equal(replay.imported, 0);
      const params = Object.values(explorer.chain.txs).filter((tx) => tx.type === 'poll_params');
      assert.equal(params.length, 2);
      assert.equal(explorer.latestPollRecord('poll_params', 'poll-1').payload.floor, 2);
      assert.deepEqual(
        explorer.chain.blocks.slice(0, published.length).map((block) => ({
          hash: block.hash,
          parentHash: block.parentHash,
          transactions: [...block.transactions],
        })),
        published,
      );
      const earlier = params.find((tx) => tx.payload.floor === 1);
      const latest = explorer.latestPollRecord('poll_params', 'poll-1');
      assert.equal(explorer.chain.supersededBy[earlier.hash], latest.hash);
      assert.equal(JSON.stringify(earlier).includes('supersededBy'), false);
      const t1 = await explorer.ingest({ outcomes: { poll_tally: [{ electionId: 'poll-1', yes: 1 }] } }, now, 0);
      const t2 = await explorer.ingest({ outcomes: { poll_tally: [{ electionId: 'poll-1', yes: 2 }] } }, now, 0);
      assert.equal(t1.imported, 1);
      assert.equal(t2.imported, 1);
      const tallies = Object.values(explorer.chain.txs).filter((tx) => tx.type === 'poll_tally');
      assert.equal(tallies.length, 2);
      assert.equal(explorer.latestPollRecord('poll_tally', 'poll-1').payload.yes, 2);
      assert.equal(params.length, 2);
      const reversed = {};
      const entries = Object.entries(explorer.chain.txs);
      for (let i = entries.length - 1; i >= 0; i -= 1) reversed[entries[i][0]] = entries[i][1];
      explorer.chain.txs = reversed;
      assert.equal(explorer.latestPollRecord('poll_tally', 'poll-1').payload.yes, 2);
      const sameBlock = await explorer.appendMany(
        'poll_tally',
        [
          { electionId: 'poll-idx', counts: [1] },
          { electionId: 'poll-idx', counts: [2] },
        ],
        now,
      );
      assert.equal(sameBlock.block.transactions.length, 2);
      assert.deepEqual(explorer.latestPollRecord('poll_tally', 'poll-idx').payload.counts, [2]);
      assert.equal(explorer.verifyBlockHashes(), true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('an older tally replay after the outcome cap does not replace the latest', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'explorer-ingest-'));
    try {
      const explorer = await Explorer.open({ dataDir: tmp, databaseUrl: '', chainId: 27427, quiet: true });
      const now = 50;
      explorer.disclosurePolicy = () => policy(now, 100);
      const tally = (counts) => ({ outcomes: { poll_tally: [{ electionId: 'poll-1', counts }] } });
      const first = await explorer.ingest(tally([1]), now, 0);
      const second = await explorer.ingest(tally([2]), now, 0);
      assert.equal(first.imported, 1);
      assert.equal(second.imported, 1);
      for (let i = 0; i < 65; i += 1) {
        const extra = await explorer.ingest(
          { outcomes: { poll_params: [{ electionId: `other-${i}`, floor: i }] } },
          now,
          0,
        );
        assert.equal(extra.imported, 1);
      }
      const before = explorer.chain.blocks.map((block) => ({
        hash: block.hash,
        parentHash: block.parentHash,
        txCount: block.txCount,
        transactions: [...block.transactions],
      }));
      const replay = await explorer.ingest(tally([1]), now, 0);
      assert.equal(replay.imported, 0);
      assert.deepEqual(explorer.latestPollRecord('poll_tally', 'poll-1').payload.counts, [2]);
      const stored = Object.values(explorer.chain.txs).filter(
        (tx) => tx.type === 'poll_tally' && String(tx.payload.electionId) === 'poll-1',
      );
      assert.equal(stored.length, 2);
      assert.deepEqual(
        explorer.chain.blocks.map((block) => ({
          hash: block.hash,
          parentHash: block.parentHash,
          txCount: block.txCount,
          transactions: [...block.transactions],
        })),
        before,
      );
      assert.equal(explorer.verifyBlockHashes(), true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('outcomes-only ingest keys stay within the cap', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'explorer-ingest-'));
    try {
      const explorer = await Explorer.open({ dataDir: tmp, databaseUrl: '', chainId: 27427, quiet: true });
      const now = 50;
      explorer.disclosurePolicy = () => policy(now, 100);
      for (let i = 0; i < OUTCOMES_ONLY_KEY_CAP + 1; i += 1) {
        const result = await explorer.ingest(
          { outcomes: { poll_params: [{ electionId: `poll-${i}`, floor: i }] } },
          now,
          0,
        );
        assert.equal(result.imported, 1);
      }
      assert.equal(explorer.chain.ingestedOutcomeKeys.length, OUTCOMES_ONLY_KEY_CAP);
      const oldest = await explorer.ingest(
        { outcomes: { poll_params: [{ electionId: 'poll-0', floor: 0 }] } },
        now,
        0,
      );
      assert.equal(oldest.imported, 0);
      assert.equal(explorer.chain.ingestedOutcomeKeys.length, OUTCOMES_ONLY_KEY_CAP);
      const newest = await explorer.ingest(
        { outcomes: { poll_params: [{ electionId: `poll-${OUTCOMES_ONLY_KEY_CAP}`, floor: OUTCOMES_ONLY_KEY_CAP }] } },
        now,
        0,
      );
      assert.equal(newest.imported, 0);
      assert.equal(explorer.chain.ingestedOutcomeKeys.length, OUTCOMES_ONLY_KEY_CAP);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

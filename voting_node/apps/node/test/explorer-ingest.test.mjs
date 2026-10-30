// A sealed choice row must not consume the block hash. A later block can
// import the choice once that block's timestamp is at the deadline.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import { Explorer } from '../src/explorer.mjs';

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
});

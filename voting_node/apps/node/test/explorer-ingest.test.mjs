// A sealed choice row must not consume the block hash. A later ingest can
// import it once the block timestamp is at the deadline.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import { Explorer } from '../src/explorer.mjs';

describe('explorer ingest', () => {
  test('a skipped choice row does not mark the block seen', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'explorer-ingest-'));
    try {
      const explorer = await Explorer.open({ dataDir: tmp, databaseUrl: '', chainId: 27427, quiet: true });
      const cutoff = 100;
      let now = 50;
      explorer.disclosurePolicy = () => ({
        electionContext() {
          return {
            known: true,
            vote: true,
            endTime: cutoff,
            resultsSealed: now < cutoff,
          };
        },
      });
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
      const released = await explorer.ingest({ block: { ...early, timestamp: cutoff } }, now, 0);
      assert.equal(released.imported, 1);
      assert.equal(explorer.chain.seenBlockHashes.includes(early.hash), true);
      const again = await explorer.ingest({ block: { ...early, timestamp: cutoff } }, now, 0);
      assert.equal(again.duplicate, true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

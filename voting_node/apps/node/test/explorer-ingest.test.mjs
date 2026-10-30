// A sealed choice row must not consume the block hash. A later block can
// import the choice once that block's timestamp is at the deadline.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import { Explorer, OUTCOMES_ONLY_KEY_CAP } from '../src/explorer.mjs';
import { l2Diag } from '../src/superAdmin/diagnostics.mjs';

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
            civic: { type: 'poll_params', pollId: 'poll-1', floor: 100 },
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
          poll_params: [{ pollId: 'poll-1', floor: 100 }],
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

  function sourceBlock(height, tag) {
    const hex = String(tag || height.toString(16)).padStart(2, '0');
    return { number: height, hash: `0x${hex.repeat(32)}`, timestamp: 50 };
  }

  test('a newer poll row is appended and readers follow source order', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'explorer-ingest-'));
    try {
      const explorer = await Explorer.open({ dataDir: tmp, databaseUrl: '', chainId: 27427, quiet: true });
      const now = 50;
      explorer.disclosurePolicy = () => policy(now, 100);
      const p1 = { block: sourceBlock(1), outcomes: { poll_params: [{ pollId: 'poll-1', floor: 1 }] } };
      const p2 = { block: sourceBlock(2), outcomes: { poll_params: [{ pollId: 'poll-1', floor: 2 }] } };
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
      assert.equal(replay.duplicate, true);
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
      const viewed = explorer.getTx(earlier.hash);
      assert.equal(viewed.superseded, true);
      assert.equal(viewed.supersededBy, latest.hash);
      assert.equal(viewed.payload.superseded, undefined);
      const t1 = await explorer.ingest(
        { block: sourceBlock(3), outcomes: { poll_tally: [{ pollId: 'poll-1', yes: 1 }] } },
        now,
        0,
      );
      const t2 = await explorer.ingest(
        { block: sourceBlock(4), outcomes: { poll_tally: [{ pollId: 'poll-1', yes: 2 }] } },
        now,
        0,
      );
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
      const indexed = await explorer.ingest(
        {
          block: sourceBlock(5, '55'),
          outcomes: {
            poll_tally: [
              { pollId: 'poll-idx', yes: 1 },
              { pollId: 'poll-idx', yes: 2 },
            ],
          },
        },
        now,
        0,
      );
      assert.equal(indexed.imported, 2);
      assert.equal(explorer.latestPollRecord('poll_tally', 'poll-idx').payload.yes, 2);
      assert.equal(explorer.verifyBlockHashes(), true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('a late unseen older tally does not replace the newer one', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'explorer-ingest-'));
    try {
      const explorer = await Explorer.open({ dataDir: tmp, databaseUrl: '', chainId: 27427, quiet: true });
      const now = 50;
      explorer.disclosurePolicy = () => policy(now, 100);
      const newer = await explorer.ingest(
        { block: sourceBlock(2), outcomes: { poll_tally: [{ pollId: 'poll-1', counts: [2] }] } },
        now,
        0,
      );
      assert.equal(newer.imported, 1);
      const late = await explorer.ingest(
        { block: sourceBlock(1, '11'), outcomes: { poll_tally: [{ pollId: 'poll-1', counts: [1] }] } },
        now,
        0,
      );
      assert.equal(late.imported, 0);
      assert.deepEqual(explorer.latestPollRecord('poll_tally', 'poll-1').payload.counts, [2]);
      const stored = Object.values(explorer.chain.txs).filter((tx) => tx.type === 'poll_tally');
      assert.equal(stored.length, 1);
      assert.equal(explorer.verifyBlockHashes(), true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('A then B then A rejects the final A as older', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'explorer-ingest-'));
    try {
      const explorer = await Explorer.open({ dataDir: tmp, databaseUrl: '', chainId: 27427, quiet: true });
      const now = 50;
      explorer.disclosurePolicy = () => policy(now, 100);
      const row = (yes, height, tag) => ({
        block: sourceBlock(height, tag),
        outcomes: { poll_tally: [{ pollId: 'poll-seq', yes }] },
      });
      assert.equal((await explorer.ingest(row('A', 1, 'a1'), now, 0)).imported, 1);
      assert.equal((await explorer.ingest(row('B', 2, 'b2'), now, 0)).imported, 1);
      const again = await explorer.ingest(row('A', 1, 'a3'), now, 0);
      assert.equal(again.imported, 0);
      assert.equal(explorer.latestPollRecord('poll_tally', 'poll-seq').payload.yes, 'B');
      const stored = Object.values(explorer.chain.txs).filter((tx) => tx.type === 'poll_tally');
      assert.equal(stored.length, 2);
      assert.equal(explorer.verifyBlockHashes(), true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('electionId is the fallback when pollId is absent', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'explorer-ingest-'));
    try {
      const explorer = await Explorer.open({ dataDir: tmp, databaseUrl: '', chainId: 27427, quiet: true });
      const now = 50;
      explorer.disclosurePolicy = () => policy(now, 100);
      const first = await explorer.ingest(
        { block: sourceBlock(1, 'e1'), outcomes: { poll_params: [{ electionId: 'poll-1', floor: 1 }] } },
        now,
        0,
      );
      const second = await explorer.ingest(
        { block: sourceBlock(2, 'e2'), outcomes: { poll_params: [{ electionId: 'poll-1', floor: 2 }] } },
        now,
        0,
      );
      assert.equal(first.imported, 1);
      assert.equal(second.imported, 1);
      assert.equal(explorer.latestPollRecord('poll_params', 'poll-1').payload.floor, 2);
      const late = await explorer.ingest(
        { block: sourceBlock(1, 'e3'), outcomes: { poll_params: [{ electionId: 'poll-1', floor: 0 }] } },
        now,
        0,
      );
      assert.equal(late.imported, 0);
      assert.equal(explorer.latestPollRecord('poll_params', 'poll-1').payload.floor, 2);
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
      const tally = (counts, height, tag) => ({
        block: sourceBlock(height, tag),
        outcomes: { poll_tally: [{ pollId: 'poll-1', counts }] },
      });
      const first = await explorer.ingest(tally([1], 1, 'c1'), now, 0);
      const second = await explorer.ingest(tally([2], 2, 'c2'), now, 0);
      assert.equal(first.imported, 1);
      assert.equal(second.imported, 1);
      for (let i = 0; i < 65; i += 1) {
        const extra = await explorer.ingest(
          { outcomes: { poll_params: [{ pollId: `other-${i}`, floor: i }] } },
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
      const replay = await explorer.ingest(tally([1], 1, 'c3'), now, 0);
      assert.equal(replay.imported, 0);
      assert.deepEqual(explorer.latestPollRecord('poll_tally', 'poll-1').payload.counts, [2]);
      const stored = Object.values(explorer.chain.txs).filter(
        (tx) => tx.type === 'poll_tally' && String(tx.payload.pollId) === 'poll-1',
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
          { outcomes: { poll_params: [{ pollId: `poll-${i}`, floor: i }] } },
          now,
          0,
        );
        assert.equal(result.imported, 1);
      }
      assert.equal(explorer.chain.ingestedOutcomeKeys.length, OUTCOMES_ONLY_KEY_CAP);
      const oldest = await explorer.ingest(
        { outcomes: { poll_params: [{ pollId: 'poll-0', floor: 0 }] } },
        now,
        0,
      );
      assert.equal(oldest.imported, 0);
      assert.equal(explorer.chain.ingestedOutcomeKeys.length, OUTCOMES_ONLY_KEY_CAP);
      const newest = await explorer.ingest(
        { outcomes: { poll_params: [{ pollId: `poll-${OUTCOMES_ONLY_KEY_CAP}`, floor: OUTCOMES_ONLY_KEY_CAP }] } },
        now,
        0,
      );
      assert.equal(newest.imported, 0);
      assert.equal(explorer.chain.ingestedOutcomeKeys.length, OUTCOMES_ONLY_KEY_CAP);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  function realTally(pollId, closeBlock, extra = {}) {
    const row = {
      pollId,
      ballotsRoot: `0x${'ab'.repeat(32)}`,
      resultHash: `0x${'cd'.repeat(32)}`,
      participation: '1',
      outcome: 'yes',
      ...extra,
    };
    if (closeBlock != null) row.closeBlock = closeBlock;
    return row;
  }

  function realParams(pollId, extra = {}) {
    return {
      pollId,
      pollParamsHash: `0x${'aa'.repeat(32)}`,
      token: `0x${'11'.repeat(20)}`,
      tokenChainId: 1,
      startTime: 10,
      cutoffTime: 100,
      ...extra,
    };
  }

  test('a later closeBlock stays latest when an earlier closeBlock arrives late', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'explorer-ingest-'));
    try {
      const explorer = await Explorer.open({ dataDir: tmp, databaseUrl: '', chainId: 27427, quiet: true });
      const now = 50;
      explorer.disclosurePolicy = () => policy(now, 100);
      const first = await explorer.ingest(
        { outcomes: { poll_tally: [realTally('poll-1', 20)] } },
        now,
        0,
      );
      const late = await explorer.ingest(
        {
          outcomes: {
            poll_tally: [realTally('poll-1', 10, { ballotsRoot: `0x${'ef'.repeat(32)}`, outcome: 'no' })],
          },
        },
        now,
        0,
      );
      assert.equal(first.imported, 1);
      assert.equal(late.imported, 0);
      const latest = explorer.latestPollRecord('poll_tally', 'poll-1');
      assert.equal(latest.payload.closeBlock, 20);
      assert.equal(explorer.getTx(latest.hash).superseded, undefined);
      assert.equal(explorer.chain.supersededBy[latest.hash], undefined);
      const stored = Object.values(explorer.chain.txs).filter((tx) => tx.type === 'poll_tally');
      assert.equal(stored.length, 1);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('an unordered row after a known latest is appended unranked and alerts', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'explorer-ingest-'));
    try {
      const explorer = await Explorer.open({ dataDir: tmp, databaseUrl: '', chainId: 27427, quiet: true });
      const now = 50;
      explorer.disclosurePolicy = () => policy(now, 100);
      assert.equal(
        (await explorer.ingest({ outcomes: { poll_tally: [realTally('poll-1', 20)] } }, now, 0)).imported,
        1,
      );
      const latest = explorer.latestPollRecord('poll_tally', 'poll-1');
      const unknown = await explorer.ingest(
        {
          outcomes: {
            poll_tally: [
              realTally('poll-1', null, {
                participation: '2',
                outcome: 'no',
                ballotsRoot: `0x${'12'.repeat(32)}`,
              }),
            ],
          },
        },
        now,
        0,
      );
      assert.equal(unknown.imported, 1);
      assert.equal(explorer.latestPollRecord('poll_tally', 'poll-1').hash, latest.hash);
      assert.equal(explorer.latestPollRecord('poll_tally', 'poll-1').payload.closeBlock, 20);
      assert.equal(explorer.chain.supersededBy[latest.hash], undefined);
      const stored = Object.values(explorer.chain.txs).filter((tx) => tx.type === 'poll_tally');
      assert.equal(stored.length, 2);
      const alerts = explorer.chain.alerts || [];
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0].kind, 'poll_order_unknown');
      assert.equal(alerts[0].pollId, 'poll-1');
      const unknownTx = stored.find((tx) => tx.payload.participation === '2');
      assert.equal(alerts[0].hash, unknownTx.hash);
      assert.deepEqual(Object.keys(alerts[0]).sort(), ['hash', 'kind', 'pollId']);
      assert.equal(explorer.getTx(unknownTx.hash).orderUnknown, true);
      assert.equal(explorer.getTx(latest.hash).orderUnknown, undefined);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('poll params order by sequence and by postedAt', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'explorer-ingest-'));
    try {
      const explorer = await Explorer.open({ dataDir: tmp, databaseUrl: '', chainId: 27427, quiet: true });
      const now = 50;
      explorer.disclosurePolicy = () => policy(now, 100);
      const seq1 = await explorer.ingest(
        { outcomes: { poll_params: [realParams('poll-1', { sequence: 1, postedAt: 50 })] } },
        now,
        0,
      );
      const seq2 = await explorer.ingest(
        {
          outcomes: {
            poll_params: [realParams('poll-1', { sequence: 2, postedAt: 10, pollParamsHash: `0x${'bb'.repeat(32)}` })],
          },
        },
        now,
        0,
      );
      const seqLate = await explorer.ingest(
        {
          outcomes: {
            poll_params: [realParams('poll-1', { sequence: 1, postedAt: 90, pollParamsHash: `0x${'cc'.repeat(32)}` })],
          },
        },
        now,
        0,
      );
      assert.equal(seq1.imported, 1);
      assert.equal(seq2.imported, 1);
      assert.equal(seqLate.imported, 0);
      assert.equal(explorer.latestPollRecord('poll_params', 'poll-1').payload.sequence, 2);
      const early = await explorer.ingest(
        { outcomes: { poll_params: [realParams('poll-when', { postedAt: 20 })] } },
        now,
        0,
      );
      const older = await explorer.ingest(
        {
          outcomes: {
            poll_params: [realParams('poll-when', { postedAt: 10, pollParamsHash: `0x${'dd'.repeat(32)}` })],
          },
        },
        now,
        0,
      );
      const newer = await explorer.ingest(
        {
          outcomes: {
            poll_params: [realParams('poll-when', { postedAt: 30, pollParamsHash: `0x${'ee'.repeat(32)}` })],
          },
        },
        now,
        0,
      );
      assert.equal(early.imported, 1);
      assert.equal(older.imported, 0);
      assert.equal(newer.imported, 1);
      assert.equal(explorer.latestPollRecord('poll_params', 'poll-when').payload.postedAt, 30);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('a cleared source order is recovered on load so a later closeBlock becomes latest', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'explorer-ingest-'));
    try {
      const explorer = await Explorer.open({ dataDir: tmp, databaseUrl: '', chainId: 27427, quiet: true });
      const now = 50;
      explorer.disclosurePolicy = () => policy(now, 100);
      assert.equal(
        (await explorer.ingest({ outcomes: { poll_tally: [realTally('poll-1', 20)] } }, now, 0)).imported,
        1,
      );
      const first = explorer.latestPollRecord('poll_tally', 'poll-1');
      delete explorer.chain.sourceOrder[first.hash];
      await explorer.persist();
      const reloaded = await Explorer.open({ dataDir: tmp, databaseUrl: '', chainId: 27427, quiet: true });
      reloaded.disclosurePolicy = () => policy(now, 100);
      const later = await reloaded.ingest(
        {
          outcomes: {
            poll_tally: [realTally('poll-1', 40, { ballotsRoot: `0x${'40'.repeat(32)}`, participation: '4' })],
          },
        },
        now,
        0,
      );
      assert.equal(later.imported, 1);
      const latest = reloaded.latestPollRecord('poll_tally', 'poll-1');
      assert.equal(latest.payload.closeBlock, 40);
      assert.equal(reloaded.chain.supersededBy[first.hash], latest.hash);
      assert.equal(reloaded.chain.sourceOrder[first.hash].closeBlock, 20);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('the same closeBlock with a different tally alerts and does not replace latest', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'explorer-ingest-'));
    try {
      const explorer = await Explorer.open({ dataDir: tmp, databaseUrl: '', chainId: 27427, quiet: true });
      const now = 50;
      explorer.disclosurePolicy = () => policy(now, 100);
      assert.equal(
        (await explorer.ingest({ outcomes: { poll_tally: [realTally('poll-1', 20)] } }, now, 0)).imported,
        1,
      );
      const first = explorer.latestPollRecord('poll_tally', 'poll-1');
      const conflict = await explorer.ingest(
        {
          outcomes: {
            poll_tally: [realTally('poll-1', 20, { ballotsRoot: `0x${'99'.repeat(32)}`, participation: '9' })],
          },
        },
        now,
        0,
      );
      assert.equal(conflict.imported, 0);
      assert.equal(explorer.latestPollRecord('poll_tally', 'poll-1').hash, first.hash);
      assert.equal(explorer.chain.supersededBy[first.hash], undefined);
      const stored = Object.values(explorer.chain.txs).filter((tx) => tx.type === 'poll_tally');
      assert.equal(stored.length, 1);
      assert.equal(explorer.chain.alerts.length, 1);
      assert.equal(explorer.chain.alerts[0].kind, 'poll_tally_conflict');
      assert.equal(explorer.chain.alerts[0].pollId, 'poll-1');
      assert.equal(explorer.chain.alerts[0].hash, first.hash);
      assert.deepEqual(Object.keys(explorer.chain.alerts[0]).sort(), ['hash', 'kind', 'pollId']);
      const replay = await explorer.ingest({ outcomes: { poll_tally: [realTally('poll-1', 20)] } }, now, 0);
      assert.equal(replay.imported, 0);
      assert.equal(explorer.chain.alerts.length, 1);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('a shared poll params sequence alerts and a later postedAt becomes latest', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'explorer-ingest-'));
    try {
      const explorer = await Explorer.open({ dataDir: tmp, databaseUrl: '', chainId: 27427, quiet: true });
      const now = 50;
      explorer.disclosurePolicy = () => policy(now, 100);
      assert.equal(
        (await explorer.ingest(
          { outcomes: { poll_params: [realParams('poll-1', { sequence: 4, postedAt: 100 })] } },
          now,
          0,
        )).imported,
        1,
      );
      const first = explorer.latestPollRecord('poll_params', 'poll-1');
      const later = await explorer.ingest(
        {
          outcomes: {
            poll_params: [realParams('poll-1', { sequence: 4, postedAt: 180, pollParamsHash: `0x${'33'.repeat(32)}` })],
          },
        },
        now,
        0,
      );
      assert.equal(later.imported, 1);
      const newest = explorer.latestPollRecord('poll_params', 'poll-1');
      assert.equal(newest.payload.postedAt, 180);
      assert.equal(newest.payload.sequence, 4);
      assert.equal(explorer.chain.supersededBy[first.hash], newest.hash);
      assert.equal(explorer.chain.alerts.length, 1);
      assert.equal(explorer.chain.alerts[0].kind, 'poll_params_conflict');
      assert.equal(explorer.chain.alerts[0].pollId, 'poll-1');
      assert.equal(explorer.chain.alerts[0].hash, first.hash);
      assert.deepEqual(Object.keys(explorer.chain.alerts[0]).sort(), ['hash', 'kind', 'pollId']);
      const replay = await explorer.ingest(
        {
          outcomes: {
            poll_params: [realParams('poll-1', { sequence: 4, postedAt: 180, pollParamsHash: `0x${'33'.repeat(32)}` })],
          },
        },
        now,
        0,
      );
      assert.equal(replay.imported, 0);
      assert.equal(explorer.chain.alerts.length, 1);
      const nextSequence = await explorer.ingest(
        {
          outcomes: {
            poll_params: [realParams('poll-1', { sequence: 5, postedAt: 1, pollParamsHash: `0x${'44'.repeat(32)}` })],
          },
        },
        now,
        0,
      );
      assert.equal(nextSequence.imported, 1);
      assert.equal(explorer.latestPollRecord('poll_params', 'poll-1').payload.sequence, 5);
      assert.equal(explorer.chain.alerts.length, 1);

      assert.equal(
        (await explorer.ingest(
          { outcomes: { poll_params: [realParams('poll-tie', { sequence: 4, postedAt: 100 })] } },
          now,
          0,
        )).imported,
        1,
      );
      const tied = explorer.latestPollRecord('poll_params', 'poll-tie');
      const sameClock = await explorer.ingest(
        {
          outcomes: {
            poll_params: [realParams('poll-tie', { sequence: 4, postedAt: 100, pollParamsHash: `0x${'11'.repeat(32)}` })],
          },
        },
        now,
        0,
      );
      const earlier = await explorer.ingest(
        {
          outcomes: {
            poll_params: [realParams('poll-tie', { sequence: 4, postedAt: 40, pollParamsHash: `0x${'22'.repeat(32)}` })],
          },
        },
        now,
        0,
      );
      assert.equal(sameClock.imported, 0);
      assert.equal(earlier.imported, 0);
      assert.equal(explorer.latestPollRecord('poll_params', 'poll-tie').hash, tied.hash);
      const tieAlerts = explorer.chain.alerts.filter((row) => row.pollId === 'poll-tie');
      assert.equal(tieAlerts.length, 2);
      for (const alert of tieAlerts) {
        assert.equal(alert.kind, 'poll_params_conflict');
        assert.equal(alert.hash, tied.hash);
        assert.deepEqual(Object.keys(alert).sort(), ['hash', 'kind', 'pollId']);
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('explorer alerts stay at the last 20 and the ops diagnostic shows them', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'explorer-ingest-'));
    try {
      const explorer = await Explorer.open({ dataDir: tmp, databaseUrl: '', chainId: 27427, quiet: true });
      for (let i = 0; i < 25; i += 1) {
        await explorer.noteAlert({ kind: 'poll_order_unknown', pollId: 'poll-1', hash: `h${i}` });
      }
      assert.equal(explorer.chain.alerts.length, 20);
      assert.equal(explorer.chain.alerts[0].hash, 'h5');
      assert.equal(explorer.chain.alerts[19].hash, 'h24');
      const diag = l2Diag({
        explorer,
        config: { dataDir: tmp, nowFn: () => 50 },
        store: { data: {} },
        chain: {},
      });
      assert.equal(diag.explorer.alerts.length, 20);
      assert.equal(diag.explorer.alerts[0].hash, 'h5');
      assert.equal(diag.explorer.alerts.at(-1).kind, 'poll_order_unknown');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('append records source order for poll rows and not for ballots', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'explorer-ingest-'));
    try {
      const explorer = await Explorer.open({ dataDir: tmp, databaseUrl: '', chainId: 27427, quiet: true });
      const vote = await explorer.append('vote', { nullifier: 'n-1', ballotHash: '0xbb', electionId: 'poll-1' });
      const pollVote = await explorer.append('poll_vote', { pollId: 'poll-1', nullifier: 'n-2' });
      const tally = await explorer.append('poll_tally', realTally('poll-1', 20));
      assert.equal(explorer.chain.sourceOrder[vote.tx.hash], undefined);
      assert.equal(explorer.chain.sourceOrder[pollVote.tx.hash], undefined);
      assert.equal(explorer.chain.sourceOrder[tally.tx.hash].closeBlock, 20);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

// NOT FOR PROFIT — civic public good, not a commercial product.
// A vote publishes ballot rows on the hourly gate. Choice totals wait until cutoff.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { ChainState, loadConfig } from '../sequencer/state.mjs';

const HOUR = 3600;
const HOUR_START = 1_699_999_200;

function civicHex(obj) {
  return '0x' + Buffer.from(JSON.stringify(obj), 'utf8').toString('hex');
}

function voteTxs(block) {
  const txs = block?.transactions || [];
  return txs.filter((tx) => String(tx.civicType || tx.civic?.type || '').toLowerCase() === 'vote');
}

function tallyTxs(block) {
  const txs = block?.transactions || [];
  return txs.filter((tx) => String(tx.civicType || tx.civic?.type || '').toLowerCase() === 'tally');
}

describe('L2 vote turnout and sealed choice results', () => {
  let tmp;
  let clock;
  let state;

  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'l2-election-type-'));
    clock = HOUR_START + 10 * 60;
    const config = loadConfig();
    config.dataDir = tmp;
    config.disclosureIntervalSeconds = HOUR;
    config.disclosureDelaySeconds = 0;
    config.resultsMinVotes = 0;
    config.disclosureMinBlockVotes = 1;
    config.admission = 'open';
    config.nowFn = () => clock;
    config.zkVotingNodeUrl = '';
    state = ChainState.open(config);
  });

  after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test('a vote is published after the hour and a tally is refused before cutoff', async () => {
    const cutoff = HOUR_START + 5 * HOUR;
    state.enqueueRaw(
      civicHex({
        type: 'election_open',
        electionId: 'vote-1',
        electionType: 1,
        cutoffTime: cutoff,
      }),
    );
    state.enqueueRaw(
      civicHex({
        type: 'vote',
        electionId: 'vote-1',
        nullifier: '0xabc',
        ballotHash: '0xdef',
      }),
    );
    const early = await state.produceBlock();
    assert.equal(voteTxs(early).length, 0);
    assert.equal(tallyTxs(early).length, 0);
    assert.equal(state.electionInfo('vote-1').votesSealedInBlocks, 0);
    assert.equal(state.electionInfo('vote-1').tally, null);

    clock = HOUR_START + HOUR;
    const disclosed = await state.produceBlock();
    assert.equal(voteTxs(disclosed).length, 1);
    assert.equal(state.electionInfo('vote-1').votesSealedInBlocks, 1);
    assert.equal(state.electionInfo('vote-1').tally, null);
    const published = JSON.stringify(disclosed);
    assert.equal(published.includes('"counts"'), false);

    assert.throws(
      () =>
        state.enqueueRaw(
          civicHex({
            type: 'tally',
            electionId: 'vote-1',
            counts: [1, 0],
            countsHash: `0x${'11'.repeat(32)}`,
          }),
        ),
      /choice results are sealed until cutoff/,
    );

    clock = cutoff;
    state.enqueueRaw(
      civicHex({
        type: 'tally',
        electionId: 'vote-1',
        countsHash: `0x${'22'.repeat(32)}`,
      }),
    );
    const after = await state.produceBlock();
    assert.equal(tallyTxs(after).length, 1);
    assert.equal(state.electionInfo('vote-1').tally.counts, null);
    assert.ok(state.electionInfo('vote-1').tally.countsHash);
  });

  test('an unknown election type is rejected', () => {
    assert.throws(
      () =>
        state.enqueueRaw(
          civicHex({
            type: 'election_open',
            electionId: 'bad-type',
            electionType: 'nope',
          }),
        ),
      /electionType/,
    );
  });
});

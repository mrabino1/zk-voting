// NOT FOR PROFIT — civic public good, not a commercial product.
// A vote uses the same hourly clock as a poll. Choice results stay sealed until cutoff.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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

  test('a vote publishes on the same hour as a poll, and choice results stay sealed', async () => {
    const cutoff = HOUR_START + 5 * HOUR;
    const voteOf = (block, id) =>
      voteTxs(block).filter((tx) => String(tx.civic?.electionId) === id);
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
        type: 'election_open',
        electionId: 'poll-1',
        electionType: 0,
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
    state.enqueueRaw(
      civicHex({
        type: 'vote',
        electionId: 'poll-1',
        nullifier: '0xpoll',
        ballotHash: '0x111',
      }),
    );
    const early = await state.produceBlock();
    assert.equal(voteOf(early, 'vote-1').length, 0);
    assert.equal(voteOf(early, 'poll-1').length, 0);
    assert.equal(state.electionInfo('vote-1').votesSealedInBlocks, 0);
    assert.equal(state.electionInfo('vote-1').tally, null);

    clock = HOUR_START + HOUR + 30;
    state.enqueueRaw(
      civicHex({
        type: 'vote',
        electionId: 'vote-1',
        nullifier: '0xaaa',
        ballotHash: '0xbbb',
      }),
    );
    const hour = await state.produceBlock();
    assert.equal(voteOf(hour, 'vote-1').length, 1);
    assert.equal(voteOf(hour, 'poll-1').length, 1);
    assert.equal(state.electionInfo('vote-1').votesSealedInBlocks, 1);
    assert.equal(state.electionInfo('vote-1').tally, null);

    clock = HOUR_START + 2 * HOUR + 30;
    state.enqueueRaw(
      civicHex({
        type: 'vote',
        electionId: 'vote-1',
        nullifier: '0xccc',
        ballotHash: '0xddd',
      }),
    );
    const later = await state.produceBlock();
    assert.equal(voteOf(later, 'vote-1').length, 1);
    assert.equal(state.electionInfo('vote-1').votesSealedInBlocks, 2);
    assert.equal(state.electionInfo('vote-1').tally, null);
    assert.equal(JSON.stringify(later).includes('"counts"'), false);

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
    const released = await state.produceBlock();
    assert.equal(voteOf(released, 'vote-1').length, 1);
    assert.equal(state.electionInfo('vote-1').votesSealedInBlocks, 3);
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

  test('the open hour is the final block at the deadline for both types', async () => {
    let finalClock = HOUR_START + 10 * 60;
    const finalDir = path.join(tmp, 'final');
    await mkdir(finalDir, { recursive: true });
    const config = loadConfig();
    config.dataDir = finalDir;
    config.disclosureIntervalSeconds = HOUR;
    config.disclosureDelaySeconds = 0;
    config.resultsMinVotes = 0;
    config.disclosureMinBlockVotes = 1;
    config.admission = 'open';
    config.nowFn = () => finalClock;
    config.zkVotingNodeUrl = '';
    const finalState = ChainState.open(config);
    const end = HOUR_START + 40 * 60;
    finalState.enqueueRaw(
      civicHex({
        type: 'election_open',
        electionId: 'vote-final',
        electionType: 1,
        cutoffTime: end,
      }),
    );
    finalState.enqueueRaw(
      civicHex({
        type: 'election_open',
        electionId: 'poll-final',
        electionType: 0,
        cutoffTime: end,
      }),
    );
    finalState.enqueueRaw(
      civicHex({ type: 'vote', electionId: 'vote-final', nullifier: '0xv1', ballotHash: '0xb1' }),
    );
    finalState.enqueueRaw(
      civicHex({ type: 'vote', electionId: 'poll-final', nullifier: '0xp1', ballotHash: '0xb2' }),
    );
    const held = await finalState.produceBlock();
    const of = (block, id) => voteTxs(block).filter((tx) => String(tx.civic?.electionId) === id);
    assert.equal(of(held, 'vote-final').length, 0);
    assert.equal(of(held, 'poll-final').length, 0);
    finalClock = end - 1;
    assert.throws(
      () =>
        finalState.enqueueRaw(
          civicHex({ type: 'tally', electionId: 'vote-final', countsHash: `0x${'33'.repeat(32)}` }),
        ),
      /choice results are sealed until cutoff/,
    );
    finalClock = end;
    const finalBlock = await finalState.produceBlock();
    assert.equal(of(finalBlock, 'vote-final').length, 1);
    assert.equal(of(finalBlock, 'poll-final').length, 1);
    assert.equal(finalState.electionInfo('vote-final').votesSealedInBlocks, 1);
    assert.equal(finalState.electionInfo('vote-final').tally, null);
  });

  test('interval 0 publishes a vote and a poll, and the vote has no choice total', async () => {
    let instantClock = HOUR_START + 10 * 60;
    const instantDir = path.join(tmp, 'instant');
    await mkdir(instantDir, { recursive: true });
    const config = loadConfig();
    config.dataDir = instantDir;
    config.disclosureIntervalSeconds = 0;
    config.disclosureDelaySeconds = 0;
    config.resultsMinVotes = 0;
    config.disclosureMinBlockVotes = 1;
    config.admission = 'open';
    config.nowFn = () => instantClock;
    config.zkVotingNodeUrl = '';
    const instant = ChainState.open(config);
    const cutoff = HOUR_START + 5 * HOUR;
    instant.enqueueRaw(
      civicHex({
        type: 'election_open',
        electionId: 'vote-now',
        electionType: 1,
        cutoffTime: cutoff,
      }),
    );
    instant.enqueueRaw(
      civicHex({
        type: 'election_open',
        electionId: 'poll-now',
        electionType: 0,
        cutoffTime: cutoff,
      }),
    );
    instant.enqueueRaw(
      civicHex({ type: 'vote', electionId: 'vote-now', nullifier: '0x1', ballotHash: '0x2' }),
    );
    instant.enqueueRaw(
      civicHex({ type: 'vote', electionId: 'poll-now', nullifier: '0x3', ballotHash: '0x4' }),
    );
    const block = await instant.produceBlock();
    const votes = voteTxs(block);
    assert.equal(votes.filter((tx) => tx.civic?.electionId === 'vote-now').length, 1);
    assert.equal(votes.filter((tx) => tx.civic?.electionId === 'poll-now').length, 1);
    assert.equal(instant.electionInfo('vote-now').votesSealedInBlocks, 1);
    assert.equal(instant.electionInfo('vote-now').tally, null);
  });

  test('a tally for an election this L2 never opened is refused', () => {
    assert.throws(
      () =>
        state.enqueueRaw(
          civicHex({
            type: 'tally',
            electionId: 'never-opened',
            countsHash: `0x${'ab'.repeat(32)}`,
          }),
        ),
      /unknown election on this L2/,
    );
  });

  test('a replayed invalid type seals choices and still publishes ballots', async () => {
    const warnings = [];
    const orig = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      state._indexCivic({
        hash: '0xbad',
        civicType: 'election_open',
        civic: {
          type: 'election_open',
          electionId: 'bad-replay',
          electionType: 'nope',
          cutoffTime: HOUR_START + 9 * HOUR,
        },
      });
    } finally {
      console.warn = orig;
    }
    const info = state.electionInfo('bad-replay');
    assert.equal(info.typeInvalid, true);
    assert.equal(info.electionType, null);
    assert.equal(info.tally, null);
    assert.equal(info.votesSealedInBlocks, 0);
    assert.match(warnings.join('\n'), /invalid election type on this L2; choice results for bad-replay stay sealed/);
    assert.throws(
      () =>
        state.enqueueRaw(
          civicHex({
            type: 'tally',
            electionId: 'bad-replay',
            countsHash: `0x${'cd'.repeat(32)}`,
          }),
        ),
      /choice results are sealed until cutoff/,
    );
    state.enqueueRaw(
      civicHex({ type: 'vote', electionId: 'bad-replay', nullifier: '0xbadvote', ballotHash: '0xbadhash' }),
    );
    clock = HOUR_START + 6 * HOUR + 30;
    const block = await state.produceBlock();
    assert.equal(voteTxs(block).filter((tx) => tx.civic?.electionId === 'bad-replay').length, 1);
    assert.equal(state.electionInfo('bad-replay').votesSealedInBlocks, 1);
    assert.equal(state.electionInfo('bad-replay').tally, null);
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

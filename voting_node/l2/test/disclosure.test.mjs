// NOT FOR PROFIT — civic public good, not a commercial product.
// Sealed vote mempool: vote txs are not public until the hour that contained
// them has closed.

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
  return txs.filter((tx) => {
    if (typeof tx === 'string') return false;
    return String(tx.civicType || tx.civic?.type || '').toLowerCase() === 'vote';
  });
}

describe('L2 sealed vote disclosure', () => {
  let tmp;
  let clock;
  let state;

  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-l2-hourly-'));
    clock = HOUR_START + 10 * 60;
    const config = loadConfig();
    config.dataDir = tmp;
    config.disclosureIntervalSeconds = HOUR;
    config.disclosureDelaySeconds = 0;
    config.resultsMinVotes = 0;
    config.disclosureMinBlockVotes = 1;
    config.nowFn = () => clock;
    config.zkVotingNodeUrl = '';
    state = ChainState.open(config);
  });

  after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test('vote is accepted but hidden from pending, blocks, and getTransactionByHash', async () => {
    const hash = state.enqueueRaw(
      civicHex({
        type: 'vote',
        electionId: '1',
        nullifier: '0xabc',
        ballotHash: '0xdef',
      }),
    );
    assert.match(hash, /^0x[0-9a-f]+$/);
    assert.equal(state.getTransactionByHash(hash), null);

    const pending = state.getBlockByNumber('pending', true);
    assert.equal(voteTxs(pending).length, 0);

    const view = state.disclosureView();
    assert.equal(view.lastClosedHourAt, HOUR_START);
    assert.equal(view.secondsUntilNext, HOUR - 10 * 60);
    assert.equal(view.pending, undefined);

    const mined = await state.produceBlock();
    assert.equal(voteTxs(mined).length, 0);
    assert.equal(state.getTransactionByHash(hash), null);

    clock = HOUR_START + HOUR;
    const disclosed = await state.produceBlock();
    const votes = voteTxs(disclosed);
    assert.equal(votes.length, 1);
    assert.equal(votes[0].hash.toLowerCase(), hash.toLowerCase());
    assert.equal(votes[0].receivedAt, undefined);
    assert.ok(state.getTransactionByHash(hash));
    assert.equal(disclosed.timestamp, HOUR_START + HOUR);
  });

  test('two votes in the same hour are lumped and ordered by hash, not arrival', async () => {
    clock = HOUR_START + HOUR + 90;
    const first = state.enqueueRaw(
      civicHex({ type: 'vote', electionId: '9', nullifier: '0xbb', ballotHash: '0x1' }),
    );
    const second = state.enqueueRaw(
      civicHex({ type: 'vote', electionId: '9', nullifier: '0xaa', ballotHash: '0x2' }),
    );
    await state.produceBlock();
    assert.equal(state.getTransactionByHash(first), null);
    assert.equal(state.getTransactionByHash(second), null);

    clock = HOUR_START + 2 * HOUR;
    const disclosed = await state.produceBlock();
    const votes = voteTxs(disclosed);
    assert.equal(votes.length, 2);
    const hashes = votes.map((tx) => tx.hash.toLowerCase());
    assert.deepEqual(hashes, [...hashes].sort());
    assert.equal(disclosed.timestamp, HOUR_START + 2 * HOUR);
  });
});

describe('L2 delay, results gate, and small blocks', () => {
  let tmp;
  let clock;
  let state;

  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-l2-delay-'));
    clock = HOUR_START + 59 * 60;
    const config = loadConfig();
    config.dataDir = tmp;
    config.disclosureIntervalSeconds = HOUR;
    config.disclosureDelaySeconds = 1800;
    config.resultsMinVotes = 0;
    config.disclosureMinBlockVotes = 1;
    config.nowFn = () => clock;
    config.zkVotingNodeUrl = '';
    state = ChainState.open(config);
  });

  after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test('08:59 stays sealed at 09:00 and the block time is 09:30', async () => {
    const hash = state.enqueueRaw(
      civicHex({ type: 'vote', electionId: 'delay', nullifier: '0x11', ballotHash: '0x22' }),
    );
    clock = HOUR_START + HOUR;
    const atClose = await state.produceBlock();
    assert.equal(voteTxs(atClose).length, 0);
    assert.equal(state.getTransactionByHash(hash), null);

    clock = HOUR_START + HOUR + 1800 + 5;
    const disclosed = await state.produceBlock();
    assert.equal(voteTxs(disclosed).length, 1);
    assert.equal(disclosed.timestamp, HOUR_START + HOUR + 1800);
    assert.ok(state.getTransactionByHash(hash));
  });
});

describe('L2 results gate and minimum block size', () => {
  let tmp;
  let clock;
  let state;

  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-l2-gate-'));
    clock = HOUR_START + 20 * 60;
    const config = loadConfig();
    config.dataDir = tmp;
    config.disclosureIntervalSeconds = HOUR;
    config.disclosureDelaySeconds = 0;
    config.resultsMinVotes = 3;
    config.disclosureMinBlockVotes = 1;
    config.nowFn = () => clock;
    config.zkVotingNodeUrl = '';
    state = ChainState.open(config);
  });

  after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test('two votes publish after the hour before the results minimum', async () => {
    state.enqueueRaw(civicHex({ type: 'vote', electionId: 'gate', nullifier: '0x1', ballotHash: '0x1' }));
    state.enqueueRaw(civicHex({ type: 'vote', electionId: 'gate', nullifier: '0x2', ballotHash: '0x2' }));
    clock = HOUR_START + HOUR;
    const early = await state.produceBlock();
    assert.equal(voteTxs(early).length, 2);

    clock = HOUR_START + HOUR + 30;
    state.enqueueRaw(civicHex({ type: 'vote', electionId: 'gate', nullifier: '0x3', ballotHash: '0x3' }));
    const opened = await state.produceBlock();
    assert.equal(voteTxs(opened).length, 0);
  });

  test('a short hour waits, then merges, and a below-minimum election waits for tally', async () => {
    clock = HOUR_START + 2 * HOUR + 10 * 60;
    state.enqueueRaw(civicHex({ type: 'vote', electionId: 'small', nullifier: '0xa', ballotHash: '0xa' }));
    state.enqueueRaw(civicHex({ type: 'vote', electionId: 'small', nullifier: '0xb', ballotHash: '0xb' }));
    state.config.disclosureMinBlockVotes = 4;
    state.config.resultsMinVotes = 0;
    clock = HOUR_START + 3 * HOUR;
    const held = await state.produceBlock();
    assert.equal(voteTxs(held).filter((tx) => String(tx.civic?.electionId) === 'small').length, 0);

    clock = HOUR_START + 3 * HOUR + 10 * 60;
    state.enqueueRaw(civicHex({ type: 'vote', electionId: 'small', nullifier: '0xc', ballotHash: '0xc' }));
    state.enqueueRaw(civicHex({ type: 'vote', electionId: 'small', nullifier: '0xd', ballotHash: '0xd' }));
    clock = HOUR_START + 4 * HOUR;
    const merged = await state.produceBlock();
    const smallVotes = voteTxs(merged).filter((tx) => String(tx.civic?.electionId) === 'small');
    assert.equal(smallVotes.length, 4);
    assert.equal(merged.timestamp, HOUR_START + 4 * HOUR);

    clock = HOUR_START + 4 * HOUR + 5 * 60;
    state.enqueueRaw(
      civicHex({
        type: 'election_open',
        electionId: 'tiny',
        eligibleRoot: '0x01',
        cutoffTime: clock - 1,
      }),
    );
    state.enqueueRaw(civicHex({ type: 'vote', electionId: 'tiny', nullifier: '0xe1', ballotHash: '0xe1' }));
    state.enqueueRaw(civicHex({ type: 'vote', electionId: 'tiny', nullifier: '0xe2', ballotHash: '0xe2' }));
    clock = HOUR_START + 6 * HOUR;
    const withheld = await state.produceBlock();
    assert.equal(voteTxs(withheld).filter((tx) => String(tx.civic?.electionId) === 'tiny').length, 0);

    state.enqueueRaw(civicHex({ type: 'tally', electionId: 'tiny', countsHash: '0x99' }));
    const released = await state.produceBlock();
    assert.equal(voteTxs(released).filter((tx) => String(tx.civic?.electionId) === 'tiny').length, 2);
  });
});

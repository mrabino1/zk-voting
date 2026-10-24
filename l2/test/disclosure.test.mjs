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

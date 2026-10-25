// NOT FOR PROFIT — civic public good, not a commercial product.
// External eligibility parties are public on L2 immediately (not hour-sealed).
// A felony / death / age veto must be visible the moment it is posted so
// observers can see why a registered person was not allowed to cast.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { ChainState, loadConfig, CIVIC_TYPES } from '../sequencer/state.mjs';

function civicHex(obj) {
  return '0x' + Buffer.from(JSON.stringify(obj), 'utf8').toString('hex');
}

describe('L2 external party civic txs', () => {
  let tmp;
  let state;

  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'republic-l2-parties-'));
    const config = loadConfig();
    config.dataDir = tmp;
    config.disclosureIntervalSeconds = 3600;
    config.nowFn = () => 1_700_000_000;
    config.republicNodeUrl = '';
    state = ChainState.open(config);
  });

  after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test('CIVIC_TYPES includes the unbounded party factory txs', () => {
    assert.ok(CIVIC_TYPES.includes('party_add'));
    assert.ok(CIVIC_TYPES.includes('party_reject'));
    assert.ok(CIVIC_TYPES.includes('party_attest'));
  });

  test('party_reject is mined immediately and is not hour-sealed', async () => {
    const hash = state.enqueueRaw(
      civicHex({
        type: 'party_reject',
        electionId: '7',
        partyId: 'felony-oracle',
        identityCommitment: '0xabc1',
        reasonCode: 10,
        evidenceHash: '0x11',
      }),
    );
    assert.match(hash, /^0x[0-9a-f]+$/);
    assert.ok(state.getTransactionByHash(hash), 'reject is public before the hour closes');

    const pending = state.getBlockByNumber('pending', true);
    const pendingRejects = (pending?.transactions || []).filter(
      (tx) => tx.civicType === 'party_reject',
    );
    assert.equal(pendingRejects.length, 1);

    const mined = await state.produceBlock();
    const rejects = (mined.transactions || []).filter((tx) => tx.civicType === 'party_reject');
    assert.equal(rejects.length, 1);
    assert.equal(rejects[0].hash.toLowerCase(), hash.toLowerCase());
    assert.equal(rejects[0].civic.identityCommitment, '0xabc1');
    assert.equal(rejects[0].civic.reasonCode, 10);
    assert.equal(rejects[0].to.toLowerCase().endsWith('1006'), true);

    const logs = state.getLogs({
      topics: [state.eventTopics.partyRejected],
    });
    assert.equal(logs.length, 1);
  });

  test('party_add keeps partyName and strips legal-name keys', async () => {
    const hash = state.enqueueRaw(
      civicHex({
        type: 'party_add',
        electionId: '7',
        partyId: 'vital-records',
        partyName: 'State vital records',
        name: 'should-not-survive',
        mode: 'veto',
      }),
    );
    const tx = state.getTransactionByHash(hash);
    assert.equal(tx.civicType, 'party_add');
    assert.equal(tx.civic.partyName, 'State vital records');
    assert.equal(tx.civic.name, undefined);
    assert.equal(tx.civic.mode, 'veto');
    await state.produceBlock();
  });

  test('party_attest is public immediately unlike a vote', async () => {
    const attest = state.enqueueRaw(
      civicHex({
        type: 'party_attest',
        electionId: '7',
        partyId: 'age-check',
        identityCommitment: '0x333',
      }),
    );
    const vote = state.enqueueRaw(
      civicHex({
        type: 'vote',
        electionId: '7',
        nullifier: '0xfeed',
        ballotHash: '0xbeef',
      }),
    );
    assert.ok(state.getTransactionByHash(attest));
    assert.equal(state.getTransactionByHash(vote), null);
    const mined = await state.produceBlock();
    const types = (mined.transactions || []).map((tx) => tx.civicType);
    assert.ok(types.includes('party_attest'));
    assert.equal(types.includes('vote'), false);
  });
});

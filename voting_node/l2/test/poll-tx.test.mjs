// NOT FOR PROFIT — token-poll L2 tx kinds. Civic vote validation stays sealed.

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

const HASH = `0x${'ab'.repeat(32)}`;
const TOKEN = '0x1111111111111111111111111111111111111111';
const VOTER = '0x2222222222222222222222222222222222222222';

function pollVote(extra = {}) {
  return {
    type: 'poll_vote',
    pollId: 'poll-1',
    voter: VOTER,
    voteBlock: 4,
    provisionalWeight: '1000',
    choicesHash: HASH,
    ballotDigest: HASH,
    ...extra,
  };
}

describe('L2 token poll txs', () => {
  let tmp;
  let clock;
  let state;
  let off;

  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-l2-polls-'));
    clock = HOUR_START + 10 * 60;
    const config = loadConfig();
    config.dataDir = tmp;
    config.disclosureIntervalSeconds = HOUR;
    config.disclosureDelaySeconds = 0;
    config.resultsMinVotes = 0;
    config.disclosureMinBlockVotes = 1;
    config.nowFn = () => clock;
    config.zkVotingNodeUrl = '';
    config.pollsEnabled = true;
    state = ChainState.open(config);

    const offDir = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-l2-polls-off-'));
    const offConfig = loadConfig();
    offConfig.dataDir = offDir;
    offConfig.pollsEnabled = false;
    offConfig.zkVotingNodeUrl = '';
    off = ChainState.open(offConfig);
  });

  after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test('poll txs are rejected when POLLS_ENABLED is unset', () => {
    assert.throws(() => off.enqueueRaw(civicHex(pollVote())), /unsupported civic tx type: poll_vote/);
  });

  test('poll_vote is sealed until the hour closes and a civic vote still is too', async () => {
    const hash = state.enqueueRaw(civicHex(pollVote()));
    assert.equal(state.getTransactionByHash(hash), null);
    const vote = state.enqueueRaw(
      civicHex({ type: 'vote', electionId: '1', nullifier: '0xabc', ballotHash: '0xdef' }),
    );
    assert.equal(state.getTransactionByHash(vote), null);
    const mined = await state.produceBlock();
    const types = (mined.transactions || []).map((tx) => tx.civicType);
    assert.equal(types.includes('poll_vote'), false);
    assert.equal(types.includes('vote'), false);
    clock = HOUR_START + HOUR;
    const disclosed = await state.produceBlock();
    const disclosedTypes = (disclosed.transactions || []).map((tx) => tx.civicType);
    assert.ok(disclosedTypes.includes('poll_vote'));
    assert.ok(disclosedTypes.includes('vote'));
  });

  test('poll_params and poll_tally are public immediately; malformed polls are rejected', async () => {
    const params = state.enqueueRaw(
      civicHex({
        type: 'poll_params',
        pollId: 'poll-1',
        pollParamsHash: HASH,
        token: TOKEN,
        tokenChainId: 1,
        startTime: 10,
        cutoffTime: 20,
      }),
    );
    assert.ok(state.getTransactionByHash(params));
    const tally = state.enqueueRaw(
      civicHex({
        type: 'poll_tally',
        pollId: 'poll-1',
        closeBlock: 9,
        ballotsRoot: HASH,
        resultHash: HASH,
        participation: '1000',
        outcome: 'WINNER',
      }),
    );
    assert.ok(state.getTransactionByHash(tally));
    assert.throws(
      () =>
        state.enqueueRaw(
          civicHex({
            type: 'poll_params',
            pollId: 'poll-2',
            pollParamsHash: HASH,
            token: TOKEN,
            tokenChainId: 27427,
            startTime: 10,
            cutoffTime: 20,
          }),
        ),
      /tokenChainId/,
    );
    assert.throws(() => state.enqueueRaw(civicHex({ type: 'poll_vote', pollId: 'poll-3' })), /voter/);
  });
});

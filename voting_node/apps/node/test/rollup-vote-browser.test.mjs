// NOT FOR PROFIT — civic public good, not a commercial product.
// The browser half of a civic vote on the rollup (public/rollup-vote.js): what it sends must
// verify exactly as the L2 operator checks it, and a blank ballot is never a vote for option 0.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as bc from '../public/ballot-crypto.js';
import {
  describeRollupReceipt,
  encryptRollupBallot,
  fetchRollupReceipt,
  isRollupVote,
  loadBallotContext,
  rollupChoiceIndex,
} from '../public/rollup-vote.js';

const rollup = '0x00000000000000000000000000000000000000aa';
const context = bc.toJSONSafe({
  electionId: 7,
  chainId: 31337,
  rollup,
  jointKey: bc.mulBase(12345n),
  optionCount: 3,
  options: [{ id: 'a', label: 'North' }, { id: 'b', label: 'South' }, { id: 'c', label: 'East' }],
  status: 'scheduled',
});

test('only a vote published on the rollup takes the rollup path', () => {
  assert.equal(isRollupVote({ chainMode: 'rollup', rollupElectionId: '7' }), true);
  assert.equal(isRollupVote({ chainMode: 'node', rollupElectionId: null }), false);
  assert.equal(isRollupVote({ chainMode: 'rollup' }), false);
});

test('the choice is the option position; blank, unknown or several options are refused', () => {
  assert.equal(rollupChoiceIndex([{ questionId: 'q', optionId: 'b' }], context), 1);
  assert.equal(rollupChoiceIndex([{ questionId: 'q', optionIds: ['c'] }], context), 2);
  assert.throws(() => rollupChoiceIndex([{ questionId: 'q' }], context), /Choose an option/);
  assert.throws(() => rollupChoiceIndex([{ questionId: 'q', optionId: 'z' }], context), /not on this ballot/);
  assert.throws(() => rollupChoiceIndex([{ questionId: 'q', optionIds: ['a', 'b'] }], context), /exactly one/);
  assert.throws(() => rollupChoiceIndex([], context), /exactly one question/);
});

test('the encrypted ballot verifies as the operator checks it, and carries no choice', () => {
  const body = encryptRollupBallot({ context, choice: 2, nullifier: '987654321' });
  assert.equal(body.nullifier, '987654321');
  const parsed = bc.fromJSONSafe(body);
  const ok = bc.verifyBallot({
    ctx: bc.contextOf({ chainId: 31337, rollup }),
    electionId: 7,
    jointKey: bc.mulBase(12345n),
    optionCount: 3,
    ciphertexts: parsed.ciphertexts,
    proof: parsed.proof,
  });
  assert.equal(ok, true);
  assert.deepEqual(Object.keys(body).sort(), ['ciphertexts', 'nullifier', 'proof']);
  // Bound to the election: the same ballot does not verify for another one.
  assert.equal(
    bc.verifyBallot({ ctx: bc.contextOf({ chainId: 31337, rollup }), electionId: 8, jointKey: bc.mulBase(12345n), optionCount: 3, ciphertexts: parsed.ciphertexts, proof: parsed.proof }),
    false,
  );
});

test('ballot context and receipts come from the node routes', async () => {
  const seen = [];
  const api = async (url) => {
    seen.push(url);
    if (url.endsWith('/ballot-context')) return context;
    const err = new Error('no ballot under this nullifier');
    err.status = 404;
    throw err;
  };
  assert.equal((await loadBallotContext(api, 'e-1')).electionId, 7);
  assert.equal(await fetchRollupReceipt(api, 'e-1', '5'), null);
  assert.deepEqual(seen, ['/api/elections/e-1/rollup/ballot-context', '/api/elections/e-1/rollup/receipts/5']);
  await assert.rejects(loadBallotContext(async () => ({ ...context, status: 'closed' }), 'e-1'), /closed on L1/);
});

test('receipt text follows the operator status and never names a choice', () => {
  assert.match(describeRollupReceipt({ status: 'pending' }), /next batch/);
  assert.match(describeRollupReceipt({ status: 'committed', batchNumber: 3, l1Tx: `0x${'ab'.repeat(32)}` }), /batch 3/);
  assert.match(describeRollupReceipt({ status: 'settled', batchNumber: 3 }), /Settled on L1/);
  assert.match(describeRollupReceipt({ status: 'rejected', reason: 'closed' }), /not counted/);
});

// NOT FOR PROFIT — civic public good, not a commercial product.
// The results page of a civic vote on the rollup reads L1: totals only once certified,
// turnout only once closed, and nothing at all below the anonymity floor.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { rollupResultsModel } from '../public/rollup-results.js';

const election = {
  questions: [{ prompt: 'Which park?', options: [{ id: 'a', label: 'North' }, { id: 'b', label: 'South' }, { id: 'c', label: 'East' }] }],
};
const view = (status, extra = {}) => ({
  published: true,
  minBallots: 5,
  threshold: 2,
  guardians: [{ index: 1, sharesPosted: true }, { index: 2, sharesPosted: false }, { index: 3, sharesPosted: false }],
  l1: { status, electionId: 7, rollup: '0xaa', chainId: 31337, threshold: 2, minBallots: 5, ballotCount: 12 },
  ...extra,
});

test('while voting: no totals and no live ballot count', () => {
  const m = rollupResultsModel(view('scheduled'), election);
  assert.equal(m.rows, null);
  assert.equal(m.ballotCount, null);
  assert.equal(m.headline, 'Voting');
});

test('closed: shows guardian progress and turnout, still no totals', () => {
  const m = rollupResultsModel(view('closed'), election);
  assert.equal(m.rows, null);
  assert.equal(m.ballotCount, 12);
  assert.match(m.detail, /1 of 2 required guardians/);
});

test('finalized: certified totals with shares and the winner; ties are named', () => {
  const m = rollupResultsModel(view('finalized', { result: { counts: ['3', '7', '2'], resultHash: '0xbeef' } }), election);
  assert.deepEqual(m.rows.map((r) => [r.label, r.count]), [['North', 3], ['South', 7], ['East', 2]]);
  assert.equal(Math.round(m.rows[1].share * 1000), 583);
  assert.equal(m.headline, 'South wins');
  assert.equal(m.resultHash, '0xbeef');
  const tie = rollupResultsModel(view('finalized', { result: { counts: ['4', '4', '0'] } }), election);
  assert.equal(tie.headline, 'Tie: North, South');
});

test('withheld below the floor, halted, and not yet published', () => {
  const w = rollupResultsModel(view('withheld'), election);
  assert.equal(w.rows, null);
  assert.match(w.detail, /Fewer than 5 ballots/);
  assert.equal(rollupResultsModel(view('halted'), election).headline, 'Halted');
  assert.equal(rollupResultsModel({ published: false }, election).headline, 'Not on L1 yet');
  assert.equal(rollupResultsModel(null, election).status, 'draft');
});

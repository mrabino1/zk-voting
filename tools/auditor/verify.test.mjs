// NOT FOR PROFIT — civic public good, not a commercial product.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { sampleBundle } from './cli.mjs';
import { verifyAuditorBundle } from './verify.mjs';

describe('auditor verify', () => {
  test('sample bundle passes invariants', () => {
    const result = verifyAuditorBundle(sampleBundle());
    assert.equal(result.ok, true, result.errors.join('; '));
    assert.equal(result.summary.uniqueNullifiers, 2);
    assert.equal(result.summary.acceptedBallots, 2);
    assert.equal(result.checks.tallySum, true);
    assert.equal(result.checks.noChoiceLeak, true);
  });

  test('duplicate nullifier fails', () => {
    const bundle = sampleBundle();
    bundle.disclosedBallots.push({ ...bundle.disclosedBallots[0] });
    bundle.acceptedBallots = 3;
    const result = verifyAuditorBundle(bundle);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => /duplicate current nullifier/.test(e)));
  });

  test('tally mismatch fails', () => {
    const bundle = sampleBundle();
    bundle.tally.counts = [9, 0];
    const result = verifyAuditorBundle(bundle);
    assert.equal(result.ok, false);
    assert.equal(result.checks.tallySum, false);
  });

  test('choice leak fails', () => {
    const bundle = sampleBundle();
    bundle.disclosedBallots[0].choice = 'yes';
    const result = verifyAuditorBundle(bundle);
    assert.equal(result.ok, false);
    assert.equal(result.checks.noChoiceLeak, false);
  });

  test('current hash in superseded list fails', () => {
    const bundle = sampleBundle();
    bundle.disclosedBallots[0].supersededHashes.push(bundle.disclosedBallots[0].ballotHash);
    const result = verifyAuditorBundle(bundle);
    assert.equal(result.ok, false);
  });

  test('last-ballot-counts: two hashes one nullifier is one voter', () => {
    const bundle = sampleBundle();
    bundle.acceptedBallots = 2;
    bundle.tally.counts = [1, 1];
    const row = bundle.disclosedBallots[0];
    assert.equal(row.generation, 2);
    assert.equal(row.supersededHashes.length, 1);
    const result = verifyAuditorBundle(bundle);
    assert.equal(result.ok, true, result.errors.join('; '));
  });
});

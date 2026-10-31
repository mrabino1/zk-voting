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

  test('omitted publicAcceptedBallots fails', () => {
    const bundle = sampleBundle();
    delete bundle.publicAcceptedBallots;
    const result = verifyAuditorBundle(bundle);
    assert.equal(result.ok, false);
    assert.equal(result.checks.publicAcceptedLeq, false);
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

  test('multi-question concatenated counts are checked per aspect, not as a unique-voter sum', () => {
    const bundle = sampleBundle();
    bundle.acceptedBallots = 1;
    bundle.publicAcceptedBallots = 1;
    bundle.disclosedBallots = [bundle.disclosedBallots[0]];
    bundle.tally = {
      counts: [1, 0, 0, 1],
      questions: [
        { id: 'q1', type: 'YES_NO', tallied: true, tallyMethod: 'plurality', counts: [1, 0] },
        { id: 'q2', type: 'YES_NO', tallied: true, tallyMethod: 'plurality', counts: [0, 1] },
      ],
    };
    const result = verifyAuditorBundle(bundle);
    assert.equal(result.ok, true, result.errors.join('; '));
    assert.equal(result.checks.tallySum, true);
  });

  test('choice leak fails', () => {
    const bundle = sampleBundle();
    bundle.disclosedBallots[0].choice = 'yes';
    const result = verifyAuditorBundle(bundle);
    assert.equal(result.ok, false);
    assert.equal(result.checks.noChoiceLeak, false);
  });

  test('supersededHashes is not a valid one-ballot pack', () => {
    const bundle = sampleBundle();
    bundle.disclosedBallots[0].supersededHashes = [bundle.disclosedBallots[0].ballotHash];
    const result = verifyAuditorBundle(bundle);
    assert.equal(result.ok, false);
  });

  test('node pack without chain addresses still verifies uniqueness', () => {
    const bundle = sampleBundle();
    bundle.contracts = {};
    const result = verifyAuditorBundle(bundle);
    assert.equal(result.ok, true, result.errors.join('; '));
    assert.equal(result.checks.addressesPresent, false);
  });

  test('one ballot per nullifier: two hashes for one nullifier fail', () => {
    const bundle = sampleBundle();
    bundle.disclosedBallots[0].generation = 2;
    bundle.disclosedBallots[0].supersededHashes = [`0x${'99'.repeat(32)}`];
    const result = verifyAuditorBundle(bundle);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => /supersededHashes|generation/.test(e)));
  });
});

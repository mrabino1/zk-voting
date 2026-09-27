// NOT FOR PROFIT — civic public good, not a commercial product.
// Indexed disqualification chain: a member has no gap, so the non-membership
// witness the vote circuit requires cannot be built.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  disqualificationGap,
  disqualificationTree,
  emptyTree,
} from '../src/merkle.mjs';

describe('disqualification indexed chain', () => {
  test('empty set is the sentinel link, not a bare incremental root', () => {
    const bare = emptyTree(16);
    const dq = disqualificationTree(16, []);
    assert.notEqual(dq.root, bare.root);
    assert.equal(dq.leaves.length, 1);
    const gap = disqualificationGap([], '0xa1');
    assert.equal(gap.index, 0);
    assert.equal(gap.low, 0n);
    assert.equal(gap.next, 0n);
  });

  test("a disqualified voter's non-membership proof fails", () => {
    const voter = 0xb2n;
    const other = 0xa1n;
    assert.equal(disqualificationGap([voter], voter), null);

    const gap = disqualificationGap([voter], other);
    assert.ok(gap);
    const voterInThatGap = gap.low < voter && (gap.next === 0n || voter < gap.next);
    assert.equal(voterInThatGap, false);

    const withVoter = disqualificationTree(16, [other, voter]);
    const withoutVoter = disqualificationTree(16, [other]);
    assert.notEqual(withVoter.root, withoutVoter.root);
    assert.equal(disqualificationGap([other, voter], voter), null);
    assert.notEqual(disqualificationGap([other, voter], 0xc3n), null);
  });
});
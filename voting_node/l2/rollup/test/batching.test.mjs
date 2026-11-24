// NOT FOR PROFIT — civic public good, not a commercial product.
// When the operator seals waiting ballots. Each batch costs L1 gas, so on a public chain ballots
// wait for a fuller batch, but never long enough to miss an election's cutoff.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Operator } from '../operator.mjs';

function operator(batchMaxWaitSeconds, { cutoffIn = 86_400 } = {}) {
  const op = new Operator({ l1: { address: '0x00000000000000000000000000000000000000aa' }, chainId: 31337, batchMaxWaitSeconds });
  op.l1Time = 1_000_000;
  op.l1TimeAt = Date.now();
  op.state.elections.set(3, { cutoffTime: op.l1Time + cutoffIn });
  return op;
}

function wait(op, n, ageSeconds) {
  const ballots = [];
  for (let i = 0; i < n; i += 1) {
    const b = { electionId: 3, nullifier: BigInt(i + 1) };
    op.receipts.set(`3:${b.nullifier}`, { status: 'pending', receivedAt: Date.now() - ageSeconds * 1000 });
    ballots.push(b);
  }
  return ballots;
}

test('with no wait (the local chain) every tick seals', () => {
  const op = operator(0);
  assert.equal(op.ballotsDue(wait(op, 1, 0)), true);
});

test('a lone fresh ballot waits for a fuller batch', () => {
  const op = operator(600);
  assert.equal(op.ballotsDue(wait(op, 1, 5)), false);
});

test('a ballot that waited the maximum is sealed', () => {
  const op = operator(600);
  assert.equal(op.ballotsDue(wait(op, 1, 600)), true);
});

test('a full batch is sealed at once', () => {
  const op = operator(600);
  assert.equal(op.ballotsDue(wait(op, 256, 0)), true);
});

test('ballots are sealed in time for the cutoff', () => {
  const near = operator(600, { cutoffIn: 700 });
  assert.equal(near.ballotsDue(wait(near, 1, 0)), true);
  const far = operator(600, { cutoffIn: 3600 });
  assert.equal(far.ballotsDue(wait(far, 1, 0)), false);
});

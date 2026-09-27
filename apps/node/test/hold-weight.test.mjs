// NOT FOR PROFIT — hold-through-close weight tests on a mock ERC-20.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { finalWeight } from '../src/holdWeight.mjs';
import { createMemoryTokenChain } from '../src/tokenSource.mjs';

const A = '0x00000000000000000000000000000000000000a1';
const B = '0x00000000000000000000000000000000000000b2';
const SINK = '0x00000000000000000000000000000000000000c3';

function chain() {
  return createMemoryTokenChain();
}

describe('hold-through-close weight', () => {
  test('weight is the minimum balance from the vote block to the close block', async () => {
    const token = chain();
    token.mint(A, 1000n);
    const vote = token.mine({ timestamp: 100n });
    token.transfer(A, SINK, 200n);
    token.mine({ timestamp: 110n });
    token.mint(A, 500n);
    const close = token.mine({ timestamp: 120n });
    const got = await finalWeight({
      source: token,
      token: token.token,
      voter: A,
      voteBlock: vote.number,
      closeBlock: close.number,
    });
    assert.equal(got.finalWeight, 800n);
    assert.equal(got.voteBalance, 1000n);
    assert.equal(got.closeBalance, 1300n);
    assert.equal(got.consistent, true);
  });

  test('tokens moved out reduce the vote, and moving all of them zeroes it', async () => {
    const token = chain();
    token.mint(A, 1000n);
    const vote = token.mine({ timestamp: 100n });
    token.transfer(A, SINK, 400n);
    const mid = token.mine({ timestamp: 110n });
    let got = await finalWeight({
      source: token,
      token: token.token,
      voter: A,
      voteBlock: vote.number,
      closeBlock: mid.number,
    });
    assert.equal(got.finalWeight, 600n);

    token.transfer(A, SINK, 600n);
    const close = token.mine({ timestamp: 120n });
    got = await finalWeight({
      source: token,
      token: token.token,
      voter: A,
      voteBlock: vote.number,
      closeBlock: close.number,
    });
    assert.equal(got.finalWeight, 0n);
    assert.equal(got.closeBalance, 0n);
  });

  test('tokens moved to a second address count only once', async () => {
    const token = chain();
    token.mint(A, 100n);
    const aVote = token.mine({ timestamp: 100n });
    token.transfer(A, B, 100n);
    const bVote = token.mine({ timestamp: 110n });
    const close = token.mine({ timestamp: 120n });
    const weightA = await finalWeight({
      source: token,
      token: token.token,
      voter: A,
      voteBlock: aVote.number,
      closeBlock: close.number,
    });
    const weightB = await finalWeight({
      source: token,
      token: token.token,
      voter: B,
      voteBlock: bVote.number,
      closeBlock: close.number,
    });
    assert.equal(weightA.finalWeight, 0n);
    assert.equal(weightB.finalWeight, 100n);
    assert.equal(weightA.finalWeight + weightB.finalWeight, 100n);
    const supply = await token.totalSupplyAt(token.token, close.number);
    const balA = await token.balanceAt(token.token, A, close.number);
    const balB = await token.balanceAt(token.token, B, close.number);
    assert.ok(weightA.finalWeight + weightB.finalWeight <= balA + balB);
    assert.ok(balA + balB <= supply);
  });

  test('a flash loan counts zero', async () => {
    const token = chain();
    token.mint(A, 100n);
    const vote = token.mine({ timestamp: 100n });
    token.flashLoan(A, 1_000_000_000_000_000_000n);
    const close = token.mine({ timestamp: 110n });
    const got = await finalWeight({
      source: token,
      token: token.token,
      voter: A,
      voteBlock: vote.number,
      closeBlock: close.number,
    });
    assert.equal(got.finalWeight, 100n);
    assert.equal(got.touchedBlocks.length, 1);
    assert.equal(got.closeBalance, 100n);

    const empty = chain();
    empty.flashLoan(A, 5000n);
    const only = empty.mine({ timestamp: 100n });
    const borrowed = await empty.balanceAt(empty.token, A, only.number);
    assert.equal(borrowed, 0n);
  });

  test('ping-pong before close cannot inflate the total', async () => {
    const token = chain();
    token.mint(A, 100n);
    const aVote = token.mine({ timestamp: 100n });
    token.transfer(A, B, 100n);
    const bVote = token.mine({ timestamp: 110n });
    token.transfer(B, A, 100n);
    const close = token.mine({ timestamp: 120n });
    const weightA = await finalWeight({
      source: token,
      token: token.token,
      voter: A,
      voteBlock: aVote.number,
      closeBlock: close.number,
    });
    const weightB = await finalWeight({
      source: token,
      token: token.token,
      voter: B,
      voteBlock: bVote.number,
      closeBlock: close.number,
    });
    assert.ok(weightA.finalWeight + weightB.finalWeight <= 100n);
    assert.equal(weightA.finalWeight, 0n);
    assert.equal(weightB.finalWeight, 0n);
  });

  test('randomized transfers keep the supply invariant', async () => {
    const addrs = [A, B, SINK];
    for (let trial = 0; trial < 20; trial += 1) {
      const token = chain();
      token.mint(A, 1000n);
      let cursor = token.mine({ timestamp: 1_000n + BigInt(trial) });
      const votes = [];
      votes.push({ voter: A, voteBlock: cursor.number });
      for (let step = 0; step < 8; step += 1) {
        const from = addrs[(trial + step) % addrs.length];
        const to = addrs[(trial + step + 1) % addrs.length];
        const bal = await token.balanceAt(token.token, from, cursor.number);
        if (bal > 0n) {
          const amount = ((bal / 3n) + BigInt(step)) % (bal + 1n);
          const moving = amount === 0n ? 1n : amount;
          if (moving <= bal && from !== to) token.transfer(from, to, moving);
        }
        cursor = token.mine({ timestamp: cursor.timestamp + 10n });
        if (step === 3) votes.push({ voter: B, voteBlock: cursor.number });
      }
      const close = cursor;
      let sum = 0n;
      let sumBal = 0n;
      for (const vote of votes) {
        const got = await finalWeight({
          source: token,
          token: token.token,
          voter: vote.voter,
          voteBlock: vote.voteBlock,
          closeBlock: close.number,
        });
        const closeBal = await token.balanceAt(token.token, vote.voter, close.number);
        assert.ok(got.finalWeight <= closeBal);
        sum += got.finalWeight;
        sumBal += closeBal;
      }
      const supply = await token.totalSupplyAt(token.token, close.number);
      assert.ok(sum <= sumBal);
      assert.ok(sumBal <= supply);
    }
  });
});

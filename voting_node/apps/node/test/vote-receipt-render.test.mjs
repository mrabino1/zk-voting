// NOT FOR PROFIT — civic public good, not a commercial product.
// The receipt screen must render. voteCopy lives in the ballot renderer and
// has to be passed in, or the receipt throws before any help text appears.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { renderVote } from '../public/vote.js';

const ELECTION_ID = 'el-receipt';

function h(tag, attrs = {}, ...children) {
  return { tag, attrs: attrs || {}, children: children.flat() };
}

function textsOf(node, acc = []) {
  if (node == null || node === false) return acc;
  if (typeof node === 'string' || typeof node === 'number') {
    acc.push(String(node));
    return acc;
  }
  if (Array.isArray(node)) {
    for (const child of node) textsOf(child, acc);
    return acc;
  }
  if (node.attrs && node.attrs.text != null) acc.push(String(node.attrs.text));
  for (const child of node.children || []) textsOf(child, acc);
  return acc;
}

function receiptContext(allowRevote) {
  const painted = [];
  return {
    painted,
    ctx: {
      h,
      api: async (path) => (path === '/api/config' ? { allowRevote } : null),
      fill(_node, ...children) {
        painted.push(children.flat(Infinity));
      },
      announce() {},
      wallet: { getPublicRecord: async () => null },
      loadElection: async () => ({
        election: {
          id: ELECTION_ID,
          title: 'Town poll',
          jurisdiction: 'Town',
          state: 2,
          startTime: 1,
          cutoffTime: 9,
          questions: [],
        },
        source: 'live',
      }),
      loadMe: async () => null,
      readVoterStore: () => ({
        votes: {
          [ELECTION_ID]: {
            ballotHash: `0x${'ab'.repeat(32)}`,
            nullifier: `0x${'cd'.repeat(32)}`,
            token: 'holder-token',
            at: '2026-01-01T00:00:00.000Z',
          },
        },
      }),
      recordVoteReceipt() {},
      formatTime: (value) => (value == null ? '' : String(value)),
      electionStateInfo: () => ({ className: 'status-open', label: 'Open' }),
      electionId: ELECTION_ID,
    },
  };
}

describe('ballot receipt screen', () => {
  test('renders the one-ballot receipt when re-vote is off', async () => {
    const { painted, ctx } = receiptContext(false);
    const main = { replaceChildren() {} };
    await renderVote(main, ctx);
    const text = textsOf(painted).join('\n');
    assert.match(text, /Ballot receipt/);
    assert.match(text, /You can submit one ballot\./);
    assert.doesNotMatch(text, /You may submit a later ballot/);
  });

  test('renders the re-vote receipt when the node allows a later ballot', async () => {
    const { painted, ctx } = receiptContext(true);
    const main = { replaceChildren() {} };
    await renderVote(main, ctx);
    const text = textsOf(painted).join('\n');
    assert.match(text, /Ballot receipt/);
    assert.match(text, /You may submit a later ballot until the deadline\./);
  });
});

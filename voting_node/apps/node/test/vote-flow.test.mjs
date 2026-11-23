// NOT FOR PROFIT — civic public good, not a commercial product.
// The ballot page's flow: which path a ballot takes, the voter's steps, and what blocks a
// live ballot. The page shows all three on every step (public/vote-flow.js, public/vote.js).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { renderVote } from '../public/vote.js';
import { ballotPath, voteBlockers, voteSteps } from '../public/vote-flow.js';

const civic = { id: 'e1', chainMode: 'rollup', rollupElectionId: 3 };
const poll = { id: 'e2' };

describe('vote flow helpers', () => {
  test('ballotPath names the civic, poll and sample paths', () => {
    assert.equal(ballotPath(civic, 'live').kind, 'civic');
    assert.match(ballotPath(civic, 'live').body, /final sum/);
    assert.equal(ballotPath(poll, 'live').kind, 'poll');
    assert.match(ballotPath(poll, 'live').body, /weaker/);
    assert.equal(ballotPath(civic, 'sample').kind, 'sample');
  });

  test('voteSteps marks done, current and todo', () => {
    const states = (list) => list.map((s) => `${s.id}:${s.state}`).join(' ');
    assert.equal(states(voteSteps('ballot')), 'ballot:current pin:todo passkey:todo receipt:todo');
    assert.equal(states(voteSteps('pin')), 'ballot:done pin:current passkey:todo receipt:todo');
    assert.equal(states(voteSteps('pin', { busy: true })), 'ballot:done pin:done passkey:current receipt:todo');
    assert.equal(states(voteSteps('receipt')), 'ballot:done pin:done passkey:done receipt:current');
    assert.equal(states(voteSteps('ballot', { withPin: false, busy: true })), 'ballot:done passkey:current receipt:todo');
  });

  test('voteBlockers lists what is missing, in order; a sample is never blocked', () => {
    const ids = (o) => voteBlockers(o).map((b) => b.id).join(',');
    assert.equal(ids({ source: 'live', signedIn: false, pinBound: false, publicRecord: null, electionId: 'e1' }), 'signin,passkey');
    assert.equal(ids({ source: 'live', signedIn: true, pinBound: false, publicRecord: {}, electionId: 'e1' }), 'pin');
    assert.equal(ids({ source: 'live', signedIn: true, pinBound: true, publicRecord: { staleWrap: true } }), 'passkey');
    assert.equal(ids({ source: 'live', signedIn: true, pinBound: true, publicRecord: {} }), '');
    assert.equal(ids({ source: 'sample', signedIn: false, pinBound: false, publicRecord: null }), '');
    const [passkey] = voteBlockers({ source: 'live', signedIn: true, pinBound: true, publicRecord: null, electionId: 'a b' });
    assert.equal(passkey.href, '/register?election=a%20b');
  });
});

function h(tag, attrs = {}, ...children) {
  return { tag, attrs: attrs || {}, children: children.flat() };
}

function find(node, pred, acc = []) {
  if (node == null || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const c of node) find(c, pred, acc);
    return acc;
  }
  if (pred(node)) acc.push(node);
  for (const c of node.children || []) find(c, pred, acc);
  return acc;
}

function texts(node, acc = []) {
  if (node == null || node === false) return acc;
  if (typeof node === 'string') return acc.push(node), acc;
  if (Array.isArray(node)) {
    for (const c of node) texts(c, acc);
    return acc;
  }
  if (node.attrs?.text != null) acc.push(String(node.attrs.text));
  for (const c of node.children || []) texts(c, acc);
  return acc;
}

async function renderBallot({ election, me, publicRecord }) {
  const painted = [];
  await renderVote(
    { replaceChildren() {} },
    {
      h,
      api: async () => null,
      fill: (_n, ...children) => painted.push(children.flat(Infinity)),
      announce() {},
      wallet: { getPublicRecord: async () => publicRecord },
      loadElection: async () => ({ election, source: 'live' }),
      loadMe: async () => me,
      readVoterStore: () => ({ votes: {} }),
      recordVoteReceipt() {},
      formatTime: (v) => String(v ?? ''),
      electionStateInfo: () => ({ label: 'Open' }),
      electionId: election.id,
    },
  );
  return painted.at(-1);
}

const question = { id: 'q1', type: 'YES_NO', prompt: 'Adopt?', options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] };

describe('ballot page', () => {
  test('a civic vote shows its path, the steps, and one checklist for a signed-out voter', async () => {
    const tree = await renderBallot({
      election: { ...civic, title: 'Parks bond', state: 2, questions: [question] },
      me: null,
      publicRecord: null,
    });
    const text = texts(tree).join('\n');
    assert.match(text, /Civic vote, settled on Ethereum/);
    const steps = find(tree, (n) => n.attrs?.class === 'vote-steps')[0];
    const current = find(steps, (n) => n.attrs?.['aria-current'] === 'step');
    assert.equal(current.length, 1);
    const phases = find(tree, (n) => String(n.attrs?.class || '').startsWith('phase-steps'))[0];
    assert.deepEqual(find(phases, (n) => n.attrs?.['aria-current'] === 'step').map((n) => n.attrs.text), ['Voting']);
    assert.equal(current[0].attrs.text, 'Mark your ballot');
    const checklist = find(tree, (n) => String(n.attrs?.class || '').includes('vote-blockers'));
    assert.equal(checklist.length, 1);
    assert.match(texts(checklist).join(' '), /Sign in\..*Create a passkey/s);
    const submit = find(tree, (n) => n.tag === 'button' && n.attrs.type === 'submit')[0];
    assert.equal(submit.attrs.disabled, true);
  });

  test('a ready voter on an open poll sees no checklist and can go on to the PIN', async () => {
    const tree = await renderBallot({
      election: { ...poll, title: 'Library hours', state: 2, questions: [question] },
      me: { user: { id: 'u1', pinBound: true } },
      publicRecord: {},
    });
    assert.match(texts(tree).join('\n'), /Poll, counted by this node/);
    assert.equal(find(tree, (n) => String(n.attrs?.class || '').includes('vote-blockers')).length, 0);
    const submit = find(tree, (n) => n.tag === 'button' && n.attrs.type === 'submit')[0];
    assert.equal(submit.attrs.disabled, false);
    assert.equal(submit.attrs.text, 'Next: vote PIN');
  });

  test('a live ballot cannot be cast while the election is not open', async () => {
    const tree = await renderBallot({
      election: { ...poll, title: 'Library hours', state: 1, questions: [question] },
      me: { user: { id: 'u1', pinBound: true } },
      publicRecord: {},
    });
    const submit = find(tree, (n) => n.tag === 'button' && n.attrs.type === 'submit')[0];
    assert.equal(submit.attrs.disabled, true);
  });
});

describe('contest phases', async () => {
  const { contestPhases } = await import('../public/contests.js');
  const current = (e) => contestPhases(e).find((p) => p.state === 'current')?.label;
  test('a civic vote is a draft until it is on L1, then follows the node state', () => {
    assert.equal(current({ electionType: 1, electionTypeName: 'vote', state: 2 }), 'Draft');
    const onL1 = { electionTypeName: 'vote', chainMode: 'rollup', rollupElectionId: '4' };
    assert.equal(current({ ...onL1, state: 0 }), 'Registration');
    assert.equal(current({ ...onL1, state: 2 }), 'Voting');
    assert.equal(current({ ...onL1, state: 3 }), 'Counting');
    assert.equal(current({ ...onL1, state: 4 }), 'Results');
    assert.deepEqual(contestPhases({ ...onL1, state: 3 }).map((p) => p.state), ['done', 'done', 'done', 'current', 'todo']);
  });
  test('a poll has no draft phase', () => {
    assert.deepEqual(contestPhases({ electionTypeName: 'poll', state: 2 }).map((p) => p.label), ['Registration', 'Voting', 'Counting', 'Results']);
  });
});

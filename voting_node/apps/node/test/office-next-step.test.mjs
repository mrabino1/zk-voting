// NOT FOR PROFIT — civic public good, not a commercial product.
// Back-office "Elections at a glance": the next step per election, the contract
// error glossary, and the pre-create checks for a civic vote.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

import '../public/office-next-step.js';

const { nextStep, friendlyError, checkNewElection } = globalThis.ZkVotingNextStep;
const NOW = 1_800_000_000;
const H = 3600;

const poll = (over = {}) => ({
  electionTypeName: 'poll',
  electionType: 0,
  state: 0,
  startTime: NOW + 24 * H,
  cutoffTime: NOW + 72 * H,
  rollFrozen: false,
  eligibleCount: 0,
  ...over,
});
const vote = (over = {}) => poll({ electionTypeName: 'vote', electionType: 1, ...over });
const l1 = (status, over = {}) => ({
  enabled: true,
  published: true,
  threshold: 2,
  minBallots: 5,
  rollSynced: 3,
  guardians: [
    { index: 1, committed: true },
    { index: 2, committed: true },
    { index: 3, committed: false },
  ],
  l1: { status, startTime: NOW + 24 * H, cutoffTime: NOW + 72 * H, threshold: 2, minBallots: 5 },
  ...over,
});

describe('poll next step', () => {
  test('an empty roll before the start asks for voters', () => {
    const s = nextStep(poll(), null, NOW);
    assert.equal(s.tone, 'action');
    assert.equal(s.section, 'registrar');
  });

  test('voters on the roll before the start asks to freeze', () => {
    const s = nextStep(poll({ eligibleCount: 12 }), null, NOW);
    assert.equal(s.section, 'clerk');
    assert.match(s.text, /12 on the roll/);
  });

  test('voting window open but roll not frozen is urgent: voters are blocked', () => {
    const s = nextStep(poll({ startTime: NOW - H }), null, NOW);
    assert.equal(s.tone, 'urgent');
    assert.equal(s.section, 'clerk');
    assert.match(s.text, /cannot cast ballots/);
  });

  test('frozen and open needs nothing', () => {
    assert.equal(nextStep(poll({ state: 2, rollFrozen: true, startTime: NOW - H }), null, NOW).tone, 'wait');
  });

  test('after the cutoff, post the tally; tallied is done', () => {
    assert.equal(nextStep(poll({ state: 3, rollFrozen: true, cutoffTime: NOW - 1 }), null, NOW).section, 'tally');
    assert.equal(nextStep(poll({ state: 4, rollFrozen: true, tally: {} }), null, NOW).tone, 'done');
  });

  test('a window that passed with no freeze says no ballots were possible', () => {
    const s = nextStep(poll({ startTime: NOW - 10 * H, cutoffTime: NOW - H }), null, NOW);
    assert.equal(s.tone, 'urgent');
    assert.match(s.text, /never frozen/);
  });
});

describe('civic vote next step follows ZkVotingRollup', () => {
  test('node without a rollup connection says so', () => {
    const s = nextStep(vote(), { enabled: false, published: false }, NOW);
    assert.equal(s.tone, 'urgent');
    assert.match(s.text, /not connected/);
  });

  test('draft with guardians suggests publishing', () => {
    const view = { enabled: true, published: false, guardians: [{ index: 1 }, { index: 2 }, { index: 3 }] };
    const s = nextStep(vote(), view, NOW);
    assert.equal(s.action, 'publish');
    assert.match(s.text, /2 needed/);
  });

  test('draft after the start cannot be published (createElection needs now < startTime)', () => {
    const s = nextStep(vote({ startTime: NOW - 60 }), { enabled: true, published: false, guardians: [] }, NOW);
    assert.equal(s.tone, 'urgent');
    assert.match(s.text, /start time has passed/);
  });

  test('keygen with k commitments suggests finalizing the key', () => {
    const s = nextStep(vote(), l1('keygen'), NOW);
    assert.equal(s.action, 'finalize-key');
  });

  test('keygen after the start can only be halted', () => {
    const view = l1('keygen');
    view.l1.startTime = NOW - 60;
    const s = nextStep(vote(), view, NOW);
    assert.equal(s.tone, 'urgent');
    assert.match(s.text, /only allows this vote to be halted/);
  });

  test('scheduled before start: roll still open; after cutoff: close', () => {
    assert.match(nextStep(vote(), l1('scheduled'), NOW).text, /until voting starts/);
    const ended = l1('scheduled');
    ended.l1.startTime = NOW - 72 * H;
    ended.l1.cutoffTime = NOW - 1;
    assert.equal(nextStep(vote(), ended, NOW).action, 'close');
  });

  test('closed with k shares suggests finalize; withheld and finalized are done', () => {
    const view = l1('closed', {
      guardians: [
        { index: 1, sharesPosted: true },
        { index: 2, sharesPosted: true },
      ],
    });
    assert.equal(nextStep(vote(), view, NOW).action, 'finalize');
    const withheld = nextStep(vote(), l1('withheld'), NOW);
    assert.equal(withheld.tone, 'done');
    assert.match(withheld.text, /Fewer than 5 ballots/);
    assert.equal(nextStep(vote(), l1('finalized'), NOW).tone, 'done');
  });
});

describe('contract error glossary', () => {
  test('every custom error in the rollup ABI has a plain-English meaning', async () => {
    const abiDir = new URL('../../../packages/chain-client/abi/', import.meta.url);
    const names = new Set();
    for (const file of ['ZkVotingRollup.json', 'Guardians.json']) {
      const abi = JSON.parse(await readFile(new URL(file, abiDir), 'utf8'));
      for (const item of abi) if (item.type === 'error') names.add(item.name);
    }
    assert.ok(names.size > 10, 'ABI lists custom errors');
    const missing = [...names].filter((n) => !friendlyError(n));
    assert.deepEqual(missing, []);
  });

  test('unknown codes give no text', () => {
    assert.equal(friendlyError('SomethingElse'), '');
    assert.equal(friendlyError(''), '');
  });
});

describe('checkNewElection', () => {
  const q = (n) => [{ type: 'SINGLE_CHOICE', options: Array.from({ length: n }, (_, i) => ({ id: `o${i}` })) }];

  test('a poll only needs start before cutoff', () => {
    assert.deepEqual([...checkNewElection({ civic: false, startTime: NOW - 10, cutoffTime: NOW + 10, questions: q(1) }, NOW)], []);
    assert.equal(checkNewElection({ civic: false, startTime: NOW + 10, cutoffTime: NOW, questions: q(2) }, NOW).length, 1);
  });

  test('a civic vote needs a future start and one question with 2–8 options', () => {
    assert.equal(checkNewElection({ civic: true, startTime: NOW - 1, cutoffTime: NOW + H, questions: q(2) }, NOW).length, 1);
    assert.equal(checkNewElection({ civic: true, startTime: NOW + 5 * H, cutoffTime: NOW + 9 * H, questions: q(9) }, NOW).length, 1);
    assert.equal(
      checkNewElection({ civic: true, startTime: NOW + 5 * H, cutoffTime: NOW + 9 * H, questions: [...q(2), ...q(2)] }, NOW).length,
      1,
    );
    const yesNo = checkNewElection({ civic: true, startTime: NOW + 5 * H, cutoffTime: NOW + 9 * H, questions: [{ type: 'YES_NO' }] }, NOW);
    assert.deepEqual([...yesNo], []);
  });

  test('a civic vote starting too soon for the key ceremony warns but does not block', () => {
    const r = checkNewElection({ civic: true, startTime: NOW + 30 * 60, cutoffTime: NOW + 9 * H, questions: q(3) }, NOW);
    assert.equal(r.length, 0);
    assert.equal(r.warnings.length, 1);
  });
});

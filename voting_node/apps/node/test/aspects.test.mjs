// NOT FOR PROFIT — civic public good, not a commercial product.
// End-to-end: two-or-more question election on the Node (create, one envelope, per-question tally).

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { createApp } from '../src/server.mjs';
import { buildBallotObject, normalizeQuestions } from '../src/ballot.mjs';

let tmp;
let app;
let store;
let server;
let base;
const adminJar = {};
const voterJar = {};

function applyCookies(res, jar) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const c of list) {
    const pair = c.split(';')[0];
    const i = pair.indexOf('=');
    if (i === -1) continue;
    jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
}

function cookieHeader(jar) {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

async function api(method, url, { body, jar } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(jar ? { cookie: cookieHeader(jar) } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (jar) applyCookies(res, jar);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { res, json, text, status: res.status };
}

function listen(application) {
  return new Promise((resolve, reject) => {
    const s = application.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

const ASPECTS = [
  {
    id: 'ordinance',
    type: 'YES_NO',
    prompt: 'Shall Ordinance 2026-14 be adopted?',
    description: 'Library hours.',
    options: [
      { id: 'yes', label: 'Yes' },
      { id: 'no', label: 'No' },
    ],
  },
  {
    id: 'council',
    type: 'SINGLE_CHOICE',
    prompt: 'City Council, at-large',
    options: [
      { id: 'rivera', label: 'Alex Rivera' },
      { id: 'chen', label: 'Morgan Chen' },
      { id: 'okonkwo', label: 'Sam Okonkwo' },
    ],
  },
  {
    id: 'board',
    type: 'MULTI_CHOICE',
    prompt: 'Park board — choose up to two',
    maxSelections: 2,
    options: [
      { id: 'lee', label: 'Pat Lee' },
      { id: 'nguyen', label: 'Kim Nguyen' },
      { id: 'ross', label: 'Chris Ross' },
    ],
  },
];

describe('multi-question ballots (aspects)', () => {
  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-aspects-'));
    const created = await createApp({
      dataDir: tmp,
      allowDevLogin: true,
      adminHandle: 'admin',
      quiet: true,
      port: 0,
      disclosureIntervalSeconds: 0,
      // Plaintext JSON ballots are rejected by default; these fixtures exercise
      // the non-production plaintext tally path on purpose.
      allowPlaintextBallots: true,
    });
    app = created.app;
    store = created.store;
    server = await listen(app);
    base = `http://127.0.0.1:${server.address().port}`;
    await api('POST', '/api/auth/dev-login', { body: { handle: 'admin' }, jar: adminJar });
    await api('POST', '/api/auth/dev-login', { body: { handle: 'voter1', role: 'voter' }, jar: voterJar });
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await rm(tmp, { recursive: true, force: true });
  });

  test('SPA results route is HTML', async () => {
    const page = await api('GET', '/elections/1/results');
    assert.equal(page.status, 200);
    assert.match(page.res.headers.get('content-type') || '', /html/);
    const ballot = await api('GET', '/vote/1');
    assert.equal(ballot.status, 200);
    assert.match(ballot.text, /app\.js/);
  });

  test('create / vote / tally a three-question election', async () => {
    const created = await api('POST', '/api/elections', {
      jar: adminJar,
      body: {
        title: 'Northbridge general — three aspects',
        startTime: nowSec() - 60,
        cutoffTime: nowSec() + 3600,
        treeDepth: 16,
        jurisdictionId: 'demo',
        questions: ASPECTS,
      },
    });
    assert.equal(created.status, 201, created.json?.error);
    const election = created.json.election;
    const id = election.id;
    assert.equal(election.questionCount, 3);
    assert.equal(election.questions.length, 3);
    assert.equal(election.aspects.length, 3);
    assert.equal(election.questions[1].options.length, 3);
    assert.equal(election.questions[2].maxSelections, 2);
    assert.ok(election.ballotSpecHash);

    await api('POST', `/api/elections/${id}/register`, {
      jar: adminJar,
      body: { identityCommitment: '0xa1' },
    });
    const freeze = await api('POST', `/api/elections/${id}/freeze`, { jar: adminJar });
    assert.equal(freeze.status, 200, freeze.json?.error);

    const questions = normalizeQuestions(ASPECTS);
    const answersA = [
      { questionId: 'ordinance', type: 'YES_NO', optionIds: ['yes'] },
      { questionId: 'council', type: 'SINGLE_CHOICE', optionIds: ['rivera'] },
      { questionId: 'board', type: 'MULTI_CHOICE', optionIds: ['lee', 'nguyen'] },
    ];
    const answersB = [
      { questionId: 'ordinance', type: 'YES_NO', optionIds: ['no'] },
      { questionId: 'council', type: 'SINGLE_CHOICE', optionIds: ['chen'] },
      { questionId: 'board', type: 'MULTI_CHOICE', optionIds: ['ross'] },
    ];

    const envelopeA = buildBallotObject({ electionId: id, ballotSpecHash: election.ballotSpecHash, questions, answers: answersA });
    const envelopeB = buildBallotObject({ electionId: id, ballotSpecHash: election.ballotSpecHash, questions, answers: answersB });

    const incomplete = await api('POST', `/api/elections/${id}/vote`, {
      body: {
        proof: { accept: true },
        publicInputs: { nullifier: '11', electionId: id },
        identityCommitment: '0xa1',
        encryptedBallot: JSON.stringify({ electionId: id, answers: [answersA[0]] }),
      },
    });
    assert.equal(incomplete.status, 400);
    assert.equal(incomplete.json.code, 'BALLOT_INCOMPLETE');

    const v1 = await api('POST', `/api/elections/${id}/vote`, {
      body: {
        proof: { accept: true },
        publicInputs: { nullifier: '21', electionId: id },
        identityCommitment: '0xa1',
        encryptedBallot: JSON.stringify(envelopeA),
        answers: answersA,
      },
    });
    assert.equal(v1.status, 201, v1.json?.error);
    assert.equal(v1.json.vote.choice, undefined);
    assert.equal(v1.json.vote.answers, undefined);

    const v2 = await api('POST', `/api/elections/${id}/vote`, {
      body: {
        proof: { accept: true },
        publicInputs: { nullifier: '22', electionId: id },
        identityCommitment: '0xa1',
        encryptedBallot: JSON.stringify(envelopeB),
      },
    });
    assert.equal(v2.status, 201, v2.json?.error);

    const snap = store.snapshot();
    for (const env of snap.envelopes.filter((e) => String(e.electionId) === String(id))) {
      assert.equal(env.answers, undefined);
      assert.equal(env.choice, undefined);
      assert.equal(env.userId, undefined);
      assert.ok(env.encryptedBallot);
    }

    const live = store.requireElection(id);
    live.cutoffTime = nowSec() - 1;
    await store.persist();

    const tooMany = await api('POST', `/api/elections/${id}/tally`, {
      jar: adminJar,
      body: { counts: [3, 0, 0, 0, 0, 0, 0, 0] },
    });
    assert.equal(tooMany.status, 400);
    assert.equal(tooMany.json.code, 'TALLY_MISMATCH');

    const wrongLen = await api('POST', `/api/elections/${id}/tally`, {
      jar: adminJar,
      body: { counts: [1, 1] },
    });
    assert.equal(wrongLen.status, 400);
    assert.equal(wrongLen.json.code, 'TALLY_LENGTH');
    assert.equal(wrongLen.json.expected, 8);

    // ordinance: yes=1,no=1; council: rivera=1,chen=1,okonkwo=0; board: lee=1,nguyen=1,ross=1
    // Global sum 7 ≠ acceptedBallots 2 — that is correct for three contests.
    const ok = await api('POST', `/api/elections/${id}/tally`, {
      jar: adminJar,
      body: {
        questions: [
          { id: 'ordinance', counts: [1, 1] },
          { id: 'council', counts: [1, 1, 0] },
          { id: 'board', counts: [1, 1, 1] },
        ],
      },
    });
    assert.equal(ok.status, 200, ok.json?.error);
    assert.equal(ok.json.election.stateName, 'Tallied');
    assert.deepEqual(ok.json.election.tally.counts, [1, 1, 1, 1, 0, 1, 1, 1]);
    const labeled = ok.json.election.tally.questions;
    assert.equal(labeled.length, 3);
    assert.equal(labeled[0].prompt, 'Shall Ordinance 2026-14 be adopted?');
    assert.equal(labeled[0].options[0].label, 'Yes');
    assert.equal(labeled[0].options[0].count, 1);
    assert.equal(labeled[0].undervotes, 0);
    assert.equal(labeled[1].options[1].label, 'Morgan Chen');
    assert.equal(labeled[1].options[1].count, 1);
    assert.equal(labeled[2].tallyMethod, 'plurality');
    assert.equal(labeled[2].options[2].count, 1);

    const results = await api('GET', `/api/elections/${id}/results`);
    assert.equal(results.status, 200);
    assert.equal(results.json.questionCount, 3);
    assert.equal(results.json.tally.questions[0].id, 'ordinance');
    assert.equal(results.json.aspects[1].prompt, 'City Council, at-large');

    const publicPage = await api('GET', `/api/elections/${id}`);
    assert.equal(publicPage.json.tally.questions[2].prompt, 'Park board — choose up to two');
  });

  test('a ranked question disables the whole tally instead of opening envelopes', async () => {
    const created = await api('POST', '/api/elections', {
      jar: adminJar,
      body: {
        title: 'Mixed ranked',
        startTime: nowSec() - 30,
        cutoffTime: nowSec() + 600,
        treeDepth: 16,
        questions: [
          { type: 'YES_NO', prompt: 'Bond?' },
          { type: 'RANKED', prompt: 'Rank the board', options: ['Ada', 'Bea', 'Cal'] },
        ],
      },
    });
    assert.equal(created.status, 201, created.json?.error);
    const id = created.json.election.id;
    assert.equal(created.json.election.questions[1].type, 'RANKED');
    await api('POST', `/api/elections/${id}/register`, {
      jar: adminJar,
      body: { identityCommitment: '0xb2' },
    });
    await api('POST', `/api/elections/${id}/freeze`, { jar: adminJar });
    const rankedQ = created.json.election.questions[1];
    const rankedAnswers = [
      { questionId: created.json.election.questions[0].id, optionIds: ['yes'] },
      {
        questionId: rankedQ.id,
        optionIds: [rankedQ.options[0].id, rankedQ.options[1].id],
      },
    ];
    const vote = await api('POST', `/api/elections/${id}/vote`, {
      body: {
        proof: { accept: true },
        publicInputs: { nullifier: '31', electionId: id },
        identityCommitment: '0xb2',
        encryptedBallot: JSON.stringify({
          answers: rankedAnswers,
        }),
      },
    });
    assert.equal(vote.status, 201, vote.json?.error);
    store.requireElection(id).cutoffTime = nowSec() - 1;
    await store.persist();
    const tallied = await api('POST', `/api/elections/${id}/tally`, {
      jar: adminJar,
      body: { counts: [1, 0] },
    });
    assert.equal(tallied.status, 409, tallied.json?.error);
    assert.equal(tallied.json.code, 'RANKED_TALLY_DISABLED');
    const stored = store.listEnvelopes(id);
    assert.equal(stored.some((row) => row.rankingPayload), false);
    assert.equal(store.requireElection(id).tally, null);
  });
});

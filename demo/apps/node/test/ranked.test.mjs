// NOT FOR PROFIT — civic public good, not a commercial product.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { createApp } from '../src/server.mjs';

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

function hexJson(obj) {
  return `0x${Buffer.from(JSON.stringify(obj), 'utf8').toString('hex')}`;
}

function voteBody(electionId, nullifier, answers, identityCommitment) {
  const payload = { answers };
  return {
    proof: { accept: true },
    publicInputs: { nullifier, electionId },
    encryptedBallot: hexJson(payload),
    answers,
    identityCommitment,
  };
}

const RANKED_QUESTIONS = [
  {
    id: 'q-office',
    type: 'RANKED',
    prompt: 'Rank the candidates for city council.',
    options: [
      { id: 'a', label: 'Alex Rivera' },
      { id: 'b', label: 'Blair Chen' },
      { id: 'c', label: 'Casey Okonkwo' },
    ],
  },
];

describe('Ranked-choice ballots and IRV tally', () => {
  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-irv-'));
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
    await api('POST', '/api/auth/dev-login', {
      body: { handle: 'ranked-voter', role: 'voter' },
      jar: voterJar,
    });
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await rm(tmp, { recursive: true, force: true });
  });

  test('GET /api/config advertises ranked_choice', async () => {
    const { status, json } = await api('GET', '/api/config');
    assert.equal(status, 200);
    assert.deepEqual(json.ballot.methods, ['plurality', 'ranked_choice']);
  });

  test('create + PATCH ranked ballot before freeze', async () => {
    const created = await api('POST', '/api/elections', {
      jar: adminJar,
      body: {
        title: 'Council IRV',
        startTime: nowSec() - 30,
        cutoffTime: nowSec() + 3600,
        treeDepth: 16,
        ballotMethod: 'ranked_choice',
        questions: RANKED_QUESTIONS,
      },
    });
    assert.equal(created.status, 201, created.json?.error);
    assert.equal(created.json.election.ballotMethod, 'ranked_choice');
    assert.equal(created.json.election.questions[0].type, 'RANKED');
    assert.equal(created.json.election.questions[0].ballotMethod, 'ranked_choice');

    const patched = await api('PATCH', `/api/elections/${created.json.election.id}`, {
      jar: adminJar,
      body: {
        title: 'Council IRV (amended)',
        questions: [
          {
            ...RANKED_QUESTIONS[0],
            options: [
              ...RANKED_QUESTIONS[0].options,
              { id: 'd', label: 'Drew Berg' },
            ],
          },
        ],
      },
    });
    assert.equal(patched.status, 200, patched.json?.error);
    assert.equal(patched.json.election.title, 'Council IRV (amended)');
    assert.equal(patched.json.election.questions[0].options.length, 4);
  });

  test('rejects invalid rankings and accepts a valid ranking', async () => {
    const created = await api('POST', '/api/elections', {
      jar: adminJar,
      body: {
        title: 'IRV accept',
        startTime: nowSec() - 30,
        cutoffTime: nowSec() + 3600,
        treeDepth: 16,
        ballotMethod: 'plurality',
        questions: RANKED_QUESTIONS,
      },
    });
    assert.equal(created.status, 201, created.json?.error);
    const id = created.json.election.id;
    assert.equal(created.json.election.questions[0].ballotMethod, 'ranked_choice');

    const reg = await api('POST', `/api/elections/${id}/register`, {
      jar: adminJar,
      body: { identityCommitment: '0x51' },
    });
    assert.equal(reg.status, 201, reg.json?.error);
    const freeze = await api('POST', `/api/elections/${id}/freeze`, { jar: adminJar });
    assert.equal(freeze.status, 200, freeze.json?.error);

    const opaque = await api('POST', `/api/elections/${id}/vote`, {
      body: {
        proof: { accept: true },
        publicInputs: { nullifier: '1', electionId: id },
        encryptedBallot: '0xc0ffee',
        identityCommitment: '0x51',
        answers: [{ questionId: 'q-office', ranking: ['a'] }],
        address: '0x2222222222222222222222222222222222222222',
        credentialId: 'cred',
      },
    });
    assert.equal(opaque.status, 201, opaque.json?.error);
    const opaqueEnv = store.listEnvelopes(id)[0];
    assert.equal(opaqueEnv.rankingPayload, undefined);
    assert.equal(opaqueEnv.answers, undefined);
    assert.equal(opaqueEnv.identityCommitment, undefined);
    assert.equal(opaqueEnv.address, undefined);
    assert.equal(opaqueEnv.credentialId, undefined);

    const dup = await api('POST', `/api/elections/${id}/vote`, {
      body: voteBody(id, '2', [{ questionId: 'q-office', ranking: ['a', 'a'] }], '0x51'),
    });
    assert.equal(dup.status, 400);
    assert.equal(dup.json.code, 'RANKING_INVALID');

    const unknown = await api('POST', `/api/elections/${id}/vote`, {
      body: voteBody(id, '3', [{ questionId: 'q-office', ranking: ['z'] }], '0x51'),
    });
    assert.equal(unknown.status, 400);

    const ok = await api('POST', `/api/elections/${id}/vote`, {
      body: voteBody(id, '4', [{ questionId: 'q-office', ranking: ['b', 'c', 'a'] }], '0x51'),
    });
    assert.equal(ok.status, 201, ok.json?.error);
    assert.equal(ok.json.vote.choice, undefined);
    assert.equal(ok.json.vote.ranking, undefined);
    const env = store.listEnvelopes(id).find((row) => row.nullifier);
    assert.equal(env.rankingPayload, undefined);
    assert.equal(env.choice, undefined);
    assert.equal(env.userId, undefined);
  });

  test('ranked tally is refused instead of opening envelopes', async () => {
    const created = await api('POST', '/api/elections', {
      jar: adminJar,
      body: {
        title: 'IRV tally',
        startTime: nowSec() - 30,
        cutoffTime: nowSec() + 3600,
        treeDepth: 16,
        questions: RANKED_QUESTIONS,
      },
    });
    assert.equal(created.status, 201, created.json?.error);
    const id = created.json.election.id;
    await api('POST', `/api/elections/${id}/register`, {
      jar: adminJar,
      body: { identityCommitment: '0x61' },
    });
    await api('POST', `/api/elections/${id}/freeze`, { jar: adminJar });

    const stacks = [
      ...Array(5).fill(['a', 'b', 'c']),
      ...Array(4).fill(['b', 'c', 'a']),
      ...Array(3).fill(['c', 'a', 'b']),
    ];
    for (let i = 0; i < stacks.length; i += 1) {
      const v = await api('POST', `/api/elections/${id}/vote`, {
        body: voteBody(id, 200 + i, [{ questionId: 'q-office', ranking: stacks[i] }], '0x61'),
      });
      assert.equal(v.status, 201, v.json?.error);
    }

    const election = store.requireElection(id);
    election.cutoffTime = nowSec() - 1;
    await store.persist();

    const tallied = await api('POST', `/api/elections/${id}/tally`, {
      jar: adminJar,
      body: {},
    });
    assert.equal(tallied.status, 409, tallied.json?.error);
    assert.equal(tallied.json.code, 'RANKED_TALLY_DISABLED');
    const stored = store.listEnvelopes(id);
    assert.ok(stored.length > 1);
    assert.equal(stored.some((row) => row.rankingPayload), false);
  });

  test('plurality tally is unchanged', async () => {
    const created = await api('POST', '/api/elections', {
      jar: adminJar,
      body: {
        title: 'FPTP still',
        startTime: nowSec() - 30,
        cutoffTime: nowSec() + 3600,
        treeDepth: 16,
        questions: [{ type: 'YES_NO', prompt: 'Adopt?' }],
      },
    });
    const id = created.json.election.id;
    assert.equal(created.json.election.ballotMethod, 'plurality');
    await api('POST', `/api/elections/${id}/register`, {
      jar: adminJar,
      body: { identityCommitment: '0x71' },
    });
    await api('POST', `/api/elections/${id}/freeze`, { jar: adminJar });
    const v = await api('POST', `/api/elections/${id}/vote`, {
      body: {
        proof: { accept: true },
        publicInputs: { nullifier: '9', electionId: id },
        encryptedBallot: '0xab',
        identityCommitment: '0x71',
      },
    });
    assert.equal(v.status, 201, v.json?.error);
    const election = store.requireElection(id);
    election.cutoffTime = nowSec() - 1;
    await store.persist();
    const bad = await api('POST', `/api/elections/${id}/tally`, { jar: adminJar, body: {} });
    assert.equal(bad.status, 400);
    const ok = await api('POST', `/api/elections/${id}/tally`, {
      jar: adminJar,
      body: { counts: [1, 0] },
    });
    assert.equal(ok.status, 200, ok.json?.error);
    assert.equal(ok.json.election.tally.ballotMethod, 'plurality');
    assert.equal(ok.json.election.tally.questions[0].tallyMethod, 'plurality');
    assert.equal(ok.json.election.tally.questions[0].winner, undefined);
  });
});

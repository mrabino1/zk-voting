// NOT FOR PROFIT — civic public good, not a commercial product.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { createApp } from '../src/server.mjs';
import { hashBallotSpec, normalizeQuestions } from '../src/ballotSpec.mjs';
import { emptyTree } from '../src/merkle.mjs';

let tmp;
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
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { res, json, text, status: res.status };
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function walk(value, visit) {
  if (!value || typeof value !== 'object') return;
  visit(value);
  for (const child of Object.values(value)) walk(child, visit);
}

describe('option metadata info API', () => {
  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-info-'));
    const created = await createApp({
      dataDir: tmp,
      allowDevLogin: true,
      adminHandle: 'admin',
      quiet: true,
      port: 0,
      disclosureIntervalSeconds: 0,
    });
    store = created.store;
    server = await new Promise((resolve, reject) => {
      const s = created.app.listen(0, '127.0.0.1', () => resolve(s));
      s.on('error', reject);
    });
    base = `http://127.0.0.1:${server.address().port}`;
    await api('POST', '/api/auth/dev-login', { body: { handle: 'admin' }, jar: adminJar });
    await api('POST', '/api/auth/dev-login', {
      body: { handle: 'voter1', role: 'voter' },
      jar: voterJar,
    });
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await rm(tmp, { recursive: true, force: true });
  });

  test('SPA fallback serves HTML for voter info deep links', async () => {
    const page = await api('GET', '/elections/1/info');
    assert.equal(page.status, 200);
    assert.match(page.res.headers.get('content-type') || '', /html/);
    assert.match(page.text, /NOT FOR PROFIT/);
    const mini = await api('GET', '/elections/1/info/q1/o1');
    assert.equal(mini.status, 200);
    assert.match(mini.text, /NOT FOR PROFIT/);
  });

  test('create with string options still works and info pages fill empty metadata', async () => {
    const title = 'Legacy strings';
    const questions = [{ type: 'YES_NO', prompt: 'Adopt?', options: ['No', 'Yes'] }];
    const { status, json } = await api('POST', '/api/elections', {
      jar: adminJar,
      body: {
        title,
        startTime: nowSec() + 60,
        cutoffTime: nowSec() + 3600,
        treeDepth: 16,
        jurisdictionId: 'demo',
        questions,
      },
    });
    assert.equal(status, 201, json?.error);
    const id = json.election.id;
    assert.equal(json.election.ballotSpecHash, hashBallotSpec({ title, questions }));
    assert.deepEqual(json.election.questions[0].options, [
      { id: 'o1', label: 'No' },
      { id: 'o2', label: 'Yes' },
    ]);

    const info = await api('GET', `/api/elections/${id}/info`);
    assert.equal(info.status, 200);
    assert.equal(info.json.createdBy, undefined);
    assert.equal(info.json.operatorInbox, undefined);
    assert.equal(info.json.me, undefined);
    assert.equal(info.json.questions[0].options[0].summary, '');
    assert.equal(info.json.questions[0].options[0].body, '');
    assert.deepEqual(info.json.questions[0].options[0].links, []);

    const mini = await api('GET', `/api/elections/${id}/info/q1/o2`);
    assert.equal(mini.status, 200);
    assert.equal(mini.json.option.label, 'Yes');
    assert.equal(mini.json.question.prompt, 'Adopt?');
  });

  test('structured metadata is stored, hashed, and returned on the public info API', async () => {
    const title = 'Council 2026';
    const questions = [
      {
        id: 'council',
        type: 'SINGLE_CHOICE',
        prompt: 'City Council, at-large',
        options: [
          {
            id: 'jane',
            label: 'Jane Doe',
            summary: 'Incumbent. Housing and transit.',
            body: 'Jane Doe has served one term on the council.',
            imageUrl: 'https://example.org/jane.jpg',
            links: [{ label: 'Campaign site', url: 'https://example.org/jane' }],
          },
          { id: 'alex', label: 'Alex Rivera' },
        ],
      },
    ];
    const created = await api('POST', '/api/elections', {
      jar: adminJar,
      body: {
        title,
        startTime: nowSec() + 60,
        cutoffTime: nowSec() + 3600,
        treeDepth: 16,
        jurisdictionId: 'demo',
        questions,
      },
    });
    assert.equal(created.status, 201, created.json?.error);
    const id = created.json.election.id;
    const stored = created.json.election.questions[0].options[0];
    assert.equal(stored.summary, 'Incumbent. Housing and transit.');
    assert.equal(stored.links[0].url, 'https://example.org/jane');
    assert.equal(created.json.election.questions[0].options[1].summary, undefined);
    assert.equal(created.json.election.ballotSpecHash, hashBallotSpec({ title, questions }));

    const unauth = await api('GET', `/api/elections/${id}/info`);
    assert.equal(unauth.status, 200);
    assert.equal(unauth.json.questions[0].options[0].body, 'Jane Doe has served one term on the council.');
    assert.equal(unauth.json.questions[0].options[1].summary, '');
    walk(unauth.json, (obj) => {
      assert.equal(Object.hasOwn(obj, 'createdBy'), false);
      assert.equal(Object.hasOwn(obj, 'secret'), false);
    });

    const mini = await api('GET', `/api/elections/${id}/info/council/jane`);
    assert.equal(mini.status, 200);
    assert.equal(mini.json.option.imageUrl, 'https://example.org/jane.jpg');
    assert.equal(mini.json.option.links[0].label, 'Campaign site');
  });

  test('PATCH updates metadata and rehashes; freeze locks the spec', async () => {
    const created = await api('POST', '/api/elections', {
      jar: adminJar,
      body: {
        title: 'Editable',
        startTime: nowSec() + 120,
        cutoffTime: nowSec() + 7200,
        treeDepth: 16,
        jurisdictionId: 'demo',
        questions: [{ type: 'YES_NO', prompt: 'Bond?' }],
      },
    });
    assert.equal(created.status, 201, created.json?.error);
    const id = created.json.election.id;
    const before = created.json.election.ballotSpecHash;

    const patched = await api('PATCH', `/api/elections/${id}`, {
      jar: adminJar,
      body: {
        questions: [
          {
            type: 'YES_NO',
            prompt: 'Bond?',
            options: [
              { id: 'no', label: 'No', summary: 'Reject the bond.' },
              { id: 'yes', label: 'Yes', summary: 'Adopt the bond.', links: [{ label: 'Text', url: 'https://example.org/bond' }] },
            ],
          },
        ],
      },
    });
    assert.equal(patched.status, 200, patched.json?.error);
    assert.notEqual(patched.json.election.ballotSpecHash, before);
    assert.equal(
      patched.json.election.ballotSpecHash,
      hashBallotSpec({
        title: 'Editable',
        questions: patched.json.election.questions,
      }),
    );

    const forbidden = await api('PATCH', `/api/elections/${id}`, {
      jar: voterJar,
      body: { title: 'hijack' },
    });
    assert.equal(forbidden.status, 403);

    const freeze = await api('POST', `/api/elections/${id}/freeze`, { jar: adminJar });
    assert.equal(freeze.status, 200, freeze.json?.error);
    const locked = await api('PATCH', `/api/elections/${id}`, {
      jar: adminJar,
      body: { title: 'too late' },
    });
    assert.equal(locked.status, 409);
    assert.equal(locked.json.code, 'ROLL_FROZEN');
  });

  test('wrong ballotSpecHash on create is rejected so UI cannot diverge', async () => {
    const { status, json } = await api('POST', '/api/elections', {
      jar: adminJar,
      body: {
        title: 'Hash mismatch',
        startTime: nowSec() + 60,
        cutoffTime: nowSec() + 3600,
        treeDepth: 16,
        jurisdictionId: 'demo',
        questions: [{ type: 'YES_NO', prompt: '?' }],
        ballotSpecHash: '0x' + '11'.repeat(32),
      },
    });
    assert.equal(status, 400);
    assert.equal(json.code, 'SPEC_HASH_MISMATCH');
  });

  test('elections stored with only string options still serve /info', async () => {
    const tree = emptyTree(16);
    const dq = emptyTree(16);
    const election = {
      id: '6f1c0a6e-9b2d-4e11-8c7a-1a2b3c4d5e01',
      title: 'Pre-metadata election',
      metadataURI: '',
      startTime: nowSec() + 10,
      cutoffTime: nowSec() + 5000,
      maxParticipants: 0,
      treeDepth: 16,
      ballotSpecHash: '0x' + 'ab'.repeat(32),
      questions: [{ id: 'q1', type: 'SINGLE_CHOICE', prompt: 'Board seat', options: ['Kim', 'Lee'] }],
      questionCount: 1,
      jurisdictionId: 'demo',
      clerk: '',
      registrar: '',
      disqualificationOfficer: '',
      tallyOperator: '',
      verifier: '',
      lateUpdateAllowed: false,
      rollFrozen: false,
      frozenAt: null,
      frozenEligibleRoot: null,
      frozenDisqualificationRoot: null,
      participantCount: 0,
      eligibleCount: 0,
      acceptedBallots: 0,
      eligibleRoot: tree.root,
      disqualificationRoot: dq.root,
      eligibleTree: tree,
      disqualificationTree: dq,
      tally: null,
      createdBy: 'should-not-leak',
      clerkNotes: 'private',
      createdAt: new Date().toISOString(),
    };
    store.data.elections.push(election);
    await store.persist();

    const info = await api('GET', '/api/elections/6f1c0a6e-9b2d-4e11-8c7a-1a2b3c4d5e01/info');
    assert.equal(info.status, 200);
    assert.equal(info.json.title, 'Pre-metadata election');
    assert.equal(info.json.createdBy, undefined);
    assert.equal(info.json.clerkNotes, undefined);
    assert.equal(info.json.questions[0].options[0].label, 'Kim');
    assert.equal(info.json.questions[0].options[1].label, 'Lee');
    const mini = await api('GET', '/api/elections/6f1c0a6e-9b2d-4e11-8c7a-1a2b3c4d5e01/info/q1/o1');
    assert.equal(mini.status, 200);
    assert.equal(mini.json.option.label, 'Kim');
  });

  test('normalizeQuestions is what the store persists after create', async () => {
    const questions = normalizeQuestions([
      { type: 'MEASURE', prompt: 'Article 3', options: [{ label: 'Adopt' }, { label: 'Reject' }] },
    ]);
    const created = await api('POST', '/api/elections', {
      jar: adminJar,
      body: {
        title: 'Measure store',
        startTime: nowSec() + 60,
        cutoffTime: nowSec() + 3600,
        treeDepth: 16,
        jurisdictionId: 'demo',
        questions: [{ type: 'MEASURE', prompt: 'Article 3', options: [{ label: 'Adopt' }, { label: 'Reject' }] }],
      },
    });
    assert.equal(created.status, 201, created.json?.error);
    const row = store.requireElection(created.json.election.id);
    assert.deepEqual(row.questions, questions);
  });
});

// NOT FOR PROFIT — civic public good, not a commercial product.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { parseRoute } from '../public/router.js';
import { createApp } from '../src/server.mjs';
import {
  buildResults,
  pluralityOutcome,
  questionResult,
  sliceOptionCounts,
} from '../src/results.mjs';

function loc(pathname) {
  return { pathname, hash: '', search: '' };
}

describe('plurality results helpers', () => {
  test('single-winner unique max', () => {
    const out = pluralityOutcome(
      [
        { id: 'yes', label: 'Yes', count: 4 },
        { id: 'no', label: 'No', count: 1 },
      ],
      1,
    );
    assert.equal(out.status, 'winner');
    assert.equal(out.winner.id, 'yes');
    assert.equal(out.tied.length, 0);
    assert.match(out.note, /Yes wins/);
  });

  test('single-winner tie is explicit', () => {
    const out = pluralityOutcome(
      [
        { id: 'yes', label: 'Yes', count: 2 },
        { id: 'no', label: 'No', count: 2 },
      ],
      1,
    );
    assert.equal(out.status, 'tie');
    assert.equal(out.winner, null);
    assert.equal(out.tied.length, 2);
    assert.match(out.note, /Tie/);
  });

  test('all zeros is no_votes', () => {
    const out = pluralityOutcome(
      [
        { id: 'a', label: 'A', count: 0 },
        { id: 'b', label: 'B', count: 0 },
      ],
      1,
    );
    assert.equal(out.status, 'no_votes');
  });

  test('multi-winner cutoff tie', () => {
    const out = pluralityOutcome(
      [
        { id: 'a', label: 'Alex', count: 10 },
        { id: 'b', label: 'Morgan', count: 8 },
        { id: 'c', label: 'Sam', count: 8 },
        { id: 'd', label: 'Jordan', count: 3 },
      ],
      2,
    );
    assert.equal(out.status, 'tie');
    assert.deepEqual(
      out.winners.map((w) => w.id),
      ['a'],
    );
    assert.deepEqual(
      out.tied.map((w) => w.id),
      ['b', 'c'],
    );
    assert.match(out.note, /Tie for the remaining seat/);
  });

  test('multi-winner unique top seats', () => {
    const out = pluralityOutcome(
      [
        { id: 'a', label: 'Alex', count: 10 },
        { id: 'b', label: 'Morgan', count: 8 },
        { id: 'c', label: 'Sam', count: 5 },
      ],
      2,
    );
    assert.equal(out.status, 'winner');
    assert.deepEqual(
      out.winners.map((w) => w.id),
      ['a', 'b'],
    );
  });

  test('slice concatenates per-question option counts', () => {
    const questions = [
      {
        id: 'q1',
        type: 'YES_NO',
        prompt: 'A?',
        options: [
          { id: 'yes', label: 'Yes' },
          { id: 'no', label: 'No' },
        ],
      },
      {
        id: 'q2',
        type: 'SINGLE_CHOICE',
        prompt: 'Office',
        options: [
          { id: 'x', label: 'X' },
          { id: 'y', label: 'Y' },
          { id: 'z', label: 'Z' },
        ],
      },
    ];
    const slices = sliceOptionCounts(questions, [3, 1, 2, 2, 1]);
    assert.deepEqual(slices[0].counts, [3, 1]);
    assert.deepEqual(slices[1].counts, [2, 2, 1]);
    const built = buildResults({
      questions,
      tally: { counts: [3, 1, 2, 2, 1], postedAt: '2026-01-01T00:00:00.000Z' },
      cutoffTime: 1,
      startTime: 0,
    });
    assert.equal(built.available, true);
    assert.equal(built.questions[0].outcome.winner.id, 'yes');
    assert.equal(built.questions[1].outcome.status, 'tie');
  });

  test('ranked questions show counts but do not declare an IRV winner', () => {
    const q = questionResult(
      {
        id: 'q1',
        type: 'RANKED',
        prompt: 'Mayor',
        options: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ],
      },
      [5, 1],
      { available: true },
    );
    assert.equal(q.method, 'ranked_choice_not_computed');
    assert.equal(q.outcome.status, 'not_computed');
    assert.equal(q.options[0].count, 5);
    assert.equal(q.outcome.winner, null);
  });

  test('empty state before tally omits option counts', () => {
    const built = buildResults({
      questions: [
        {
          id: 'q1',
          type: 'YES_NO',
          prompt: 'Adopt?',
          options: [
            { id: 'yes', label: 'Yes' },
            { id: 'no', label: 'No' },
          ],
        },
      ],
      tally: null,
      startTime: 0,
      cutoffTime: 9e12,
      rollFrozen: true,
    });
    assert.equal(built.available, false);
    assert.equal(built.status, 'open');
    assert.equal(built.questions[0].options[0].count, null);
    assert.equal(built.questions[0].outcome, null);
  });
});

describe('SPA results routes', () => {
  test('parseRoute understands results paths', () => {
    assert.equal(parseRoute(loc('/elections/1/results')).name, 'results');
    assert.equal(parseRoute(loc('/elections/1/results')).params.id, '1');
    assert.equal(parseRoute(loc('/elections/abc-uuid/results')).params.id, 'abc-uuid');
    assert.equal(parseRoute(loc('/elections')).name, 'resultsIndex');
    assert.equal(parseRoute(loc('/elections/1')).name, 'results');
    assert.equal(parseRoute(loc('/vote/1')).name, 'vote');
  });
});

describe('results API', () => {
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

  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-results-'));
    const created = await createApp({
      dataDir: tmp,
      allowDevLogin: true,
      adminHandle: 'admin',
      quiet: true,
      port: 0,
      disclosureIntervalSeconds: 0,
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

  test('unknown election is 404', async () => {
    const counted = await api('GET', '/api/elections/99999/results');
    assert.equal(counted.status, 400);
    assert.equal(counted.json.code, 'ID_NOT_UUID');
    const { status, json } = await api('GET', '/api/elections/6f1c0a6e-9b2d-4e11-8c7a-1a2b3c4d5e99/results');
    assert.equal(status, 404);
    assert.equal(json.nfp, true);
    assert.match(json.error, /not found/i);
  });

  test('open election empty state has no option counts', async () => {
    const created = await api('POST', '/api/elections', {
      jar: adminJar,
      body: {
        title: 'Open poll',
        startTime: nowSec() - 60,
        cutoffTime: nowSec() + 3600,
        treeDepth: 16,
        questions: [{ type: 'YES_NO', prompt: 'Adopt the measure?' }],
      },
    });
    assert.equal(created.status, 201, created.json?.error);
    const id = created.json.election.id;
    const freeze = await api('POST', `/api/elections/${id}/freeze`, { jar: adminJar });
    assert.equal(freeze.status, 200, freeze.json?.error);
    const { status, json } = await api('GET', `/api/elections/${id}/results`);
    assert.equal(status, 200);
    assert.equal(json.results.available, false);
    assert.equal(json.results.status, 'open');
    assert.equal(json.results.questions[0].options[0].count, null);
    assert.equal(json.results.questions[0].outcome, null);
    assert.equal(json.operatorInbox, undefined);
    assert.equal(json.results.questions[0].options[0].label, 'Yes');
  });

  test('closed without tally is awaiting_tally', async () => {
    const created = await api('POST', '/api/elections', {
      jar: adminJar,
      body: {
        title: 'Closed no tally',
        startTime: nowSec() - 120,
        cutoffTime: nowSec() - 1,
        treeDepth: 16,
        questions: [{ type: 'YES_NO', prompt: 'Adopt?' }],
      },
    });
    const id = created.json.election.id;
    const { json } = await api('GET', `/api/elections/${id}/results`);
    assert.equal(json.results.available, false);
    assert.equal(json.results.status, 'awaiting_tally');
    assert.match(json.results.message, /tally has not been posted/i);
  });

  test('tallied plurality winner and UUID lookup; a short code is not an API id', async () => {
    const created = await api('POST', '/api/elections', {
      jar: adminJar,
      body: {
        title: 'Winner race',
        startTime: nowSec() - 120,
        cutoffTime: nowSec() + 3600,
        treeDepth: 16,
        questions: [
          { type: 'YES_NO', prompt: 'Adopt the measure?' },
          {
            type: 'MULTI_CHOICE',
            prompt: 'Council',
            maxSelections: 2,
            options: [
              { id: 'a', label: 'Alex' },
              { id: 'b', label: 'Morgan' },
              { id: 'c', label: 'Sam' },
            ],
          },
        ],
      },
    });
    const id = created.json.election.id;
    await api('POST', `/api/elections/${id}/register`, {
      jar: adminJar,
      body: { identityCommitment: '0xabc1' },
    });
    await api('POST', `/api/elections/${id}/freeze`, { jar: adminJar });
    const v1 = await api('POST', `/api/elections/${id}/vote`, {
      body: {
        proof: { accept: true },
        publicInputs: { nullifier: 11, electionId: id },
        identityCommitment: '0xabc1',
        encryptedBallot: '0xaa',
      },
    });
    assert.equal(v1.status, 201, v1.json?.error);
    const v2 = await api('POST', `/api/elections/${id}/vote`, {
      body: {
        proof: { accept: true },
        publicInputs: { nullifier: 12, electionId: id },
        identityCommitment: '0xabc1',
        encryptedBallot: '0xbb',
      },
    });
    assert.equal(v2.status, 201, v2.json?.error);

    const election = store.requireElection(id);
    election.cutoffTime = nowSec() - 1;
    election.uuid = '550e8400-e29b-41d4-a716-446655440000';
    election.code = 'NBR-26';
    await store.persist();

    const empty = await api('GET', `/api/elections/${id}/results`);
    assert.equal(empty.json.results.available, false);
    assert.equal(empty.json.results.status, 'awaiting_tally');

    const tally = await api('POST', `/api/elections/${id}/tally`, {
      jar: adminJar,
      body: { counts: [2, 0, 0, 0, 0] },
    });
    assert.equal(tally.status, 200, tally.json?.error);

    const { status, json } = await api('GET', `/api/elections/${id}/results`);
    assert.equal(status, 200);
    assert.equal(json.results.available, true);
    assert.equal(json.results.status, 'tallied');
    assert.equal(json.results.questions[0].options[0].count, 2);
    assert.equal(json.results.questions[0].outcome.status, 'winner');
    assert.equal(json.results.questions[0].outcome.winner.id, 'yes');
    assert.equal(json.results.questions[1].outcome.status, 'no_votes');
    assert.equal(json.choice, undefined);
    assert.equal(json.operatorInbox, undefined);

    const byUuid = await api('GET', `/api/elections/${election.uuid}/results`);
    assert.equal(byUuid.status, 200);
    assert.equal(byUuid.json.id, id);
    assert.equal(byUuid.json.results.questions[0].outcome.winner.label, 'Yes');

    const byCode = await api('GET', `/api/elections/${election.code}/results`);
    assert.equal(byCode.status, 400);
    assert.equal(byCode.json.code, 'ID_NOT_UUID');
  });

  test('tie is declared for equal YES_NO counts', async () => {
    const created = await api('POST', '/api/elections', {
      jar: adminJar,
      body: {
        title: 'Tie poll',
        startTime: nowSec() - 120,
        cutoffTime: nowSec() + 3600,
        treeDepth: 16,
        questions: [{ type: 'YES_NO', prompt: 'Adopt?' }],
      },
    });
    const id = created.json.election.id;
    await api('POST', `/api/elections/${id}/register`, {
      jar: adminJar,
      body: { identityCommitment: '0xabc2' },
    });
    await api('POST', `/api/elections/${id}/freeze`, { jar: adminJar });
    await api('POST', `/api/elections/${id}/vote`, {
      body: {
        proof: { accept: true },
        publicInputs: { nullifier: 21, electionId: id },
        identityCommitment: '0xabc2',
        encryptedBallot: '0xcc',
      },
    });
    await api('POST', `/api/elections/${id}/vote`, {
      body: {
        proof: { accept: true },
        publicInputs: { nullifier: 22, electionId: id },
        identityCommitment: '0xabc2',
        encryptedBallot: '0xdd',
      },
    });
    store.requireElection(id).cutoffTime = nowSec() - 1;
    await store.persist();
    const tally = await api('POST', `/api/elections/${id}/tally`, {
      jar: adminJar,
      body: { counts: [1, 1] },
    });
    assert.equal(tally.status, 200, tally.json?.error);
    const { json } = await api('GET', `/api/elections/${id}/results`);
    assert.equal(json.results.questions[0].outcome.status, 'tie');
    assert.equal(json.results.questions[0].outcome.tied.length, 2);
    assert.match(json.results.questions[0].outcome.note, /Tie/);
  });
});

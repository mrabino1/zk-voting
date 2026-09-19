// NOT FOR PROFIT — civic public good, not a commercial product.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { createApp } from '../src/server.mjs';
import { encryptToTallyPub, packChoices } from '../src/tallyCrypto.mjs';

let tmp;
let app;
let store;
let server;
let base;
const adminJar = {};

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
  return { json, status: res.status, text };
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

async function voteEncrypted(electionId, nullifier, envelopeHex, identityCommitment) {
  return api('POST', `/api/elections/${electionId}/vote`, {
    body: {
      proof: { accept: true },
      publicInputs: { nullifier, electionId },
      encryptedBallot: envelopeHex,
      identityCommitment,
    },
  });
}

async function registerVoter(electionId, identityCommitment) {
  const res = await api('POST', `/api/elections/${electionId}/register`, {
    jar: adminJar,
    body: { identityCommitment },
  });
  assert.equal(res.status, 201, res.text);
  return res;
}

describe('tally opens ballots (demo ECIES)', () => {
  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'republic-tally-opens-'));
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
    const login = await api('POST', '/api/auth/dev-login', {
      body: { handle: 'admin', role: 'platform_admin' },
      jar: adminJar,
    });
    assert.equal(login.status, 200, login.text);
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await rm(tmp, { recursive: true, force: true });
  });

  test('opens N demo ballots to the correct plurality; invented sum-only vector fails', async () => {
    const created = await api('POST', '/api/elections', {
      jar: adminJar,
      body: {
        title: 'Opens-ballots demo',
        startTime: nowSec() - 10,
        cutoffTime: nowSec() + 3600,
        questions: [
          {
            type: 'SINGLE_CHOICE',
            prompt: 'Who?',
            options: [
              { id: 'a', label: 'A' },
              { id: 'b', label: 'B' },
              { id: 'c', label: 'C' },
            ],
          },
        ],
        jurisdictionId: 'demo',
        tallyScheme: 'opens_ballots',
      },
    });
    assert.equal(created.status, 201, created.text);
    const electionId = created.json.election.id;
    assert.equal(created.json.election.tallyScheme, 'opens_ballots');
    assert.ok(created.json.election.tallyPubKey);
    assert.equal(created.json.election.tallyCeremony.production, false);
    assert.match(created.json.election.tallyCeremony.warning, /NON-PRODUCTION/);

    const key = await api('GET', `/api/elections/${electionId}/tally-key`);
    assert.equal(key.status, 200);
    assert.equal(key.json.ceremony.production, false);
    assert.equal(key.json.ceremony.privateJwk, undefined);
    const pub = created.json.election.tallyPubKey;

    // 5 ballots: 0,0,1,0,2 → [3,1,1]
    const choices = [0, 0, 1, 0, 2];
    const commitments = choices.map((_, i) => `0x${(0xa01 + i).toString(16)}`);
    for (const commitment of commitments) {
      await registerVoter(electionId, commitment);
    }

    const freeze = await api('POST', `/api/elections/${electionId}/freeze`, { jar: adminJar });
    assert.equal(freeze.status, 200, freeze.text);

    for (let i = 0; i < choices.length; i++) {
      const env = await encryptToTallyPub(pub, packChoices([choices[i]]));
      const cast = await voteEncrypted(electionId, 1000 + i, env, commitments[i]);
      assert.equal(cast.status, 201, cast.text);
    }

    const election = store.requireElection(electionId);
    election.cutoffTime = nowSec() - 1;
    await store.persist();

    const invented = await api('POST', `/api/elections/${electionId}/tally`, {
      jar: adminJar,
      body: { counts: [5, 0, 0] },
    });
    assert.equal(invented.status, 400, invented.text);
    assert.equal(invented.json.code, 'INVENTED_COUNTS');
    assert.deepEqual(invented.json.derived, [3, 1, 1]);

    const alsoInvented = await api('POST', `/api/elections/${electionId}/tally`, {
      jar: adminJar,
      body: { counts: [0, 0, 5] },
    });
    assert.equal(alsoInvented.status, 400);
    assert.equal(alsoInvented.json.code, 'INVENTED_COUNTS');

    const ok = await api('POST', `/api/elections/${electionId}/tally`, {
      jar: adminJar,
      body: {},
    });
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual(ok.json.election.tally.counts, [3, 1, 1]);
    assert.equal(ok.json.election.tally.source, 'opens_ballots');
    assert.equal(ok.json.election.tally.production, false);
    assert.equal(ok.json.tally.openedBallots, 5);
  });

  test('legacy sum_only still accepts a matching-sum invented vector', async () => {
    const created = await api('POST', '/api/elections', {
      jar: adminJar,
      body: {
        title: 'Legacy sum-only',
        startTime: nowSec() - 10,
        cutoffTime: nowSec() + 3600,
        questions: [
          {
            type: 'YES_NO',
            prompt: 'Adopt?',
            options: [
              { id: 'yes', label: 'Yes' },
              { id: 'no', label: 'No' },
            ],
          },
        ],
        jurisdictionId: 'demo',
        tallyScheme: 'sum_only',
      },
    });
    assert.equal(created.status, 201, created.text);
    const electionId = created.json.election.id;
    assert.equal(created.json.election.tallyScheme, 'sum_only');
    assert.equal(created.json.election.tallyPubKey, null);

    await registerVoter(electionId, '0xb01');
    const freeze = await api('POST', `/api/elections/${electionId}/freeze`, { jar: adminJar });
    assert.equal(freeze.status, 200, freeze.text);
    const v = await voteEncrypted(electionId, 42, '0xab', '0xb01');
    assert.equal(v.status, 201, v.text);

    const election = store.requireElection(electionId);
    election.cutoffTime = nowSec() - 1;
    await store.persist();

    const ok = await api('POST', `/api/elections/${electionId}/tally`, {
      jar: adminJar,
      body: { counts: [0, 1] },
    });
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual(ok.json.election.tally.counts, [0, 1]);
    assert.equal(ok.json.election.tally.source, 'sum_only');
  });

  test('GET /api/config advertises both tally schemes and non-production demo key', async () => {
    const { status, json } = await api('GET', '/api/config');
    assert.equal(status, 200);
    assert.deepEqual(json.tally.schemes, ['sum_only', 'opens_ballots']);
    assert.equal(json.tally.production, false);
  });
});

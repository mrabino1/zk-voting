// NOT FOR PROFIT — civic public good, not a commercial product.
// One accepted nullifier + choice-free receipts + public auditor pack.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { createApp } from '../src/server.mjs';
import { verifyAuditorBundle } from '../../../tools/auditor/verify.mjs';

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

describe('one-ballot-per-nullifier and auditor pack', () => {
  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'republic-coercion-'));
    const created = await createApp({
      dataDir: tmp,
      allowDevLogin: true,
      adminHandle: 'admin',
      quiet: true,
      port: 0,
      disclosureIntervalSeconds: 0,
      electionFactoryAddress: '0x1111111111111111111111111111111111111111',
      ballotInboxAddress: '0x2222222222222222222222222222222222222222',
    });
    app = created.app;
    store = created.store;
    server = await listen(app);
    base = `http://127.0.0.1:${server.address().port}`;
    await api('POST', '/api/auth/dev-login', {
      body: { handle: 'admin', role: 'platform_admin' },
      jar: adminJar,
    });
    await api('POST', '/api/auth/dev-login', {
      body: { handle: 'voter', role: 'voter' },
      jar: voterJar,
    });
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await rm(tmp, { recursive: true, force: true });
  });

  test('second ballot is rejected even with a new ciphertext; receipts hide choice', async () => {
    const created = await api('POST', '/api/elections', {
      jar: adminJar,
      body: {
        title: 'Coercion slice',
        startTime: nowSec() - 10,
        cutoffTime: nowSec() + 3600,
        treeDepth: 16,
        questions: [
          {
            type: 'YES_NO',
            prompt: 'Sample?',
            options: [
              { id: 'yes', label: 'Yes' },
              { id: 'no', label: 'No' },
            ],
          },
        ],
      },
    });
    assert.equal(created.status, 201, created.json?.error);
    const id = created.json.id;
    const reg = await api('POST', `/api/elections/${id}/register`, {
      jar: voterJar,
      body: { identityCommitment: '0xca11' },
    });
    assert.equal(reg.status, 201, reg.json?.error);
    const freeze = await api('POST', `/api/elections/${id}/freeze`, { jar: adminJar });
    assert.equal(freeze.status, 200, freeze.json?.error);

    const first = await api('POST', `/api/elections/${id}/vote`, {
      body: {
        proof: { accept: true },
        publicInputs: { nullifier: '0xabc', electionId: id },
        encryptedBallot: '0x01',
      },
    });
    assert.equal(first.status, 201, first.json?.error);
    assert.equal(first.json.generation, undefined);
    assert.equal(first.json.superseded, undefined);
    assert.equal(first.json.vote.choice, undefined);
    assert.equal(first.json.vote.generation, undefined);

    const replay = await api('POST', `/api/elections/${id}/vote`, {
      body: {
        proof: { accept: true },
        publicInputs: { nullifier: '0xabc', electionId: id },
        encryptedBallot: '0x01',
      },
    });
    assert.equal(replay.status, 409);
    assert.equal(replay.json.code, 'NULLIFIER_USED');

    const changedMind = await api('POST', `/api/elections/${id}/vote`, {
      body: {
        proof: { accept: true },
        publicInputs: { nullifier: '0xabc', electionId: id },
        encryptedBallot: '0x02',
      },
    });
    assert.equal(changedMind.status, 409, 'a new ciphertext must not be a second ballot');
    assert.equal(changedMind.json.code, 'NULLIFIER_USED');

    const election = store.requireElection(id);
    assert.equal(election.acceptedBallots, 1, 'double voting must remain impossible');
    const envelopes = store.listEnvelopes(id);
    assert.equal(envelopes.length, 1);
    assert.equal(envelopes[0].choice, undefined);
    assert.equal(envelopes[0].encryptedBallot, '0x01');

    const ballots = await api('GET', `/api/elections/${id}/ballots`);
    assert.equal(ballots.json.acceptedBallots, 1);
    assert.equal(ballots.json.ballots.length, 1);
    assert.equal(ballots.json.ballots[0].generation, undefined);
    assert.equal(ballots.json.ballots[0].choice, undefined);
    assert.equal(ballots.json.ballots[0].supersededHashes, undefined);

    election.cutoffTime = nowSec() - 1;
    await store.persist();
    const tally = await api('POST', `/api/elections/${id}/tally`, {
      jar: adminJar,
      body: { counts: [1, 0] },
    });
    assert.equal(tally.status, 200, tally.json?.error);

    const artifacts = await api('GET', `/api/elections/${id}/artifacts`);
    assert.equal(artifacts.status, 200);
    assert.equal(artifacts.json.schema, 'republic.auditor.v1');
    assert.equal(artifacts.json.nfp, true);
    assert.equal(artifacts.json.acceptedBallots, 1);
    assert.equal(artifacts.json.coercion.receiptsProveChoice, false);
    assert.equal(artifacts.json.coercion.policy, 'one-ballot-per-nullifier');
    assert.equal(artifacts.json.disclosedBallots[0].generation, undefined);
    assert.equal(artifacts.json.disclosedBallots[0].supersededHashes, undefined);
    const verified = verifyAuditorBundle(artifacts.json);
    assert.equal(verified.ok, true, verified.errors.join('; '));
  });

  test('GET /api/config publishes coercion policy and addresses, not keys', async () => {
    const { json } = await api('GET', '/api/config');
    assert.equal(json.coercion.receiptsProveChoice, false);
    assert.equal(json.coercion.policy, 'one-ballot-per-nullifier');
    assert.equal(json.addresses.factory, '0x1111111111111111111111111111111111111111');
    assert.equal(json.relayerPrivateKey, undefined);
  });
});

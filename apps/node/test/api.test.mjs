// NOT FOR PROFIT — civic public good, not a commercial product.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { createApp } from '../src/server.mjs';
import { toBytes32 } from '../src/merkle.mjs';

let tmp;
let app;
let store;
let explorer;
let server;
let base;
const adminJar = {};
const voterJar = {};
const officerJar = {};

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

async function api(method, url, { body, jar, headers } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(jar ? { cookie: cookieHeader(jar) } : {}),
      ...headers,
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

function walk(value, visit) {
  if (!value || typeof value !== 'object') return;
  visit(value);
  for (const child of Object.values(value)) walk(child, visit);
}

describe('Republic Node API', () => {
  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'republic-node-'));
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
    explorer = created.explorer;
    server = await listen(app);
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await rm(tmp, { recursive: true, force: true });
  });

  test('GET /health', async () => {
    const { status, json } = await api('GET', '/health');
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.app, 'zk-voting');
    assert.equal(json.nfp, true);
    assert.equal(typeof json.chainId, 'number');
  });

  test('GET /api/config advertises proving path in progress', async () => {
    const { status, json } = await api('GET', '/api/config');
    assert.equal(status, 200);
    assert.equal(json.vote.origin, json.vote.fqdn ? `https://${json.vote.fqdn}` : null);
    assert.equal(json.proving.path, 'in-progress');
    assert.equal(json.proving.ceremony, 'not-done');
    assert.equal(json.proving.mockVerifierDefault, true);
    assert.equal(json.proving.provingPath, false);
    assert.equal(json.proving.poseidonWired, true);
    assert.equal(json.proving.circuitHashScheme, 'republic.hash.poseidon-bn254-x5-t3-v1');
    assert.match(json.proving.hashScheme, /keccak-dev-v1/);
  });

  test('SPA fallback serves HTML for non-API GET', async () => {
    const explorerPage = await api('GET', '/explorer');
    assert.equal(explorerPage.status, 200);
    assert.match(explorerPage.res.headers.get('content-type') || '', /html/);
    assert.match(explorerPage.text, /NOT FOR PROFIT/);

    const votePage = await api('GET', '/vote/1');
    assert.equal(votePage.status, 200);
    assert.match(votePage.text, /NOT FOR PROFIT/);
    assert.match(votePage.text, /loading/i);

    const uuidPage = await api('GET', '/vote/3f1c0a6e-9b2d-4e11-8c7a-1a2b3c4d5e01');
    assert.equal(uuidPage.status, 200);
    assert.match(uuidPage.text, /NOT FOR PROFIT/);

    const resultsPage = await api('GET', '/elections/1/results');
    assert.equal(resultsPage.status, 200);
    assert.match(resultsPage.res.headers.get('content-type') || '', /html/);
    assert.match(resultsPage.text, /NOT FOR PROFIT/);
  });

  test('unknown API route is JSON 404', async () => {
    const { status, json } = await api('GET', '/api/does-not-exist');
    assert.equal(status, 404);
    assert.equal(json.nfp, true);
    assert.equal(json.error, 'not found');
  });

  test('GET /api/me unauthenticated', async () => {
    const { status, json } = await api('GET', '/api/me');
    assert.equal(status, 200);
    assert.equal(json.user, null);
    assert.equal(json.nfp, true);
  });

  test('POST /api/elections requires auth', async () => {
    const { status } = await api('POST', '/api/elections', { body: { title: 'x' } });
    assert.equal(status, 401);
  });

  test('dev-login seeds platform_super_admin and sets cookie', async () => {
    const { status, json } = await api('POST', '/api/auth/dev-login', {
      body: { handle: 'admin' },
      jar: adminJar,
    });
    assert.equal(status, 200);
    assert.equal(json.user.role, 'platform_super_admin');
    assert.ok(adminJar['republic.sid']);
    const me = await api('GET', '/api/me', { jar: adminJar });
    assert.equal(me.json.user.handle, 'admin');
  });

  test('passkey register begin uses rpName Republic', async () => {
    const { status, json } = await api('POST', '/api/auth/passkey/register/begin', {
      body: { handle: 'alice', acceptedTerms: true },
    });
    assert.equal(status, 200);
    assert.equal(json.rp?.name || json.rpName, 'Republic');
    assert.ok(json.challenge);
    assert.equal(json.authenticatorSelection?.residentKey, 'required');
  });

  test('passkey login begin returns a challenge', async () => {
    const { status, json } = await api('POST', '/api/auth/passkey/login/begin', {
      body: { handle: 'admin' },
    });
    assert.equal(status, 200);
    assert.ok(json.challenge);
  });

  let electionId;

  test('clerk/admin creates an election', async () => {
    const startTime = nowSec() - 60;
    const cutoffTime = nowSec() + 3600;
    const { status, json } = await api('POST', '/api/elections', {
      jar: adminJar,
      body: {
        title: 'Demo general',
        startTime,
        cutoffTime,
        maxParticipants: 0,
        treeDepth: 16,
        jurisdictionId: 'demo',
        questions: [{ type: 'YES_NO', prompt: 'Adopt the measure?' }],
      },
    });
    assert.equal(status, 201, json?.error);
    electionId = json.election.id;
    assert.match(String(electionId), /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(json.id, electionId);
    assert.equal(json.shortCode, json.election.shortCode);
    assert.equal(typeof json.shortCode, 'string');
    assert.ok(json.shortCode.length >= 8);
    assert.equal(json.election.stateName, 'Created');
    assert.equal(json.election.rollFrozen, false);
    assert.ok(json.election.ballotSpecHash);
    assert.equal(json.chainMode, 'demo');
    assert.match(String(json.onChainElectionId), /^\d+$/);
    assert.equal(json.election.chainMode, 'demo');
    assert.equal(json.election.onChainElectionId, json.onChainElectionId);
    assert.equal(json.onChainElectionAddress, null);
  });

  test('voter cannot create an election', async () => {
    await api('POST', '/api/auth/dev-login', {
      body: { handle: 'voter1', role: 'voter' },
      jar: voterJar,
    });
    const { status } = await api('POST', '/api/elections', {
      jar: voterJar,
      body: { title: 'nope', startTime: nowSec(), cutoffTime: nowSec() + 10 },
    });
    assert.equal(status, 403);
  });

  test('register after passkey is pending until a civil officer approves', async () => {
    const { status, json } = await api('POST', `/api/elections/${electionId}/register`, {
      jar: voterJar,
      body: { identityCommitment: '0x1234' },
    });
    assert.equal(status, 202, json?.error);
    assert.equal(json.status, 'pending');
    assert.equal(json.code, 'PENDING_REVIEW');
    const empty = await api('GET', `/api/elections/${electionId}/registrations`, { jar: adminJar });
    assert.equal(empty.json.registrations.length, 0);
    const approved = await api(
      'POST',
      `/api/elections/${electionId}/registration-requests/${json.request.id}/approve`,
      { jar: adminJar, body: {} },
    );
    assert.equal(approved.status, 200, approved.json?.error);
    assert.equal(approved.json.identityCommitment, toBytes32('0x1234'));
    assert.equal(approved.json.leafIndex, 0);
    assert.equal(approved.json.eligibleRoot.startsWith('0x'), true);
    const list = await api('GET', `/api/elections/${electionId}/registrations`, { jar: adminJar });
    assert.equal(list.json.registrations.length, 1);
    assert.equal(list.json.registrations[0].userId, undefined);
  });

  test('vote is rejected before freeze', async () => {
    const { status, json } = await api('POST', `/api/elections/${electionId}/vote`, {
      body: {
        proof: { accept: true },
        publicInputs: { nullifier: 1, electionId },
        encryptedBallot: '0xab',
      },
    });
    assert.equal(status, 400);
    assert.equal(json.code, 'ROLL_NOT_FROZEN');
  });

  test('freeze roll then accept a relayed vote', async () => {
    const freeze = await api('POST', `/api/elections/${electionId}/freeze`, { jar: adminJar });
    assert.equal(freeze.status, 200, freeze.json?.error);
    assert.equal(freeze.json.election.rollFrozen, true);
    assert.equal(freeze.json.election.frozenEligibleRoot, freeze.json.election.eligibleRoot);
    assert.equal(
      freeze.json.election.frozenDisqualificationRoot,
      freeze.json.election.disqualificationRoot,
    );

    const { status, json } = await api('POST', `/api/elections/${electionId}/vote`, {
      body: {
        proof: { accept: true },
        publicInputs: { nullifier: '99', electionId, root: freeze.json.election.eligibleRoot },
        encryptedBallot: '0xc0ffee',
        identityCommitment: '0x1234',
        userId: 'should-never-be-stored',
        choice: 1,
        optionId: 'yes',
      },
    });
    assert.equal(status, 201, json?.error);
    assert.deepEqual(Object.keys(json.vote).sort(), [
      'ballotHash',
      'electionId',
      'nullifier',
      'relayer',
    ]);
    assert.equal(json.vote.relayer, 'node');
    assert.equal(json.vote.userId, undefined);
    assert.equal(json.vote.choice, undefined);
  });

  test('nullifier uniqueness', async () => {
    const { status, json } = await api('POST', `/api/elections/${electionId}/vote`, {
      body: {
        proof: { accept: true },
        publicInputs: { nullifier: '99', electionId },
        encryptedBallot: '0xc0ffee',
        identityCommitment: '0x1234',
      },
    });
    assert.equal(status, 409);
    assert.equal(json.code, 'NULLIFIER_USED');
  });

  test('vote records never map passkey user id to a ballot', async () => {
    const snap = store.snapshot();
    for (const vote of snap.votes) {
      assert.deepEqual(Object.keys(vote).sort(), [
        'acceptedAt',
        'ballotHash',
        'electionId',
        'nullifier',
        'relayer',
      ]);
    }
    for (const env of snap.envelopes) {
      assert.equal(env.userId, undefined);
      assert.equal(env.choice, undefined);
      assert.ok(env.encryptedBallot);
    }
    const raw = JSON.parse(await readFile(path.join(tmp, 'republic.json'), 'utf8'));
    let leaks = 0;
    walk(raw, (obj) => {
      const keys = Object.keys(obj);
      const hasUser = keys.includes('userId') || keys.includes('passkeyUserId');
      const hasBallot = keys.includes('encryptedBallot') || keys.includes('choice');
      if (hasUser && hasBallot) leaks += 1;
    });
    assert.equal(leaks, 0);
  });

  test('explorer lists blocks for register, freeze, and vote', async () => {
    const { status, json } = await api('GET', '/api/explorer/blocks');
    assert.equal(status, 200);
    assert.ok(json.blocks.length >= 3);
    assert.equal(json.chainId, explorer.chain.chainId);
    const one = await api('GET', `/api/explorer/blocks/${json.blocks[0].number}`);
    assert.equal(one.status, 200);
    assert.ok(one.json.block.txs.length >= 1);
    const hash = json.blocks[0].transactions[0];
    const tx = await api('GET', `/api/explorer/txs/${hash}`);
    assert.equal(tx.status, 200);
    assert.equal(tx.json.tx.hash, hash);
    assert.equal(tx.json.tx.payload?.choice, undefined);
    assert.equal(tx.json.tx.payload?.userId, undefined);
  });

  test('public ballots list is nullifiers + hashes only', async () => {
    const { json } = await api('GET', `/api/elections/${electionId}/ballots`);
    assert.equal(json.acceptedBallots, 1);
    assert.equal(json.ballots[0].relayer, 'node');
    assert.equal(json.ballots[0].encryptedBallot, undefined);
  });

  test('second vote (new nullifier) then tally after cutoff', async () => {
    const v2 = await api('POST', `/api/elections/${electionId}/vote`, {
      body: {
        proof: { accept: true },
        publicInputs: { nullifier: 100, electionId },
        encryptedBallot: '0xdd',
        identityCommitment: '0x1234',
      },
    });
    assert.equal(v2.status, 201, v2.json?.error);

    const election = store.requireElection(electionId);
    election.cutoffTime = nowSec() - 1;
    await store.persist();

    const closed = await api('POST', `/api/elections/${electionId}/vote`, {
      body: {
        proof: { accept: true },
        publicInputs: { nullifier: 101, electionId },
        encryptedBallot: '0xee',
      },
    });
    assert.equal(closed.status, 400);
    assert.equal(closed.json.code, 'CLOSED');

    const badTally = await api('POST', `/api/elections/${electionId}/tally`, {
      jar: adminJar,
      body: { counts: [99, 0] },
    });
    assert.equal(badTally.status, 400);
    assert.equal(badTally.json.code, 'TALLY_MISMATCH');

    const ok = await api('POST', `/api/elections/${electionId}/tally`, {
      jar: adminJar,
      body: { counts: [2, 0] },
    });
    assert.equal(ok.status, 200, ok.json?.error);
    assert.equal(ok.json.election.stateName, 'Tallied');
    assert.deepEqual(ok.json.election.tally.counts, [2, 0]);
    assert.equal(ok.json.l1Certification.status, 'skipped');
    assert.equal(ok.json.election.tally.l1.status, 'skipped');
  });

  test('disqualify after freeze is rejected', async () => {
    await api('POST', '/api/auth/dev-login', {
      body: { handle: 'officer', role: 'voter' },
      jar: officerJar,
    });
    const grant = await api('POST', '/api/jurisdictions/demo/roles', {
      jar: adminJar,
      body: { handle: 'officer', role: 'disqualification_officer' },
    });
    assert.equal(grant.status, 200, grant.json?.error);
    const { status, json } = await api('POST', `/api/elections/${electionId}/disqualify`, {
      jar: officerJar,
      body: { identityCommitment: '0x1234', reasonCode: 2 },
    });
    assert.equal(status, 409);
    assert.equal(json.code, 'ROLL_FROZEN');
  });

  test('maxParticipants cap and disqualify before freeze', async () => {
    const created = await api('POST', '/api/elections', {
      jar: adminJar,
      body: {
        title: 'Capped',
        startTime: nowSec() + 60,
        cutoffTime: nowSec() + 3600,
        maxParticipants: 1,
        treeDepth: 16,
        lateUpdateAllowed: false,
        questions: [{ type: 'YES_NO', prompt: '?' }],
      },
    });
    assert.equal(created.status, 201, created.json?.error);
    const id = created.json.election.id;
    const voterMe = await api('GET', '/api/me', { jar: voterJar });
    const voterId = voterMe.json.user.id;
    const r1 = await api('POST', `/api/elections/${id}/register`, {
      jar: adminJar,
      body: { identityCommitment: 1, userId: voterId },
    });
    assert.equal(r1.status, 201, r1.json?.error);
    const r2 = await api('POST', `/api/elections/${id}/register`, {
      jar: adminJar,
      body: { identityCommitment: 2 },
    });
    assert.equal(r2.status, 409);

    const dq = await api('POST', `/api/elections/${id}/disqualify`, {
      jar: officerJar,
      body: { identityCommitment: 1, reasonCode: 1, evidenceHash: '0xabc' },
    });
    assert.equal(dq.status, 201, dq.json?.error);
    assert.equal(dq.json.disqualification.reasonCode, 1);
    const detail = await api('GET', `/api/elections/${id}`, { jar: voterJar });
    assert.equal(detail.json.me.disqualified, true);
    assert.equal(detail.json.me.eligible, false);
    assert.equal(detail.json.me.reasonCode, 1);
  });

  test('reason codes catalog matches Solidity 1..14', async () => {
    const { json } = await api('GET', '/api/reason-codes');
    assert.equal(json.reasonCodes.length, 14);
    assert.equal(json.reasonCodes[0].name, 'NOT_OF_AGE');
    assert.equal(json.reasonCodes[13].name, 'OTHER');
  });

  test('CORS preflight is open for local', async () => {
    const { res } = await api('OPTIONS', '/api/elections', {
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'POST',
      },
    });
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  });

  test('jurisdictions list includes seeded demo', async () => {
    const { json } = await api('GET', '/api/jurisdictions');
    assert.ok(json.jurisdictions.some((j) => j.id === 'demo'));
    assert.ok(json.jurisdictions.every((j) => j.officers === undefined));
  });

  test('vote accepts the SPA body (publicInputs nested on proof)', async () => {
    const created = await api('POST', '/api/elections', {
      jar: adminJar,
      body: {
        title: 'SPA shape',
        startTime: nowSec() - 10,
        cutoffTime: nowSec() + 3600,
        treeDepth: 16,
        questions: [{ type: 'YES_NO', prompt: '?' }],
      },
    });
    assert.equal(created.status, 201, created.json?.error);
    const id = created.json.id;
    const reg = await api('POST', `/api/elections/${id}/register`, {
      jar: adminJar,
      body: { identityCommitment: '0xabc1' },
    });
    assert.equal(reg.status, 201, reg.json?.error);
    const freeze = await api('POST', `/api/elections/${id}/freeze`, { jar: adminJar });
    assert.equal(freeze.status, 200, freeze.json?.error);
    const { status, json } = await api('POST', `/api/elections/${id}/vote`, {
      body: {
        identityCommitment: '0xabc1',
        address: '0xdead',
        credentialId: 'cred',
        nullifier: '0xfeed',
        ballotHash: `0x${'11'.repeat(32)}`,
        encryptedBallot: '0xc0ffee11',
        proof: {
          mock: true,
          a: ['0x0', '0x0'],
          b: [
            ['0x0', '0x0'],
            ['0x0', '0x0'],
          ],
          c: ['0x0', '0x0'],
          publicInputs: [
            freeze.json.election.eligibleRoot,
            freeze.json.election.disqualificationRoot,
            '0xfeed',
            `0x${'11'.repeat(32)}`,
            String(id),
          ],
        },
      },
    });
    assert.equal(status, 201, json?.error);
    assert.equal(json.accepted, true);
    assert.equal(json.vote.relayer, 'node');
    assert.equal(json.vote.userId, undefined);
    assert.equal(json.vote.identityCommitment, undefined);
  });

  test('vote rejects a 4-signal publicInputs array (disqRoot required)', async () => {
    const created = await api('POST', '/api/elections', {
      jar: adminJar,
      body: {
        title: 'Four-signal rejected',
        startTime: nowSec() - 10,
        cutoffTime: nowSec() + 3600,
        treeDepth: 16,
        questions: [{ type: 'YES_NO', prompt: '?' }],
      },
    });
    assert.equal(created.status, 201, created.json?.error);
    const id = created.json.id;
    const reg = await api('POST', `/api/elections/${id}/register`, {
      jar: adminJar,
      body: { identityCommitment: '0xabc2' },
    });
    assert.equal(reg.status, 201, reg.json?.error);
    const freeze = await api('POST', `/api/elections/${id}/freeze`, { jar: adminJar });
    assert.equal(freeze.status, 200, freeze.json?.error);
    const { status, json } = await api('POST', `/api/elections/${id}/vote`, {
      body: {
        nullifier: '0xfeed',
        ballotHash: `0x${'11'.repeat(32)}`,
        encryptedBallot: '0xc0ffee22',
        proof: {
          mock: true,
          a: ['0x0', '0x0'],
          b: [
            ['0x0', '0x0'],
            ['0x0', '0x0'],
          ],
          c: ['0x0', '0x0'],
          publicInputs: [freeze.json.election.eligibleRoot, '0xfeed', `0x${'11'.repeat(32)}`, String(id)],
        },
      },
    });
    assert.equal(status, 400);
    assert.equal(json.code, 'INVALID_PUBLIC_INPUTS');
  });
});

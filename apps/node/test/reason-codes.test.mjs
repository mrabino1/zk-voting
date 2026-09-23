// NOT FOR PROFIT — civic public good, not a commercial product.
// Reason-code catalog plus the roll helper. The vote POST does not carry the
// leaf: banned identity keys are ignored. `store.assertCanVote` still encodes
// registered ∩ ¬disqualified for callers that already have a commitment.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { MAX_CODE, REASON_CODES, isValidReasonCode, reasonName } from '../src/reasonCodes.mjs';
import { HttpError } from '../src/http.mjs';
import { emptyTree, insertLeaf, toBytes32 } from '../src/merkle.mjs';
import { createApp } from '../src/server.mjs';

let tmp;
let app;
let store;
let server;
let base;
const adminJar = {};
const voterJar = {};
const voter2Jar = {};
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

function expectedEligibleRoot(treeDepth, commitments) {
  const tree = emptyTree(treeDepth);
  for (const c of commitments) insertLeaf(tree, toBytes32(c));
  return tree.root;
}

async function createOpenElection({ title, lateUpdateAllowed = false } = {}) {
  const created = await api('POST', '/api/elections', {
    jar: adminJar,
    body: {
      title: title || 'Eligibility',
      startTime: nowSec() - 60,
      cutoffTime: nowSec() + 3600,
      treeDepth: 16,
      jurisdictionId: 'demo',
      lateUpdateAllowed,
      questions: [{ type: 'YES_NO', prompt: '?' }],
    },
  });
  assert.equal(created.status, 201, created.json?.error);
  return created.json.election.id;
}

async function vote(electionId, { identityCommitment, nullifier, root, disqRoot }) {
  return api('POST', `/api/elections/${electionId}/vote`, {
    body: {
      proof: { accept: true },
      publicInputs: {
        nullifier,
        electionId,
        root,
        disqRoot,
      },
      encryptedBallot: '0xc0ffee',
      identityCommitment,
    },
  });
}

describe('reason codes and Node disqualification vote gate', () => {
  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'republic-reason-'));
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
    await api('POST', '/api/auth/dev-login', {
      body: { handle: 'voter1', role: 'voter' },
      jar: voterJar,
    });
    await api('POST', '/api/auth/dev-login', {
      body: { handle: 'voter2', role: 'voter' },
      jar: voter2Jar,
    });
    await api('POST', '/api/auth/dev-login', {
      body: { handle: 'officer', role: 'voter' },
      jar: officerJar,
    });
    const grant = await api('POST', '/api/jurisdictions/demo/roles', {
      jar: adminJar,
      body: { handle: 'officer', role: 'disqualification_officer' },
    });
    assert.equal(grant.status, 200, grant.json?.error);
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await rm(tmp, { recursive: true, force: true });
  });

  test('catalog matches Solidity uint16 1..14', () => {
    assert.equal(REASON_CODES.length, 14);
    assert.equal(MAX_CODE, 14);
    assert.equal(REASON_CODES[0].name, 'NOT_OF_AGE');
    assert.equal(REASON_CODES[13].name, 'OTHER');
    assert.equal(isValidReasonCode(0), false);
    assert.equal(isValidReasonCode(1), true);
    assert.equal(isValidReasonCode(14), true);
    assert.equal(isValidReasonCode(15), false);
    assert.equal(reasonName(2), 'NOT_RESIDENT');
    assert.equal(reasonName(99), null);
  });

  test('GET /api/reason-codes matches the in-process catalog', async () => {
    const { status, json } = await api('GET', '/api/reason-codes');
    assert.equal(status, 200);
    assert.equal(json.reasonCodes.length, 14);
    assert.deepEqual(
      json.reasonCodes.map((r) => r.name),
      REASON_CODES.map((r) => r.name),
    );
  });

  test('invalid reasonCode is rejected', async () => {
    const id = await createOpenElection({ title: 'Bad code' });
    const bad = await api('POST', `/api/elections/${id}/disqualify`, {
      jar: officerJar,
      body: { identityCommitment: '0x11', reasonCode: 99 },
    });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /reasonCode/i);
  });

  test('disqualify rebuilds eligibleRoot as registered ∩ ¬currently-disqualified', async () => {
    const id = await createOpenElection({ title: 'Rebuild eligible' });
    const a = await api('POST', `/api/elections/${id}/register`, {
      jar: adminJar,
      body: { identityCommitment: '0xa1' },
    });
    const b = await api('POST', `/api/elections/${id}/register`, {
      jar: adminJar,
      body: { identityCommitment: '0xb2' },
    });
    assert.equal(a.status, 201, a.json?.error);
    assert.equal(b.status, 201, b.json?.error);
    const before = store.requireElection(id).eligibleRoot;
    assert.equal(before, expectedEligibleRoot(16, ['0xa1', '0xb2']));

    const dq = await api('POST', `/api/elections/${id}/disqualify`, {
      jar: officerJar,
      body: { identityCommitment: '0xa1', reasonCode: 2 },
    });
    assert.equal(dq.status, 201, dq.json?.error);
    assert.equal(dq.json.disqualification.reasonCode, 2);
    const election = store.requireElection(id);
    const expected = expectedEligibleRoot(16, ['0xb2']);
    assert.equal(election.eligibleRoot, expected);
    assert.equal(dq.json.eligibleRoot, expected);
    assert.notEqual(election.eligibleRoot, before);
    assert.equal(election.eligibleCount, 1);
    assert.equal(election.participantCount, 2);
  });

  test('vote POST ignores the leaf; the roll helper still blocks a disqualified commitment', async () => {
    const id = await createOpenElection({ title: 'Block vote' });
    await api('POST', `/api/elections/${id}/register`, {
      jar: adminJar,
      body: { identityCommitment: '0xc1' },
    });
    await api('POST', `/api/elections/${id}/register`, {
      jar: adminJar,
      body: { identityCommitment: '0xc2' },
    });
    const dq = await api('POST', `/api/elections/${id}/disqualify`, {
      jar: officerJar,
      body: { identityCommitment: '0xc1', reasonCode: 5 },
    });
    assert.equal(dq.status, 201, dq.json?.error);

    const freeze = await api('POST', `/api/elections/${id}/freeze`, { jar: adminJar });
    assert.equal(freeze.status, 200, freeze.json?.error);
    assert.equal(freeze.json.election.frozenEligibleRoot, freeze.json.election.eligibleRoot);
    assert.equal(freeze.json.election.eligibleCount, 1);
    assert.equal(
      freeze.json.election.eligibleRoot,
      expectedEligibleRoot(16, ['0xc2']),
    );

    assert.throws(
      () => store.assertCanVote(id, '0xc1'),
      (err) => {
        assert.equal(err instanceof HttpError, true);
        assert.equal(err.status, 403);
        assert.equal(err.extra.code, 'DISQUALIFIED');
        assert.equal(err.extra.reasonCode, 5);
        assert.equal(err.extra.reasonName, 'DECEASED');
        return true;
      },
    );
    store.assertCanVote(id, '0xc2');

    const ignored = await vote(id, { identityCommitment: '0xc1', nullifier: '11' });
    assert.equal(ignored.status, 201, ignored.json?.error);
    assert.equal(ignored.json.vote.identityCommitment, undefined);
    assert.equal(ignored.json.vote.userId, undefined);
    assert.equal(ignored.json.code, undefined);

    const registrationOnly = expectedEligibleRoot(16, ['0xc1', '0xc2']);
    const staleRoot = await vote(id, {
      identityCommitment: '0xc2',
      nullifier: '13',
      root: registrationOnly,
      disqRoot: freeze.json.election.disqualificationRoot,
    });
    assert.equal(staleRoot.status, 400);
    assert.equal(staleRoot.json.code, 'ELIGIBLE_ROOT_MISMATCH');

    const ok = await vote(id, { identityCommitment: '0xc2', nullifier: '12' });
    assert.equal(ok.status, 201, ok.json?.error);
    assert.equal(ok.json.vote.identityCommitment, undefined);
    assert.equal(ok.json.vote.userId, undefined);
  });

  test('unregistered commitment is a roll-helper rejection, not a vote-body field', async () => {
    const id = await createOpenElection({ title: 'Unregistered' });
    await api('POST', `/api/elections/${id}/register`, {
      jar: adminJar,
      body: { identityCommitment: '0xd1' },
    });
    const freeze = await api('POST', `/api/elections/${id}/freeze`, { jar: adminJar });
    assert.equal(freeze.status, 200, freeze.json?.error);
    assert.throws(
      () => store.assertCanVote(id, '0xd2'),
      (err) => err instanceof HttpError && err.extra.code === 'NOT_REGISTERED',
    );
    const missing = await vote(id, { identityCommitment: '0xd2', nullifier: '21' });
    assert.equal(missing.status, 201, missing.json?.error);
    assert.equal(missing.json.vote.identityCommitment, undefined);
  });

  test('vote POST does not require identityCommitment and ignores banned keys', async () => {
    const id = await createOpenElection({ title: 'Envelope only' });
    await api('POST', `/api/elections/${id}/register`, {
      jar: adminJar,
      body: { identityCommitment: '0xe1' },
    });
    const freeze = await api('POST', `/api/elections/${id}/freeze`, { jar: adminJar });
    assert.equal(freeze.status, 200, freeze.json?.error);
    const clean = await api('POST', `/api/elections/${id}/vote`, {
      body: {
        proof: { accept: true },
        publicInputs: { nullifier: '31', electionId: id },
        encryptedBallot: '0xab',
      },
    });
    assert.equal(clean.status, 201, clean.json?.error);
    assert.equal(clean.json.vote.identityCommitment, undefined);

    const dirty = await api('POST', `/api/elections/${id}/vote`, {
      body: {
        proof: { accept: true, userId: 'should-drop', answers: [{ optionIds: ['yes'] }] },
        publicInputs: { nullifier: '32', electionId: id },
        encryptedBallot: '0xcd',
        identityCommitment: '0xe1',
        address: '0x1111111111111111111111111111111111111111',
        credentialId: 'cred-1',
        answers: [{ questionId: 'q', optionIds: ['yes'] }],
        choice: 1,
      },
    });
    assert.equal(dirty.status, 201, dirty.json?.error);
    assert.equal(dirty.json.vote.identityCommitment, undefined);
    assert.equal(dirty.json.vote.answers, undefined);
    assert.equal(dirty.json.vote.address, undefined);
    assert.equal(dirty.json.vote.credentialId, undefined);
    for (const env of store.listEnvelopes(id)) {
      assert.equal(env.identityCommitment, undefined);
      assert.equal(env.answers, undefined);
      assert.equal(env.address, undefined);
      assert.equal(env.credentialId, undefined);
      assert.equal(env.userId, undefined);
      assert.equal(env.choice, undefined);
    }
    assert.throws(
      () => store.assertCanVote(id, ''),
      (err) => err instanceof HttpError && err.extra.code === 'IDENTITY_COMMITMENT_REQUIRED',
    );
  });

  test('revoke restores the ability to vote if still registered and freeze has not locked the roll', async () => {
    const id = await createOpenElection({ title: 'Revoke restores' });
    await api('POST', `/api/elections/${id}/register`, {
      jar: adminJar,
      body: { identityCommitment: '0xf1' },
    });
    const dq = await api('POST', `/api/elections/${id}/disqualify`, {
      jar: officerJar,
      body: { identityCommitment: '0xf1', reasonCode: 6 },
    });
    assert.equal(dq.status, 201, dq.json?.error);
    assert.equal(store.requireElection(id).eligibleCount, 0);

    const revoked = await api('POST', `/api/elections/${id}/revoke`, {
      jar: officerJar,
      body: { identityCommitment: '0xf1' },
    });
    assert.equal(revoked.status, 200, revoked.json?.error);
    const restored = store.requireElection(id);
    assert.equal(restored.eligibleCount, 1);
    assert.equal(restored.eligibleRoot, expectedEligibleRoot(16, ['0xf1']));

    const freeze = await api('POST', `/api/elections/${id}/freeze`, { jar: adminJar });
    assert.equal(freeze.status, 200, freeze.json?.error);
    const ok = await vote(id, { identityCommitment: '0xf1', nullifier: '41' });
    assert.equal(ok.status, 201, ok.json?.error);
  });

  test('after freeze, revoke is rejected unless lateUpdateAllowed', async () => {
    const id = await createOpenElection({ title: 'Frozen revoke' });
    await api('POST', `/api/elections/${id}/register`, {
      jar: adminJar,
      body: { identityCommitment: '0xf2' },
    });
    await api('POST', `/api/elections/${id}/disqualify`, {
      jar: officerJar,
      body: { identityCommitment: '0xf2', reasonCode: 9 },
    });
    const freeze = await api('POST', `/api/elections/${id}/freeze`, { jar: adminJar });
    assert.equal(freeze.status, 200, freeze.json?.error);
    const snapEligible = freeze.json.election.frozenEligibleRoot;
    const snapDisq = freeze.json.election.frozenDisqualificationRoot;
    assert.ok(snapEligible);
    assert.ok(snapDisq);

    const lateRevoke = await api('POST', `/api/elections/${id}/revoke`, {
      jar: officerJar,
      body: { identityCommitment: '0xf2' },
    });
    assert.equal(lateRevoke.status, 409);
    assert.equal(lateRevoke.json.code, 'ROLL_FROZEN');

    assert.throws(
      () => store.assertCanVote(id, '0xf2'),
      (err) => err instanceof HttpError && err.extra.code === 'DISQUALIFIED',
    );
    const stillIgnored = await vote(id, { identityCommitment: '0xf2', nullifier: '51' });
    assert.equal(stillIgnored.status, 201, stillIgnored.json?.error);
    assert.equal(stillIgnored.json.vote.identityCommitment, undefined);
    assert.equal(store.requireElection(id).frozenEligibleRoot, snapEligible);
    assert.equal(store.requireElection(id).eligibleRoot, snapEligible);
  });

  test('lateUpdateAllowed: post-freeze disqualify blocks, revoke restores', async () => {
    const id = await createOpenElection({ title: 'Late update', lateUpdateAllowed: true });
    await api('POST', `/api/elections/${id}/register`, {
      jar: adminJar,
      body: { identityCommitment: '0xf3' },
    });
    const freeze = await api('POST', `/api/elections/${id}/freeze`, { jar: adminJar });
    assert.equal(freeze.status, 200, freeze.json?.error);
    const frozenEligible = freeze.json.election.frozenEligibleRoot;

    const dq = await api('POST', `/api/elections/${id}/disqualify`, {
      jar: officerJar,
      body: { identityCommitment: '0xf3', reasonCode: 11 },
    });
    assert.equal(dq.status, 201, dq.json?.error);
    assert.notEqual(store.requireElection(id).eligibleRoot, frozenEligible);
    assert.equal(store.requireElection(id).frozenEligibleRoot, frozenEligible);

    assert.throws(
      () => store.assertCanVote(id, '0xf3'),
      (err) => {
        assert.equal(err instanceof HttpError, true);
        assert.equal(err.extra.code, 'DISQUALIFIED');
        assert.equal(err.extra.reasonCode, 11);
        return true;
      },
    );
    const ignored = await vote(id, { identityCommitment: '0xf3', nullifier: '61' });
    assert.equal(ignored.status, 201, ignored.json?.error);
    assert.equal(ignored.json.vote.identityCommitment, undefined);

    const revoked = await api('POST', `/api/elections/${id}/disqualify/revoke`, {
      jar: officerJar,
      body: { identityCommitment: '0xf3' },
    });
    assert.equal(revoked.status, 200, revoked.json?.error);
    const ok = await vote(id, { identityCommitment: '0xf3', nullifier: '62' });
    assert.equal(ok.status, 201, ok.json?.error);
  });

  test('accepted vote records never store identityCommitment', async () => {
    const snap = store.snapshot();
    for (const voteRow of snap.votes) {
      assert.equal(voteRow.identityCommitment, undefined);
      assert.equal(voteRow.choice, undefined);
      assert.equal(voteRow.userId, undefined);
    }
  });
});

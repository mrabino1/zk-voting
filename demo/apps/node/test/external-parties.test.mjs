// NOT FOR PROFIT — civic public good, not a commercial product.
// Super admin → admin → election staff approvals, and unbounded external
// parties that can veto a registered voter at cast time.

import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { DEMO_JURISDICTION_ID } from '../src/recordIds.mjs';
import { createApp } from '../src/server.mjs';

let tmp;
let server;
let base;
let oracle;
let oracleUrl;
const superJar = {};
const adminJar = {};
const staffJar = {};
const clerkJar = {};
const felonyJar = {};
const voterJar = {};
const otherAdminJar = {};

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

async function createElection(title, jar = clerkJar) {
  const created = await api('POST', '/api/elections', {
    jar,
    body: {
      title,
      startTime: nowSec() - 60,
      cutoffTime: nowSec() + 3600,
      treeDepth: 16,
      jurisdictionId: 'demo',
      questions: [{ type: 'YES_NO', prompt: '?' }],
    },
  });
  assert.equal(created.status, 201, created.json?.error);
  return created.json.election;
}

async function vote(electionId, { identityCommitment, nullifier }) {
  return api('POST', `/api/elections/${electionId}/vote`, {
    body: {
      proof: { accept: true },
      publicInputs: { nullifier, electionId },
      encryptedBallot: '0xc0ffee',
      identityCommitment,
    },
  });
}

describe('approval chain and external vote parties', () => {
  before(async () => {
    oracle = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
      });
      req.on('end', () => {
        let body = {};
        try {
          body = JSON.parse(raw || '{}');
        } catch {
          body = {};
        }
        const commitment = String(body.identityCommitment || '').toLowerCase();
        const deceased = commitment.includes('dead') || commitment.endsWith('aa');
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify(
            deceased ? { allow: false, reasonCode: 5 } : { allow: true },
          ),
        );
      });
    });
    await new Promise((resolve) => oracle.listen(0, '127.0.0.1', resolve));
    oracleUrl = `http://127.0.0.1:${oracle.address().port}/check`;

    tmp = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-parties-'));
    const created = await createApp({
      dataDir: tmp,
      allowDevLogin: true,
      adminHandle: 'admin',
      quiet: true,
      port: 0,
      disclosureIntervalSeconds: 0,
    });
    server = await listen(created.app);
    base = `http://127.0.0.1:${server.address().port}`;

    const superLogin = await api('POST', '/api/auth/dev-login', {
      body: { handle: 'admin' },
      jar: superJar,
    });
    assert.equal(superLogin.status, 200);
    assert.equal(superLogin.json.user.role, 'platform_super_admin');

    for (const [jar, handle, role] of [
      [adminJar, 'county-admin', 'voter'],
      [staffJar, 'poll-staff', 'voter'],
      [clerkJar, 'demo-clerk', 'voter'],
      [felonyJar, 'felony-oracle', 'voter'],
      [voterJar, 'voter-z', 'voter'],
      [otherAdminJar, 'other-admin', 'voter'],
    ]) {
      const { status, json } = await api('POST', '/api/auth/dev-login', {
        body: { handle, role },
        jar,
      });
      assert.equal(status, 200, json?.error);
    }

    const grantClerk = await api('POST', `/api/jurisdictions/${DEMO_JURISDICTION_ID}/roles`, {
      jar: superJar,
      body: { handle: 'demo-clerk', role: 'clerk' },
    });
    assert.equal(grantClerk.status, 200, grantClerk.json?.error);
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await new Promise((resolve) => oracle.close(resolve));
    await rm(tmp, { recursive: true, force: true });
  });

  test('GET /api/roles publishes the three-tier approval chain', async () => {
    const { status, json } = await api('GET', '/api/roles');
    assert.equal(status, 200);
    assert.ok(json.roles.includes('platform_super_admin'));
    assert.ok(json.roles.includes('platform_admin'));
    assert.ok(json.officerRoles.includes('election_staff'));
    assert.equal(
      json.approvalChain.election_staff.includes('external'),
      true,
    );
  });

  test('only super admin may approve a platform admin', async () => {
    const denied = await api('POST', '/api/admin/admins', {
      jar: clerkJar,
      body: { handle: 'county-admin' },
    });
    assert.equal(denied.status, 403);

    const approved = await api('POST', '/api/admin/admins', {
      jar: superJar,
      body: { handle: 'county-admin' },
    });
    assert.equal(approved.status, 201, approved.json?.error);
    assert.equal(approved.json.user.role, 'platform_admin');

    const me = await api('GET', '/api/me', { jar: adminJar });
    assert.equal(me.json.user.role, 'platform_admin');

    const cannotElevate = await api('POST', '/api/admin/admins', {
      jar: adminJar,
      body: { handle: 'other-admin' },
    });
    assert.equal(cannotElevate.status, 403);

    const cannotPatchSuper = await api('PATCH', `/api/users/${me.json.user.id}`, {
      jar: adminJar,
      body: { role: 'platform_super_admin' },
    });
    assert.equal(cannotPatchSuper.status, 403);
  });

  test('admin approves election staff; staff cannot approve more staff', async () => {
    const election = await createElection('Staffed general', clerkJar);
    const denied = await api('POST', `/api/elections/${election.id}/staff`, {
      jar: staffJar,
      body: { handle: 'poll-staff' },
    });
    assert.equal(denied.status, 403);

    const granted = await api('POST', `/api/elections/${election.id}/staff`, {
      jar: adminJar,
      body: { handle: 'poll-staff' },
    });
    assert.equal(granted.status, 201, granted.json?.error);

    const me = await api('GET', '/api/me', { jar: staffJar });
    assert.ok(me.json.electionRoles.some((g) => g.electionId === election.id));
    assert.ok(me.json.roles.includes('ELECTION_STAFF'));
  });

  test('election staff registers unbounded external parties; voters cannot', async () => {
    const election = await createElection('Party factory', clerkJar);
    await api('POST', `/api/elections/${election.id}/staff`, {
      jar: adminJar,
      body: { handle: 'poll-staff' },
    });

    const voterDenied = await api('POST', `/api/elections/${election.id}/parties`, {
      jar: voterJar,
      body: { name: 'Felony', mode: 'veto', handle: 'felony-oracle' },
    });
    assert.equal(voterDenied.status, 403);

    const created = [];
    for (let i = 0; i < 12; i += 1) {
      const add = await api('POST', `/api/elections/${election.id}/parties`, {
        jar: staffJar,
        body: {
          name: `Oracle ${i}`,
          mode: 'veto',
          handle: 'felony-oracle',
          metadataURI: 'ipfs://policy',
        },
      });
      assert.equal(add.status, 201, add.json?.error);
      created.push(add.json.party.id);
    }
    assert.equal(created.length, 12);
    const listed = await api('GET', `/api/elections/${election.id}/parties`);
    assert.equal(listed.status, 200);
    assert.equal(listed.json.parties.length, 12);
    assert.equal(listed.json.parties[0].endpointUrl, undefined);
  });

  test('felony veto blocks a registered voter at cast time', async () => {
    const election = await createElection('Felony gate', clerkJar);
    await api('POST', `/api/elections/${election.id}/staff`, {
      jar: adminJar,
      body: { handle: 'poll-staff' },
    });
    const party = await api('POST', `/api/elections/${election.id}/parties`, {
      jar: staffJar,
      body: { name: 'Felony / INELIGIBLE_STATUS', mode: 'veto', handle: 'felony-oracle' },
    });
    assert.equal(party.status, 201, party.json?.error);
    const partyId = party.json.party.id;

    const reg = await api('POST', `/api/elections/${election.id}/register`, {
      jar: clerkJar,
      body: { identityCommitment: '0xabc1' },
    });
    assert.equal(reg.status, 201, reg.json?.error);
    const freeze = await api('POST', `/api/elections/${election.id}/freeze`, { jar: clerkJar });
    assert.equal(freeze.status, 200, freeze.json?.error);

    const reject = await api('POST', `/api/elections/${election.id}/parties/${partyId}/reject`, {
      jar: felonyJar,
      body: { identityCommitment: '0xabc1', reasonCode: 10, evidenceHash: '0x11' },
    });
    assert.equal(reject.status, 201, reject.json?.error);

    const blocked = await vote(election.id, { identityCommitment: '0xabc1', nullifier: '1' });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.json.code, 'EXTERNAL_PARTY_REJECTED');
    assert.equal(blocked.json.reasonCode, 10);
    assert.equal(blocked.json.reasonName, 'INELIGIBLE_STATUS');

    const cleared = await api('POST', `/api/elections/${election.id}/parties/${partyId}/clear`, {
      jar: felonyJar,
      body: { identityCommitment: '0xabc1' },
    });
    assert.equal(cleared.status, 200, cleared.json?.error);
    const ok = await vote(election.id, { identityCommitment: '0xabc1', nullifier: '1' });
    assert.equal(ok.status, 201, ok.json?.error);
    assert.equal(ok.json.vote.identityCommitment, undefined);
  });

  test('HTTP death-records oracle can reject at the unifying L2/Node gate', async () => {
    const election = await createElection('Vital records', clerkJar);
    await api('POST', `/api/elections/${election.id}/staff`, {
      jar: adminJar,
      body: { handle: 'poll-staff' },
    });
    const party = await api('POST', `/api/elections/${election.id}/parties`, {
      jar: staffJar,
      body: {
        name: 'State vital records',
        mode: 'veto',
        handle: 'felony-oracle',
        endpointUrl: oracleUrl,
      },
    });
    assert.equal(party.status, 201, party.json?.error);

    await api('POST', `/api/elections/${election.id}/register`, {
      jar: clerkJar,
      body: { identityCommitment: '0xdead' },
    });
    await api('POST', `/api/elections/${election.id}/register`, {
      jar: clerkJar,
      body: { identityCommitment: '0xbeef' },
    });
    await api('POST', `/api/elections/${election.id}/freeze`, { jar: clerkJar });

    const dead = await vote(election.id, { identityCommitment: '0xdead', nullifier: '21' });
    assert.equal(dead.status, 403);
    assert.equal(dead.json.code, 'EXTERNAL_PARTY_REJECTED');
    assert.equal(dead.json.reasonCode, 5);

    const living = await vote(election.id, { identityCommitment: '0xbeef', nullifier: '22' });
    assert.equal(living.status, 201, living.json?.error);
  });

  test('must_attest age party requires a clearance before the ballot is submitted', async () => {
    const election = await createElection('Age attest', clerkJar);
    await api('POST', `/api/elections/${election.id}/staff`, {
      jar: adminJar,
      body: { handle: 'poll-staff' },
    });
    const party = await api('POST', `/api/elections/${election.id}/parties`, {
      jar: staffJar,
      body: { name: 'Age verification', mode: 'must_attest', handle: 'felony-oracle' },
    });
    const partyId = party.json.party.id;
    await api('POST', `/api/elections/${election.id}/register`, {
      jar: clerkJar,
      body: { identityCommitment: '0x333' },
    });
    await api('POST', `/api/elections/${election.id}/freeze`, { jar: clerkJar });

    const missing = await vote(election.id, { identityCommitment: '0x333', nullifier: '31' });
    assert.equal(missing.status, 403);
    assert.equal(missing.json.code, 'EXTERNAL_ATTESTATION_REQUIRED');

    const attest = await api('POST', `/api/elections/${election.id}/parties/${partyId}/attest`, {
      jar: felonyJar,
      body: { identityCommitment: '0x333' },
    });
    assert.equal(attest.status, 201, attest.json?.error);
    const ok = await vote(election.id, { identityCommitment: '0x333', nullifier: '31' });
    assert.equal(ok.status, 201, ok.json?.error);
  });

  test('paused party no longer gates votes', async () => {
    const election = await createElection('Paused oracle', clerkJar);
    await api('POST', `/api/elections/${election.id}/staff`, {
      jar: adminJar,
      body: { handle: 'poll-staff' },
    });
    const party = await api('POST', `/api/elections/${election.id}/parties`, {
      jar: staffJar,
      body: { name: 'Felony', mode: 'veto', handle: 'felony-oracle' },
    });
    const partyId = party.json.party.id;
    await api('POST', `/api/elections/${election.id}/register`, {
      jar: clerkJar,
      body: { identityCommitment: '0x444' },
    });
    await api('POST', `/api/elections/${election.id}/freeze`, { jar: clerkJar });
    await api('POST', `/api/elections/${election.id}/parties/${partyId}/reject`, {
      jar: felonyJar,
      body: { identityCommitment: '0x444', reasonCode: 10 },
    });
    await api('PATCH', `/api/elections/${election.id}/parties/${partyId}`, {
      jar: staffJar,
      body: { status: 'paused' },
    });
    const ok = await vote(election.id, { identityCommitment: '0x444', nullifier: '41' });
    assert.equal(ok.status, 201, ok.json?.error);
  });
});

// NOT FOR PROFIT — civic public good, not a commercial product.
// Per-jurisdiction officer grants: allow in-scope, deny cross-jurisdiction.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { createApp } from '../src/server.mjs';

let tmp;
let server;
let base;
const adminJar = {};
const northClerkJar = {};
const southClerkJar = {};
const northRegistrarJar = {};
const southRegistrarJar = {};
const northDqJar = {};
const southDqJar = {};
const northTallyJar = {};
const southTallyJar = {};
const globalClerkJar = {};
const voterJar = {};
const voter2Jar = {};

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

function electionBody(jurisdictionId, extra = {}) {
  return {
    title: extra.title || `Election ${jurisdictionId}`,
    startTime: extra.startTime ?? nowSec() + 60,
    cutoffTime: extra.cutoffTime ?? nowSec() + 3600,
    treeDepth: 16,
    jurisdictionId,
    questions: [{ type: 'YES_NO', prompt: '?' }],
    ...extra,
  };
}

async function grant(jurisdictionId, handle, role) {
  const { status, json } = await api('POST', `/api/jurisdictions/${jurisdictionId}/roles`, {
    jar: adminJar,
    body: { handle, role },
  });
  assert.equal(status, 200, json?.error);
  return json;
}

describe('per-jurisdiction officer roles', () => {
  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'republic-roles-'));
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

    const admin = await api('POST', '/api/auth/dev-login', {
      body: { handle: 'admin' },
      jar: adminJar,
    });
    assert.equal(admin.status, 200);

    for (const [id, name] of [
      ['north', 'North'],
      ['south', 'South'],
    ]) {
      const createdJ = await api('POST', '/api/jurisdictions', {
        jar: adminJar,
        body: { id, name },
      });
      assert.equal(createdJ.status, 201, createdJ.json?.error);
    }

    const logins = [
      [northClerkJar, 'north-clerk'],
      [southClerkJar, 'south-clerk'],
      [northRegistrarJar, 'north-registrar'],
      [southRegistrarJar, 'south-registrar'],
      [northDqJar, 'north-dq'],
      [southDqJar, 'south-dq'],
      [northTallyJar, 'north-tally'],
      [southTallyJar, 'south-tally'],
      [globalClerkJar, 'global-clerk', 'clerk'],
      [voterJar, 'voter-a'],
      [voter2Jar, 'voter-b'],
    ];
    for (const [jar, handle, role] of logins) {
      const { status, json } = await api('POST', '/api/auth/dev-login', {
        body: { handle, role: role || 'voter' },
        jar,
      });
      assert.equal(status, 200, json?.error);
    }

    await grant('north', 'north-clerk', 'clerk');
    await grant('south', 'south-clerk', 'clerk');
    await grant('north', 'north-registrar', 'registrar');
    await grant('south', 'south-registrar', 'registrar');
    await grant('north', 'north-dq', 'disqualification_officer');
    await grant('south', 'south-dq', 'disqualification_officer');
    await grant('north', 'north-tally', 'tally_operator');
    await grant('south', 'south-tally', 'tally_operator');
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await rm(tmp, { recursive: true, force: true });
  });

  test('grant is idempotent and does not overwrite the global user role', async () => {
    const again = await api('POST', '/api/jurisdictions/north/roles', {
      jar: adminJar,
      body: { handle: 'north-clerk', role: 'clerk' },
    });
    assert.equal(again.status, 200, again.json?.error);
    assert.equal(again.json.user.role, 'voter');
    const listed = await api('GET', '/api/jurisdictions/north/roles', { jar: adminJar });
    assert.equal(listed.status, 200);
    const clerks = listed.json.officers.filter((o) => o.handle === 'north-clerk' && o.role === 'clerk');
    assert.equal(clerks.length, 1);
  });

  test('anonymous GET /api/jurisdictions omits the officer roster', async () => {
    const anon = await api('GET', '/api/jurisdictions');
    assert.equal(anon.status, 200);
    const north = anon.json.jurisdictions.find((j) => j.id === 'north');
    assert.ok(north);
    assert.equal(north.name, 'North');
    assert.equal(north.officers, undefined);

    const rolesAnon = await api('GET', '/api/jurisdictions/north/roles');
    assert.equal(rolesAnon.status, 401);

    const host = await api('GET', '/api/jurisdictions', { jar: adminJar });
    const northHost = host.json.jurisdictions.find((j) => j.id === 'north');
    assert.ok(Array.isArray(northHost.officers));
    assert.ok(northHost.officers.some((o) => o.handle === 'north-clerk' && o.role === 'clerk'));
  });

  test('GET /api/me lists jurisdictionRoles for a scoped clerk', async () => {
    const me = await api('GET', '/api/me', { jar: northClerkJar });
    assert.equal(me.status, 200);
    assert.equal(me.json.user.role, 'voter');
    assert.ok(me.json.jurisdictionRoles.some((g) => g.jurisdictionId === 'north' && g.role === 'clerk'));
    assert.ok(me.json.roles.includes('CLERK'));
    assert.ok(!me.json.jurisdictionRoles.some((g) => g.jurisdictionId === 'south'));
  });

  test('platform_admin can create an election in any jurisdiction', async () => {
    const created = await api('POST', '/api/elections', {
      jar: adminJar,
      body: electionBody('south', { title: 'Admin south' }),
    });
    assert.equal(created.status, 201, created.json?.error);
  });

  test('clerk of north can create in north and is denied in south', async () => {
    const ok = await api('POST', '/api/elections', {
      jar: northClerkJar,
      body: electionBody('north', { title: 'North general' }),
    });
    assert.equal(ok.status, 201, ok.json?.error);
    assert.equal(ok.json.election.jurisdictionId, 'north');

    const denied = await api('POST', '/api/elections', {
      jar: northClerkJar,
      body: electionBody('south', { title: 'North clerk in south' }),
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.json.jurisdictionId, 'south');
  });

  test('global clerk role without a jurisdiction grant cannot create', async () => {
    const denied = await api('POST', '/api/elections', {
      jar: globalClerkJar,
      body: electionBody('north', { title: 'Global clerk' }),
    });
    assert.equal(denied.status, 403);
  });

  test('voter cannot grant jurisdiction roles', async () => {
    const denied = await api('POST', '/api/jurisdictions/north/roles', {
      jar: voterJar,
      body: { handle: 'voter-a', role: 'clerk' },
    });
    assert.equal(denied.status, 403);
  });

  test('invalid officer role and missing identity are 400', async () => {
    const badRole = await api('POST', '/api/jurisdictions/north/roles', {
      jar: adminJar,
      body: { handle: 'north-clerk', role: 'platform_admin' },
    });
    assert.equal(badRole.status, 400);
    const missing = await api('POST', '/api/jurisdictions/north/roles', {
      jar: adminJar,
      body: { role: 'clerk' },
    });
    assert.equal(missing.status, 400);
  });

  let northElectionId;
  let southElectionId;

  test('PATCH ballot metadata is allowed only for the election jurisdiction clerk', async () => {
    const north = await api('POST', '/api/elections', {
      jar: northClerkJar,
      body: electionBody('north', { title: 'North metadata' }),
    });
    assert.equal(north.status, 201, north.json?.error);
    const id = north.json.election.id;

    const denied = await api('PATCH', `/api/elections/${id}`, {
      jar: southClerkJar,
      body: { title: 'Hijack' },
    });
    assert.equal(denied.status, 403);

    const allowed = await api('PATCH', `/api/elections/${id}`, {
      jar: northClerkJar,
      body: { title: 'North metadata revised' },
    });
    assert.equal(allowed.status, 200, allowed.json?.error);
    assert.equal(allowed.json.election.title, 'North metadata revised');
  });

  test('freeze is allowed only for the election jurisdiction clerk', async () => {
    const north = await api('POST', '/api/elections', {
      jar: northClerkJar,
      body: electionBody('north', { title: 'North freeze' }),
    });
    const south = await api('POST', '/api/elections', {
      jar: southClerkJar,
      body: electionBody('south', { title: 'South freeze' }),
    });
    assert.equal(north.status, 201, north.json?.error);
    assert.equal(south.status, 201, south.json?.error);
    northElectionId = north.json.election.id;
    southElectionId = south.json.election.id;

    const cross = await api('POST', `/api/elections/${southElectionId}/freeze`, { jar: northClerkJar });
    assert.equal(cross.status, 403);
    assert.equal(cross.json.jurisdictionId, 'south');

    const allowed = await api('POST', `/api/elections/${northElectionId}/freeze`, { jar: northClerkJar });
    assert.equal(allowed.status, 200, allowed.json?.error);
    assert.equal(allowed.json.election.rollFrozen, true);

    const adminFreeze = await api('POST', `/api/elections/${southElectionId}/freeze`, { jar: adminJar });
    assert.equal(adminFreeze.status, 200, adminFreeze.json?.error);
  });

  test('GET registrations is denied across jurisdictions', async () => {
    const denied = await api('GET', `/api/elections/${northElectionId}/registrations`, {
      jar: southClerkJar,
    });
    assert.equal(denied.status, 403);
    const allowed = await api('GET', `/api/elections/${northElectionId}/registrations`, {
      jar: northClerkJar,
    });
    assert.equal(allowed.status, 200);
  });

  test('registrar may register another user only in their jurisdiction', async () => {
    const voterMe = await api('GET', '/api/me', { jar: voterJar });
    const voterId = voterMe.json.user.id;
    const openNorth = await api('POST', '/api/elections', {
      jar: northClerkJar,
      body: electionBody('north', { title: 'North register' }),
    });
    const openSouth = await api('POST', '/api/elections', {
      jar: southClerkJar,
      body: electionBody('south', { title: 'South register' }),
    });
    assert.equal(openNorth.status, 201, openNorth.json?.error);
    assert.equal(openSouth.status, 201, openSouth.json?.error);
    const nId = openNorth.json.election.id;
    const sId = openSouth.json.election.id;

    const cross = await api('POST', `/api/elections/${nId}/register`, {
      jar: southRegistrarJar,
      body: { identityCommitment: '0x11', userId: voterId },
    });
    assert.equal(cross.status, 403);

    const allowed = await api('POST', `/api/elections/${nId}/register`, {
      jar: northRegistrarJar,
      body: { identityCommitment: '0x11', userId: voterId },
    });
    assert.equal(allowed.status, 201, allowed.json?.error);

    const self = await api('POST', `/api/elections/${sId}/register`, {
      jar: voter2Jar,
      body: { identityCommitment: '0x22' },
    });
    assert.equal(self.status, 202, self.json?.error);
    assert.equal(self.json.code, 'PENDING_REVIEW');
    const approved = await api(
      'POST',
      `/api/elections/${sId}/registration-requests/${self.json.request.id}/approve`,
      { jar: southRegistrarJar, body: {} },
    );
    assert.equal(approved.status, 200, approved.json?.error);
  });

  test('disqualify is allowed only for the election jurisdiction officer', async () => {
    const election = await api('POST', '/api/elections', {
      jar: northClerkJar,
      body: electionBody('north', { title: 'North dq' }),
    });
    assert.equal(election.status, 201, election.json?.error);
    const id = election.json.election.id;
    const pending = await api('POST', `/api/elections/${id}/register`, {
      jar: voterJar,
      body: { identityCommitment: '0x33' },
    });
    assert.equal(pending.status, 202, pending.json?.error);
    const enrolled = await api(
      'POST',
      `/api/elections/${id}/registration-requests/${pending.json.request.id}/approve`,
      { jar: northRegistrarJar, body: {} },
    );
    assert.equal(enrolled.status, 200, enrolled.json?.error);

    const denied = await api('POST', `/api/elections/${id}/disqualify`, {
      jar: southDqJar,
      body: { identityCommitment: '0x33', reasonCode: 1 },
    });
    assert.equal(denied.status, 403);

    const allowed = await api('POST', `/api/elections/${id}/disqualify`, {
      jar: northDqJar,
      body: { identityCommitment: '0x33', reasonCode: 1 },
    });
    assert.equal(allowed.status, 201, allowed.json?.error);
  });

  test('tally is allowed only for the election jurisdiction operator', async () => {
    const election = await api('POST', '/api/elections', {
      jar: northClerkJar,
      body: electionBody('north', {
        title: 'North tally',
        startTime: nowSec() - 120,
        cutoffTime: nowSec() - 1,
      }),
    });
    assert.equal(election.status, 201, election.json?.error);
    const id = election.json.election.id;

    const denied = await api('POST', `/api/elections/${id}/tally`, {
      jar: southTallyJar,
      body: { counts: [0, 0] },
    });
    assert.equal(denied.status, 403);

    const allowed = await api('POST', `/api/elections/${id}/tally`, {
      jar: northTallyJar,
      body: { counts: [0, 0] },
    });
    assert.equal(allowed.status, 200, allowed.json?.error);
    assert.equal(allowed.json.election.stateName, 'Tallied');

    const deniedCert = await api('POST', `/api/elections/${id}/certify-l1`, {
      jar: southTallyJar,
      body: {},
    });
    assert.equal(deniedCert.status, 403);

    const allowedCert = await api('POST', `/api/elections/${id}/certify-l1`, {
      jar: northTallyJar,
      body: {},
    });
    assert.equal(allowedCert.status, 200, allowedCert.json?.error);
  });

  test('platform_admin can tally in a jurisdiction with no local operator grant', async () => {
    const election = await api('POST', '/api/elections', {
      jar: adminJar,
      body: electionBody('south', {
        title: 'Admin tally',
        startTime: nowSec() - 120,
        cutoffTime: nowSec() - 1,
      }),
    });
    assert.equal(election.status, 201, election.json?.error);
    const ok = await api('POST', `/api/elections/${election.json.election.id}/tally`, {
      jar: adminJar,
      body: { counts: [0, 0] },
    });
    assert.equal(ok.status, 200, ok.json?.error);
  });

  test('GET /api/users includes jurisdictionRoles', async () => {
    const { status, json } = await api('GET', '/api/users', { jar: adminJar });
    assert.equal(status, 200);
    const clerk = json.users.find((u) => u.handle === 'north-clerk');
    assert.ok(clerk);
    assert.equal(clerk.role, 'voter');
    assert.ok(clerk.jurisdictionRoles.some((g) => g.jurisdictionId === 'north' && g.role === 'clerk'));
  });

  test('revoke removes the grant and subsequent create is denied', async () => {
    const revoked = await api('DELETE', '/api/jurisdictions/north/roles', {
      jar: adminJar,
      body: { handle: 'north-clerk', role: 'clerk' },
    });
    assert.equal(revoked.status, 200, revoked.json?.error);
    const denied = await api('POST', '/api/elections', {
      jar: northClerkJar,
      body: electionBody('north', { title: 'After revoke' }),
    });
    assert.equal(denied.status, 403);
    const missing = await api('DELETE', '/api/jurisdictions/north/roles', {
      jar: adminJar,
      body: { handle: 'north-clerk', role: 'clerk' },
    });
    assert.equal(missing.status, 404);
  });

  test('jurisdiction registrar can bind a person-key; a clerk of another jurisdiction cannot', async () => {
    const me = await api('GET', '/api/me', { jar: voter2Jar });
    const id = me.json.user.id;
    const denied = await api('POST', `/api/persons/${id}/person-key`, {
      jar: northClerkJar,
      body: { personKey: 'civil-file-voter-b' },
    });
    assert.equal(denied.status, 403);
    const allowed = await api('POST', `/api/persons/${id}/person-key`, {
      jar: southRegistrarJar,
      body: { personKey: 'civil-file-voter-b' },
    });
    assert.equal(allowed.status, 200, allowed.json?.error);
    assert.equal(allowed.json.user.personKeyBound, true);
  });
});

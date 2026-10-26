// NOT FOR PROFIT — civic public good, not a commercial product.
// Regression: adding a passkey to a claimed handle requires a session for
// that same account. Unauthenticated begin/finish must not attach a
// credential or issue a session cookie.

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
const ownerJar = {};
const otherJar = {};

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

function setCookieNames(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return list.map((c) => c.split('=')[0]);
}

async function api(method, url, { body, jar, headers } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(jar ? { cookie: cookieHeader(jar) } : {}),
      ...(headers || {}),
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

function registrationBody({ id, challenge }) {
  return {
    id,
    rawId: id,
    type: 'public-key',
    response: {
      clientDataJSON: Buffer.from(
        JSON.stringify({
          type: 'webauthn.create',
          challenge,
          origin: 'http://localhost',
        }),
      ).toString('base64url'),
      attestationObject: Buffer.from('00', 'hex').toString('base64url'),
      transports: ['internal'],
    },
  };
}

const passkeyHooks = {
  generateRegistrationOptions: async (opts) => ({
    challenge: `chal-${opts.userName}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    rp: { name: 'zk-voting', id: 'localhost' },
    user: { name: opts.userName, id: opts.userID },
    authenticatorSelection: { residentKey: 'required' },
    excludeCredentials: opts.excludeCredentials || [],
  }),
  verifyRegistrationResponse: async ({ response }) => ({
    verified: true,
    registrationInfo: {
      credential: {
        id: response.id,
        publicKey: Buffer.from(`pk-${response.id}`),
        counter: 0,
        transports: ['internal'],
      },
      credentialDeviceType: 'singleDevice',
      credentialBackedUp: false,
    },
  }),
};

describe('passkey register requires auth for claimed handles', () => {
  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'zk-passkey-auth-'));
    const created = await createApp({
      dataDir: tmp,
      allowDevLogin: true,
      adminHandle: 'admin',
      quiet: true,
      port: 0,
      disclosureIntervalSeconds: 0,
      requireEmailMfa: false,
      passkeyHooks,
    });
    app = created.app;
    store = created.store;
    server = await listen(app);
    base = `http://127.0.0.1:${server.address().port}`;

    // Claimed owner: one legitimate passkey already on the account.
    const owner = await store.ensureUser({ handle: 'owner', role: 'voter' });
    store.addCredential(owner.id, {
      id: 'owner-cred-0',
      publicKey: Buffer.from('owner-pk').toString('base64url'),
      counter: 0,
      transports: ['internal'],
      createdAt: new Date().toISOString(),
    });
    await store.persist();

    const login = await api('POST', '/api/auth/dev-login', {
      body: { handle: 'owner' },
      jar: ownerJar,
    });
    assert.equal(login.status, 200, login.json?.error);
    assert.ok(ownerJar['zk-voting.sid']);

    const other = await api('POST', '/api/auth/dev-login', {
      body: { handle: 'other', role: 'voter' },
      jar: otherJar,
    });
    assert.equal(other.status, 200, other.json?.error);
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await rm(tmp, { recursive: true, force: true });
  });

  test('unauthenticated begin against a claimed handle is 401; no challenge issued', async () => {
    const before = store.getUserByHandle('owner').credentials.map((c) => c.id);
    const begin = await api('POST', '/api/auth/passkey/register/begin', {
      body: { handle: 'owner', acceptedTerms: true },
    });
    assert.equal(begin.status, 401, begin.text);
    assert.equal(begin.json.code, 'AUTH_REQUIRED');
    assert.equal(begin.json.challenge, undefined);
    const after = store.getUserByHandle('owner').credentials.map((c) => c.id);
    assert.deepEqual(after, before);
  });

  test('unauthenticated finish cannot attach a credential or set a session', async () => {
    const before = store.getUserByHandle('owner');
    const beforeIds = new Set(before.credentials.map((c) => c.id));
    const attackJar = {};

    // Mint a challenge the way a pre-fix begin would have (direct service bypass
    // is out of scope); instead reuse a begin from the owner session, drop the
    // cookie, and try finish anonymously — finish must still refuse.
    const begin = await api('POST', '/api/auth/passkey/register/begin', {
      body: { handle: 'owner' },
      jar: ownerJar,
    });
    assert.equal(begin.status, 200, begin.text);

    const finish = await api('POST', '/api/auth/passkey/register/finish', {
      jar: attackJar,
      body: {
        handle: 'owner',
        ...registrationBody({ id: 'attacker-cred', challenge: begin.json.challenge }),
      },
    });
    assert.ok(finish.status === 401 || finish.status === 403, finish.text);
    assert.ok(
      finish.json?.code === 'AUTH_REQUIRED' || finish.json?.code === 'HANDLE_MISMATCH',
      finish.text,
    );
    assert.equal(attackJar['zk-voting.sid'], undefined);
    assert.ok(!setCookieNames(finish.res).includes('zk-voting.sid'));

    const after = store.getUserByHandle('owner');
    assert.equal(after.credentials.length, before.credentials.length);
    assert.ok(!after.credentials.some((c) => c.id === 'attacker-cred'));
    assert.deepEqual(
      after.credentials.map((c) => c.id).sort(),
      [...beforeIds].sort(),
    );
  });

  test('signed-in owner can still add another passkey', async () => {
    const beforeCount = store.getUserByHandle('owner').credentials.length;
    const begin = await api('POST', '/api/auth/passkey/register/begin', {
      body: { handle: 'owner' },
      jar: ownerJar,
    });
    assert.equal(begin.status, 200, begin.text);
    const finish = await api('POST', '/api/auth/passkey/register/finish', {
      jar: ownerJar,
      body: {
        handle: 'owner',
        ...registrationBody({ id: 'owner-cred-1', challenge: begin.json.challenge }),
      },
    });
    assert.equal(finish.status, 200, finish.text);
    assert.equal(store.getUserByHandle('owner').credentials.length, beforeCount + 1);
    assert.ok(
      store.getUserByHandle('owner').credentials.some((c) => c.id === 'owner-cred-1'),
    );
  });

  test('signed-in other user cannot register a passkey onto owner', async () => {
    const beforeCount = store.getUserByHandle('owner').credentials.length;
    const begin = await api('POST', '/api/auth/passkey/register/begin', {
      body: { handle: 'owner' },
      jar: otherJar,
    });
    assert.equal(begin.status, 403, begin.text);
    assert.equal(begin.json.code, 'HANDLE_MISMATCH');
    assert.equal(store.getUserByHandle('owner').credentials.length, beforeCount);
  });

  test('new-user registration without a session still works', async () => {
    const jar = {};
    const begin = await api('POST', '/api/auth/passkey/register/begin', {
      body: { handle: 'newbie', acceptedTerms: true },
    });
    assert.equal(begin.status, 200, begin.text);
    assert.ok(begin.json.challenge);
    const finish = await api('POST', '/api/auth/passkey/register/finish', {
      jar,
      body: {
        handle: 'newbie',
        acceptedTerms: true,
        ...registrationBody({ id: 'newbie-cred', challenge: begin.json.challenge }),
      },
    });
    assert.equal(finish.status, 200, finish.text);
    const created = store.getUserByHandle('newbie');
    assert.ok(created);
    assert.ok(created.credentials.some((c) => c.id === 'newbie-cred'));
    // First registration may establish a session when MFA is off.
    assert.ok(jar['zk-voting.sid'] || finish.json?.ok || finish.json?.verified);
  });

  test('unclaimed ADMIN_HANDLE seed can still be claimed without a session', async () => {
    const admin = store.getUserByHandle('admin');
    assert.ok(admin, 'seeded admin row');
    assert.equal(admin.credentials.length, 0, 'admin starts unclaimed');
    const jar = {};
    const begin = await api('POST', '/api/auth/passkey/register/begin', {
      body: { handle: 'admin', acceptedTerms: true },
    });
    assert.equal(begin.status, 200, begin.text);
    const finish = await api('POST', '/api/auth/passkey/register/finish', {
      jar,
      body: {
        handle: 'admin',
        acceptedTerms: true,
        ...registrationBody({ id: 'admin-first-cred', challenge: begin.json.challenge }),
      },
    });
    assert.equal(finish.status, 200, finish.text);
    assert.ok(store.getUserByHandle('admin').credentials.some((c) => c.id === 'admin-first-cred'));
  });

  test('original unauthenticated takeover path is closed end-to-end', async () => {
    const victim = await store.ensureUser({ handle: 'victim', role: 'voter' });
    store.addCredential(victim.id, {
      id: 'victim-cred-0',
      publicKey: Buffer.from('victim-pk').toString('base64url'),
      counter: 0,
      transports: ['internal'],
      createdAt: new Date().toISOString(),
    });
    await store.persist();
    const beforeCount = store.getUserByHandle('victim').credentials.length;
    const jar = {};
    const begin = await api('POST', '/api/auth/passkey/register/begin', {
      body: { handle: 'victim', acceptedTerms: true },
    });
    assert.equal(begin.status, 401);
    assert.equal(begin.json.code, 'AUTH_REQUIRED');
    // Even if an attacker forged a finish body without a real challenge:
    const finish = await api('POST', '/api/auth/passkey/register/finish', {
      jar,
      body: {
        handle: 'victim',
        ...registrationBody({ id: 'evil-cred', challenge: 'forged-challenge' }),
      },
    });
    assert.ok(finish.status >= 400, finish.text);
    assert.equal(jar['zk-voting.sid'], undefined);
    assert.equal(store.getUserByHandle('victim').credentials.length, beforeCount);
    assert.ok(!store.getUserByHandle('victim').credentials.some((c) => c.id === 'evil-cred'));
  });

});

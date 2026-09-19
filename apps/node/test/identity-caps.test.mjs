// NOT FOR PROFIT — civic public good, not a commercial product.
// Per-person caps: 5 passkeys, 5 emails, exactly one primary.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import {
  MAX_EMAILS_PER_PERSON,
  MAX_PASSKEYS_PER_PERSON,
  mfaDestinationEmail,
} from '../src/identity.mjs';
import { createApp } from '../src/server.mjs';

const DUMMY_PUBKEY = Buffer.from('not-a-real-cose-key').toString('base64url');

let tmp;
let app;
let store;
let mailer;
let server;
let base;
const jar = {};
const adminJar = {};

function applyCookies(res, cookieJar) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const c of list) {
    const pair = c.split(';')[0];
    const i = pair.indexOf('=');
    if (i === -1) continue;
    cookieJar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
}

function cookieHeader(cookieJar) {
  return Object.entries(cookieJar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

async function api(method, url, { body, jar: cookieJar } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(cookieJar ? { cookie: cookieHeader(cookieJar) } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (cookieJar) applyCookies(res, cookieJar);
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

function lastOtp() {
  const hit = mailer.lastOtp();
  assert.ok(hit?.code, 'expected a captured OTP');
  return hit;
}

function assertionBody({ id, challenge }) {
  const clientDataJSON = Buffer.from(
    JSON.stringify({
      type: 'webauthn.get',
      origin: 'http://127.0.0.1',
      challenge,
      crossOrigin: false,
    }),
    'utf8',
  ).toString('base64url');
  return {
    id,
    rawId: id,
    type: 'public-key',
    response: {
      clientDataJSON,
      authenticatorData: Buffer.from('00', 'hex').toString('base64url'),
      signature: Buffer.from('00', 'hex').toString('base64url'),
      userHandle: null,
    },
  };
}

function registrationBody({ id, challenge }) {
  const clientDataJSON = Buffer.from(
    JSON.stringify({
      type: 'webauthn.create',
      origin: 'http://127.0.0.1',
      challenge,
      crossOrigin: false,
    }),
    'utf8',
  ).toString('base64url');
  return {
    id,
    rawId: id,
    type: 'public-key',
    response: {
      clientDataJSON,
      attestationObject: Buffer.from('00', 'hex').toString('base64url'),
      transports: ['internal'],
    },
  };
}

async function addEmail(cookieJar, email) {
  const start = await api('POST', '/api/identity/email/start', {
    body: { email },
    jar: cookieJar,
  });
  assert.equal(start.status, 200, start.json?.error);
  const verify = await api('POST', '/api/auth/mfa/verify', {
    body: { code: lastOtp().code },
    jar: cookieJar,
  });
  assert.equal(verify.status, 200, verify.json?.error);
  return verify;
}

describe('mfa destination prefers primary except email-first and bind', () => {
  test('passkey MFA uses primary; email login and bind use the given address', () => {
    const user = {
      id: 'u1',
      handle: 'pat',
      email: 'primary@example.com',
      credentials: [],
      authMethods: [
        {
          id: 'e1',
          type: 'email',
          email: 'primary@example.com',
          primary: true,
        },
        {
          id: 'e2',
          type: 'email',
          email: 'second@example.com',
          primary: false,
        },
      ],
      ethAccounts: [],
    };
    assert.equal(
      mfaDestinationEmail({ user, factor: 'passkey' }),
      'primary@example.com',
    );
    assert.equal(
      mfaDestinationEmail({ user, factor: 'email', email: 'second@example.com' }),
      'second@example.com',
    );
    assert.equal(
      mfaDestinationEmail({
        user,
        factor: 'email',
        email: 'third@example.com',
        bindEmail: true,
      }),
      'third@example.com',
    );
  });
});

describe('passkey and email caps (primary email)', () => {
  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'republic-caps-'));
    const created = await createApp({
      dataDir: tmp,
      allowDevLogin: true,
      adminHandle: 'admin',
      quiet: true,
      port: 0,
      disclosureIntervalSeconds: 0,
      requireEmailMfa: true,
      passkeyHooks: {
        generateRegistrationOptions: async (opts) => ({
          challenge: `chal-${opts.userName}-${Date.now()}`,
          rp: { name: 'Republic', id: 'localhost' },
          user: { name: opts.userName },
          authenticatorSelection: { residentKey: 'required' },
          excludeCredentials: opts.excludeCredentials || [],
        }),
        verifyRegistrationResponse: async ({ response }) => ({
          verified: true,
          registrationInfo: {
            credential: {
              id: response.id,
              publicKey: Buffer.from('pk'),
              counter: 0,
              transports: ['internal'],
            },
            credentialDeviceType: 'singleDevice',
            credentialBackedUp: false,
          },
        }),
        verifyAuthenticationResponse: async () => ({
          verified: true,
          authenticationInfo: { newCounter: 1 },
        }),
      },
    });
    app = created.app;
    store = created.store;
    mailer = created.mailer;
    server = await listen(app);
    base = `http://127.0.0.1:${server.address().port}`;
    const login = await api('POST', '/api/auth/dev-login', {
      body: { handle: 'pat', role: 'voter' },
      jar,
    });
    assert.equal(login.status, 200, login.json?.error);
    const admin = await api('POST', '/api/auth/dev-login', {
      body: { handle: 'admin' },
      jar: adminJar,
    });
    assert.equal(admin.status, 200, admin.json?.error);
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await rm(tmp, { recursive: true, force: true });
  });

  test('store rejects a 6th passkey with PASSKEY_CAP', async () => {
    const user = store.getUserByHandle('pat');
    for (let i = 0; i < MAX_PASSKEYS_PER_PERSON; i += 1) {
      store.addCredential(user.id, {
        id: `cred-${i}`,
        publicKey: DUMMY_PUBKEY,
        counter: 0,
        transports: ['internal'],
        createdAt: new Date().toISOString(),
      });
    }
    await store.persist();
    assert.equal(user.credentials.length, 5);
    assert.throws(
      () =>
        store.addCredential(user.id, {
          id: 'cred-6',
          publicKey: DUMMY_PUBKEY,
          counter: 0,
        }),
      (err) => err.code === 'PASSKEY_CAP' || err.extra?.code === 'PASSKEY_CAP',
    );
  });

  test('list APIs return passkeys and the cap; register begin rejects the 6th', async () => {
    const listed = await api('GET', '/api/me/passkeys', { jar });
    assert.equal(listed.status, 200, listed.json?.error);
    assert.equal(listed.json.passkeyCount, 5);
    assert.equal(listed.json.caps.passkeys, 5);
    assert.equal(listed.json.passkeys.length, 5);

    const begin = await api('POST', '/api/auth/passkey/register/begin', {
      body: { handle: 'pat' },
      jar,
    });
    assert.equal(begin.status, 409);
    assert.equal(begin.json.code, 'PASSKEY_CAP');
    assert.match(begin.json.error, /at most 5 passkeys/i);
  });

  test('any of the person\'s passkeys can still sign in', async () => {
    const loginJar = {};
    const begin = await api('POST', '/api/auth/passkey/login/begin', {
      body: { handle: 'pat' },
    });
    assert.equal(begin.status, 200, begin.json?.error);
    const finish = await api('POST', '/api/auth/passkey/login/finish', {
      jar: loginJar,
      body: assertionBody({ id: 'cred-3', challenge: begin.json.challenge }),
    });
    assert.equal(finish.status, 200, finish.json?.error);
    assert.equal(finish.json.mfaRequired, true);
    assert.equal(finish.json.verified, false);
    assert.ok(loginJar['republic.mfa']);
  });

  test('first email is primary; list APIs return all emails and which is primary', async () => {
    const added = await addEmail(jar, 'one@example.com');
    assert.equal(added.json.identity.primaryEmail, 'one@example.com');
    assert.equal(added.json.identity.emails.length, 1);
    assert.equal(added.json.identity.emails[0].primary, true);

    const listed = await api('GET', '/api/me/emails', { jar });
    assert.equal(listed.status, 200);
    assert.equal(listed.json.primaryEmail, 'one@example.com');
    assert.equal(listed.json.emailCount, 1);
    assert.equal(listed.json.caps.emails, MAX_EMAILS_PER_PERSON);
  });

  test('adding emails until 5; 6th is rejected with EMAIL_CAP', async () => {
    for (let i = 2; i <= MAX_EMAILS_PER_PERSON; i += 1) {
      const added = await addEmail(jar, `n${i}@example.com`);
      assert.equal(added.json.identity.emailCount, i, added.json?.error);
    }
    const sixth = await api('POST', '/api/identity/email/start', {
      body: { email: 'sixth@example.com' },
      jar,
    });
    assert.equal(sixth.status, 409);
    assert.equal(sixth.json.code, 'EMAIL_CAP');
    assert.match(sixth.json.error, /at most 5 email/i);

    const me = await api('GET', '/api/me', { jar });
    assert.equal(me.json.identity.emailCount, 5);
    const primaries = me.json.identity.emails.filter((e) => e.primary);
    assert.equal(primaries.length, 1);
    assert.equal(primaries[0].email, 'one@example.com');
  });

  test('setting a new primary clears the old one', async () => {
    const me = await api('GET', '/api/me', { jar });
    const second = me.json.identity.emails.find((e) => e.email === 'n2@example.com');
    assert.ok(second);
    const switched = await api('POST', '/api/me/emails/primary', {
      jar,
      body: { id: second.id },
    });
    assert.equal(switched.status, 200, switched.json?.error);
    assert.equal(switched.json.identity.primaryEmail, 'n2@example.com');
    const primaries = switched.json.identity.emails.filter((e) => e.primary);
    assert.equal(primaries.length, 1);
    assert.equal(primaries[0].email, 'n2@example.com');
    const old = switched.json.identity.emails.find((e) => e.email === 'one@example.com');
    assert.equal(old.primary, false);
  });

  test('cannot remove the primary; can remove a non-primary', async () => {
    const me = await api('GET', '/api/me', { jar });
    const primary = me.json.identity.emails.find((e) => e.primary);
    const extra = me.json.identity.emails.find((e) => !e.primary);
    const blocked = await api('DELETE', `/api/me/emails/${primary.id}`, { jar });
    assert.equal(blocked.status, 400);
    assert.equal(blocked.json.code, 'PRIMARY_REQUIRED');

    const removed = await api('DELETE', `/api/me/emails/${extra.id}`, { jar });
    assert.equal(removed.status, 200, removed.json?.error);
    assert.equal(removed.json.identity.primaryEmail, 'n2@example.com');
    assert.equal(
      removed.json.identity.emails.some((e) => e.id === extra.id),
      false,
    );
  });

  test('email login with a non-primary address still works; MFA after passkey uses primary', async () => {
    const me = await api('GET', '/api/me', { jar });
    const secondary = me.json.identity.emails.find((e) => !e.primary);
    assert.ok(secondary, 'need a non-primary email to log in with');
    assert.equal(me.json.identity.primaryEmail, 'n2@example.com');

    const mailJar = {};
    const start = await api('POST', '/api/auth/email/start', {
      body: { email: secondary.email },
      jar: mailJar,
    });
    assert.equal(start.status, 200, start.json?.error);
    assert.equal(lastOtp().message.to, secondary.email);
    const verify = await api('POST', '/api/auth/mfa/verify', {
      body: { code: lastOtp().code },
      jar: mailJar,
    });
    assert.equal(verify.status, 200, verify.json?.error);
    assert.equal(verify.json.user.handle, 'pat');

    const pkJar = {};
    const begin = await api('POST', '/api/auth/passkey/login/begin', {
      body: { handle: 'pat' },
    });
    const finish = await api('POST', '/api/auth/passkey/login/finish', {
      jar: pkJar,
      body: assertionBody({ id: 'cred-0', challenge: begin.json.challenge }),
    });
    assert.equal(finish.status, 200, finish.json?.error);
    assert.equal(finish.json.mfaRequired, true);
    assert.equal(lastOtp().message.to, 'n2@example.com');
  });

  test('removing a passkey frees a slot; a new register is accepted', async () => {
    const listed = await api('GET', '/api/me/passkeys', { jar });
    const id = listed.json.passkeys[0].credentialId;
    const removed = await api('DELETE', `/api/me/passkeys/${encodeURIComponent(id)}`, { jar });
    assert.equal(removed.status, 200, removed.json?.error);
    assert.equal(removed.json.identity.passkeyCount, 4);

    const begin = await api('POST', '/api/auth/passkey/register/begin', {
      body: { handle: 'pat', acceptedTerms: true },
      jar,
    });
    assert.equal(begin.status, 200, begin.json?.error);
    const finish = await api('POST', '/api/auth/passkey/register/finish', {
      jar,
      body: registrationBody({ id: 'cred-new', challenge: begin.json.challenge }),
    });
    assert.equal(finish.status, 200, finish.json?.error);
    const again = await api('GET', '/api/me/passkeys', { jar });
    assert.equal(again.json.passkeyCount, 5);
    assert.ok(again.json.passkeys.some((p) => p.credentialId === 'cred-new'));
  });

  test('GET /api/config advertises the DealPunchList caps', async () => {
    const { status, json } = await api('GET', '/api/config');
    assert.equal(status, 200);
    assert.equal(json.identity.maxPasskeys, 5);
    assert.equal(json.identity.maxEmails, 5);
    assert.equal(json.identity.maxSmartCards, 5);
    assert.equal(json.identity.maxCivicIds, 5);
    assert.equal(json.identity.onePrimaryEmail, true);
    assert.equal(json.identity.registrationApproval, 'civil_officer');
  });
});

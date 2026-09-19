// NOT FOR PROFIT — civic public good, not a commercial product.
// Email username, SES OTP MFA, smart-card login, hashed license/passport.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { mnemonicToAccount } from 'viem/accounts';

import { civicIdHash } from '../src/identity.mjs';
import { createApp } from '../src/server.mjs';

const MNEMONIC = 'test test test test test test test test test test test junk';
const account0 = mnemonicToAccount(MNEMONIC, { addressIndex: 0 });

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

function lastCode() {
  const hit = mailer.lastOtp();
  assert.ok(hit?.code, 'expected a captured OTP');
  return hit.code;
}

describe('civic id hash', () => {
  test('is deterministic and ignores spaces/dashes/case', () => {
    const a = civicIdHash({
      kind: 'drivers_license',
      issuer: 'us-ca',
      documentNumber: 'D123-4567',
    });
    const b = civicIdHash({
      kind: 'drivers_license',
      issuer: 'US-CA',
      documentNumber: 'd123 4567',
    });
    assert.equal(a, b);
    assert.match(a, /^0x[0-9a-f]{64}$/);
  });
});

describe('email MFA, SES capture, civic id, smart-card login', () => {
  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'republic-mfa-'));
    const created = await createApp({
      dataDir: tmp,
      allowDevLogin: true,
      allowSmartCardMock: true,
      allowCivicIdMock: true,
      requireEmailMfa: true,
      adminHandle: 'admin',
      quiet: true,
      port: 0,
      disclosureIntervalSeconds: 0,
    });
    app = created.app;
    store = created.store;
    mailer = created.mailer;
    server = await listen(app);
    base = `http://127.0.0.1:${server.address().port}`;
    const login = await api('POST', '/api/auth/dev-login', {
      body: { handle: 'admin' },
      jar: adminJar,
    });
    assert.equal(login.status, 200, login.json?.error);
    assert.equal(login.json.mfaRequired, false);
    assert.ok(adminJar['republic.sid']);
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await rm(tmp, { recursive: true, force: true });
  });

  test('GET /api/config advertises email MFA via SES and civic id kinds', async () => {
    const { status, json } = await api('GET', '/api/config');
    assert.equal(status, 200);
    assert.equal(json.auth.requireEmailMfa, true);
    assert.equal(json.auth.emailMfaVendor, 'ses');
    assert.equal(json.auth.emailLogin, true);
    assert.equal(json.auth.smartCardLogin, true);
    assert.equal(json.auth.civicIdLogin, true);
    assert.deepEqual(json.identity.civicIdKinds, ['drivers_license', 'passport']);
  });

  test('dev-login still bypasses MFA when MFA is required', async () => {
    const local = {};
    const { status, json } = await api('POST', '/api/auth/dev-login', {
      body: { handle: 'dev-bypass' },
      jar: local,
    });
    assert.equal(status, 200, json?.error);
    assert.equal(json.mfaRequired, false);
    assert.ok(local['republic.sid']);
  });

  test('email register + OTP creates a session; unknown email login is 404', async () => {
    const unknown = await api('POST', '/api/auth/email/start', {
      body: { email: 'nobody@example.com' },
    });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json.code, 'UNKNOWN_CREDENTIAL');

    const start = await api('POST', '/api/identity/email/start', {
      body: { email: 'alice@example.com', handle: 'mail-alice' },
      jar,
    });
    assert.equal(start.status, 200, start.json?.error);
    assert.equal(start.json.mfaRequired, true);
    assert.equal(start.json.needsEmail, false);
    assert.ok(jar['republic.mfa']);
    assert.ok(!jar['republic.sid'] || jar['republic.sid'] === '');

    const bad = await api('POST', '/api/auth/mfa/verify', {
      body: { code: '000000' },
      jar,
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.code, 'OTP_INVALID');

    const verify = await api('POST', '/api/auth/mfa/verify', {
      body: { code: lastCode() },
      jar,
    });
    assert.equal(verify.status, 200, verify.json?.error);
    assert.equal(verify.json.mfaRequired, false);
    assert.equal(verify.json.user.handle, 'mail-alice');
    assert.ok(verify.json.identity.authMethods.some((m) => m.type === 'email'));
    assert.ok(jar['republic.sid']);

    const me = await api('GET', '/api/me', { jar });
    assert.equal(me.json.user.handle, 'mail-alice');
    assert.equal(me.json.identity.emailBound, true);

    const out = await api('POST', '/api/auth/logout', { jar });
    assert.equal(out.status, 200);

    const login = await api('POST', '/api/auth/email/start', {
      body: { email: 'alice@example.com' },
      jar,
    });
    assert.equal(login.status, 200, login.json?.error);
    assert.equal(login.json.mfaRequired, true);
    const again = await api('POST', '/api/auth/mfa/verify', {
      body: { code: lastCode() },
      jar,
    });
    assert.equal(again.status, 200, again.json?.error);
    assert.equal(again.json.user.handle, 'mail-alice');
  });

  test('web3 bind with MFA collects email then establishes a session', async () => {
    const walletJar = {};
    const challenge = await api('POST', '/api/identity/web3/challenge', {
      body: { address: account0.address },
    });
    const signature = await account0.signMessage({ message: challenge.json.message });
    const bound = await api('POST', '/api/identity/web3/verify', {
      body: { address: account0.address, signature, handle: 'wallet-mfa' },
      jar: walletJar,
    });
    assert.equal(bound.status, 200, bound.json?.error);
    assert.equal(bound.json.mfaRequired, true);
    assert.equal(bound.json.needsEmail, true);
    assert.ok(walletJar['republic.mfa']);

    const emailed = await api('POST', '/api/auth/mfa/email', {
      body: { email: 'wallet@example.com' },
      jar: walletJar,
    });
    assert.equal(emailed.status, 200, emailed.json?.error);
    assert.equal(emailed.json.needsEmail, false);

    const done = await api('POST', '/api/auth/mfa/verify', {
      body: { code: lastCode() },
      jar: walletJar,
    });
    assert.equal(done.status, 200, done.json?.error);
    assert.equal(done.json.user.handle, 'wallet-mfa');
    assert.ok(done.json.identity.authMethods.some((m) => m.type === 'web3'));
    assert.ok(done.json.identity.authMethods.some((m) => m.type === 'email'));

    await api('POST', '/api/auth/logout', { jar: walletJar });
    const loginChallenge = await api('POST', '/api/auth/web3/challenge', {
      body: { address: account0.address },
    });
    const loginSig = await account0.signMessage({ message: loginChallenge.json.message });
    const login = await api('POST', '/api/auth/web3/login', {
      body: { address: account0.address, signature: loginSig },
      jar: walletJar,
    });
    assert.equal(login.status, 200, login.json?.error);
    assert.equal(login.json.mfaRequired, true);
    const logged = await api('POST', '/api/auth/mfa/verify', {
      body: { code: lastCode() },
      jar: walletJar,
    });
    assert.equal(logged.status, 200, logged.json?.error);
    assert.equal(logged.json.user.handle, 'wallet-mfa');
  });

  test('smart-card bind and returning-user login both require email OTP', async () => {
    const cardJar = {};
    const fp = `0x${'11'.repeat(16)}`;
    const challenge = await api('POST', '/api/identity/smart-card/challenge', {
      body: { fingerprint: fp },
    });
    const bound = await api('POST', '/api/identity/smart-card/verify', {
      body: {
        nonce: challenge.json.nonce,
        fingerprint: fp,
        mock: true,
        handle: 'card-mfa',
        email: 'card@example.com',
      },
      jar: cardJar,
    });
    assert.equal(bound.status, 200, bound.json?.error);
    assert.equal(bound.json.mfaRequired, true);
    const verified = await api('POST', '/api/auth/mfa/verify', {
      body: { code: lastCode() },
      jar: cardJar,
    });
    assert.equal(verified.status, 200, verified.json?.error);
    assert.equal(verified.json.user.handle, 'card-mfa');

    await api('POST', '/api/auth/logout', { jar: cardJar });
    const loginChallenge = await api('POST', '/api/auth/smart-card/challenge', {
      body: { fingerprint: fp },
    });
    const login = await api('POST', '/api/auth/smart-card/login', {
      body: { nonce: loginChallenge.json.nonce, fingerprint: fp, mock: true },
      jar: cardJar,
    });
    assert.equal(login.status, 200, login.json?.error);
    assert.equal(login.json.mfaRequired, true);
    const done = await api('POST', '/api/auth/mfa/verify', {
      body: { code: lastCode() },
      jar: cardJar,
    });
    assert.equal(done.status, 200, done.json?.error);
    assert.equal(done.json.user.handle, 'card-mfa');
  });

  test('civic id hashes the document and never persists the number', async () => {
    const civicJar = {};
    const documentNumber = 'D123-4567-SECRET';
    const bound = await api('POST', '/api/identity/civic-id/verify', {
      body: {
        kind: 'drivers_license',
        issuer: 'US-CA',
        documentNumber,
        mock: true,
        handle: 'license-mfa',
        email: 'license@example.com',
      },
      jar: civicJar,
    });
    assert.equal(bound.status, 200, bound.json?.error);
    assert.equal(bound.json.mfaRequired, true);
    const method = bound.json.identity?.authMethods?.find((m) => m.type === 'civic_id');
    assert.equal(method, undefined); // identity not on MFA payload
    const done = await api('POST', '/api/auth/mfa/verify', {
      body: { code: lastCode() },
      jar: civicJar,
    });
    assert.equal(done.status, 200, done.json?.error);
    assert.equal(done.json.user.handle, 'license-mfa');
    const civic = done.json.identity.authMethods.find((m) => m.type === 'civic_id');
    assert.equal(civic.kind, 'drivers_license');
    assert.equal(civic.issuer, 'US-CA');
    assert.equal(civic.fingerprint, undefined);
    assert.equal(civic.documentNumber, undefined);

    const raw = await readFile(path.join(tmp, 'republic.json'), 'utf8');
    assert.doesNotMatch(raw, /D123-4567-SECRET/);
    assert.doesNotMatch(raw, /documentNumber/);
    const expected = civicIdHash({
      kind: 'drivers_license',
      issuer: 'US-CA',
      documentNumber,
    });
    assert.match(raw, new RegExp(expected.slice(2)));

    await api('POST', '/api/auth/logout', { jar: civicJar });
    const unknown = await api('POST', '/api/auth/civic-id/login', {
      body: { kind: 'drivers_license', issuer: 'US-CA', documentNumber: 'NOPE9999' },
    });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json.code, 'UNKNOWN_CREDENTIAL');

    const login = await api('POST', '/api/auth/civic-id/login', {
      body: { kind: 'drivers_license', issuer: 'us-ca', documentNumber: 'd123 4567 secret' },
      jar: civicJar,
    });
    assert.equal(login.status, 200, login.json?.error);
    assert.equal(login.json.mfaRequired, true);
    const logged = await api('POST', '/api/auth/mfa/verify', {
      body: { code: lastCode() },
      jar: civicJar,
    });
    assert.equal(logged.status, 200, logged.json?.error);
    assert.equal(logged.json.user.handle, 'license-mfa');
  });

  test('registrar can attest a passport without storing the number', async () => {
    const person = store.getUserByHandle('mail-alice');
    assert.ok(person);
    const documentNumber = 'X88888888';
    const added = await api('POST', `/api/persons/${person.id}/methods`, {
      jar: adminJar,
      body: {
        type: 'civic_id',
        kind: 'passport',
        issuer: 'US',
        documentNumber,
        label: 'US passport',
      },
    });
    assert.equal(added.status, 201, added.json?.error);
    const civic = added.json.identity.authMethods.find((m) => m.kind === 'passport');
    assert.equal(civic.issuer, 'US');
    const raw = await readFile(path.join(tmp, 'republic.json'), 'utf8');
    assert.doesNotMatch(raw, /X88888888/);
  });
});

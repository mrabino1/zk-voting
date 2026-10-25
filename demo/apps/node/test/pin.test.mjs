// NOT FOR PROFIT — civic public good, not a commercial product.
// Vote PIN: hashed on the person, scrambled phone keypad at the ballot, MFA reset.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import {
  STANDARD_PAD,
  assertPinStrength,
  hashPin,
  keypadLayoutFor,
  normalizePin,
  verifyPinHash,
} from '../src/pin.mjs';
import { createApp } from '../src/server.mjs';

let tmp;
let app;
let store;
let mailer;
let pin;
let server;
let base;
const adminJar = {};
const voterJar = {};
const mailJar = {};

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

function lastCode() {
  const hit = mailer.lastOtp();
  assert.ok(hit?.code, 'expected a captured OTP');
  return hit.code;
}

describe('vote PIN helpers', () => {
  test('rejects short, repeated, and sequential PINs', () => {
    assert.throws(() => normalizePin('12'), { status: 400 });
    assert.throws(() => assertPinStrength('1111'), (err) => err.code === 'PIN_WEAK' || err.extra?.code === 'PIN_WEAK');
    assert.throws(() => assertPinStrength('1234'), (err) => err.extra?.code === 'PIN_WEAK');
    assert.throws(() => assertPinStrength('9876'), (err) => err.extra?.code === 'PIN_WEAK');
    assert.doesNotThrow(() => assertPinStrength('2580'));
    assert.doesNotThrow(() => assertPinStrength('1904'));
  });

  test('hashes with scrypt and never compares equal to plaintext', async () => {
    const hash = await hashPin('2580');
    assert.match(hash, /^scrypt\$/);
    assert.equal(hash.includes('2580'), false);
    assert.equal(await verifyPinHash('2580', hash), true);
    assert.equal(await verifyPinHash('2581', hash), false);
  });

  test('scrambles 3×3+0 per person and nonce; setup stays standard', () => {
    assert.deepEqual(keypadLayoutFor('p1', 'n1', { scramble: false }), [...STANDARD_PAD]);
    const a = keypadLayoutFor('person-a', 'nonce-1', { scramble: true });
    const aAgain = keypadLayoutFor('person-a', 'nonce-1', { scramble: true });
    const b = keypadLayoutFor('person-b', 'nonce-1', { scramble: true });
    const a2 = keypadLayoutFor('person-a', 'nonce-2', { scramble: true });
    assert.deepEqual(a, aAgain);
    assert.notDeepEqual(a, b);
    assert.notDeepEqual(a, a2);
    assert.deepEqual([...a].sort(), [...STANDARD_PAD].sort());
    assert.equal(a.length, 10);
  });
});

describe('vote PIN HTTP', () => {
  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'republic-pin-'));
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
    mailer = created.mailer;
    pin = created.pin;
    server = await listen(app);
    base = `http://127.0.0.1:${server.address().port}`;
    const admin = await api('POST', '/api/auth/dev-login', {
      body: { handle: 'admin', role: 'platform_admin' },
      jar: adminJar,
    });
    assert.equal(admin.status, 200, admin.json?.error);
    const voter = await api('POST', '/api/auth/dev-login', {
      body: { handle: 'pin-voter', role: 'voter' },
      jar: voterJar,
    });
    assert.equal(voter.status, 200, voter.json?.error);
    assert.equal(voter.json.identity.pinBound, false);
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await rm(tmp, { recursive: true, force: true });
  });

  test('GET /api/config advertises the scrambled vote PIN', async () => {
    const { status, json } = await api('GET', '/api/config');
    assert.equal(status, 200);
    assert.equal(json.identity.votePin.required, true);
    assert.equal(json.identity.votePin.minLength, 4);
    assert.equal(json.identity.votePin.maxLength, 8);
    assert.equal(json.identity.votePin.keypad, 'phone-3x3-zero');
    assert.equal(json.identity.votePin.scrambleOnVote, true);
    assert.equal(json.identity.votePin.keyboardEntry, false);
  });

  test('setup keypad is standard; vote keypad is scrambled and person-specific', async () => {
    const setup = await api('POST', '/api/me/pin/keypad', {
      jar: voterJar,
      body: { purpose: 'setup' },
    });
    assert.equal(setup.status, 200, setup.json?.error);
    assert.equal(setup.json.scramble, false);
    assert.deepEqual(setup.json.layout, [...STANDARD_PAD]);
    assert.equal(setup.json.keyboardEntry, false);

    const vote = await api('POST', '/api/me/pin/keypad', {
      jar: voterJar,
      body: { purpose: 'vote' },
    });
    assert.equal(vote.status, 200, vote.json?.error);
    assert.equal(vote.json.scramble, true);
    assert.notDeepEqual(vote.json.layout, [...STANDARD_PAD]);
    assert.deepEqual([...vote.json.layout].sort(), [...STANDARD_PAD].sort());

    const otherJar = {};
    await api('POST', '/api/auth/dev-login', {
      body: { handle: 'pin-other', role: 'voter' },
      jar: otherJar,
    });
    const other = await api('POST', '/api/me/pin/keypad', {
      jar: otherJar,
      body: { purpose: 'vote' },
    });
    assert.notDeepEqual(vote.json.layout, other.json.layout);
  });

  test('person sets, changes, and confirms a PIN; hash is never public', async () => {
    const weak = await api('POST', '/api/me/pin', { jar: voterJar, body: { pin: '1111' } });
    assert.equal(weak.status, 400);
    assert.equal(weak.json.code, 'PIN_WEAK');

    const set = await api('POST', '/api/me/pin', {
      jar: voterJar,
      body: { pin: '2580', confirmPin: '2580' },
    });
    assert.equal(set.status, 200, set.json?.error);
    assert.equal(set.json.identity.pinBound, true);
    assert.equal(set.json.user.pinBound, true);
    assert.equal(set.json.identity.pinHash, undefined);
    assert.ok(!JSON.stringify(set.json).includes('2580'));

    const stored = store.getUser(set.json.user.id);
    assert.ok(stored.pinHash);
    assert.equal(stored.pinHash.includes('2580'), false);

    const missing = await api('POST', '/api/me/pin', {
      jar: voterJar,
      body: { pin: '1904', confirmPin: '1904' },
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.json.code, 'CURRENT_PIN_REQUIRED');

    const wrong = await api('POST', '/api/me/pin', {
      jar: voterJar,
      body: { pin: '1904', confirmPin: '1904', currentPin: '0000' },
    });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.json.code, 'PIN_INVALID');

    const changed = await api('POST', '/api/me/pin', {
      jar: voterJar,
      body: { pin: '1904', confirmPin: '1904', currentPin: '2580' },
    });
    assert.equal(changed.status, 200, changed.json?.error);
    assert.equal(changed.json.identity.pinBound, true);
  });

  test('session vote requires a one-use pinToken; anonymous vote still works', async () => {
    const sessionJar = {};
    await api('POST', '/api/auth/dev-login', {
      body: { handle: 'pin-session-voter', role: 'voter' },
      jar: sessionJar,
    });
    const set = await api('POST', '/api/me/pin', {
      jar: sessionJar,
      body: { pin: '1904', confirmPin: '1904' },
    });
    assert.equal(set.status, 200, set.json?.error);

    const created = await api('POST', '/api/elections', {
      jar: adminJar,
      body: {
        title: 'PIN poll',
        startTime: nowSec() - 10,
        cutoffTime: nowSec() + 3600,
        treeDepth: 16,
        questions: [{ type: 'YES_NO', prompt: 'Pin?' }],
      },
    });
    assert.equal(created.status, 201, created.json?.error);
    const id = created.json.election.id;
    const reg = await api('POST', `/api/elections/${id}/register`, {
      jar: adminJar,
      body: { identityCommitment: '0xaaa1' },
    });
    assert.equal(reg.status, 201, reg.json?.error);
    const freeze = await api('POST', `/api/elections/${id}/freeze`, { jar: adminJar });
    assert.equal(freeze.status, 200, freeze.json?.error);

    const anon = await api('POST', `/api/elections/${id}/vote`, {
      body: {
        proof: { accept: true },
        publicInputs: { nullifier: '0xb01', electionId: id },
        encryptedBallot: '0xaa',
        identityCommitment: '0xaaa1',
      },
    });
    assert.equal(anon.status, 201, anon.json?.error);

    const noToken = await api('POST', `/api/elections/${id}/vote`, {
      jar: sessionJar,
      body: {
        proof: { accept: true },
        publicInputs: { nullifier: '0xb02', electionId: id },
        encryptedBallot: '0xbb',
        identityCommitment: '0xaaa1',
      },
    });
    assert.equal(noToken.status, 403);
    assert.equal(noToken.json.code, 'PIN_TOKEN_REQUIRED');

    const verified = await api('POST', '/api/me/pin/verify', {
      jar: sessionJar,
      body: { pin: '1904', purpose: 'vote' },
    });
    assert.equal(verified.status, 200, verified.json?.error);
    assert.ok(verified.json.pinToken);

    const withToken = await api('POST', `/api/elections/${id}/vote`, {
      jar: sessionJar,
      body: {
        proof: { accept: true },
        publicInputs: { nullifier: '0xb03', electionId: id },
        encryptedBallot: '0xcc',
        identityCommitment: '0xaaa1',
        pinToken: verified.json.pinToken,
      },
    });
    assert.equal(withToken.status, 201, withToken.json?.error);

    const reused = await api('POST', `/api/elections/${id}/vote`, {
      jar: sessionJar,
      body: {
        proof: { accept: true },
        publicInputs: { nullifier: '0xb04', electionId: id },
        encryptedBallot: '0xdd',
        identityCommitment: '0xaaa1',
        pinToken: verified.json.pinToken,
      },
    });
    assert.equal(reused.status, 403);
    assert.equal(reused.json.code, 'PIN_TOKEN_INVALID');
  });

  test('forgot PIN via email MFA grants a reset, then a new PIN without the old one', async () => {
    const start = await api('POST', '/api/identity/email/start', {
      body: { email: 'pin-alice@example.com', handle: 'pin-alice', acceptedTerms: true },
      jar: mailJar,
    });
    assert.equal(start.status, 200, start.json?.error);
    const verify = await api('POST', '/api/auth/mfa/verify', {
      body: { code: lastCode() },
      jar: mailJar,
    });
    assert.equal(verify.status, 200, verify.json?.error);

    const set = await api('POST', '/api/me/pin', {
      jar: mailJar,
      body: { pin: '5826', confirmPin: '5826' },
    });
    assert.equal(set.status, 200, set.json?.error);

    await api('POST', '/api/auth/logout', { jar: mailJar });

    const forgot = await api('POST', '/api/pin/forgot', {
      body: { email: 'pin-alice@example.com' },
      jar: mailJar,
    });
    assert.equal(forgot.status, 200, forgot.json?.error);
    assert.equal(forgot.json.mfaRequired, true);
    assert.equal(forgot.json.pinReset, true);
    assert.match(mailer.lastOtp().message.subject, /PIN reset/i);

    const otp = await api('POST', '/api/auth/mfa/verify', {
      body: { code: lastCode() },
      jar: mailJar,
    });
    assert.equal(otp.status, 200, otp.json?.error);
    assert.equal(otp.json.pinResetGranted, true);
    assert.equal(otp.json.identity.pinResetGranted, true);

    const next = await api('POST', '/api/me/pin', {
      jar: mailJar,
      body: { pin: '1397', confirmPin: '1397' },
    });
    assert.equal(next.status, 200, next.json?.error);
    assert.equal(next.json.identity.pinBound, true);
    assert.equal(next.json.identity.pinResetGranted, false);

    const oldPin = await api('POST', '/api/me/pin/verify', {
      jar: mailJar,
      body: { pin: '5826', purpose: 'vote' },
    });
    assert.equal(oldPin.status, 403);
    const newPin = await api('POST', '/api/me/pin/verify', {
      jar: mailJar,
      body: { pin: '1397', purpose: 'vote' },
    });
    assert.equal(newPin.status, 200, newPin.json?.error);
    assert.ok(newPin.json.pinToken);
    assert.ok(pin.tokens.has(newPin.json.pinToken));
  });

  test('unknown email forgot PIN is UNKNOWN_CREDENTIAL', async () => {
    const miss = await api('POST', '/api/pin/forgot', { body: { email: 'nobody@example.com' } });
    assert.equal(miss.status, 404);
    assert.equal(miss.json.code, 'UNKNOWN_CREDENTIAL');
  });

  test('signed-in person without a PIN is PIN_REQUIRED on vote', async () => {
    const fresh = {};
    await api('POST', '/api/auth/dev-login', {
      body: { handle: 'no-pin-yet', role: 'voter' },
      jar: fresh,
    });
    const created = await api('POST', '/api/elections', {
      jar: adminJar,
      body: {
        title: 'Needs PIN',
        startTime: nowSec() - 10,
        cutoffTime: nowSec() + 3600,
        treeDepth: 16,
        questions: [{ type: 'YES_NO', prompt: '?' }],
      },
    });
    const id = created.json.election.id;
    await api('POST', `/api/elections/${id}/register`, {
      jar: adminJar,
      body: { identityCommitment: '0xaaa2' },
    });
    await api('POST', `/api/elections/${id}/freeze`, { jar: adminJar });
    const voted = await api('POST', `/api/elections/${id}/vote`, {
      jar: fresh,
      body: {
        proof: { accept: true },
        publicInputs: { nullifier: '0xb05', electionId: id },
        encryptedBallot: '0xee',
        identityCommitment: '0xaaa2',
      },
    });
    assert.equal(voted.status, 403);
    assert.equal(voted.json.code, 'PIN_REQUIRED');
  });
});

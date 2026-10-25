// NOT FOR PROFIT — civic public good, not a commercial product.
// Passkey login and Ethereum wallet login (returning users). WebAuthn crypto
// is mocked the same way a browser assertion would be swapped in tests.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { mnemonicToAccount } from 'viem/accounts';

import { createApp } from '../src/server.mjs';

const MNEMONIC = 'test test test test test test test test test test test junk';
const account0 = mnemonicToAccount(MNEMONIC, { addressIndex: 0 });
const account1 = mnemonicToAccount(MNEMONIC, { addressIndex: 1 });
const unbound = mnemonicToAccount(MNEMONIC, { addressIndex: 9 });

const CRED_ID = 'test-resident-cred';
const DUMMY_PUBKEY = Buffer.from('not-a-real-cose-key').toString('base64url');

let tmp;
let app;
let store;
let server;
let base;
let verifyAuthImpl;

const passkeyJar = {};
const walletJar = {};
const clerkJar = {};

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

async function seedPasskeyUser() {
  const user = store.createUser({ handle: 'passkey-voter', role: 'voter' });
  store.addCredential(user.id, {
    id: CRED_ID,
    publicKey: DUMMY_PUBKEY,
    counter: 0,
    transports: ['internal'],
  });
  await store.persist();
  return user;
}

describe('passkey and Ethereum wallet login (returning users)', () => {
  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'republic-auth-login-'));
    verifyAuthImpl = async () => ({
      verified: true,
      authenticationInfo: { newCounter: 1 },
    });
    const created = await createApp({
      dataDir: tmp,
      allowDevLogin: true,
      adminHandle: 'admin',
      quiet: true,
      port: 0,
      disclosureIntervalSeconds: 0,
      passkeyHooks: {
        verifyAuthenticationResponse: (...args) => verifyAuthImpl(...args),
      },
    });
    app = created.app;
    store = created.store;
    server = await listen(app);
    base = `http://127.0.0.1:${server.address().port}`;
    await seedPasskeyUser();
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await rm(tmp, { recursive: true, force: true });
  });

  test('GET /api/config advertises passkey and web3 login; dev login is gated', async () => {
    const { status, json } = await api('GET', '/api/config');
    assert.equal(status, 200);
    assert.equal(json.auth.passkeyLogin, true);
    assert.equal(json.auth.web3Login, true);
    assert.equal(json.auth.emailLogin, true);
    assert.equal(json.auth.smartCardLogin, true);
    assert.equal(json.auth.civicIdLogin, true);
    assert.equal(json.auth.requireEmailMfa, false);
    assert.equal(json.auth.emailMfaVendor, 'ses');
    assert.equal(json.auth.allowDevLogin, true);
  });

  test('passkey login begin is username-less (discoverable / resident key)', async () => {
    const { status, json } = await api('POST', '/api/auth/passkey/login/begin', { body: {} });
    assert.equal(status, 200, json?.error);
    assert.ok(json.challenge);
    assert.equal(json.rpName, 'Republic');
    const listed = json.allowCredentials || json.publicKey?.allowCredentials;
    assert.ok(!listed || listed.length === 0);
  });

  test('passkey login begin with unknown handle is 404', async () => {
    const { status, json } = await api('POST', '/api/auth/passkey/login/begin', {
      body: { handle: 'no-such-person' },
    });
    assert.equal(status, 404);
    assert.equal(json.error, 'unknown handle');
  });

  test('passkey login happy path establishes the same session cookie and role', async () => {
    verifyAuthImpl = async () => ({
      verified: true,
      authenticationInfo: { newCounter: 2 },
    });
    const begin = await api('POST', '/api/auth/passkey/login/begin', { body: {} });
    assert.equal(begin.status, 200, begin.json?.error);
    const finish = await api('POST', '/api/auth/passkey/login/finish', {
      jar: passkeyJar,
      body: assertionBody({ id: CRED_ID, challenge: begin.json.challenge }),
    });
    assert.equal(finish.status, 200, finish.json?.error);
    assert.equal(finish.json.verified, true);
    assert.equal(finish.json.user.handle, 'passkey-voter');
    assert.equal(finish.json.user.role, 'voter');
    assert.ok(passkeyJar['republic.sid']);
    assert.ok(finish.json.identity.authMethods.some((m) => m.type === 'passkey'));

    const me = await api('GET', '/api/me', { jar: passkeyJar });
    assert.equal(me.status, 200);
    assert.equal(me.json.user.handle, 'passkey-voter');
    assert.equal(me.json.user.role, 'voter');
  });

  test('passkey login rejects an unknown credential', async () => {
    const begin = await api('POST', '/api/auth/passkey/login/begin', { body: {} });
    const finish = await api('POST', '/api/auth/passkey/login/finish', {
      body: assertionBody({ id: 'not-a-stored-credential', challenge: begin.json.challenge }),
    });
    assert.equal(finish.status, 404);
    assert.equal(finish.json.code, 'UNKNOWN_CREDENTIAL');
  });

  test('passkey login rejects a bad / unverified assertion', async () => {
    verifyAuthImpl = async () => ({ verified: false });
    const begin = await api('POST', '/api/auth/passkey/login/begin', { body: {} });
    const finish = await api('POST', '/api/auth/passkey/login/finish', {
      body: assertionBody({ id: CRED_ID, challenge: begin.json.challenge }),
    });
    assert.equal(finish.status, 400);
    assert.match(finish.json.error, /not verified/i);
    verifyAuthImpl = async () => ({
      verified: true,
      authenticationInfo: { newCounter: 3 },
    });
  });

  test('passkey login rejects a thrown WebAuthn verification (bad signature shape)', async () => {
    verifyAuthImpl = async () => {
      throw new Error('signature invalid');
    };
    const begin = await api('POST', '/api/auth/passkey/login/begin', { body: {} });
    const finish = await api('POST', '/api/auth/passkey/login/finish', {
      body: assertionBody({ id: CRED_ID, challenge: begin.json.challenge }),
    });
    assert.equal(finish.status, 400);
    assert.match(finish.json.error, /passkey login failed/i);
    verifyAuthImpl = async () => ({
      verified: true,
      authenticationInfo: { newCounter: 4 },
    });
  });

  test('passkey login session can call clerk routes when the person is a clerk', async () => {
    const clerk = store.createUser({ handle: 'clerk-passkey', role: 'clerk' });
    store.addCredential(clerk.id, {
      id: 'clerk-resident-cred',
      publicKey: DUMMY_PUBKEY,
      counter: 0,
      transports: ['internal'],
    });
    await store.grantJurisdictionRole('demo', { handle: 'clerk-passkey', role: 'clerk' });
    await store.persist();
    const begin = await api('POST', '/api/auth/passkey/login/begin', { body: {} });
    const finish = await api('POST', '/api/auth/passkey/login/finish', {
      jar: clerkJar,
      body: assertionBody({ id: 'clerk-resident-cred', challenge: begin.json.challenge }),
    });
    assert.equal(finish.status, 200, finish.json?.error);
    assert.equal(finish.json.user.role, 'clerk');
    const created = await api('POST', '/api/elections', {
      jar: clerkJar,
      body: {
        title: 'Clerk after passkey login',
        startTime: Math.floor(Date.now() / 1000) + 60,
        cutoffTime: Math.floor(Date.now() / 1000) + 3600,
        questions: [{ type: 'YES_NO', prompt: 'Adopt?' }],
        jurisdictionId: 'demo',
      },
    });
    assert.equal(created.status, 201, created.json?.error);
    const voterDenied = await api('POST', '/api/elections', {
      jar: passkeyJar,
      body: { title: 'nope' },
    });
    assert.equal(voterDenied.status, 403);
  });

  test('wallet login challenge is a SIWE-like message that is not a bind', async () => {
    const { status, json } = await api('POST', '/api/auth/web3/challenge', {
      body: { address: account0.address },
    });
    assert.equal(status, 200, json?.error);
    assert.equal(json.purpose, 'login');
    assert.match(json.message, /sign in with this Ethereum wallet/i);
    assert.doesNotMatch(json.message, /uniquely identify this Ethereum address to your person/);
    assert.ok(json.nonce);
  });

  test('wallet login rejects an unknown address (does not register a person)', async () => {
    const challenge = await api('POST', '/api/auth/web3/challenge', {
      body: { address: unbound.address },
    });
    const signature = await unbound.signMessage({ message: challenge.json.message });
    const login = await api('POST', '/api/auth/web3/login', {
      body: { address: unbound.address, signature },
    });
    assert.equal(login.status, 404);
    assert.equal(login.json.code, 'UNKNOWN_CREDENTIAL');
    assert.equal(store.getUserByHandle(`eth-${unbound.address.slice(2).toLowerCase()}`), null);
  });

  test('wallet login happy path after the address is bound to a person', async () => {
    const bindChallenge = await api('POST', '/api/identity/web3/challenge', {
      body: { address: account0.address },
    });
    const bindSig = await account0.signMessage({ message: bindChallenge.json.message });
    const bound = await api('POST', '/api/identity/web3/verify', {
      body: { address: account0.address, signature: bindSig, handle: 'wallet-alice', acceptedTerms: true },
    });
    assert.equal(bound.status, 200, bound.json?.error);
    assert.equal(bound.json.user.handle, 'wallet-alice');

    const loginChallenge = await api('POST', '/api/auth/web3/challenge', {
      body: { address: account0.address },
    });
    const loginSig = await account0.signMessage({ message: loginChallenge.json.message });
    const login = await api('POST', '/api/auth/web3/login', {
      jar: walletJar,
      body: { address: account0.address, signature: loginSig },
    });
    assert.equal(login.status, 200, login.json?.error);
    assert.equal(login.json.user.handle, 'wallet-alice');
    assert.equal(login.json.user.role, 'voter');
    assert.ok(walletJar['republic.sid']);
    const me = await api('GET', '/api/me', { jar: walletJar });
    assert.equal(me.json.user.handle, 'wallet-alice');
    assert.equal(me.json.identity.activeEthAddress, account0.address);
  });

  test('wallet login rejects a bad signature', async () => {
    const challenge = await api('POST', '/api/auth/web3/challenge', {
      body: { address: account0.address },
    });
    const wrong = await account1.signMessage({ message: challenge.json.message });
    const login = await api('POST', '/api/auth/web3/login', {
      body: { address: account0.address, signature: wrong },
    });
    assert.equal(login.status, 400);
    assert.match(login.json.error, /signature invalid/i);
  });

  test('wallet login resolves a verified ETH account that is not a web3 auth method', async () => {
    const alice = store.getUserByHandle('wallet-alice');
    await store.addEthAccount(alice.id, { address: account1.address, source: 'passkey' });
    const challenge = await api('POST', '/api/auth/web3/challenge', {
      body: { address: account1.address },
    });
    const signature = await account1.signMessage({ message: challenge.json.message });
    const login = await api('POST', '/api/auth/web3/login', {
      body: { address: account1.address, signature },
    });
    assert.equal(login.status, 200, login.json?.error);
    assert.equal(login.json.user.handle, 'wallet-alice');
  });

  test('wallet login without a prior challenge is rejected', async () => {
    const { status, json } = await api('POST', '/api/auth/web3/login', {
      body: { address: account0.address, signature: `0x${'ab'.repeat(65)}` },
    });
    assert.equal(status, 400);
    assert.match(json.error, /no web3 login challenge/i);
  });

  test('POST /api/auth/logout clears the session', async () => {
    const out = await api('POST', '/api/auth/logout', { jar: walletJar });
    assert.equal(out.status, 200);
    const me = await api('GET', '/api/me', { jar: walletJar });
    assert.equal(me.json.user, null);
  });
});

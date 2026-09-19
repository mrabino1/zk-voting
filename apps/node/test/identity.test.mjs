// NOT FOR PROFIT — civic public good, not a commercial product.
// One person. Passkey / Web3 / smart-card. Many verified ETH addresses; one active.

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
const account2 = mnemonicToAccount(MNEMONIC, { addressIndex: 2 });

let tmp;
let app;
let server;
let base;
const adminJar = {};
const aliceJar = {};
const bobJar = {};

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

async function bindWeb3(account, { handle, jar } = {}) {
  const challenge = await api('POST', '/api/identity/web3/challenge', {
    body: { address: account.address },
    jar,
  });
  assert.equal(challenge.status, 200, challenge.json?.error);
  const signature = await account.signMessage({ message: challenge.json.message });
  return api('POST', '/api/identity/web3/verify', {
    body: { address: account.address, signature, handle, acceptedTerms: true },
    jar,
  });
}

describe('person identity (passkey / web3 / smart card, one active ETH)', () => {
  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'republic-identity-'));
    const created = await createApp({
      dataDir: tmp,
      allowDevLogin: true,
      allowSmartCardMock: true,
      adminHandle: 'admin',
      quiet: true,
      port: 0,
      disclosureIntervalSeconds: 0,
    });
    app = created.app;
    server = await listen(app);
    base = `http://127.0.0.1:${server.address().port}`;
    const login = await api('POST', '/api/auth/dev-login', {
      body: { handle: 'admin' },
      jar: adminJar,
    });
    assert.equal(login.status, 200, login.json?.error);
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await rm(tmp, { recursive: true, force: true });
  });

  test('catalog advertises email, web3, smart card, civic id, passkey, and one active Ethereum address', async () => {
    const methods = await api('GET', '/api/identity/methods');
    assert.equal(methods.status, 200);
    assert.equal(methods.json.nfp, true);
    assert.deepEqual(
      methods.json.methods.map((m) => m.type),
      ['email', 'web3', 'smart_card', 'civic_id', 'passkey'],
    );
    const config = await api('GET', '/api/config');
    assert.equal(config.status, 200);
    assert.equal(config.json.identity.oneActiveEthAddress, true);
    assert.equal(config.json.identity.onePrimaryEmail, true);
    assert.equal(config.json.identity.maxPasskeys, 5);
    assert.equal(config.json.identity.maxEmails, 5);
    assert.deepEqual(config.json.identity.methods, ['email', 'web3', 'smart_card', 'civic_id', 'passkey']);
    assert.equal(methods.json.caps.emails, 5);
    assert.equal(methods.json.caps.passkeys, 5);
    assert.equal(methods.json.onePrimaryEmail, true);
  });

  test('web3 bind uniquely identifies a person and registers the first address as active', async () => {
    const bound = await bindWeb3(account0, { handle: 'alice', jar: aliceJar });
    assert.equal(bound.status, 200, bound.json?.error);
    assert.equal(bound.json.nfp, true);
    assert.equal(bound.json.user.handle, 'alice');
    assert.equal(bound.json.identity.activeEthAddress, account0.address);
    assert.equal(bound.json.identity.verifiedEthAddressCount, 1);
    assert.equal(bound.json.identity.ethAccounts[0].active, true);
    assert.ok(bound.json.identity.authMethods.some((m) => m.type === 'web3'));
    assert.ok(aliceJar['republic.sid']);

    const me = await api('GET', '/api/me', { jar: aliceJar });
    assert.equal(me.json.identity.activeEthAddress, account0.address);
    assert.equal(me.json.user.activeEthAddress, account0.address);
    assert.equal(me.json.user.personKeyBound, false);
  });

  test('a person may verify many ETH addresses internally and switch the one active address', async () => {
    const second = await api('POST', '/api/me/eth-accounts', {
      jar: aliceJar,
      body: { address: account1.address, source: 'passkey' },
    });
    assert.equal(second.status, 201, second.json?.error);
    assert.equal(second.json.identity.verifiedEthAddressCount, 2);
    assert.equal(second.json.identity.activeEthAddress, account0.address);
    const inactive = second.json.identity.ethAccounts.find((a) => a.address === account1.address);
    assert.equal(inactive.active, false);
    assert.equal(inactive.verified, true);

    const switched = await api('POST', '/api/me/eth-accounts/active', {
      jar: aliceJar,
      body: { address: account1.address },
    });
    assert.equal(switched.status, 200, switched.json?.error);
    assert.equal(switched.json.activeEthAddress, account1.address);
    assert.equal(switched.json.identity.verifiedEthAddressCount, 2);
    assert.equal(
      switched.json.identity.ethAccounts.filter((a) => a.active).length,
      1,
    );

    const back = await api('POST', '/api/me/eth-accounts/active', {
      jar: aliceJar,
      body: { address: account0.address },
    });
    assert.equal(back.json.activeEthAddress, account0.address);
  });

  test('setActive of an address this person has not verified is NOT_VERIFIED', async () => {
    const { status, json } = await api('POST', '/api/me/eth-accounts/active', {
      jar: aliceJar,
      body: { address: account2.address },
    });
    assert.equal(status, 400);
    assert.equal(json.code, 'NOT_VERIFIED');
  });

  test('the same wallet or address cannot be bound to a second person', async () => {
    const bob = await bindWeb3(account2, { handle: 'bob', jar: bobJar });
    assert.equal(bob.status, 200, bob.json?.error);
    assert.equal(bob.json.user.handle, 'bob');
    assert.equal(bob.json.identity.activeEthAddress, account2.address);

    const stealWallet = await bindWeb3(account0, { handle: 'eve', jar: bobJar });
    assert.equal(stealWallet.status, 409);
    assert.equal(stealWallet.json.code, 'METHOD_OWNED');

    const stealInternal = await bindWeb3(account1, { handle: 'eve', jar: {} });
    assert.equal(stealInternal.status, 409);
    assert.equal(stealInternal.json.code, 'ADDRESS_OWNED');

    const loginAsAlice = await bindWeb3(account0, { jar: {} });
    assert.equal(loginAsAlice.status, 200, loginAsAlice.json?.error);
    assert.equal(loginAsAlice.json.user.handle, 'alice');

    const grab = await api('POST', '/api/me/eth-accounts', {
      jar: bobJar,
      body: { address: account0.address },
    });
    assert.equal(grab.status, 409);
    assert.equal(grab.json.code, 'ADDRESS_OWNED');
  });

  test('smart-card mock bind uniquely identifies a person', async () => {
    const fp = `0x${'ab'.repeat(16)}`;
    const challenge = await api('POST', '/api/identity/smart-card/challenge', {
      body: { fingerprint: fp },
    });
    assert.equal(challenge.status, 200, challenge.json?.error);
    const verify = await api('POST', '/api/identity/smart-card/verify', {
      body: {
        nonce: challenge.json.nonce,
        fingerprint: fp,
        mock: true,
        handle: 'cardholder',
        subject: 'CN=Card Holder',
        acceptedTerms: true,
      },
    });
    assert.equal(verify.status, 200, verify.json?.error);
    assert.ok(verify.json.identity.authMethods.some((m) => m.type === 'smart_card'));
    assert.equal(verify.json.identity.activeEthAddress, null);

    const challenge2 = await api('POST', '/api/identity/smart-card/challenge', {
      body: { fingerprint: fp },
    });
    const steal = await api('POST', '/api/identity/smart-card/verify', {
      jar: bobJar,
      body: { nonce: challenge2.json.nonce, fingerprint: fp, mock: true },
    });
    assert.equal(steal.status, 409);
    assert.equal(steal.json.code, 'METHOD_OWNED');
  });

  test('registrar person-key is unique and does not store a name', async () => {
    const me = await api('GET', '/api/me', { jar: aliceJar });
    const aliceId = me.json.user.id;
    const bobMe = await api('GET', '/api/me', { jar: bobJar });
    const bobId = bobMe.json.user.id;

    const bound = await api('POST', `/api/persons/${aliceId}/person-key`, {
      jar: adminJar,
      body: { personKey: 'civil-file-alice-1' },
    });
    assert.equal(bound.status, 200, bound.json?.error);
    assert.equal(bound.json.user.personKeyBound, true);
    assert.equal(bound.json.identity.personKeyBound, true);
    assert.equal(bound.json.user.personKeyHash, undefined);

    const voterDenied = await api('POST', `/api/persons/${aliceId}/person-key`, {
      jar: aliceJar,
      body: { personKey: 'civil-file-alice-1' },
    });
    assert.equal(voterDenied.status, 403);

    const clash = await api('POST', `/api/persons/${bobId}/person-key`, {
      jar: adminJar,
      body: { personKey: 'civil-file-alice-1' },
    });
    assert.equal(clash.status, 409);
    assert.equal(clash.json.code, 'PERSON_KEY_OWNED');
  });

  test('registrar can attest a smart card and a second ETH address without changing the leaf model', async () => {
    const me = await api('GET', '/api/me', { jar: aliceJar });
    const aliceId = me.json.user.id;
    const extra = '0x00000000000000000000000000000000000000aa';
    const added = await api('POST', `/api/persons/${aliceId}/eth-accounts`, {
      jar: adminJar,
      body: { address: extra, source: 'registrar' },
    });
    assert.equal(added.status, 201, added.json?.error);
    assert.ok(added.json.identity.verifiedEthAddressCount >= 3);
    assert.equal(added.json.identity.activeEthAddress, account0.address);

    const method = await api('POST', `/api/persons/${aliceId}/methods`, {
      jar: adminJar,
      body: { type: 'smart_card', fingerprint: `0x${'cd'.repeat(16)}`, label: 'National eID' },
    });
    assert.equal(method.status, 201, method.json?.error);
    assert.ok(method.json.identity.authMethods.some((m) => m.type === 'smart_card'));

    const identity = await api('GET', '/api/me/identity', { jar: aliceJar });
    assert.equal(identity.status, 200);
    assert.equal(identity.json.identity.personId, aliceId);
    assert.ok(identity.json.identity.note.includes('Only one Ethereum address is active'));
  });

  test('POST /me/eth-accounts requires a session', async () => {
    const { status } = await api('POST', '/api/me/eth-accounts', {
      body: { address: '0x0000000000000000000000000000000000000001' },
    });
    assert.equal(status, 401);
  });
});

describe('smart-card mock is off unless ALLOW_SMART_CARD_MOCK', () => {
  let tmp2;
  let server2;
  let base2;

  before(async () => {
    tmp2 = await mkdtemp(path.join(os.tmpdir(), 'republic-card-'));
    const created = await createApp({
      dataDir: tmp2,
      allowDevLogin: true,
      allowSmartCardMock: false,
      quiet: true,
      port: 0,
      disclosureIntervalSeconds: 0,
    });
    server2 = await listen(created.app);
    base2 = `http://127.0.0.1:${server2.address().port}`;
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server2.close((err) => (err ? reject(err) : resolve()));
    });
    await rm(tmp2, { recursive: true, force: true });
  });

  test('self-service card verify without mock config is clerk-attested only', async () => {
    const fp = `0x${'ef'.repeat(16)}`;
    const challenge = await fetch(base2 + '/api/identity/smart-card/challenge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fingerprint: fp }),
    });
    const issued = await challenge.json();
    const verify = await fetch(base2 + '/api/identity/smart-card/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce: issued.nonce, fingerprint: fp, mock: true, handle: 'kiosk' }),
    });
    assert.equal(verify.status, 400);
    const json = await verify.json();
    assert.match(json.error, /clerk-attested|ALLOW_SMART_CARD_MOCK/);
  });
});

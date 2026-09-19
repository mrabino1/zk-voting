// NOT FOR PROFIT — civic public good, not a commercial product.
// Voter registration requests need civil approval. Multiple verified ETH
// addresses and licenses; officers revoke expired cards/licenses by hand.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { mnemonicToAccount } from 'viem/accounts';

import { civicIdHash } from '../src/identity.mjs';
import { createApp } from '../src/server.mjs';

const MNEMONIC = 'test test test test test test test test test test test junk';
const account0 = mnemonicToAccount(MNEMONIC, { addressIndex: 0 });
const account1 = mnemonicToAccount(MNEMONIC, { addressIndex: 1 });

let tmp;
let app;
let server;
let base;
const adminJar = {};
const voterJar = {};
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

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

async function createElection(title = 'Civil review') {
  const created = await api('POST', '/api/elections', {
    jar: adminJar,
    body: {
      title,
      startTime: nowSec() - 60,
      cutoffTime: nowSec() + 3600,
      maxParticipants: 0,
      treeDepth: 16,
      jurisdictionId: 'demo',
      questions: [{ type: 'YES_NO', prompt: 'Adopt the measure?' }],
    },
  });
  assert.equal(created.status, 201, created.json?.error);
  return created.json.election.id;
}

describe('registration approval and revocable credentials', () => {
  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'republic-reg-cred-'));
    const created = await createApp({
      dataDir: tmp,
      allowDevLogin: true,
      allowSmartCardMock: true,
      allowCivicIdMock: true,
      adminHandle: 'admin',
      quiet: true,
      port: 0,
      disclosureIntervalSeconds: 0,
      credentialProviderSecret: 'test-provider-secret',
      credentialProviderId: 'demo-dmv',
    });
    app = created.app;
    server = await listen(app);
    base = `http://127.0.0.1:${server.address().port}`;
    const admin = await api('POST', '/api/auth/dev-login', {
      body: { handle: 'admin' },
      jar: adminJar,
    });
    assert.equal(admin.status, 200, admin.json?.error);
    const voter = await api('POST', '/api/auth/dev-login', {
      body: { handle: 'voter-ada', role: 'voter' },
      jar: voterJar,
    });
    assert.equal(voter.status, 200, voter.json?.error);
    const clerk = await api('POST', '/api/auth/dev-login', {
      body: { handle: 'clerk-ada', role: 'voter' },
      jar: clerkJar,
    });
    assert.equal(clerk.status, 200, clerk.json?.error);
    const clerkId = clerk.json.user.id;
    const grant = await api('POST', '/api/jurisdictions/demo/roles', {
      jar: adminJar,
      body: { userId: clerkId, role: 'clerk' },
    });
    assert.equal(grant.status, 200, grant.json?.error);
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await rm(tmp, { recursive: true, force: true });
  });

  test('config advertises manual+webhook provider and civil registration approval', async () => {
    const config = await api('GET', '/api/config');
    assert.equal(config.status, 200);
    assert.equal(config.json.identity.registrationApproval, 'civil_officer');
    assert.equal(config.json.identity.maxSmartCards, 5);
    assert.equal(config.json.identity.maxCivicIds, 5);
    assert.equal(config.json.identity.credentialProvider.webhookEnabled, true);
    assert.equal(config.json.identity.credentialProvider.mode, 'manual+webhook');
    assert.equal(config.json.identity.credentialProvider.webhookPath, '/api/integrations/credentials/status');
  });

  test('a voter request is pending until a civil officer approves', async () => {
    const id = await createElection('Pending roll');
    const req = await api('POST', `/api/elections/${id}/register`, {
      jar: voterJar,
      body: { identityCommitment: '0xaaa1' },
    });
    assert.equal(req.status, 202, req.json?.error);
    assert.equal(req.json.status, 'pending');
    assert.equal(req.json.code, 'PENDING_REVIEW');
    assert.ok(req.json.request?.id);

    const roll = await api('GET', `/api/elections/${id}/registrations`, { jar: adminJar });
    assert.equal(roll.json.registrations.length, 0);

    const mine = await api('GET', `/api/elections/${id}`, { jar: voterJar });
    assert.equal(mine.json.me.pending, true);
    assert.equal(mine.json.me.registered, false);

    const listed = await api('GET', `/api/elections/${id}/registration-requests?status=pending`, {
      jar: clerkJar,
    });
    assert.equal(listed.status, 200, listed.json?.error);
    assert.equal(listed.json.requests.length, 1);
    assert.equal(listed.json.requests[0].handle, 'voter-ada');

    const again = await api('POST', `/api/elections/${id}/register`, {
      jar: voterJar,
      body: { identityCommitment: '0xaaa2' },
    });
    assert.equal(again.status, 409);
    assert.equal(again.json.code, 'REQUEST_PENDING');

    const approved = await api(
      'POST',
      `/api/elections/${id}/registration-requests/${req.json.request.id}/approve`,
      { jar: clerkJar, body: {} },
    );
    assert.equal(approved.status, 200, approved.json?.error);
    assert.equal(approved.json.status, 'registered');
    assert.equal(approved.json.leafIndex, 0);

    const after = await api('GET', `/api/elections/${id}`, { jar: voterJar });
    assert.equal(after.json.me.registered, true);
    assert.equal(after.json.me.pending, false);

    const roll2 = await api('GET', `/api/elections/${id}/registrations`, { jar: adminJar });
    assert.equal(roll2.json.registrations.length, 1);

    const afterEnrolled = await api('POST', `/api/elections/${id}/register`, {
      jar: voterJar,
      body: { identityCommitment: '0xaaa3' },
    });
    assert.equal(afterEnrolled.status, 409);
    assert.equal(afterEnrolled.json.code, 'ALREADY_REGISTERED');
  });

  test('a civil officer may deny a request; the leaf is not inserted', async () => {
    const id = await createElection('Denied roll');
    const req = await api('POST', `/api/elections/${id}/register`, {
      jar: voterJar,
      body: { identityCommitment: '0xbbb1' },
    });
    assert.equal(req.status, 202, req.json?.error);
    const denied = await api(
      'POST',
      `/api/elections/${id}/registration-requests/${req.json.request.id}/deny`,
      { jar: adminJar, body: { reason: 'documents incomplete' } },
    );
    assert.equal(denied.status, 200, denied.json?.error);
    assert.equal(denied.json.status, 'denied');
    const mine = await api('GET', `/api/elections/${id}`, { jar: voterJar });
    assert.equal(mine.json.me.registered, false);
    assert.equal(mine.json.me.requestStatus, 'denied');
    const roll = await api('GET', `/api/elections/${id}/registrations`, { jar: adminJar });
    assert.equal(roll.json.registrations.length, 0);
  });

  test('a registrar/admin still inserts a commitment immediately', async () => {
    const id = await createElection('Officer insert');
    const inserted = await api('POST', `/api/elections/${id}/register`, {
      jar: adminJar,
      body: { identityCommitment: '0xccc1' },
    });
    assert.equal(inserted.status, 201, inserted.json?.error);
    assert.equal(inserted.json.status, 'registered');
    const roll = await api('GET', `/api/elections/${id}/registrations`, { jar: adminJar });
    assert.equal(roll.json.registrations.length, 1);
  });

  test('extra Ethereum addresses require a wallet signature', async () => {
    const unsigned = await api('POST', '/api/me/eth-accounts', {
      jar: voterJar,
      body: { address: account0.address },
    });
    assert.equal(unsigned.status, 400);
    assert.equal(unsigned.json.code, 'SIGNATURE_REQUIRED');

    const challenge = await api('POST', '/api/identity/web3/challenge', {
      jar: voterJar,
      body: { address: account0.address },
    });
    const signature = await account0.signMessage({ message: challenge.json.message });
    const first = await api('POST', '/api/me/eth-accounts', {
      jar: voterJar,
      body: {
        address: account0.address,
        signature,
        nonce: challenge.json.nonce,
        source: 'web3',
      },
    });
    assert.equal(first.status, 201, first.json?.error);
    assert.equal(first.json.identity.activeEthAddress, account0.address);
    assert.equal(first.json.identity.ethAccounts[0].verified, true);
    assert.equal(first.json.identity.ethAccounts[0].verifiedBy, 'self');

    const challenge1 = await api('POST', '/api/identity/web3/challenge', {
      jar: voterJar,
      body: { address: account1.address },
    });
    const signature1 = await account1.signMessage({ message: challenge1.json.message });
    const second = await api('POST', '/api/me/eth-accounts', {
      jar: voterJar,
      body: {
        address: account1.address,
        signature: signature1,
        nonce: challenge1.json.nonce,
      },
    });
    assert.equal(second.status, 201, second.json?.error);
    assert.equal(second.json.identity.verifiedEthAddressCount, 2);
    assert.equal(second.json.identity.activeEthAddress, account0.address);

    const listed = await api('GET', '/api/me/eth-accounts', { jar: voterJar });
    assert.equal(listed.json.ethAccounts.length, 2);
  });

  test('a person may bind several driver’s licenses; officers revoke an expired one', async () => {
    const voterId = (await api('GET', '/api/me', { jar: voterJar })).json.user.id;
    const first = await api('POST', `/api/persons/${voterId}/methods`, {
      jar: adminJar,
      body: {
        type: 'civic_id',
        kind: 'drivers_license',
        issuer: 'US-CA',
        documentNumber: 'CA-OLD-1111',
        expiresAt: '2020-01-01',
        label: 'California (expired)',
      },
    });
    assert.equal(first.status, 201, first.json?.error);
    const expired = first.json.identity.credentials.find((c) => c.issuer === 'US-CA');
    assert.ok(expired);
    assert.equal(expired.status, 'expired');

    const second = await api('POST', `/api/persons/${voterId}/methods`, {
      jar: adminJar,
      body: {
        type: 'civic_id',
        kind: 'drivers_license',
        issuer: 'US-NV',
        documentNumber: 'NV-LIVE-2222',
        expiresAt: '2099-12-31',
      },
    });
    assert.equal(second.status, 201, second.json?.error);
    assert.equal(second.json.identity.civicIdCount, 1);

    const loginExpired = await api('POST', '/api/auth/civic-id/login', {
      body: { kind: 'drivers_license', issuer: 'US-CA', documentNumber: 'CA-OLD-1111' },
    });
    assert.equal(loginExpired.status, 403);
    assert.equal(loginExpired.json.code, 'CREDENTIAL_EXPIRED');

    const loginLive = await api('POST', '/api/auth/civic-id/login', {
      body: { kind: 'drivers_license', issuer: 'US-NV', documentNumber: 'NV-LIVE-2222' },
      jar: {},
    });
    assert.equal(loginLive.status, 200, loginLive.json?.error);

    const office = await api('GET', '/api/office/credentials?type=civic_id', { jar: clerkJar });
    assert.equal(office.status, 200, office.json?.error);
    const nv = office.json.credentials.find((c) => c.issuer === 'US-NV');
    assert.ok(nv);
    const revoked = await api('POST', `/api/persons/${voterId}/methods/${nv.id}/revoke`, {
      jar: clerkJar,
      body: { reason: 'EXPIRED' },
    });
    assert.equal(revoked.status, 200, revoked.json?.error);
    assert.equal(revoked.json.credential.status, 'revoked');

    const loginRevoked = await api('POST', '/api/auth/civic-id/login', {
      body: { kind: 'drivers_license', issuer: 'US-NV', documentNumber: 'NV-LIVE-2222' },
    });
    assert.equal(loginRevoked.status, 403);
    assert.equal(loginRevoked.json.code, 'CREDENTIAL_REVOKED');
  });

  test('a smart card can be revoked and then cannot sign in', async () => {
    const fp = `0x${'11'.repeat(16)}`;
    const challenge = await api('POST', '/api/identity/smart-card/challenge', {
      body: { fingerprint: fp },
    });
    const bound = await api('POST', '/api/identity/smart-card/verify', {
      jar: voterJar,
      body: { nonce: challenge.json.nonce, fingerprint: fp, mock: true, issuer: 'PIV' },
    });
    assert.equal(bound.status, 200, bound.json?.error);
    const card = bound.json.identity.credentials.find((c) => c.type === 'smart_card');
    assert.ok(card);
    const voterId = bound.json.identity.personId;
    const revoked = await api('POST', `/api/persons/${voterId}/methods/${card.id}/revoke`, {
      jar: adminJar,
      body: { reason: 'SUSPENDED' },
    });
    assert.equal(revoked.status, 200, revoked.json?.error);
    const loginChal = await api('POST', '/api/auth/smart-card/challenge', {
      body: { fingerprint: fp },
    });
    const login = await api('POST', '/api/auth/smart-card/login', {
      body: { nonce: loginChal.json.nonce, fingerprint: fp, mock: true },
    });
    assert.equal(login.status, 403);
    assert.equal(login.json.code, 'CREDENTIAL_REVOKED');
  });

  test('provider webhook updates status when the shared secret is set', async () => {
    const voterId = (await api('GET', '/api/me', { jar: voterJar })).json.user.id;
    const hash = civicIdHash({
      kind: 'passport',
      issuer: 'US',
      documentNumber: 'P999888777',
    });
    const added = await api('POST', `/api/persons/${voterId}/methods`, {
      jar: adminJar,
      body: {
        type: 'civic_id',
        kind: 'passport',
        issuer: 'US',
        documentNumber: 'P999888777',
        expiresAt: '2099-01-01',
      },
    });
    assert.equal(added.status, 201, added.json?.error);
    const denied = await api('POST', '/api/integrations/credentials/status', {
      body: { civicIdHash: hash, status: 'revoked', reason: 'PROVIDER' },
      headers: { 'x-republic-provider-secret': 'wrong' },
    });
    assert.equal(denied.status, 401);

    const ok = await api('POST', '/api/integrations/credentials/status', {
      body: { civicIdHash: hash, status: 'revoked', reason: 'PROVIDER', providerRef: 'dmv-batch-1' },
      headers: { 'x-republic-provider-secret': 'test-provider-secret' },
    });
    assert.equal(ok.status, 200, ok.json?.error);
    assert.equal(ok.json.credential.status, 'revoked');
    assert.equal(ok.json.credential.providerRef, 'dmv-batch-1');
  });
});

describe('credential provider stays manual without a secret', () => {
  let tmp2;
  let server2;
  let base2;

  before(async () => {
    tmp2 = await mkdtemp(path.join(os.tmpdir(), 'republic-manual-'));
    const created = await createApp({
      dataDir: tmp2,
      allowDevLogin: true,
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

  test('webhook is 501 CREDENTIAL_PROVIDER_MANUAL', async () => {
    const res = await fetch(base2 + '/api/integrations/credentials/status', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ civicIdHash: '0x' + 'ab'.repeat(32), status: 'revoked' }),
    });
    assert.equal(res.status, 501);
    const json = await res.json();
    assert.equal(json.code, 'CREDENTIAL_PROVIDER_MANUAL');
    const config = await fetch(base2 + '/api/config');
    const cfg = await config.json();
    assert.equal(cfg.identity.credentialProvider.mode, 'manual');
    assert.equal(cfg.identity.credentialProvider.webhookEnabled, false);
  });
});

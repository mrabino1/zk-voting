// NOT FOR PROFIT — civic public good, not a commercial product.

import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { createApp } from '../src/server.mjs';
import { nextAuditEntry, verifyAuditChain } from '../src/superAdmin/audit.mjs';
import { hashSuperAdminSecret, parseSuperAdminToken, resolveKeyExpiry } from '../src/superAdmin/keys.mjs';
import { ipAllowed, normalizeCidr } from '../src/superAdmin/net.mjs';
import { FORBIDDEN_FIELD_NAMES, redactionProblems } from '../src/superAdmin/redact.mjs';
import { recordLog, resetLogBuffer } from '../src/superAdmin/logs.mjs';
import { grantableScopes, normalizeScopeList, reservedScopes } from '../src/superAdmin/scopes.mjs';

const PEPPER = 'unit-test-pepper';
const ADMIN_EMAIL = 'root-operator@example.gov';
const READS = [
  '/api/_sa/v1/health',
  '/api/_sa/v1/config',
  '/api/_sa/v1/store',
  '/api/_sa/v1/elections',
  '/api/_sa/v1/users',
  '/api/_sa/v1/l2',
  '/api/_sa/v1/l1',
  '/api/_sa/v1/mail',
  '/api/_sa/v1/logs',
  '/api/_sa/v1/audit',
  '/api/_sa/v1/audit/verify',
];
const ALL_SCOPES = [
  'read:health',
  'read:config',
  'read:store',
  'read:elections',
  'read:users',
  'read:l2',
  'read:l1',
  'read:mail',
  'read:logs',
  'read:audit',
  'write:config',
  'write:mail',
  'write:users',
  'write:elections',
  'write:l2',
  'write:logs',
];

function applyCookies(res, jar) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const cookie of list) {
    const pair = cookie.split(';')[0];
    const i = pair.indexOf('=');
    if (i === -1) continue;
    jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
}

function cookieHeader(jar) {
  return Object.entries(jar)
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');
}

function listen(application) {
  return new Promise((resolve, reject) => {
    const server = application.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

function client(base) {
  return async function api(method, url, { body, jar, headers } = {}) {
    const res = await fetch(base + url, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(jar ? { cookie: cookieHeader(jar) } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (jar) applyCookies(res, jar);
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json, text };
  };
}

function walkKeys(value, visit) {
  if (Array.isArray(value)) {
    for (const item of value) walkKeys(item, visit);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    visit(key);
    walkKeys(child, visit);
  }
}

describe('super-admin scope registry', () => {
  test('read and write are separate and reserved names are not grantable', () => {
    const grantable = grantableScopes();
    assert.ok(grantable.includes('read:health'));
    assert.ok(grantable.includes('write:config'));
    assert.equal(grantable.includes('write:health'), false);
    assert.equal(grantable.includes('write:store'), false);
    assert.equal(grantable.includes('write:l1'), false);
    assert.equal(grantable.includes('read:apikeys'), false);
    assert.equal(grantable.includes('write:apikeys'), false);
    assert.deepEqual(reservedScopes().sort(), ['write:health', 'write:l1', 'write:store']);
    assert.throws(() => normalizeScopeList(['write:store']), /not grantable/);
    assert.throws(() => normalizeScopeList(['read:*']), /wildcard/);
    assert.throws(() => normalizeScopeList(['ops:health']), /not grantable/);
    assert.deepEqual(normalizeScopeList(['read:health', 'read:health']), ['read:health']);
    const expiry = resolveKeyExpiry({ nowMs: 1_700_000_000_000 });
    assert.equal(expiry.expiresIn, '30d');
    assert.throws(() => resolveKeyExpiry({ expiresIn: 'never' }), /allowNeverExpires/);
    assert.equal(normalizeCidr('127.0.0.1'), '127.0.0.1/32');
    assert.equal(ipAllowed('::ffff:127.0.0.1', ['10.0.0.0/8']), false);
    assert.equal(ipAllowed('::ffff:127.0.0.8', ['127.0.0.0/8']), true);
  });

  test('redaction scanner rejects forbidden fields and secret material', () => {
    const bad = { nested: { identityCommitment: 'abc', choice: 1 } };
    assert.ok(redactionProblems(bad).length >= 2);
    const leaked = { note: `token zksa_${'ab'.repeat(8)}_abcdefghijklmnopqrstuvwxyz0123456789` };
    assert.ok(redactionProblems(leaked).some((item) => item === 'note'));
    const clean = { ok: true, maskedEmail: 'r***@example.gov', castCount: 0 };
    assert.deepEqual(redactionProblems(clean, { superAdminEmail: ADMIN_EMAIL, pepper: PEPPER }), []);
    assert.ok(FORBIDDEN_FIELD_NAMES.includes('nullifier'));
    assert.ok(FORBIDDEN_FIELD_NAMES.includes('passkey'));
  });

  test('audit hash chain detects tampering', () => {
    const first = nextAuditEntry(null, sampleAudit(1));
    const second = nextAuditEntry(first, sampleAudit(2));
    assert.equal(verifyAuditChain([first, second]).ok, true);
    const tampered = { ...second, path: '/api/_sa/v1/config' };
    const verdict = verifyAuditChain([first, tampered]);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'hash_mismatch');
  });
});

function sampleAudit(n) {
  return {
    timestamp: new Date(n * 1000).toISOString(),
    keyId: n === 1 ? 'abcd' : null,
    sessionUser: n === 2 ? 'admin' : null,
    method: 'GET',
    path: '/api/_sa/v1/health',
    scope: 'read:health',
    result: 200,
    reason: 'ok',
    ip: '127.0.0.1',
    userAgent: 'test',
    requestId: `req-${n}`,
    dryRun: false,
    before: null,
    after: null,
  };
}

describe('platform super-admin API', { concurrency: false }, () => {
  let tmp;
  let server;
  let store;
  let mailer;
  let api;
  const admin = {};
  let csrf;
  let broad;

  before(async () => {
    resetLogBuffer();
    tmp = await mkdtemp(path.join(os.tmpdir(), 'republic-sa-'));
    const created = await createApp({
      dataDir: tmp,
      allowDevLogin: true,
      adminHandle: 'admin',
      quiet: true,
      port: 0,
      writerLease: false,
      superAdminApiPepper: PEPPER,
      superAdminEmail: ADMIN_EMAIL,
      disclosureIntervalSeconds: 0,
    });
    store = created.store;
    mailer = created.mailer;
    server = await listen(created.app);
    api = client(`http://127.0.0.1:${server.address().port}`);
    const login = await api('POST', '/api/auth/dev-login', { jar: admin, body: { handle: 'admin' } });
    assert.equal(login.status, 200, login.text);
    const session = await api('GET', '/api/_sa/v1/session', { jar: admin });
    assert.equal(session.status, 200, session.text);
    csrf = session.json.csrfToken;
    assert.equal(typeof csrf, 'string');
    assert.equal(session.json.recentAuth, true);
  });

  after(async () => {
    if (server) {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  function saHeaders(extra = {}) {
    return { 'x-csrf-token': csrf, ...extra };
  }

  test('auth failures are a generic 404 and keys cannot manage keys', async () => {
    const anon = await api('GET', '/api/_sa/v1/health');
    assert.equal(anon.status, 404);
    assert.deepEqual(anon.json, { error: 'not found', nfp: true });

    const voterJar = {};
    const voter = await api('POST', '/api/auth/dev-login', {
      jar: voterJar,
      body: { handle: 'voter-one', role: 'voter' },
    });
    assert.equal(voter.status, 200, voter.text);
    const denied = await api('GET', '/api/_sa/v1/keys', { jar: voterJar, headers: saHeaders() });
    assert.equal(denied.status, 404);
    assert.deepEqual(denied.json, { error: 'not found', nfp: true });

    const missingCsrf = await api('POST', '/api/_sa/v1/keys', {
      jar: admin,
      body: { name: 'nope', scopes: ['read:health'] },
    });
    assert.equal(missingCsrf.status, 404);
    assert.deepEqual(missingCsrf.json, { error: 'not found', nfp: true });

    const personal = await api('POST', '/api/me/api-keys', {
      jar: admin,
      body: { name: 'bot', level: 'read', expiresIn: '7d' },
    });
    assert.equal(personal.status, 201, personal.text);
    const rk = await api('GET', '/api/_sa/v1/health', {
      headers: { authorization: `Bearer ${personal.json.secret}` },
    });
    assert.equal(rk.status, 404);
    assert.deepEqual(rk.json, { error: 'not found', nfp: true });
    assert.equal(rk.text.includes(personal.json.secret), false);
  });

  test('create lists once, stores a hash, and defaults expiry to 30d', async () => {
    const created = await api('POST', '/api/_sa/v1/keys', {
      jar: admin,
      headers: saHeaders(),
      body: { name: 'broad', scopes: ALL_SCOPES },
    });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.json.shownOnce, true);
    assert.match(created.json.token, /^zksa_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
    broad = created.json.token;
    const parsed = parseSuperAdminToken(broad);
    const raw = await readFile(path.join(tmp, 'republic.json'), 'utf8');
    assert.equal(raw.includes(broad), false);
    assert.equal(raw.includes(parsed.secret), false);
    assert.equal(raw.includes(PEPPER), false);
    assert.equal(raw.includes(ADMIN_EMAIL) || raw.includes('root-operator'), true);
    const plain = createHash('sha256').update(parsed.secret).digest('hex');
    const mac = createHmac('sha256', PEPPER).update(parsed.secret).digest('hex');
    assert.equal(hashSuperAdminSecret(parsed.secret, PEPPER), mac);
    assert.equal(raw.includes(plain), false);
    assert.equal(raw.includes(mac), true);
    const expiresAt = Date.parse(created.json.key.expiresAt);
    const delta = expiresAt - Date.now();
    assert.ok(delta > 29 * 24 * 60 * 60 * 1000 && delta < 31 * 24 * 60 * 60 * 1000);

    const listed = await api('GET', '/api/_sa/v1/keys', { jar: admin, headers: saHeaders() });
    assert.equal(listed.status, 200, listed.text);
    assert.equal(JSON.stringify(listed.json).includes(broad), false);
    assert.equal(listed.json.keys.some((row) => row.id === created.json.key.id), true);
    assert.equal(listed.json.keys[0].status, 'active');

    const never = await api('POST', '/api/_sa/v1/keys', {
      jar: admin,
      headers: saHeaders(),
      body: { name: 'forever', scopes: ['read:health'], expiresIn: 'never' },
    });
    assert.equal(never.status, 400, never.text);
    const forever = await api('POST', '/api/_sa/v1/keys', {
      jar: admin,
      headers: saHeaders(),
      body: { name: 'forever', scopes: ['read:health'], expiresIn: 'never', allowNeverExpires: true },
    });
    assert.equal(forever.status, 201, forever.text);
    assert.equal(forever.json.key.expiresAt, null);
    assert.equal(forever.json.key.status, 'active');
  });

  test('step-up is required again after the window', async () => {
    const row = store.data.sessions.find((session) => session.csrfToken === csrf);
    const fresh = row.stepUpAt;
    row.stepUpAt = Date.now() - 2 * 60 * 60 * 1000;
    row.authenticatedAt = row.stepUpAt;
    row.createdAt = row.stepUpAt;
    const blocked = await api('POST', '/api/_sa/v1/keys', {
      jar: admin,
      headers: saHeaders(),
      body: { name: 'late', scopes: ['read:health'], expiresIn: '1h' },
    });
    assert.equal(blocked.status, 404);
    assert.deepEqual(blocked.json, { error: 'not found', nfp: true });
    const stepped = await api('POST', '/api/_sa/v1/step-up', { jar: admin, headers: saHeaders(), body: {} });
    assert.equal(stepped.status, 200, stepped.text);
    assert.equal(stepped.json.recentAuth, true);
    assert.ok(row.stepUpAt > fresh);
  });

  test('revoke is immediate and a key cannot rotate or list keys', async () => {
    const minted = await api('POST', '/api/_sa/v1/keys', {
      jar: admin,
      headers: saHeaders(),
      body: { name: 'temp', scopes: ['read:health'], expiresIn: '1h' },
    });
    assert.equal(minted.status, 201, minted.text);
    const token = minted.json.token;
    const ok = await api('GET', '/api/_sa/v1/health', { headers: { authorization: `Bearer ${token}` } });
    assert.equal(ok.status, 200, ok.text);
    const manage = await api('GET', '/api/_sa/v1/keys', {
      jar: admin,
      headers: { authorization: `Bearer ${token}`, 'x-csrf-token': csrf },
    });
    assert.equal(manage.status, 404);
    assert.deepEqual(manage.json, { error: 'not found', nfp: true });
    const revoked = await api('POST', `/api/_sa/v1/keys/${minted.json.key.id}/revoke`, {
      jar: admin,
      headers: saHeaders(),
      body: {},
    });
    assert.equal(revoked.status, 200, revoked.text);
    assert.equal(revoked.json.key.status, 'revoked');
    const again = await api('GET', '/api/_sa/v1/health', { headers: { authorization: `Bearer ${token}` } });
    assert.equal(again.status, 404);
    assert.deepEqual(again.json, { error: 'not found', nfp: true });
    const rotate = await api('POST', `/api/_sa/v1/keys/${minted.json.key.id}/rotate`, {
      jar: admin,
      headers: saHeaders(),
      body: {},
    });
    assert.equal(rotate.status, 409, rotate.text);
  });

  test('expiry, allowlist, and rate limit', async () => {
    const minted = await api('POST', '/api/_sa/v1/keys', {
      jar: admin,
      headers: saHeaders(),
      body: { name: 'short', scopes: ['read:health'], expiresIn: '1h' },
    });
    const row = store.data.superAdminKeys.find((item) => item.id === minted.json.key.id);
    row.expiresAt = new Date(Date.now() - 1000).toISOString();
    const expired = await api('GET', '/api/_sa/v1/health', {
      headers: { authorization: `Bearer ${minted.json.token}` },
    });
    assert.equal(expired.status, 404);
    const listed = await api('GET', '/api/_sa/v1/keys', { jar: admin, headers: saHeaders() });
    const view = listed.json.keys.find((item) => item.id === minted.json.key.id);
    assert.equal(view.status, 'expired');

    const blockedNet = await api('POST', '/api/_sa/v1/keys', {
      jar: admin,
      headers: saHeaders(),
      body: { name: 'remote', scopes: ['read:health'], expiresIn: '1h', ipAllowlist: ['10.0.0.0/8'] },
    });
    assert.equal(blockedNet.status, 201, blockedNet.text);
    const deniedIp = await api('GET', '/api/_sa/v1/health', {
      headers: { authorization: `Bearer ${blockedNet.json.token}` },
    });
    assert.equal(deniedIp.status, 404);

    const local = await api('POST', '/api/_sa/v1/keys', {
      jar: admin,
      headers: saHeaders(),
      body: {
        name: 'local',
        scopes: ['read:health'],
        expiresIn: '1h',
        ipAllowlist: ['127.0.0.0/8'],
        rateLimit: { limit: 1, windowSeconds: 60 },
      },
    });
    assert.equal(local.status, 201, local.text);
    const first = await api('GET', '/api/_sa/v1/health', {
      headers: { authorization: `Bearer ${local.json.token}` },
    });
    assert.equal(first.status, 200, first.text);
    const second = await api('GET', '/api/_sa/v1/health', {
      headers: { authorization: `Bearer ${local.json.token}` },
    });
    assert.equal(second.status, 429);
    assert.equal(second.json.code, 'RATE_LIMIT');
  });

  test('scope enforcement: write does not imply read', async () => {
    const reader = await api('POST', '/api/_sa/v1/keys', {
      jar: admin,
      headers: saHeaders(),
      body: { name: 'reader', scopes: ['read:health'], expiresIn: '24h' },
    });
    const writer = await api('POST', '/api/_sa/v1/keys', {
      jar: admin,
      headers: saHeaders(),
      body: { name: 'writer', scopes: ['write:config'], expiresIn: '24h' },
    });
    const readHeaders = { authorization: `Bearer ${reader.json.token}` };
    const writeHeaders = { authorization: `Bearer ${writer.json.token}` };
    assert.equal((await api('GET', '/api/_sa/v1/health', { headers: readHeaders })).status, 200);
    assert.equal((await api('GET', '/api/_sa/v1/config', { headers: readHeaders })).status, 404);
    assert.equal((await api('POST', '/api/_sa/v1/config', { headers: readHeaders, body: { logLevel: 'warn' } })).status, 404);
    assert.equal((await api('GET', '/api/_sa/v1/config', { headers: writeHeaders })).status, 404);
    const wrote = await api('POST', '/api/_sa/v1/config?dryRun=1', {
      headers: writeHeaders,
      body: { logLevel: 'debug' },
    });
    assert.equal(wrote.status, 200, wrote.text);
    assert.equal(wrote.json.dryRun, true);
    assert.equal(wrote.json.applied, false);
    const reserved = await api('POST', '/api/_sa/v1/keys', {
      jar: admin,
      headers: saHeaders(),
      body: { name: 'bad', scopes: ['write:l1'], expiresIn: '1h' },
    });
    assert.equal(reserved.status, 400, reserved.text);
    const manage = await api('POST', '/api/_sa/v1/keys', {
      headers: writeHeaders,
      body: { name: 'nope', scopes: ['read:health'] },
    });
    assert.equal(manage.status, 404);
    assert.deepEqual(manage.json, { error: 'not found', nfp: true });
  });

  test('writes are audited, dry-run does not persist, and forbidden fields are rejected', async () => {
    const beforeWindow = store.data.runtime?.feedbackRateWindowSeconds;
    const dry = await api('POST', '/api/_sa/v1/config', {
      headers: { authorization: `Bearer ${broad}` },
      body: { feedbackRateWindowSeconds: 7200, dryRun: true },
    });
    assert.equal(dry.status, 200, dry.text);
    assert.equal(dry.json.applied, false);
    assert.equal(store.data.runtime?.feedbackRateWindowSeconds, beforeWindow);
    const applied = await api('POST', '/api/_sa/v1/config', {
      headers: { authorization: `Bearer ${broad}` },
      body: { feedbackRateWindowSeconds: 7200, logLevel: 'warn', archiveEnabled: false },
    });
    assert.equal(applied.status, 200, applied.text);
    assert.equal(applied.json.config.feedbackRateWindowSeconds, 7200);
    assert.equal(store.data.runtime.feedbackRateWindowSeconds, 7200);
    const rejected = await api('POST', '/api/_sa/v1/config', {
      headers: { authorization: `Bearer ${broad}` },
      body: { relayerPrivateKey: '0xsecret' },
    });
    assert.equal(rejected.status, 400, rejected.text);
    assert.equal(rejected.text.includes('0xsecret'), false);

    const forbidden = await api('POST', '/api/_sa/v1/users/voter-one/role', {
      headers: { authorization: `Bearer ${broad}` },
      body: { role: 'observer', identityCommitment: '0xabc', choice: 'yes' },
    });
    assert.equal(forbidden.status, 400, forbidden.text);
    assert.equal(forbidden.json.code, 'FORBIDDEN_FIELD');
    assert.equal(forbidden.text.includes('0xabc'), false);
    assert.equal(store.getUserByHandle('voter-one').role, 'voter');

    const role = await api('POST', '/api/_sa/v1/users/voter-one/role', {
      headers: { authorization: `Bearer ${broad}` },
      body: { role: 'observer' },
    });
    assert.equal(role.status, 200, role.text);
    assert.equal(role.json.user.role, 'observer');
    const promote = await api('POST', '/api/_sa/v1/users/voter-one/role', {
      headers: { authorization: `Bearer ${broad}` },
      body: { role: 'platform_super_admin' },
    });
    assert.equal(promote.status, 400, promote.text);
    const demote = await api('POST', '/api/_sa/v1/users/admin/role', {
      headers: { authorization: `Bearer ${broad}` },
      body: { role: 'voter' },
    });
    assert.equal(demote.status, 400, demote.text);
    const suspendAdmin = await api('POST', '/api/_sa/v1/users/admin/suspend', {
      headers: { authorization: `Bearer ${broad}` },
      body: {},
    });
    assert.equal(suspendAdmin.status, 400, suspendAdmin.text);

    const voter = store.getUserByHandle('voter-one');
    voter.termsNotifiedHash = 'abc123';
    const termsDry = await api('POST', '/api/_sa/v1/mail/resend-terms?dryRun=1', {
      headers: { authorization: `Bearer ${broad}` },
      body: { handle: 'voter-one' },
    });
    assert.equal(termsDry.status, 200, termsDry.text);
    assert.equal(voter.termsNotifiedHash, 'abc123');
    const terms = await api('POST', '/api/_sa/v1/mail/resend-terms', {
      headers: { authorization: `Bearer ${broad}` },
      body: { handle: 'voter-one' },
    });
    assert.equal(terms.status, 200, terms.text);
    assert.equal(voter.termsNotifiedHash, null);
    assert.equal(terms.text.includes(ADMIN_EMAIL), false);

    const beforeSend = mailer.sendCount;
    const mailed = await api('POST', '/api/_sa/v1/mail/test', {
      headers: { authorization: `Bearer ${broad}` },
      body: {},
    });
    assert.equal(mailed.status, 200, mailed.text);
    assert.equal(mailed.json.toHint, 'r***@example.gov');
    assert.equal(mailed.text.includes(ADMIN_EMAIL), false);
    assert.equal(mailer.sendCount, beforeSend + 1);
    const mailDry = await api('POST', '/api/_sa/v1/mail/test?dryRun=1', {
      headers: { authorization: `Bearer ${broad}` },
      body: { to: 'other@example.gov' },
    });
    assert.equal(mailDry.status, 400, mailDry.text);

    const suspended = await api('POST', '/api/_sa/v1/users/voter-one/suspend', {
      headers: { authorization: `Bearer ${broad}` },
      body: {},
    });
    assert.equal(suspended.status, 200, suspended.text);
    assert.equal(suspended.json.user.status, 'suspended');
    const relog = await api('POST', '/api/auth/dev-login', { body: { handle: 'voter-one' } });
    assert.equal(relog.status, 403, relog.text);
    await api('POST', '/api/_sa/v1/users/voter-one/unsuspend', {
      headers: { authorization: `Bearer ${broad}` },
      body: {},
    });

    const jar = {};
    await api('POST', '/api/auth/dev-login', { jar, body: { handle: 'voter-one' } });
    assert.ok(jar['republic.sid']);
    const dropped = await api('POST', '/api/_sa/v1/users/voter-one/sessions/revoke', {
      headers: { authorization: `Bearer ${broad}` },
      body: {},
    });
    assert.equal(dropped.status, 200, dropped.text);
    assert.ok(dropped.json.revokedSessions >= 1);
    const me = await api('GET', '/api/me', { jar });
    assert.equal(me.json.user, null);

    const now = Math.floor(Date.now() / 1000);
    const election = await api('POST', '/api/elections', {
      jar: admin,
      body: {
        title: 'Meta only',
        startTime: now - 60,
        cutoffTime: now + 3600,
        jurisdictionId: 'demo',
        questions: [{ type: 'YES_NO', prompt: 'Adopt the measure?' }],
      },
    });
    assert.equal(election.status, 201, election.text);
    const electionId = election.json.election.id;
    const extendDry = await api('POST', `/api/_sa/v1/elections/${electionId}/lifecycle?dryRun=1`, {
      headers: { authorization: `Bearer ${broad}` },
      body: { action: 'extend', cutoffTime: now + 7200 },
    });
    assert.equal(extendDry.status, 200, extendDry.text);
    assert.equal(store.getElection(electionId).cutoffTime, now + 3600);
    const extend = await api('POST', `/api/_sa/v1/elections/${electionId}/lifecycle`, {
      headers: { authorization: `Bearer ${broad}` },
      body: { action: 'extend', cutoffTime: now + 7200 },
    });
    assert.equal(extend.status, 200, extend.text);
    assert.equal(store.getElection(electionId).cutoffTime, now + 7200);
    const pause = await api('POST', `/api/_sa/v1/elections/${electionId}/lifecycle`, {
      headers: { authorization: `Bearer ${broad}` },
      body: { action: 'pause' },
    });
    assert.equal(pause.status, 200, pause.text);
    const vote = await api('POST', `/api/elections/${electionId}/vote`, { body: {} });
    assert.equal(vote.status, 409, vote.text);
    assert.equal(vote.json.code, 'ELECTION_PAUSED');
    await api('POST', `/api/_sa/v1/elections/${electionId}/lifecycle`, {
      headers: { authorization: `Bearer ${broad}` },
      body: { action: 'resume' },
    });

    const beat = await api('POST', '/api/_sa/v1/l2/heartbeat?dryRun=1', {
      headers: { authorization: `Bearer ${broad}` },
      body: {},
    });
    assert.equal(beat.status, 200, beat.text);
    assert.equal(beat.json.chainSealed, false);
    const verify = await api('POST', '/api/_sa/v1/l2/verify', {
      headers: { authorization: `Bearer ${broad}` },
      body: {},
    });
    assert.equal(verify.status, 200, verify.text);
    assert.equal(verify.json.chainSealed, undefined);
    const archive = await api('POST', '/api/_sa/v1/l2/archive', {
      headers: { authorization: `Bearer ${broad}` },
      body: {},
    });
    assert.equal(archive.status, 200, archive.text);
    assert.equal(archive.json.chainSealed, false);
    assert.equal(archive.text.includes('SECRET'), false);

    recordLog('warn', `marker-sa zksa_${'cd'.repeat(8)}_abcdefghijklmnopqrstuvwxyz0123456789 ${ADMIN_EMAIL}`);
    const logs = await api('GET', '/api/_sa/v1/logs', { headers: { authorization: `Bearer ${broad}` } });
    assert.equal(logs.status, 200, logs.text);
    assert.match(logs.text, /marker-sa/);
    assert.equal(logs.text.includes('zksa_cd'), false);
    assert.equal(logs.text.includes(ADMIN_EMAIL), false);
    const level = await api('POST', '/api/_sa/v1/logs/level', {
      headers: { authorization: `Bearer ${broad}` },
      body: { level: 'error' },
    });
    assert.equal(level.status, 200, level.text);
    assert.equal(level.json.logLevel, 'error');
  });

  test('every read response passes the forbidden-field and redaction scanners', async () => {
    const ctx = { superAdminEmail: ADMIN_EMAIL, pepper: PEPPER };
    const paths = READS.slice();
    const electionId = store.data.elections[0]?.id;
    if (electionId) paths.push(`/api/_sa/v1/elections/${electionId}`);
    paths.push('/api/_sa/v1/users/admin');
    for (const url of paths) {
      const res = await api('GET', url, { headers: { authorization: `Bearer ${broad}` } });
      assert.equal(res.status, 200, `${url} ${res.text}`);
      const names = [];
      walkKeys(res.json, (key) => names.push(String(key).toLowerCase()));
      for (const banned of FORBIDDEN_FIELD_NAMES) {
        assert.equal(names.includes(banned), false, `${url} field ${banned}`);
      }
      assert.deepEqual(redactionProblems(res.json, ctx), [], url);
      assert.equal(res.text.includes(ADMIN_EMAIL), false, url);
      assert.equal(res.text.includes(PEPPER), false, url);
      assert.equal(res.text.includes(broad), false, url);
    }
    const openapi = await api('GET', '/api/openapi.json');
    assert.equal(openapi.text.includes('/api/_sa'), false);
    assert.equal(openapi.text.includes('zksa_'), false);
  });

  test('audit records success and failure and verifies until tampered', async () => {
    const page = await api('GET', '/api/_sa/v1/audit?limit=200', {
      headers: { authorization: `Bearer ${broad}` },
    });
    assert.equal(page.status, 200, page.text);
    assert.ok(page.json.entries.some((row) => row.result === 404 && row.reason === 'no_session'));
    assert.ok(page.json.entries.some((row) => row.result === 200 && row.scope === 'write:config' && row.before));
    assert.equal(page.text.includes(broad), false);
    const verified = await api('GET', '/api/_sa/v1/audit/verify', {
      headers: { authorization: `Bearer ${broad}` },
    });
    assert.equal(verified.status, 200, verified.text);
    assert.equal(verified.json.ok, true);
    const victim = store.data.superAdminAudit[0];
    const original = victim.path;
    victim.path = '/tampered';
    const bad = await api('GET', '/api/_sa/v1/audit/verify', {
      headers: { authorization: `Bearer ${broad}` },
    });
    assert.equal(bad.json.ok, false);
    assert.equal(bad.json.reason, 'hash_mismatch');
    victim.path = original;
  });
});

describe('super-admin standby writer', { concurrency: false }, () => {
  let dir;
  let active;
  let standby;
  let activeServer;
  let standbyServer;
  let activeApi;
  let standbyApi;

  after(async () => {
    if (activeServer) await new Promise((resolve) => activeServer.close(() => resolve()));
    if (standbyServer) await new Promise((resolve) => standbyServer.close(() => resolve()));
    try {
      active?.writer?.release();
    } catch {
      /* already released */
    }
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test('standby serves a keyed read, does not write, and still 404s auth failures', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'republic-sa-lease-'));
    active = await createApp({
      dataDir: dir,
      allowDevLogin: true,
      quiet: true,
      port: 0,
      writerLease: true,
      leaseOwnerId: 'active-holder',
      leaseTtlMs: 120_000,
      superAdminApiPepper: PEPPER,
      superAdminEmail: ADMIN_EMAIL,
    });
    assert.equal(active.writer.acceptingWrites(), true, 'active writer should hold the lease');
    standby = await createApp({
      dataDir: dir,
      allowDevLogin: true,
      quiet: true,
      port: 0,
      writerLease: true,
      leaseOwnerId: 'standby-holder',
      leaseTtlMs: 120_000,
      superAdminApiPepper: PEPPER,
    });
    assert.equal(standby.writer.acceptingWrites(), false);
    activeServer = await listen(active.app);
    standbyServer = await listen(standby.app);
    activeApi = client(`http://127.0.0.1:${activeServer.address().port}`);
    standbyApi = client(`http://127.0.0.1:${standbyServer.address().port}`);
    const jar = {};
    const login = await activeApi('POST', '/api/auth/dev-login', { jar, body: { handle: 'admin' } });
    assert.equal(login.status, 200, login.text);
    const session = await activeApi('GET', '/api/_sa/v1/session', { jar });
    assert.equal(session.status, 200, session.text);
    const minted = await activeApi('POST', '/api/_sa/v1/keys', {
      jar,
      headers: { 'x-csrf-token': session.json.csrfToken },
      body: { name: 'standby', scopes: ['read:health', 'write:config'], expiresIn: '1h' },
    });
    assert.equal(minted.status, 201, minted.text);
    const token = minted.json.token;
    const before = JSON.parse(await readFile(path.join(dir, 'republic.json'), 'utf8'));
    const auditBefore = (before.superAdminAudit || []).length;
    const health = await standbyApi('GET', '/api/_sa/v1/health', {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(health.status, 200, health.text);
    assert.equal(health.json.mode, 'standby');
    const write = await standbyApi('POST', '/api/_sa/v1/config', {
      headers: { authorization: `Bearer ${token}` },
      body: { logLevel: 'debug' },
    });
    assert.equal(write.status, 503, write.text);
    assert.equal(write.json.code, 'STANDBY');
    const missing = await standbyApi('POST', '/api/_sa/v1/config', { body: { logLevel: 'debug' } });
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.json, { error: 'not found', nfp: true });
    const afterRead = JSON.parse(await readFile(path.join(dir, 'republic.json'), 'utf8'));
    assert.equal((afterRead.superAdminAudit || []).length, auditBefore);
    const keyRow = afterRead.superAdminKeys.find((row) => row.id === minted.json.key.id);
    assert.equal(keyRow.lastUsedAt, null);
    await activeApi('POST', `/api/_sa/v1/keys/${minted.json.key.id}/revoke`, {
      jar,
      headers: { 'x-csrf-token': session.json.csrfToken },
      body: {},
    });
    const revoked = await standbyApi('GET', '/api/_sa/v1/health', {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(revoked.status, 404);
    assert.deepEqual(revoked.json, { error: 'not found', nfp: true });
  });
});

// NOT FOR PROFIT — civic public good, not a commercial product.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { createApp } from '../src/server.mjs';
import { BOT_DOC_BANNED, renderBotGuideMarkdown, renderRepoLlmsTxt } from '../src/botApiCatalog.mjs';
import { renderApiKeyCreatedEmail } from '../src/apiKeyMail.mjs';

let tmp;
let app;
let store;
let mailer;
let server;
let base;
const voterJar = {};
const adminJar = {};

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
      ...headers,
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

describe('personal API keys', () => {
  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'republic-api-keys-'));
    const created = await createApp({
      dataDir: tmp,
      allowDevLogin: true,
      adminHandle: 'admin',
      quiet: true,
      port: 0,
      disclosureIntervalSeconds: 0,
      publicBaseUrl: 'http://vote.test',
    });
    app = created.app;
    store = created.store;
    mailer = created.mailer;
    server = await listen(app);
    base = `http://127.0.0.1:${server.address().port}`;
    const voter = await api('POST', '/api/auth/dev-login', {
      jar: voterJar,
      body: { handle: 'ada', role: 'voter' },
    });
    assert.equal(voter.status, 200);
    const email = await api('PATCH', '/api/me/contact-email', {
      jar: voterJar,
      body: { contactEmail: 'ada@example.com' },
    });
    assert.equal(email.status, 200);
    const admin = await api('POST', '/api/auth/dev-login', {
      jar: adminJar,
      body: { handle: 'clerk-admin', role: 'platform_admin' },
    });
    assert.equal(admin.status, 200);
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await rm(tmp, { recursive: true, force: true });
  });

  test('a key is returned once, emailed without the secret, and cannot be fetched again', async () => {
    const before = mailer.sent.length;
    const created = await api('POST', '/api/me/api-keys', {
      jar: voterJar,
      body: { name: 'grok', level: 'read' },
    });
    assert.equal(created.status, 201);
    assert.equal(created.json.secretShownOnce, true);
    assert.match(created.json.secret, /^rk_[A-Za-z0-9_-]{40,}$/);
    assert.equal(created.json.apiKey.level, 'read');
    assert.equal(created.json.apiKey.expiresIn, '30d');
    assert.ok(created.json.apiKey.expiresAt);
    assert.equal(created.json.apiKey.secret, undefined);
    assert.equal(created.json.apiKey.secretHash, undefined);
    const secret = created.json.secret;

    const listed = await api('GET', '/api/me/api-keys', { jar: voterJar });
    assert.equal(listed.status, 200);
    assert.equal(listed.json.apiKeys.length, 1);
    assert.doesNotMatch(listed.text, new RegExp(secret));
    assert.equal(listed.json.apiKeys[0].prefix, secret.slice(0, 12));
    assert.equal(listed.json.apiKeys[0].secret, undefined);

    const disk = await readFile(path.join(tmp, 'republic.json'), 'utf8');
    assert.doesNotMatch(disk, new RegExp(secret));
    assert.match(disk, /secretHash/);

    const notice = mailer.sent.slice(before).find((row) => row.meta?.purpose === 'api-key-created');
    assert.ok(notice);
    assert.equal(notice.to, 'ada@example.com');
    assert.match(notice.subject, /API key was created/);
    assert.match(notice.text, /contact support as soon as possible/i);
    assert.match(notice.text, /cannot be shown again/i);
    assert.match(notice.html, /api_key|cannot be shown again|Contact support/);
    assert.doesNotMatch(notice.text, new RegExp(secret));
    assert.doesNotMatch(notice.html, new RegExp(secret));
    assert.doesNotMatch(notice.text, /rk_/);
    assert.doesNotMatch(notice.html, /rk_/);

    const again = await api('GET', '/api/me/api-keys', { jar: voterJar });
    assert.doesNotMatch(again.text, new RegExp(secret));
    const me = await api('GET', '/api/me', { jar: voterJar });
    assert.doesNotMatch(me.text, new RegExp(secret));
  });

  test('many keys can use different levels and expirations, including never', async () => {
    for (const [level, expiresIn] of [
      ['voter', '7d'],
      ['officer', 'never'],
      ['read', '365d'],
    ]) {
      const created = await api('POST', '/api/me/api-keys', {
        jar: voterJar,
        body: { name: `${level}-${expiresIn}`, level, expiresIn },
      });
      assert.equal(created.status, 201, created.text);
      assert.equal(created.json.apiKey.level, level);
      assert.equal(created.json.apiKey.expiresIn, expiresIn);
      assert.equal(created.json.apiKey.expiresAt, expiresIn === 'never' ? null : created.json.apiKey.expiresAt);
    }
    const bad = await api('POST', '/api/me/api-keys', {
      jar: voterJar,
      body: { name: 'nope', expiresIn: '2d', level: 'root' },
    });
    assert.equal(bad.status, 400);
  });

  test('read-only cannot write, voter can, and a key cannot mint another key', async () => {
    const read = await api('POST', '/api/me/api-keys', {
      jar: voterJar,
      body: { name: 'reads', level: 'read', expiresIn: '7d' },
    });
    const voter = await api('POST', '/api/me/api-keys', {
      jar: voterJar,
      body: { name: 'acts', level: 'voter', expiresIn: '90d' },
    });
    const readHeaders = { authorization: `Bearer ${read.json.secret}` };
    const voterHeaders = { authorization: `Bearer ${voter.json.secret}` };

    const me = await api('GET', '/api/me', { headers: readHeaders });
    assert.equal(me.status, 200);
    assert.equal(me.json.user.handle, 'ada');

    const denied = await api('PATCH', '/api/me/contact-email', {
      headers: readHeaders,
      body: { contactEmail: 'ada@example.com' },
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.json.code, 'API_KEY_SCOPE');

    const allowed = await api('PATCH', '/api/me/contact-email', {
      headers: voterHeaders,
      body: { contactEmail: 'ada@example.com' },
    });
    assert.equal(allowed.status, 200);

    const minted = await api('POST', '/api/me/api-keys', {
      headers: voterHeaders,
      body: { name: 'child', level: 'officer', expiresIn: 'never' },
    });
    assert.equal(minted.status, 403);

    const headerKey = await api('GET', '/api/config', { headers: { 'x-api-key': read.json.secret } });
    assert.equal(headerKey.status, 200);
  });

  test('revoke and expiry reject the secret, which is still not stored', async () => {
    const created = await api('POST', '/api/me/api-keys', {
      jar: voterJar,
      body: { name: 'temporary', level: 'read', expiresIn: '180d' },
    });
    const secret = created.json.secret;
    const revoked = await api('DELETE', `/api/me/api-keys/${created.json.apiKey.id}`, { jar: voterJar });
    assert.equal(revoked.status, 200);
    assert.ok(revoked.json.apiKey.revokedAt);
    const after = await api('GET', '/api/me', { headers: { authorization: `Bearer ${secret}` } });
    assert.equal(after.status, 401);
    assert.equal(after.json.code, 'API_KEY_REVOKED');

    const expiring = await api('POST', '/api/me/api-keys', {
      jar: voterJar,
      body: { name: 'old', level: 'read', expiresIn: '7d' },
    });
    const row = store.data.apiKeys.find((item) => item.id === expiring.json.apiKey.id);
    row.expiresAt = new Date(Date.now() - 1000).toISOString();
    const expired = await api('GET', '/api/elections', {
      headers: { authorization: `Bearer ${expiring.json.secret}` },
    });
    assert.equal(expired.status, 401);
    assert.equal(expired.json.code, 'API_KEY_EXPIRED');
  });

  test('an officer key follows the account and cannot call omitted host routes', async () => {
    const officer = await api('POST', '/api/me/api-keys', {
      jar: adminJar,
      body: { name: 'desk', level: 'officer', expiresIn: '30d' },
    });
    assert.equal(officer.status, 201);
    const headers = { authorization: `Bearer ${officer.json.secret}` };
    const jurisdiction = await api('POST', '/api/jurisdictions', {
      headers,
      body: { id: 'north', name: 'North' },
    });
    assert.equal(jurisdiction.status, 201, jurisdiction.text);

    const voterKey = await api('POST', '/api/me/api-keys', {
      jar: adminJar,
      body: { name: 'look', level: 'voter', expiresIn: '30d' },
    });
    const blocked = await api('POST', '/api/jurisdictions', {
      headers: { authorization: `Bearer ${voterKey.json.secret}` },
      body: { id: 'south', name: 'South' },
    });
    assert.equal(blocked.status, 403);

    const host = await api('POST', '/api/admin/admins', {
      headers,
      body: { handle: 'ada' },
    });
    assert.equal(host.status, 403);
    assert.equal(host.json.code, 'API_KEY_SCOPE');
    assert.doesNotMatch(host.text, /platform_super_admin/);
  });

  test('public /api docs omit host-only administration and describe the key lifecycle', async () => {
    const page = await api('GET', '/api', { headers: { accept: 'text/html' } });
    assert.equal(page.status, 200);
    assert.match(page.res.headers.get('content-type') || '', /html/);
    assert.match(page.text, /NOT FOR PROFIT/);
    assert.match(page.text, /7d/);
    assert.match(page.text, /30d/);
    assert.match(page.text, /90d/);
    assert.match(page.text, /180d/);
    assert.match(page.text, /365d/);
    assert.match(page.text, /never/);
    assert.match(page.text, /Read-only/);
    assert.match(page.text, /shown once/i);
    assert.match(page.text, /does not include the key/i);
    assert.doesNotMatch(page.text, BOT_DOC_BANNED);

    const spec = await api('GET', '/api/openapi.json');
    assert.equal(spec.status, 200);
    assert.ok(spec.json.paths['/api/me/api-keys']);
    assert.equal(spec.json.paths['/api/admin/admins'], undefined);
    assert.doesNotMatch(spec.text, BOT_DOC_BANNED);

    const llms = await api('GET', '/api/llms.txt');
    assert.equal(llms.status, 200);
    assert.match(llms.text, /api_key\.created/);
    assert.doesNotMatch(llms.text, BOT_DOC_BANNED);

    const discovery = await api('GET', '/api?format=json', { headers: { accept: 'application/json' } });
    assert.equal(discovery.status, 200);
    assert.equal(discovery.json.defaultExpiration, '30d');
    assert.doesNotMatch(discovery.text, BOT_DOC_BANNED);

    const root = path.resolve(import.meta.dirname, '../../..');
    const guide = await readFile(path.join(root, 'docs/BOT_API.md'), 'utf8');
    const index = await readFile(path.join(root, 'llms.txt'), 'utf8');
    assert.equal(guide, renderBotGuideMarkdown());
    assert.equal(index, renderRepoLlmsTxt());
    assert.doesNotMatch(guide, BOT_DOC_BANNED);
    assert.doesNotMatch(index, BOT_DOC_BANNED);
  });

  test('the mail template redacts a key pasted into the name', () => {
    const secret = `rk_${'a'.repeat(40)}`;
    const rendered = renderApiKeyCreatedEmail({
      handle: 'ada',
      keyName: secret,
      level: 'read',
      expiryLabel: '30d',
      createdAt: '2026-01-01T00:00:00.000Z',
      profileUrl: 'http://vote.test/me',
      supportUrl: 'http://vote.test/feedback',
    });
    assert.equal(rendered.templateId, 'api_key.created');
    assert.doesNotMatch(rendered.text, new RegExp(secret));
    assert.doesNotMatch(rendered.html, new RegExp(secret));
    assert.doesNotMatch(rendered.notificationBody, new RegExp(secret));
    assert.match(rendered.text, /\[redacted\]/);
    assert.match(rendered.text, /contact support as soon as possible/i);
  });
});

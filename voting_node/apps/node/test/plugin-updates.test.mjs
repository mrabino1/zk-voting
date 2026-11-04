// NOT FOR PROFIT — civic public good, not a commercial product.
// Plugin update feeds: check, manual update, automatic update, signature,
// minAppVersion, rollback and the repo-bundled notice.

import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { createApp } from '../src/server.mjs';
import { writeZip } from '../src/plugins/zip.mjs';

const CLIENT = 'export function register(h){ h.slot("footer", (el) => { el.textContent = "ok"; }); }\n';
const SERVER_OK = 'export function register() {}\n';
const SERVER_BAD = 'export function register() { throw new Error("boom"); }\n';

let tmp;
let bundled;
let feedServer;
let origin;
let server;
let base;
let store;
const jars = {};
/** @type {Map<string, { body: Buffer, type: string }>} */
const files = new Map();

function applyCookies(res, jar) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const c of list) {
    const pair = c.split(';')[0];
    const i = pair.indexOf('=');
    if (i !== -1) jar.cookies[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
}

async function api(method, url, { body, jar, raw, headers = {}, csrf = true } = {}) {
  const h = { ...headers };
  if (jar) h.cookie = Object.entries(jar.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  if (jar?.csrf && csrf && method !== 'GET') h['x-csrf-token'] = jar.csrf;
  let payload;
  if (raw !== undefined) {
    payload = raw;
    h['content-type'] ||= 'application/zip';
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    h['content-type'] = 'application/json';
  }
  const res = await fetch(base + url, { method, headers: h, body: payload, redirect: 'manual' });
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

async function login(name, handle, role) {
  const jar = { cookies: {}, csrf: null };
  const r = await api('POST', '/api/auth/dev-login', { body: role ? { handle, role } : { handle }, jar });
  assert.equal(r.status, 200, r.json?.error);
  jar.user = r.json.user;
  const me = await api('GET', '/api/site-admin/me', { jar });
  assert.equal(me.status, 200, me.json?.error);
  jar.csrf = me.json.csrfToken;
  jars[name] = jar;
  return jar;
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

function pluginZip(name, manifest, extra = {}) {
  return writeZip([
    { name: `${name}/plugin.json`, data: Buffer.from(JSON.stringify(manifest)) },
    ...Object.entries(extra).map(([file, data]) => ({ name: `${name}/${file}`, data: Buffer.from(data) })),
  ]);
}

function manifest(name, version, extra = {}) {
  return {
    name,
    version,
    author: 'Test',
    license: 'MIT',
    type: 'ui',
    permissions: ['client'],
    entrypoints: { client: 'client.mjs' },
    slots: ['footer'],
    description: `${name} fixture`,
    ...extra,
  };
}

async function writePluginDir(root, man, extra = {}) {
  const dir = path.join(root, man.name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'plugin.json'), JSON.stringify(man));
  for (const [file, data] of Object.entries(extra)) {
    const target = path.join(dir, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
  }
}

function publish(name, man, extra = {}, { privateKey = null } = {}) {
  const zip = pluginZip(name, man, extra);
  const signature = privateKey ? sign(null, zip, privateKey).toString('hex') : undefined;
  files.set(`/pkg/${name}.zip`, { body: zip, type: 'application/zip' });
  files.set(`/feed/${name}`, {
    body: Buffer.from(JSON.stringify({
      version: man.version,
      packageUrl: `${origin}/pkg/${name}.zip`,
      sha256: sha(zip),
      minAppVersion: man.minAppVersion || '0.0.0',
      changelog: man.changelog || `Changes in ${man.version}`,
      ...(signature ? { signature } : {}),
    })),
    type: 'application/json',
  });
  return zip;
}

async function upload(name, man, extra = {}) {
  const zip = pluginZip(name, man, extra);
  const r = await api('POST', '/api/site-admin/plugins/upload', {
    jar: jars.super,
    raw: zip,
    headers: { 'x-plugin-sha256': sha(zip) },
  });
  assert.equal(r.status, 201, r.json?.error);
  return r.json.plugin;
}

async function plugin(name) {
  const r = await api('GET', '/api/site-admin/plugins', { jar: jars.super });
  assert.equal(r.status, 200, r.json?.error);
  return r.json.plugins.find((p) => p.name === name);
}

async function auditReasons(action) {
  const r = await api('GET', `/api/site-admin/audit?area=plugins&action=${encodeURIComponent(action)}&limit=50`, { jar: jars.super });
  assert.equal(r.status, 200, r.text);
  return r.json.entries.map((e) => e.reason);
}

describe('plugin updates', () => {
  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'zkv-plugin-update-'));
    bundled = path.join(tmp, 'bundled');
    await mkdir(bundled, { recursive: true });
    feedServer = createServer((req, res) => {
      const hit = files.get(String(req.url || '').split('?')[0]);
      if (!hit) {
        res.statusCode = 404;
        res.end('missing');
        return;
      }
      res.setHeader('content-type', hit.type);
      res.end(hit.body);
    });
    await new Promise((resolve) => feedServer.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${feedServer.address().port}`;

    const plain = manifest('repo-plain', '1.0.0');
    const sourced = manifest('repo-sourced', '1.0.0', { updateUrl: `${origin}/feed/repo-sourced` });
    await writePluginDir(bundled, plain, { 'client.mjs': CLIENT });
    await writePluginDir(bundled, sourced, { 'client.mjs': CLIENT });
    publish('repo-sourced', sourced, { 'client.mjs': CLIENT });

    const created = await createApp({
      dataDir: tmp,
      allowDevLogin: true,
      adminHandle: 'admin',
      quiet: true,
      port: 0,
      pluginsAllowUpload: true,
      pluginUpdateIntervalMs: 0,
      pluginsBundledDir: bundled,
      layoutFile: path.join(tmp, 'no-layout.json'),
      layoutOverrideModule: path.join(tmp, 'no-override.mjs'),
    });
    store = created.store;
    server = await new Promise((resolve, reject) => {
      const s = created.app.listen(0, '127.0.0.1', () => resolve(s));
      s.on('error', reject);
    });
    base = `http://127.0.0.1:${server.address().port}`;
    await login('super', 'admin');
    await login('alice', 'alice', 'voter');
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => feedServer.close(resolve));
    await rm(tmp, { recursive: true, force: true });
  });

  test('bundled plugins without a source are notice-only and are not checked', async () => {
    const listed = await api('GET', '/api/site-admin/plugins', { jar: jars.super });
    assert.equal(listed.json.updateCheckIntervalMs, 0);
    assert.equal(listed.json.updateCheckActive, false);
    const plain = listed.json.plugins.find((p) => p.name === 'repo-plain');
    const sourced = listed.json.plugins.find((p) => p.name === 'repo-sourced');
    assert.equal(plain.updateMode, 'notice');
    assert.equal(plain.canUpdate, false);
    assert.equal(plain.autoUpdate, false);
    assert.equal(plain.updateAvailable, null);
    assert.equal(sourced.updateMode, 'source');
    assert.equal(sourced.autoUpdate, false);
    const denied = await api('POST', '/api/site-admin/plugins/repo-plain/update', { jar: jars.super, body: {} });
    assert.equal(denied.status, 400);
    assert.equal(denied.json.code, 'PLUGIN_REPO_NOTICE_ONLY');
    const auto = await api('POST', '/api/site-admin/plugins/repo-plain/auto-update', { jar: jars.super, body: { enabled: true } });
    assert.equal(auto.status, 400);
    assert.equal(auto.json.code, 'PLUGIN_REPO_NOTICE_ONLY');
    const voter = await api('POST', '/api/site-admin/plugins/check-updates', { jar: jars.alice, body: {} });
    assert.equal(voter.status, 403);
    const check = await api('POST', '/api/site-admin/plugins/check-updates', { jar: jars.super, body: {} });
    assert.equal(check.status, 200, check.json?.error);
    assert.equal(check.json.checked, 1);
    assert.deepEqual(check.json.updates, []);
    assert.equal((await plugin('repo-sourced')).updateAvailable, null);
  });

  test('a newer feed shows version, changelog and an audit entry; an older feed does not', async () => {
    const man = manifest('repo-sourced', '1.2.0', {
      updateUrl: `${origin}/feed/repo-sourced`,
      changelog: 'Banner contrast',
    });
    publish('repo-sourced', man, { 'client.mjs': CLIENT });
    const check = await api('POST', '/api/site-admin/plugins/check-updates', { jar: jars.super, body: {} });
    assert.equal(check.status, 200, check.json?.error);
    const row = check.json.updates.find((u) => u.name === 'repo-sourced');
    assert.equal(row.to, '1.2.0');
    assert.equal(row.applied, false);
    const found = await plugin('repo-sourced');
    assert.equal(found.version, '1.0.0');
    assert.equal(found.updateAvailable.version, '1.2.0');
    assert.equal(found.updateAvailable.changelog, 'Banner contrast');
    assert.equal(found.updateAvailable.compatible, true);
    assert.equal(found.autoUpdate, false);
    const me = await api('GET', '/api/site-admin/me', { jar: jars.super });
    assert.equal(me.json.pluginUpdateCount, 1);
    assert.ok((await auditReasons('plugin.update_available')).includes('plugin.update_available'));

    publish('repo-sourced', manifest('repo-sourced', '0.9.0', { updateUrl: `${origin}/feed/repo-sourced` }), { 'client.mjs': CLIENT });
    const older = await api('POST', '/api/site-admin/plugins/check-updates', { jar: jars.super, body: {} });
    assert.equal(older.status, 200, older.json?.error);
    assert.equal((await plugin('repo-sourced')).updateAvailable, null);
  });

  test('manual update replaces a bundled plugin when a source is set and records plugin.updated', async () => {
    const man = manifest('repo-sourced', '1.2.0', {
      updateUrl: `${origin}/feed/repo-sourced`,
      changelog: 'Banner contrast',
    });
    publish('repo-sourced', man, { 'client.mjs': CLIENT });
    await api('POST', '/api/site-admin/plugins/check-updates', { jar: jars.super, body: {} });
    const up = await api('POST', '/api/site-admin/plugins/repo-sourced/update', {
      jar: jars.super,
      body: { version: '1.2.0' },
    });
    assert.equal(up.status, 200, up.json?.error);
    assert.equal(up.json.applied, true);
    assert.equal(up.json.plugin.version, '1.2.0');
    assert.equal(up.json.plugin.updateAvailable, null);
    const onDisk = JSON.parse(await readFile(path.join(bundled, 'repo-sourced', 'plugin.json'), 'utf8'));
    assert.equal(onDisk.version, '1.2.0');
    assert.ok((await auditReasons('plugin.updated')).includes('plugin.updated'));
    const again = await api('POST', '/api/site-admin/plugins/repo-sourced/update', { jar: jars.super, body: {} });
    assert.equal(again.status, 409);
    assert.equal(again.json.code, 'PLUGIN_UP_TO_DATE');
  });

  test('sha256 mismatch and minAppVersion refusal leave the installed files in place', async () => {
    const man = manifest('repo-sourced', '1.3.0', { updateUrl: `${origin}/feed/repo-sourced` });
    const zip = publish('repo-sourced', man, { 'client.mjs': CLIENT });
    const body = JSON.parse(files.get('/feed/repo-sourced').body.toString());
    body.sha256 = sha(Buffer.from('not-the-zip'));
    files.set('/feed/repo-sourced', { body: Buffer.from(JSON.stringify(body)), type: 'application/json' });
    const bad = await api('POST', '/api/site-admin/plugins/repo-sourced/update', { jar: jars.super, body: { version: '1.3.0' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.code, 'CHECKSUM_MISMATCH');
    assert.equal((await plugin('repo-sourced')).version, '1.2.0');
    assert.ok((await auditReasons('plugin.update_failed')).includes('plugin.update_failed'));

    body.sha256 = sha(zip);
    body.minAppVersion = '99.0.0';
    files.set('/feed/repo-sourced', { body: Buffer.from(JSON.stringify(body)), type: 'application/json' });
    const check = await api('POST', '/api/site-admin/plugins/check-updates', { jar: jars.super, body: {} });
    assert.equal(check.status, 200, check.json?.error);
    const notice = (await plugin('repo-sourced')).updateAvailable;
    assert.equal(notice.version, '1.3.0');
    assert.equal(notice.compatible, false);
    const tooNew = await api('POST', '/api/site-admin/plugins/repo-sourced/update', { jar: jars.super, body: { version: '1.3.0' } });
    assert.equal(tooNew.status, 409);
    assert.equal(tooNew.json.code, 'PLUGIN_APP_TOO_OLD');
    assert.equal(JSON.parse(await readFile(path.join(bundled, 'repo-sourced', 'plugin.json'), 'utf8')).version, '1.2.0');
  });

  test('a failed start rolls back to the previous version', async () => {
    const name = 'roll-plugin';
    const v1 = {
      name,
      version: '1.0.0',
      author: 'Test',
      license: 'MIT',
      type: 'backoffice',
      permissions: [],
      entrypoints: { server: 'server/index.mjs' },
      updateUrl: `${origin}/feed/${name}`,
    };
    publish(name, v1, { 'server/index.mjs': SERVER_OK });
    await upload(name, v1, { 'server/index.mjs': SERVER_OK });
    const en = await api('POST', `/api/site-admin/plugins/${name}/enable`, { jar: jars.super, body: { acceptPermissions: [] } });
    assert.equal(en.status, 200, en.json?.error);
    assert.equal(en.json.plugin.running, true);
    const v2 = { ...v1, version: '1.1.0' };
    publish(name, v2, { 'server/index.mjs': SERVER_BAD });
    const up = await api('POST', `/api/site-admin/plugins/${name}/update`, { jar: jars.super, body: { version: '1.1.0' } });
    assert.equal(up.status, 400);
    assert.equal(up.json.code, 'PLUGIN_UPDATE_FAILED');
    const after = await plugin(name);
    assert.equal(after.version, '1.0.0');
    assert.equal(after.enabled, true);
    assert.equal(after.running, true);
    const onDisk = JSON.parse(await readFile(path.join(tmp, 'plugins', name, 'plugin.json'), 'utf8'));
    assert.equal(onDisk.version, '1.0.0');
    const serverSrc = await readFile(path.join(tmp, 'plugins', name, 'server', 'index.mjs'), 'utf8');
    assert.match(serverSrc, /register\(\) \{\}/);
    const leftovers = await readdir(path.join(tmp, 'plugins'));
    assert.equal(leftovers.some((n) => n.startsWith('.backup-') || n.startsWith('.staging-')), false);
  });

  test('updatePublicKey requires a matching ed25519 signature', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const hex = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
    const name = 'signed-plugin';
    const v1 = manifest(name, '1.0.0', { updateUrl: `${origin}/feed/${name}`, updatePublicKey: hex });
    publish(name, v1, { 'client.mjs': CLIENT }, { privateKey });
    await upload(name, v1, { 'client.mjs': CLIENT });
    const v2 = manifest(name, '1.1.0', { updateUrl: `${origin}/feed/${name}`, updatePublicKey: hex, changelog: 'Signed' });
    publish(name, v2, { 'client.mjs': CLIENT });
    const missing = await api('POST', `/api/site-admin/plugins/${name}/update`, { jar: jars.super, body: { version: '1.1.0' } });
    assert.equal(missing.status, 400);
    assert.equal(missing.json.code, 'SIGNATURE_REQUIRED');
    assert.equal((await plugin(name)).version, '1.0.0');

    const zip = pluginZip(name, v2, { 'client.mjs': CLIENT });
    const badSig = sign(null, Buffer.from('other'), privateKey).toString('hex');
    files.set(`/pkg/${name}.zip`, { body: zip, type: 'application/zip' });
    files.set(`/feed/${name}`, {
      body: Buffer.from(JSON.stringify({
        version: '1.1.0',
        packageUrl: `${origin}/pkg/${name}.zip`,
        sha256: sha(zip),
        minAppVersion: '0.0.0',
        changelog: 'Signed',
        signature: badSig,
      })),
      type: 'application/json',
    });
    const bad = await api('POST', `/api/site-admin/plugins/${name}/update`, { jar: jars.super, body: { version: '1.1.0' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.code, 'SIGNATURE_INVALID');
    assert.equal((await plugin(name)).version, '1.0.0');

    publish(name, v2, { 'client.mjs': CLIENT }, { privateKey });
    const ok = await api('POST', `/api/site-admin/plugins/${name}/update`, { jar: jars.super, body: { version: '1.1.0' } });
    assert.equal(ok.status, 200, ok.json?.error);
    assert.equal(ok.json.plugin.version, '1.1.0');
  });

  test('automatic updates stay off until enabled, then install without a permission change', async () => {
    const name = 'auto-plugin';
    const v1 = manifest(name, '1.0.0', { updateUrl: `${origin}/feed/${name}` });
    publish(name, v1, { 'client.mjs': CLIENT });
    const installed = await upload(name, v1, { 'client.mjs': CLIENT });
    assert.equal(installed.autoUpdate, false);
    const v2 = manifest(name, '1.4.0', { updateUrl: `${origin}/feed/${name}`, changelog: 'Auto' });
    publish(name, v2, { 'client.mjs': CLIENT });
    await api('POST', '/api/site-admin/plugins/check-updates', { jar: jars.super, body: {} });
    assert.equal((await plugin(name)).version, '1.0.0');
    assert.equal((await plugin(name)).updateAvailable.version, '1.4.0');
    const on = await api('POST', `/api/site-admin/plugins/${name}/auto-update`, { jar: jars.super, body: { enabled: true } });
    assert.equal(on.status, 200, on.json?.error);
    assert.equal(on.json.plugin.autoUpdate, true);
    assert.equal(on.json.applied, true);
    assert.equal(on.json.plugin.version, '1.4.0');
    assert.ok((await auditReasons('plugin.auto_update_on')).includes('plugin.auto_update_on'));
  });

  test('automatic update waits when permissions change; manual update accepts them', async () => {
    const name = 'perm-plugin';
    const v1 = manifest(name, '1.0.0', { updateUrl: `${origin}/feed/${name}` });
    publish(name, v1, { 'client.mjs': CLIENT });
    await upload(name, v1, { 'client.mjs': CLIENT });
    const en = await api('POST', `/api/site-admin/plugins/${name}/enable`, {
      jar: jars.super,
      body: { acceptPermissions: ['client'] },
    });
    assert.equal(en.status, 200, en.json?.error);
    const turned = await api('POST', `/api/site-admin/plugins/${name}/auto-update`, { jar: jars.super, body: { enabled: true } });
    assert.equal(turned.status, 200, turned.json?.error);
    const v2 = manifest(name, '2.0.0', {
      updateUrl: `${origin}/feed/${name}`,
      permissions: ['client', 'routes'],
      changelog: 'Adds a route permission',
    });
    publish(name, v2, { 'client.mjs': CLIENT });
    const check = await api('POST', '/api/site-admin/plugins/check-updates', { jar: jars.super, body: {} });
    assert.equal(check.status, 200, check.json?.error);
    const mid = await plugin(name);
    assert.equal(mid.version, '1.0.0');
    assert.equal(mid.enabled, true);
    assert.equal(mid.updateAvailable.needsReview, true);
    assert.equal(mid.updateAvailable.version, '2.0.0');
    const refused = await api('POST', `/api/site-admin/plugins/${name}/update`, { jar: jars.super, body: { version: '2.0.0' } });
    assert.equal(refused.status, 400);
    assert.equal(refused.json.code, 'PERMISSIONS_NOT_ACCEPTED');
    assert.deepEqual(refused.json.requested, ['client', 'routes']);
    assert.equal((await plugin(name)).version, '1.0.0');
    const ok = await api('POST', `/api/site-admin/plugins/${name}/update`, {
      jar: jars.super,
      body: { version: '2.0.0', acceptPermissions: ['client', 'routes'] },
    });
    assert.equal(ok.status, 200, ok.json?.error);
    assert.equal(ok.json.plugin.version, '2.0.0');
    assert.equal(ok.json.plugin.enabled, true);
    assert.deepEqual([...ok.json.plugin.grantedPermissions].sort(), ['client', 'routes']);
  });

  test('an uploaded plugin with no source is not part of the check', async () => {
    const name = 'local-only';
    await upload(name, manifest(name, '1.0.0'), { 'client.mjs': CLIENT });
    const found = await plugin(name);
    assert.equal(found.updateMode, 'none');
    assert.equal(found.canUpdate, false);
    const check = await api('POST', '/api/site-admin/plugins/check-updates', { jar: jars.super, body: {} });
    assert.equal(check.json.updates.some((u) => u.name === name), false);
    const up = await api('POST', `/api/site-admin/plugins/${name}/update`, { jar: jars.super, body: {} });
    assert.equal(up.status, 400);
    assert.equal(up.json.code, 'PLUGIN_NO_UPDATE_SOURCE');
  });

  test('update and the automatic-update toggle require a recent sign-in', async () => {
    const name = 'reauth-plugin';
    const v1 = manifest(name, '1.0.0', { updateUrl: `${origin}/feed/${name}` });
    publish(name, v1, { 'client.mjs': CLIENT });
    await upload(name, v1, { 'client.mjs': CLIENT });
    publish(name, manifest(name, '1.5.0', { updateUrl: `${origin}/feed/${name}` }), { 'client.mjs': CLIENT });
    const sessions = store.data.sessions || [];
    const saved = [];
    for (const s of sessions) {
      if (s.userId === jars.super.user.id) {
        saved.push([s, s.authenticatedAt, s.createdAt]);
        s.authenticatedAt = Date.now() - 3600_000;
        s.createdAt = s.authenticatedAt;
      }
    }
    try {
      const up = await api('POST', `/api/site-admin/plugins/${name}/update`, { jar: jars.super, body: { version: '1.5.0' } });
      assert.equal(up.status, 401);
      assert.equal(up.json.code, 'REAUTH_REQUIRED');
      const auto = await api('POST', `/api/site-admin/plugins/${name}/auto-update`, { jar: jars.super, body: { enabled: true } });
      assert.equal(auto.status, 401);
      assert.equal(auto.json.code, 'REAUTH_REQUIRED');
      assert.equal((await plugin(name)).version, '1.0.0');
      assert.equal((await plugin(name)).autoUpdate, false);
    } finally {
      for (const [s, authenticatedAt, createdAt] of saved) {
        s.authenticatedAt = authenticatedAt;
        s.createdAt = createdAt;
      }
    }
  });
});

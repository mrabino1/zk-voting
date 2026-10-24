// NOT FOR PROFIT — civic public good, not a commercial product.
// Site admin: capability-based roles, last-super-admin protection, audited
// role changes, layout + branding, and the plugin lifecycle over HTTP.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { createApp, SITE_ADMIN_CSP } from '../src/server.mjs';
import { writeZip } from '../src/plugins/zip.mjs';

let tmp;
let server;
let base;
let store;
const jars = {};

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

function pluginZip(manifest, extra = {}) {
  const files = [
    { name: 'my-plugin/plugin.json', data: Buffer.from(JSON.stringify(manifest)) },
    ...Object.entries(extra).map(([name, data]) => ({ name: `my-plugin/${name}`, data: Buffer.from(data) })),
  ];
  return writeZip(files);
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

describe('site admin: roles, layout, plugins', () => {
  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'zkv-site-admin-'));
    const created = await createApp({
      dataDir: tmp,
      allowDevLogin: true,
      adminHandle: 'admin',
      quiet: true,
      port: 0,
      pluginsAllowUpload: true,
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
    await login('bob', 'bob', 'voter');
    await login('carol', 'carol', 'voter');
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(tmp, { recursive: true, force: true });
  });

  test('anonymous and voters cannot reach site-admin APIs', async () => {
    assert.equal((await api('GET', '/api/site-admin/roles')).status, 401);
    const voter = await api('GET', '/api/site-admin/roles', { jar: jars.alice });
    assert.equal(voter.status, 403);
    assert.equal(voter.json.code, 'CAPABILITY');
    const me = await api('GET', '/api/site-admin/me', { jar: jars.alice });
    assert.deepEqual(me.json.capabilities, []);
  });

  test('super admin sees every capability and the role catalogue', async () => {
    const me = await api('GET', '/api/site-admin/me', { jar: jars.super });
    for (const cap of ['manage_roles', 'manage_plugins', 'edit_layout', 'manage_elections', 'view_audit', 'manage_admins', 'manage_branding']) {
      assert.ok(me.json.capabilities.includes(cap), cap);
    }
    const roles = await api('GET', '/api/site-admin/roles', { jar: jars.super });
    assert.equal(roles.status, 200);
    const ids = roles.json.roles.map((r) => r.id);
    for (const r of ['platform_super_admin', 'platform_admin', 'designer', 'election_manager', 'auditor', 'moderator', 'voter']) {
      assert.ok(ids.includes(r), r);
    }
  });

  test('user list never exposes emails', async () => {
    const r = await api('GET', '/api/site-admin/users?q=ali', { jar: jars.super });
    assert.equal(r.status, 200);
    assert.ok(r.json.users.some((u) => u.handle === 'alice'));
    assert.ok(!r.text.includes('@'), 'no email-like strings');
  });

  test('writes need the CSRF token', async () => {
    const r = await api('PUT', `/api/site-admin/users/${jars.alice.user.id}/role`, {
      jar: jars.super,
      body: { role: 'designer' },
      csrf: false,
    });
    assert.equal(r.status, 403);
  });

  test('super admin promotes alice to designer (alias "editor") and it is audited', async () => {
    const r = await api('PUT', `/api/site-admin/users/${jars.alice.user.id}/role`, {
      jar: jars.super,
      body: { role: 'editor' },
    });
    assert.equal(r.status, 200, r.json?.error);
    assert.equal(r.json.user.role, 'designer');
    const audit = await api('GET', '/api/site-admin/audit?area=roles', { jar: jars.super });
    assert.equal(audit.status, 200);
    assert.equal(audit.json.verify.ok, true);
    const entry = audit.json.entries.find((e) => e.reason === 'role.change' && e.after?.userId === jars.alice.user.id);
    assert.ok(entry, 'role change audited');
    assert.equal(entry.before.role, 'voter');
    assert.equal(entry.after.role, 'designer');
  });

  test('designer can edit layout but not roles, plugins or branding', async () => {
    assert.equal((await api('GET', '/api/site-admin/layout', { jar: jars.alice })).status, 200);
    assert.equal((await api('GET', '/api/site-admin/plugins', { jar: jars.alice })).status, 403);
    const promote = await api('PUT', `/api/site-admin/users/${jars.bob.user.id}/role`, {
      jar: jars.alice,
      body: { role: 'auditor' },
    });
    assert.equal(promote.status, 403);
    const rename = await api('PUT', '/api/site-admin/layout', {
      jar: jars.alice,
      body: { layout: { branding: { productName: 'Not allowed' } } },
    });
    assert.equal(rename.status, 403);
    assert.equal(rename.json.capability, 'manage_branding');
    const nav = await api('PUT', '/api/site-admin/layout', {
      jar: jars.alice,
      body: {
        layout: {
          nav: { managed: false, items: [{ id: 'help', label: 'Help', href: '/faq', order: 1 }], hidden: ['/api'] },
          regions: { banner: [{ id: 'welcome', type: 'notice', title: 'Welcome', body: 'Hello voters', tone: 'info' }] },
          theme: { light: { focus: '#1d4ed8' } },
        },
      },
    });
    assert.equal(nav.status, 200, nav.json?.error);
    const pub = await api('GET', '/api/layout');
    assert.equal(pub.json.layout.nav.items[0].label, 'Help');
    assert.equal(pub.json.layout.regions.banner[0].body, 'Hello voters');
    assert.equal(pub.json.layout.branding.productName, 'ZK-Voting');
    const css = await api('GET', '/api/layout/theme.css');
    assert.match(css.text, /--focus:\s*#1d4ed8/);
  });

  test('layout rejects unsafe hrefs and theme values', async () => {
    const bad = await api('PUT', '/api/site-admin/layout', {
      jar: jars.super,
      body: { layout: { nav: { items: [{ id: 'x', label: 'X', href: 'javascript:alert(1)' }] } } },
    });
    assert.equal(bad.status, 400);
    const css = await api('PUT', '/api/site-admin/layout', {
      jar: jars.super,
      body: { layout: { theme: { light: { fg: 'red; } body { display:none' } } } },
    });
    assert.equal(css.status, 400);
  });

  test('product name defaults to ZK-Voting and super admin can rename it', async () => {
    const before = await api('GET', '/api/layout');
    assert.equal(before.json.layout.branding.productName, 'ZK-Voting');
    const r = await api('PUT', '/api/site-admin/layout', {
      jar: jars.super,
      body: { layout: { ...before.json.layout, branding: { productName: 'County Votes' } } },
    });
    assert.equal(r.status, 200, r.json?.error);
    assert.equal((await api('GET', '/api/layout')).json.layout.branding.productName, 'County Votes');
    // designer edits keep the admin's name
    const keep = await api('PUT', '/api/site-admin/layout', {
      jar: jars.alice,
      body: { layout: { nav: { items: [] } } },
    });
    assert.equal(keep.status, 200, keep.json?.error);
    assert.equal((await api('GET', '/api/layout')).json.layout.branding.productName, 'County Votes');
    const reset = await api('POST', '/api/site-admin/layout/reset', { jar: jars.super, body: {} });
    assert.equal(reset.status, 200);
    assert.equal((await api('GET', '/api/layout')).json.layout.branding.productName, 'ZK-Voting');
  });

  test('admin cannot create or demote super admins; last super admin is protected', async () => {
    const mk = await api('PUT', `/api/site-admin/users/${jars.bob.user.id}/role`, {
      jar: jars.super,
      body: { role: 'admin' },
    });
    assert.equal(mk.status, 200, mk.json?.error);
    assert.equal(mk.json.user.role, 'platform_admin');
    const up = await api('PUT', `/api/site-admin/users/${jars.carol.user.id}/role`, {
      jar: jars.bob,
      body: { role: 'super_admin' },
    });
    assert.equal(up.status, 403);
    const down = await api('PUT', `/api/site-admin/users/${jars.super.user.id}/role`, {
      jar: jars.bob,
      body: { role: 'voter' },
    });
    assert.equal(down.status, 403);
    const ok = await api('PUT', `/api/site-admin/users/${jars.carol.user.id}/role`, {
      jar: jars.bob,
      body: { role: 'election_manager' },
    });
    assert.equal(ok.status, 200, ok.json?.error);
    const self = await api('PUT', `/api/site-admin/users/${jars.super.user.id}/role`, {
      jar: jars.super,
      body: { role: 'platform_admin' },
    });
    assert.equal(self.status, 409);
    assert.equal(self.json.code, 'LAST_SUPER_ADMIN');
    const audit = await api('GET', '/api/site-admin/audit?action=role.change_denied', { jar: jars.super });
    assert.ok(audit.json.entries.length >= 2);
  });

  test('invalid roles are rejected', async () => {
    const r = await api('PUT', `/api/site-admin/users/${jars.carol.user.id}/role`, {
      jar: jars.super,
      body: { role: 'root' },
    });
    assert.equal(r.status, 400);
  });

  test('legacy PATCH /api/users/:id role changes are audited too', async () => {
    const r = await api('PATCH', `/api/users/${jars.carol.user.id}`, { jar: jars.super, body: { role: 'auditor' } });
    assert.equal(r.status, 200, r.json?.error);
    const audit = await api('GET', '/api/site-admin/audit?area=roles', { jar: jars.super });
    assert.ok(audit.json.entries.some((e) => e.path === `/api/users/${jars.carol.user.id}` && e.after.role === 'auditor'));
  });

  test('bundled example plugins are listed, disabled by default', async () => {
    const r = await api('GET', '/api/site-admin/plugins', { jar: jars.super });
    assert.equal(r.status, 200, r.json?.error);
    const names = r.json.plugins.map((p) => p.name);
    assert.ok(names.includes('announcement-banner'));
    assert.ok(names.includes('backoffice-notes'));
    for (const p of r.json.plugins) assert.equal(p.enabled, false, p.name);
    assert.deepEqual((await api('GET', '/api/layout')).json.plugins, []);
    assert.equal((await api('GET', '/api/plugins/announcement-banner/message')).status, 404);
    assert.equal((await api('GET', '/plugins-assets/announcement-banner/client.mjs')).status, 404);
  });

  test('enabling requires accepting the exact permissions', async () => {
    const r = await api('POST', '/api/site-admin/plugins/announcement-banner/enable', {
      jar: jars.super,
      body: { acceptPermissions: ['client'] },
    });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, 'PERMISSIONS_NOT_ACCEPTED');
  });

  test('announcement-banner: enable, edit, render, disable', async () => {
    const list = await api('GET', '/api/site-admin/plugins', { jar: jars.super });
    const plugin = list.json.plugins.find((p) => p.name === 'announcement-banner');
    const en = await api('POST', '/api/site-admin/plugins/announcement-banner/enable', {
      jar: jars.super,
      body: { acceptPermissions: plugin.permissions },
    });
    assert.equal(en.status, 200, en.json?.error);
    assert.deepEqual((await api('GET', '/api/plugins/announcement-banner/message')).json, { message: null });
    const voterPut = await api('PUT', '/api/plugins/announcement-banner/settings', {
      jar: jars.carol,
      body: { enabled: true, text: 'nope' },
    });
    assert.equal(voterPut.status, 403);
    const noCsrf = await api('PUT', '/api/plugins/announcement-banner/settings', {
      jar: jars.alice,
      body: { enabled: true, text: 'nope' },
      csrf: false,
    });
    assert.equal(noCsrf.status, 403);
    const put = await api('PUT', '/api/plugins/announcement-banner/settings', {
      jar: jars.alice,
      body: { enabled: true, text: 'Polls close at 8pm', tone: 'warning' },
    });
    assert.equal(put.status, 200, put.json?.error);
    const msg = await api('GET', '/api/plugins/announcement-banner/message');
    assert.equal(msg.json.message.text, 'Polls close at 8pm');
    const layout = await api('GET', '/api/layout');
    const cm = layout.json.plugins.find((p) => p.name === 'announcement-banner');
    assert.ok(cm.slots.includes('banner'));
    const asset = await api('GET', cm.client);
    assert.equal(asset.status, 200);
    assert.match(asset.res.headers.get('content-type'), /javascript/);
    assert.equal(asset.res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await api('GET', '/plugins-assets/announcement-banner/server/index.mjs')).status, 404);
    assert.equal((await api('GET', '/plugins-assets/announcement-banner/plugin.json')).status, 404);
    assert.equal((await api('GET', '/plugins-assets/announcement-banner/..%2f..%2fpackage.json')).status, 404);
    const dis = await api('POST', '/api/site-admin/plugins/announcement-banner/disable', { jar: jars.super, body: {} });
    assert.equal(dis.status, 200);
    assert.equal((await api('GET', '/api/plugins/announcement-banner/message')).status, 404);
    const audit = await api('GET', '/api/site-admin/audit?area=plugins', { jar: jars.super });
    const actions = audit.json.entries.map((e) => e.reason);
    assert.ok(actions.includes('plugin.enable'));
    assert.ok(actions.includes('plugin.disable'));
  });

  test('backoffice-notes: admin page, gated routes, role-change event', async () => {
    const list = await api('GET', '/api/site-admin/plugins', { jar: jars.super });
    const plugin = list.json.plugins.find((p) => p.name === 'backoffice-notes');
    const en = await api('POST', '/api/site-admin/plugins/backoffice-notes/enable', {
      jar: jars.super,
      body: { acceptPermissions: plugin.permissions },
    });
    assert.equal(en.status, 200, en.json?.error);
    const me = await api('GET', '/api/site-admin/me', { jar: jars.super });
    assert.ok(me.json.menu.some((m) => m.plugin === 'backoffice-notes' && m.page === 'notes'));
    assert.equal((await api('GET', '/api/plugins/backoffice-notes/notes', { jar: jars.alice })).status, 403);
    const add = await api('POST', '/api/plugins/backoffice-notes/notes', { jar: jars.super, body: { text: 'Ballots printed' } });
    assert.equal(add.status, 201, add.json?.error);
    await api('PUT', `/api/site-admin/users/${jars.carol.user.id}/role`, { jar: jars.super, body: { role: 'moderator' } });
    const notes = await api('GET', '/api/plugins/backoffice-notes/notes', { jar: jars.super });
    assert.equal(notes.status, 200);
    assert.equal(notes.json.notes[0].text, 'Ballots printed');
    assert.ok(notes.json.roleLog.some((r) => r.handle === 'carol' && r.to === 'moderator'));
    assert.ok(!JSON.stringify(notes.json).includes('@'));
    await api('POST', '/api/site-admin/plugins/backoffice-notes/disable', { jar: jars.super, body: {} });
  });

  test('uploads: checksum header, zip-slip, manifest, disabled after import, uninstall', async () => {
    const manifest = {
      name: 'my-plugin',
      version: '0.1.0',
      author: 'Test',
      license: 'MIT',
      type: 'ui',
      permissions: ['client'],
      entrypoints: { client: 'client.mjs' },
      slots: ['footer'],
    };
    const good = pluginZip(manifest, { 'client.mjs': 'export function register(h){h.slot("footer",(el)=>{el.textContent="hi";});}' });
    const noSha = await api('POST', '/api/site-admin/plugins/upload', { jar: jars.super, raw: good });
    assert.equal(noSha.status, 400);
    assert.equal(noSha.json.code, 'CHECKSUM_MISMATCH');

    const slip = writeZip([
      { name: 'plugin.json', data: Buffer.from(JSON.stringify(manifest)) },
      { name: '../../evil.mjs', data: Buffer.from('x') },
    ]);
    const s = await api('POST', '/api/site-admin/plugins/upload', {
      jar: jars.super,
      raw: slip,
      headers: { 'x-plugin-sha256': sha(slip) },
    });
    assert.equal(s.status, 400);
    await assert.rejects(stat(path.join(tmp, '..', 'evil.mjs')));

    const evalZip = pluginZip(manifest, { 'client.mjs': 'export function register(){ eval("1"); }' });
    const e = await api('POST', '/api/site-admin/plugins/upload', {
      jar: jars.super,
      raw: evalZip,
      headers: { 'x-plugin-sha256': sha(evalZip) },
    });
    assert.equal(e.status, 400);

    const designer = await api('POST', '/api/site-admin/plugins/upload', {
      jar: jars.alice,
      raw: good,
      headers: { 'x-plugin-sha256': sha(good) },
    });
    assert.equal(designer.status, 403);

    const up = await api('POST', '/api/site-admin/plugins/upload', {
      jar: jars.super,
      raw: good,
      headers: { 'x-plugin-sha256': sha(good) },
    });
    assert.equal(up.status, 201, up.json?.error);
    assert.equal(up.json.plugin.enabled, false);
    assert.equal(up.json.plugin.source, 'upload');
    const dup = await api('POST', '/api/site-admin/plugins/upload', {
      jar: jars.super,
      raw: good,
      headers: { 'x-plugin-sha256': sha(good) },
    });
    assert.equal(dup.status, 409);
    const del = await api('DELETE', '/api/site-admin/plugins/my-plugin', { jar: jars.super });
    assert.equal(del.status, 200, del.json?.error);
    await assert.rejects(stat(path.join(tmp, 'plugins', 'my-plugin')));
    const delRepo = await api('DELETE', '/api/site-admin/plugins/announcement-banner', { jar: jars.super });
    assert.equal(delRepo.status, 400);
  });

  test('plugin upload requires a recent sign-in', async () => {
    const sess = store.data.sessions || [];
    const all = Array.isArray(sess) ? sess : Object.values(sess);
    for (const s of all) {
      if (s.userId === jars.super.user.id) {
        s.authenticatedAt = new Date(Date.now() - 3600_000).toISOString();
        s.createdAt = s.authenticatedAt;
      }
    }
    const zip = pluginZip({ name: 'my-plugin', version: '0.1.0', author: 'T', license: 'MIT', type: 'ui', permissions: ['client'], entrypoints: { styles: 'a.css' } }, { 'a.css': 'body{}' });
    const r = await api('POST', '/api/site-admin/plugins/upload', {
      jar: jars.super,
      raw: zip,
      headers: { 'x-plugin-sha256': sha(zip) },
    });
    assert.equal(r.status, 401);
    assert.equal(r.json.code, 'REAUTH_REQUIRED');
  });

  test('site-admin page is served with a strict CSP', async () => {
    const r = await api('GET', '/site-admin', { jar: jars.super });
    assert.equal(r.status, 200);
    assert.equal(r.res.headers.get('content-security-policy'), SITE_ADMIN_CSP);
    assert.doesNotMatch(SITE_ADMIN_CSP, /unsafe-(inline|eval)/);
    assert.doesNotMatch(r.text, /<script>(?!<\/script>)/);
    assert.doesNotMatch(r.text, /\sstyle=/);
    assert.doesNotMatch(r.text, /\son[a-z]+=/i);
    assert.match(r.text, /ZK-Voting/);
    assert.doesNotMatch(r.text, /Republic/);
    assert.doesNotMatch(r.text, /%BRAND_/);
  });
});

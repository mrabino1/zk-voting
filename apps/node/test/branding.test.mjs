// NOT FOR PROFIT — civic public good, not a commercial product.
// Configurable branding: "ZK-Voting" by default, renamed in site admin by a
// super admin or admin (manage_branding), never by a designer or voter.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { createApp } from '../src/server.mjs';
import { brandDefaults, brandName, renderBrandedHtml, setBrandingProvider } from '../src/branding.mjs';

let tmp;
let server;
let base;
const jars = {};

function applyCookies(res, jar) {
  for (const c of res.headers.getSetCookie?.() || []) {
    const pair = c.split(';')[0];
    const i = pair.indexOf('=');
    if (i !== -1) jar.cookies[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
}

async function api(method, url, { body, jar } = {}) {
  const h = {};
  if (jar) h.cookie = Object.entries(jar.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  if (jar?.csrf && method !== 'GET') h['x-csrf-token'] = jar.csrf;
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  if (jar) applyCookies(res, jar);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

async function login(name, handle, role) {
  const jar = { cookies: {}, csrf: null };
  const r = await api('POST', '/api/auth/dev-login', { body: role ? { handle, role } : { handle }, jar });
  assert.equal(r.status, 200, r.json?.error);
  jar.user = r.json.user;
  const me = await api('GET', '/api/site-admin/me', { jar });
  if (me.status === 200) jar.csrf = me.json.csrfToken;
  jars[name] = jar;
  return jar;
}

async function refreshCsrf(jar) {
  const me = await api('GET', '/api/site-admin/me', { jar });
  assert.equal(me.status, 200, me.json?.error);
  jar.csrf = me.json.csrfToken;
}

const visible = (html) => html.replace(/<!--[\s\S]*?-->/g, '');
const title = (html) => (html.match(/<title[^>]*>([^<]*)<\/title>/) || [])[1];

describe('configurable branding', () => {
  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'zkv-branding-'));
    const created = await createApp({
      dataDir: tmp,
      allowDevLogin: true,
      adminHandle: 'admin',
      quiet: true,
      port: 0,
      layoutFile: path.join(tmp, 'no-layout.json'),
      layoutOverrideModule: path.join(tmp, 'no-override.mjs'),
    });
    server = await new Promise((resolve, reject) => {
      const s = created.app.listen(0, '127.0.0.1', () => resolve(s));
      s.on('error', reject);
    });
    base = `http://127.0.0.1:${server.address().port}`;
    await login('super', 'admin');
    await login('dana', 'dana', 'voter');
    await login('ella', 'ella', 'voter');
    await login('vic', 'vic', 'voter');
    for (const [name, role] of [['dana', 'platform_admin'], ['ella', 'designer']]) {
      const r = await api('PUT', `/api/site-admin/users/${jars[name].user.id}/role`, { jar: jars.super, body: { role } });
      assert.equal(r.status, 200, r.json?.error);
      await refreshCsrf(jars[name]);
    }
  });

  after(async () => {
    setBrandingProvider(null);
    await new Promise((resolve) => server.close(resolve));
    await rm(tmp, { recursive: true, force: true });
  });

  test('default renders ZK-Voting in pages, meta, docs and API', async () => {
    for (const url of ['/', '/site-admin', '/docs', '/ceremony']) {
      const r = await api('GET', url, { jar: jars.super });
      assert.equal(r.status, 200, url);
      assert.match(r.text, /<meta name="brand-name" content="ZK-Voting"\/>/, url);
      assert.doesNotMatch(r.text, /%BRAND_/, url);
      assert.doesNotMatch(r.text, /Republic/, url);
      assert.match(title(r.text) || '', /ZK-Voting/, url);
    }
    const home = await api('GET', '/');
    assert.match(home.text, /<meta property="og:site_name" content="ZK-Voting" \/>/);
    const cfg = await api('GET', '/api/config');
    assert.equal(cfg.json.product, 'ZK-Voting');
    assert.equal(cfg.json.rpName, 'ZK-Voting');
    assert.equal(brandName(), 'ZK-Voting');
  });

  test('super admin rename changes the rendered name everywhere', async () => {
    const r = await api('PUT', '/api/site-admin/layout', {
      jar: jars.super,
      body: { branding: { productName: 'Springfield Votes', tagline: 'Town of Springfield ballots' } },
    });
    assert.equal(r.status, 200, r.json?.error);
    const home = await api('GET', '/');
    assert.match(title(home.text), /Springfield Votes/);
    assert.match(home.text, /<meta name="brand-name" content="Springfield Votes"\/>/);
    assert.match(home.text, /<meta name="brand-short-name" content="Springfield Votes"\/>/);
    assert.match(home.text, /content="Town of Springfield ballots"/);
    assert.doesNotMatch(visible(home.text), /ZK-Voting/);
    const docs = await api('GET', '/docs');
    assert.match(docs.text, /Springfield Votes/);
    const cfg = await api('GET', '/api/config');
    assert.equal(cfg.json.product, 'Springfield Votes');
    assert.equal(cfg.json.rpName, 'Springfield Votes', 'WebAuthn rpName follows the brand');
    assert.equal(brandName(), 'Springfield Votes');
  });

  test('platform admin can rename; HTML in a name is refused', async () => {
    const bad = await api('PUT', '/api/site-admin/layout', { jar: jars.dana, body: { branding: { productName: '<b>x</b>' } } });
    assert.equal(bad.status, 400);
    const r = await api('PUT', '/api/site-admin/layout', { jar: jars.dana, body: { branding: { productName: 'Shelbyville Votes', shortName: 'SV' } } });
    assert.equal(r.status, 200, r.json?.error);
    const home = await api('GET', '/');
    assert.match(title(home.text), /Shelbyville Votes/);
    assert.match(home.text, /<meta name="brand-short-name" content="SV"\/>/);
  });

  test('designer and voter cannot change the name', async () => {
    const layout = await api('GET', '/api/site-admin/layout', { jar: jars.ella });
    assert.equal(layout.status, 200, layout.json?.error);
    // Echoing the effective layout back is not a rename.
    const same = await api('PUT', '/api/site-admin/layout', { jar: jars.ella, body: { branding: layout.json.effective.branding } });
    assert.equal(same.status, 200, same.json?.error);
    const designer = await api('PUT', '/api/site-admin/layout', { jar: jars.ella, body: { branding: { productName: 'Hijacked' } } });
    assert.equal(designer.status, 403);
    assert.equal(designer.json.code, 'CAPABILITY');
    const voter = await api('PUT', '/api/site-admin/layout', { jar: jars.vic, body: { branding: { productName: 'Hijacked' } } });
    assert.equal(voter.status, 403);
    assert.doesNotMatch((await api('GET', '/')).text, /Hijacked/);
  });

  test('clearing the name falls back to the default', async () => {
    const r = await api('PUT', '/api/site-admin/layout', { jar: jars.super, body: { branding: { productName: '', shortName: '', tagline: '' } } });
    assert.equal(r.status, 200, r.json?.error);
    assert.match(title((await api('GET', '/')).text), /ZK-Voting/);
  });
});

describe('branding helpers', () => {
  test('BRAND_* env sets the default; unsafe values are ignored', () => {
    assert.deepEqual(brandDefaults({}), { name: 'ZK-Voting', shortName: 'ZK-Voting', tagline: brandDefaults({}).tagline });
    const d = brandDefaults({ BRAND_NAME: 'Ogdenville Polls', BRAND_SHORT_NAME: 'OP' });
    assert.equal(d.name, 'Ogdenville Polls');
    assert.equal(d.shortName, 'OP');
    assert.equal(brandDefaults({ BRAND_NAME: '<script>' }).name, 'ZK-Voting');
  });

  test('placeholders are HTML-escaped', () => {
    const out = renderBrandedHtml('<title>%BRAND_NAME%</title>%BRAND_SHORT_NAME%|%BRAND_TAGLINE%', {
      name: 'A & B',
      shortName: "A's",
      tagline: 'x',
    });
    assert.equal(out, '<title>A &amp; B</title>A&#39;s|x');
  });
});

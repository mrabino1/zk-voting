// NOT FOR PROFIT — civic public good, not a commercial product.
// Site identity: a fork's pages must not send its visitors to the upstream project's inbox
// or advertise upstream's services; the source link must be able to point at the fork.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { createApp } from '../src/server.mjs';
import { applySiteIdentityHtml, parseIdentityInput, resolveSiteIdentity, UPSTREAM } from '../src/siteIdentity.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const PAGES = ['index.html', 'admin.html', 'back-office.html', 'explorer.html', 'site-admin.html', 'docs.html', 'ceremony.html'];

describe('resolveSiteIdentity', () => {
  test('defaults: no contact, no contracting offer, upstream project links', () => {
    const id = resolveSiteIdentity({ env: {} });
    assert.equal(id.contactEmail, '');
    assert.equal(id.contractingCta, false);
    assert.equal(id.sourceUrl, UPSTREAM.sourceUrl);
    assert.equal(id.projectUrl, UPSTREAM.projectUrl);
    assert.equal(id.forumUrl, UPSTREAM.forumUrl);
  });

  test('environment, then saved values win; "none" hides a project link', () => {
    const env = { SITE_CONTACT_EMAIL: 'clerk@city.example', SITE_CONTRACTING_CTA: 'true', SITE_FORUM_URL: 'none', SITE_SOURCE_URL: 'https://git.city.example/vote' };
    const id = resolveSiteIdentity({ env });
    assert.equal(id.contactEmail, 'clerk@city.example');
    assert.equal(id.contractingCta, true);
    assert.equal(id.forumUrl, '');
    assert.equal(id.sourceUrl, 'https://git.city.example/vote');
    const saved = resolveSiteIdentity({ env, saved: { contactEmail: 'votes@city.example', projectUrl: 'none' } });
    assert.equal(saved.contactEmail, 'votes@city.example');
    assert.equal(saved.projectUrl, '');
    assert.equal(saved.sources.contactEmail, 'saved');
    assert.equal(saved.sources.forumUrl, 'environment');
  });

  test('unsafe values are ignored', () => {
    const id = resolveSiteIdentity({ env: { SITE_CONTACT_EMAIL: 'x"><script>@a.b', SITE_SOURCE_URL: 'javascript:alert(1)' } });
    assert.equal(id.contactEmail, '');
    assert.equal(id.sourceUrl, UPSTREAM.sourceUrl);
  });

  test('input validation: the source link cannot be hidden (AGPL)', () => {
    assert.throws(() => parseIdentityInput({ sourceUrl: 'none' }), /AGPL/);
    assert.throws(() => parseIdentityInput({ contactEmail: 'not an email' }), /Contact email/);
    assert.deepEqual(parseIdentityInput({ forumUrl: '', contractingCta: 1 }), { forumUrl: 'none', contractingCta: true });
  });
});

describe('applySiteIdentityHtml on the real pages', () => {
  for (const page of PAGES) {
    test(`${page}: a default fork shows no upstream inbox or offer`, async () => {
      const html = await readFile(path.join(here, '../public', page), 'utf8');
      const out = applySiteIdentityHtml(html, resolveSiteIdentity({ env: {} }));
      assert.doesNotMatch(out, /hello@zk-voting\.org/);
      assert.doesNotMatch(out, /class="footer-contract"/);
      assert.doesNotMatch(out, /aria-labelledby="footer-contact-label"/, 'no dangling label reference');
    });
  }

  test('a configured site shows its own contact, offer and source', async () => {
    const html = await readFile(path.join(here, '../public/index.html'), 'utf8');
    const id = resolveSiteIdentity({ env: { SITE_CONTACT_EMAIL: 'clerk@city.example', SITE_CONTRACTING_CTA: '1', SITE_SOURCE_URL: 'https://github.com/city/zk-voting' } });
    const out = applySiteIdentityHtml(html, id);
    assert.match(out, /mailto:clerk@city\.example/);
    assert.match(out, /class="footer-contract"/);
    assert.match(out, /https:\/\/github\.com\/city\/zk-voting/);
    assert.doesNotMatch(out, /github\.com\/mrabino1/);
  });

  test('hiding the project and forum removes those links', async () => {
    const html = await readFile(path.join(here, '../public/index.html'), 'utf8');
    const out = applySiteIdentityHtml(html, resolveSiteIdentity({ env: { SITE_PROJECT_URL: 'none', SITE_FORUM_URL: 'none' } }));
    assert.doesNotMatch(out, /community\.zk-voting\.org/);
    assert.doesNotMatch(out, /href="https:\/\/zk-voting\.org"/);
  });
});

describe('served pages', () => {
  let tmp;
  let server;
  let base;
  let created;
  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'zkv-identity-'));
    created = await createApp({ dataDir: tmp, allowDevLogin: true, adminHandle: 'admin', quiet: true, port: 0, disclosureIntervalSeconds: 0 });
    server = await new Promise((r) => {
      const s = created.app.listen(0, '127.0.0.1', () => r(s));
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    await rm(tmp, { recursive: true, force: true });
  });

  test('a saved identity reaches every page and the browser meta tags', async () => {
    created.store.data.siteIdentity = { contactEmail: 'votes@city.example', forumUrl: 'none', sourceUrl: 'https://github.com/city/zk-voting' };
    for (const route of ['/', '/back-office', '/admin']) {
      const html = await (await fetch(base + route)).text();
      assert.match(html, /mailto:votes@city\.example/, route);
      assert.doesNotMatch(html, /hello@zk-voting\.org/, route);
      assert.match(html, /<meta name="site-forum-url" content=""\/>/, route);
      assert.match(html, /<meta name="site-source-url" content="https:\/\/github\.com\/city\/zk-voting"\/>/, route);
    }
  });

  test('PUT /api/setup/identity needs the super admin and validates input', async () => {
    const anon = await fetch(`${base}/api/setup/identity`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(anon.status, 401);
    const login = await fetch(`${base}/api/auth/dev-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'admin' }) });
    const cookie = login.headers.getSetCookie()[0].split(';')[0];
    const bad = await fetch(`${base}/api/setup/identity`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ sourceUrl: 'none' }) });
    assert.equal(bad.status, 400);
    const ok = await fetch(`${base}/api/setup/identity`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ contactEmail: 'help@city.example', contractingCta: false, forumUrl: 'https://forum.city.example' }),
    });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.site.identity.contactEmail, 'help@city.example');
    assert.equal(body.site.identity.forumUrl, 'https://forum.city.example');
  });
});

describe('client host footer (VOTE_FQDN set)', () => {
  test('keeps the site\'s own contact and offer next to powered-by', async () => {
    const { renderPublicHtml } = await import('../src/publicAssets.mjs');
    const html = await readFile(path.join(here, '../public/index.html'), 'utf8');
    const out = renderPublicHtml(html, { voteFqdn: 'demo.example.org', projectUrl: 'https://zk-voting.org', contactEmail: 'hello@city.example', contractingCta: true });
    const footer = out.match(/<footer[\s\S]*?<\/footer>/)[0];
    assert.match(footer, /mailto:hello@city\.example/);
    assert.match(footer, /class="footer-contract"/);
    assert.match(footer, /powered by zk-voting\.org/);
  });

  test('without a contact it shows only powered-by, never the upstream inbox', async () => {
    const { renderPublicHtml } = await import('../src/publicAssets.mjs');
    const html = await readFile(path.join(here, '../public/index.html'), 'utf8');
    const footer = renderPublicHtml(html, { voteFqdn: 'demo.example.org', projectUrl: 'https://zk-voting.org' }).match(/<footer[\s\S]*?<\/footer>/)[0];
    assert.doesNotMatch(footer, /mailto:/);
    assert.match(footer, /powered by/);
  });
});

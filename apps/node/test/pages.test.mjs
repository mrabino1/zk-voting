// NOT FOR PROFIT — civic public good, not a commercial product.
// Forked Node CMS + one shared factory pin + clean URLs (no .html).

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import {
  SHARED_DEPLOYMENT_NOTE,
  applySiteContractPins,
  canManagePages,
  mergePublicContracts,
  navItemsFromPages,
  normalizeSlug,
  sanitizeAddress,
  sanitizeBlock,
  sanitizeBlocks,
  sanitizeHref,
  sanitizeText,
} from '../src/cms.mjs';
import { parseRoute } from '../public/router.js';
import { mainNav } from '../public/audience.js';
import { createApp } from '../src/server.mjs';

function loc(pathname, search = '') {
  return { pathname, hash: '', search };
}

let tmp;
let server;
let base;
const adminJar = {};
const northClerkJar = {};
const southClerkJar = {};
const registrarJar = {};
const voterJar = {};
let northId;
let southId;

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

async function api(method, url, { body, jar, redirect = 'follow' } = {}) {
  const res = await fetch(base + url, {
    method,
    redirect,
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

async function grant(jurisdictionId, handle, role) {
  const { status, json } = await api('POST', `/api/jurisdictions/${jurisdictionId}/roles`, {
    jar: adminJar,
    body: { handle, role },
  });
  assert.equal(status, 200, json?.error);
}

describe('cms helpers', () => {
  test('strips HTML, rejects javascript hrefs, reserved slugs', () => {
    assert.equal(sanitizeText('<p>Hello <script>alert(1)</script></p>'), 'Hello');
    assert.equal(sanitizeHref('javascript:alert(1)'), '');
    assert.equal(sanitizeHref('https://example.org/about'), 'https://example.org/about');
    assert.equal(sanitizeHref('/office/pages'), '/office/pages');
    assert.equal(sanitizeHref('//evil.example'), '');
    assert.equal(normalizeSlug('Hours & Info'), 'hours-info');
    assert.equal(normalizeSlug('admin'), '');
    assert.equal(normalizeSlug('about'), '');
    assert.equal(normalizeSlug('terms'), '');
    assert.equal(normalizeSlug('feedback'), '');
    assert.equal(normalizeSlug('receipt'), '');
    assert.equal(normalizeSlug('proof'), '');
    assert.equal(normalizeSlug('outcomes'), '');
    assert.equal(normalizeSlug('monitor'), '');
    assert.equal(normalizeSlug('o'), '');
    assert.equal(sanitizeAddress('0x1111111111111111111111111111111111111111'), '0x1111111111111111111111111111111111111111');
    assert.equal(sanitizeAddress('not-an-address'), null);
    assert.equal(sanitizeAddress(''), '');
    const block = sanitizeBlock({
      type: 'paragraph',
      text: '<img src=x onerror=alert(1)>Hello',
    });
    assert.equal(block.type, 'paragraph');
    assert.equal(block.text, 'Hello');
    assert.equal(sanitizeBlock({ type: 'cta', label: 'Go', href: 'javascript:1' }), null);
    assert.deepEqual(
      sanitizeBlocks([{ type: 'heading', text: 'Town hall' }, { type: 'nope', text: '' }]),
      [{ type: 'heading', text: 'Town hall' }],
    );
    assert.match(SHARED_DEPLOYMENT_NOTE, /Fork this Node/);
  });

  test('env factory wins over site pin', () => {
    const site = {
      contracts: {
        factory: '0x2222222222222222222222222222222222222222',
        ballotInbox: '',
        verifier: '',
      },
    };
    const config = {
      chainId: 27427,
      envContracts: {
        factory: '0x1111111111111111111111111111111111111111',
        ballotInbox: '',
        verifier: '',
      },
      electionFactoryAddress: '0x1111111111111111111111111111111111111111',
    };
    const merged = mergePublicContracts(config, site);
    assert.equal(merged.factory, '0x1111111111111111111111111111111111111111');
    assert.equal(merged.source, 'env');
    assert.equal(merged.pinnedByEnv.factory, true);
    const unset = { chainId: 1, envContracts: { factory: '', ballotInbox: '', verifier: '' } };
    applySiteContractPins(unset, site);
    assert.equal(unset.electionFactoryAddress, '0x2222222222222222222222222222222222222222');
    assert.equal(mergePublicContracts(unset, site).source, 'site');
  });

  test('nav items only from published custom pages', () => {
    const nav = navItemsFromPages([
      { kind: 'custom', status: 'published', showInNav: true, slug: 'hours', title: 'Hours', navLabel: 'Hours' },
      { kind: 'custom', status: 'draft', showInNav: true, slug: 'secret', title: 'Secret' },
      { kind: 'about', status: 'published', showInNav: true, slug: 'about', title: 'About' },
    ]);
    assert.deepEqual(
      nav.map((i) => i.href),
      ['/p/hours'],
    );
  });

  test('parseRoute maps CMS and office editor paths; extra nav is opt-in', () => {
    assert.equal(parseRoute(loc('/office/pages')).name, 'officePages');
    assert.equal(parseRoute(loc('/office/pages/new')).name, 'officePageNew');
    assert.equal(parseRoute(loc('/office/site')).name, 'officeSite');
    assert.equal(parseRoute(loc('/p/hours')).name, 'cmsPage');
    assert.equal(parseRoute(loc('/p/hours')).params.slug, 'hours');
    assert.equal(parseRoute(loc('/admin.html')).name, 'notfound');
    assert.equal(parseRoute(loc('/polls')).name, 'polls');
    assert.equal(parseRoute(loc('/polls/poll-1')).name, 'poll');
    assert.equal(parseRoute(loc('/polls/poll-1/vote')).name, 'pollVote');
    assert.equal(parseRoute(loc('/polls/poll-1/results')).name, 'pollResults');
    assert.equal(parseRoute(loc('/elections/1')).name, 'results');
    const pub = mainNav('public').map((i) => i.label);
    assert.deepEqual(pub, ['About', 'FAQ', 'Receipt', 'Outcomes', 'Terms', 'Feedback', 'Bot API', 'Sign in', 'Register']);
    const withExtra = mainNav('public', [{ href: '/p/hours', label: 'Hours' }]).map((i) => i.label);
    assert.deepEqual(withExtra, ['About', 'FAQ', 'Receipt', 'Outcomes', 'Terms', 'Feedback', 'Bot API', 'Hours', 'Sign in', 'Register']);
  });

  test('canManagePages: platform_admin all; clerk scoped; registrar no', () => {
    const store = {
      userHasJurisdictionRole(user, roles, jid) {
        if (user.role === 'platform_admin') return true;
        return user.handle === 'north-clerk' && roles.includes('clerk') && jid === 'north';
      },
      userHasAnyJurisdictionRole(user, roles) {
        if (user.role === 'platform_admin') return true;
        return user.handle === 'north-clerk' && roles.includes('clerk');
      },
    };
    const admin = { role: 'platform_admin' };
    const clerk = { role: 'voter', handle: 'north-clerk' };
    const registrar = { role: 'voter', handle: 'north-registrar' };
    assert.equal(canManagePages(store, admin, { jurisdictionId: 'south' }), true);
    assert.equal(canManagePages(store, clerk, { jurisdictionId: null }), false);
    assert.equal(canManagePages(store, clerk, { jurisdictionId: 'north' }), true);
    assert.equal(canManagePages(store, clerk, { jurisdictionId: 'south' }), false);
    assert.equal(canManagePages(store, registrar, { jurisdictionId: null }), false);
  });
});

describe('pages HTTP CMS and clean URLs', () => {
  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'republic-pages-'));
    const created = await createApp({
      dataDir: tmp,
      allowDevLogin: true,
      adminHandle: 'admin',
      quiet: true,
      port: 0,
      disclosureIntervalSeconds: 0,
    });
    server = await listen(created.app);
    base = `http://127.0.0.1:${server.address().port}`;

    const admin = await api('POST', '/api/auth/dev-login', { body: { handle: 'admin' }, jar: adminJar });
    assert.equal(admin.status, 200);
    const north = await api('POST', '/api/jurisdictions', {
      jar: adminJar,
      body: { name: 'North' },
    });
    const south = await api('POST', '/api/jurisdictions', {
      jar: adminJar,
      body: { name: 'South' },
    });
    assert.equal(north.status, 201, north.json?.error);
    assert.equal(south.status, 201, south.json?.error);
    northId = north.json.id;
    southId = south.json.id;
    for (const [jar, handle] of [
      [northClerkJar, 'north-clerk'],
      [southClerkJar, 'south-clerk'],
      [registrarJar, 'north-registrar'],
      [voterJar, 'voter-pages'],
    ]) {
      const login = await api('POST', '/api/auth/dev-login', {
        body: { handle, role: 'voter' },
        jar,
      });
      assert.equal(login.status, 200, login.json?.error);
    }
    await grant(northId, 'north-clerk', 'clerk');
    await grant(southId, 'south-clerk', 'clerk');
    await grant(northId, 'north-registrar', 'registrar');
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await rm(tmp, { recursive: true, force: true });
  });

  test('*.html URLs redirect to clean paths', async () => {
    for (const [from, to] of [
      ['/admin.html', '/admin'],
      ['/back-office.html', '/back-office'],
      ['/explorer.html', '/explorer'],
      ['/index.html', '/'],
    ]) {
      const page = await api('GET', from, { redirect: 'manual' });
      assert.equal(page.status, 301, from);
      assert.equal(page.res.headers.get('location'), to, from);
      assert.notEqual(page.status, 200, from);
    }
    const adminClean = await api('GET', '/admin', { jar: adminJar, redirect: 'manual' });
    assert.equal(adminClean.status, 200);
    assert.match(adminClean.res.headers.get('content-type') || '', /html/);
    assert.doesNotMatch(adminClean.res.url || '', /\.html/);
  });

  test('GET /api/pages is public and empty before publish; config advertises shared deploy', async () => {
    const pages = await api('GET', '/api/pages');
    assert.equal(pages.status, 200);
    assert.equal(pages.json.sharedDeployment, true);
    assert.equal(pages.json.pages.length, 0);
    assert.match(pages.json.note, /Fork this Node/);
    const cfg = await api('GET', '/api/config');
    assert.equal(cfg.json.sharedDeployment, true);
    assert.equal(cfg.json.contracts.sharedDeployment, true);
    const health = await api('GET', '/health');
    assert.equal(health.json.sharedDeployment, true);
  });

  test('voter and registrar cannot write pages; unauthenticated office HTML is gated', async () => {
    const voter = await api('POST', '/api/office/pages', {
      jar: voterJar,
      body: { kind: 'custom', slug: 'nope', title: 'Nope', status: 'published', blocks: [{ type: 'paragraph', text: 'x' }] },
    });
    assert.equal(voter.status, 403);
    const registrar = await api('POST', '/api/office/pages', {
      jar: registrarJar,
      body: { kind: 'custom', slug: 'nope2', title: 'Nope', status: 'published', blocks: [{ type: 'paragraph', text: 'x' }] },
    });
    assert.equal(registrar.status, 403);
    const anon = await api('GET', '/office/pages', { redirect: 'manual' });
    assert.equal(anon.status, 302);
    assert.match(anon.res.headers.get('location') || '', /\/signin\?next=/);
  });

  test('clerk publishes a custom page; draft is hidden; HTML is stripped; reserved slug fails', async () => {
    const reserved = await api('POST', '/api/office/pages', {
      jar: northClerkJar,
      body: {
        kind: 'custom',
        slug: 'admin',
        title: 'Admin',
        status: 'published',
        jurisdictionId: northId,
        blocks: [{ type: 'paragraph', text: 'x' }],
      },
    });
    assert.equal(reserved.status, 400);

    const created = await api('POST', '/api/office/pages', {
      jar: northClerkJar,
      body: {
        kind: 'custom',
        slug: 'hours',
        title: '<b>Polling hours</b>',
        navLabel: 'Hours',
        showInNav: true,
        status: 'draft',
        jurisdictionId: northId,
        blocks: [
          { type: 'heading', text: '<script>alert(1)</script>Hours' },
          { type: 'paragraph', text: 'Open 7am–8pm. <img src=x onerror=alert(1)>' },
          { type: 'cta', label: 'FAQ', href: '/faq' },
        ],
      },
    });
    assert.equal(created.status, 201, created.json?.error);
    assert.equal(created.json.page.title, 'Polling hours');
    assert.equal(created.json.page.blocks[0].text, 'Hours');
    assert.equal(created.json.page.blocks[1].text, 'Open 7am–8pm.');
    assert.equal(created.json.page.status, 'draft');

    const publicDraft = await api('GET', '/api/pages/hours');
    assert.equal(publicDraft.status, 404);
    const list = await api('GET', '/api/pages');
    assert.equal(list.json.pages.length, 0);

    const published = await api('PATCH', `/api/office/pages/${created.json.page.id}`, {
      jar: northClerkJar,
      body: { status: 'published' },
    });
    assert.equal(published.status, 200, published.json?.error);
    const visible = await api('GET', '/api/pages/hours');
    assert.equal(visible.status, 200);
    assert.equal(visible.json.page.slug, 'hours');
    assert.equal(visible.json.page.path, '/p/hours');
    const nav = await api('GET', '/api/pages');
    assert.ok(nav.json.nav.some((i) => i.href === '/p/hours'));

    const spa = await api('GET', '/p/hours');
    assert.equal(spa.status, 200);
    assert.match(spa.text, /NOT FOR PROFIT/);
  });

  test('south clerk cannot edit north-tagged or unscoped pages', async () => {
    const northPage = await api('POST', '/api/office/pages', {
      jar: northClerkJar,
      body: {
        kind: 'custom',
        slug: 'north-only',
        title: 'North only',
        status: 'published',
        jurisdictionId: northId,
        blocks: [{ type: 'paragraph', text: 'North copy' }],
      },
    });
    assert.equal(northPage.status, 201, northPage.json?.error);
    const steal = await api('PATCH', `/api/office/pages/${northPage.json.page.id}`, {
      jar: southClerkJar,
      body: { title: 'Hijacked' },
    });
    assert.equal(steal.status, 403);

    const listedSouth = await api('GET', '/api/office/pages', { jar: southClerkJar });
    assert.equal(listedSouth.status, 200);
    assert.ok(!listedSouth.json.pages.some((p) => p.slug === 'north-only'));

    const siteWide = await api('POST', '/api/office/pages', {
      jar: southClerkJar,
      body: {
        kind: 'about',
        title: 'About overlay',
        status: 'published',
        replaceBuiltin: false,
        blocks: [{ type: 'paragraph', text: 'From South clerk on this Node.' }],
      },
    });
    assert.equal(siteWide.status, 403);

    const southPage = await api('POST', '/api/office/pages', {
      jar: southClerkJar,
      body: {
        kind: 'custom',
        slug: 'south-hours',
        title: 'South hours',
        status: 'published',
        jurisdictionId: southId,
        blocks: [{ type: 'paragraph', text: 'South copy' }],
      },
    });
    assert.equal(southPage.status, 201, southPage.json?.error);
  });

  test('platform_admin pins shared factory; clerk cannot; invalid address 400', async () => {
    const clerkPin = await api('PATCH', '/api/office/site', {
      jar: northClerkJar,
      body: { contracts: { factory: '0x3333333333333333333333333333333333333333' } },
    });
    assert.equal(clerkPin.status, 403);

    const clerkTitle = await api('PATCH', '/api/office/site', {
      jar: northClerkJar,
      body: { title: 'Captured desk' },
    });
    assert.equal(clerkTitle.status, 403);

    const bad = await api('PATCH', '/api/office/site', {
      jar: adminJar,
      body: { contracts: { factory: 'not-an-address' } },
    });
    assert.equal(bad.status, 400);

    const pin = await api('PATCH', '/api/office/site', {
      jar: adminJar,
      body: {
        title: 'Northbridge Republic',
        tagline: 'Fork the Node, keep the factory.',
        contracts: { factory: '0x3333333333333333333333333333333333333333' },
      },
    });
    assert.equal(pin.status, 200, pin.json?.error);
    assert.equal(pin.json.site.contracts.factory.toLowerCase(), '0x3333333333333333333333333333333333333333');
    assert.equal(pin.json.site.contracts.source, 'site');
    const cfg = await api('GET', '/api/config');
    assert.equal(cfg.json.electionFactoryAddress.toLowerCase(), '0x3333333333333333333333333333333333333333');
    assert.equal(cfg.json.addresses.factory.toLowerCase(), '0x3333333333333333333333333333333333333333');
    const site = await api('GET', '/api/site');
    assert.equal(site.json.title, 'Northbridge Republic');
  });

  test('home overlay publishes and office editor HTML is served at a clean URL', async () => {
    const home = await api('POST', '/api/office/pages', {
      jar: adminJar,
      body: {
        kind: 'home',
        title: 'Welcome to Northbridge',
        status: 'published',
        replaceBuiltin: true,
        blocks: [{ type: 'paragraph', text: 'Clerk-authored home copy.' }],
      },
    });
    assert.equal(home.status, 201, home.json?.error);
    const publicHome = await api('GET', '/api/pages');
    assert.equal(publicHome.json.overlays.home.title, 'Welcome to Northbridge');
    const editor = await api('GET', '/office/pages', { jar: adminJar, redirect: 'manual' });
    assert.equal(editor.status, 200);
    assert.match(editor.text, /NOT FOR PROFIT/);
    assert.match(editor.res.headers.get('content-type') || '', /html/);
  });
});

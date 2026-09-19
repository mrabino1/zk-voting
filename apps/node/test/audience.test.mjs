// NOT FOR PROFIT — civic public good, not a commercial product.
// Three audience surfaces: public / registered desk / voting admin.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import {
  audienceOf,
  homeDestination,
  isOfficer,
  mainNav,
  postLoginPath,
  safeNextPath,
} from '../public/audience.js';
import { FAQ_ENTRIES, FAQ_REQUIRED_TOPICS, faqCorpus } from '../public/faq.js';
import { parseRoute } from '../public/router.js';
import { audienceOfUser, userIsOfficer } from '../src/roles.mjs';
import { createApp } from '../src/server.mjs';

function loc(pathname, search = '') {
  return { pathname, hash: '', search };
}

let tmp;
let server;
let base;
const adminJar = {};
const voterJar = {};

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

describe('audience helpers and FAQ', () => {
  test('FAQ has many entries covering the required topics', () => {
    assert.ok(FAQ_ENTRIES.length >= 20, `expected ≥20 FAQ entries, got ${FAQ_ENTRIES.length}`);
    const topics = new Set(FAQ_ENTRIES.map((e) => e.topic));
    for (const topic of FAQ_REQUIRED_TOPICS) {
      assert.ok(topics.has(topic), `missing FAQ topic ${topic}`);
    }
    const corpus = faqCorpus();
    assert.match(corpus, /MockVerifier/);
    assert.match(corpus, /AGPL/);
    assert.match(corpus, /passkey/i);
    assert.match(corpus, /ranked/i);
    assert.match(corpus, /hour/i);
    assert.match(corpus, /not for profit/i);
    assert.match(corpus, /court-ready/i);
    assert.ok(FAQ_ENTRIES.every((e) => e.q && String(e.a || '').length + (Array.isArray(e.a) ? e.a.join('').length : 0) > 40));
  });

  test('parseRoute maps public, desk, and office paths without stealing vote deep links', () => {
    assert.equal(parseRoute(loc('/')).name, 'home');
    assert.equal(parseRoute(loc('/public')).name, 'publicHome');
    assert.equal(parseRoute(loc('/about')).name, 'about');
    assert.equal(parseRoute(loc('/faq')).name, 'faq');
    assert.equal(parseRoute(loc('/signin')).name, 'signin');
    assert.equal(parseRoute(loc('/me')).name, 'desk');
    assert.equal(parseRoute(loc('/app')).name, 'desk');
    assert.equal(parseRoute(loc('/office')).name, 'office');
    assert.equal(parseRoute(loc('/office/pages')).name, 'officePages');
    assert.equal(parseRoute(loc('/office/site')).name, 'officeSite');
    assert.equal(parseRoute(loc('/p/hours')).name, 'cmsPage');
    assert.equal(parseRoute(loc('/register')).name, 'register');
    const uuid = '3f1c0a6e-9b2d-4e11-8c7a-1a2b3c4d5e01';
    assert.equal(parseRoute(loc(`/vote/${uuid}`)).name, 'vote');
    assert.equal(parseRoute(loc(`/vote/${uuid}`)).params.id, uuid);
    assert.equal(parseRoute(loc('/v/nbrdge2k3m')).name, 'vote');
    assert.equal(parseRoute(loc(`/elections/${uuid}/results`)).name, 'results');
    assert.equal(parseRoute(loc(`/elections/${uuid}/info`)).name, 'election-info');
  });

  test('logged-out vs logged-in home destination', () => {
    assert.equal(audienceOf(null), 'public');
    assert.equal(audienceOf({ user: null }), 'public');
    assert.equal(audienceOf({ user: { handle: 'ada', role: 'voter' } }), 'registered');
    assert.equal(
      audienceOf({ user: { handle: 'admin', role: 'platform_admin' }, officer: true, audience: 'officer' }),
      'officer',
    );
    assert.equal(homeDestination('public'), '/');
    assert.equal(homeDestination('registered'), '/me');
    assert.equal(homeDestination('officer'), '/me');
    assert.equal(postLoginPath({ user: { role: 'voter' } }, null), '/me');
    assert.equal(postLoginPath({ user: { role: 'voter' } }, '/admin'), '/me');
    assert.equal(postLoginPath({ user: { role: 'voter' } }, '/back-office'), '/me');
    assert.equal(
      postLoginPath({ user: { role: 'platform_admin' }, officer: true, audience: 'officer' }, '/admin'),
      '/admin',
    );
    assert.equal(safeNextPath('https://evil.example/'), null);
    assert.equal(safeNextPath('//evil.example'), null);
  });

  test('nav items differ by audience', () => {
    const pub = mainNav('public').map((i) => i.label);
    assert.deepEqual(pub, ['About', 'FAQ', 'Sign in', 'Register']);
    const voter = mainNav('registered').map((i) => i.label);
    assert.deepEqual(voter, ['My desk', 'Register', 'Results']);
    const officer = mainNav('officer').map((i) => i.label);
    assert.ok(officer.includes('Admin'));
    assert.ok(!pub.includes('Admin'));
  });

  test('officer detection matches Node roles helper', () => {
    assert.equal(userIsOfficer(null), false);
    assert.equal(userIsOfficer({ role: 'voter' }), false);
    assert.equal(userIsOfficer({ role: 'platform_admin' }), true);
    assert.equal(userIsOfficer({ role: 'voter' }, [{ role: 'clerk', jurisdictionId: 'demo' }]), true);
    assert.equal(isOfficer({ user: { role: 'voter' }, jurisdictionRoles: [{ role: 'tally_operator' }] }), true);
    assert.equal(audienceOfUser({ role: 'observer' }), 'registered');
    assert.equal(audienceOfUser({ role: 'clerk' }), 'officer');
  });
});

describe('audience HTTP routes and admin gates', () => {
  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'republic-audience-'));
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
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await rm(tmp, { recursive: true, force: true });
  });

  test('public SPA routes render HTML', async () => {
    for (const url of ['/', '/public', '/about', '/faq', '/signin', '/me', '/app', '/register']) {
      const page = await api('GET', url);
      assert.equal(page.status, 200, url);
      assert.match(page.res.headers.get('content-type') || '', /html/, url);
      assert.match(page.text, /NOT FOR PROFIT/, url);
      assert.match(page.text, /About/, url);
      assert.match(page.text, /FAQ/, url);
    }
    const vote = await api('GET', '/vote/3f1c0a6e-9b2d-4e11-8c7a-1a2b3c4d5e01');
    assert.equal(vote.status, 200);
    assert.match(vote.text, /NOT FOR PROFIT/);
    const results = await api('GET', '/elections/3f1c0a6e-9b2d-4e11-8c7a-1a2b3c4d5e01/results');
    assert.equal(results.status, 200);
  });

  test('GET /api/me unauthenticated is the public audience', async () => {
    const { status, json } = await api('GET', '/api/me');
    assert.equal(status, 200);
    assert.equal(json.user, null);
    assert.equal(json.audience, 'public');
    assert.equal(json.officer, false);
  });

  test('admin HTML is gated to sign-in when logged out', async () => {
    for (const url of ['/admin', '/back-office', '/office']) {
      const page = await api('GET', url, { redirect: 'manual' });
      assert.equal(page.status, 302, url);
      const location = page.res.headers.get('location') || '';
      assert.match(location, /\/signin\?next=/, url);
    }
    const stillPublic = await api('GET', '/about', { redirect: 'manual' });
    assert.equal(stillPublic.status, 200);
  });

  test('POST /api/elections still requires auth', async () => {
    const { status } = await api('POST', '/api/elections', { body: { title: 'x' } });
    assert.equal(status, 401);
  });

  test('dev-login voter vs officer audiences and HTML gates', async () => {
    const voter = await api('POST', '/api/auth/dev-login', {
      body: { handle: 'voter-desk', role: 'voter' },
      jar: voterJar,
    });
    assert.equal(voter.status, 200);
    const voterMe = await api('GET', '/api/me', { jar: voterJar });
    assert.equal(voterMe.json.audience, 'registered');
    assert.equal(voterMe.json.officer, false);

    const admin = await api('POST', '/api/auth/dev-login', {
      body: { handle: 'admin' },
      jar: adminJar,
    });
    assert.equal(admin.status, 200);
    const adminMe = await api('GET', '/api/me', { jar: adminJar });
    assert.equal(adminMe.json.audience, 'officer');
    assert.equal(adminMe.json.officer, true);
    assert.equal(adminMe.json.user.role, 'platform_admin');

    const voterAdmin = await api('GET', '/admin', { jar: voterJar, redirect: 'manual' });
    assert.equal(voterAdmin.status, 200);
    assert.match(voterAdmin.text, /officer-gate/);
    assert.match(voterAdmin.text, /Officer access required/);

    const officerAdmin = await api('GET', '/admin', { jar: adminJar, redirect: 'manual' });
    assert.equal(officerAdmin.status, 200);
    assert.match(officerAdmin.text, /office-work/);
    assert.match(officerAdmin.text, /Host this Node/);

    const officerOffice = await api('GET', '/office', { jar: adminJar, redirect: 'manual' });
    assert.equal(officerOffice.status, 200);
    assert.match(officerOffice.text, /NOT FOR PROFIT/);

    const voterOffice = await api('GET', '/office', { jar: voterJar, redirect: 'manual' });
    assert.equal(voterOffice.status, 200);
  });
});

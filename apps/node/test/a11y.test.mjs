// NOT FOR PROFIT — civic public good, not a commercial product.
// WCAG 2.2 AA axe checks for the voter, registered, admin, and public shells.
// Requires Chrome (google-chrome or CHROME_PATH). Headless; no display.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import puppeteer from 'puppeteer-core';

import { createApp } from '../src/server.mjs';

const require = createRequire(import.meta.url);
const axePath = require.resolve('axe-core');

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const bin of ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser']) {
    try {
      const found = execFileSync('bash', ['-lc', `command -v ${bin}`], { encoding: 'utf8' }).trim();
      if (found) return found;
    } catch {
      /* try the next name */
    }
  }
  throw new Error('Chrome is required for axe checks. Set CHROME_PATH or install google-chrome.');
}

async function launchChrome() {
  const options = {
    executablePath: chromePath(),
    headless: true,
    timeout: 90_000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  };
  try {
    return await puppeteer.launch(options);
  } catch (err) {
    const message = String(err?.message || err);
    if (!message.includes('WS endpoint')) throw err;
    return puppeteer.launch(options);
  }
}

function listen(application) {
  return new Promise((resolve, reject) => {
    const s = application.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
}

function formatViolations(violations) {
  return violations
    .map((v) => {
      const nodes = v.nodes
        .slice(0, 4)
        .map((n) => `    ${n.target.join(' ')} :: ${n.html.replace(/\s+/g, ' ').slice(0, 180)}`)
        .join('\n');
      return `[${v.impact}] ${v.id} x${v.count}\n${nodes}`;
    })
    .join('\n');
}

let tmp;
let server;
let base;
let browser;
let electionId;
let adminCookie;
let voterCookie;

async function login(handle, role) {
  const res = await fetch(`${base}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(role ? { handle, role } : { handle }),
  });
  const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const pair = (set[0] || '').split(';')[0];
  const i = pair.indexOf('=');
  assert.ok(i > 0, `dev-login cookie for ${handle}`);
  return { name: pair.slice(0, i).trim(), value: decodeURIComponent(pair.slice(i + 1).trim()) };
}

async function settle(page) {
  await page.waitForFunction(
    () => {
      const main = document.querySelector('#main');
      const text = (main && main.innerText) || '';
      return text.length > 20 && !/^Loading/.test(text.trim());
    },
    { timeout: 15000 },
  );
}

async function applySession(page, cookie) {
  const existing = await page.cookies(base);
  if (existing.length) await page.deleteCookie(...existing);
  if (cookie) {
    await page.setCookie({
      name: cookie.name,
      value: cookie.value,
      url: base,
      httpOnly: true,
    });
  }
}

async function audit(page, url, { cookie, scheme = 'light' } = {}) {
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
  await applySession(page, cookie);
  // /site-admin ships a strict CSP (script-src 'self'); let the test inject axe.
  await page.setBypassCSP(true);
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
  await settle(page);
  await page.addScriptTag({ path: axePath });
  const violations = await page.evaluate(async (tags) => {
    const out = await window.axe.run(document, {
      runOnly: { type: 'tag', values: tags },
      resultTypes: ['violations'],
    });
    return out.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      count: v.nodes.length,
      nodes: v.nodes.slice(0, 4).map((n) => ({
        target: n.target.map(String),
        html: n.html,
      })),
    }));
  }, AXE_TAGS);
  assert.deepEqual(violations, [], `${scheme} ${url}\n${formatViolations(violations)}`);
}

describe('WCAG 2.2 AA axe', () => {
  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'republic-a11y-'));
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
    adminCookie = await login('admin');
    voterCookie = await login('voter-a11y', 'voter');
    const now = Math.floor(Date.now() / 1000);
    const createdElection = await fetch(`${base}/api/elections`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `${adminCookie.name}=${adminCookie.value}`,
      },
      body: JSON.stringify({
        title: 'Accessibility sample',
        startTime: now - 120,
        cutoffTime: now + 86400,
        maxParticipants: 0,
        treeDepth: 16,
        jurisdictionId: 'demo',
        questions: [
          { type: 'YES_NO', prompt: 'Adopt the measure?' },
          {
            type: 'RANKED',
            prompt: 'Rank the candidates',
            options: [
              { id: 'a', label: 'Ada' },
              { id: 'b', label: 'Bao' },
            ],
          },
        ],
      }),
    });
    const body = await createdElection.json();
    assert.equal(createdElection.status, 201, body?.error);
    electionId = body.election.id;

    browser = await launchChrome();
  });

  after(async () => {
    if (browser) await browser.close();
    if (server) {
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  const cases = [
    ['public home', '/'],
    ['public calendar', '/public'],
    ['about', '/about'],
    ['faq', '/faq'],
    ['sign in', '/signin'],
    ['register', '/register'],
    ['terms', '/terms'],
    ['feedback', '/feedback'],
    ['receipt', '/receipt'],
    ['outcomes', '/outcomes'],
    ['registered desk', '/me', 'voter'],
    ['registered register', '/register', 'voter'],
    ['ballot', null, 'voter'],
    ['results', null, 'voter'],
    ['platform admin', '/admin', 'admin'],
    ['back office', '/back-office', 'admin'],
    ['admin hub', '/office', 'admin'],
    ['explorer', '/explorer', 'admin'],
    ['site admin roles', '/site-admin/roles', 'admin'],
    ['site admin layout', '/site-admin/layout', 'admin'],
    ['site admin plugins', '/site-admin/plugins', 'admin'],
    ['site admin audit', '/site-admin/audit', 'admin'],
  ];

  for (const scheme of ['light', 'dark']) {
    for (const [name, pathname, who] of cases) {
      test(`${scheme} ${name}`, async () => {
        const page = await browser.newPage();
        try {
          await page.setViewport({ width: 1280, height: 900 });
          const pathName =
            pathname ||
            (name === 'ballot' ? `/vote/${electionId}` : `/elections/${electionId}/results`);
          const cookie = who === 'admin' ? adminCookie : who === 'voter' ? voterCookie : null;
          await audit(page, `${base}${pathName}`, { cookie, scheme });
        } finally {
          await page.close();
        }
      });
    }
  }

  test('keyboard skip link, language listbox, and route focus', async () => {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    try {
      await page.bringToFront();
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(`${base}/`, { waitUntil: 'networkidle0', timeout: 30000 });
      await settle(page);
      // Route render focuses #main, so Tab continues from there.
      // A visitor tabbing in from the top of the document hits the skip link first.
      await page.evaluate(() => {
        const start = document.createElement('span');
        start.tabIndex = 0;
        start.id = 'a11y-tab-start';
        start.setAttribute('aria-hidden', 'true');
        start.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden';
        document.body.prepend(start);
        start.focus();
      });

      await page.keyboard.press('Tab');
      const skip = await page.evaluate(() => ({
        className: document.activeElement?.className || '',
        text: document.activeElement?.textContent || '',
      }));
      assert.match(skip.className, /skip/);
      assert.match(skip.text, /Skip to main content/);
      await page.keyboard.press('Enter');
      const afterSkip = await page.evaluate(() => document.activeElement?.id);
      assert.equal(afterSkip, 'main');

      await page.focus('[data-testid="language-toggle"]');
      await page.keyboard.press('Enter');
      await page.waitForSelector('#lang-menu:not([hidden])');
      const first = await page.evaluate(() => ({
        locale: document.activeElement?.dataset?.locale || '',
        testid: document.activeElement?.dataset?.testid || '',
        cls: document.activeElement?.className || '',
      }));
      assert.equal(first.locale, 'en', JSON.stringify(first));
      await page.keyboard.press('ArrowDown');
      const second = await page.evaluate(() => document.activeElement?.dataset?.locale);
      assert.equal(second, 'es');
      await page.keyboard.press('Escape');
      const closed = await page.evaluate(() => ({
        hidden: document.getElementById('lang-menu')?.hidden,
        toggle: document.activeElement?.dataset?.testid,
        expanded: document.querySelector('.lang-toggle')?.getAttribute('aria-expanded'),
      }));
      assert.equal(closed.hidden, true);
      assert.equal(closed.toggle, 'language-toggle');
      assert.equal(closed.expanded, 'false');

      await page.keyboard.press('Enter');
      await page.focus('[data-testid="language-option-ar"]');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.documentElement.dir === 'rtl');
      const rtl = await page.evaluate(() => ({
        lang: document.documentElement.lang,
        dir: document.documentElement.dir,
        mainLang: document.getElementById('main')?.getAttribute('lang'),
        skip: document.querySelector('.skip-link')?.textContent || '',
        about: document.querySelector('.nav-main a[href="/about"]')?.textContent || '',
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
      }));
      assert.equal(rtl.lang, 'ar');
      assert.equal(rtl.dir, 'rtl');
      assert.equal(rtl.mainLang, 'en');
      assert.match(rtl.skip, /المحتوى/);
      assert.equal(rtl.about, 'حول');
      assert.equal(rtl.overflow, false);

      await page.click('a[href="/faq"]');
      await settle(page);
      const focused = await page.evaluate(() => document.activeElement?.id);
      assert.equal(focused, 'main');
      const beforeToggle = await page.$eval('#faq-list details', (el) => el.open);
      await page.focus('#faq-list details summary');
      await page.keyboard.press('Enter');
      const afterToggle = await page.$eval('#faq-list details', (el) => el.open);
      assert.notEqual(afterToggle, beforeToggle);
    } finally {
      await page.close();
      await context.close();
    }
  });

  test('ranked ballot controls name the candidate', async () => {
    const page = await browser.newPage();
    try {
      await page.setViewport({ width: 1280, height: 900 });
      await applySession(page, voterCookie);
      await page.goto(`${base}/vote/${electionId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await settle(page);
      const labels = await page.$$eval('.rank-btn', (els) => els.map((el) => el.getAttribute('aria-label') || ''));
      assert.ok(labels.some((label) => /Ada/.test(label)), labels.join(' | '));
      assert.ok(labels.some((label) => /Bao/.test(label)), labels.join(' | '));
    } finally {
      await page.close();
    }
  });
});

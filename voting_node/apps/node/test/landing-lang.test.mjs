// NOT FOR PROFIT — civic public good, not a commercial product.
// The public landing page loads, follows the browser language, and switches.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import puppeteer from 'puppeteer-core';

const siteDir = fileURLToPath(new URL('../../../../site/public/', import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

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
  throw new Error('Chrome is required. Set CHROME_PATH or install google-chrome.');
}

function listen() {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.endsWith('/')) pathname += 'index.html';
      const rel = pathname.replace(/^\/+/, '');
      const root = siteDir.endsWith('/') ? siteDir : `${siteDir}/`;
      const file = normalize(join(root, rel));
      if (file !== root.slice(0, -1) && !file.startsWith(root)) {
        res.writeHead(403);
        res.end();
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': TYPES[extname(file)] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

async function launch() {
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

async function openPage(browser, acceptLanguage, stored) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const userAgent = await browser.userAgent();
  const session = await page.createCDPSession();
  await session.send('Emulation.setUserAgentOverride', { userAgent, acceptLanguage });
  if (stored) {
    await page.evaluateOnNewDocument((code) => {
      localStorage.setItem('site_lang', code);
    }, stored);
  }
  return page;
}

let server;
let base;
let browser;

before(async () => {
  server = await listen();
  const address = server.address();
  base = `http://127.0.0.1:${address.port}/`;
  browser = await launch();
});

after(async () => {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
});

test('landing page detects Arabic, switches to Spanish, and keeps that choice', { timeout: 60_000 }, async () => {
  const detected = await openPage(browser, 'ar-SA,en;q=0.8');
  await detected.goto(base, { waitUntil: 'networkidle0' });
  await detected.waitForSelector('#lang-switcher');
  const arabic = await detected.evaluate(() => {
    const brand = document.querySelector('.brand').getBoundingClientRect();
    const select = document.querySelector('#lang-switcher').getBoundingClientRect();
    return {
      lang: document.documentElement.lang,
      dir: document.documentElement.dir,
      title: document.title,
      alt: document.querySelector('.logo').alt,
      og: document.querySelector('meta[data-og-current]').content,
      value: document.querySelector('#lang-switcher').value,
      poll: document.querySelector('#poll-vs-vote select').value,
      brandX: brand.x,
      selectX: select.x,
      ballot: getComputedStyle(document.querySelector('.ballot-visual')).transform,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  assert.equal(arabic.lang, 'ar');
  assert.equal(arabic.dir, 'rtl');
  assert.equal(arabic.value, 'ar');
  assert.equal(arabic.poll, 'ar');
  assert.match(arabic.title, /[\u0600-\u06FF]/);
  assert.match(arabic.alt, /شعار/);
  assert.equal(arabic.og, 'ar_AR');
  assert.ok(arabic.brandX > arabic.selectX, 'brand sits on the right in Arabic');
  assert.match(arabic.ballot, /matrix\(-1/);
  assert.ok(arabic.overflow <= 1, `horizontal overflow ${arabic.overflow}`);

  await detected.select('#lang-switcher', 'es');
  const spanish = await detected.evaluate(() => ({
    lang: document.documentElement.lang,
    dir: document.documentElement.dir,
    title: document.title,
    stored: localStorage.getItem('site_lang'),
    poll: document.querySelector('#poll-vs-vote select').value,
    contact: document.querySelector('#footer-contact-label').textContent,
    og: document.querySelector('meta[property="og:title"]').content,
  }));
  assert.equal(spanish.lang, 'es');
  assert.equal(spanish.dir, 'ltr');
  assert.equal(spanish.stored, 'es');
  assert.equal(spanish.poll, 'es');
  assert.match(spanish.title, /boletas privadas/);
  assert.equal(spanish.contact, 'Contacto');
  assert.match(spanish.og, /boletas privadas/);

  await detected.reload({ waitUntil: 'networkidle0' });
  const kept = await detected.evaluate(() => ({
    lang: document.documentElement.lang,
    stored: localStorage.getItem('site_lang'),
  }));
  assert.equal(kept.lang, 'es');
  assert.equal(kept.stored, 'es');
  await detected.browserContext().close();

  const saved = await openPage(browser, 'ar-SA,en;q=0.8', 'fr');
  await saved.goto(base, { waitUntil: 'networkidle0' });
  const french = await saved.evaluate(() => ({
    lang: document.documentElement.lang,
    dir: document.documentElement.dir,
    value: document.querySelector('#lang-switcher').value,
  }));
  assert.equal(french.lang, 'fr');
  assert.equal(french.dir, 'ltr');
  assert.equal(french.value, 'fr');
  await saved.browserContext().close();

  const unknown = await openPage(browser, 'de-DE,de;q=0.9');
  await unknown.goto(base, { waitUntil: 'networkidle0' });
  const english = await unknown.evaluate(() => ({
    lang: document.documentElement.lang,
    dir: document.documentElement.dir,
    title: document.title,
    value: document.querySelector('#lang-switcher').value,
  }));
  assert.equal(english.lang, 'en');
  assert.equal(english.dir, 'ltr');
  assert.equal(english.value, 'en');
  assert.match(english.title, /private ballots/);
  await unknown.setViewport({ width: 390, height: 800 });
  const narrow = await unknown.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(narrow <= 1, `narrow overflow ${narrow}`);
  await unknown.browserContext().close();
});

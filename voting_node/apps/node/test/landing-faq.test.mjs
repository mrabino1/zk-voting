// NOT FOR PROFIT — civic public good, not a commercial product.
// /faq on the marketing site: left section list, page on the right.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { LOCALE_CODES, flattenKeys, lookup, translate, translateMarkup } from '../../../../site/public/i18n.js';
import faqEn from '../../../../site/public/locales/faq/en.js';
import faqEs from '../../../../site/public/locales/faq/es.js';
import faqZh from '../../../../site/public/locales/faq/zh.js';
import faqFil from '../../../../site/public/locales/faq/fil.js';
import faqVi from '../../../../site/public/locales/faq/vi.js';
import faqAr from '../../../../site/public/locales/faq/ar.js';
import faqFr from '../../../../site/public/locales/faq/fr.js';
import faqKo from '../../../../site/public/locales/faq/ko.js';
import faqPt from '../../../../site/public/locales/faq/pt.js';
import faqHi from '../../../../site/public/locales/faq/hi.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const faqHtml = readFileSync(join(root, 'site/public/faq.html'), 'utf8');
const indexHtml = readFileSync(join(root, 'site/public/index.html'), 'utf8');
const css = readFileSync(join(root, 'site/public/styles.css'), 'utf8');
const nginx = readFileSync(join(root, 'site/nginx.conf'), 'utf8');

const FAQ = { en: faqEn, es: faqEs, zh: faqZh, fil: faqFil, vi: faqVi, ar: faqAr, fr: faqFr, ko: faqKo, pt: faqPt, hi: faqHi };

const NAV = [
  'Welcome',
  'Quick Links',
  'Glossary',
  'General',
  'Elections',
  'Registration',
  'Ballots',
  'Polls',
  'Votes',
  'Results',
  'Privacy',
  'Officers',
  'Disqualification',
  'Receipts',
  'Not a token',
  'Community',
  'Where it runs',
  'How it fits',
  'Roadmap',
  'Builder kit',
  'How to deploy',
];

function usedKeys(html) {
  const used = [];
  for (const attr of ['data-i18n', 'data-i18n-html', 'data-i18n-content', 'data-i18n-aria-label', 'data-i18n-alt']) {
    used.push(...[...html.matchAll(new RegExp(`${attr}="([^"]+)"`, 'g'))].map((match) => match[1]));
  }
  return used;
}

test('faq page keeps the section list on the left and one page on the right', () => {
  assert.match(nginx, /try_files \$uri \$uri\.html \$uri\/ \/index\.html/);
  assert.match(indexHtml, /href="\/faq"/);
  assert.match(faqHtml, /class="docs"/);
  assert.match(faqHtml, /<details class="docs-drawer" open>/);
  assert.match(faqHtml, /class="docs-nav"/);
  assert.match(faqHtml, /class="docs-content"/);
  assert.ok(faqHtml.indexOf('class="docs-nav"') < faqHtml.indexOf('class="docs-content"'));
  assert.match(css, /\.docs\{display:grid;grid-template-columns:minmax\(220px,280px\)/);
  assert.match(css, /@supports selector\(:has\(\*\)\)/);
  for (const label of NAV) {
    assert.match(faqHtml, new RegExp(`data-i18n="faq\\.[^"]+\\.nav">${label}</a>`));
  }
  assert.match(faqHtml, /There is nothing to deposit/);
  assert.match(faqHtml, /Do not deploy a lending pool/);
  assert.doesNotMatch(faqHtml, /Ajna|price bucket to lend|borrow against/i);
  assert.match(faqHtml, /href="#quick-links"/);
  assert.match(faqHtml, /id="quick-links"/);
  assert.match(faqHtml, /community\.zk-voting\.org/);
  assert.match(faqHtml, /github\.com\/mrabino1\/zk-voting/);
});

test('faq catalogs share keys and the English page text matches', () => {
  const enKeys = flattenKeys(faqEn).sort();
  assert.equal(enKeys.length, 255);
  const used = usedKeys(faqHtml);
  for (const key of used) {
    if (key.startsWith('faq.')) assert.equal(typeof lookup(faqEn, key), 'string', key);
    else assert.equal(typeof translate('en', key), 'string');
  }
  const usedFaq = new Set(used.filter((key) => key.startsWith('faq.')));
  for (const key of enKeys) assert.ok(usedFaq.has(key), `faq.html does not use ${key}`);
  for (const code of LOCALE_CODES) {
    assert.deepEqual(flattenKeys(FAQ[code]).sort(), enKeys, code);
    for (const key of enKeys) {
      const value = lookup(FAQ[code], key);
      assert.equal(typeof value, 'string');
      assert.ok(value.trim().length > 0, `${code} ${key}`);
      assert.doesNotMatch(value, /https?:\/\/|@[a-z0-9.-]+\.[a-z]{2,}/i, `${code} ${key}`);
      assert.doesNotMatch(value, /ZK-Voting/, `${code} ${key}`);
      if (code !== 'en') assert.notEqual(value, lookup(faqEn, key), `${code} ${key} copied English`);
    }
  }
  const text = [...faqHtml.matchAll(/data-i18n="(faq\.[^"]+)">([^<]*)</g)];
  assert.ok(text.length > 200);
  for (const [, key, raw] of text) {
    assert.equal(raw, translate('en', key, 'ZK-Voting'), key);
  }
  const es = translateMarkup(faqHtml, 'es');
  assert.match(es, /Enlaces rápidos/);
  assert.match(es, /No hay nada que depositar/);
  assert.doesNotMatch(es, /Quick Links/);
  const ar = translateMarkup(faqHtml, 'ar');
  assert.match(ar, /<html dir="rtl" lang="ar">/);
  assert.match(ar, /[\u0600-\u06FF]/);
});

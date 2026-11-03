// NOT FOR PROFIT — civic public good, not a commercial product.
// Landing-page catalogs stay in lockstep with the Node UI language list.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { RTL_LOCALES as APP_RTL, SUPPORTED_LOCALES } from '../public/i18n.js';
import {
  HTML_LANG,
  LOCALE_CODES,
  OG_LOCALE,
  RTL_LOCALES,
  catalogs,
  flattenKeys,
  initialLocale,
  lookup,
  matchNavigatorLocale,
  translateMarkup,
} from '../../../../site/public/i18n.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const pagePath = join(root, 'site/public/index.html');
const I18N_ATTRS = ['data-i18n', 'data-i18n-html', 'data-i18n-content', 'data-i18n-aria-label', 'data-i18n-alt'];

function usedKeys(html) {
  const used = [];
  for (const attr of I18N_ATTRS) {
    used.push(...[...html.matchAll(new RegExp(`${attr}="([^"]+)"`, 'g'))].map((match) => match[1]));
  }
  return used;
}

test('every landing locale has the same keys as English and the Node UI list', () => {
  assert.deepEqual([...LOCALE_CODES], [...SUPPORTED_LOCALES]);
  assert.deepEqual([...RTL_LOCALES], [...APP_RTL]);
  assert.deepEqual(Object.keys(HTML_LANG).sort(), [...LOCALE_CODES].sort());
  assert.deepEqual(Object.keys(OG_LOCALE).sort(), [...LOCALE_CODES].sort());

  const dicts = catalogs();
  const enKeys = flattenKeys(dicts.en).sort();
  assert.ok(enKeys.length >= 175);
  const html = readFileSync(pagePath, 'utf8');
  const used = usedKeys(html);
  const usedSet = new Set(used);
  for (const key of used) {
    assert.equal(typeof lookup(dicts.en, key), 'string', `missing ${key}`);
  }
  for (const key of enKeys) {
    if (key.startsWith('lang.') && key !== 'lang.label') continue;
    assert.ok(usedSet.has(key), `landing page does not use ${key}`);
  }
  for (const code of LOCALE_CODES) {
    assert.deepEqual(flattenKeys(dicts[code]).sort(), enKeys, `${code} key set`);
    for (const key of enKeys) {
      const value = lookup(dicts[code], key);
      assert.equal(typeof value, 'string', `${code} ${key}`);
      assert.ok(value.trim().length > 0, `${code} ${key} empty`);
    }
  }
});

test('saved choice wins, then the browser language, then English', () => {
  assert.equal(initialLocale('es', ['ar', 'en']), 'es');
  assert.equal(initialLocale('en', ['fr']), 'en');
  assert.equal(initialLocale('nope', ['fr-CA', 'en-US']), 'fr');
  assert.equal(initialLocale(null, ['tl-PH', 'en']), 'fil');
  assert.equal(initialLocale(undefined, ['zh-Hant-TW', 'en']), 'zh');
  assert.equal(initialLocale('', ['pt_PT']), 'pt');
  assert.equal(initialLocale(null, ['de-DE', 'de']), 'en');
  assert.equal(initialLocale(null, []), 'en');
  assert.equal(initialLocale(null, undefined), 'en');
  assert.equal(matchNavigatorLocale(['ar-EG']), 'ar');
  assert.equal(HTML_LANG.ar, 'ar');
  assert.equal(HTML_LANG.zh, 'zh-Hans');
  assert.equal(HTML_LANG.pt, 'pt-BR');
  assert.equal(OG_LOCALE.ar, 'ar_AR');
  assert.equal(OG_LOCALE.pt, 'pt_BR');
});

test('translated markup sets lang, dir, alt text, title, and open graph copy', () => {
  const html = readFileSync(pagePath, 'utf8');
  assert.match(html, /localStorage\.getItem\("site_lang"\)/);
  assert.match(html, /fil", "tl"/);
  assert.match(html, /property="og:title"/);
  assert.match(html, /property="og:description"/);
  assert.match(html, /data-i18n-alt="nav\.logoAlt"/);
  assert.match(html, /data-i18n="nav\.skip"/);

  const arabic = translateMarkup(html, 'ar');
  assert.match(arabic, /<html dir="rtl" lang="ar">/);
  assert.match(arabic, /alt="شعار ZK-Voting"/);
  assert.match(arabic, /data-og-current content="ar_AR"/);
  assert.match(arabic, /بطاقات اقتراع/);
  assert.match(arabic, /إيثريوم الطبقة 1/);

  const spanish = translateMarkup(html, 'es', 'Civic Desk');
  assert.match(spanish, /<html dir="ltr" lang="es">/);
  assert.match(spanish, /<title[^>]*>Civic Desk: boletas privadas/);
  assert.match(spanish, /property="og:title"[^>]*content="Civic Desk: boletas privadas/);
  assert.match(spanish, /property="og:description"[^>]*content="Civic Desk es un sistema/);
  assert.match(spanish, /alt="Logotipo de Civic Desk"/);
  assert.match(spanish, /aria-label="Inicio de Civic Desk"/);
  assert.match(spanish, /Capa 1 de Ethereum/);
  assert.doesNotMatch(spanish, /\brepublic\b/i);
  assert.doesNotMatch(spanish, /zkvoting\.com/i);
  assert.doesNotMatch(spanish, /ZK-VOTE/);
});

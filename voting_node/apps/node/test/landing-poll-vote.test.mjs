// NOT FOR PROFIT — civic public good, not a commercial product.
// Poll vs Vote section on the public landing page: structure, accessible
// name, and the same ten locales as the Node UI.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { SUPPORTED_LOCALES } from '../public/i18n.js';
import { DEFAULT_BRAND_NAME, brandName } from '../../../../site/public/brand.js';
import {
  HTML_LANG,
  LOCALE_CODES,
  catalogs,
  flattenKeys,
  lookup,
  sectionDirection,
  translateMarkup,
} from '../../../../site/public/i18n.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const siteDir = join(root, 'site/public');
const pagePath = join(siteDir, 'index.html');
const cssPath = join(siteDir, 'styles.css');

const BANNED = new RegExp("zk" + "-?" + "vote" + "|" + "zk" + "voting" + "|" + "re" + "public" + "|" + "\\bcertified\\b", "i");

function pageHtml() {
  return readFileSync(pagePath, 'utf8');
}

function regionOf(html) {
  const start = html.indexOf('id="poll-vs-vote"');
  const end = html.indexOf('<ol class="steps"');
  assert.ok(start > 0 && end > start, 'poll vs vote region sits above the steps');
  return html.slice(start, end);
}

function accessibleName(html) {
  const open = html.match(/<svg\b[^>]*\bid="ballot-flow"[^>]*>/);
  assert.ok(open, 'flow svg');
  assert.match(open[0], /\brole="img"/);
  assert.match(open[0], /\baria-labelledby="flow-title flow-desc"/);
  const parts = ['flow-title', 'flow-desc'].map((id) => {
    const re = new RegExp(`<([a-zA-Z0-9:-]+)\\b[^>]*\\bid="${id}"[^>]*>([^<]*)</\\1>`);
    const found = html.match(re);
    assert.ok(found, `accessible name part #${id}`);
    return found[2].trim();
  });
  return parts.join(' ').replace(/\s+/g, ' ');
}

test('renders the poll vs vote section, both columns, and the named flow graphic', () => {
  const html = translateMarkup(pageHtml(), 'en');
  const region = regionOf(html);
  assert.match(region, /id="poll-vs-vote"/);
  assert.match(region, /id="poll-column"/);
  assert.match(region, /id="vote-column"/);
  assert.match(region, /class="ballot-compare"/);
  assert.ok(region.indexOf('id="poll-column"') < region.indexOf('id="vote-column"'));
  const name = accessibleName(region);
  assert.match(name, /Ballot flow for a poll and a vote/);
  assert.match(name, /final tally/i);
  assert.doesNotMatch(name, /certified/i);
  assert.doesNotMatch(region, BANNED);
  assert.match(region, /k-of-n guardians/);
  assert.match(region, /100 ballots/);
  assert.match(region, /30 minutes/);
  assert.match(region, /fewer than 10 ballots/);
  assert.match(region, /challenge window/i);
  assert.match(region, /re-vote/);
  assert.match(region, /receipt/i);
});

test('Spanish render keeps both columns and translates the accessible name', () => {
  const html = translateMarkup(pageHtml(), 'es');
  const region = regionOf(html);
  const poll = region.split('id="vote-column"')[0];
  const vote = region.split('id="vote-column"')[1];
  assert.match(poll, />Encuesta</);
  assert.match(vote, />Votación</);
  const name = accessibleName(region);
  assert.match(name, /encuesta/i);
  assert.match(name, /escrutinio final/i);
  assert.doesNotMatch(name, /Ballot flow/);
  assert.match(html, /data-brand>ZK-Voting</);
});

test('display name is filled from the branding helper', () => {
  assert.equal(brandName(), DEFAULT_BRAND_NAME);
  const html = pageHtml();
  assert.ok(html.includes(`<span data-brand>${DEFAULT_BRAND_NAME}</span>`));
  assert.match(html, /<meta name="brand-name" content="ZK-Voting">/);
  const branded = translateMarkup(html, 'en', 'Civic Desk');
  assert.match(branded, /data-brand>Civic Desk</);
  assert.match(branded, /aria-label="Civic Desk on GitHub"/);
  assert.doesNotMatch(regionOf(branded), /ZK-Voting/);
});

test('poll vs vote copy covers the same keys in all 10 locales', () => {
  assert.deepEqual([...LOCALE_CODES], [...SUPPORTED_LOCALES]);
  assert.equal(LOCALE_CODES.length, 10);
  assert.equal(HTML_LANG.ar, 'ar');
  assert.equal(HTML_LANG.zh, 'zh-Hans');
  assert.equal(HTML_LANG.pt, 'pt-BR');
  assert.equal(sectionDirection('ar'), 'rtl');
  assert.equal(sectionDirection('en'), 'ltr');
  assert.equal(sectionDirection('he'), 'ltr');

  const dicts = catalogs();
  const enKeys = flattenKeys(dicts.en).sort();
  assert.ok(enKeys.length >= 40);
  const used = [...pageHtml().matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(used.length >= 30);
  for (const key of used) {
    assert.equal(typeof lookup(dicts.en, key), 'string', `missing ${key}`);
  }

  for (const code of LOCALE_CODES) {
    const keys = flattenKeys(dicts[code]).sort();
    assert.deepEqual(keys, enKeys, `${code} key set`);
    for (const key of enKeys) {
      const value = lookup(dicts[code], key);
      assert.equal(typeof value, 'string');
      assert.ok(value.trim().length > 0, `${code} ${key} empty`);
      assert.doesNotMatch(value, BANNED, `${code} ${key}`);
      assert.doesNotMatch(value, /https?:\/\/|@[a-z0-9.-]+\.[a-z]{2,}/i, `${code} ${key}`);
      if (code === 'en') continue;
      if (key.startsWith('lang.') && key !== 'lang.label') continue;
      assert.notEqual(value, lookup(dicts.en, key), `${code} ${key} is an English copy`);
    }
  }

  assert.match(lookup(dicts.ar, 'pollVote.poll.name'), /[\u0600-\u06FF]/);
  assert.match(lookup(dicts.zh, 'pollVote.poll.name'), /[\u4e00-\u9fff]/);
  assert.match(lookup(dicts.ko, 'pollVote.poll.name'), /[\uac00-\ud7af]/);
  assert.match(lookup(dicts.hi, 'pollVote.poll.name'), /[\u0900-\u097F]/);
});

test('comparison stacks on a narrow screen and motion can be reduced', () => {
  const css = readFileSync(cssPath, 'utf8');
  assert.match(css, /\.ballot-compare\{[^}]*grid-template-columns:1fr 1fr/);
  assert.match(css, /@media \(max-width:960px\)\{\s*\.ballot-compare\{grid-template-columns:1fr\}/);
  assert.match(css, /@media \(max-width:640px\)\{[^}]*\.both-grid\{grid-template-columns:1fr\}/);
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /\.flow-edge\{animation:none !important/);
});

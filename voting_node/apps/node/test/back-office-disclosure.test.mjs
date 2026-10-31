import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { SEALED_RANKED_DISCLOSURE, SEALED_RANKED_DISCLOSURE_KEY } from '../public/sealed-ranked-disclosure.js';

const src = readFileSync(new URL('../public/back-office.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/back-office.html', import.meta.url), 'utf8');
const start = src.indexOf('const SEALED_RANKED_DISCLOSURE_STATIC_EN');
const end = src.indexOf('fillSealedRankedDisclosure(document');
const block = src.slice(start, end);

function load() {
  const ctx = vm.createContext({});
  vm.runInContext(`${block};globalThis.fill=fillSealedRankedDisclosure;globalThis.STATIC=SEALED_RANKED_DISCLOSURE_STATIC_EN;`, ctx);
  return ctx;
}
function fakeDoc() {
  const slot = { textContent: '' };
  const ack = { disabled: true };
  return { slot, ack, doc: { getElementById: (id) => (id === 'e-sealed-ranked-disclosure-text' ? slot : id === 'e-sealed-ranked-ack' ? ack : null) } };
}
const mod = { SEALED_RANKED_DISCLOSURE, SEALED_RANKED_DISCLOSURE_KEY };

test('ack checkbox ships disabled; static fallback matches the English catalog', () => {
  assert.match(html, /id="e-sealed-ranked-ack"[^>]*\bdisabled\b/);
  assert.equal(load().STATIC, SEALED_RANKED_DISCLOSURE);
});

test('localized text fills the slot and enables the ack', async () => {
  const { slot, ack, doc } = fakeDoc();
  await load().fill(doc, async (p) => (p === '/i18n.js' ? { t: () => 'Texto localizado' } : mod));
  assert.equal(slot.textContent, 'Texto localizado');
  assert.equal(ack.disabled, false);
});

test('i18n load failure falls back to the English module text', async () => {
  const { slot, ack, doc } = fakeDoc();
  await load().fill(doc, async (p) => { if (p === '/i18n.js') throw new Error('boom'); return mod; });
  assert.equal(slot.textContent, SEALED_RANKED_DISCLOSURE);
  assert.equal(ack.disabled, false);
});

test('missing key and total load failure fall back to static English', async () => {
  const a = fakeDoc();
  await load().fill(a.doc, async (p) => (p === '/i18n.js' ? { t: (k) => k } : mod));
  assert.equal(a.slot.textContent, SEALED_RANKED_DISCLOSURE);
  const b = fakeDoc();
  await load().fill(b.doc, async () => { throw new Error('offline'); });
  assert.equal(b.slot.textContent, SEALED_RANKED_DISCLOSURE);
  assert.equal(b.ack.disabled, false);
});

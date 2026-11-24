// NOT FOR PROFIT — civic public good, not a commercial product.
// Layout nav.placement: a top bar (the default) or a left sidebar on wide screens. The server
// stamps it on <html> so the page never paints the wrong shell first.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { defaultLayout, mergeLayout, validateLayout } from '../src/layout.mjs';
import { createApp } from '../src/server.mjs';

test('nav placement defaults to top and accepts only top or sidebar', () => {
  assert.equal(defaultLayout().nav.placement, 'top');
  assert.equal(validateLayout({}).nav.placement, undefined, 'unset inherits');
  assert.equal(validateLayout({ nav: { placement: 'sidebar' } }).nav.placement, 'sidebar');
  assert.throws(() => validateLayout({ nav: { placement: 'bottom' } }), (err) => err.extra?.code === 'LAYOUT_INVALID');
});

test('a layer without a placement keeps the one below it', () => {
  const db = validateLayout({ nav: { placement: 'sidebar' } });
  const file = validateLayout({ nav: { items: [{ id: 'help', label: 'Help', href: '/faq' }] } });
  assert.equal(mergeLayout(mergeLayout(defaultLayout(), db), file).nav.placement, 'sidebar');
  assert.equal(mergeLayout(defaultLayout(), file).nav.placement, 'top');
});

test('pages carry data-nav from the layout', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zkv-nav-'));
  const created = await createApp({ dataDir: dir, quiet: true, port: 0 });
  const server = await new Promise((r) => {
    const s = created.app.listen(0, '127.0.0.1', () => r(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.match(await (await fetch(`${base}/elections`)).text(), /<html data-nav="top"/);
    created.store.data.layout = validateLayout({ nav: { placement: 'sidebar' } });
    const html = await (await fetch(`${base}/elections`)).text();
    assert.match(html, /<html data-nav="sidebar"/);
  } finally {
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  }
});

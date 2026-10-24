// NOT FOR PROFIT — civic public good, not a commercial product.
// Keeps docs/self-hosting, docker-compose.tailscale.yml, and the README in step.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');
const dir = 'docs/self-hosting';

function envKeys(compose) {
  return new Set([...compose.matchAll(/\$\{([A-Z0-9_]+)(?::?[-?][^}]*)?\}/g)].map((m) => m[1]));
}

test('docker-compose.tailscale.yml uses every variable docker-compose.yml uses', () => {
  const base = envKeys(read('docker-compose.yml'));
  const ts = envKeys(read('docker-compose.tailscale.yml'));
  const missing = [...base].filter((k) => !ts.has(k));
  assert.deepEqual(missing, [], `copy these into docker-compose.tailscale.yml: ${missing.join(', ')}`);
});

test('Tailscale sidecar keeps its required wiring', () => {
  const ts = read('docker-compose.tailscale.yml');
  assert.match(ts, /image: tailscale\/tailscale:stable/);
  assert.match(ts, /TS_AUTHKEY: \$\{TS_AUTHKEY:\?/);
  assert.match(ts, /TS_STATE_DIR: \/var\/lib\/tailscale/);
  assert.match(ts, /tailscale-state:\/var\/lib\/tailscale/);
  assert.match(ts, /TS_ENABLE_HEALTH_CHECK: "true"/);
  assert.match(ts, /"Proxy": "http:\/\/node:3000"/);
  assert.match(ts, /127\.0\.0\.1:\$\{ZK_VOTING_PORT:-3000\}:3000/);
});

test('every self-hosting page is in nav.json and every nav entry has a page', () => {
  const nav = JSON.parse(read(`${dir}/nav.json`));
  const listed = nav.sections.flatMap((s) => s.pages.map((p) => `${p.slug}.md`)).sort();
  const files = readdirSync(path.join(root, dir)).filter((f) => f.endsWith('.md')).sort();
  assert.deepEqual(listed, files);
});

test('self-hosting pages carry the charter line and no host-only admin details', () => {
  for (const f of readdirSync(path.join(root, dir)).filter((x) => x.endsWith('.md'))) {
    const text = read(`${dir}/${f}`);
    assert.match(text, /NOT FOR PROFIT/, f);
    for (const banned of ['/api/_sa', 'zksa_', 'SUPER_ADMIN_API']) {
      assert.ok(!text.includes(banned), `${f} mentions ${banned}`);
    }
  }
});

test('README links the self-hosting docs', () => {
  const readme = read('README.md');
  assert.match(readme, /docs\/self-hosting\/README\.md/);
  assert.match(readme, /docker-compose\.tailscale\.yml/);
});

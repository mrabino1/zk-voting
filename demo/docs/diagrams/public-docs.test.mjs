// NOT FOR PROFIT — civic public good, not a commercial product.
// The public docs set is whatever README links plus the top-level docs pages.
// docs/internal is operator-only and must stay out of that list and out of the
// diagram renderer.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function publicDocPaths() {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const linked = new Set();
  for (const match of readme.matchAll(/(?:\]\(|`)(docs\/[A-Za-z0-9_./-]+\.md)/g)) {
    linked.add(match[1]);
  }
  for (const name of readdirSync(join(root, 'docs'))) {
    if (name.endsWith('.md')) linked.add(`docs/${name}`);
  }
  return [...linked].sort();
}

describe('public docs list', () => {
  test('internal super-admin notes are excluded from the public list and the docs renderer', () => {
    const listed = publicDocPaths();
    assert.ok(listed.includes('docs/ARCHITECTURE.md'));
    assert.ok(listed.includes('docs/OPERATOR.md'));
    assert.equal(listed.some((item) => item.startsWith('docs/internal/')), false);
    assert.equal(listed.includes('docs/internal/SUPER_ADMIN_API.md'), false);
    const renderer = readFileSync(join(root, 'docs/diagrams/render.mjs'), 'utf8');
    assert.equal(renderer.includes('docs/internal'), false);
    assert.equal(renderer.includes('SUPER_ADMIN_API'), false);
  });

  test('public docs and the bot catalog do not advertise the super-admin API', () => {
    const files = [
      'README.md',
      'apps/node/README.md',
      'apps/node/src/botApiCatalog.mjs',
      'apps/node/src/routes/botDocs.mjs',
      ...publicDocPaths(),
    ];
    for (const rel of files) {
      const text = readFileSync(join(root, rel), 'utf8');
      assert.equal(text.includes('/api/_sa'), false, rel);
      assert.equal(text.includes('zksa_'), false, rel);
      assert.equal(text.includes('SUPER_ADMIN_API'), false, rel);
    }
  });
});

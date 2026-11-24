// NOT FOR PROFIT — civic public good, not a commercial product.
// The l2 image must let ESM resolve viem: `import 'viem'` ignores NODE_PATH.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
const main = readFileSync(new URL('../main.mjs', import.meta.url), 'utf8');
const boot = readFileSync(new URL('../boot.mjs', import.meta.url), 'utf8');

test('the l2 image links /node_modules to the viem install and the build loads l1, server and boot', () => {
  assert.match(dockerfile, /ln -s \/opt\/deps\/node_modules \/node_modules/);
  for (const file of ['l1', 'server', 'boot']) assert.match(dockerfile, new RegExp(`await import\\('/l2/rollup/${file}\\.mjs'\\)`));
});

test('main.mjs and boot.mjs do not load viem before the server listens', () => {
  for (const src of [main, boot]) {
    assert.doesNotMatch(src, /^import .* from '\.\/l1\.mjs';$/m);
    assert.doesNotMatch(src, /^import .* from '\.\/operator\.mjs';$/m);
  }
  assert.match(main, /zk-voting l2 starting:/);
});

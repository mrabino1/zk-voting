// NOT FOR PROFIT — civic public good, not a commercial product.
// The voter theme (public/voter-theme.css) is wired to the voter shell only, busts caches when
// it changes, ships its own fonts, and leaves high-contrast mode to styles.css.

import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { assetVersion } from '../src/publicAssets.mjs';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const css = readFileSync(join(publicDir, 'voter-theme.css'), 'utf8');

test('only the voter shell loads the theme, after styles.css', () => {
  const index = readFileSync(join(publicDir, 'index.html'), 'utf8');
  const base = index.indexOf('href="/styles.css"');
  const theme = index.indexOf('href="/voter-theme.css"');
  assert.ok(base > 0 && theme > base, 'index.html links voter-theme.css after styles.css');
  for (const name of readdirSync(publicDir).filter((f) => f.endsWith('.html') && f !== 'index.html')) {
    assert.doesNotMatch(readFileSync(join(publicDir, name), 'utf8'), /voter-theme\.css/, `${name} keeps the office look`);
  }
});

test('a change to the theme changes the asset version', () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'zkv-theme-'));
  try {
    for (const name of ['styles.css', 'index.html', 'voter-theme.css']) copyFileSync(join(publicDir, name), join(dir, name));
    const before = assetVersion(dir);
    writeFileSync(join(dir, 'voter-theme.css'), `${css}\n/* changed */\n`);
    assert.notEqual(assetVersion(dir), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fonts are self-hosted with their licence', () => {
  const urls = [...css.matchAll(/url\("(\/fonts\/[^"]+)"\)/g)].map((m) => m[1]);
  assert.ok(urls.length >= 2);
  for (const url of urls) assert.ok(existsSync(join(publicDir, url)), `${url} exists`);
  assert.ok(existsSync(join(publicDir, 'fonts', 'OFL.txt')));
  assert.doesNotMatch(css, /fonts\.(googleapis|gstatic)\.com/);
});

test('the look yields to prefers-contrast: more', () => {
  const gate = css.indexOf('@media not (prefers-contrast: more) {');
  assert.ok(gate > 0, 'look is gated');
  const before = css.slice(0, gate);
  // Only fonts and structure come before the gate: no surface colours or shadows.
  assert.doesNotMatch(before, /background\s*:|box-shadow\s*:|hsl\(|#[0-9a-f]{3,8}\b/i);
});

test('rules read tokens; colours are set once in the token block', () => {
  const gate = css.indexOf('@media not (prefers-contrast: more) {');
  const look = css.slice(gate);
  const tokensEnd = look.indexOf('\n  }\n');
  const rules = look.slice(tokensEnd);
  assert.doesNotMatch(rules, /#[0-9a-f]{3,8}\b/i, 'no hex colours in rules');
  assert.doesNotMatch(rules, /hsl\(/, 'no hsl() colours in rules');
  // The primary follows the admin-settable layout tokens.
  assert.match(look.slice(0, tokensEnd), /--primary:\s*var\(--project\)/);
  assert.match(look.slice(0, tokensEnd), /--primary-ink:\s*var\(--project-text\)/);
});

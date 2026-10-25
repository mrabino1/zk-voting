// NOT FOR PROFIT — civic public good, not a commercial product.
//
// Artifact check for the informational election-workflow diagram.
// Does not invoke mermaid-cli / Chromium (that is `npm run docs:workflow`).

import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const sourcePath = join(here, 'election-workflow.mmd');
const pngPath = join(root, 'docs', 'images', 'election-workflow.png');
const readmePath = join(root, 'README.md');
const privacyPath = join(root, 'docs', 'how_voters_privacy_is_protected.md');
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const REQUIRED_PHRASES = [
  'register',
  'freeze',
  'vote',
  'nullifier',
  'relayer',
  'hourly disclosure',
  'tally',
  'results',
  'republic node',
  'republic l2',
  'ethereum l1',
  'identity is not the ballot',
];

describe('election workflow diagram artifacts', () => {
  test('mermaid source exists and names the lifecycle, layers, and identity split', () => {
    const source = readFileSync(sourcePath, 'utf8');
    assert.ok(source.length > 400, 'mermaid source looks empty');
    assert.match(source, /flowchart\s+TB/);
    const lower = source.toLowerCase();
    for (const phrase of REQUIRED_PHRASES) {
      assert.ok(lower.includes(phrase), `mermaid source missing ${JSON.stringify(phrase)}`);
    }
  });

  test('committed PNG is a real image', () => {
    const st = statSync(pngPath);
    assert.ok(st.isFile(), 'docs/images/election-workflow.png missing');
    assert.ok(st.size > 8_000, `PNG too small (${st.size} bytes); re-run npm run docs:workflow`);
    const head = readFileSync(pngPath).subarray(0, 8);
    assert.deepEqual(head, PNG_MAGIC, 'docs/images/election-workflow.png is not a PNG');
  });

  test('README and privacy brief embed the PNG', () => {
    const embed = 'docs/images/election-workflow.png';
    const readme = readFileSync(readmePath, 'utf8');
    const privacy = readFileSync(privacyPath, 'utf8');
    assert.ok(readme.includes(embed), 'README.md does not embed the workflow PNG');
    assert.ok(readme.includes('docs/diagrams/election-workflow.mmd'), 'README.md should link the mermaid source');
    assert.ok(privacy.includes(embed), 'how_voters_privacy_is_protected.md does not embed the workflow PNG');
  });
});

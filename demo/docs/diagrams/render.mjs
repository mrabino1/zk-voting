#!/usr/bin/env node
// NOT FOR PROFIT — civic public good, not a commercial product.
//
// Render docs/diagrams/election-workflow.mmd → docs/images/election-workflow.png
// using @mermaid-js/mermaid-cli (mmdc). Chromium is required.
//
//   npm run docs:workflow
//
// CI does not run this by default (no Chrome on ubuntu-latest). The PNG is a
// committed artifact; `npm run test:docs` checks that the source and PNG exist.

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const input = join(here, 'election-workflow.mmd');
const outputDir = join(root, 'docs', 'images');
const output = join(outputDir, 'election-workflow.png');
const puppeteerConfig = join(here, 'puppeteer.json');
const MMDC_PKG = '@mermaid-js/mermaid-cli@11.12.0';

function findChrome() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH && existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  const candidates = [
    '/usr/local/bin/google-chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const cmd of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const found = spawnSync('which', [cmd], { encoding: 'utf8' });
    if (found.status === 0) {
      const path = found.stdout.trim();
      if (path) candidates.unshift(path);
    }
  }
  return candidates.find((p) => existsSync(p)) || '';
}

function run(command, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, ...extraEnv },
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited ${code}`));
    });
  });
}

mkdirSync(outputDir, { recursive: true });

if (!existsSync(input)) {
  console.error(`missing mermaid source: ${input}`);
  process.exit(1);
}

const chrome = findChrome();
const env = {};
if (chrome) {
  env.PUPPETEER_EXECUTABLE_PATH = chrome;
  env.PUPPETEER_SKIP_DOWNLOAD = 'true';
  env.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD = 'true';
  console.log(`using Chrome: ${chrome}`);
} else {
  console.log('no system Chrome found; mermaid-cli will try its bundled Chromium');
}

const args = [
  '--yes',
  MMDC_PKG,
  '-i',
  input,
  '-o',
  output,
  '-b',
  'white',
  '-w',
  '2400',
  '-s',
  '2',
  '-p',
  puppeteerConfig,
];

await run('npx', args, env);

if (!existsSync(output)) {
  console.error(`mmdc did not write ${output}`);
  process.exit(1);
}

try {
  chmodSync(output, 0o644);
} catch {
  /* ignore */
}

console.log(`wrote ${output}`);

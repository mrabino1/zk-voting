// The L2 image copies l2/ to /l2 and does not copy the Node app.
// sequencer/state.mjs still imports the disclosure modules by a path that
// lands in /apps/node/src. This stages that layout and loads the sequencer.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, cp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const votingNode = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHARED = ['disclosure.mjs', 'electionType.mjs'];

test('staged L2 image layout can load the sequencer', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'l2-image-'));
  try {
    await cp(path.join(votingNode, 'l2'), path.join(root, 'l2'), { recursive: true });
    await mkdir(path.join(root, 'apps/node/src'), { recursive: true });
    for (const file of SHARED) {
      await cp(path.join(votingNode, 'apps/node/src', file), path.join(root, 'apps/node/src', file));
    }
    const loaded = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', "await import('./sequencer/state.mjs')"],
      { cwd: path.join(root, 'l2'), encoding: 'utf8' },
    );
    assert.equal(loaded.status, 0, loaded.stderr || loaded.stdout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

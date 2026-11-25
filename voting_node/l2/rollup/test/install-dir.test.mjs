// NOT FOR PROFIT — civic public good, not a commercial product.
// INSTALL_DIR (docker-compose.coolify.yml): with nothing configured the operator shares the
// generated ballot token, waits in standby, and restarts itself (exit 0, the container's
// restart policy brings it back) when /setup saves a voting mode.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const MAIN = fileURLToPath(new URL('../main.mjs', import.meta.url));
const install = createRequire(import.meta.url)('../../../packages/chain-client/install.js');

test('unconfigured operator stands by, shares the token, and restarts when setup saves a mode', async () => {
  const installDir = mkdtempSync(path.join(tmpdir(), 'l2-install-'));
  const dataDir = mkdtempSync(path.join(tmpdir(), 'l2-data-'));
  const port = 19700 + Math.floor(Math.random() * 200);
  const child = spawn(process.execPath, [MAIN], {
    env: {
      PATH: process.env.PATH,
      INSTALL_DIR: installDir,
      L2_STANDBY_WHEN_UNCONFIGURED: 'true',
      L2_DATA_DIR: dataDir,
      L2_RPC_HOST: '127.0.0.1',
      L2_RPC_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  try {
    let health;
    for (let i = 0; i < 50 && !health; i++) {
      await new Promise((r) => setTimeout(r, 100));
      health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json()).catch(() => null);
    }
    assert.equal(health?.status, 'standby', out);
    assert.match(out, /Choose how civic votes are counted on the \/setup page/);
    const token = readFileSync(path.join(installDir, install.INSTALL_FILES.ballotToken), 'utf8').trim();
    assert.match(token, /^[0-9a-f]{64}$/);

    install.writeVotingConfig(installDir, { mode: 'polls' });
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 9000))]);
    assert.equal(code, 0, `expected a clean exit to restart, got ${code}\n${out}`);
    assert.match(out, /voting mode changed on \/setup; restarting/);
  } finally {
    child.kill();
    rmSync(installDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

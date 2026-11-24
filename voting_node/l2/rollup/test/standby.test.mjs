// NOT FOR PROFIT — civic public good, not a commercial product.
// L2_STANDBY_WHEN_UNCONFIGURED: an operator whose rollup is not usable stays up in standby
// (liveness only) instead of exiting, and never sends anything to L1. Safety refusals still exit.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createStandbyApi } from '../server.mjs';

const MAIN = fileURLToPath(new URL('../main.mjs', import.meta.url));
const ROLLUP = '0x1111111111111111111111111111111111111111';
// A random, unfunded key (not an Anvil dev key).
const KEY = '0x7ac6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690e';
const ANVIL_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

// Fake mainnet JSON-RPC: chain id 1, the rollup has no logs (no genesis). Records methods.
const calls = [];
let rpc;
let rpcUrl;
before(async () => {
  rpc = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const one = (m) => {
      calls.push(m.method);
      const result = { eth_chainId: '0x1', eth_getLogs: [], eth_blockNumber: '0x10' }[m.method];
      return result === undefined
        ? { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'not here' } }
        : { jsonrpc: '2.0', id: m.id, result };
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)));
  });
  await new Promise((r) => rpc.listen(0, '127.0.0.1', r));
  rpcUrl = `http://127.0.0.1:${rpc.address().port}`;
});
after(() => rpc.close());

let nextPort = 18600 + Math.floor(Math.random() * 1000);
function run(extraEnv) {
  const port = nextPort++;
  const dataDir = mkdtempSync(path.join(tmpdir(), 'l2-standby-'));
  const env = {
    PATH: process.env.PATH,
    L1_RPC: rpcUrl,
    ROLLUP_ADDRESS: ROLLUP,
    OPERATOR_PRIVATE_KEY: KEY,
    L2_BALLOT_TOKEN: 'secret',
    L2_DATA_DIR: dataDir,
    L2_RPC_HOST: '127.0.0.1',
    L2_RPC_PORT: String(port),
    ...extraEnv,
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const child = spawn(process.execPath, [MAIN], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  const stop = () => {
    child.kill('SIGKILL');
    rmSync(dataDir, { recursive: true, force: true });
  };
  return { base: `http://127.0.0.1:${port}`, child, exited, stop, output: () => out };
}

async function waitHealth(base, exited) {
  const deadline = Date.now() + 15_000;
  let gone = false;
  exited.then(() => (gone = true));
  while (Date.now() < deadline && !gone) {
    try {
      const res = await fetch(`${base}/health`);
      return res;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return null;
}

test('standby API: /health is 200 and not ready, everything else 503', async () => {
  const server = createStandbyApi({ reason: 'rollup genesis not found', chainId: 1, rollup: ROLLUP });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    const h = await health.json();
    assert.equal(h.status, 'standby');
    assert.equal(h.ready, false);
    assert.equal(h.reason, 'rollup genesis not found');
    assert.equal((await fetch(`${base}/v1/status`)).status, 503);
    assert.equal((await fetch(`${base}/v1/batches`)).status, 503);
    const post = await fetch(`${base}/v1/ballots`, { method: 'POST', body: '{}' });
    assert.equal(post.status, 503);
    assert.match((await post.json()).error, /standby/);
  } finally {
    server.close();
  }
});

test('without the flag, a rollup with no genesis still exits', async () => {
  const p = run({});
  try {
    const code = await p.exited;
    assert.notEqual(code, 0);
    assert.match(p.output(), /rollup genesis not found/);
  } finally {
    p.stop();
  }
});

test('with the flag, a rollup with no genesis on mainnet stays up in standby and sends nothing', async () => {
  calls.length = 0;
  const p = run({ L2_STANDBY_WHEN_UNCONFIGURED: 'true' });
  try {
    const res = await waitHealth(p.base, p.exited);
    assert.ok(res, `l2 did not come up: ${p.output()}`);
    assert.equal(res.status, 200);
    const h = await res.json();
    assert.equal(h.status, 'standby');
    assert.equal(h.chainId, 1);
    assert.match(h.reason, /rollup genesis not found/);
    assert.equal((await fetch(`${p.base}/v1/status`)).status, 503);
    const ballot = await fetch(`${p.base}/v1/ballots`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: '{"electionId":1,"nullifier":"5"}',
    });
    assert.equal(ballot.status, 503);
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!calls.some((m) => /send|sign/i.test(m)), `L1 writes in standby: ${calls.join(',')}`);
    assert.match(p.output(), /L2 STANDBY \(not ready\)/);
  } finally {
    p.stop();
  }
});

test('with the flag, an unset ROLLUP_ADDRESS is standby too', async () => {
  const p = run({ L2_STANDBY_WHEN_UNCONFIGURED: '1', ROLLUP_ADDRESS: undefined });
  try {
    const res = await waitHealth(p.base, p.exited);
    assert.ok(res, `l2 did not come up: ${p.output()}`);
    const h = await res.json();
    assert.equal(h.status, 'standby');
    assert.match(h.reason, /ROLLUP_ADDRESS is required/);
  } finally {
    p.stop();
  }
});

test('the flag never bypasses safety refusals: mock proofs or an Anvil key off chain 31337', async () => {
  for (const extra of [{ ZK_VOTING_ALLOW_MOCK_PROOFS: '1' }, { OPERATOR_PRIVATE_KEY: ANVIL_KEY }]) {
    const p = run({ L2_STANDBY_WHEN_UNCONFIGURED: 'true', ...extra });
    try {
      assert.equal(await p.exited, 2, p.output());
      assert.doesNotMatch(p.output(), /STANDBY/);
    } finally {
      p.stop();
    }
  }
});

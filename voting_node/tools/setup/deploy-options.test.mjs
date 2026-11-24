// NOT FOR PROFIT — civic public good, not a commercial product.
// Tests for scripts/deploy.sh options that need no chain, and for the
// Etherscan target matcher. Run: npm run test:setup
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const DEMO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEPLOY = path.join(DEMO, 'scripts', 'deploy.sh');
const VERIFY = path.join(DEMO, 'scripts', 'lib', 'verify_targets.py');

function run(cmd, args, env = {}) {
  // Isolated env: no RPC, no keys, nothing from the caller's shell.
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
  });
}

test('deploy.sh --help documents the local and public targets', () => {
  const r = run('bash', [DEPLOY, '--help']);
  assert.equal(r.status, 0);
  for (const word of ['--target local\\|public', 'DeployLocal.s.sol', 'Deploy.s.sol', 'GOVERNOR', 'BATCH_VK', '--verify', '--dry-run']) {
    assert.match(r.stdout, new RegExp(word));
  }
});

test('deploy.sh rejects an unknown target before touching any RPC', () => {
  const r = run('bash', [DEPLOY, '--target', 'l1']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /--target must be local or public/);
});

test('deploy.sh public needs GOVERNOR and BATCH_VK before touching any RPC', () => {
  const r = run('bash', [DEPLOY, '--target', 'public', '--rpc-url', 'http://127.0.0.1:1']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /needs GOVERNOR/);
  const vk = run('bash', [DEPLOY, '--target', 'public', '--rpc-url', 'http://127.0.0.1:1'], { GOVERNOR: `0x${'11'.repeat(20)}` });
  assert.match(vk.stderr + vk.stdout, /needs BATCH_VK/);
});

test('verify_targets.py maps CREATE2 children to artifacts and splits constructor args', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'zkv-verify-'));
  const out = path.join(dir, 'out');
  mkdirSync(path.join(out, 'Foo.sol'), { recursive: true });
  mkdirSync(path.join(out, 'FooBar.sol'), { recursive: true });
  writeFileSync(path.join(out, 'Foo.sol', 'Foo.json'), JSON.stringify({ bytecode: { object: '0x6001' } }));
  writeFileSync(path.join(out, 'FooBar.sol', 'FooBar.json'), JSON.stringify({ bytecode: { object: '0x60016002' } }));
  const a1 = '0x' + '11'.repeat(20);
  const a2 = '0x' + '22'.repeat(20);
  const bfile = path.join(dir, 'run.json');
  writeFileSync(
    bfile,
    JSON.stringify({
      transactions: [
        { contractAddress: a1, transaction: { input: '0x6001' + 'ab'.repeat(32) } },
        { function: 'deploy(bytes32[],bytes[])', additionalContracts: [{ address: a2, initCode: '0x60016002cd' }] },
      ],
    }),
  );
  const r = run('python3', [VERIFY, bfile, out]);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.deepEqual(lines, [`${a1}|Foo|0x${'ab'.repeat(32)}`, `${a2}|FooBar|0xcd`]);
});

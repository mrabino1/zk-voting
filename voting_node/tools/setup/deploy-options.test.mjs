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
const FORK = path.join(DEMO, 'scripts', 'deploy-fork-dryrun.sh');
const VERIFY = path.join(DEMO, 'scripts', 'lib', 'verify_targets.py');

function run(cmd, args, env = {}) {
  // Isolated env: no RPC, no keys, nothing from the caller's shell.
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
  });
}

test('deploy.sh --help documents --via-deployer, --verify and --code-size-limit', () => {
  const r = run('bash', [DEPLOY, '--help']);
  assert.equal(r.status, 0);
  for (const flag of ['--via-deployer', '--verify', '--code-size-limit', 'ADMIN_TODO']) {
    assert.match(r.stdout, new RegExp(flag));
  }
});

test('deploy.sh rejects a non-numeric --code-size-limit before touching any RPC', () => {
  const r = run('bash', [DEPLOY, '--via-deployer', '--code-size-limit', 'big', '--rpc-url', 'http://127.0.0.1:1']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /--code-size-limit must be a number/);
});

test('deploy.sh rejects an unknown target with --via-deployer', () => {
  const r = run('bash', [DEPLOY, '--via-deployer', '--target', 'l3']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /--target must be local, l2, or l1/);
});

test('deploy-fork-dryrun.sh skips cleanly without MAINNET_FORK_RPC_URL', (t) => {
  if (spawnSync('bash', ['-lc', 'command -v anvil && command -v cast'], { env: process.env }).status !== 0) {
    t.skip('foundry not installed');
    return;
  }
  const r = run('bash', [FORK], { MAINNET_FORK_RPC_URL: '' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout + r.stderr, /skipping the mainnet-fork dry run/);
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

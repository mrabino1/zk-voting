// NOT FOR PROFIT — civic public good, not a commercial product.
// Tests for the guided setup (./setup.sh). Run: npm run test:setup
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { makeEntropyString } from '../../apps/node/public/vendor/zk-entropy.js';
import { ADDED_MARKER, formatEnvValue, parseEnvText, updateEnvText } from './envfile.mjs';
import { SECRET_KEYS, describeValue, launchPlan, normalizeFqdn, runSetup } from './setup.mjs';

const DEMO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Anvil's well-known test account #1 (public test key, never funded on a real chain).
const TEST_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const TEST_ADDR = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';

function sandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), 'zkv-setup-'));
  copyFileSync(path.join(DEMO, '.env.example'), path.join(dir, '.env.example'));
  return dir;
}

async function run(dir, lines, argv = [], extra = {}) {
  let out = '';
  const output = new Writable({
    write(chunk, _e, cb) {
      out += chunk;
      cb();
    },
  });
  const input = Readable.from([lines.map((l) => `${l}\n`).join('')]);
  const res = await runSetup({ argv: ['--file', path.join(dir, '.env'), ...argv], input, output, demoDir: dir, ...extra });
  return { ...res, out };
}

function fakeL1({ balanceWei, gasPriceWei }) {
  return async (_url, init) => {
    const { method } = JSON.parse(init.body);
    const result = method === 'eth_getBalance' ? `0x${BigInt(balanceWei).toString(16)}` : `0x${BigInt(gasPriceWei).toString(16)}`;
    return { json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
  };
}

const BASE_ANSWERS = [
  'admin', // handle
  'clerk@example.org', // email
  'g', // generate setup token
  '27427', // chain id
  'n', // no ceremony
  'l', // local entropy
  'vote.example.org', // fqdn
  '3000', // port
  'y', // proxy
  'j', // json store
  'My City', // brand
  'https://eth-mainnet.example.invalid/v2/PROVIDERKEY123', // L1 RPC with an embedded key
  'e', // enter submitter key
  TEST_KEY,
  'c', // compose
];

test('envfile: replaces in place, appends missing keys once, idempotent', () => {
  const src = '# head\nA=1\n# B=commented\nB=\n';
  const once = updateEnvText(src, { A: '2', B: 'x y', C: 'new' });
  assert.equal(once, `# head\nA=2\n# B=commented\nB='x y'\n\n${ADDED_MARKER}\nC=new\n`);
  assert.equal(updateEnvText(once, { A: '2', B: 'x y', C: 'new' }), once);
  const twice = updateEnvText(once, { D: '4' });
  assert.match(twice, new RegExp(`${ADDED_MARKER}\\nC=new\\nD=4\\n$`));
  assert.deepEqual([...parseEnvText(twice)], [['A', '2'], ['B', 'x y'], ['C', 'new'], ['D', '4']]);
});

test('envfile: quoting rules and refusals never include the value', () => {
  assert.equal(formatEnvValue('K', 'postgres://u:p@db:5432/x?sslmode=require'), 'postgres://u:p@db:5432/x?sslmode=require');
  assert.equal(formatEnvValue('K', 'a$b'), "'a$b'");
  assert.throws(() => formatEnvValue('K', 'sec#ret'), (e) => !e.message.includes('sec#ret'));
  assert.throws(() => formatEnvValue('K', 'a\nb'));
});

test('normalizeFqdn accepts bare hostnames only', () => {
  assert.equal(normalizeFqdn('Vote.Example.org.'), 'vote.example.org');
  for (const bad of ['https://vote.example.org', 'vote.example.org:443', '10.0.0.1', 'localhost', 'vote/x']) assert.equal(normalizeFqdn(bad), null, bad);
});

test('first run writes .env (mode 600) with every answer and never prints a secret', async () => {
  const dir = sandbox();
  const r = await run(dir, BASE_ANSWERS, [], {
    fetchImpl: fakeL1({ balanceWei: 10n ** 18n, gasPriceWei: 10n ** 9n }),
  });
  assert.equal(r.code, 0);
  const file = path.join(dir, '.env');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const env = parseEnvText(readFileSync(file, 'utf8'));
  assert.equal(env.get('ADMIN_HANDLE'), 'admin');
  assert.equal(env.get('SUPER_ADMIN_EMAIL'), 'clerk@example.org');
  assert.ok(env.get('SETUP_TOKEN').length >= 30);
  assert.equal(env.get('CHAIN_ID'), '27427');
  assert.equal(env.get('ENTROPY_CEREMONY_URL'), '');
  assert.match(env.get('ZK_ENTROPY'), /^zke1:local:[0-9a-f]{64}:[0-9a-f]{64}:[0-9a-f]{8}$/);
  assert.equal(env.get('VOTE_FQDN'), 'vote.example.org');
  assert.equal(env.get('TRUST_PROXY'), '1');
  assert.equal(env.get('DATABASE_URL'), '');
  assert.equal(env.get('BRAND_NAME'), 'My City');
  assert.match(env.get('EXPLORER_INGEST_SECRET'), /^[0-9a-f]{64}$/);
  assert.match(env.get('RECEIPT_PDF_SECRET'), /^[0-9a-f]{64}$/);
  assert.equal(env.get('L1_SUBMITTER_PRIVATE_KEY'), TEST_KEY);
  assert.match(env.get('L2_UUID'), /^[0-9a-f-]{36}$/);
  assert.match(env.get('L2_SALT'), /^0x[0-9a-f]{64}$/);
  assert.match(env.get('L2_ADMIN_SECRET'), /^[0-9a-f]{64}$/);
  assert.equal(env.get('L2_OPERATOR_ADDRESS'), TEST_ADDR);
  assert.match(env.get('L2_ID'), /^0x[0-9a-f]{64}$/);
  // Secrets and the provider key in the RPC URL never reach the terminal.
  for (const k of SECRET_KEYS) if (env.get(k)) assert.ok(!r.out.includes(env.get(k)), `${k} leaked`);
  assert.ok(!r.out.includes('PROVIDERKEY123'), 'L1_RPC path leaked');
  assert.match(r.out, /L2_ID 0x[0-9a-f]{64}/);
  assert.match(r.out, /Funding: L1 submitter funded/);
  assert.match(r.out, /cd voting_node && docker compose up -d --build/);
  assert.match(r.out, /https:\/\/vote\.example\.org\/setup/);
});

test('re-running with --defaults changes nothing (idempotent)', async () => {
  const dir = sandbox();
  await run(dir, BASE_ANSWERS);
  const before = readFileSync(path.join(dir, '.env'), 'utf8');
  const r = await run(dir, [], ['--defaults', '--deploy', 'compose']);
  assert.equal(r.code, 0);
  assert.deepEqual(r.changed, []);
  assert.match(r.out, /No changes/);
  assert.equal(readFileSync(path.join(dir, '.env'), 'utf8'), before);
});

test('--defaults on a fresh clone generates secrets and identity, skips entropy', async () => {
  const dir = sandbox();
  const r = await run(dir, [], ['-y', '--deploy', 'node']);
  const env = parseEnvText(readFileSync(path.join(dir, '.env'), 'utf8'));
  assert.ok(env.get('SETUP_TOKEN'));
  assert.equal(env.get('ZK_ENTROPY'), '');
  assert.ok(env.get('L2_UUID') && env.get('L2_SALT') && env.get('L2_ADMIN_SECRET'));
  assert.equal(env.get('L2_ID'), '');
  assert.match(r.out, /Funding not checked/);
  assert.match(r.out, /npm run dev/);
});

test('closed ceremony: rejects a bad and a local string, accepts the ceremony output', async () => {
  const dir = sandbox();
  const good = await makeEntropyString('ceremony', 'ab'.repeat(32), 'cd'.repeat(32));
  const local = await makeEntropyString('local', 'ab'.repeat(32), 'cd'.repeat(32));
  const answers = ['admin', '', 'n', '', 'y', 'ceremony.zk-voting.org', 'y', 'zke1:nope', local, good, '', '', 'j', '', '', 'n', '', 'c'];
  const r = await run(dir, answers);
  const env = parseEnvText(readFileSync(path.join(dir, '.env'), 'utf8'));
  assert.equal(env.get('ENTROPY_CEREMONY_URL'), 'https://ceremony.zk-voting.org');
  assert.equal(env.get('ZK_ENTROPY'), good);
  assert.equal(env.get('SETUP_TOKEN'), '');
  assert.match(r.out, /not accepted/);
  assert.match(r.out, /that is a local string/);
  assert.ok(!r.out.includes(good));
});

test('low submitter balance prints a warning', async () => {
  const dir = sandbox();
  // 250000 gas * 1 gwei = 0.00025 ETH per batch; 0.001 ETH covers 4 of 20.
  const r = await run(dir, BASE_ANSWERS, [], { fetchImpl: fakeL1({ balanceWei: 10n ** 15n, gasPriceWei: 10n ** 9n }) });
  assert.match(r.out, /WARNING \(low\): L1 submitter balance is low/);
  assert.match(r.out, new RegExp(`Top up ${TEST_ADDR}`));
});

test('input that ends early writes nothing', async () => {
  const dir = sandbox();
  await assert.rejects(run(dir, ['admin']), /input ended/);
  assert.equal(existsSync(path.join(dir, '.env')), false);
});

test('an existing .env keeps comments and unrelated lines', async () => {
  const dir = sandbox();
  writeFileSync(path.join(dir, '.env'), '# mine\nFOO=bar\nCHAIN_ID=1\n');
  await run(dir, [], ['-y', '--deploy', 'compose']);
  const text = readFileSync(path.join(dir, '.env'), 'utf8');
  assert.match(text, /^# mine\nFOO=bar\nCHAIN_ID=1\n/);
  assert.ok(text.includes(ADDED_MARKER));
});

test('a fresh setup does not invent IS_DEMO', async () => {
  const dir = sandbox();
  await run(dir, [], ['-y', '--deploy', 'compose']);
  const env = parseEnvText(readFileSync(path.join(dir, '.env'), 'utf8'));
  assert.equal(env.has('IS_DEMO'), false);
});

test('an existing IS_DEMO is normalised and a missing one stays missing', async () => {
  const dir = sandbox();
  writeFileSync(path.join(dir, '.env'), 'IS_DEMO=YES\nCHAIN_ID=1\n');
  const warned = await run(dir, [], ['-y', '--deploy', 'compose']);
  const env = parseEnvText(readFileSync(path.join(dir, '.env'), 'utf8'));
  assert.equal(env.get('IS_DEMO'), 'false');
  assert.match(warned.out, /treating as false/);

  const kept = sandbox();
  writeFileSync(path.join(kept, '.env'), 'IS_DEMO=TRUE\nCHAIN_ID=1\n');
  await run(kept, [], ['-y', '--deploy', 'compose']);
  assert.equal(parseEnvText(readFileSync(path.join(kept, '.env'), 'utf8')).get('IS_DEMO'), 'true');
});

test('Coolify plan names secrets without values', () => {
  const plan = launchPlan({ deploy: 'coolify', next: { VOTE_FQDN: 'vote.example.org', SETUP_TOKEN: 's3cret', L1_RPC: 'https://x/key', L2_ID: '0xabc', CHAIN_ID: '27427' } });
  assert.ok(plan.coolify.includes('Base Directory: /voting_node'));
  assert.ok(plan.envSecret.includes('SETUP_TOKEN') && plan.envSecret.includes('L1_RPC'));
  assert.ok(!JSON.stringify(plan).includes('s3cret') && !JSON.stringify(plan).includes('https://x/key'));
  assert.equal(describeValue('L1_RPC', 'https://h.example/v2/KEY'), 'set (h.example; full URL not shown)');
});

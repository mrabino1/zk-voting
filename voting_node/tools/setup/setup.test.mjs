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
import { LOCAL_ROLLUP, SECRET_KEYS, describeValue, launchPlan, normalizeFqdn, runSetup } from './setup.mjs';

const DEMO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Throwaway keys for an "existing deployment" answer (not Anvil's public ones).
const NODE_KEY = `0x${'11'.repeat(32)}`;
const OPERATOR_KEY = `0x${'22'.repeat(32)}`;
const NODE_ADDR = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A';
const ROLLUP = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0';
const JURISDICTION = `0x${'ab'.repeat(32)}`;
// Anvil's public test key #1: refused for an existing deployment.
const ANVIL_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

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

function fakeL1({ balanceWei, gasPriceWei, chainId = 11155111, code = '0x6080' }) {
  return async (_url, init) => {
    const { method } = JSON.parse(init.body);
    const hex = (n) => `0x${BigInt(n).toString(16)}`;
    const result = {
      eth_chainId: hex(chainId),
      eth_getCode: code,
      eth_gasPrice: hex(gasPriceWei),
      eth_getBalance: hex(balanceWei),
    }[method];
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
  'e', // an existing rollup deployment
  'https://eth-sepolia.example.invalid/v2/PROVIDERKEY123', // L1 RPC with an embedded key
  ROLLUP,
  JURISDICTION,
  'e', // enter the node key
  NODE_KEY,
  'e', // enter the operator key
  OPERATOR_KEY,
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
  assert.match(env.get('RECEIPT_PDF_SECRET'), /^[0-9a-f]{64}$/);
  assert.equal(env.get('COMPOSE_PROFILES'), '');
  assert.equal(env.get('ROLLUP_DEPLOYMENT_FILE'), '');
  assert.equal(env.get('ZK_VOTING_ALLOW_MOCK_PROOFS'), '');
  assert.equal(env.get('L1_CHAIN_ID'), '11155111');
  assert.equal(env.get('ROLLUP_ADDRESS'), ROLLUP);
  assert.equal(env.get('ROLLUP_JURISDICTION_ID'), JURISDICTION);
  assert.equal(env.get('ROLLUP_PRIVATE_KEY'), NODE_KEY);
  assert.equal(env.get('OPERATOR_PRIVATE_KEY'), OPERATOR_KEY);
  assert.match(env.get('L2_BALLOT_TOKEN'), /^[0-9a-f]{64}$/);
  // Secrets and the provider key in the RPC URL never reach the terminal.
  for (const k of SECRET_KEYS) if (env.get(k)) assert.ok(!r.out.includes(env.get(k)), `${k} leaked`);
  assert.ok(!r.out.includes('PROVIDERKEY123'), 'L1_RPC path leaked');
  assert.match(r.out, /L1 chain id 11155111/);
  assert.match(r.out, new RegExp(`Node account ${NODE_ADDR}: 1\\.000000 ETH`));
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

test('--defaults on a fresh clone picks the local L1, generates secrets, skips entropy', async () => {
  const dir = sandbox();
  const r = await run(dir, [], ['-y', '--deploy', 'node']);
  const env = parseEnvText(readFileSync(path.join(dir, '.env'), 'utf8'));
  assert.ok(env.get('SETUP_TOKEN'));
  assert.equal(env.get('ZK_ENTROPY'), '');
  for (const [k, v] of Object.entries(LOCAL_ROLLUP)) assert.equal(env.get(k), v, k);
  assert.match(env.get('L2_BALLOT_TOKEN'), /^[0-9a-f]{64}$/);
  assert.match(r.out, /PUBLIC dev keys/);
  assert.match(r.out, /L1_RPC= npm run dev/);
});

test('an existing deployment refuses an Anvil test key', async () => {
  const dir = sandbox();
  const answers = [...BASE_ANSWERS];
  answers.splice(answers.indexOf(NODE_KEY), 1, ANVIL_KEY, NODE_KEY);
  const r = await run(dir, answers, [], { fetchImpl: fakeL1({ balanceWei: 10n ** 18n, gasPriceWei: 10n ** 9n }) });
  assert.equal(r.code, 0);
  assert.match(r.out, /public Anvil test key/);
  assert.equal(parseEnvText(readFileSync(path.join(dir, '.env'), 'utf8')).get('ROLLUP_PRIVATE_KEY'), NODE_KEY);
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

test('a low balance prints a warning, and a missing contract is flagged', async () => {
  const dir = sandbox();
  // 300000 gas * 1 gwei = 0.0003 ETH per L1 call; 0.001 ETH covers 3 of 20.
  const r = await run(dir, BASE_ANSWERS, [], { fetchImpl: fakeL1({ balanceWei: 10n ** 15n, gasPriceWei: 10n ** 9n, code: '0x' }) });
  assert.match(r.out, new RegExp(`WARNING \\(low\\): Node account ${NODE_ADDR} has 0\\.001000 ETH, about 3 L1 calls`));
  assert.match(r.out, new RegExp(`WARNING: no contract at ${ROLLUP}`));
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
  const plan = launchPlan({
    deploy: 'coolify',
    next: { VOTE_FQDN: 'vote.example.org', SETUP_TOKEN: 's3cret', L1_RPC: 'https://x/key', ROLLUP_ADDRESS: ROLLUP, ROLLUP_PRIVATE_KEY: NODE_KEY, CHAIN_ID: '27427' },
  });
  assert.ok(plan.coolify.includes('Base Directory: /voting_node'));
  assert.ok(plan.envSecret.includes('SETUP_TOKEN') && plan.envSecret.includes('L1_RPC') && plan.envSecret.includes('ROLLUP_PRIVATE_KEY'));
  assert.ok(plan.envPlain.includes(`ROLLUP_ADDRESS=${ROLLUP}`));
  assert.ok(!JSON.stringify(plan).includes('s3cret') && !JSON.stringify(plan).includes('https://x/key') && !JSON.stringify(plan).includes(NODE_KEY));
  assert.equal(describeValue('L1_RPC', 'https://h.example/v2/KEY'), 'set (h.example; full URL not shown)');
});

test('a first run with the defaults generates credentials for the bundled Postgres', async () => {
  const dir = sandbox();
  const r = await run(dir, [], ['-y', '--deploy', 'compose']);
  assert.equal(r.code, 0);
  const env = parseEnvText(readFileSync(path.join(dir, '.env'), 'utf8'));
  assert.equal(env.get('POSTGRES_USER'), 'zkvote');
  assert.equal(env.get('POSTGRES_DB'), 'zkvote');
  assert.match(env.get('POSTGRES_PASSWORD'), /^[0-9a-f]{48}$/);
  assert.equal(env.get('DATABASE_URL'), `postgres://zkvote:${env.get('POSTGRES_PASSWORD')}@db:5432/zkvote`);
  assert.equal(r.out.includes(env.get('POSTGRES_PASSWORD')), false, 'the password is never printed');
  assert.doesNotMatch(r.out, /Compose will not start/);
  // Running it again keeps the same credentials.
  const again = await run(dir, [], ['-y', '--deploy', 'compose']);
  assert.deepEqual(again.changed, []);
});

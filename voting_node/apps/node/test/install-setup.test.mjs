// NOT FOR PROFIT — civic public good, not a commercial product.
// A fork deployed with no hand-typed settings: platform-derived values, the shared install
// volume, the network registry, and the "How will civic votes be counted?" setup step.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { insecurePublicUrl, platformEnv } from '../src/platformEnv.mjs';
import { networksForSetup, redactRpc, saveVotingMode, votingSetupStatus } from '../src/votingSetup.mjs';

const install = createRequire(import.meta.url)('@zk-voting/chain-client/install');

let dir;
before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'zkv-install-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('platformEnv (Coolify)', () => {
  test('fills the domain, public URL and proxy from Coolify', () => {
    const { env, derived } = platformEnv({ COOLIFY_FQDN: 'vote.example.org', COOLIFY_URL: 'https://vote.example.org' });
    assert.equal(env.VOTE_FQDN, 'vote.example.org');
    assert.equal(env.PUBLIC_BASE_URL, 'https://vote.example.org');
    assert.equal(env.TRUST_PROXY, '1');
    assert.deepEqual(Object.keys(derived).sort(), ['PUBLIC_BASE_URL', 'TRUST_PROXY', 'VOTE_FQDN']);
  });

  test('an explicit variable always wins', () => {
    const { env, derived } = platformEnv({ COOLIFY_FQDN: 'abc.sslip.io', VOTE_FQDN: 'vote.example.org', TRUST_PROXY: 'loopback' });
    assert.equal(env.VOTE_FQDN, 'vote.example.org');
    assert.equal(env.TRUST_PROXY, 'loopback');
    assert.equal(derived.VOTE_FQDN, undefined);
  });

  test('builds DATABASE_URL from the Postgres parts, escaping the password', () => {
    const { env } = platformEnv({ POSTGRES_USER: 'u', POSTGRES_PASSWORD: 'p@ss/w:rd', POSTGRES_DB: 'zk' });
    assert.equal(env.DATABASE_URL, 'postgres://u:p%40ss%2Fw%3Ard@db:5432/zk');
    assert.equal(platformEnv({ DATABASE_URL: 'postgres://x', POSTGRES_USER: 'u', POSTGRES_PASSWORD: 'p', POSTGRES_DB: 'd' }).env.DATABASE_URL, 'postgres://x');
  });

  test('keeps the first of several Coolify domains and flags plain http', () => {
    const { env } = platformEnv({ COOLIFY_FQDN: 'a.example.org,b.example.org', COOLIFY_URL: 'http://a.example.org,http://b.example.org' });
    assert.equal(env.VOTE_FQDN, 'a.example.org');
    assert.equal(insecurePublicUrl(env.PUBLIC_BASE_URL, env.VOTE_FQDN), true);
    assert.equal(insecurePublicUrl('http://localhost:3000', 'localhost'), false);
    assert.equal(insecurePublicUrl('https://a.example.org', 'a.example.org'), false);
  });
});

describe('install volume', () => {
  test('the ballot token is generated once and shared', async () => {
    const a = install.installEnv({ INSTALL_DIR: dir });
    const b = install.installEnv({ INSTALL_DIR: dir });
    assert.match(a.env.L2_BALLOT_TOKEN, /^[0-9a-f]{64}$/);
    assert.equal(a.env.L2_BALLOT_TOKEN, b.env.L2_BALLOT_TOKEN);
    const mode = (await stat(path.join(dir, install.INSTALL_FILES.ballotToken))).mode & 0o777;
    assert.equal(mode, 0o600);
    assert.equal(install.installEnv({ INSTALL_DIR: dir, L2_BALLOT_TOKEN: 'from-env' }).env.L2_BALLOT_TOKEN, 'from-env');
  });

  test('without INSTALL_DIR nothing changes', () => {
    const r = install.installEnv({ FOO: '1' });
    assert.deepEqual(r.env, { FOO: '1' });
    assert.deepEqual(r.sources, {});
  });

  test('the test chain mode fills the local rollup settings with public test keys', () => {
    install.writeVotingConfig(dir, { mode: 'local-test' });
    const { env } = install.installEnv({ INSTALL_DIR: dir });
    assert.equal(env.L1_RPC, 'http://l1:8545');
    assert.equal(env.L1_CHAIN_ID, '31337');
    assert.equal(env.ROLLUP_DEPLOYMENT_FILE, '/deployments/local.json');
    const { isAnvilDevKey } = createRequire(import.meta.url)('@zk-voting/chain-client');
    assert.ok(isAnvilDevKey(env.ROLLUP_PRIVATE_KEY));
    assert.ok(isAnvilDevKey(env.OPERATOR_PRIVATE_KEY));
  });

  test('shared mode generates private keys that are not test keys', async () => {
    const sub = path.join(dir, 'shared');
    install.writeVotingConfig(sub, { mode: 'shared', network: 'sepolia', chainId: 11155111, l1Rpc: 'https://rpc.example', rollupAddress: '0x' + '1'.repeat(40) });
    const { env } = install.installEnv({ INSTALL_DIR: sub });
    assert.match(env.ROLLUP_PRIVATE_KEY, /^0x[0-9a-f]{64}$/);
    assert.match(env.OPERATOR_PRIVATE_KEY, /^0x[0-9a-f]{64}$/);
    assert.notEqual(env.ROLLUP_PRIVATE_KEY, env.OPERATOR_PRIVATE_KEY);
    const { isAnvilDevKey } = createRequire(import.meta.url)('@zk-voting/chain-client');
    assert.equal(isAnvilDevKey(env.ROLLUP_PRIVATE_KEY), false);
    assert.equal(env.ROLLUP_ADDRESS, '0x' + '1'.repeat(40));
    assert.equal(env.L1_CHAIN_ID, '11155111');
    // Saving again keeps the same keys (funds already sent to them stay reachable).
    install.writeVotingConfig(sub, { mode: 'shared', network: 'sepolia', chainId: 11155111, l1Rpc: 'https://rpc2.example', rollupAddress: '0x' + '1'.repeat(40) });
    assert.equal(install.installEnv({ INSTALL_DIR: sub }).env.ROLLUP_PRIVATE_KEY, env.ROLLUP_PRIVATE_KEY);
    const key = (await stat(path.join(sub, install.INSTALL_FILES.nodeKey))).mode & 0o777;
    assert.equal(key, 0o600);
    assert.match(await readFile(path.join(sub, install.INSTALL_FILES.voting), 'utf8'), /rpc2\.example/);
  });
});

describe('network registry', () => {
  test('lists the built-in test chain, Sepolia and mainnet with their chain ids', () => {
    const nets = networksForSetup();
    assert.deepEqual(
      nets.map((n) => [n.id, n.chainId]),
      [
        ['local-test', 31337],
        ['sepolia', 11155111],
        ['mainnet', 1],
      ],
    );
    assert.equal(nets.find((n) => n.id === 'local-test').available, true);
  });

  test('a public network without a deployed contract is not offered as available', () => {
    for (const n of networksForSetup().filter((x) => !x.builtIn)) {
      const raw = install.findNetwork(n.id);
      assert.equal(n.available, Boolean(raw.rollup.address && raw.civicVotes.available));
      if (!n.available) assert.ok(n.availabilityNote.length > 20, `${n.id} explains why it is unavailable`);
    }
  });
});

describe('saveVotingMode', () => {
  const store = (elections = []) => ({ listElections: () => elections });
  const okRpc = (chainId) => async () => ({ ok: true, json: async () => ({ result: `0x${chainId.toString(16)}` }) });

  test('polls only needs nothing', async () => {
    const sub = path.join(dir, 'polls');
    const saved = await saveVotingMode({ installDir: sub, store: store() }, { mode: 'polls' }, { env: {} });
    assert.equal(saved.mode, 'polls');
    assert.equal(votingSetupStatus({ installDir: sub, store: store() }, {}).mode, 'polls');
  });

  test('the test chain must actually be running', async () => {
    const sub = path.join(dir, 'lt');
    await assert.rejects(
      saveVotingMode({ installDir: sub, store: store() }, { mode: 'local-test' }, { env: {}, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }),
      (err) => err.extra.code === 'SETUP_TEST_CHAIN_DOWN',
    );
    const saved = await saveVotingMode({ installDir: sub, store: store() }, { mode: 'local-test' }, { env: {}, fetchImpl: okRpc(31337) });
    assert.equal(saved.mode, 'local-test');
  });

  test('a public network with no deployed contract is refused with its reason', async () => {
    await assert.rejects(
      saveVotingMode({ installDir: path.join(dir, 's'), store: store() }, { mode: 'shared', network: 'mainnet', l1Rpc: 'https://x' }, { env: {}, fetchImpl: okRpc(1) }),
      (err) => err.extra.code === 'SETUP_NETWORK_UNAVAILABLE' && /not deployed/i.test(err.message),
    );
  });

  test('settings fixed in the environment are left alone', async () => {
    const { recordFilled } = await import('../src/platformEnv.mjs');
    recordFilled([], 'setup');
    await assert.rejects(
      saveVotingMode({ installDir: path.join(dir, 'e'), store: store() }, { mode: 'polls' }, { env: { ROLLUP_ADDRESS: '0xabc' } }),
      (err) => err.extra.code === 'SETUP_ROLLUP_FIXED_BY_ENV' && err.extra.locked.includes('ROLLUP_ADDRESS'),
    );
  });

  test('the mode cannot change once a civic vote is on the current chain', async () => {
    const sub = path.join(dir, 'pub');
    install.writeVotingConfig(sub, { mode: 'local-test' });
    const published = store([{ id: 'e1', title: 'Charter', rollup: { electionId: 3 } }]);
    await assert.rejects(
      saveVotingMode({ installDir: sub, store: published }, { mode: 'polls' }, { env: {} }),
      (err) => err.extra.code === 'SETUP_CIVIC_VOTES_PUBLISHED',
    );
  });

  test('without an install volume, setup says what to do instead', async () => {
    await assert.rejects(saveVotingMode({ installDir: '', store: store() }, { mode: 'polls' }, { env: {} }), (err) => err.extra.code === 'SETUP_NO_INSTALL_DIR');
  });

  test('RPC URLs are shown without provider credentials', () => {
    assert.equal(redactRpc('https://eth-sepolia.example.com/v2/SECRETKEY123456'), 'https://eth-sepolia.example.com/v2/SE…');
    assert.equal(redactRpc('https://rpc.example?key=abc'), 'https://rpc.example/?…');
  });
});

describe('review fixes', () => {
  test('a pinned VOTE_FQDN keeps its own https public URL, not Coolify\'s test domain', () => {
    const { env, derived } = platformEnv({ COOLIFY_FQDN: 'abc.sslip.io', COOLIFY_URL: 'http://abc.sslip.io', VOTE_FQDN: 'vote.city.org' });
    assert.equal(env.PUBLIC_BASE_URL, undefined);
    assert.equal(derived.PUBLIC_BASE_URL, undefined);
  });

  test('an unusable Coolify domain is skipped instead of failing start-up', () => {
    assert.equal(platformEnv({ COOLIFY_FQDN: '10.0.0.5' }).env.VOTE_FQDN, undefined);
    assert.equal(platformEnv({ COOLIFY_FQDN: 'https://vote.example.org:443/x' }).env.VOTE_FQDN, 'vote.example.org');
  });

  test('the test chain never waives poll eligibility proofs on the node', () => {
    const sub = path.join(dir, 'roles');
    install.writeVotingConfig(sub, { mode: 'local-test' });
    assert.equal(install.installEnv({ INSTALL_DIR: sub }, { role: 'node' }).env.ZK_VOTING_ALLOW_MOCK_PROOFS, undefined);
    assert.equal(install.installEnv({ INSTALL_DIR: sub }, { role: 'l2' }).env.ZK_VOTING_ALLOW_MOCK_PROOFS, '1');
  });

  test('an operator key set for l2 locks the rollup choice', async () => {
    await assert.rejects(
      saveVotingMode({ installDir: path.join(dir, 'opk'), store: { listElections: () => [] } }, { mode: 'polls' }, { env: { OPERATOR_PRIVATE_KEY_SET: '1' } }),
      (err) => err.extra.code === 'SETUP_ROLLUP_FIXED_BY_ENV' && err.extra.locked.includes('OPERATOR_PRIVATE_KEY'),
    );
  });

  test('a leftover empty secret file does not wedge start-up', async () => {
    const { writeFileSync } = await import('node:fs');
    const sub = await mkdtemp(path.join(os.tmpdir(), 'zkv-empty-'));
    writeFileSync(path.join(sub, install.INSTALL_FILES.ballotToken), '');
    const token = install.sharedSecret(sub, install.INSTALL_FILES.ballotToken);
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(install.sharedSecret(sub, install.INSTALL_FILES.ballotToken), token);
    await rm(sub, { recursive: true, force: true });
  });
});

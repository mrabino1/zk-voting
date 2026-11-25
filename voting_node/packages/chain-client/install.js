// NOT FOR PROFIT — civic public good, not a commercial product.
//
// Settings the first-run setup screen writes, shared by the node and the L2 operator.
//
// A person who forks this repository and clicks "Deploy" in Coolify should not have to
// invent secrets or know which chain id, contract address or RPC they need. So:
//
//   - The Compose file mounts one small volume, INSTALL_DIR (default /install), into both
//     the node and the l2 container.
//   - Secrets that only these two containers share (the L2 ballot token) are generated
//     here once, on first boot, by whichever container starts first.
//   - The setup screen (/setup) writes voting.json: how civic votes are settled
//     ("polls only", the built-in test chain, or a shared ZkVotingRollup on a public
//     network). Keys it generates sit next to it, readable by the owner only.
//   - At start-up both containers call applyInstallEnv(process.env): every variable that
//     is still empty is filled from these files. A variable set in the environment
//     (Coolify's Environment Variables, .env) always wins, so nothing changes for an
//     operator who configures by hand.
//
// The files hold secrets. They live on a Docker volume that only these containers mount,
// like the .env file they replace. They are not encrypted at rest: a key that could decrypt
// them would have to sit on the same volume.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const LOCAL_CHAIN_ID = 31337;

/** Anvil's public test accounts used by script/DeployLocal.s.sol (Compose service l1-deploy). */
const LOCAL_TEST_CHAIN = Object.freeze({
  l1Rpc: 'http://l1:8545',
  deploymentFile: '/deployments/local.json',
  // Account 2 is the clerk DeployLocal.s.sol registers; account 1 is the operator.
  nodeKey: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  operatorKey: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
});

const MODES = Object.freeze(['polls', 'local-test', 'shared']);

const FILES = Object.freeze({
  ballotToken: 'l2-ballot-token',
  voting: 'voting.json',
  nodeKey: 'node.key',
  operatorKey: 'operator.key',
});

function installDir(env = process.env) {
  return String(env.INSTALL_DIR || '').trim();
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch (err) {
    if (err && err.code === 'ENOENT') return '';
    throw err;
  }
}

/** Write a file only the owner can read, atomically (rename), creating the directory. */
function writePrivate(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, contents, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Read a secret, or create it once. Safe when the node and l2 start at the same time:
 * the first `wx` create wins and the other reads what it wrote.
 */
function sharedSecret(dir, name, make = () => crypto.randomBytes(32).toString('hex')) {
  const file = path.join(dir, name);
  const existing = readText(file);
  if (existing) return existing;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const value = make();
  try {
    fs.writeFileSync(file, `${value}\n`, { mode: 0o600, flag: 'wx' });
    return value;
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      // The other container won the race; it may still be writing.
      for (let i = 0; i < 50; i++) {
        const v = readText(file);
        if (v) return v;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
    throw err;
  }
}

/** voting.json, or null when setup has not chosen yet. */
function readVotingConfig(dir) {
  if (!dir) return null;
  const raw = readText(path.join(dir, FILES.voting));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && MODES.includes(parsed.mode) ? parsed : null;
  } catch {
    return null;
  }
}

/** Fingerprint of voting.json, so a running container can notice setup changed it. */
function votingConfigStamp(dir) {
  if (!dir) return '';
  const raw = readText(path.join(dir, FILES.voting));
  return raw ? crypto.createHash('sha256').update(raw).digest('hex') : '';
}

function isHex32(value) {
  return /^0x[0-9a-fA-F]{64}$/.test(String(value || ''));
}

/** A new secp256k1 private key (any 32 bytes below the curve order is valid; reject the rest). */
function newPrivateKey() {
  const N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
  for (;;) {
    const k = BigInt(`0x${crypto.randomBytes(32).toString('hex')}`);
    if (k > 0n && k < N) return `0x${k.toString(16).padStart(64, '0')}`;
  }
}

/**
 * The key file for `role` ("node" or "operator"), created on first use.
 * Only used for a shared public deployment; the test chain uses Anvil's public keys.
 */
function ensureKey(dir, role) {
  const name = role === 'operator' ? FILES.operatorKey : FILES.nodeKey;
  return sharedSecret(dir, name, newPrivateKey);
}

/**
 * Save the voting mode chosen on /setup. `settings` for mode "shared":
 *   { network, chainId, l1Rpc, rollupAddress, jurisdictionId?, deployBlock? }
 */
function writeVotingConfig(dir, settings) {
  if (!dir) throw new Error('INSTALL_DIR is not set; setup cannot save the voting mode');
  if (!MODES.includes(settings?.mode)) throw new Error(`mode must be one of ${MODES.join(', ')}`);
  const out = { version: 1, mode: settings.mode, savedAt: new Date().toISOString() };
  if (settings.mode === 'shared') {
    for (const key of ['network', 'chainId', 'l1Rpc', 'rollupAddress', 'jurisdictionId', 'deployBlock']) {
      if (settings[key] !== undefined && settings[key] !== null && settings[key] !== '') out[key] = settings[key];
    }
    ensureKey(dir, 'node');
    ensureKey(dir, 'operator');
  }
  writePrivate(path.join(dir, FILES.voting), `${JSON.stringify(out, null, 2)}\n`);
  return out;
}

/**
 * The environment the containers should run with: `env`, plus every value setup knows
 * that `env` leaves empty. Returns { env, sources } where sources[NAME] is "setup" for
 * each filled value. Never throws on a missing directory: an install without
 * INSTALL_DIR behaves exactly as before.
 */
function installEnv(env = process.env) {
  const out = { ...env };
  const sources = {};
  const dir = installDir(env);
  if (!dir) return { env: out, sources, mode: null };
  const fill = (name, value) => {
    if (value === undefined || value === null || value === '') return;
    if (String(out[name] ?? '').trim() !== '') return;
    out[name] = String(value);
    sources[name] = 'setup';
  };

  fill('L2_BALLOT_TOKEN', sharedSecret(dir, FILES.ballotToken));

  const voting = readVotingConfig(dir);
  if (voting?.mode === 'local-test') {
    fill('L1_RPC', LOCAL_TEST_CHAIN.l1Rpc);
    fill('L1_CHAIN_ID', LOCAL_CHAIN_ID);
    fill('ROLLUP_DEPLOYMENT_FILE', LOCAL_TEST_CHAIN.deploymentFile);
    fill('ROLLUP_PRIVATE_KEY', LOCAL_TEST_CHAIN.nodeKey);
    fill('OPERATOR_PRIVATE_KEY', LOCAL_TEST_CHAIN.operatorKey);
    // The batch validity circuit is not built; the mock path is accepted on 31337 only.
    fill('ZK_VOTING_ALLOW_MOCK_PROOFS', '1');
  } else if (voting?.mode === 'shared') {
    fill('L1_RPC', voting.l1Rpc);
    fill('L1_CHAIN_ID', voting.chainId);
    fill('ROLLUP_ADDRESS', voting.rollupAddress);
    fill('ROLLUP_JURISDICTION_ID', voting.jurisdictionId);
    fill('ROLLUP_DEPLOY_BLOCK', voting.deployBlock);
    const nodeKey = readText(path.join(dir, FILES.nodeKey));
    const operatorKey = readText(path.join(dir, FILES.operatorKey));
    if (isHex32(nodeKey)) fill('ROLLUP_PRIVATE_KEY', nodeKey);
    if (isHex32(operatorKey)) fill('OPERATOR_PRIVATE_KEY', operatorKey);
  }
  return { env: out, sources, mode: voting?.mode || null };
}

/** Fill process.env in place (start-up only). Returns the names it filled. */
function applyInstallEnv(target = process.env) {
  const { env, sources, mode } = installEnv(target);
  for (const name of Object.keys(sources)) target[name] = env[name];
  return { filled: Object.keys(sources), mode };
}

module.exports = {
  INSTALL_FILES: FILES,
  VOTING_MODES: MODES,
  LOCAL_TEST_CHAIN,
  installDir,
  sharedSecret,
  readVotingConfig,
  votingConfigStamp,
  writeVotingConfig,
  ensureKey,
  newPrivateKey,
  installEnv,
  applyInstallEnv,
};

/** The networks /setup offers (networks.json), with the built-in test chain first. */
function listNetworks() {
  // Read fresh each time: tiny file, and a redeploy with an updated registry needs no restart.
  const raw = fs.readFileSync(path.join(__dirname, 'networks.json'), 'utf8');
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed.networks) ? parsed.networks : [];
}

function findNetwork(id) {
  return listNetworks().find((n) => n.id === id) || null;
}

module.exports.listNetworks = listNetworks;
module.exports.findNetwork = findNetwork;

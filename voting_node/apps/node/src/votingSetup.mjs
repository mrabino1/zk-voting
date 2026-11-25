// NOT FOR PROFIT — civic public good, not a commercial product.
//
// /setup, "How will civic votes be counted?": the choice a person deploying a fork makes
// without knowing chain ids, contract addresses or environment variables.
//
//   polls       Polls only. Counted on this node; no blockchain. Civic votes are off.
//   local-test  The built-in test chain (Compose services l1 + l1-deploy, chain 31337).
//               Free practice elections; nothing of value at stake.
//   shared      The one shared ZkVotingRollup on a public network from networks.json.
//               This node gets its own keys; the person funds them with ETH for gas.
//
// Settings land in INSTALL_DIR/voting.json (packages/chain-client/install.js). The node and
// the l2 operator read them at start-up after the environment, so a value set in the
// environment always wins and is shown here as fixed.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { privateKeyToAccount } from 'viem/accounts';

import { HttpError } from './http.mjs';
import { settingSource } from './platformEnv.mjs';

const install = createRequire(import.meta.url)('@zk-voting/chain-client/install');

/** Settings that decide where civic votes settle. If the operator typed any, setup leaves them alone. */
export const ROLLUP_ENV = Object.freeze(['L1_RPC', 'ROLLUP_ADDRESS', 'ROLLUP_DEPLOYMENT_FILE', 'ROLLUP_PRIVATE_KEY', 'OPERATOR_PRIVATE_KEY']);

function addressOf(key) {
  try {
    return /^0x[0-9a-fA-F]{64}$/.test(String(key || '')) ? privateKeyToAccount(key).address : null;
  } catch {
    return null;
  }
}

/** Public view of networks.json for the setup screen. */
export function networksForSetup() {
  return install.listNetworks().map((n) => ({
    id: n.id,
    name: n.name,
    chainId: n.chainId,
    kind: n.kind,
    builtIn: Boolean(n.builtIn),
    summary: n.summary,
    available: Boolean(n.civicVotes?.available) && Boolean(n.rollup?.address),
    availabilityNote: n.civicVotes?.note || '',
    explorer: n.explorer || null,
    rpcHints: n.rpcHints || [],
    faucet: n.faucet || null,
    joinPolicy: n.joinPolicy || null,
  }));
}

/** Names of rollup settings the operator fixed in the environment (not filled by setup). */
export function envLockedRollupSettings(env = process.env) {
  return ROLLUP_ENV.filter((name) => settingSource(name, env) === 'environment');
}

/** Elections already published to L1 under the current settings. Changing the mode would strand them. */
export function publishedCivicVotes(store) {
  const rows = typeof store?.listElections === 'function' ? store.listElections() : [];
  return rows.filter((e) => e?.rollup?.electionId).map((e) => ({ id: e.id, title: e.title }));
}

/**
 * What /setup shows for this step.
 * @param {{ installDir?: string, store?: object, requestRestart?: Function|null }} deps
 */
export function votingSetupStatus(deps, env = process.env) {
  const dir = deps.installDir || '';
  const saved = dir ? install.readVotingConfig(dir) : null;
  const locked = envLockedRollupSettings(env);
  let mode = saved?.mode || null;
  // Configured by hand in the environment, without /setup: describe what is there.
  if (!mode && locked.length) mode = 'environment';
  const keys = {};
  if (dir && saved?.mode === 'shared') {
    const read = (name) => {
      try {
        return fs.readFileSync(path.join(dir, name), 'utf8').trim();
      } catch {
        return '';
      }
    };
    keys.nodeAddress = addressOf(read(install.INSTALL_FILES.nodeKey));
    keys.operatorAddress = addressOf(read(install.INSTALL_FILES.operatorKey));
  }
  return {
    available: Boolean(dir),
    mode,
    network: saved?.network || (saved?.mode === 'local-test' ? 'local-test' : null),
    l1Rpc: saved?.mode === 'shared' ? redactRpc(saved.l1Rpc) : null,
    savedAt: saved?.savedAt || null,
    lockedByEnvironment: locked,
    keys,
    published: publishedCivicVotes(deps.store),
    restartsAutomatically: typeof deps.requestRestart === 'function',
    networks: networksForSetup(),
  };
}

/** Show an RPC URL without credentials a provider may have put in its path or query. */
export function redactRpc(url) {
  try {
    const u = new URL(String(url));
    const path = u.pathname.length > 12 ? `${u.pathname.slice(0, 6)}…` : u.pathname;
    return `${u.protocol}//${u.host}${path}${u.search ? '?…' : ''}`;
  } catch {
    return null;
  }
}

/** Ask an RPC endpoint for its chain id. */
export async function rpcChainId(url, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`the RPC answered HTTP ${res.status}`);
  const body = await res.json();
  if (!body || typeof body.result !== 'string') throw new Error('the RPC did not return a chain id');
  return Number(BigInt(body.result));
}

function validRpcUrl(raw) {
  const value = String(raw || '').trim();
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return value;
}

/**
 * Save the voting mode. Throws HttpError with a plain-English message a non-technical
 * person can act on.
 * @param {{ mode: string, network?: string, l1Rpc?: string }} body
 */
export async function saveVotingMode(deps, body, { env = process.env, fetchImpl = fetch } = {}) {
  const dir = deps.installDir || '';
  if (!dir) {
    throw new HttpError(409, 'This deployment has no shared settings volume, so setup cannot change how civic votes are counted. Use docker-compose.coolify.yml, or set the rollup variables in the environment.', {
      code: 'SETUP_NO_INSTALL_DIR',
    });
  }
  const locked = envLockedRollupSettings(env);
  if (locked.length) {
    throw new HttpError(409, `These are fixed in your hosting environment, so setup leaves them alone: ${locked.join(', ')}. Remove them there to choose here instead.`, {
      code: 'SETUP_ROLLUP_FIXED_BY_ENV',
      locked,
    });
  }
  const published = publishedCivicVotes(deps.store);
  const current = install.readVotingConfig(dir);
  const mode = String(body?.mode || '');
  if (!install.VOTING_MODES.includes(mode)) {
    throw new HttpError(400, 'Choose polls only, the built-in test chain, or a shared Ethereum network.', { code: 'SETUP_BAD_MODE' });
  }
  const sameAsNow = current && current.mode === mode && (mode !== 'shared' || current.network === body?.network);
  if (published.length && !sameAsNow) {
    throw new HttpError(409, `${published.length} civic vote${published.length === 1 ? ' is' : 's are'} already on the current chain. Changing how votes are counted now would strand ${published.length === 1 ? 'it' : 'them'}.`, {
      code: 'SETUP_CIVIC_VOTES_PUBLISHED',
      published,
    });
  }

  if (mode === 'polls') return install.writeVotingConfig(dir, { mode });

  if (mode === 'local-test') {
    const local = install.findNetwork('local-test');
    try {
      const chainId = await rpcChainId(install.LOCAL_TEST_CHAIN.l1Rpc, { fetchImpl, timeoutMs: 4000 });
      if (chainId !== local.chainId) throw new Error(`it reports chain ${chainId}`);
    } catch (err) {
      throw new HttpError(409, `The built-in test chain is not running in this deployment (${err.message}). It is part of docker-compose.coolify.yml, and of docker-compose.yml with COMPOSE_PROFILES=local-l1.`, {
        code: 'SETUP_TEST_CHAIN_DOWN',
      });
    }
    return install.writeVotingConfig(dir, { mode });
  }

  // shared
  const network = install.findNetwork(String(body?.network || ''));
  if (!network || network.builtIn) {
    throw new HttpError(400, 'Choose one of the listed public networks.', { code: 'SETUP_BAD_NETWORK' });
  }
  const view = networksForSetup().find((n) => n.id === network.id);
  if (!view.available) {
    throw new HttpError(409, view.availabilityNote || `${network.name} is not available yet.`, { code: 'SETUP_NETWORK_UNAVAILABLE' });
  }
  const l1Rpc = validRpcUrl(body?.l1Rpc);
  if (!l1Rpc) {
    throw new HttpError(400, `Paste the full RPC address for ${network.name}, starting with https://`, { code: 'SETUP_BAD_RPC' });
  }
  let chainId;
  try {
    chainId = await rpcChainId(l1Rpc, { fetchImpl });
  } catch (err) {
    throw new HttpError(400, `Could not reach that RPC address: ${err.message}. Check it is copied in full.`, { code: 'SETUP_RPC_UNREACHABLE' });
  }
  if (chainId !== network.chainId) {
    throw new HttpError(400, `That RPC address is for chain ${chainId}, not ${network.name} (chain ${network.chainId}). Use an address for ${network.name}.`, {
      code: 'SETUP_RPC_WRONG_CHAIN',
      chainId,
    });
  }
  return install.writeVotingConfig(dir, {
    mode,
    network: network.id,
    chainId: network.chainId,
    l1Rpc,
    rollupAddress: network.rollup.address,
    deployBlock: network.rollup.deployBlock ?? undefined,
  });
}

// NOT FOR PROFIT — civic public good, not a commercial product.
// One-time deploy guard for ZkVotingRollup, the one L1 contract. App containers never
// deploy; they read ROLLUP_ADDRESS (or the record) and use it.
//
// The rule (same as scripts/deploy.sh): a set ROLLUP_ADDRESS, or a deployment record whose
// rollup address has code on the chain, refuses another deploy unless FORCE_REDEPLOY=1.

import fs from 'node:fs';
import path from 'node:path';

import { l1RpcHeaders, redactL1RpcAuth } from '../../l2/l1RpcAuth.js';

const FORCE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function isForceRedeploy(env = {}) {
  return FORCE_VALUES.has(String(env.FORCE_REDEPLOY || '').trim().toLowerCase());
}

/** The rollup address a record names (Deploy.s.sol / DeployLocal.s.sol output), or null. */
export function recordRollup(record) {
  const value = String(record?.rollup || '').trim();
  return ADDRESS_RE.test(value) ? value : null;
}

/**
 * @param {{ env?: Record<string, string|undefined>, record?: object|null, recordHasCode?: boolean }} input
 *        recordHasCode: whether the record's rollup address has code on the target chain
 *        (a record left over from a wiped local chain does not block a deploy).
 */
export function assessDeploy({ env = {}, record = null, recordHasCode = true } = {}) {
  const pinned = String(env.ROLLUP_ADDRESS || '').trim();
  const recorded = recordRollup(record);
  const live = Boolean(recorded) && recordHasCode;
  const blocked = Boolean(pinned) || live;
  const force = isForceRedeploy(env);
  if (blocked && !force) {
    return {
      ok: false,
      forced: false,
      reason: pinned ? 'ROLLUP_ADDRESS already set' : 'deployment record names a live rollup',
      pinned: pinned || null,
      recorded,
    };
  }
  return {
    ok: true,
    forced: blocked && force,
    warning: blocked && force
      ? 'FORCE_REDEPLOY=1 deploys a second rollup. Every jurisdiction must then move to it; do not do this during a live election.'
      : null,
    pinned: pinned || null,
    recorded,
  };
}

export function formatEnvLines({ rollup, chainId } = {}) {
  const lines = [];
  if (chainId != null && chainId !== '') lines.push(`L1_CHAIN_ID=${chainId}`);
  if (rollup) lines.push(`ROLLUP_ADDRESS=${rollup}`);
  return lines.join('\n');
}

/** smart-contracts/deployments/<chainId>.json, or local.json on 31337. */
export function deploymentRecordPath(contractsDir, chainId) {
  return path.join(contractsDir, 'deployments', String(chainId) === '31337' ? 'local.json' : `${chainId}.json`);
}

export function readDeploymentRecord(file) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

async function rpc(rpcUrl, method, params, fetchImpl, env = process.env) {
  const res = await fetchImpl(rpcUrl, {
    method: 'POST',
    headers: l1RpcHeaders(env),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(redactL1RpcAuth(body.error.message || `${method} failed`, env));
  return body.result;
}

export async function verifyDeployedCode(rpcUrl, address, fetchImpl = fetch, env = process.env) {
  const code = String((await rpc(rpcUrl, 'eth_getCode', [address, 'latest'], fetchImpl, env)) || '');
  if (!code || code === '0x' || code === '0x0') throw new Error(`no code at ${address}`);
  return code;
}

export async function hasCode(rpcUrl, address, fetchImpl = fetch, env = process.env) {
  try {
    await verifyDeployedCode(rpcUrl, address, fetchImpl, env);
    return true;
  } catch {
    return false;
  }
}

export async function chainIdOf(rpcUrl, fetchImpl = fetch, env = process.env) {
  return Number(BigInt(await rpc(rpcUrl, 'eth_chainId', [], fetchImpl, env)));
}

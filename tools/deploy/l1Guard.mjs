// NOT FOR PROFIT — civic public good, not a commercial product.
// One-time L1 deploy guard. App containers do not import this to deploy;
// they only read the addresses it prints.

import fs from 'node:fs';
import path from 'node:path';

export const PINNED_ADDRESS_KEYS = Object.freeze([
  'SETTLEMENT_ADDRESS',
  'VERIFIER_ADDRESS',
  'L1_TALLY_MIRROR_ADDRESS',
  'L1_SETTLEMENT_ADDRESS',
  'ELECTION_FACTORY_ADDRESS',
  'BALLOT_INBOX_ADDRESS',
]);

const FORCE_VALUES = new Set(['1', 'true', 'yes', 'on']);

export function isForceRedeploy(env = {}) {
  return FORCE_VALUES.has(String(env.FORCE_REDEPLOY || '').trim().toLowerCase());
}

export function filledAddressKeys(env = {}) {
  return PINNED_ADDRESS_KEYS.filter((key) => String(env[key] || '').trim().length > 0);
}

export function recordHasDeployment(record) {
  if (!record || record.deployed !== true) return false;
  const addresses = record.addresses && typeof record.addresses === 'object' ? record.addresses : {};
  return Object.values(addresses).some((value) => String(value || '').trim().length > 0);
}

/**
 * @param {{ env?: Record<string, string|undefined>, record?: object|null }} input
 */
export function assessDeploy({ env = {}, record = null } = {}) {
  const setKeys = filledAddressKeys(env);
  const recordDeployed = recordHasDeployment(record);
  const force = isForceRedeploy(env);
  if ((setKeys.length > 0 || recordDeployed) && !force) {
    return {
      ok: false,
      forced: false,
      reason: setKeys.length > 0 ? 'address env already set' : 'deployment record exists',
      setKeys,
      recordDeployed,
    };
  }
  if (force && (setKeys.length > 0 || recordDeployed)) {
    return {
      ok: true,
      forced: true,
      warning:
        'FORCE_REDEPLOY=1 overrides an existing L1 deployment. This can split the chain of record. Do not use on a live election.',
      setKeys,
      recordDeployed,
    };
  }
  return { ok: true, forced: false, warning: null, setKeys, recordDeployed };
}

export function formatEnvLines(addresses = {}) {
  const lines = [];
  for (const key of PINNED_ADDRESS_KEYS) {
    const value = String(addresses[key] || '').trim();
    if (value) lines.push(`${key}=${value}`);
  }
  return lines.join('\n');
}

export function deploymentRecordPath(root, chainId) {
  return path.join(root, 'deployments', `${chainId}.json`);
}

export function readDeploymentRecord(file) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function writeDeploymentRecord(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export async function verifyDeployedCode(rpcUrl, address, fetchImpl = fetch) {
  const res = await fetchImpl(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getCode',
      params: [address, 'latest'],
    }),
  });
  const body = await res.json();
  if (body.error) {
    throw new Error(body.error.message || 'eth_getCode failed');
  }
  const code = String(body.result || '');
  if (!code || code === '0x' || code === '0x0') {
    throw new Error(`no code at ${address}`);
  }
  return code;
}

export async function verifyAddressSet(rpcUrl, addresses, fetchImpl = fetch) {
  const checked = {};
  for (const [key, value] of Object.entries(addresses)) {
    const address = String(value || '').trim();
    if (!address) continue;
    checked[key] = await verifyDeployedCode(rpcUrl, address, fetchImpl);
  }
  return checked;
}

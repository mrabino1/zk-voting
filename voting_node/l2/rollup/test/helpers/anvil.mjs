// NOT FOR PROFIT — civic public good, not a commercial product.
// Start Anvil and deploy ZkVotingRollup with smart-contracts/script/DeployLocal.s.sol.

import { l1RpcHeaders } from '../../../l1RpcAuth.js';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const CONTRACTS = path.resolve(here, '../../../../../smart-contracts');
/** Anvil's first dev key: the governor, and by default also operator and clerk. */
export const DEV_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
/** Anvil accounts 1 and 2: the operator and node clerk in the Docker Compose layout. */
export const OPERATOR_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
export const OPERATOR_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
export const CLERK_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
export const CLERK_ADDRESS = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

function foundryBin(name) {
  for (const p of [process.env[`${name.toUpperCase()}_BIN`], path.join(os.homedir(), '.foundry/bin', name), name]) {
    if (!p) continue;
    try {
      execFileSync(p, ['--version'], { stdio: 'ignore' });
      return p;
    } catch {}
  }
  return null;
}

export const foundryAvailable = () => Boolean(foundryBin('anvil') && foundryBin('forge'));

export async function startAnvil() {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(foundryBin('anvil'), ['--port', String(port), '--silent'], { stdio: 'ignore' });
  const rpcUrl = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: l1RpcHeaders(process.env),
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      });
      if (res.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  const rpc = async (method, params = []) => {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: l1RpcHeaders(process.env),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const body = await res.json();
    if (body.error) throw new Error(body.error.message);
    return body.result;
  };
  return {
    rpcUrl,
    rpc,
    /** Move L1 time forward and mine a block there. */
    async warp(seconds) {
      await rpc('evm_increaseTime', [seconds]);
      await rpc('evm_mine');
    },
    async now() {
      const block = await rpc('eth_getBlockByNumber', ['latest', false]);
      return Number(BigInt(block.timestamp));
    },
    stop: () => child.kill(),
  };
}

/** @param {{ operator?: string, clerk?: string }} [roles] addresses; default the deployer */
export function deployLocal(rpcUrl, roles = {}) {
  const env = { ...process.env, PRIVATE_KEY: DEV_KEY };
  delete env.OPERATOR;
  delete env.CLERK;
  if (roles.operator) env.OPERATOR = roles.operator;
  if (roles.clerk) env.CLERK = roles.clerk;
  execFileSync(
    foundryBin('forge'),
    ['script', 'script/DeployLocal.s.sol', '--rpc-url', rpcUrl, '--broadcast', '--slow'],
    { cwd: CONTRACTS, stdio: 'ignore', env },
  );
  const file = path.join(CONTRACTS, 'deployments/local.json');
  if (!existsSync(file)) throw new Error('DeployLocal did not write deployments/local.json');
  return JSON.parse(readFileSync(file, 'utf8'));
}

// NOT FOR PROFIT — civic public good, not a commercial product.
// Start Anvil and deploy ZkVotingRollup with smart-contracts/script/DeployLocal.s.sol.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const CONTRACTS = path.resolve(here, '../../../../../smart-contracts');
/** Anvil's first dev key: governor, operator, clerk, registrar and officer in these tests. */
export const DEV_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

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
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      });
      if (res.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  const rpc = async (method, params = []) => {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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

export function deployLocal(rpcUrl) {
  execFileSync(
    foundryBin('forge'),
    ['script', 'script/DeployLocal.s.sol', '--rpc-url', rpcUrl, '--broadcast', '--slow'],
    { cwd: CONTRACTS, stdio: 'ignore', env: { ...process.env, PRIVATE_KEY: DEV_KEY } },
  );
  const file = path.join(CONTRACTS, 'deployments/local.json');
  if (!existsSync(file)) throw new Error('DeployLocal did not write deployments/local.json');
  return JSON.parse(readFileSync(file, 'utf8'));
}

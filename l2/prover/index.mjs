#!/usr/bin/env node
// NOT FOR PROFIT — civic public good, not a commercial prover.
// Watches Republic L2 blocks, batches them, and settles proofs to L1
// RollupSettlement — or writes mock proofs locally.
import fs from 'node:fs';
import path from 'node:path';
import { WriterLease } from '../lease/lease.mjs';
import { loadConfig } from '../sequencer/state.mjs';
import { ROLLUP_SETTLEMENT_ABI } from './batch.mjs';
import {
  assertProverDoesNotDeploy,
  loadSettlementView,
  readCursor,
  runProverTick,
} from './settle.mjs';

const config = loadConfig();
fs.mkdirSync(path.join(config.dataDir, 'proofs'), { recursive: true });

async function rpc(method, params = []) {
  const res = await fetch(config.l2RpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(8000),
  });
  const json = await res.json();
  if (json.error) {
    throw new Error(json.error.message || 'rpc error');
  }
  return json.result;
}

async function waitForRpc() {
  for (let i = 0; i < 100; i++) {
    try {
      const id = await rpc('eth_chainId');
      if (BigInt(id) === BigInt(config.chainId)) return;
    } catch {
      // sequencer not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`L2 RPC not ready at ${config.l2RpcUrl}`);
}

function asBytes32(value) {
  const h = String(value);
  const body = h.startsWith('0x') ? h.slice(2) : h;
  return '0x' + body.padStart(64, '0');
}

function asG1(pair) {
  return [BigInt(pair[0]), BigInt(pair[1])];
}

async function submitBatchL1(batch) {
  if (!config.l1Rpc || !config.settlementAddress || !config.privateKey) {
    return { submitted: false, reason: 'L1_RPC, SETTLEMENT_ADDRESS, or PRIVATE_KEY not set' };
  }
  if (!config.devMockProof) {
    return {
      submitted: false,
      reason: 'DEV_MOCK_PROOF=false and production groth16 keys are not present',
    };
  }
  let viem;
  let accounts;
  try {
    viem = await import('viem');
    accounts = await import('viem/accounts');
  } catch {
    return { submitted: false, reason: 'viem is not installed; wrote proof JSON instead' };
  }
  const pk = config.privateKey.startsWith('0x') ? config.privateKey : `0x${config.privateKey}`;
  const account = accounts.privateKeyToAccount(pk);
  const publicClient = viem.createPublicClient({ transport: viem.http(config.l1Rpc) });
  const chainId = await publicClient.getChainId();
  const chain = viem.defineChain({
    id: chainId,
    name: 'l1',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [config.l1Rpc] } },
  });
  const wallet = viem.createWalletClient({
    account,
    chain,
    transport: viem.http(config.l1Rpc),
  });
  const hash = await wallet.writeContract({
    address: config.settlementAddress,
    abi: ROLLUP_SETTLEMENT_ABI,
    functionName: 'submitBatch',
    args: [
      BigInt(batch.batchIndex),
      asBytes32(batch.prevStateRoot),
      asBytes32(batch.newStateRoot),
      asBytes32(batch.dataHash),
      asG1(batch.proof.a),
      [asG1(batch.proof.b[0]), asG1(batch.proof.b[1])],
      asG1(batch.proof.c),
    ],
  });
  return { submitted: true, l1TxHash: hash };
}

async function tick(cursor, lease) {
  if (lease && !lease.holds()) {
    const got = lease.tryAcquire();
    if (!got.acquired) return;
    lease.startHeartbeat();
    console.log(`prover active epoch=${got.epoch}`);
    Object.assign(cursor, readCursor(config.dataDir));
  }
  const gate = await loadSettlementView(config);
  if (gate.mode === 'fail-closed') {
    console.error(`prover fail closed: ${gate.reason}`);
    return;
  }
  const result = await runProverTick({
    config,
    cursor,
    l2Rpc: config.l2RpcUrl,
    gate,
    submit: submitBatchL1,
  });
  Object.assign(cursor, result.cursor);
  for (const action of result.actions) {
    if (action.failClosed) {
      console.error(`prover fail closed: ${action.reason}`);
      continue;
    }
    if (action.duplicate) {
      console.log(`batch already recorded (${action.reason})`);
      continue;
    }
    const dest = action.submitted ? `L1 ${action.l1TxHash}` : 'local proof';
    console.log(`batch settled -> ${dest}`);
  }
}

async function main() {
  assertProverDoesNotDeploy();
  console.log(
    'Republic L2 prover  NOT FOR PROFIT  rpc=' +
      config.l2RpcUrl +
      '  batchSize=' +
      config.batchSize +
      '  mock=' +
      config.devMockProof +
      '  voteProvingPath=' +
      Boolean(config.voteProvingPath) +
      ' (vote circuit; distinct from DEV_MOCK_PROOF rollup batches)',
  );
  const lease = new WriterLease({ dataDir: config.dataDir, role: 'prover' });
  let stop = false;
  const requestStop = () => {
    stop = true;
  };
  process.on('SIGTERM', requestStop);
  process.on('SIGINT', requestStop);
  await waitForRpc();
  const cursor = readCursor(config.dataDir);
  while (!stop) {
    try {
      await tick(cursor, lease);
    } catch (err) {
      console.warn('prover tick failed (will retry):', err.message || err);
    }
    const slice = Math.min(config.blockTimeMs || 1000, 1000);
    const step = 100;
    let left = slice;
    while (left > 0 && !stop) {
      await new Promise((r) => setTimeout(r, Math.min(step, left)));
      left -= step;
    }
  }
  lease.release();
  console.log('prover stopped');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

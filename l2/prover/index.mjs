#!/usr/bin/env node
// NOT FOR PROFIT — civic public good, not a commercial prover.
// Watches Republic L2 blocks, batches them, and settles proofs to L1
// RollupSettlement — or writes mock proofs locally.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ZERO_HASH } from '../sequencer/state.mjs';
import { buildBatch, ROLLUP_SETTLEMENT_ABI } from './batch.mjs';

const config = loadConfig();
fs.mkdirSync(path.join(config.dataDir, 'proofs'), { recursive: true });

const cursorPath = path.join(config.dataDir, 'proofs', 'cursor.json');

function readCursor() {
  if (!fs.existsSync(cursorPath)) {
    return { lastProvenBlock: 0, lastBatchIndex: -1 };
  }
  return JSON.parse(fs.readFileSync(cursorPath, 'utf8'));
}

function writeCursor(cursor) {
  const tmp = cursorPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cursor) + '\n');
  fs.renameSync(tmp, cursorPath);
}

function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

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

function hexToNumber(q) {
  if (q == null) return 0;
  return Number(BigInt(q));
}

function rpcBlockToLocal(block) {
  return {
    number: hexToNumber(block.number),
    hash: block.hash,
    parentHash: block.parentHash,
    stateRoot: block.stateRoot,
    timestamp: hexToNumber(block.timestamp),
    transactions: Array.isArray(block.transactions) ? block.transactions : [],
  };
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

async function proveRange(cursor, start, end) {
  const blocks = [];
  for (let n = start; n <= end; n++) {
    const raw = await rpc('eth_getBlockByNumber', ['0x' + n.toString(16), true]);
    if (!raw) throw new Error(`missing block ${n}`);
    blocks.push(rpcBlockToLocal(raw));
  }
  let prevStateRoot = ZERO_HASH;
  if (start === 0) {
    prevStateRoot = config.genesisStateRoot || ZERO_HASH;
  } else {
    const parent = await rpc('eth_getBlockByNumber', ['0x' + (start - 1).toString(16), false]);
    prevStateRoot = parent?.stateRoot || ZERO_HASH;
  }
  const batchIndex = cursor.lastBatchIndex + 1;
  const batch = buildBatch({ batchIndex, blocks, prevStateRoot });
  const proofPath = path.join(config.dataDir, 'proofs', `batch-${batchIndex}.json`);
  const settlement = await submitBatchL1(batch);
  const record = {
    ...batch,
    mock: Boolean(config.devMockProof),
    submitted: Boolean(settlement.submitted),
    submitReason: settlement.reason || null,
    l1TxHash: settlement.l1TxHash || null,
    writtenAt: new Date().toISOString(),
  };
  writeJsonAtomic(proofPath, record);
  writeCursor({
    lastProvenBlock: end,
    lastBatchIndex: batchIndex,
    lastDataHash: batch.dataHash,
  });
  const dest = settlement.submitted
    ? `L1 ${settlement.l1TxHash}`
    : proofPath;
  console.log(
    `batch ${batchIndex} blocks ${start}-${end} dataHash=${batch.dataHash} -> ${dest}`,
  );
}

async function tick(cursor) {
  const latest = hexToNumber(await rpc('eth_blockNumber'));
  const batchSize = config.batchSize || 4;
  while (latest - cursor.lastProvenBlock >= batchSize) {
    const start = cursor.lastProvenBlock + 1;
    const end = start + batchSize - 1;
    await proveRange(cursor, start, end);
    Object.assign(cursor, readCursor());
  }
}

async function main() {
  console.log(
    'Republic L2 prover  NOT FOR PROFIT  rpc=' +
      config.l2RpcUrl +
      '  batchSize=' +
      config.batchSize +
      '  mock=' +
      config.devMockProof,
  );
  await waitForRpc();
  const cursor = readCursor();
  while (true) {
    try {
      await tick(cursor);
    } catch (err) {
      console.warn('prover tick failed (will retry):', err.message || err);
    }
    await new Promise((r) => setTimeout(r, Math.min(config.blockTimeMs, 1000)));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

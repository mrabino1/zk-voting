// NOT FOR PROFIT — civic public good, not a commercial prover.
// Settlement decisions for the prover. The prover never deploys contracts.
// It reads SETTLEMENT_ADDRESS and refuses to submit when that address is
// missing, has no code, or sits on a different chain than L1_CHAIN_ID.
import fs from 'node:fs';
import path from 'node:path';

import { keccak256Hex } from '../sequencer/state.mjs';
import { buildBatch } from './batch.mjs';

export const BATCH_COUNT_SELECTOR = keccak256Hex('batchCount()').slice(0, 10);

const ZERO_CODE = new Set(['', '0x', '0x0']);

export function assertProverDoesNotDeploy(env = process.env) {
  const flag = String(env.DEPLOY_ON_START || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(flag)) {
    throw new Error(
      'prover refuses to deploy L1 contracts; pin SETTLEMENT_ADDRESS from the one-time deploy',
    );
  }
}

/**
 * @param {{ l1Rpc?: string, settlementAddress?: string, l1ChainId?: string|number,
 *   rpcChainId?: string|number|null, code?: string|null }} view
 */
export function assessSettlement(view) {
  const l1Rpc = String(view.l1Rpc || '').trim();
  if (!l1Rpc) return { ok: true, mode: 'local', reason: null };
  const address = String(view.settlementAddress || '').trim();
  if (!address) {
    return { ok: false, mode: 'fail-closed', reason: 'SETTLEMENT_ADDRESS missing' };
  }
  if (view.l1ChainId == null || String(view.l1ChainId).trim() === '' || Number(view.l1ChainId) === 0) {
    return { ok: false, mode: 'fail-closed', reason: 'L1_CHAIN_ID missing' };
  }
  if (view.rpcChainId == null || String(view.rpcChainId).trim() === '') {
    return { ok: false, mode: 'fail-closed', reason: 'eth_chainId unavailable' };
  }
  let rpcId;
  let want;
  try {
    rpcId = BigInt(view.rpcChainId);
    want = BigInt(view.l1ChainId);
  } catch {
    return { ok: false, mode: 'fail-closed', reason: 'L1 chain id is not an integer' };
  }
  if (rpcId !== want) {
    return {
      ok: false,
      mode: 'fail-closed',
      reason: `L1 chain id mismatch: rpc ${rpcId} != L1_CHAIN_ID ${want}`,
    };
  }
  const code = String(view.code || '').trim().toLowerCase();
  if (ZERO_CODE.has(code)) {
    return { ok: false, mode: 'fail-closed', reason: 'no code at SETTLEMENT_ADDRESS' };
  }
  return { ok: true, mode: 'submit', reason: null };
}

export function proofPathFor(dataDir, batchIndex) {
  return path.join(dataDir, 'proofs', `batch-${batchIndex}.json`);
}

export function cursorPathFor(dataDir) {
  return path.join(dataDir, 'proofs', 'cursor.json');
}

export function readCursor(dataDir) {
  const cursorPath = cursorPathFor(dataDir);
  if (!fs.existsSync(cursorPath)) return { lastProvenBlock: 0, lastBatchIndex: -1 };
  return JSON.parse(fs.readFileSync(cursorPath, 'utf8'));
}

export function readProof(file) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function recordIsSettled(record, batchIndex) {
  if (!record || Number(record.batchIndex) !== Number(batchIndex)) return false;
  if (record.l1TxHash) return true;
  if (record.status === 'recorded' || record.status === 'duplicate') return true;
  if (record.submitted === true) return true;
  // Local mock proofs are durable once the cursor-bearing record exists.
  if (record.status === 'local') return true;
  return false;
}

/**
 * Write the batch record and cursor. Does not call L1.
 * `submit` is invoked at most once, and only after an intent record is on disk
 * and only when the chain batchCount still equals this batchIndex.
 */
export async function commitBatch({
  batch,
  cursor,
  dataDir,
  gate,
  onChainBatchCount = null,
  submit,
  endBlock,
}) {
  const batchIndex = Number(batch.batchIndex);
  const proofPath = proofPathFor(dataDir, batchIndex);
  const existing = readProof(proofPath);
  if (Number(cursor.lastBatchIndex) >= batchIndex || recordIsSettled(existing, batchIndex)) {
    const nextCursor = {
      lastProvenBlock: Math.max(Number(cursor.lastProvenBlock) || 0, Number(endBlock)),
      lastBatchIndex: Math.max(Number(cursor.lastBatchIndex), batchIndex),
      lastDataHash: existing?.dataHash || batch.dataHash,
    };
    writeJsonAtomic(cursorPathFor(dataDir), nextCursor);
    return { ok: true, duplicate: true, submitted: false, reason: 'already recorded', cursor: nextCursor };
  }
  if (!gate || gate.mode === 'fail-closed' || gate.ok === false) {
    return {
      ok: false,
      failClosed: true,
      submitted: false,
      duplicate: false,
      reason: gate?.reason || 'fail closed',
      cursor,
    };
  }
  if (gate.mode === 'submit') {
    if (onChainBatchCount == null || !Number.isFinite(Number(onChainBatchCount))) {
      return {
        ok: false,
        failClosed: true,
        submitted: false,
        reason: 'batchCount unavailable',
        cursor,
      };
    }
    const chainCount = Number(onChainBatchCount);
    if (batchIndex < chainCount) {
      const record = {
        ...batch,
        status: 'duplicate',
        submitted: false,
        submitReason: 'batchIndex already on L1',
        l1TxHash: existing?.l1TxHash || null,
        writtenAt: new Date().toISOString(),
      };
      writeJsonAtomic(proofPath, record);
      const nextCursor = {
        lastProvenBlock: Number(endBlock),
        lastBatchIndex: batchIndex,
        lastDataHash: batch.dataHash,
      };
      writeJsonAtomic(cursorPathFor(dataDir), nextCursor);
      return { ok: true, duplicate: true, submitted: false, reason: 'chain', cursor: nextCursor };
    }
    if (batchIndex !== chainCount) {
      return {
        ok: false,
        failClosed: true,
        submitted: false,
        reason: `batchIndex ${batchIndex} is ahead of L1 batchCount ${chainCount}`,
        cursor,
      };
    }
  }

  writeJsonAtomic(proofPath, {
    ...batch,
    status: 'intent',
    submitted: false,
    l1TxHash: null,
    writtenAt: new Date().toISOString(),
  });

  let settlement = { submitted: false, reason: 'local mock proof' };
  if (gate.mode === 'submit') {
    if (typeof submit !== 'function') {
      return { ok: false, failClosed: true, submitted: false, reason: 'submit function missing', cursor };
    }
    settlement = await submit(batch);
  }
  const record = {
    ...batch,
    status: settlement.submitted ? 'recorded' : 'local',
    mock: gate.mode !== 'submit',
    submitted: Boolean(settlement.submitted),
    submitReason: settlement.reason || null,
    l1TxHash: settlement.l1TxHash || null,
    writtenAt: new Date().toISOString(),
  };
  const nextCursor = {
    lastProvenBlock: Number(endBlock),
    lastBatchIndex: batchIndex,
    lastDataHash: batch.dataHash,
  };
  writeJsonAtomic(proofPath, record);
  writeJsonAtomic(cursorPathFor(dataDir), nextCursor);
  return {
    ok: true,
    duplicate: false,
    submitted: Boolean(settlement.submitted),
    reason: settlement.reason || null,
    cursor: nextCursor,
    l1TxHash: settlement.l1TxHash || null,
  };
}

async function rpcCall(rpcUrl, method, params, fetchImpl) {
  const res = await fetchImpl(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || 'rpc error');
  return json.result;
}

export async function loadSettlementView(config, fetchImpl = fetch) {
  const l1Rpc = String(config.l1Rpc || '').trim();
  const settlementAddress = String(config.settlementAddress || '').trim();
  if (!l1Rpc) {
    return assessSettlement({ l1Rpc: '', settlementAddress, l1ChainId: config.l1ChainId });
  }
  let rpcChainId = null;
  let code = null;
  let batchCount = null;
  try {
    rpcChainId = await rpcCall(l1Rpc, 'eth_chainId', [], fetchImpl);
  } catch {
    rpcChainId = null;
  }
  if (settlementAddress) {
    try {
      code = await rpcCall(l1Rpc, 'eth_getCode', [settlementAddress, 'latest'], fetchImpl);
    } catch {
      code = null;
    }
    try {
      const raw = await rpcCall(
        l1Rpc,
        'eth_call',
        [{ to: settlementAddress, data: BATCH_COUNT_SELECTOR }, 'latest'],
        fetchImpl,
      );
      batchCount = raw ? Number(BigInt(raw)) : null;
    } catch {
      batchCount = null;
    }
  }
  const gate = assessSettlement({
    l1Rpc,
    settlementAddress,
    l1ChainId: config.l1ChainId,
    rpcChainId,
    code,
  });
  return { ...gate, batchCount };
}

export function hexToNumber(q) {
  if (q == null) return 0;
  return Number(BigInt(q));
}

export async function runProverTick({ config, cursor, l2Rpc, gate, submit, fetchImpl = fetch }) {
  assertProverDoesNotDeploy();
  const latest = hexToNumber(await rpcCall(l2Rpc, 'eth_blockNumber', [], fetchImpl));
  const batchSize = config.batchSize || 4;
  const actions = [];
  let current = { ...cursor };
  while (latest - current.lastProvenBlock >= batchSize) {
    const start = current.lastProvenBlock + 1;
    const end = start + batchSize - 1;
    const blocks = [];
    for (let n = start; n <= end; n++) {
      const raw = await rpcCall(l2Rpc, 'eth_getBlockByNumber', ['0x' + n.toString(16), true], fetchImpl);
      if (!raw) throw new Error(`missing block ${n}`);
      blocks.push({
        number: hexToNumber(raw.number),
        hash: raw.hash,
        parentHash: raw.parentHash,
        stateRoot: raw.stateRoot,
        timestamp: hexToNumber(raw.timestamp),
        transactions: Array.isArray(raw.transactions) ? raw.transactions : [],
      });
    }
    let prevStateRoot = config.genesisStateRoot || '0x' + '00'.repeat(32);
    if (start > 0) {
      const parent = await rpcCall(
        l2Rpc,
        'eth_getBlockByNumber',
        ['0x' + (start - 1).toString(16), false],
        fetchImpl,
      );
      prevStateRoot = parent?.stateRoot || prevStateRoot;
    }
    const batchIndex = Number(current.lastBatchIndex) + 1;
    const batch = buildBatch({ batchIndex, blocks, prevStateRoot });
    const result = await commitBatch({
      batch,
      cursor: current,
      dataDir: config.dataDir,
      gate,
      onChainBatchCount: gate.mode === 'submit' ? gate.batchCount : null,
      submit,
      endBlock: end,
    });
    actions.push(result);
    if (result.failClosed) break;
    current = result.cursor || current;
    if (gate.mode === 'submit' && result.submitted) gate.batchCount = batchIndex + 1;
  }
  return { cursor: current, actions, latest };
}

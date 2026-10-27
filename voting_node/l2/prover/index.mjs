#!/usr/bin/env node
// NOT FOR PROFIT — civic public good, not a commercial prover.
// Watches ZK-Voting L2 blocks, batches them, and settles proofs to L1
// RollupSettlement — or writes mock proofs locally.
import fs from 'node:fs';
import path from 'node:path';
import { WriterLease } from '../lease/lease.mjs';
import { loadConfig } from '../sequencer/state.mjs';
import { ROLLUP_SETTLEMENT_ABI } from './batch.mjs';
import { importOptional, resolveIdentityAsync, resolveOperatorAddress } from '../identity.mjs';
import { checkBatchAdmission } from './admission.mjs';
import { checkSubmitterFunding } from './funding.mjs';
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
    return { submitted: false, reason: 'L1_RPC, SETTLEMENT_ADDRESS, or L1_SUBMITTER_PRIVATE_KEY not set' };
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
    viem = await importOptional('viem');
    accounts = await importOptional('viem/accounts');
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
  // L1 values come from batch.settlement: a chained root and
  // dataHash = keccak(abi.encode(index, prev, new)), as RollupSettlement checks.
  const l1 = batch.settlement || batch;
  const hash = await wallet.writeContract({
    address: config.settlementAddress,
    abi: ROLLUP_SETTLEMENT_ABI,
    functionName: 'submitBatch',
    args: [
      BigInt(batch.batchIndex),
      asBytes32(l1.prevStateRoot),
      asBytes32(l1.newStateRoot),
      asBytes32(l1.dataHash),
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
  if (gate.mode === 'submit') {
    const funding = await fundingStatus();
    if (funding && funding.level === 'empty') {
      console.error(`prover holding batches: ${funding.message}`);
      return;
    }
  }
  const result = await runProverTick({
    config,
    cursor,
    l2Rpc: config.l2RpcUrl,
    gate,
    submit: submitBatchL1,
    admit: (blocks) =>
      checkBatchAdmission(blocks, {
        admission: config.admission,
        adminSecret: config.adminSecret,
        chainId: config.chainId,
        l2Uuid: config.l2Uuid,
        getElection: (uuid) => rpc('zkv_getElection', [uuid]),
      }),
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

let submitterAddress = '';
let lastFunding = null;
let lastFundingAt = 0;
async function fundingStatus() {
  if (!config.l1Rpc || !submitterAddress) return null;
  const now = Date.now();
  if (lastFunding && now - lastFundingAt < 5 * 60_000) return lastFunding;
  lastFunding = await checkSubmitterFunding({ l1Rpc: config.l1Rpc, address: submitterAddress });
  lastFundingAt = now;
  if (lastFunding.level === 'low' || lastFunding.level === 'unreachable') console.warn(lastFunding.message);
  return lastFunding;
}

async function main() {
  assertProverDoesNotDeploy();
  submitterAddress = await resolveOperatorAddress(process.env);
  config.identity = await resolveIdentityAsync(process.env);
  console.log(
    `L2 identity  uuid=${config.identity.l2Uuid || '(unset)'}  l2Id=${config.identity.l2Id || '(unset)'}  submitter=${submitterAddress || '(none)'}`,
  );
  for (const p of config.identity.problems) console.warn(`L2 identity: ${p}`);
  if (config.identity.problems.some((p) => p.includes('does not match'))) {
    // Never settle under an identity this operator cannot prove it owns.
    throw new Error('L2_ID does not match the submitter key, L2_UUID and L2_SALT; refusing to start');
  }
  if (config.l1Rpc && submitterAddress) {
    const f = await fundingStatus();
    if (f) console.log(f.message);
  }
  console.log(
    'ZK-Voting L2 prover  NOT FOR PROFIT  rpc=' +
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

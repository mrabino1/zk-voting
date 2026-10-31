// NOT FOR PROFIT — civic public good, not a commercial product.
// The prover never deploys. A missing settlement address fails closed, and
// submitBatch is sent at most once for a batch index.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

import {
  assertProverDoesNotDeploy,
  assessSettlement,
  commitBatch,
  readCursor,
  runProverTick,
} from '../prover/settle.mjs';
import { loadConfig } from '../sequencer/state.mjs';

describe('prover settlement guard', () => {
  const temps = [];

  after(async () => {
    for (const dir of temps) await rm(dir, { recursive: true, force: true });
  });

  async function dir() {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-prover-'));
    temps.push(tmp);
    return tmp;
  }

  test('assessSettlement fails closed without an address, code, or matching chain id', () => {
    assert.equal(assessSettlement({ l1Rpc: '' }).mode, 'local');
    assert.equal(
      assessSettlement({ l1Rpc: 'http://l1', settlementAddress: '', l1ChainId: 1 }).reason,
      'SETTLEMENT_ADDRESS missing',
    );
    assert.equal(
      assessSettlement({
        l1Rpc: 'http://l1',
        settlementAddress: '0xabc',
        l1ChainId: 1,
        rpcChainId: '0x1',
        code: '0x',
      }).reason,
      'no code at SETTLEMENT_ADDRESS',
    );
    assert.match(
      assessSettlement({
        l1Rpc: 'http://l1',
        settlementAddress: '0xabc',
        l1ChainId: 1,
        rpcChainId: '0x5',
        code: '0x1234',
      }).reason,
      /chain id mismatch/,
    );
    assert.equal(
      assessSettlement({
        l1Rpc: 'http://l1',
        settlementAddress: '0xabc',
        l1ChainId: 1,
        rpcChainId: '0x1',
        code: '0x1234',
      }).mode,
      'submit',
    );
  });

  test('dev mock proof is off unless DEV_MOCK_PROOF is set', () => {
    const prev = process.env.DEV_MOCK_PROOF;
    delete process.env.DEV_MOCK_PROOF;
    try {
      assert.equal(loadConfig().devMockProof, false);
      process.env.DEV_MOCK_PROOF = '1';
      assert.equal(loadConfig().devMockProof, true);
    } finally {
      if (prev === undefined) delete process.env.DEV_MOCK_PROOF;
      else process.env.DEV_MOCK_PROOF = prev;
    }
  });

  test('DEPLOY_ON_START is refused', () => {
    assert.throws(() => assertProverDoesNotDeploy({ DEPLOY_ON_START: '1' }), /refuses to deploy/);
    assert.doesNotThrow(() => assertProverDoesNotDeploy({}));
  });

  test('fail closed does not submit or advance the cursor', async () => {
    const dataDir = await dir();
    let calls = 0;
    const cursor = { lastProvenBlock: 0, lastBatchIndex: -1 };
    const result = await commitBatch({
      batch: { batchIndex: 0, dataHash: '0x01' },
      cursor,
      dataDir,
      gate: { ok: false, mode: 'fail-closed', reason: 'SETTLEMENT_ADDRESS missing' },
      submit: async () => {
        calls += 1;
        return { submitted: true };
      },
      endBlock: 4,
    });
    assert.equal(result.failClosed, true);
    assert.equal(calls, 0);
    assert.equal(readCursor(dataDir).lastBatchIndex, -1);
  });

  test('submitBatch is sent once; a replay and an existing chain batch are skipped', async () => {
    const dataDir = await dir();
    let calls = 0;
    const submit = async () => {
      calls += 1;
      return { submitted: true, l1TxHash: '0xabc', reason: 'ok' };
    };
    const gate = { ok: true, mode: 'submit' };
    const first = await commitBatch({
      batch: { batchIndex: 0, dataHash: '0x01' },
      cursor: { lastProvenBlock: 0, lastBatchIndex: -1 },
      dataDir,
      gate,
      onChainBatchCount: 0,
      submit,
      endBlock: 4,
    });
    assert.equal(first.submitted, true);
    assert.equal(calls, 1);
    const replay = await commitBatch({
      batch: { batchIndex: 0, dataHash: '0x01' },
      cursor: first.cursor,
      dataDir,
      gate,
      onChainBatchCount: 1,
      submit,
      endBlock: 4,
    });
    assert.equal(replay.duplicate, true);
    assert.equal(calls, 1);

    const ahead = await dir();
    let aheadCalls = 0;
    const skipped = await commitBatch({
      batch: { batchIndex: 0, dataHash: '0x02' },
      cursor: { lastProvenBlock: 0, lastBatchIndex: -1 },
      dataDir: ahead,
      gate,
      onChainBatchCount: 1,
      submit: async () => {
        aheadCalls += 1;
        return { submitted: true };
      },
      endBlock: 4,
    });
    assert.equal(skipped.duplicate, true);
    assert.equal(skipped.reason, 'chain');
    assert.equal(aheadCalls, 0);
  });

  test('runProverTick fails closed before submit when settlement has no code', async () => {
    const dataDir = await dir();
    let submits = 0;
    const fetchImpl = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      let result = '0x0';
      if (body.method === 'eth_blockNumber') result = '0x4';
      if (body.method === 'eth_getBlockByNumber') {
        const n = Number(BigInt(body.params[0]));
        result = {
          number: '0x' + n.toString(16),
          hash: '0x' + n.toString(16).padStart(64, '0'),
          parentHash: '0x' + Math.max(0, n - 1).toString(16).padStart(64, '0'),
          stateRoot: '0x' + 'ab'.repeat(32),
          timestamp: '0x10',
          transactions: [],
        };
      }
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
    };
    const tick = await runProverTick({
      config: { dataDir, batchSize: 4 },
      cursor: { lastProvenBlock: 0, lastBatchIndex: -1 },
      l2Rpc: 'http://l2',
      gate: { ok: false, mode: 'fail-closed', reason: 'no code at SETTLEMENT_ADDRESS' },
      submit: async () => {
        submits += 1;
        return { submitted: true };
      },
      fetchImpl,
    });
    assert.equal(submits, 0);
    assert.equal(tick.actions[0].failClosed, true);
    assert.equal(readCursor(dataDir).lastBatchIndex, -1);
  });
});

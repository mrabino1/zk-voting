// NOT FOR PROFIT — civic public good, not a commercial product.
// The producer seals a block when there is a transaction, when the disclosure
// hour closes, or once per heartbeat. Block numbers stay contiguous.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

import { buildBatch } from '../prover/batch.mjs';
import { ChainState, loadConfig } from '../sequencer/state.mjs';

const HOUR = 3600;
const HOUR_START = 1_699_999_200;

function civicHex(obj) {
  return '0x' + Buffer.from(JSON.stringify(obj), 'utf8').toString('hex');
}

function voteTxs(block) {
  const txs = block?.transactions || [];
  return txs.filter((tx) => String(tx.civicType || tx.civic?.type || '').toLowerCase() === 'vote');
}

function withEnv(name, value, fn) {
  const prev = process.env[name];
  if (value == null) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

describe('L2 skip empty blocks', () => {
  const temps = [];

  after(async () => {
    for (const dir of temps) await rm(dir, { recursive: true, force: true });
  });

  async function openState(patch = {}) {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-l2-skip-'));
    temps.push(tmp);
    const clock = { t: patch.t ?? HOUR_START + 10 * 60 };
    const config = loadConfig();
    config.dataDir = tmp;
    config.disclosureIntervalSeconds = patch.disclosureIntervalSeconds ?? HOUR;
    config.disclosureDelaySeconds = patch.disclosureDelaySeconds ?? 0;
    config.resultsMinVotes = patch.resultsMinVotes ?? 0;
    config.disclosureMinBlockVotes = patch.disclosureMinBlockVotes ?? 1;
    config.skipEmptyBlocks = patch.skipEmptyBlocks ?? true;
    config.heartbeatSeconds = patch.heartbeatSeconds ?? HOUR;
    config.nowFn = () => clock.t;
    config.zkVotingNodeUrl = '';
    const state = ChainState.open(config);
    return { state, clock, tmp };
  }

  test('loadConfig defaults skip empty blocks and a one-hour heartbeat', () => {
    withEnv('L2_SKIP_EMPTY_BLOCKS', null, () => {
      withEnv('L2_HEARTBEAT_SECONDS', null, () => {
        const cfg = loadConfig();
        assert.equal(cfg.skipEmptyBlocks, true);
        assert.equal(cfg.heartbeatSeconds, 3600);
      });
    });
    withEnv('L2_SKIP_EMPTY_BLOCKS', '0', () => {
      const cfg = loadConfig();
      assert.equal(cfg.skipEmptyBlocks, false);
    });
    withEnv('L2_HEARTBEAT_SECONDS', '120', () => {
      const cfg = loadConfig();
      assert.equal(cfg.heartbeatSeconds, 120);
    });
  });

  test('idle producer does not seal until the heartbeat or the hour boundary', async () => {
    const { state, clock } = await openState({ t: HOUR_START + 10, heartbeatSeconds: 30 });
    assert.equal(state.latestNumber, 0);
    assert.equal(state.shouldProduceBlock(), false);
    assert.equal(await state.tickProducer(), null);
    assert.equal(state.latestNumber, 0);

    clock.t = HOUR_START + 39;
    assert.equal(state.shouldProduceBlock(), false);

    clock.t = HOUR_START + 40;
    const heartbeat = await state.tickProducer();
    assert.equal(heartbeat.number, 1);
    assert.equal(heartbeat.parentHash, state.blocks[0].hash);
    assert.equal(heartbeat.transactions.length, 0);
    assert.equal(heartbeat.timestamp, HOUR_START + 40);
    assert.equal(state.latestNumber, 1);
    assert.equal(Number(BigInt(state.getBlockByNumber('latest', false).number)), 1);
    assert.equal(state.getBlockByNumber('0x1', false).hash, heartbeat.hash);
    assert.equal(state.shouldProduceBlock(), false);
  });

  test('a transaction seals on the next tick and keeps the parent hash chain', async () => {
    const { state } = await openState({ t: HOUR_START + 20 });
    assert.equal(state.shouldProduceBlock(), false);
    const hash = state.enqueueRaw(
      civicHex({ type: 'register', electionId: '1', identityCommitment: '0xabc' }),
    );
    assert.equal(state.shouldProduceBlock(), true);
    const block = await state.tickProducer();
    assert.equal(block.number, 1);
    assert.equal(block.parentHash, state.blocks[0].hash);
    assert.equal(block.transactions.length, 1);
    assert.equal(block.transactions[0].hash, hash);
    assert.equal(state.getTransactionByHash(hash).hash, hash);
    assert.equal(Number(BigInt(state.getBlockByNumber('0x1', true).number)), 1);
    clockQuiet(state);
  });

  test('sealed votes stay hidden until the hour closes, then seal on time', async () => {
    const { state, clock } = await openState({
      t: HOUR_START + 10,
      heartbeatSeconds: 30,
      disclosureIntervalSeconds: HOUR,
    });
    const hash = state.enqueueRaw(
      civicHex({
        type: 'vote',
        electionId: '1',
        nullifier: '0xabc',
        ballotHash: '0xdef',
      }),
    );
    assert.equal(state.shouldProduceBlock(), false, 'a sealed vote is not a public tx yet');
    assert.equal(await state.tickProducer(), null);
    assert.equal(state.getTransactionByHash(hash), null);

    clock.t = HOUR_START + 40;
    const heartbeat = await state.tickProducer();
    assert.equal(voteTxs(heartbeat).length, 0);
    assert.equal(state.getTransactionByHash(hash), null);
    assert.equal(state.disclosureView().lastClosedHourAt, HOUR_START);

    clock.t = HOUR_START + HOUR;
    assert.equal(state.shouldProduceBlock(), true);
    const disclosed = await state.tickProducer();
    assert.equal(disclosed.number, state.blocks[1].number + 1);
    assert.equal(disclosed.parentHash, state.blocks[1].hash);
    assert.equal(disclosed.timestamp, HOUR_START + HOUR);
    const votes = voteTxs(disclosed);
    assert.equal(votes.length, 1);
    assert.equal(votes[0].hash.toLowerCase(), hash.toLowerCase());
    assert.equal(votes[0].receivedAt, undefined);
    assert.ok(state.getTransactionByHash(hash));
    assert.equal(state.shouldProduceBlock(), false);
  });

  test('hour boundary with no votes still seals one empty block', async () => {
    const { state, clock } = await openState({ t: HOUR_START + 10, heartbeatSeconds: HOUR });
    clock.t = HOUR_START + HOUR;
    const block = await state.tickProducer();
    assert.equal(block.number, 1);
    assert.equal(block.transactions.length, 0);
    assert.equal(block.parentHash, state.blocks[0].hash);
    assert.equal(block.timestamp, HOUR_START + HOUR);
    assert.equal(await state.tickProducer(), null);
  });

  test('L2_SKIP_EMPTY_BLOCKS=0 seals an empty block every tick', async () => {
    const { state } = await openState({ t: HOUR_START + 10, skipEmptyBlocks: false });
    assert.equal(state.shouldProduceBlock(), true);
    const block = await state.tickProducer();
    assert.equal(block.number, 1);
    assert.equal(block.transactions.length, 0);
    assert.equal(block.parentHash, state.blocks[0].hash);
  });

  test('skipped time does not gap block numbers or the prover cursor', async () => {
    const { state, clock } = await openState({ t: HOUR_START + 10, heartbeatSeconds: HOUR });
    for (let i = 1; i <= 4; i++) {
      clock.t = HOUR_START + i * HOUR;
      const block = await state.tickProducer();
      assert.equal(block.number, i);
      assert.equal(block.parentHash, state.blocks[i - 1].hash);
    }
    assert.equal(state.latestNumber, 4);
    for (let n = 0; n <= state.latestNumber; n++) {
      const rpc = state.getBlockByNumber('0x' + n.toString(16), true);
      assert.ok(rpc, `eth_getBlockByNumber ${n}`);
      assert.equal(Number(BigInt(rpc.number)), n);
      if (n > 0) assert.equal(rpc.parentHash, state.blocks[n - 1].hash);
    }
    assert.equal(state.getBlockByNumber('0x5', false), null);

    const partial = proveThrough(state, 4, 2);
    assert.equal(partial.ranges.length, 0);
    assert.equal(partial.lastProven, 0);

    const full = proveThrough(state, 4, 4);
    assert.equal(full.ranges.length, 1);
    assert.equal(full.lastProven, 4);
    assert.equal(full.ranges[0].startBlock, 1);
    assert.equal(full.ranges[0].endBlock, 4);
    assert.equal(full.ranges[0].blockHashes.length, 4);
    assert.equal(full.ranges[0].prevStateRoot, state.blocks[0].stateRoot);
  });
});

function clockQuiet(state) {
  assert.equal(state.latestNumber, 1);
}

function proveThrough(state, batchSize, untilBlock) {
  const latest = Math.min(state.latestNumber, untilBlock);
  let lastProven = 0;
  const ranges = [];
  while (latest - lastProven >= batchSize) {
    const start = lastProven + 1;
    const end = start + batchSize - 1;
    const blocks = [];
    for (let n = start; n <= end; n++) {
      const raw = state.getBlockByNumber('0x' + n.toString(16), true);
      if (!raw) throw new Error(`missing block ${n}`);
      blocks.push({
        number: Number(BigInt(raw.number)),
        hash: raw.hash,
        parentHash: raw.parentHash,
        stateRoot: raw.stateRoot,
        timestamp: Number(BigInt(raw.timestamp)),
        transactions: raw.transactions,
      });
    }
    const parent = state.getBlockByNumber('0x' + (start - 1).toString(16), false);
    ranges.push(
      buildBatch({
        batchIndex: ranges.length,
        blocks,
        prevStateRoot: parent.stateRoot,
      }),
    );
    lastProven = end;
  }
  return { ranges, lastProven };
}

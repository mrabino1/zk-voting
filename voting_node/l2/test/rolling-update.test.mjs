// NOT FOR PROFIT — civic public good, not a commercial product.
// One sequencer holds the writer lease. A second process on the same data
// directory stays standby, including while skip-empty would otherwise seal
// a chain-heartbeat block.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { NO_STORE_REASON, loadArchiveConfig } from '../archive/config.mjs';
import { runArchiveJob } from '../archive/job.mjs';
import { WriterLease } from '../lease/lease.mjs';
import { ChainState, loadConfig } from '../sequencer/state.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HOUR_START = 1_699_999_200;

function civicHex(obj) {
  return '0x' + Buffer.from(JSON.stringify(obj), 'utf8').toString('hex');
}

function blockFiles(dir) {
  const blocks = path.join(dir, 'blocks');
  if (!fs.existsSync(blocks)) return [];
  return fs.readdirSync(blocks).filter((name) => name.endsWith('.json')).sort();
}

describe('L2 rolling-update lease', () => {
  const temps = [];
  const children = [];

  after(async () => {
    for (const child of children) {
      if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
    }
    for (const dir of temps) await rm(dir, { recursive: true, force: true });
  });

  async function openPair(patch = {}) {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-l2-lease-'));
    temps.push(tmp);
    const clock = { t: patch.t ?? HOUR_START + 10 };
    const base = loadConfig();
    base.dataDir = tmp;
    base.skipEmptyBlocks = patch.skipEmptyBlocks ?? true;
    base.heartbeatSeconds = patch.heartbeatSeconds ?? 3600;
    base.disclosureIntervalSeconds = patch.disclosureIntervalSeconds ?? 3600;
    base.disclosureDelaySeconds = patch.disclosureDelaySeconds ?? 0;
    base.resultsMinVotes = patch.resultsMinVotes ?? 0;
    base.disclosureMinBlockVotes = patch.disclosureMinBlockVotes ?? 1;
    base.nowFn = () => clock.t;
    base.zkVotingNodeUrl = '';
    base.leaseTtlMs = patch.leaseTtlMs ?? 8_000;
    const active = ChainState.open({ ...base, leaseOwnerId: 'sequencer-active' });
    const standby = ChainState.open({ ...base, leaseOwnerId: 'sequencer-standby' });
    return { tmp, clock, active, standby };
  }

  test('only the lease holder produces, and block numbers stay unique', async () => {
    const { active, standby, clock } = await openPair({ heartbeatSeconds: 30, t: HOUR_START + 10 });
    assert.equal(active.acceptingWrites(), true);
    assert.equal(standby.acceptingWrites(), false);
    assert.equal(active.writerEpoch() > 0, true);
    assert.equal(standby.latestNumber, 0);

    clock.t = HOUR_START + 40;
    const block = await active.tickProducer();
    assert.equal(block.number, 1);
    assert.equal(await standby.tickProducer(), null);
    assert.equal(await standby.produceBlock(), null);
    assert.equal(active.latestNumber, 1);
    assert.equal(fs.readdirSync(path.join(active.config.dataDir, 'blocks')).length, 2);

    const numbers = active.blocks.filter(Boolean).map((b) => b.number);
    assert.deepEqual(numbers, [0, 1]);
    assert.equal(active.blocks[1].parentHash, active.blocks[0].hash);
    await active.stop();
    await standby.stop();
  });

  test('standby does not seal a second skip-empty heartbeat block', async () => {
    const { active, standby, clock, tmp } = await openPair({ heartbeatSeconds: 30, t: HOUR_START + 5 });
    clock.t = HOUR_START + 50;
    const sealed = await active.tickProducer();
    assert.equal(sealed.number, 1);
    assert.equal(sealed.transactions.length, 0);
    assert.equal(await standby.tickProducer(), null);
    assert.equal(blockFiles(tmp).length, 2);
    clock.t = HOUR_START + 80;
    assert.equal(await standby.tickProducer(), null);
    assert.equal(blockFiles(tmp).length, 2);
    const again = await active.tickProducer();
    assert.equal(again.number, 2);
    assert.equal(again.parentHash, sealed.hash);
    await active.stop();
    await standby.stop();
  });

  test('explicit produceBlock still seals for the holder when skip-empty is idle', async () => {
    const { active, standby } = await openPair({ t: HOUR_START + 10, heartbeatSeconds: 3600 });
    assert.equal(active.shouldProduceBlock(), false);
    assert.equal(await active.tickProducer(), null);
    const block = await active.produceBlock();
    assert.equal(block.number, 1);
    assert.equal(await standby.produceBlock(), null);
    const onDisk = JSON.parse(fs.readFileSync(active.blockPath(1), 'utf8'));
    assert.equal(onDisk.hash, block.hash);
    assert.equal(onDisk.epoch, active.writerEpoch());
    assert.throws(() => active.persistBlock(block), /already exists/);
    await active.stop();
    await standby.stop();
  });

  test('expired lease is stolen and the old epoch cannot write', async () => {
    const { active, standby } = await openPair({ leaseTtlMs: 1_000 });
    const previous = active.writerEpoch();
    active.writerLease.stopHeartbeat();
    const meta = JSON.parse(fs.readFileSync(active.writerLease.ownerPath(), 'utf8'));
    meta.heartbeat = Date.now() - 60_000;
    fs.writeFileSync(active.writerLease.ownerPath(), JSON.stringify(meta) + '\n');
    const got = standby.writerLease.tryAcquire();
    assert.equal(got.acquired, true);
    assert.ok(got.epoch > previous);
    standby.writerActive = true;
    assert.equal(standby.acceptingWrites(), true);
    assert.throws(() => active.assertWritable(), /maintenance handover|stale writer fence/);
    assert.equal(active.acceptingWrites(), false);
    await standby.stop();
  });

  test('stop releases the lease and flushes the mempool for the next holder', async () => {
    const { active, standby, tmp } = await openPair();
    const hash = active.enqueueRaw(
      civicHex({ type: 'register', electionId: '9', identityCommitment: '0xabc' }),
    );
    assert.equal(active.mempool.length, 1);
    await active.stop();
    const got = standby.writerLease.tryAcquire();
    assert.equal(got.acquired, true);
    standby.writerActive = true;
    standby.reloadFromDisk();
    assert.equal(standby.acceptingWrites(), true);
    assert.equal(standby.mempool.some((tx) => tx.hash === hash), true);
    const mempool = JSON.parse(fs.readFileSync(path.join(tmp, 'mempool.json'), 'utf8'));
    assert.equal(mempool.some((tx) => tx.hash === hash), true);
    await standby.stop();
  });

  test('same tx hash is accepted once; a different payload with the same nullifier is rejected', async () => {
    const { active, standby } = await openPair({ disclosureIntervalSeconds: 0 });
    const vote = civicHex({
      type: 'vote',
      electionId: '3',
      nullifier: '0x11',
      ballotHash: '0x22',
    });
    const hash = active.enqueueRaw(vote);
    assert.equal(active.enqueueRaw(vote), hash);
    standby.reloadFromDisk();
    assert.equal(standby.enqueueRaw(vote), hash);
    assert.equal(active.mempool.length + active.sealed.length, 1);
    assert.throws(
      () =>
        active.enqueueRaw(
          civicHex({
            type: 'vote',
            electionId: '3',
            nullifier: '0x11',
            ballotHash: '0x33',
          }),
        ),
      /duplicate nullifier/,
    );
    const reg = civicHex({ type: 'register', electionId: '3', identityCommitment: '0xabc' });
    active.enqueueRaw(reg);
    assert.equal(active.enqueueRaw(reg), active.enqueueRaw(reg));
    assert.throws(
      () =>
        active.enqueueRaw(
          civicHex({ type: 'register', electionId: '3', identityCommitment: '0xabc', extra: 1 }),
        ),
      /duplicate identityCommitment/,
    );
    assert.throws(
      () => standby.enqueueRaw(civicHex({ type: 'tally', electionId: '8', countsHash: '0x1' })),
      /maintenance handover/,
    );
    await active.stop();
    await standby.stop();
  });

  test('archive default-on claims the lease and a second job does not prune', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-l2-archive-lease-'));
    temps.push(tmp);
    fs.mkdirSync(path.join(tmp, 'blocks'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'blocks', '0.json'), '{}\n');
    const cfg = loadArchiveConfig({
      env: { ARCHIVE_ENABLED: '1', ARCHIVE_S3_BUCKET: '', ARCHIVE_S3_ENDPOINT: '' },
    });
    cfg.dataDir = tmp;
    const holder = new WriterLease({ dataDir: tmp, role: 'archive', ownerId: 'archive-holder' });
    assert.equal(holder.tryAcquire().acquired, true);
    const blocked = await runArchiveJob({ config: cfg });
    assert.equal(blocked.code, 'ARCHIVE_STANDBY');
    assert.equal(blocked.skipped, true);
    assert.equal(fs.existsSync(path.join(tmp, 'blocks', '0.json')), true);
    holder.release();
    const ran = await runArchiveJob({ config: cfg });
    assert.equal(ran.reason, NO_STORE_REASON);
    assert.equal(ran.skipped, true);
    assert.equal(fs.existsSync(path.join(tmp, 'blocks', '0.json')), true);
  });

  test('SIGTERM handover: the standby sequencer becomes active and exits 0', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-l2-sigterm-'));
    temps.push(tmp);
    const portA = await freePort();
    const portB = await freePort();
    const first = startSequencer(tmp, portA);
    children.push(first);
    const healthA = await waitHealth(portA, 'active');
    assert.equal(healthA.ok, true);
    const second = startSequencer(tmp, portB);
    children.push(second);
    const healthB = await waitHealth(portB, 'standby');
    assert.equal(healthB.acceptingWrites, false);
    first.kill('SIGTERM');
    const code = await exitCode(first);
    assert.equal(code, 0);
    const promoted = await waitHealth(portB, 'active');
    assert.equal(promoted.blockNumber, healthA.blockNumber);
    second.kill('SIGTERM');
    assert.equal(await exitCode(second), 0);
  });
});

function startSequencer(dataDir, port) {
  return spawn(process.execPath, ['l2/sequencer/index.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      L2_DATA_DIR: dataDir,
      L2_RPC_HOST: '127.0.0.1',
      L2_RPC_PORT: String(port),
      L2_SKIP_EMPTY_BLOCKS: '1',
      L2_HEARTBEAT_SECONDS: '3600',
      ZK_VOTING_NODE_URL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitHealth(port, mode) {
  const deadline = Date.now() + 15_000;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      const body = await res.json();
      if (res.status === 200 && body.ok === true && body.mode === mode) return body;
      last = JSON.stringify(body);
    } catch (err) {
      last = err.message;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`health ${port} did not reach ${mode}: ${last}`);
}

function exitCode(child) {
  if (child.exitCode != null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 10_000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

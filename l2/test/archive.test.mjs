// NOT FOR PROFIT — civic public good, not a commercial product.
// Hourly L2 attic: upload sealed hours, prune only after checksum verify.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { ChainState, loadConfig } from '../sequencer/state.mjs';
import { loadArchiveConfig } from '../archive/config.mjs';
import {
  defaultArchiveIo,
  restoreHour,
  runArchiveJob,
  listLocalBlocks,
  readArchiveIndex,
} from '../archive/job.mjs';
import { acquireArchiveLock } from '../archive/lock.mjs';
import { createFileStore, createMemoryStore, sha256Hex } from '../archive/s3.mjs';
import { hourPath, hourStart, isHourArchivable, objectPrefix } from '../archive/hours.mjs';

const HOUR = 3600;
const T0 = 1_700_000_000; // 2023-11-14T22:13:20Z — not on an hour boundary

function writeBlock(dataDir, number, timestamp, txs = []) {
  const block = {
    number,
    hash: `0x${String(number).padStart(64, '0')}`,
    parentHash: number === 0 ? `0x${'00'.repeat(32)}` : `0x${String(number - 1).padStart(64, '0')}`,
    stateRoot: `0x${'ab'.repeat(32)}`,
    timestamp,
    transactions: txs,
    logs: [],
  };
  const file = path.join(dataDir, 'blocks', `${number}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(block) + '\n');
  return block;
}

function writeHead(dataDir, number) {
  fs.writeFileSync(
    path.join(dataDir, 'head.json'),
    JSON.stringify({ number, hash: `0x${String(number).padStart(64, '0')}`, txNonce: '3' }) + '\n',
  );
}

function writeProof(dataDir, index, startBlock, endBlock) {
  const file = path.join(dataDir, 'proofs', `batch-${index}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ batchIndex: index, startBlock, endBlock, mock: true }) + '\n',
  );
}

function writeCursor(dataDir, lastProvenBlock) {
  fs.mkdirSync(path.join(dataDir, 'proofs'), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'proofs', 'cursor.json'),
    JSON.stringify({ lastProvenBlock, lastBatchIndex: 0 }) + '\n',
  );
}

describe('L2 hourly S3/R2 archive attic', () => {
  let tmp;
  let sinkRoot;
  let dataDir;

  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'republic-l2-archive-'));
    sinkRoot = path.join(tmp, 'sink');
    dataDir = path.join(tmp, 'l2-data');
    fs.mkdirSync(path.join(dataDir, 'blocks'), { recursive: true });
    fs.mkdirSync(path.join(dataDir, 'proofs'), { recursive: true });
  });

  after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  function l2Config() {
    const config = loadConfig();
    config.dataDir = dataDir;
    config.disclosureIntervalSeconds = HOUR;
    config.republicNodeUrl = '';
    return config;
  }

  function archiveCfg(extra = {}) {
    return loadArchiveConfig({
      l2Config: l2Config(),
      env: {
        ARCHIVE_ENABLED: '1',
        ARCHIVE_S3_BUCKET: 'l2-archive',
        ARCHIVE_S3_ENDPOINT: `file://${sinkRoot}`,
        ARCHIVE_HOT_WINDOW_HOURS: '2',
        ...extra,
      },
    });
  }

  function seedChain() {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dataDir, 'blocks'), { recursive: true });
    fs.mkdirSync(path.join(dataDir, 'proofs'), { recursive: true });
    fs.rmSync(sinkRoot, { recursive: true, force: true });
    const h0 = hourStart(T0, HOUR);
    writeBlock(dataDir, 0, h0 - 10, []);
    writeBlock(dataDir, 1, h0 + 10, [
      { hash: '0xaaa', nonce: 0, civicType: 'register' },
    ]);
    writeBlock(dataDir, 2, h0 + HOUR + 10, [
      { hash: '0xbbb', nonce: 1, civicType: 'vote' },
    ]);
    writeBlock(dataDir, 3, h0 + 2 * HOUR + 10, [
      { hash: '0xccc', nonce: 2, civicType: 'register' },
    ]);
    writeBlock(dataDir, 4, h0 + 3 * HOUR + 10, []);
    writeHead(dataDir, 4);
    writeProof(dataDir, 0, 1, 1);
    writeProof(dataDir, 1, 2, 2);
    writeCursor(dataDir, 4);
    return h0;
  }

  test('ARCHIVE_ENABLED=0 is a no-op and does not prune', async () => {
    const h0 = seedChain();
    const result = await runArchiveJob({
      config: archiveCfg({ ARCHIVE_ENABLED: '0' }),
      now: h0 + 3 * HOUR + 30,
    });
    assert.equal(result.skipped, true);
    assert.equal(result.ok, true);
    assert.ok(fs.existsSync(path.join(dataDir, 'blocks', '1.json')));
    assert.ok(fs.existsSync(path.join(dataDir, 'blocks', '2.json')));
  });

  test('upload-then-prune sealed hours outside the hot window', async () => {
    const h0 = seedChain();
    const now = h0 + 3 * HOUR + 30;
    const expectedBlockHash = sha256Hex(fs.readFileSync(path.join(dataDir, 'blocks', '1.json')));
    const result = await runArchiveJob({
      config: archiveCfg(),
      now,
    });
    assert.equal(result.ok, true);
    assert.equal(result.skipped, false);
    const prunedHours = result.hours.filter((h) => h.ok && h.pruned > 0);
    assert.ok(prunedHours.length >= 1, JSON.stringify(result.hours, null, 2));
    assert.equal(fs.existsSync(path.join(dataDir, 'blocks', '0.json')), true, 'genesis stays local');
    assert.equal(fs.existsSync(path.join(dataDir, 'blocks', '1.json')), false);
    assert.equal(fs.existsSync(path.join(dataDir, 'head.json')), true);
    assert.equal(fs.existsSync(path.join(dataDir, 'proofs', 'cursor.json')), true);
    assert.equal(fs.existsSync(path.join(dataDir, 'blocks', '4.json')), true, 'hot window stays local');

    const store = createFileStore(`file://${sinkRoot}`, 'l2-archive');
    const prefix = objectPrefix(27427, h0);
    const manifestBody = await store.get(`${prefix}/manifest.json`);
    assert.ok(manifestBody, 'hour manifest uploaded');
    const manifest = JSON.parse(manifestBody.toString('utf8'));
    assert.equal(manifest.kind, 'l2-hour-archive');
    assert.equal(manifest.hashAlgorithm, 'sha256');
    const blockObj = manifest.objects.find((o) => o.key.endsWith('/blocks/1.json'));
    assert.ok(blockObj);
    assert.equal(blockObj.algorithm, 'sha256');
    assert.equal(blockObj.hashedAt, 'pre-upload');
    assert.equal(blockObj.sha256, expectedBlockHash);
    const remote = await store.get(blockObj.key);
    assert.equal(sha256Hex(remote), expectedBlockHash);
    assert.equal(remote.length, blockObj.bytes);

    const local = listLocalBlocks(dataDir).map((b) => b.number);
    assert.ok(local.includes(0));
    assert.ok(!local.includes(1));
  });

  test('failed upload does not prune local copies', async () => {
    const h0 = seedChain();
    const inner = createMemoryStore();
    const store = {
      kind: 'memory',
      async put(key, body) {
        if (String(key).includes('/blocks/1.json')) {
          throw new Error('injected put failure');
        }
        return inner.put(key, body);
      },
      get: inner.get.bind(inner),
      head: inner.head.bind(inner),
      list: inner.list.bind(inner),
    };
    const result = await runArchiveJob({
      config: archiveCfg(),
      store,
      now: h0 + 3 * HOUR + 30,
    });
    assert.equal(result.ok, false);
    const failed = result.hours.find((h) => !h.ok);
    assert.ok(failed, 'expected a failed hour');
    assert.match(failed.error, /injected put failure/);
    assert.equal(failed.code, 'PUT_FAILED');
    assert.equal(fs.existsSync(path.join(dataDir, 'blocks', '1.json')), true);
    assert.equal(fs.existsSync(path.join(dataDir, 'proofs', 'batch-0.json')), true);
  });

  test('checksum mismatch after PUT does not prune', async () => {
    const h0 = seedChain();
    const inner = createMemoryStore();
    const store = {
      kind: 'memory',
      async put(key, body) {
        return inner.put(key, body);
      },
      async get(key) {
        const got = await inner.get(key);
        if (got && String(key).includes('/blocks/1.json')) {
          const copy = Buffer.from(got);
          copy[0] = copy[0] ^ 0xff;
          return copy;
        }
        return got;
      },
      head: inner.head.bind(inner),
      list: inner.list.bind(inner),
    };
    const result = await runArchiveJob({
      config: archiveCfg(),
      store,
      now: h0 + 3 * HOUR + 30,
    });
    assert.equal(result.ok, false);
    const failed = result.hours.find((h) => !h.ok);
    assert.equal(failed.code, 'GET_VERIFY_FAILED');
    assert.equal(fs.existsSync(path.join(dataDir, 'blocks', '1.json')), true);
  });

  test('sequencer reopens after prune and keeps producing', async () => {
    const h0 = seedChain();
    await runArchiveJob({
      config: archiveCfg(),
      now: h0 + 3 * HOUR + 30,
    });
    const config = l2Config();
    config.nowFn = () => h0 + 3 * HOUR + 90;
    const state = ChainState.open(config);
    assert.equal(state.latestNumber, 4);
    assert.ok(state.head);
    assert.equal(state.head.number, 4);
    const next = await state.produceBlock();
    assert.equal(next.number, 5);
    assert.equal(fs.existsSync(path.join(dataDir, 'blocks', '5.json')), true);
  });

  test('restore helper rehydrates a hour prefix read-only', async () => {
    const h0 = seedChain();
    await runArchiveJob({
      config: archiveCfg(),
      now: h0 + 3 * HOUR + 30,
    });
    const out = path.join(tmp, 'restore-hour');
    const result = await restoreHour({
      config: archiveCfg(),
      hour: hourPath(h0),
      out,
    });
    assert.equal(result.ok, true);
    assert.ok(result.restored >= 1);
    const restoredBlock = path.join(out, 'blocks', '1.json');
    assert.equal(fs.existsSync(restoredBlock), true);
    const srcMissing = fs.existsSync(path.join(dataDir, 'blocks', '1.json'));
    assert.equal(srcMissing, false, 'restore is read-only toward the live data dir');
  });

  test('archive index records keys for auditors', async () => {
    const h0 = seedChain();
    await runArchiveJob({
      config: archiveCfg(),
      now: h0 + 3 * HOUR + 30,
    });
    const index = readArchiveIndex(dataDir);
    assert.ok(index.archivedThrough >= 1);
    const hours = Object.values(index.hours);
    assert.ok(hours.length >= 1);
    assert.ok(hours[0].manifestSha256);
    assert.ok(hours[0].prefix.startsWith('l2/27427/'));
  });

  test('optional explorer snapshot is uploaded without pruning Node DATA_DIR', async () => {
    const h0 = seedChain();
    const nodeDir = path.join(tmp, 'node-data');
    fs.mkdirSync(nodeDir, { recursive: true });
    const explorerFile = path.join(nodeDir, 'l2-chain.json');
    fs.writeFileSync(explorerFile, JSON.stringify({ chainId: 27427, blocks: [] }) + '\n');
    const result = await runArchiveJob({
      config: archiveCfg({
        ARCHIVE_EXPLORER_SNAPSHOT: '1',
        ARCHIVE_EXPLORER_FILE: explorerFile,
      }),
      now: h0 + 3 * HOUR + 30,
    });
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(explorerFile), true);
    const store = createFileStore(`file://${sinkRoot}`, 'l2-archive');
    const prefix = objectPrefix(27427, h0);
    const snap = await store.get(`${prefix}/explorer/l2-chain.json`);
    assert.ok(snap, 'explorer snapshot in the hour prefix');
  });

  test('hot-window cutoff keeps the current and previous hour', () => {
    const h0 = 1_699_999_200;
    const now = h0 + 3 * HOUR + 30;
    assert.equal(isHourArchivable(h0, now, HOUR, 2), true);
    assert.equal(isHourArchivable(h0 + HOUR, now, HOUR, 2), true);
    assert.equal(isHourArchivable(h0 + 2 * HOUR, now, HOUR, 2), false);
    assert.equal(isHourArchivable(h0 + 3 * HOUR, now, HOUR, 2), false);
  });

  test('sequencer still requires missing block files when nothing was archived', async () => {
    seedChain();
    fs.unlinkSync(path.join(dataDir, 'blocks', '2.json'));
    const config = l2Config();
    assert.throws(() => ChainState.open(config), /missing block file/);
  });

  test('PUT HTTP 503 does not prune', async () => {
    const h0 = seedChain();
    const inner = createMemoryStore();
    const store = {
      kind: 'memory',
      async put(key, body) {
        if (String(key).includes('/blocks/1.json')) {
          throw new Error('S3 PUT failed: HTTP 503 SlowDown');
        }
        return inner.put(key, body);
      },
      get: inner.get.bind(inner),
      head: inner.head.bind(inner),
      list: inner.list.bind(inner),
    };
    const result = await runArchiveJob({
      config: archiveCfg(),
      store,
      now: h0 + 3 * HOUR + 30,
    });
    assert.equal(result.ok, false);
    assert.equal(result.hours.find((h) => !h.ok).code, 'PUT_FAILED');
    assert.equal(fs.existsSync(path.join(dataDir, 'blocks', '1.json')), true);
  });

  test('PUT HTTP 403 auth failure does not prune', async () => {
    const h0 = seedChain();
    const inner = createMemoryStore();
    const store = {
      kind: 'memory',
      async put(key, body) {
        if (String(key).includes('/blocks/1.json')) {
          throw new Error('S3 PUT failed: HTTP 403 AccessDenied');
        }
        return inner.put(key, body);
      },
      get: inner.get.bind(inner),
      head: inner.head.bind(inner),
      list: inner.list.bind(inner),
    };
    const result = await runArchiveJob({
      config: archiveCfg(),
      store,
      now: h0 + 3 * HOUR + 30,
    });
    assert.equal(result.ok, false);
    assert.equal(result.hours.find((h) => !h.ok).code, 'AUTH');
    assert.equal(fs.existsSync(path.join(dataDir, 'blocks', '1.json')), true);
  });

  test('PUT timeout does not prune', async () => {
    const h0 = seedChain();
    const inner = createMemoryStore();
    const store = {
      kind: 'memory',
      async put(key, body) {
        if (String(key).includes('/blocks/1.json')) {
          const err = new Error('The operation was aborted due to timeout');
          err.name = 'TimeoutError';
          throw err;
        }
        return inner.put(key, body);
      },
      get: inner.get.bind(inner),
      head: inner.head.bind(inner),
      list: inner.list.bind(inner),
    };
    const result = await runArchiveJob({
      config: archiveCfg(),
      store,
      now: h0 + 3 * HOUR + 30,
    });
    assert.equal(result.ok, false);
    assert.equal(result.hours.find((h) => !h.ok).code, 'TIMEOUT');
    assert.equal(fs.existsSync(path.join(dataDir, 'blocks', '1.json')), true);
  });

  test('truncated remote GET does not prune', async () => {
    const h0 = seedChain();
    const inner = createMemoryStore();
    const store = {
      kind: 'memory',
      put: inner.put.bind(inner),
      async get(key) {
        const got = await inner.get(key);
        if (got && String(key).includes('/blocks/1.json')) {
          return got.subarray(0, Math.max(1, got.length - 8));
        }
        return got;
      },
      head: inner.head.bind(inner),
      list: inner.list.bind(inner),
    };
    const result = await runArchiveJob({
      config: archiveCfg(),
      store,
      now: h0 + 3 * HOUR + 30,
    });
    assert.equal(result.ok, false);
    assert.equal(result.hours.find((h) => !h.ok).code, 'TRUNCATED');
    assert.equal(fs.existsSync(path.join(dataDir, 'blocks', '1.json')), true);
  });

  test('manifest PUT failure after objects uploaded leaves local intact', async () => {
    const h0 = seedChain();
    const inner = createMemoryStore();
    const store = {
      kind: 'memory',
      async put(key, body) {
        if (String(key).endsWith('/manifest.json') && String(key).includes(hourPath(h0))) {
          throw new Error('S3 PUT manifest.json failed: HTTP 500 Internal Error');
        }
        return inner.put(key, body);
      },
      get: inner.get.bind(inner),
      head: inner.head.bind(inner),
      list: inner.list.bind(inner),
    };
    const result = await runArchiveJob({
      config: archiveCfg(),
      store,
      now: h0 + 3 * HOUR + 30,
    });
    assert.equal(result.ok, false);
    assert.equal(result.hours.find((h) => !h.ok && h.hour === hourPath(h0)).code, 'MANIFEST_PUT_FAILED');
    assert.equal(fs.existsSync(path.join(dataDir, 'blocks', '1.json')), true);
    assert.ok(await inner.get(`${objectPrefix(27427, h0)}/blocks/1.json`), 'retry-friendly remote object may exist');
  });

  test('retry after manifest PUT failure is safe and then prunes', async () => {
    const h0 = seedChain();
    const inner = createMemoryStore();
    let manifestPuts = 0;
    const store = {
      kind: 'memory',
      async put(key, body) {
        if (String(key).endsWith('/manifest.json') && String(key).includes(hourPath(h0))) {
          manifestPuts += 1;
          if (manifestPuts === 1) {
            throw new Error('S3 PUT manifest.json failed: HTTP 500 Internal Error');
          }
        }
        return inner.put(key, body);
      },
      get: inner.get.bind(inner),
      head: inner.head.bind(inner),
      list: inner.list.bind(inner),
    };
    const first = await runArchiveJob({
      config: archiveCfg(),
      store,
      now: h0 + 3 * HOUR + 30,
    });
    assert.equal(first.ok, false);
    assert.equal(fs.existsSync(path.join(dataDir, 'blocks', '1.json')), true);
    const second = await runArchiveJob({
      config: archiveCfg(),
      store,
      now: h0 + 3 * HOUR + 30,
    });
    assert.equal(second.ok, true);
    assert.equal(fs.existsSync(path.join(dataDir, 'blocks', '1.json')), false);
  });

  test('local bitrot after hash / during job does not prune', async () => {
    const h0 = seedChain();
    const inner = createMemoryStore();
    const store = {
      kind: 'memory',
      async put(key, body) {
        await inner.put(key, body);
        if (String(key).includes('/blocks/1.json')) {
          fs.writeFileSync(path.join(dataDir, 'blocks', '1.json'), 'truncated-during-job');
        }
      },
      get: inner.get.bind(inner),
      head: inner.head.bind(inner),
      list: inner.list.bind(inner),
    };
    const result = await runArchiveJob({
      config: archiveCfg(),
      store,
      now: h0 + 3 * HOUR + 30,
    });
    assert.equal(result.ok, false);
    assert.equal(result.hours.find((h) => !h.ok).code, 'LOCAL_BITROT');
    assert.equal(fs.existsSync(path.join(dataDir, 'blocks', '1.json')), true);
  });

  test('concurrent second run skips while lock is held', async () => {
    const h0 = seedChain();
    const lock = acquireArchiveLock(dataDir);
    assert.equal(lock.acquired, true);
    try {
      const result = await runArchiveJob({
        config: archiveCfg(),
        now: h0 + 3 * HOUR + 30,
      });
      assert.equal(result.ok, false);
      assert.equal(result.locked, true);
      assert.equal(result.code, 'ARCHIVE_LOCK_HELD');
      assert.equal(fs.existsSync(path.join(dataDir, 'blocks', '1.json')), true);
    } finally {
      lock.release();
    }
  });

  test('second run after success is idempotent for pruned hours', async () => {
    const h0 = seedChain();
    const first = await runArchiveJob({
      config: archiveCfg(),
      now: h0 + 3 * HOUR + 30,
    });
    assert.equal(first.ok, true);
    const second = await runArchiveJob({
      config: archiveCfg(),
      now: h0 + 3 * HOUR + 30,
    });
    assert.equal(second.ok, true);
    assert.equal(fs.existsSync(path.join(dataDir, 'blocks', '1.json')), false);
    assert.equal(fs.existsSync(path.join(dataDir, 'blocks', '4.json')), true);
  });

  test('ENOSPC writing staging manifest aborts hour with no prune', async () => {
    const h0 = seedChain();
    const io = {
      ...defaultArchiveIo(),
      writeFileSync(file, data, enc) {
        if (String(file).includes(`${path.sep}staging${path.sep}`) || String(file).includes('/staging/')) {
          const err = new Error('ENOSPC: no space left on device');
          err.code = 'ENOSPC';
          throw err;
        }
        return fs.writeFileSync(file, data, enc);
      },
    };
    const result = await runArchiveJob({
      config: archiveCfg(),
      io,
      now: h0 + 3 * HOUR + 30,
    });
    assert.equal(result.ok, false);
    assert.equal(result.hours.find((h) => !h.ok).code, 'ENOSPC');
    assert.equal(fs.existsSync(path.join(dataDir, 'blocks', '1.json')), true);
    assert.equal(fs.existsSync(path.join(dataDir, 'blocks', '2.json')), true);
  });

  test('ENOSPC mid-job aborts remaining hours and does not prune unverified', async () => {
    const h0 = seedChain();
    const secondHour = hourPath(h0 + HOUR).replaceAll('/', '-');
    const io = {
      ...defaultArchiveIo(),
      writeFileSync(file, data, enc) {
        if (String(file).includes(secondHour)) {
          const err = new Error('ENOSPC: no space left on device');
          err.code = 'ENOSPC';
          throw err;
        }
        return fs.writeFileSync(file, data, enc);
      },
    };
    const result = await runArchiveJob({
      config: archiveCfg(),
      io,
      now: h0 + 3 * HOUR + 30,
    });
    assert.equal(result.ok, false);
    assert.match(result.reason || '', /aborted remaining/);
    const failed = result.hours.find((h) => !h.ok);
    assert.equal(failed.code, 'ENOSPC');
    assert.equal(fs.existsSync(path.join(dataDir, 'blocks', '1.json')), false, 'verified hour may prune');
    assert.equal(fs.existsSync(path.join(dataDir, 'blocks', '2.json')), true, 'unverified hour stays');
  });

  test('critically low disk still offloads sealed hours but skips explorer snapshot', async () => {
    const h0 = seedChain();
    const nodeDir = path.join(tmp, 'node-data-low');
    fs.mkdirSync(nodeDir, { recursive: true });
    const explorerFile = path.join(nodeDir, 'l2-chain.json');
    fs.writeFileSync(explorerFile, JSON.stringify({ chainId: 27427, blocks: [1, 2, 3] }) + '\n');
    const result = await runArchiveJob({
      config: archiveCfg({
        ARCHIVE_EXPLORER_SNAPSHOT: '1',
        ARCHIVE_EXPLORER_FILE: explorerFile,
        ARCHIVE_MIN_FREE_BYTES: '1000000',
      }),
      diskFree: 100,
      now: h0 + 3 * HOUR + 30,
    });
    assert.equal(result.ok, true);
    assert.equal(result.lowDisk, true);
    assert.equal(fs.existsSync(explorerFile), true);
    assert.equal(fs.existsSync(path.join(dataDir, 'blocks', '1.json')), false);
    const store = createFileStore(`file://${sinkRoot}`, 'l2-archive');
    const snap = await store.get(`${objectPrefix(27427, h0)}/explorer/l2-chain.json`);
    assert.equal(snap, null);
  });
});

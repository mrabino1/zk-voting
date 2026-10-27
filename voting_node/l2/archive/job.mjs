// NOT FOR PROFIT — civic public good, not a commercial product.
// Hourly offload of sealed L2 artifacts to S3 / R2 / file://. Prune only after verify.
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

import { loadConfig } from '../sequencer/state.mjs';
import { assertArchiveReady, loadArchiveConfig } from './config.mjs';
import { archiveError, classifyStoreError, isEnospc, wrapEnospc } from './errors.mjs';
import {
  hourStart as hourStartOf,
  isHourArchivable,
  objectPrefix,
  parseHourPath,
  hourPath,
} from './hours.mjs';
import { claimRoleLease } from '../lease/lease.mjs';
import { acquireArchiveLock, lockBusyResult } from './lock.mjs';
import {
  createObjectStore,
  getAndVerify,
  hashBytes,
  hashLocalFile,
  putAndVerify,
  sha256Hex,
  verifyLocalHash,
} from './s3.mjs';

export const ARCHIVE_INDEX_REL = path.join('archive', 'index.json');

export function defaultArchiveIo() {
  return {
    mkdirSync: (...args) => fs.mkdirSync(...args),
    writeFileSync: (...args) => fs.writeFileSync(...args),
    readFileSync: (...args) => fs.readFileSync(...args),
    unlinkSync: (...args) => fs.unlinkSync(...args),
    existsSync: (...args) => fs.existsSync(...args),
    renameSync: (...args) => fs.renameSync(...args),
    statSync: (...args) => fs.statSync(...args),
    statfsSync: typeof fs.statfsSync === 'function' ? (...args) => fs.statfsSync(...args) : null,
  };
}

export function readDiskFree(dir, io = defaultArchiveIo()) {
  if (!io.statfsSync) return null;
  try {
    const s = io.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, obj, io = defaultArchiveIo()) {
  try {
    io.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    io.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
    io.renameSync(tmp, file);
  } catch (err) {
    try {
      io.unlinkSync(file + '.tmp');
    } catch {
      // ignore
    }
    throw wrapEnospc(err, `write ${file}`);
  }
}

export function archiveIndexPath(dataDir) {
  return path.join(dataDir, ARCHIVE_INDEX_REL);
}

export function readArchiveIndex(dataDir, io = defaultArchiveIo()) {
  const file = archiveIndexPath(dataDir);
  if (!io.existsSync(file)) {
    return { version: 1, nfp: true, archivedThrough: -1, txNonce: '0', hours: {} };
  }
  const parsed = JSON.parse(io.readFileSync(file, 'utf8'));
  parsed.hours = parsed.hours && typeof parsed.hours === 'object' ? parsed.hours : {};
  if (parsed.archivedThrough == null) parsed.archivedThrough = -1;
  return parsed;
}

export function writeArchiveIndex(dataDir, index, io = defaultArchiveIo()) {
  writeJsonAtomic(archiveIndexPath(dataDir), index, io);
}

function readJson(file, io) {
  return JSON.parse(io.readFileSync(file, 'utf8'));
}

function blockNumberFromName(name) {
  const m = String(name).match(/^(\d+)\.json$/);
  return m ? Number(m[1]) : null;
}

function txHashesFromBlock(block) {
  const txs = Array.isArray(block?.transactions) ? block.transactions : [];
  const out = [];
  for (const tx of txs) {
    if (typeof tx === 'string') out.push(tx);
    else if (tx && tx.hash) out.push(String(tx.hash));
  }
  return out;
}

function maxNextNonceFromBlock(block, current) {
  let n = current;
  for (const tx of Array.isArray(block?.transactions) ? block.transactions : []) {
    if (!tx || typeof tx === 'string' || tx.nonce == null) continue;
    const next = BigInt(tx.nonce) + 1n;
    if (next > n) n = next;
  }
  return n;
}

export function listLocalBlocks(dataDir, io = defaultArchiveIo()) {
  const dir = path.join(dataDir, 'blocks');
  if (!io.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const number = blockNumberFromName(name);
    if (number == null) continue;
    const file = path.join(dir, name);
    let block;
    try {
      block = readJson(file, io);
    } catch {
      continue;
    }
    if (block && block.archived) continue;
    const timestamp = Number(block.timestamp || 0);
    out.push({
      number,
      file,
      timestamp,
      hash: block.hash,
      parentHash: block.parentHash,
      stateRoot: block.stateRoot,
      txHashes: txHashesFromBlock(block),
      block,
    });
  }
  out.sort((a, b) => a.number - b.number);
  return out;
}

export function listLocalProofs(dataDir, io = defaultArchiveIo()) {
  const dir = path.join(dataDir, 'proofs');
  if (!io.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (name === 'cursor.json' || !name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    let rec;
    try {
      rec = readJson(file, io);
    } catch {
      continue;
    }
    out.push({
      name,
      file,
      startBlock: Number(rec.startBlock ?? rec.publicData?.startBlock ?? -1),
      endBlock: Number(rec.endBlock ?? rec.publicData?.endBlock ?? -1),
      rec,
    });
  }
  return out;
}

function readProvenThrough(dataDir, io) {
  const cursorPath = path.join(dataDir, 'proofs', 'cursor.json');
  if (!io.existsSync(cursorPath)) return null;
  try {
    const cursor = readJson(cursorPath, io);
    if (cursor.lastProvenBlock == null) return null;
    return Number(cursor.lastProvenBlock);
  } catch {
    return null;
  }
}

function groupByHour(blocks, intervalSeconds) {
  const groups = new Map();
  for (const item of blocks) {
    if (item.number === 0) continue;
    const start = hourStartOf(item.timestamp, intervalSeconds);
    if (!groups.has(start)) groups.set(start, []);
    groups.get(start).push(item);
  }
  return groups;
}

function artifactKey(prefix, kind, name) {
  return `${prefix}/${kind}/${name}`;
}

function planObject({ key, file, kind, dataDir, io, compress }) {
  const hashed = hashLocalFile(file, io);
  const useGzip = Boolean(compress) && (kind === 'block' || kind === 'proof');
  const body = useGzip ? gzipSync(hashed.body) : hashed.body;
  const stored = hashBytes(body);
  return {
    key,
    sha256: stored.sha256,
    bytes: stored.bytes,
    rawSha256: hashed.sha256,
    rawBytes: hashed.bytes,
    contentEncoding: useGzip ? 'gzip' : 'identity',
    kind,
    localPath: path.isAbsolute(file) ? path.relative(dataDir, file) : file,
    algorithm: 'sha256',
    hashedAt: 'pre-upload',
    body,
    file,
  };
}

function publicObject(obj) {
  return {
    key: obj.key,
    sha256: obj.sha256,
    bytes: obj.bytes,
    rawSha256: obj.rawSha256,
    rawBytes: obj.rawBytes,
    contentEncoding: obj.contentEncoding || 'identity',
    kind: obj.kind,
    localPath: obj.localPath,
    algorithm: obj.algorithm || 'sha256',
    hashedAt: obj.hashedAt || 'pre-upload',
  };
}

async function putPlanned(store, planned, stage = 'PUT') {
  try {
    const existing = await store.get(planned.key);
    if (
      existing &&
      existing.length === planned.bytes &&
      sha256Hex(existing) === planned.sha256
    ) {
      return { ...publicObject(planned), skippedPut: true };
    }
  } catch {
    // treat as missing; PUT next
  }
  try {
    return await putAndVerify(store, planned.key, planned.body, planned.sha256);
  } catch (err) {
    throw classifyStoreError(err, stage, planned.key);
  }
}

function verifyRemainingLocal(planned, io) {
  for (const obj of planned) {
    if (!obj.file) continue;
    verifyLocalHash(obj.file, obj.rawSha256 || obj.sha256, io);
  }
}

function stagingManifestPath(dataDir, hour) {
  return path.join(dataDir, 'archive', 'staging', `${String(hour).replaceAll('/', '-')}.json`);
}

export async function archiveHour({
  cfg,
  store,
  hourStart,
  items,
  proofs,
  now,
  prune = true,
  io = defaultArchiveIo(),
  lowDisk = false,
}) {
  const prefix = objectPrefix(cfg.chainId, hourStart);
  const hour = hourPath(hourStart);
  const planned = [];
  const txHashes = [];
  let maxNonce = 0n;
  const blockNumbers = [];

  for (const item of items) {
    const name = path.basename(item.file);
    const key = artifactKey(prefix, 'blocks', name);
    planned.push(
      planObject({
        key,
        file: item.file,
        kind: 'block',
        dataDir: cfg.dataDir,
        io,
        compress: cfg.compress,
      }),
    );
    txHashes.push(...item.txHashes);
    maxNonce = maxNextNonceFromBlock(item.block, maxNonce);
    blockNumbers.push(item.number);
  }

  for (const proof of proofs) {
    const key = artifactKey(prefix, 'proofs', proof.name);
    planned.push(
      planObject({
        key,
        file: proof.file,
        kind: 'proof',
        dataDir: cfg.dataDir,
        io,
        compress: cfg.compress,
      }),
    );
  }

  if (cfg.explorerSnapshot && cfg.explorerFile && io.existsSync(cfg.explorerFile) && !lowDisk) {
    planned.push(
      planObject({
        key: `${prefix}/explorer/l2-chain.json`,
        file: cfg.explorerFile,
        kind: 'explorer',
        dataDir: cfg.dataDir,
        io,
        compress: false,
      }),
    );
  }

  const manifestObjects = planned.map(publicObject);
  const manifestDraft = {
    nfp: true,
    app: 'zk-voting',
    kind: 'l2-hour-archive',
    chainId: cfg.chainId,
    hour,
    hourStart,
    hourEnd:
      hourStart +
      (Number(cfg.disclosureIntervalSeconds) > 0 ? Number(cfg.disclosureIntervalSeconds) : 3600),
    prefix,
    hashAlgorithm: 'sha256',
    createdAt: new Date((Number(now) || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    objects: manifestObjects,
  };

  try {
    writeJsonAtomic(stagingManifestPath(cfg.dataDir, hour), manifestDraft, io);
  } catch (err) {
    throw wrapEnospc(err, `staging manifest for hour ${hour}`);
  }

  for (const obj of planned) {
    await putPlanned(store, obj, 'PUT');
  }

  const manifestKey = `${prefix}/manifest.json`;
  const manifestBody = Buffer.from(JSON.stringify(manifestDraft, null, 2) + '\n');
  const manifestSha256 = sha256Hex(manifestBody);
  try {
    await putAndVerify(store, manifestKey, manifestBody, manifestSha256);
  } catch (err) {
    if (err.code === 'AUTH' || err.code === 'TIMEOUT' || err.code === 'ENOSPC') throw err;
    throw archiveError(
      'MANIFEST_PUT_FAILED',
      err.message || `manifest PUT failed for ${manifestKey}`,
      { key: manifestKey, cause: err },
    );
  }

  for (const obj of planned) {
    await getAndVerify(store, obj.key, obj.sha256, obj.bytes);
  }
  await getAndVerify(store, manifestKey, manifestSha256, manifestBody.length);

  verifyRemainingLocal(planned, io);

  const provenThrough = readProvenThrough(cfg.dataDir, io);
  const hourMax = blockNumbers.length ? Math.max(...blockNumbers) : -1;
  const hourMin = blockNumbers.length ? Math.min(...blockNumbers) : -1;
  const proven = provenThrough == null || hourMax <= provenThrough;
  const shouldPrune = prune && proven;

  verifyRemainingLocal(planned, io);

  return {
    hour,
    prefix,
    hourStart,
    uploaded: planned.length + 1,
    pruned: 0,
    shouldPrune,
    pruneSkipped: prune && !proven ? 'unproven' : undefined,
    pruneItems: shouldPrune ? items.filter((i) => i.number !== 0) : [],
    pruneProofs: shouldPrune
      ? proofs.filter((p) => provenThrough == null || p.endBlock <= provenThrough)
      : [],
    blockFrom: hourMin,
    blockTo: hourMax,
    txHashes,
    txNonce: maxNonce.toString(),
    manifestSha256,
    manifestKey,
    prunedPaths: [],
    objects: manifestObjects,
    lowDiskSkippedExplorer: Boolean(lowDisk && cfg.explorerSnapshot),
  };
}

function failHour(start, err) {
  const wrapped = err?.code
    ? err
    : isEnospc(err)
      ? wrapEnospc(err, `hour ${hourPath(start)}`)
      : archiveError(err?.code || 'ARCHIVE_FAILED', err?.message || String(err));
  return {
    ok: false,
    hour: hourPath(start),
    hourStart: start,
    error: wrapped.message || String(wrapped),
    code: wrapped.code || 'ARCHIVE_FAILED',
    failedObject: wrapped.key,
    pruned: 0,
  };
}

export async function runArchiveJob(opts = {}) {
  const cfg = opts.config || loadArchiveConfig({ env: opts.env, l2Config: opts.l2Config });
  const now = opts.now != null ? Number(opts.now) : Math.floor(Date.now() / 1000);
  const io = opts.io || defaultArchiveIo();
  let releaseWriter = () => {};
  if (!opts.skipWriterLease) {
    const claim = claimRoleLease({
      dataDir: cfg.dataDir,
      role: 'archive',
      existing: opts.writerLease,
      ttlMs: opts.leaseTtlMs,
    });
    if (!claim.acquired) {
      return {
        ok: true,
        skipped: true,
        locked: true,
        reason: 'ARCHIVE_STANDBY',
        code: 'ARCHIVE_STANDBY',
        error: 'archive standby; another container holds the writer lease',
        hours: [],
        now,
      };
    }
    releaseWriter = () => {
      claim.release();
      releaseWriter = () => {};
    };
  }

  const ready = assertArchiveReady(cfg);
  if (!ready.ok || ready.skipped) {
    if (ready.warn) {
      console.warn(`archive skipped: ${ready.reason}`);
    }
    releaseWriter();
    return {
      ok: ready.ok,
      skipped: true,
      reason: ready.reason,
      hours: [],
      now,
    };
  }

  let lock;
  try {
    lock = opts.skipLock
      ? { acquired: true, release() {} }
      : acquireArchiveLock(cfg.dataDir, opts.lock || {});
  } catch (err) {
    const wrapped = wrapEnospc(err, `archive lock under ${cfg.dataDir}`);
    releaseWriter();
    return {
      ok: false,
      skipped: false,
      reason: wrapped.message,
      error: wrapped.message,
      code: wrapped.code || err.code,
      hours: [],
      now,
    };
  }
  if (!lock.acquired) {
    releaseWriter();
    return lockBusyResult(lock, now);
  }

  try {
    const minFree = Number(cfg.minFreeBytes) || 0;
    const free =
      opts.diskFree != null ? Number(opts.diskFree) : readDiskFree(cfg.dataDir, io);
    const lowDisk = free != null && minFree > 0 && free < minFree;
    if (lowDisk) {
      console.warn(
        `ENOSPC: only ${free} bytes free under ${cfg.dataDir} (min ${minFree}). ` +
          'Skipping explorer snapshot and extra local copies; still attempting sealed-hour offload. ' +
          'Sequencer/Node hot-path ENOSPC is a separate ops alert.',
      );
    }

    const store = opts.store || createObjectStore({ ...cfg, timeoutMs: cfg.timeoutMs });
    const blocks = listLocalBlocks(cfg.dataDir, io);
    const proofs = listLocalProofs(cfg.dataDir, io);
    const grouped = groupByHour(blocks, cfg.disclosureIntervalSeconds);
    const hours = [];
    const index = readArchiveIndex(cfg.dataDir, io);
    let nextNonce = BigInt(index.txNonce || '0');
    let abortRemaining = null;

    const sortedStarts = [...grouped.keys()].sort((a, b) => a - b);
    for (const start of sortedStarts) {
      if (abortRemaining) break;
      if (!isHourArchivable(start, now, cfg.disclosureIntervalSeconds, cfg.hotWindowHours)) {
        continue;
      }
      const hour = hourPath(start);
      const items = grouped.get(start);
      const localStillThere = items.some((i) => io.existsSync(i.file));
      const prior = index.hours[hour];
      if (prior && prior.pruned && !localStillThere) {
        hours.push({
          ok: true,
          hour,
          hourStart: start,
          skipped: true,
          reason: 'already archived',
          pruned: 0,
          uploaded: 0,
        });
        continue;
      }
      const hourMax = Math.max(...items.map((i) => i.number));
      const hourMin = Math.min(...items.map((i) => i.number));
      const hourProofs = proofs.filter((p) => p.endBlock >= hourMin && p.endBlock <= hourMax);
      try {
        const result = await archiveHour({
          cfg,
          store,
          hourStart: start,
          items,
          proofs: hourProofs,
          now,
          prune: opts.prune !== false,
          io,
          lowDisk,
        });
        nextNonce =
          BigInt(result.txNonce || '0') > nextNonce ? BigInt(result.txNonce || '0') : nextNonce;
        index.hours[result.hour] = {
          hourStart: result.hourStart,
          prefix: result.prefix,
          manifestKey: result.manifestKey,
          manifestSha256: result.manifestSha256,
          blockFrom: result.blockFrom,
          blockTo: result.blockTo,
          pruned: false,
          txHashes: result.txHashes,
        };
        index.txNonce = nextNonce.toString();
        writeArchiveIndex(cfg.dataDir, index, io);

        const pruned = [];
        if (result.shouldPrune) {
          if (result.blockTo > Number(index.archivedThrough || -1)) {
            index.archivedThrough = result.blockTo;
          }
          index.hours[result.hour].pruned = true;
          writeArchiveIndex(cfg.dataDir, index, io);
          for (const item of result.pruneItems || []) {
            io.unlinkSync(item.file);
            pruned.push(path.relative(cfg.dataDir, item.file));
          }
          for (const proof of result.pruneProofs || []) {
            io.unlinkSync(proof.file);
            pruned.push(path.relative(cfg.dataDir, proof.file));
          }
        }

        hours.push({
          ok: true,
          ...result,
          pruned: pruned.length,
          prunedPaths: pruned,
        });
      } catch (err) {
        const failed = failHour(start, err);
        hours.push(failed);
        if (failed.code === 'ENOSPC') {
          abortRemaining = failed.code;
        }
      }
    }

    const failed = hours.filter((h) => !h.ok);
    return {
      ok: failed.length === 0,
      skipped: false,
      reason: abortRemaining
        ? `aborted remaining hours after ${abortRemaining}`
        : failed.length
          ? `${failed.length} hour(s) failed`
          : undefined,
      hours,
      archivedThrough: index.archivedThrough,
      now,
      lowDisk,
      diskFree: free,
    };
  } finally {
    if (typeof lock.release === 'function') lock.release();
    releaseWriter();
  }
}

export async function restoreHour(opts = {}) {
  const cfg = opts.config || loadArchiveConfig({ env: opts.env, l2Config: opts.l2Config });
  const store = opts.store || createObjectStore(cfg);
  const io = opts.io || defaultArchiveIo();
  let hourStart = opts.hourStart;
  if (hourStart == null && opts.hour) {
    const parsed = parseHourPath(opts.hour);
    if (!parsed) throw new Error(`invalid hour path: ${opts.hour}`);
    hourStart = parsed.hourStart;
  }
  if (hourStart == null && opts.prefix) {
    const parsed = parseHourPath(String(opts.prefix));
    hourStart = parsed ? parsed.hourStart : null;
  }
  if (hourStart == null) throw new Error('restore requires --hour YYYY/MM/DD/HH');
  const prefix = opts.prefix || objectPrefix(cfg.chainId, hourStart);
  const dest = path.resolve(opts.out || path.join(cfg.dataDir, 'archive', 'restore', hourPath(hourStart)));
  try {
    io.mkdirSync(dest, { recursive: true });
  } catch (err) {
    throw wrapEnospc(err, `restore mkdir ${dest}`);
  }
  const manifestKey = `${prefix}/manifest.json`;
  const manifestBody = await store.get(manifestKey);
  if (!manifestBody) throw new Error(`manifest not found: ${manifestKey}`);
  const manifest = JSON.parse(manifestBody.toString('utf8'));
  const verified = [];
  for (const obj of manifest.objects || []) {
    const remote = await getAndVerify(store, obj.key, obj.sha256, obj.bytes);
    const decoded = decodeStoredObject(obj, remote.body);
    const rel = restoreRelativePath(obj, prefix);
    const file = path.resolve(dest, rel);
    if (file !== path.resolve(dest) && !file.startsWith(path.resolve(dest) + path.sep)) {
      throw new Error(`restore path escapes destination: ${rel}`);
    }
    try {
      io.mkdirSync(path.dirname(file), { recursive: true });
      io.writeFileSync(file, decoded.body);
    } catch (err) {
      throw wrapEnospc(err, `restore write ${file}`);
    }
    verifyLocalHash(file, decoded.sha256, io);
    verified.push({ key: obj.key, sha256: decoded.sha256, storedSha256: remote.sha256, file });
  }
  const manifestFile = path.join(dest, 'manifest.json');
  try {
    io.writeFileSync(manifestFile, manifestBody);
  } catch (err) {
    throw wrapEnospc(err, `restore write ${manifestFile}`);
  }
  return { ok: true, prefix, dest, restored: verified.length, manifest: manifestKey };
}

function decodeStoredObject(obj, storedBody) {
  const encoding = String(obj.contentEncoding || 'identity').toLowerCase();
  if (encoding === 'gzip') {
    let raw;
    try {
      raw = gunzipSync(storedBody);
    } catch (err) {
      throw archiveError(
        'GZIP_DECODE_FAILED',
        `gzip decode failed for ${obj.key}: ${err.message || err}`,
        { key: obj.key },
      );
    }
    const rawSha = sha256Hex(raw);
    if (obj.rawSha256 && rawSha !== obj.rawSha256) {
      throw archiveError(
        'RAW_HASH_MISMATCH',
        `raw sha256 mismatch for ${obj.key}: ${rawSha} != ${obj.rawSha256}`,
        { key: obj.key, sha256: rawSha, expected: obj.rawSha256 },
      );
    }
    if (
      obj.rawBytes != null &&
      Number.isFinite(Number(obj.rawBytes)) &&
      raw.length !== Number(obj.rawBytes)
    ) {
      throw archiveError(
        'RAW_SIZE_MISMATCH',
        `raw size mismatch for ${obj.key}: ${raw.length} != ${obj.rawBytes}`,
        { key: obj.key, bytes: raw.length, expected: Number(obj.rawBytes) },
      );
    }
    return { body: raw, sha256: obj.rawSha256 || rawSha };
  }
  // Legacy hours stored the raw JSON. sha256/bytes are those exact bytes.
  return { body: storedBody, sha256: obj.sha256 };
}

function restoreRelativePath(obj, prefix) {
  const fromKey = String(obj.key || '')
    .replace(/^\/+/, '')
    .startsWith(String(prefix).replace(/^\/+/, ''))
    ? String(obj.key).slice(String(prefix).length).replace(/^\/+/, '')
    : path.basename(String(obj.key || 'object'));
  const local = obj.localPath;
  if (local && !path.isAbsolute(local) && !String(local).includes('..')) return local;
  return fromKey || path.basename(String(obj.key || 'object'));
}

export function defaultL2Config() {
  return loadConfig();
}

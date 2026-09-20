// NOT FOR PROFIT — civic public good, not a commercial product.
// Hourly offload of sealed L2 artifacts to S3 / R2 / file://. Prune only after verify.
import fs from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../sequencer/state.mjs';
import { assertArchiveReady, loadArchiveConfig } from './config.mjs';
import {
  hourStart as hourStartOf,
  isHourArchivable,
  objectPrefix,
  parseHourPath,
  hourPath,
} from './hours.mjs';
import { createObjectStore, putAndVerify, sha256Hex } from './s3.mjs';

export const ARCHIVE_INDEX_REL = path.join('archive', 'index.json');

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function archiveIndexPath(dataDir) {
  return path.join(dataDir, ARCHIVE_INDEX_REL);
}

export function readArchiveIndex(dataDir) {
  const file = archiveIndexPath(dataDir);
  if (!fs.existsSync(file)) {
    return { version: 1, nfp: true, archivedThrough: -1, txNonce: '0', hours: {} };
  }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  parsed.hours = parsed.hours && typeof parsed.hours === 'object' ? parsed.hours : {};
  if (parsed.archivedThrough == null) parsed.archivedThrough = -1;
  return parsed;
}

export function writeArchiveIndex(dataDir, index) {
  writeJsonAtomic(archiveIndexPath(dataDir), index);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
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

export function listLocalBlocks(dataDir) {
  const dir = path.join(dataDir, 'blocks');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const number = blockNumberFromName(name);
    if (number == null) continue;
    const file = path.join(dir, name);
    let block;
    try {
      block = readJson(file);
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

export function listLocalProofs(dataDir) {
  const dir = path.join(dataDir, 'proofs');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (name === 'cursor.json' || !name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    let rec;
    try {
      rec = readJson(file);
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

function readProvenThrough(dataDir) {
  const cursorPath = path.join(dataDir, 'proofs', 'cursor.json');
  if (!fs.existsSync(cursorPath)) return null;
  try {
    const cursor = readJson(cursorPath);
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

async function snapshotExplorer(cfg, store, prefix, objects) {
  if (!cfg.explorerSnapshot || !cfg.explorerFile) return;
  if (!fs.existsSync(cfg.explorerFile)) return;
  const body = fs.readFileSync(cfg.explorerFile);
  const key = `${prefix}/explorer/l2-chain.json`;
  const meta = await putAndVerify(store, key, body);
  objects.push({ ...meta, kind: 'explorer', localPath: cfg.explorerFile });
}

export async function archiveHour({
  cfg,
  store,
  hourStart,
  items,
  proofs,
  now,
  prune = true,
}) {
  const prefix = objectPrefix(cfg.chainId, hourStart);
  const hour = hourPath(hourStart);
  const objects = [];
  const txHashes = [];
  let maxNonce = 0n;
  const blockNumbers = [];

  for (const item of items) {
    const body = fs.readFileSync(item.file);
    const name = path.basename(item.file);
    const key = artifactKey(prefix, 'blocks', name);
    const meta = await putAndVerify(store, key, body);
    objects.push({ ...meta, kind: 'block', localPath: path.relative(cfg.dataDir, item.file) });
    txHashes.push(...item.txHashes);
    maxNonce = maxNextNonceFromBlock(item.block, maxNonce);
    blockNumbers.push(item.number);
  }

  for (const proof of proofs) {
    const body = fs.readFileSync(proof.file);
    const key = artifactKey(prefix, 'proofs', proof.name);
    const meta = await putAndVerify(store, key, body);
    objects.push({ ...meta, kind: 'proof', localPath: path.relative(cfg.dataDir, proof.file) });
  }

  await snapshotExplorer(cfg, store, prefix, objects);

  const manifest = {
    nfp: true,
    app: 'zk-voting',
    kind: 'l2-hour-archive',
    chainId: cfg.chainId,
    hour,
    hourStart,
    hourEnd: hourStart + (Number(cfg.disclosureIntervalSeconds) > 0
      ? Number(cfg.disclosureIntervalSeconds)
      : 3600),
    prefix,
    createdAt: new Date((Number(now) || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    objects,
  };
  const manifestBody = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  const manifestKey = `${prefix}/manifest.json`;
  const manifestMeta = await putAndVerify(store, manifestKey, manifestBody);
  objects.push({ ...manifestMeta, kind: 'manifest' });
  manifest.objects = objects.filter((o) => o.kind !== 'manifest');
  manifest.manifest = manifestMeta;

  const provenThrough = readProvenThrough(cfg.dataDir);
  const hourMax = blockNumbers.length ? Math.max(...blockNumbers) : -1;
  const hourMin = blockNumbers.length ? Math.min(...blockNumbers) : -1;
  const proven = provenThrough == null || hourMax <= provenThrough;
  const pruned = [];
  if (prune && proven) {
    for (const item of items) {
      if (item.number === 0) continue;
      fs.unlinkSync(item.file);
      pruned.push(path.relative(cfg.dataDir, item.file));
    }
    for (const proof of proofs) {
      if (provenThrough != null && proof.endBlock > provenThrough) continue;
      fs.unlinkSync(proof.file);
      pruned.push(path.relative(cfg.dataDir, proof.file));
    }
  }

  return {
    hour,
    prefix,
    hourStart,
    uploaded: objects.length,
    pruned: pruned.length,
    pruneSkipped: prune && !proven ? 'unproven' : undefined,
    blockFrom: hourMin,
    blockTo: hourMax,
    txHashes,
    txNonce: maxNonce.toString(),
    manifestSha256: manifestMeta.sha256,
    manifestKey,
    prunedPaths: pruned,
  };
}

export async function runArchiveJob(opts = {}) {
  const cfg = opts.config || loadArchiveConfig({ env: opts.env, l2Config: opts.l2Config });
  const now = opts.now != null ? Number(opts.now) : Math.floor(Date.now() / 1000);
  const ready = assertArchiveReady(cfg);
  if (!ready.ok || ready.skipped) {
    return {
      ok: ready.ok,
      skipped: true,
      reason: ready.reason,
      hours: [],
      now,
    };
  }

  const store = opts.store || createObjectStore(cfg);
  const blocks = listLocalBlocks(cfg.dataDir);
  const proofs = listLocalProofs(cfg.dataDir);
  const grouped = groupByHour(blocks, cfg.disclosureIntervalSeconds);
  const hours = [];
  const index = readArchiveIndex(cfg.dataDir);
  let nextNonce = BigInt(index.txNonce || '0');

  const sortedStarts = [...grouped.keys()].sort((a, b) => a - b);
  for (const start of sortedStarts) {
    if (!isHourArchivable(start, now, cfg.disclosureIntervalSeconds, cfg.hotWindowHours)) {
      continue;
    }
    const items = grouped.get(start);
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
      });
      nextNonce =
        BigInt(result.txNonce || '0') > nextNonce ? BigInt(result.txNonce || '0') : nextNonce;
      if (result.blockTo > Number(index.archivedThrough || -1) && result.pruned > 0) {
        index.archivedThrough = result.blockTo;
      }
      index.hours[result.hour] = {
        hourStart: result.hourStart,
        prefix: result.prefix,
        manifestKey: result.manifestKey,
        manifestSha256: result.manifestSha256,
        blockFrom: result.blockFrom,
        blockTo: result.blockTo,
        pruned: result.pruned > 0,
        txHashes: result.txHashes,
      };
      index.txNonce = nextNonce.toString();
      writeArchiveIndex(cfg.dataDir, index);
      hours.push({ ok: true, ...result });
    } catch (err) {
      hours.push({
        ok: false,
        hour: hourPath(start),
        hourStart: start,
        error: err.message || String(err),
        pruned: 0,
      });
    }
  }

  const failed = hours.filter((h) => !h.ok);
  return {
    ok: failed.length === 0,
    skipped: false,
    reason: failed.length ? `${failed.length} hour(s) failed` : undefined,
    hours,
    archivedThrough: index.archivedThrough,
    now,
  };
}

export async function restoreHour(opts = {}) {
  const cfg = opts.config || loadArchiveConfig({ env: opts.env, l2Config: opts.l2Config });
  const store = opts.store || createObjectStore(cfg);
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
  fs.mkdirSync(dest, { recursive: true });
  const manifestKey = `${prefix}/manifest.json`;
  const manifestBody = await store.get(manifestKey);
  if (!manifestBody) throw new Error(`manifest not found: ${manifestKey}`);
  const manifest = JSON.parse(manifestBody.toString('utf8'));
  const verified = [];
  for (const obj of manifest.objects || []) {
    const body = await store.get(obj.key);
    if (!body) throw new Error(`missing object ${obj.key}`);
    const actual = sha256Hex(body);
    if (obj.sha256 && actual !== obj.sha256) {
      throw new Error(`checksum mismatch ${obj.key}`);
    }
    const rel = restoreRelativePath(obj, prefix);
    const file = path.resolve(dest, rel);
    if (file !== path.resolve(dest) && !file.startsWith(path.resolve(dest) + path.sep)) {
      throw new Error(`restore path escapes destination: ${rel}`);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    verified.push({ key: obj.key, sha256: actual, file });
  }
  const manifestFile = path.join(dest, 'manifest.json');
  fs.writeFileSync(manifestFile, manifestBody);
  return { ok: true, prefix, dest, restored: verified.length, manifest: manifestKey };
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

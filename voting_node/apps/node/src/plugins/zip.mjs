// NOT FOR PROFIT — civic public good, not a commercial product.
// Minimal, defensive ZIP reader for plugin uploads (no third-party dependency).
// Supports stored (0) and deflate (8) entries only. Rejects: zip-slip paths,
// absolute paths, drive letters, backslashes, `..`, symlinks, encrypted
// entries, ZIP64, duplicate names, too many entries, oversize files and
// suspicious compression ratios.

import { inflateRawSync } from 'node:zlib';

export const ZIP_LIMITS = Object.freeze({
  maxEntries: 200,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  maxRatio: 100,
});

export class ZipError extends Error {
  constructor(message, code = 'ZIP_INVALID') {
    super(message);
    this.name = 'ZipError';
    this.code = code;
  }
}

/**
 * Validate one archive path. Returns the normalised relative path or throws.
 * @param {string} name
 */
export function safeEntryPath(name) {
  const raw = String(name);
  if (!raw || raw.length > 240) throw new ZipError('entry name length', 'ZIP_PATH');
  if (raw.includes('\\')) throw new ZipError(`backslash in entry path: ${raw}`, 'ZIP_PATH');
  if (raw.includes('\0')) throw new ZipError('NUL in entry path', 'ZIP_PATH');
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) throw new ZipError(`absolute entry path: ${raw}`, 'ZIP_PATH');
  const parts = raw.split('/');
  for (const part of parts.slice(0, raw.endsWith('/') ? -1 : undefined)) {
    if (part === '' || part === '.' || part === '..') throw new ZipError(`unsafe entry path: ${raw}`, 'ZIP_PATH');
    if (/[\u0000-\u001f\u007f]/.test(part)) throw new ZipError('control character in entry path', 'ZIP_PATH');
  }
  return raw;
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new ZipError('not a zip archive (no end of central directory)');
}

/**
 * Parse and extract a zip held in memory.
 * @param {Buffer} buf
 * @param {Partial<typeof ZIP_LIMITS>} [limitsIn]
 * @returns {Map<string, Buffer>} file path -> contents (directories omitted)
 */
export function readZip(buf, limitsIn = {}) {
  const limits = { ...ZIP_LIMITS, ...limitsIn };
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new ZipError('archive too small');
  const eocd = findEocd(buf);
  const diskEntries = buf.readUInt16LE(eocd + 8);
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) throw new ZipError('ZIP64 is not supported');
  if (diskEntries !== total) throw new ZipError('multi-disk archives are not supported');
  if (total > limits.maxEntries) throw new ZipError(`too many entries (${total} > ${limits.maxEntries})`, 'ZIP_LIMIT');
  if (cdOffset + cdSize > eocd) throw new ZipError('central directory out of bounds');

  const files = new Map();
  const seen = new Set();
  let totalBytes = 0;
  let p = cdOffset;
  for (let n = 0; n < total; n += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ZipError('bad central directory entry');
    const madeBy = buf.readUInt16LE(p + 4);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const extAttr = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;

    const entry = safeEntryPath(name);
    const lower = entry.toLowerCase();
    if (seen.has(lower)) throw new ZipError(`duplicate entry: ${entry}`, 'ZIP_PATH');
    seen.add(lower);
    if (flags & 0x1) throw new ZipError('encrypted entries are not supported');
    const hostOs = madeBy >> 8;
    const mode = (extAttr >>> 16) & 0xffff;
    if (hostOs === 3 && (mode & 0o170000) === 0o120000) throw new ZipError(`symlink entry rejected: ${entry}`, 'ZIP_SYMLINK');
    if (entry.endsWith('/')) continue;
    if (size > limits.maxFileBytes) throw new ZipError(`entry too large: ${entry}`, 'ZIP_LIMIT');
    totalBytes += size;
    if (totalBytes > limits.maxTotalBytes) throw new ZipError('archive expands beyond the size limit', 'ZIP_LIMIT');
    if (compSize > 0 && size / compSize > limits.maxRatio && size > 64 * 1024) {
      throw new ZipError(`suspicious compression ratio: ${entry}`, 'ZIP_LIMIT');
    }

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new ZipError(`bad local header: ${entry}`);
    }
    const lName = buf.readUInt16LE(localOffset + 26);
    const lExtra = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lName + lExtra;
    if (start + compSize > buf.length) throw new ZipError(`entry data out of bounds: ${entry}`);
    const raw = buf.subarray(start, start + compSize);
    let data;
    if (method === 0) {
      data = Buffer.from(raw);
    } else if (method === 8) {
      try {
        data = inflateRawSync(raw, { maxOutputLength: limits.maxFileBytes });
      } catch {
        throw new ZipError(`cannot inflate entry: ${entry}`, 'ZIP_LIMIT');
      }
    } else {
      throw new ZipError(`unsupported compression method ${method}`);
    }
    if (data.length !== size) throw new ZipError(`size mismatch: ${entry}`);
    if (crc32(data) !== crc) throw new ZipError(`crc mismatch: ${entry}`);
    files.set(entry, data);
  }
  return files;
}

/**
 * When every file sits under one top-level folder (`my-plugin/plugin.json`),
 * strip it so the plugin root holds `plugin.json`.
 * @param {Map<string, Buffer>} files
 */
export function stripCommonRoot(files) {
  const names = [...files.keys()];
  if (!names.length || names.includes('plugin.json')) return files;
  const first = names[0].split('/')[0];
  if (!names.every((n) => n.startsWith(`${first}/`))) return files;
  const out = new Map();
  for (const [name, data] of files) out.set(name.slice(first.length + 1), data);
  return out;
}

// ---- writer (tests, packaging script) -------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Build a stored (uncompressed) zip. `entries` items: { name, data, symlink? }.
 * Used by tests and `scripts/pack-plugin.mjs`; deliberately permissive so tests
 * can craft hostile archives.
 */
export function writeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data ?? ''), 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    const mode = e.symlink ? 0o120777 : e.name.endsWith('/') ? 0o40755 : 0o100644;
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

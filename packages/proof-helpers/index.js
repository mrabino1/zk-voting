/**
 * @fileoverview Proof helpers for Republic vote / tally Groth16 public inputs.
 *
 * NOT FOR PROFIT — civic public good, not a commercial product.
 *
 * Hashing note
 * ------------
 * Ethereum uses **Keccak-256** (pre-NIST padding). Node's `crypto` module
 * exposes `sha256` and NIST `sha3-256`. Those are the **wrong** algorithms
 * for `bytes32` values that Solidity `keccak256(...)` produces
 * (`ballotSpecHash`, packed encodings, function selectors).
 *
 * When `viem` is installed, this package uses `viem.keccak256`.
 * `@noble/hashes/sha3` `keccak_256` is a second optional path.
 * There is a small built-in Keccak-f[1600] fallback so selectors and
 * `encodePacked` work in a bare Node 22 workspace; it is **not** an
 * audited crypto library. Prefer viem in the Node app and in scripts.
 */

"use strict";

const PUBLIC_INPUT_KEYS = Object.freeze([
  "root",
  "disqRoot",
  "nullifier",
  "ballotHash",
  "electionId",
]);

/**
 * Serialize BallotInbox / Vote circuit public inputs.
 *
 * Order is the Groth16 instance **and** `IBallotInbox.submitVote` array:
 * `[root, disqRoot, nullifier, ballotHash, electionId]`.
 *
 * @param {object} input
 * @param {string|number|bigint} input.root Eligible Merkle root.
 * @param {string|number|bigint} input.disqRoot Disqualification Merkle root.
 * @param {string|number|bigint} input.nullifier Vote nullifier.
 * @param {string|number|bigint} input.ballotHash Commitment of the ciphertext.
 * @param {string|number|bigint} input.electionId On-chain uint256 election id
 *   (not the public UUID used in `/vote/:id`).
 * @returns {bigint[]} Length 5.
 */
function serializePublicInputs(input) {
  if (input == null || typeof input !== "object") {
    throw new TypeError("serializePublicInputs: expected an object");
  }
  const out = [];
  for (const key of PUBLIC_INPUT_KEYS) {
    if (input[key] === undefined || input[key] === null || input[key] === "") {
      throw new Error(`serializePublicInputs: missing ${key}`);
    }
    out.push(toBigInt(input[key]));
  }
  return out;
}

/**
 * @param {bigint[]} publicInputs
 * @returns {{root: bigint, disqRoot: bigint, nullifier: bigint, ballotHash: bigint, electionId: bigint}}
 */
function parsePublicInputs(publicInputs) {
  if (!Array.isArray(publicInputs) || publicInputs.length !== 5) {
    throw new Error("parsePublicInputs: expected 5 public inputs");
  }
  return {
    root: toBigInt(publicInputs[0]),
    disqRoot: toBigInt(publicInputs[1]),
    nullifier: toBigInt(publicInputs[2]),
    ballotHash: toBigInt(publicInputs[3]),
    electionId: toBigInt(publicInputs[4]),
  };
}

function toBigInt(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`toBigInt: refusing non-integer number ${value}`);
    }
    return BigInt(value);
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (s.startsWith("0x") || s.startsWith("0X")) return BigInt(s);
    if (/^\d+$/.test(s)) return BigInt(s);
    throw new Error(`toBigInt: cannot parse ${value}`);
  }
  if (value && typeof value.toString === "function" && (typeof value === "object")) {
    // viem Hex / Hex quantity objects sometimes wrap a string.
    if (typeof value.hex === "string") return toBigInt(value.hex);
  }
  throw new Error(`toBigInt: unsupported type ${typeof value}`);
}

/**
 * Left-pad a bigint to 32-byte hex (bytes32 / uint256 ABI word).
 * @param {string|number|bigint} value
 * @returns {`0x${string}`}
 */
function toHex32(value) {
  const hex = toBigInt(value).toString(16).padStart(64, "0");
  if (hex.length > 64) {
    throw new Error("toHex32: value does not fit in 32 bytes");
  }
  return /** @type {`0x${string}`} */ (`0x${hex}`);
}

function strip0x(hex) {
  if (typeof hex !== "string") throw new TypeError("expected hex string");
  return hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
}

function hexToBytes(hex) {
  const h = strip0x(hex);
  if (h.length % 2 !== 0) throw new Error("hexToBytes: odd length");
  if (h.length > 0 && !/^[0-9a-fA-F]+$/.test(h)) {
    throw new Error("hexToBytes: invalid hex");
  }
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes) {
  let s = "0x";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

function utf8Bytes(str) {
  return new Uint8Array(Buffer.from(String(str), "utf8"));
}

function concatBytes(chunks) {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/**
 * Solidity `abi.encodePacked` stand-in (mock of tightly packed encoding).
 *
 * Supported types:
 * - `uint8`..`uint256` / `uint` — big-endian, width = bits/8 (uint defaults to 32)
 * - `int*` — two's complement, same widths
 * - `address` — 20 bytes
 * - `bool` — 1 byte
 * - `bytes32` / `bytes16` / `bytesN` — N bytes
 * - `bytes` — raw bytes, no length prefix
 * - `string` — UTF-8 bytes, no length prefix
 *
 * This is **not** `abi.encode` (no 32-byte alignment, no offsets). Dynamic
 * arrays are not supported. Good enough for `ballotSpecHash` preimages and
 * Merkle `hashLeftRight` helpers that concatenate two words.
 *
 * @param {string[]} types
 * @param {unknown[]} values
 * @returns {`0x${string}`}
 */
function encodePacked(types, values) {
  if (!Array.isArray(types) || !Array.isArray(values)) {
    throw new TypeError("encodePacked: types and values must be arrays");
  }
  if (types.length !== values.length) {
    throw new Error("encodePacked: types/values length mismatch");
  }
  const chunks = [];
  for (let i = 0; i < types.length; i++) {
    chunks.push(packOne(types[i], values[i]));
  }
  return /** @type {`0x${string}`} */ (bytesToHex(concatBytes(chunks)));
}

function packOne(type, value) {
  const t = String(type).trim();
  if (t === "bool") {
    return Uint8Array.of(value ? 1 : 0);
  }
  if (t === "address") {
    const hex = strip0x(String(value)).padStart(40, "0");
    if (hex.length !== 40) throw new Error(`encodePacked: bad address ${value}`);
    return hexToBytes(hex);
  }
  if (t === "string") {
    return utf8Bytes(value == null ? "" : String(value));
  }
  if (t === "bytes") {
    if (value instanceof Uint8Array) return value;
    if (Buffer.isBuffer(value)) return new Uint8Array(value);
    return hexToBytes(String(value));
  }
  const bytesN = /^bytes(\d+)$/.exec(t);
  if (bytesN) {
    const n = Number(bytesN[1]);
    const raw =
      value instanceof Uint8Array
        ? value
        : hexToBytes(String(value));
    if (raw.length !== n) {
      throw new Error(`encodePacked: ${t} expected ${n} bytes, got ${raw.length}`);
    }
    return raw;
  }
  const uintN = /^uint(\d+)?$/.exec(t);
  if (uintN) {
    const bits = uintN[1] ? Number(uintN[1]) : 256;
    if (bits % 8 !== 0 || bits < 8 || bits > 256) {
      throw new Error(`encodePacked: unsupported ${t}`);
    }
    return uintToBe(toBigInt(value), bits / 8);
  }
  const intN = /^int(\d+)?$/.exec(t);
  if (intN) {
    const bits = intN[1] ? Number(intN[1]) : 256;
    const width = bits / 8;
    let v = typeof value === "bigint" ? value : BigInt(value);
    const mod = 1n << BigInt(bits);
    if (v < 0n) v = (mod + v) % mod;
    return uintToBe(v, width);
  }
  throw new Error(`encodePacked: unsupported type ${type}`);
}

function uintToBe(value, width) {
  if (value < 0n) throw new Error("uintToBe: negative");
  const hex = value.toString(16).padStart(width * 2, "0");
  if (hex.length > width * 2) {
    throw new Error(`uintToBe: value does not fit in ${width} bytes`);
  }
  return hexToBytes(hex);
}

// ---- Keccak-256 (Ethereum), not NIST SHA-3 ---------------------------------

const KECCAK_RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

// Indexed by x + 5*y (matches state lanes). Values are r[x][y].
const KECCAK_ROTL = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
];

function rotl64(x, n) {
  const s = BigInt(n % 64);
  return ((x << s) | (x >> (64n - s))) & 0xffffffffffffffffn;
}

function keccakF1600(st) {
  for (let round = 0; round < 24; round++) {
    const c = new Array(5);
    for (let x = 0; x < 5; x++) {
      c[x] = st[x] ^ st[x + 5] ^ st[x + 10] ^ st[x + 15] ^ st[x + 20];
    }
    const d = new Array(5);
    for (let x = 0; x < 5; x++) {
      d[x] = c[(x + 4) % 5] ^ rotl64(c[(x + 1) % 5], 1);
    }
    for (let i = 0; i < 25; i++) st[i] ^= d[i % 5];

    const b = new Array(25);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const src = x + 5 * y;
        const dstX = y;
        const dstY = (2 * x + 3 * y) % 5;
        b[dstX + 5 * dstY] = rotl64(st[src], KECCAK_ROTL[src]);
      }
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const i = x + 5 * y;
        const notNext = b[((x + 1) % 5) + 5 * y] ^ 0xffffffffffffffffn;
        st[i] = (b[i] ^ (notNext & b[((x + 2) % 5) + 5 * y])) & 0xffffffffffffffffn;
      }
    }
    st[0] ^= KECCAK_RC[round];
  }
}

/**
 * Built-in Ethereum Keccak-256. Prefer {@link keccak256} which tries viem first.
 * @param {Uint8Array|Buffer} bytes
 * @returns {Uint8Array} 32 bytes
 */
function keccak256FallbackBytes(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const rate = 136;
  const st = new Array(25).fill(0n);
  let offset = 0;
  while (offset + rate <= data.length) {
    xorAbsorb(st, data, offset, rate);
    keccakF1600(st);
    offset += rate;
  }
  const block = new Uint8Array(rate);
  const rem = data.length - offset;
  if (rem > 0) block.set(data.subarray(offset));
  block[rem] ^= 0x01; // Keccak domain (NOT SHA-3's 0x06)
  block[rate - 1] ^= 0x80;
  xorAbsorb(st, block, 0, rate);
  keccakF1600(st);
  const out = new Uint8Array(32);
  let o = 0;
  for (let i = 0; i < 4; i++) {
    let lane = st[i];
    for (let b = 0; b < 8; b++) {
      out[o++] = Number(lane & 0xffn);
      lane >>= 8n;
    }
  }
  return out;
}

function xorAbsorb(st, data, offset, rate) {
  for (let i = 0; i < rate; i += 8) {
    let lane = 0n;
    for (let b = 7; b >= 0; b--) {
      lane = (lane << 8n) | BigInt(data[offset + i + b]);
    }
    st[i / 8] ^= lane;
  }
}

function normalizeKeccakInput(data) {
  if (typeof data === "string") {
    if (data.startsWith("0x") || data.startsWith("0X")) return hexToBytes(data);
    return utf8Bytes(data);
  }
  if (data instanceof Uint8Array) return data;
  if (Buffer.isBuffer(data)) return new Uint8Array(data);
  throw new TypeError("keccak256: expected hex string, utf8 string, or Uint8Array");
}

let _viem = undefined;
function tryViem() {
  if (_viem !== undefined) return _viem;
  try {
    _viem = require("viem");
  } catch {
    _viem = null;
  }
  return _viem;
}

let _noble = undefined;
function tryNobleKeccak() {
  if (_noble !== undefined) return _noble;
  try {
    _noble = require("@noble/hashes/sha3").keccak_256;
  } catch {
    _noble = null;
  }
  return _noble;
}

/**
 * Keccak-256 as `0x`-prefixed hex.
 *
 * Resolution order: `viem.keccak256` → `@noble/hashes` → built-in fallback.
 * Does **not** call `crypto.createHash('sha3-256')` — that is NIST SHA-3.
 *
 * @param {string|Uint8Array|Buffer} data Hex (`0x…`) or raw bytes. Bare
 *   strings without `0x` are UTF-8 (same idea as viem's toBytes on strings
 *   is *not* copied; pass hex or Uint8Array when you need byte-exact).
 * @returns {`0x${string}`}
 */
function keccak256(data) {
  const viem = tryViem();
  if (viem && typeof viem.keccak256 === "function") {
    const bytes = normalizeKeccakInput(data);
    return viem.keccak256(bytes);
  }
  const noble = tryNobleKeccak();
  if (noble) {
    const digest = noble(normalizeKeccakInput(data));
    return bytesToHex(digest);
  }
  return bytesToHex(keccak256FallbackBytes(normalizeKeccakInput(data)));
}

/**
 * First 4 bytes of keccak256(utf8(signature)), e.g. `electionCount()`.
 * @param {string} signature
 * @returns {`0x${string}`}
 */
function functionSelector(signature) {
  const hash = keccak256(utf8Bytes(signature));
  return /** @type {`0x${string}`} */ (hash.slice(0, 10));
}

/**
 * HashLeftRight stand-in for tests that do not run Poseidon.
 * Concatenate two 32-byte words and keccak256. Solidity `KeccakHasher`
 * should do the same. Production trees use Poseidon via `IHasher`.
 *
 * @param {string|bigint} left
 * @param {string|bigint} right
 * @returns {`0x${string}`}
 */
function keccakHashLeftRight(left, right) {
  return keccak256(encodePacked(["bytes32", "bytes32"], [toHex32(left), toHex32(right)]));
}

function publicInputsToHex(publicInputs) {
  const arr = Array.isArray(publicInputs)
    ? publicInputs
    : serializePublicInputs(publicInputs);
  return arr.map(toHex32);
}

module.exports = {
  PUBLIC_INPUT_KEYS,
  serializePublicInputs,
  parsePublicInputs,
  publicInputsToHex,
  toBigInt,
  toHex32,
  hexToBytes,
  bytesToHex,
  encodePacked,
  keccak256,
  keccak256FallbackBytes,
  functionSelector,
  keccakHashLeftRight,
};

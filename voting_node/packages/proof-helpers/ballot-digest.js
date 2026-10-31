"use strict";

// Ordered EG ballot digest. Matches BallotDigest.sol and circuits/indexed_merkle.circom.
// ct = Poseidon(Poseidon(c1x, c1y), Poseidon(c2x, c2y)).
// ballot = Poseidon(ct(primary), n), then Poseidon(acc, ct(option_i)) in order.
// n = 0 is Poseidon(ct, 0), not ct alone.

const { poseidonHashLeftRight } = require("./poseidon.js");

const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function mod(n) {
  const x = typeof n === "bigint" ? n : BigInt(n);
  if (x < 0n) throw new Error("negative field element");
  return x % FIELD;
}

function H(left, right) {
  return poseidonHashLeftRight(mod(left), mod(right));
}

function word(value) {
  return mod(value);
}

function coordsOf(point) {
  if (Array.isArray(point)) return [word(point[0]), word(point[1]), word(point[2]), word(point[3])];
  return [word(point.c1X), word(point.c1Y), word(point.c2X), word(point.c2Y)];
}

function ciphertextHash(x1, y1, x2, y2) {
  return H(H(x1, y1), H(x2, y2));
}

function ballotDigest(c1x, c1y, c2x, c2y, options = []) {
  const n = options.length;
  let h = H(ciphertextHash(c1x, c1y, c2x, c2y), BigInt(n));
  for (const option of options) {
    const [x1, y1, x2, y2] = coordsOf(option);
    h = H(h, ciphertextHash(x1, y1, x2, y2));
  }
  return h;
}

function optionVectorHash(options = []) {
  let h = H(0n, BigInt(options.length));
  for (const option of options) {
    const [x1, y1, x2, y2] = coordsOf(option);
    h = H(h, ciphertextHash(x1, y1, x2, y2));
  }
  return h;
}

function hexToBytes(hex) {
  const raw = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (raw.length % 2 !== 0) throw new Error("odd hex");
  const out = new Uint8Array(raw.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(raw.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes) {
  let hex = "0x";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

function readWord(bytes, offset) {
  let x = 0n;
  for (let i = 0; i < 32; i += 1) x = (x << 8n) + BigInt(bytes[offset + i]);
  return x;
}

function writeWord(bytes, offset, value) {
  let x = word(value);
  for (let i = 31; i >= 0; i -= 1) {
    bytes[offset + i] = Number(x & 0xffn);
    x >>= 8n;
  }
}

function encodeEgBallot(c1x, c1y, c2x, c2y, options = []) {
  const n = options.length;
  if (n > 4) throw new Error("option count must be 0..4");
  const len = n === 0 ? 130 : 162 + n * 128;
  const bytes = new Uint8Array(len);
  bytes[0] = 0x45;
  bytes[1] = 0x47;
  writeWord(bytes, 2, c1x);
  writeWord(bytes, 34, c1y);
  writeWord(bytes, 66, c2x);
  writeWord(bytes, 98, c2y);
  if (n > 0) {
    writeWord(bytes, 130, n);
    options.forEach((option, i) => {
      const [x1, y1, x2, y2] = coordsOf(option);
      const off = 162 + i * 128;
      writeWord(bytes, off, x1);
      writeWord(bytes, off + 32, y1);
      writeWord(bytes, off + 64, x2);
      writeWord(bytes, off + 96, y2);
    });
  }
  return bytesToHex(bytes);
}

/** @returns {bigint | null} Ordered digest, or null when the blob is not canonical EG. */
function digestEgBallot(bytesOrHex) {
  const bytes = typeof bytesOrHex === "string" ? hexToBytes(bytesOrHex) : bytesOrHex;
  if (!bytes || bytes.length < 130 || bytes[0] !== 0x45 || bytes[1] !== 0x47) return null;
  const c1x = readWord(bytes, 2);
  const c1y = readWord(bytes, 34);
  const c2x = readWord(bytes, 66);
  const c2y = readWord(bytes, 98);
  if (bytes.length === 130) return ballotDigest(c1x, c1y, c2x, c2y, []);
  if (bytes.length < 162) return null;
  const n = readWord(bytes, 130);
  if (n > 4n || bytes.length !== 162 + Number(n) * 128) return null;
  const options = [];
  for (let i = 0; i < Number(n); i += 1) {
    const off = 162 + i * 128;
    options.push([readWord(bytes, off), readWord(bytes, off + 32), readWord(bytes, off + 64), readWord(bytes, off + 96)]);
  }
  return ballotDigest(c1x, c1y, c2x, c2y, options);
}

module.exports = {
  ciphertextHash,
  ballotDigest,
  optionVectorHash,
  encodeEgBallot,
  digestEgBallot,
};

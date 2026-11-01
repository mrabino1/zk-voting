/**
 * NOT FOR PROFIT — civic public good, not a commercial product.
 *
 * Plurality envelope for aggregate tally. Exponential ElGamal on P-256,
 * one ciphertext per option, exactly one of them encrypts 1.
 *
 * Layout (bytes):
 *   "AG" (0x41 0x47) || tag (32) || nOptions (uint8) || n * (C1 || C2)
 *   C1 and C2 are uncompressed P-256 points (65 bytes each).
 *
 * tag = Poseidon(choice, choiceRandomness) mod r, big-endian.
 * choiceRandomness stays private. The tag is what the vote circuit binds
 * and what an "AG" ballot hash is on chain. The curve check of C1/C2 is
 * not in the dev circuit yet.
 */

import { poseidonHashLeftRight } from "./poseidon.js";
import { P256_G, p256Add, p256Mul, pointFromRaw, pointToRaw, randomScalar } from "./p256-math.js";

export const AGGREGATE_MAGIC = new Uint8Array([0x41, 0x47]);
const FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const POINT = 65;

function bytesToHex(bytes) {
  let s = "0x";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

export function hexToBytes(hex) {
  let h = String(hex || "").trim();
  if (h.startsWith("0x") || h.startsWith("0X")) h = h.slice(2);
  if (h.length % 2 !== 0) throw new Error("odd hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function concat(chunks) {
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

function fieldHex(value) {
  return "0x" + (BigInt(value) % FIELD).toString(16).padStart(64, "0");
}

/** Fresh private tag randomness in the scalar field (never zero). */
export function freshChoiceRandomness() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  let n = 0n;
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  n %= FIELD;
  return n === 0n ? 1n : n;
}

export function aggregateTag(choice, choiceRandomness, bindHash) {
  let tag = poseidonHashLeftRight(BigInt(choice), BigInt(choiceRandomness));
  // Sealed ranked-choice: the tag also commits to the ranking envelope hash,
  // so the proven ballot hash binds the ranking at cast time.
  if (bindHash != null && bindHash !== "") tag = poseidonHashLeftRight(tag, BigInt(bindHash) % FIELD);
  return { tag, hex: fieldHex(tag) };
}

export function isAggregateEnvelope(hexOrBytes) {
  try {
    const bytes = typeof hexOrBytes === "string" ? hexToBytes(hexOrBytes) : hexOrBytes;
    if (!(bytes instanceof Uint8Array) || bytes.length < 2 + 32 + 1) return false;
    if (bytes[0] !== 0x41 || bytes[1] !== 0x47) return false;
    const n = bytes[34];
    if (n < 1 || n > 16) return false;
    return bytes.length === 2 + 32 + 1 + n * POINT * 2;
  } catch {
    return false;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.jointPublicKey uncompressed hex point Y
 * @param {number|bigint} opts.choice option index, exactly one bit is 1
 * @param {bigint|number|string} opts.choiceRandomness private tag randomness
 * @param {number} opts.nOptions
 * @param {bigint[]} [opts.scalars] test-only scalars, length nOptions
 * @param {string} [opts.bindHash] sealed ranking envelope hash bound into the tag
 */
export function encryptAggregateBallot({ jointPublicKey, choice, choiceRandomness, nOptions, scalars, bindHash }) {
  const n = Number(nOptions);
  const selected = Number(choice);
  if (!Number.isInteger(n) || n < 1 || n > 16) {
    throw Object.assign(new Error("nOptions must be 1..16"), { code: "BAD_ENVELOPE" });
  }
  if (!Number.isInteger(selected) || selected < 0 || selected >= n) {
    throw Object.assign(new Error("choice is not one of the options"), { code: "OPTION_RANGE" });
  }
  const Y = pointFromRaw(hexToBytes(jointPublicKey));
  const rs = scalars && scalars.length === n ? scalars : Array.from({ length: n }, () => randomScalar());
  const points = [];
  for (let j = 0; j < n; j++) {
    const r = rs[j];
    const c1 = p256Mul(r, P256_G);
    const shared = p256Mul(r, Y);
    const c2 = j === selected ? p256Add(shared, P256_G) : shared;
    points.push(pointToRaw(c1), pointToRaw(c2));
  }
  const { tag, hex } = aggregateTag(selected, choiceRandomness, bindHash);
  const tagBytes = hexToBytes(hex);
  const header = new Uint8Array(2 + 32 + 1);
  header.set(AGGREGATE_MAGIC, 0);
  header.set(tagBytes, 2);
  header[34] = n;
  const body = concat(points);
  const bytes = concat([header, body]);
  return {
    encryptedBallot: bytesToHex(bytes),
    ballotHash: hex,
    tag,
    nOptions: n,
    choice: selected,
  };
}

export function parseAggregateEnvelope(hexOrBytes) {
  const bytes = typeof hexOrBytes === "string" ? hexToBytes(hexOrBytes) : hexOrBytes;
  if (!isAggregateEnvelope(bytes)) {
    throw Object.assign(new Error("not an AG aggregate envelope"), { code: "BAD_ENVELOPE" });
  }
  let tag = 0n;
  for (let i = 0; i < 32; i++) tag = (tag << 8n) + BigInt(bytes[2 + i]);
  const n = bytes[34];
  const options = [];
  let o = 35;
  for (let j = 0; j < n; j++) {
    const c1 = bytes.subarray(o, o + POINT);
    const c2 = bytes.subarray(o + POINT, o + POINT * 2);
    o += POINT * 2;
    options.push({
      c1: pointFromRaw(c1),
      c2: pointFromRaw(c2),
      c1Hex: bytesToHex(c1),
      c2Hex: bytesToHex(c2),
    });
  }
  return { tag, ballotHash: fieldHex(tag), nOptions: n, options };
}

/** Pointwise sum of AG envelopes. Every envelope must use the same nOptions. */
export function aggregateCiphertexts(envelopes) {
  const parsed = (envelopes || []).map(parseAggregateEnvelope);
  if (!parsed.length) {
    throw Object.assign(new Error("no aggregate envelopes"), { code: "ENVELOPE_GAP" });
  }
  const n = parsed[0].nOptions;
  if (parsed.some((row) => row.nOptions !== n)) {
    throw Object.assign(new Error("aggregate envelopes disagree on nOptions"), { code: "BAD_ENVELOPE" });
  }
  const options = [];
  for (let j = 0; j < n; j++) {
    let c1 = null;
    let c2 = null;
    for (const row of parsed) {
      c1 = p256Add(c1, row.options[j].c1);
      c2 = p256Add(c2, row.options[j].c2);
    }
    options.push({
      c1,
      c2,
      c1Hex: bytesToHex(pointToRaw(c1)),
      c2Hex: bytesToHex(pointToRaw(c2)),
    });
  }
  return { nOptions: n, options, ballots: parsed.length };
}

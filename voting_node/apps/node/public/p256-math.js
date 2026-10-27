/**
 * NOT FOR PROFIT — civic public good, not a commercial product.
 *
 * Affine P-256 (secp256r1) used by the in-browser aggregate ballot.
 * Same curve as @noble/curves p256. Uncompressed points are 0x04 || x || y.
 */

const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const GX = 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n;
const GY = 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n;

export const P256_P = P;
export const P256_N = N;
export const P256_G = Object.freeze({ x: GX, y: GY });

function mod(value, modulus = P) {
  const r = BigInt(value) % modulus;
  return r >= 0n ? r : r + modulus;
}

function inv(value, modulus = P) {
  let a = mod(value, modulus);
  if (a === 0n) throw new Error("inverse of zero");
  let result = 1n;
  let e = modulus - 2n;
  while (e > 0n) {
    if (e & 1n) result = mod(result * a, modulus);
    a = mod(a * a, modulus);
    e >>= 1n;
  }
  return result;
}

/** @param {{x: bigint, y: bigint}|null} p */
export function p256Add(p, q) {
  if (!p) return q;
  if (!q) return p;
  if (p.x === q.x) {
    if ((p.y + q.y) % P === 0n) return null;
    const slope = mod((3n * p.x * p.x + (P - 3n)) * inv(mod(2n * p.y)));
    const x = mod(slope * slope - 2n * p.x);
    const y = mod(slope * (p.x - x) - p.y);
    return { x, y };
  }
  const slope = mod((q.y - p.y) * inv(mod(q.x - p.x)));
  const x = mod(slope * slope - p.x - q.x);
  const y = mod(slope * (p.x - x) - p.y);
  return { x, y };
}

export function p256Negate(point) {
  if (!point) return null;
  return { x: point.x, y: point.y === 0n ? 0n : P - point.y };
}

export function p256Mul(scalar, point) {
  let k = mod(scalar, N);
  let acc = null;
  let base = point;
  while (k > 0n) {
    if (k & 1n) acc = p256Add(acc, base);
    base = p256Add(base, base);
    k >>= 1n;
  }
  return acc;
}

function hex32(value) {
  return mod(value).toString(16).padStart(64, "0");
}

export function pointToRaw(point) {
  if (!point) throw new Error("identity point");
  const hex = `04${hex32(point.x)}${hex32(point.y)}`;
  const out = new Uint8Array(65);
  for (let i = 0; i < 65; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function pointFromRaw(bytes) {
  const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (raw.length !== 65 || raw[0] !== 0x04) throw new Error("P-256 point must be uncompressed");
  let x = 0n;
  let y = 0n;
  for (let i = 0; i < 32; i++) x = (x << 8n) + BigInt(raw[1 + i]);
  for (let i = 0; i < 32; i++) y = (y << 8n) + BigInt(raw[33 + i]);
  if (x >= P || y >= P) throw new Error("P-256 coordinate out of range");
  const yy = mod(y * y);
  const rhs = mod(mod(x * x) * x + (P - 3n) * x + 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn);
  if (yy !== rhs) throw new Error("P-256 point is not on the curve");
  return { x, y };
}

export function randomScalar() {
  const cryptoObj = globalThis.crypto;
  if (!cryptoObj?.getRandomValues) throw new Error("crypto.getRandomValues is required");
  for (;;) {
    const bytes = cryptoObj.getRandomValues(new Uint8Array(32));
    let scalar = 0n;
    for (const b of bytes) scalar = (scalar << 8n) + BigInt(b);
    scalar %= N;
    if (scalar > 0n) return scalar;
  }
}

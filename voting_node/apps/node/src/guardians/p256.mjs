// NOT FOR PROFIT — civic public good, not a commercial product.
// P-256 field arithmetic for Feldman shares and Chaum-Pedersen proofs.
// WebCrypto encrypts to the joint point; it cannot add partial points, so
// combination lives here. Scalars are the curve order, not the field prime.

import { p256 } from '@noble/curves/p256';

export const ORDER = p256.CURVE.n;
export const BASE = p256.ProjectivePoint.BASE;
export const IDENTITY = p256.ProjectivePoint.ZERO;

export function mod(value, modulus = ORDER) {
  const r = BigInt(value) % modulus;
  return r >= 0n ? r : r + modulus;
}

export function modPow(base, exp, modulus = ORDER) {
  let result = 1n;
  let b = mod(base, modulus);
  let e = BigInt(exp);
  if (e < 0n) throw new Error('negative exponent');
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus;
    b = (b * b) % modulus;
    e >>= 1n;
  }
  return result;
}

export function inv(value, modulus = ORDER) {
  const a = mod(value, modulus);
  if (a === 0n) throw new Error('inverse of zero');
  return modPow(a, modulus - 2n, modulus);
}

export function randomScalar() {
  for (;;) {
    const bytes = p256.utils.randomPrivateKey();
    const scalar = bytesToScalar(bytes);
    if (scalar > 0n && scalar < ORDER) return scalar;
  }
}

export function bytesToScalar(bytes) {
  const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (raw.length !== 32) {
    throw Object.assign(new Error('scalar must be 32 bytes'), { code: 'BAD_SCALAR' });
  }
  const scalar = BigInt(`0x${Buffer.from(raw).toString('hex')}`);
  if (scalar <= 0n || scalar >= ORDER) {
    throw Object.assign(new Error('scalar out of range'), { code: 'BAD_SCALAR' });
  }
  return scalar;
}

export function scalarToBytes(scalar) {
  const hex = mod(scalar).toString(16).padStart(64, '0');
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

export function scalarToHex(scalar) {
  return `0x${mod(scalar).toString(16).padStart(64, '0')}`;
}

export function hexToScalar(hex) {
  let h = String(hex || '').trim().toLowerCase();
  if (h.startsWith('0x')) h = h.slice(2);
  if (!/^[0-9a-f]{1,64}$/.test(h)) {
    throw Object.assign(new Error('scalar hex is invalid'), { code: 'BAD_SCALAR' });
  }
  return bytesToScalar(Buffer.from(h.padStart(64, '0'), 'hex'));
}

function stripHex(hex) {
  const h = String(hex || '').trim();
  return h.startsWith('0x') || h.startsWith('0X') ? h.slice(2) : h;
}

export function pointFromHex(hexOrBytes) {
  try {
    const point =
      hexOrBytes instanceof Uint8Array
        ? p256.ProjectivePoint.fromHex(hexOrBytes)
        : p256.ProjectivePoint.fromHex(stripHex(hexOrBytes));
    if (point.equals(p256.ProjectivePoint.ZERO)) {
      throw new Error('identity point');
    }
    return point;
  } catch (err) {
    throw Object.assign(new Error(`invalid P-256 point: ${err.message}`), { code: 'BAD_POINT' });
  }
}

export function pointToHex(point) {
  return `0x${Buffer.from(point.toRawBytes(false)).toString('hex')}`;
}

export function pointXBytes(point) {
  return point.toRawBytes(false).subarray(1, 33);
}

export function evalPoly(coeffs, x, modulus = ORDER) {
  let acc = 0n;
  const xv = mod(x, modulus);
  for (let i = coeffs.length - 1; i >= 0; i--) {
    acc = mod(acc * xv + coeffs[i], modulus);
  }
  return acc;
}

/**
 * f(0) from Shamir points {x, y}. Needs `points.length` evaluations; a caller
 * that passes fewer than the polynomial degree plus one does not recover the
 * dealer secret. This function does not know the degree — callers enforce t.
 */
export function lagrangeAtZero(points, modulus = ORDER) {
  if (!Array.isArray(points) || points.length === 0) {
    throw Object.assign(new Error('no shares'), { code: 'THRESHOLD_NOT_MET' });
  }
  const xs = points.map((p) => BigInt(p.x));
  if (new Set(xs.map(String)).size !== xs.length) {
    throw Object.assign(new Error('duplicate share index'), { code: 'BAD_SHARE' });
  }
  let secret = 0n;
  for (let i = 0; i < points.length; i++) {
    let lambda = 1n;
    const xi = xs[i];
    for (let j = 0; j < points.length; j++) {
      if (i === j) continue;
      const xj = xs[j];
      lambda = mod(lambda * xj, modulus);
      lambda = mod(lambda * inv(mod(xj - xi, modulus), modulus), modulus);
    }
    secret = mod(secret + lambda * BigInt(points[i].y), modulus);
  }
  return secret;
}

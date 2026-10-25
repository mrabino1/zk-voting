// NOT FOR PROFIT — civic public good, not a commercial product.
// Threshold decryption of a P-256 ECIES envelope.
// Guardian i publishes P_i = x_i·R and a Chaum-Pedersen proof that
// log_G(Y_i) = log_R(P_i). Lagrange combination recovers x·R without
// reconstructing x in one place. Y_i is the Feldman verification key.

import { createHash } from 'node:crypto';

import { decryptTallyEnvelopeWithSharedBits, tallyEnvelopeEphemeral } from '../tallyCrypto.mjs';
import {
  BASE,
  ORDER,
  hexToScalar,
  inv,
  mod,
  pointFromHex,
  pointToHex,
  pointXBytes,
  randomScalar,
  scalarToHex,
} from './p256.mjs';

const DOMAIN = 'republic.guardian.chaum-pedersen.v1';

function hashBytes(parts) {
  const hash = createHash('sha256');
  hash.update(DOMAIN);
  for (const part of parts) {
    hash.update('\0');
    if (typeof part === 'string') hash.update(part);
    else hash.update(Buffer.from(part));
  }
  return hash.digest();
}

export function fiatShamirChallenge({ electionId, ballotHash, index, jointPublicKey, R, Y, P, A, B }) {
  const digest = hashBytes([
    String(electionId),
    String(ballotHash).toLowerCase(),
    String(index),
    jointPublicKey.toRawBytes(false),
    R.toRawBytes(false),
    Y.toRawBytes(false),
    P.toRawBytes(false),
    A.toRawBytes(false),
    B.toRawBytes(false),
  ]);
  let e = BigInt(`0x${digest.toString('hex')}`) % ORDER;
  if (e === 0n) e = 1n;
  return e;
}

export function partialDecrypt({ shareScalar, index, electionId, ballotHash, jointPublicKey, ephemeral }) {
  const x = typeof shareScalar === 'bigint' ? shareScalar : hexToScalar(shareScalar);
  const R = pointFromHex(ephemeral);
  const Y = BASE.multiply(x);
  const P = R.multiply(x);
  const joint = pointFromHex(jointPublicKey);
  const w = randomScalar();
  const A = BASE.multiply(w);
  const B = R.multiply(w);
  const e = fiatShamirChallenge({
    electionId,
    ballotHash,
    index,
    jointPublicKey: joint,
    R,
    Y,
    P,
    A,
    B,
  });
  const z = mod(w + e * x);
  return {
    ballotHash: String(ballotHash),
    point: pointToHex(P),
    proof: { A: pointToHex(A), B: pointToHex(B), z: scalarToHex(z) },
  };
}

/**
 * @returns {boolean} true when the partial matches the Feldman verification key
 */
export function verifyPartial({ partial, electionId, index, jointPublicKey, expectedY, ephemeral }) {
  try {
    const R = pointFromHex(ephemeral);
    const Y = pointFromHex(expectedY);
    const P = pointFromHex(partial?.point);
    const A = pointFromHex(partial?.proof?.A);
    const B = pointFromHex(partial?.proof?.B);
    const z = hexToScalar(partial?.proof?.z);
    const joint = pointFromHex(jointPublicKey);
    const e = fiatShamirChallenge({
      electionId,
      ballotHash: partial?.ballotHash,
      index,
      jointPublicKey: joint,
      R,
      Y,
      P,
      A,
      B,
    });
    const leftG = BASE.multiply(z);
    const rightG = A.add(Y.multiply(e));
    if (!leftG.equals(rightG)) return false;
    const leftR = R.multiply(z);
    const rightR = B.add(P.multiply(e));
    return leftR.equals(rightR);
  } catch {
    return false;
  }
}

function lambdaFor(index, indices) {
  const xi = BigInt(index);
  let lambda = 1n;
  for (const other of indices) {
    const xj = BigInt(other);
    if (xj === xi) continue;
    lambda = mod(lambda * xj);
    lambda = mod(lambda * inv(mod(xj - xi)));
  }
  return lambda;
}

/**
 * Combine at least `threshold` partial points into the ECDH shared point x·R.
 * Fewer than `threshold` distinct guardians throws THRESHOLD_NOT_MET.
 */
export function combinePartialPoints(partialPoints, threshold) {
  const rows = partialPoints.map((row) => ({
    index: Number(row.index),
    point: pointFromHex(row.point),
  }));
  if (rows.some((row) => !Number.isInteger(row.index) || row.index <= 0)) {
    throw Object.assign(new Error('partial index is invalid'), { code: 'BAD_PARTIAL' });
  }
  const unique = new Set(rows.map((row) => row.index));
  if (unique.size !== rows.length) {
    throw Object.assign(new Error('duplicate partial index'), { code: 'BAD_PARTIAL' });
  }
  const t = Number(threshold);
  if (!Number.isInteger(t) || rows.length < t) {
    throw Object.assign(new Error(`${rows.length} partials are below threshold ${t}`), {
      code: 'THRESHOLD_NOT_MET',
      have: rows.length,
      threshold: t,
    });
  }
  const chosen = [...rows].sort((a, b) => a.index - b.index).slice(0, t);
  const indices = chosen.map((row) => row.index);
  let acc = null;
  for (const row of chosen) {
    const term = row.point.multiply(lambdaFor(row.index, indices));
    acc = acc ? acc.add(term) : term;
  }
  return acc;
}

export function ephemeralFromEnvelope(envelopeHex) {
  return tallyEnvelopeEphemeral(envelopeHex);
}

export async function decryptEnvelopeWithPartials({
  envelopeHex,
  electionId,
  ballotHash,
  jointPublicKey,
  verificationKeys,
  partials,
  threshold,
}) {
  const ephemeral = ephemeralFromEnvelope(envelopeHex);
  const checked = [];
  for (const partial of partials) {
    const index = Number(partial.index);
    const expectedY = verificationKeys[String(index)] || verificationKeys[index];
    if (!expectedY) {
      throw Object.assign(new Error(`no verification key for guardian ${index}`), { code: 'BAD_PARTIAL' });
    }
    const ok = verifyPartial({
      partial: { ...partial, ballotHash },
      electionId,
      index,
      jointPublicKey,
      expectedY,
      ephemeral,
    });
    if (!ok) {
      throw Object.assign(new Error(`partial decryption from guardian ${index} is not valid`), {
        code: 'BAD_PARTIAL',
        index,
      });
    }
    checked.push({ index, point: partial.point });
  }
  const shared = combinePartialPoints(checked, threshold);
  return decryptTallyEnvelopeWithSharedBits(pointXBytes(shared), envelopeHex);
}

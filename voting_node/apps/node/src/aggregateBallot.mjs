// NOT FOR PROFIT — civic public good, not a commercial product.
// Homomorphic plurality tally. Guardians decrypt the product of the
// one-hot ElGamal ciphertexts, never an individual envelope.

import {
  aggregateCiphertexts,
  encryptAggregateBallot,
  isAggregateEnvelope,
  parseAggregateEnvelope,
} from '../public/aggregate-ballot.js';
import { p256Add, p256Negate, P256_G, pointFromRaw } from '../public/p256-math.js';
import { combinePartialPoints, verifyPartial } from './guardians/threshold.mjs';

export { aggregateCiphertexts, encryptAggregateBallot, isAggregateEnvelope, parseAggregateEnvelope };

export function aggregateOptionId(index) {
  return `aggregate:${Number(index)}`;
}

/** Discrete log base G, bounded by the number of accepted ballots. */
export function discreteLogBaseG(point, max) {
  const limit = Number(max);
  if (!Number.isInteger(limit) || limit < 0) {
    throw Object.assign(new Error('discrete log bound is invalid'), { code: 'PLAINTEXT_INVALID' });
  }
  if (!point) return 0;
  let acc = null;
  for (let i = 1; i <= limit; i += 1) {
    acc = p256Add(acc, P256_G);
    if (acc && acc.x === point.x && acc.y === point.y) return i;
  }
  throw Object.assign(new Error('aggregate plaintext is outside the ballot count'), {
    code: 'PLAINTEXT_INVALID',
  });
}

function nobleToPoint(noblePoint) {
  return pointFromRaw(noblePoint.toRawBytes(false));
}

/**
 * Decrypt one summed option. `partialGroups` is the ceremony bucket:
 * `{ index, partials: [{ ballotHash, point, proof }] }[]`.
 * Partials must be tagged `aggregate:<option>`.
 */
export function decryptAggregateCounts({
  product,
  electionId,
  jointPublicKey,
  verificationKeys,
  partialGroups,
  threshold,
  maxCount,
}) {
  const counts = [];
  for (let j = 0; j < product.nOptions; j += 1) {
    const ballotHash = aggregateOptionId(j);
    const ephemeral = product.options[j].c1Hex;
    const checked = [];
    for (const group of partialGroups || []) {
      const match = (group.partials || []).find((row) => String(row.ballotHash) === ballotHash);
      if (!match) continue;
      const index = Number(group.index);
      const expectedY = verificationKeys?.[String(index)] ?? verificationKeys?.[index];
      if (!expectedY) {
        throw Object.assign(new Error(`no verification key for guardian ${index}`), { code: 'BAD_PARTIAL' });
      }
      const ok = verifyPartial({
        partial: { ...match, ballotHash },
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
      checked.push({ index, point: match.point });
    }
    const shared = combinePartialPoints(checked, threshold);
    const message = p256Add(product.options[j].c2, p256Negate(nobleToPoint(shared)));
    counts.push(discreteLogBaseG(message, maxCount));
  }
  return counts;
}

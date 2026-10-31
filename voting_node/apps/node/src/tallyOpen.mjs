// NOT FOR PROFIT — civic public good, not a commercial product.
// Plurality tally decrypts the product of one-hot ciphertexts.
// Individual envelopes are not opened here. Sealed rankings open in rankedTally.mjs.

import { aggregateCiphertexts, decryptAggregateCounts } from './aggregateBallot.mjs';
import { HttpError } from './http.mjs';
import { TALLY_SCHEME_OPENS_BALLOTS, countsEqual, expectedCountLength } from './tallyCrypto.mjs';

export function isOpensBallots(election) {
  return (
    election?.tallyScheme === TALLY_SCHEME_OPENS_BALLOTS ||
    election?.tallyScheme === 1 ||
    election?.tallyScheme === 'opens_ballots'
  );
}

function httpFromCrypto(err) {
  if (err instanceof HttpError) throw err;
  const code = err.code || 'DECRYPT_FAILED';
  const status = code === 'THRESHOLD_NOT_MET' || code === 'CEREMONY_INCOMPLETE' ? 409 : 400;
  throw new HttpError(status, err.message, {
    code,
    ...(err.index != null ? { index: err.index } : {}),
    ...(err.have != null ? { have: err.have, threshold: err.threshold } : {}),
  });
}

/** The final tally uses the latest ciphertext. Published blocks keep the original. */
export function ciphertextForTally(env) {
  if (!env) return null;
  return env.tallyEncryptedBallot || env.encryptedBallot;
}

function sameNullifier(left, right) {
  try {
    return BigInt(left).toString() === BigInt(right).toString();
  } catch {
    return String(left) === String(right);
  }
}

/** Drop excluded ballots before a sum. Soft-deleted exclusions are not counted twice. */
export function withoutExcludedEnvelopes(envelopes, excludedNullifiers) {
  const all = Array.isArray(envelopes) ? envelopes : [];
  const ids = Array.isArray(excludedNullifiers) ? excludedNullifiers : [];
  if (!ids.length) return { envelopes: all, excludedLive: 0 };
  const kept = [];
  let excludedLive = 0;
  for (const env of all) {
    const excluded = ids.some((id) => sameNullifier(id, env?.nullifier));
    if (!excluded) {
      kept.push(env);
      continue;
    }
    if (env?.is_deleted !== true) excludedLive += 1;
  }
  return { envelopes: kept, excludedLive };
}

function splitSoftDeleted(envelopes) {
  const all = Array.isArray(envelopes) ? envelopes : [];
  const hidden = all.filter((env) => env && env.is_deleted === true).length;
  const live = all.filter((env) => !env || env.is_deleted !== true);
  return { live, hidden };
}

/**
 * Sum AG envelopes and threshold-decrypt each option total.
 * The returned object has counts only. There is no per-ballot openings list.
 */
export async function openBallots(election, envelopes, partialGroups, questions, excludedCount = 0) {
  const ceremony = election?.tallyCeremony;
  if (!ceremony || ceremony.status !== 'ready' || !ceremony.publicKey || !ceremony.verificationKeys) {
    throw new HttpError(409, 'guardian ceremony is not ready', { code: 'CEREMONY_INCOMPLETE' });
  }
  // Soft-deleted envelopes stay in the store (a purge is not a hard delete)
  // but they are not part of a live tally. When none are hidden, the check
  // is the same as comparing the array length to acceptedBallots.
  const { live, hidden } = splitSoftDeleted(envelopes);
  const accepted = Number(election.acceptedBallots) || 0;
  const excluded = Number(excludedCount) || 0;
  const expected = Math.max(0, accepted - hidden - excluded);
  if (live.length !== expected) {
    throw new HttpError(409, 'envelope count does not match acceptedBallots', {
      code: 'ENVELOPE_GAP',
      envelopes: live.length,
      acceptedBallots: expected,
    });
  }
  let product;
  try {
    product = aggregateCiphertexts(live.map((env) => ciphertextForTally(env)));
  } catch (err) {
    httpFromCrypto(err);
  }
  const nSlots = Math.max(expectedCountLength(questions || election.questions), 1);
  if (product.nOptions !== nSlots) {
    throw new HttpError(400, 'aggregate envelope width does not match the ballot', {
      code: 'OPTION_RANGE',
      nOptions: product.nOptions,
      nSlots,
    });
  }
  let counts;
  try {
    counts = decryptAggregateCounts({
      product,
      electionId: election.id,
      jointPublicKey: ceremony.publicKey,
      verificationKeys: ceremony.verificationKeys,
      partialGroups,
      threshold: ceremony.threshold,
      maxCount: expected,
    });
  } catch (err) {
    httpFromCrypto(err);
  }
  return {
    counts,
    nSlots,
    aggregation: 'homomorphic',
  };
}

export function rejectInventedCounts(submitted, derived) {
  if (!countsEqual(submitted, derived)) {
    throw new HttpError(400, 'counts[] do not match the aggregate tally', {
      code: 'INVENTED_COUNTS',
      submitted,
      derived,
    });
  }
}

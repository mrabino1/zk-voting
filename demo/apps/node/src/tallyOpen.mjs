// NOT FOR PROFIT — civic public good, not a commercial product.
// Plurality tally decrypts the product of one-hot ciphertexts.
// Individual envelopes are not opened. Ranked ballots are not tallied here.

import { aggregateCiphertexts, decryptAggregateCounts } from './aggregateBallot.mjs';
import { electionHasRanked } from './ballot.mjs';
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

/**
 * Sum AG envelopes and threshold-decrypt each option total.
 * The returned object has counts only. There is no per-ballot openings list.
 */
export async function openBallots(election, envelopes, partialGroups, questions) {
  if (electionHasRanked(election)) {
    throw new HttpError(
      409,
      'ranked tally is disabled until a verified shuffle exists; individual envelopes are not opened',
      { code: 'RANKED_TALLY_DISABLED' },
    );
  }
  const ceremony = election?.tallyCeremony;
  if (!ceremony || ceremony.status !== 'ready' || !ceremony.publicKey || !ceremony.verificationKeys) {
    throw new HttpError(409, 'guardian ceremony is not ready', { code: 'CEREMONY_INCOMPLETE' });
  }
  if (envelopes.length !== election.acceptedBallots) {
    throw new HttpError(409, 'envelope count does not match acceptedBallots', {
      code: 'ENVELOPE_GAP',
      envelopes: envelopes.length,
      acceptedBallots: election.acceptedBallots,
    });
  }
  let product;
  try {
    product = aggregateCiphertexts(envelopes.map((env) => env.encryptedBallot));
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
      maxCount: election.acceptedBallots,
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

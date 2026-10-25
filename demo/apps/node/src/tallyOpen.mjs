// NOT FOR PROFIT — civic public good, not a commercial product.
// Open accepted envelopes with t verified guardian partials.
// Aggregation is delegated; the only usable adapter is `undecided`.

import { getAggregator } from './guardians/aggregate.mjs';
import { decryptEnvelopeWithPartials } from './guardians/threshold.mjs';
import { HttpError } from './http.mjs';
import {
  TALLY_SCHEME_OPENS_BALLOTS,
  countsEqual,
  expectedCountLength,
  histogramFromOpenings,
  unpackChoices,
} from './tallyCrypto.mjs';

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
 * Decrypt each aggregation unit. Opened choices are returned to the caller
 * and are not written onto vote rows.
 * @param {object[]} partialGroups `{ index, partials: [{ ballotHash, point, proof }] }[]`
 */
export async function openBallots(election, envelopes, partialGroups, questions) {
  const ceremony = election?.tallyCeremony;
  if (!ceremony || ceremony.status !== 'ready' || !ceremony.publicKey || !ceremony.verificationKeys) {
    throw new HttpError(409, 'guardian ceremony is not ready', { code: 'CEREMONY_INCOMPLETE' });
  }
  let units;
  try {
    units = getAggregator(ceremony.aggregation || 'undecided').prepare(envelopes);
  } catch (err) {
    httpFromCrypto(err);
  }
  if (units.length !== envelopes.length) {
    throw new HttpError(
      409,
      'the selected aggregator did not return one ciphertext per ballot',
      { code: 'AGGREGATION_UNDECIDED' },
    );
  }
  if (envelopes.length !== election.acceptedBallots) {
    throw new HttpError(409, 'envelope count does not match acceptedBallots', {
      code: 'ENVELOPE_GAP',
      envelopes: envelopes.length,
      acceptedBallots: election.acceptedBallots,
    });
  }
  const nSlots = Math.max(expectedCountLength(questions || election.questions), 1);
  const openings = [];
  for (const unit of units) {
    const partials = [];
    for (const group of partialGroups || []) {
      const match = (group.partials || []).find((row) => String(row.ballotHash) === String(unit.ballotHash));
      if (match) partials.push({ ...match, index: group.index, ballotHash: unit.ballotHash });
    }
    let plain;
    try {
      plain = await decryptEnvelopeWithPartials({
        envelopeHex: unit.encryptedBallot,
        electionId: election.id,
        ballotHash: unit.ballotHash,
        jointPublicKey: ceremony.publicKey,
        verificationKeys: ceremony.verificationKeys,
        partials,
        threshold: ceremony.threshold,
      });
    } catch (err) {
      httpFromCrypto(err);
    }
    let choices;
    try {
      choices = unpackChoices(plain);
    } catch (err) {
      throw new HttpError(400, 'opened ballot plaintext is not a packed choice vector', {
        code: 'PLAINTEXT_INVALID',
        detail: err.message,
      });
    }
    const idx = Number(choices[0]);
    if (!Number.isInteger(idx) || idx < 0 || idx >= nSlots) {
      throw new HttpError(400, 'opened choice out of range', { code: 'OPTION_RANGE', idx, nSlots });
    }
    openings.push(idx);
  }
  const counts = histogramFromOpenings(openings, nSlots);
  return {
    openings,
    counts,
    nSlots,
    aggregation: ceremony.aggregation || 'undecided',
  };
}

export function rejectInventedCounts(submitted, derived) {
  if (!countsEqual(submitted, derived)) {
    throw new HttpError(400, 'counts[] do not match opened ballots', {
      code: 'INVENTED_COUNTS',
      submitted,
      derived,
    });
  }
}

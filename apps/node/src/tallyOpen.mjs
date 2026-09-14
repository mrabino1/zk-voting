// NOT FOR PROFIT — civic public good, not a commercial product.
// Decrypt accepted envelopes with the demo threshold-1 operator key and
// derive plurality counts. Never persist opened choices onto vote rows.

import { HttpError } from './http.mjs';
import {
  TALLY_SCHEME_OPENS_BALLOTS,
  countsEqual,
  decryptTallyEnvelope,
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

/**
 * Open every envelope for an election. Requires the demo guardian private JWK.
 * @returns {{ openings: number[], counts: number[], nSlots: number }}
 */
export async function openBallots(election, envelopes, guardian, questions) {
  if (!guardian?.privateJwk) {
    throw new HttpError(500, 'tally guardian private key missing', { code: 'NO_TALLY_KEY' });
  }
  const nSlots = Math.max(expectedCountLength(questions || election.questions), 1);
  if (envelopes.length !== election.acceptedBallots) {
    throw new HttpError(409, 'envelope count does not match acceptedBallots', {
      code: 'ENVELOPE_GAP',
      envelopes: envelopes.length,
      acceptedBallots: election.acceptedBallots,
    });
  }
  const openings = [];
  for (const env of envelopes) {
    let plain;
    try {
      plain = await decryptTallyEnvelope(guardian.privateJwk, env.encryptedBallot);
    } catch (err) {
      throw new HttpError(400, 'failed to open a ballot envelope', {
        code: 'DECRYPT_FAILED',
        detail: err.message,
      });
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
  return { openings, counts, nSlots };
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

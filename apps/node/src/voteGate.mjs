// NOT FOR PROFIT — civic public good, not a commercial product.
// Live external eligibility gate. Election staff register unbounded parties
// (death records, felony systems, age verification, …). Any active party may
// veto a registered person at cast time. The identity commitment is checked
// then discarded; it is never stored on the ballot.

import { HttpError } from './http.mjs';
import { isValidReasonCode, reasonName } from './reasonCodes.mjs';

export const PARTY_MODE_VETO = 'veto';
export const PARTY_MODE_MUST_ATTEST = 'must_attest';
export const PARTY_MODES = Object.freeze([PARTY_MODE_VETO, PARTY_MODE_MUST_ATTEST]);

export const DEFAULT_PARTY_TIMEOUT_MS = 2500;

export function isPartyMode(mode) {
  return PARTY_MODES.includes(String(mode || '').trim());
}

function rejectVote(party, reasonCode, extra = {}) {
  const code = isValidReasonCode(reasonCode) ? Number(reasonCode) : 14;
  throw new HttpError(403, 'external party rejected this vote', {
    code: 'EXTERNAL_PARTY_REJECTED',
    partyId: party.id,
    partyName: party.name,
    reasonCode: code,
    reasonName: reasonName(code),
    ...extra,
  });
}

async function queryEndpoint(party, { electionId, identityCommitment, fetchImpl, timeoutMs }) {
  const fetchFn = fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new HttpError(503, 'external party endpoint cannot be reached', {
      code: 'EXTERNAL_PARTY_UNREACHABLE',
      partyId: party.id,
      partyName: party.name,
    });
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchFn(party.endpointUrl, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      signal: ac.signal,
      body: JSON.stringify({
        nfp: true,
        purpose: 'cast',
        electionId: String(electionId),
        identityCommitment,
      }),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      rejectVote(party, json?.reasonCode || 14, { httpStatus: res.status });
    }
    if (!json || json.allow !== true) {
      rejectVote(party, json?.reasonCode || 14, { evidenceHash: json?.evidenceHash || null });
    }
    return { partyId: party.id, allow: true, source: 'http' };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(403, 'external party did not clear this vote', {
      code: 'EXTERNAL_PARTY_UNREACHABLE',
      partyId: party.id,
      partyName: party.name,
      reasonCode: 14,
      reasonName: reasonName(14),
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fail-closed live check against every active party for this election.
 * Store vetoes and in-store MUST_ATTEST clearances do not wait on HTTP.
 * Parties with `endpointUrl` are queried at cast time (timeout = reject).
 */
export async function assertExternalClearance(
  store,
  electionId,
  identityCommitment,
  { now = Math.floor(Date.now() / 1000), fetchImpl } = {},
) {
  const parties = store.listActiveExternalParties(electionId);
  if (!parties.length) return { ok: true, checks: [] };
  const checks = [];
  for (const party of parties) {
    const timeoutMs = Number(party.endpointTimeoutMs) || DEFAULT_PARTY_TIMEOUT_MS;
    if (party.endpointUrl) {
      checks.push(
        await queryEndpoint(party, {
          electionId,
          identityCommitment,
          fetchImpl,
          timeoutMs,
        }),
      );
      continue;
    }
    const veto = store.activePartyRejection(electionId, party.id, identityCommitment);
    if (veto) {
      rejectVote(party, veto.reasonCode, { evidenceHash: veto.evidenceHash || null });
    }
    if (party.mode === PARTY_MODE_MUST_ATTEST) {
      const attest = store.activePartyAttestation(electionId, party.id, identityCommitment, now);
      if (!attest) {
        throw new HttpError(403, 'external party has not attested this identity', {
          code: 'EXTERNAL_ATTESTATION_REQUIRED',
          partyId: party.id,
          partyName: party.name,
        });
      }
      checks.push({ partyId: party.id, allow: true, source: 'attestation' });
      continue;
    }
    checks.push({ partyId: party.id, allow: true, source: 'veto-clear' });
  }
  return { ok: true, checks };
}

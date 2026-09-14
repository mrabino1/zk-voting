// NOT FOR PROFIT — civic public good, not a commercial product.
// Public election ids are UUID v4. Short codes are opaque url-safe aliases.
// Solidity ElectionFactory still uses uint256 (`++electionCount`); that value
// is stored as onChainElectionId and is what Groth16 / BallotInbox consume.

import { randomBytes, randomUUID } from 'node:crypto';

/** UUID v4 (RFC 4122). */
export const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Crockford-ish lowercase alphabet (no 0/o/1/i/l) so short links stay
 * url-safe and copy-paste friendly. 31^10 ≈ 8e14 codes.
 */
export const SHORT_CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const SHORT_CODE_LENGTH = 10;

export function isUuid(value) {
  return UUID_V4_RE.test(String(value || ''));
}

export function mintUuid() {
  return randomUUID();
}

/**
 * @param {number} [length]
 * @returns {string}
 */
export function mintShortCode(length = SHORT_CODE_LENGTH) {
  const n = Number(length);
  const size = Number.isInteger(n) && n >= 8 ? n : SHORT_CODE_LENGTH;
  const alphabet = SHORT_CODE_ALPHABET;
  const bytes = randomBytes(size);
  let out = '';
  for (let i = 0; i < size; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  if (!/[a-z]/.test(out)) {
    out = `a${out.slice(1)}`;
  }
  return out;
}

export function isShortCodeShape(value) {
  const s = String(value || '');
  if (s.length < 8 || s.length > 16) return false;
  if (isUuid(s)) return false;
  return new RegExp(`^[${SHORT_CODE_ALPHABET}]+$`).test(s);
}

/**
 * Decimal uint256 used on chain (factory electionId / circuit public input).
 * @param {object} election
 * @returns {string}
 */
export function chainElectionId(election) {
  if (election?.onChainElectionId != null && String(election.onChainElectionId) !== '') {
    return String(election.onChainElectionId);
  }
  return String(election?.id ?? '');
}

/**
 * Every human-facing or legacy key that should resolve to this election.
 * @param {object} election
 * @returns {Set<string>}
 */
export function refsOf(election) {
  const refs = new Set();
  if (!election) return refs;
  if (election.id != null && election.id !== '') refs.add(String(election.id));
  if (election.shortCode) refs.add(String(election.shortCode));
  if (election.onChainElectionId != null && election.onChainElectionId !== '') {
    refs.add(String(election.onChainElectionId));
  }
  for (const alias of election.aliases || []) {
    if (alias != null && alias !== '') refs.add(String(alias));
  }
  return refs;
}

export function electionMatchesRef(election, ref) {
  if (ref == null || ref === '') return false;
  return refsOf(election).has(String(ref));
}

export function parseOnChainElectionId(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (!/^\d+$/.test(s)) {
    const err = new Error('onChainElectionId must be a decimal uint256');
    err.status = 400;
    throw err;
  }
  try {
    const n = BigInt(s);
    if (n < 0n || n >= 1n << 256n) {
      const err = new Error('onChainElectionId out of uint256 range');
      err.status = 400;
      throw err;
    }
  } catch (err) {
    if (err.status) throw err;
    const wrapped = new Error('onChainElectionId out of uint256 range');
    wrapped.status = 400;
    throw wrapped;
  }
  return s.replace(/^0+(?=\d)/, '') || '0';
}

export function publicIdFields(election) {
  if (!election) return {};
  const id = String(election.id);
  const shortCode = election.shortCode || null;
  return {
    id,
    shortCode,
    onChainElectionId: election.onChainElectionId != null ? String(election.onChainElectionId) : null,
    links: {
      vote: `/vote/${encodeURIComponent(id)}`,
      short: shortCode ? `/v/${encodeURIComponent(shortCode)}` : null,
      election: shortCode ? `/e/${encodeURIComponent(shortCode)}` : `/vote/${encodeURIComponent(id)}`,
    },
  };
}

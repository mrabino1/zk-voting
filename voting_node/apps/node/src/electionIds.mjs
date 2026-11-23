// NOT FOR PROFIT — civic public good, not a commercial product.
// Public election ids are UUID v5 bound to (node, jurisdiction, local sequence),
// so a UUID copied from another Node or jurisdiction does not verify.
// UUID v4 remains as a random helper and for legacy records.
// The local sequence is stored as `localElectionId` (historical name). It is
// the numeric electionId in the node's poll proofs. A civic vote's L1 id is
// separate: `election.rollup.electionId`, assigned by ZkVotingRollup on publish.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { keccak256 } = require('@zk-voting/proof-helpers');

/** UUID v4 (RFC 4122). */
export const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** UUID v5 (name-based, RFC 4122). */
export const UUID_V5_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** UUID v1–v8 (canonical 8-4-4-4-12). */
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Name-based namespace for ZK-Voting public election ids (UUID v5). */
export const ZK_VOTING_ELECTION_NAMESPACE = '7c3a1f10-9e2b-5c4d-8a71-0b9d4e6f2a11';

/**
 * Crockford-ish lowercase alphabet (no 0/o/1/i/l) so short links stay
 * url-safe and copy-paste friendly. 31^10 ≈ 8e14 codes.
 */
export const SHORT_CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const SHORT_CODE_LENGTH = 10;

export function isUuid(value) {
  return UUID_RE.test(String(value || ''));
}

export function uuidVersion(value) {
  if (!isUuid(value)) return 0;
  return parseInt(String(value).split('-')[2][0], 16);
}

export function mintUuid() {
  return randomUUID();
}

/**
 * RFC 4122 UUID v5: SHA-1(namespace bytes || name), then set version/variant.
 * @param {string} namespaceUuid
 * @param {string} name
 */
export function uuidV5(namespaceUuid, name) {
  const ns = String(namespaceUuid || '').replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(ns)) {
    throw new Error('uuidV5: namespace must be a UUID');
  }
  const hash = createHash('sha1')
    .update(Buffer.from(ns, 'hex'))
    .update(String(name), 'utf8')
    .digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Jurisdiction id → bytes32: `keccak256(utf8(id))` unless already 32-byte hex. */
function jurisdictionBytes32(id) {
  const s = String(id || '').trim();
  if (!s) return `0x${'00'.repeat(32)}`;
  if (/^0x[0-9a-fA-F]{64}$/.test(s)) return s.toLowerCase();
  return keccak256(s);
}

/**
 * Canonical name hashed into the public UUID. The `demo:` prefix is historical
 * and kept so ids already issued still verify.
 */
export function scopedPublicIdName(scope = {}) {
  const electionId = String(scope.localElectionId ?? '').trim();
  const jurisdiction = jurisdictionBytes32(scope.jurisdictionId);
  const nodeId = String(scope.nodeId || '').trim().toLowerCase();
  return `demo:${nodeId}:${jurisdiction}:${electionId}`;
}

export function mintScopedPublicId(scope = {}) {
  return uuidV5(ZK_VOTING_ELECTION_NAMESPACE, scopedPublicIdName(scope));
}

export function publicIdMatchesScope(uuid, scope = {}) {
  if (!uuid) return false;
  if (uuidVersion(uuid) !== 5) return true;
  return String(uuid).toLowerCase() === mintScopedPublicId(scope);
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
 * Decimal uint256 used as the electionId public input of the node's poll proofs.
 * @param {object} election
 * @returns {string}
 */
export function localElectionIdOf(election) {
  if (election?.localElectionId != null && String(election.localElectionId) !== '') {
    return String(election.localElectionId);
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
  if (election.uuid) refs.add(String(election.uuid));
  if (election.code) refs.add(String(election.code));
  if (election.publicId) refs.add(String(election.publicId));
  if (election.shortCode) refs.add(String(election.shortCode));
  if (election.localElectionId != null && election.localElectionId !== '') {
    refs.add(String(election.localElectionId));
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

export function parseLocalElectionId(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (!/^\d+$/.test(s)) {
    const err = new Error('localElectionId must be a decimal uint256');
    err.status = 400;
    throw err;
  }
  try {
    const n = BigInt(s);
    if (n < 0n || n >= 1n << 256n) {
      const err = new Error('localElectionId out of uint256 range');
      err.status = 400;
      throw err;
    }
  } catch (err) {
    if (err.status) throw err;
    const wrapped = new Error('localElectionId out of uint256 range');
    wrapped.status = 400;
    throw wrapped;
  }
  return s.replace(/^0+(?=\d)/, '') || '0';
}

export function publicIdFields(election) {
  if (!election) return {};
  const id = String(election.id);
  const shortCode = election.shortCode || null;
  const localElectionId = election.localElectionId != null ? String(election.localElectionId) : null;
  return {
    id,
    shortCode,
    localElectionId,
    publicIdScheme: election.publicIdScheme || (uuidVersion(id) === 5 ? 'uuid-v5-jurisdiction' : null),
    links: {
      vote: `/vote/${encodeURIComponent(id)}`,
      short: shortCode ? `/v/${encodeURIComponent(shortCode)}` : null,
      election: shortCode ? `/e/${encodeURIComponent(shortCode)}` : `/vote/${encodeURIComponent(id)}`,
    },
  };
}

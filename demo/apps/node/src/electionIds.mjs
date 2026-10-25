// NOT FOR PROFIT — civic public good, not a commercial product.
// Public election ids are UUID v5 bound to (factory, on-chain id, jurisdiction)
// so two bodies cannot advertise the same id for different L1 identities.
// UUID v4 remains as a random helper and for legacy records.
// Solidity ElectionFactory still uses uint256 (`++electionCount`); that value
// is stored as onChainElectionId and is what Groth16 / BallotInbox consume.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  certificationId,
  jurisdictionBytes32,
  publicIdHash,
} = require('@zk-voting/chain-client');

/** UUID v4 (RFC 4122). */
export const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** UUID v5 (name-based, RFC 4122). */
export const UUID_V5_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** UUID v1–v8 (canonical 8-4-4-4-12). */
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Name-based namespace for Republic public election ids (UUID v5).
 * Independent of the on-chain DOMAIN used for L1 certificationId.
 */
export const REPUBLIC_ELECTION_NAMESPACE = '7c3a1f10-9e2b-5c4d-8a71-0b9d4e6f2a11';

/**
 * Crockford-ish lowercase alphabet (no 0/o/1/i/l) so short links stay
 * url-safe and copy-paste friendly. 31^10 ≈ 8e14 codes.
 */
export const SHORT_CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const SHORT_CODE_LENGTH = 10;

export { certificationId, jurisdictionBytes32, publicIdHash };

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

function isZeroAddress(value) {
  if (!value) return true;
  const hex = String(value).replace(/^0x/i, '').toLowerCase();
  return hex.length === 0 || /^0+$/.test(hex);
}

/**
 * Canonical name hashed into the public UUID. On-chain contests bind to the
 * shared factory; demo Nodes bind to `nodeId` so two forks do not collide.
 */
export function scopedPublicIdName(scope = {}) {
  const electionId = String(scope.onChainElectionId ?? '').trim();
  const jurisdiction = jurisdictionBytes32(scope.jurisdictionId);
  const factory = String(scope.factoryAddress || '').trim().toLowerCase();
  const chainId =
    scope.chainId != null && String(scope.chainId) !== '' ? String(scope.chainId) : '0';
  if (factory && !isZeroAddress(factory)) {
    return `onchain:${chainId}:${factory}:${electionId}:${jurisdiction}`;
  }
  const nodeId = String(scope.nodeId || '').trim().toLowerCase();
  return `demo:${nodeId}:${jurisdiction}:${electionId}`;
}

export function mintScopedPublicId(scope = {}) {
  return uuidV5(REPUBLIC_ELECTION_NAMESPACE, scopedPublicIdName(scope));
}

export function publicIdMatchesScope(uuid, scope = {}) {
  if (!uuid) return false;
  if (uuidVersion(uuid) !== 5) {
    const factory = String(scope.factoryAddress || '').trim();
    if (factory && !isZeroAddress(factory)) return false;
    return true;
  }
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
  if (election.uuid) refs.add(String(election.uuid));
  if (election.code) refs.add(String(election.code));
  if (election.publicId) refs.add(String(election.publicId));
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
  const factory = election.factoryAddress || null;
  const onChainElectionId = election.onChainElectionId != null ? String(election.onChainElectionId) : null;
  const jurisdictionKey = election.jurisdictionId != null ? jurisdictionBytes32(election.jurisdictionId) : null;
  return {
    id,
    shortCode,
    onChainElectionId,
    publicIdScheme: election.publicIdScheme || (uuidVersion(id) === 5 ? 'uuid-v5-jurisdiction' : null),
    certificationId:
      onChainElectionId != null
        ? certificationId(factory, onChainElectionId, jurisdictionKey || election.jurisdictionId)
        : null,
    publicIdHash: publicIdHash(id),
    links: {
      vote: `/vote/${encodeURIComponent(id)}`,
      short: shortCode ? `/v/${encodeURIComponent(shortCode)}` : null,
      election: shortCode ? `/e/${encodeURIComponent(shortCode)}` : `/vote/${encodeURIComponent(id)}`,
    },
  };
}

export function l1IdentityOf(election, config = {}) {
  const fromElection = election?.factoryAddress;
  const fromConfig = config.electionFactoryAddress || config.factoryAddress;
  const factory =
    fromElection && !isZeroAddress(fromElection)
      ? fromElection
      : fromConfig && !isZeroAddress(fromConfig)
        ? fromConfig
        : fromElection || null;
  let electionId = null;
  if (election?.onChainElectionId != null && String(election.onChainElectionId) !== '') {
    electionId = String(election.onChainElectionId);
  } else if (election?.id != null && /^\d+$/.test(String(election.id))) {
    electionId = String(election.id);
  }
  const jurisdictionId = jurisdictionBytes32(election?.jurisdictionId);
  const publicId = election?.id != null ? String(election.id) : '';
  return {
    electionId,
    publicId,
    publicIdHash: publicId ? publicIdHash(publicId) : null,
    factory,
    pinnedFactory: config.electionFactoryAddress || null,
    electionAddress: election?.onChainElectionAddress || null,
    jurisdictionId,
    ballotSpecHash: election?.ballotSpecHash || null,
    certificationId: electionId != null ? certificationId(factory, electionId, jurisdictionId) : null,
    chainId: election?.chainId ?? config.chainId ?? null,
  };
}

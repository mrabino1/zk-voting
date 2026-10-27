// NOT FOR PROFIT — civic public good, not a commercial product.
// L2 identity, election keys, and L1 settlement digests.
//
// Every hash here is keccak256(abi.encode(...)) over static ABI words, so a
// Solidity contract computes the same value with abi.encode. The proposal in
// docs/proposals/L2-REGISTRY-AND-ELECTION-KEYS.md (repo root) uses the same
// domain tags and argument order.
//
//   l2Id        = keccak256(abi.encode(L2_ID_DOMAIN, operator, bytes16(l2Uuid), salt))
//   electionKey = keccak256(abi.encode(ELECTION_KEY_DOMAIN, l1ChainId, l2Id, bytes16(electionUuid)))
//   stateRoot'  = keccak256(abi.encode(STATE_DOMAIN, l2Id, prevStateRoot, publicDataHash))
//   dataHash    = keccak256(abi.encode(uint64 batchIndex, prevStateRoot, newStateRoot))
//                 (this one matches RollupSettlement.computeDataHash today)
//   batchDigest = keccak256(abi.encode(BATCH_DOMAIN, l1ChainId, registry, l2Id,
//                                      batchIndex, prevStateRoot, newStateRoot, dataHash))
//
// The operator address is inside the l2Id preimage. A squatter who copies an
// L2 UUID and salt from the mempool gets a different l2Id under their own key,
// so registering on L1 cannot be front-run.
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { keccak256Hex, ZERO_HASH } from './sequencer/state.mjs';

const enc = new TextEncoder();

/** keccak256 of an ASCII tag, as Solidity `keccak256("...")`. */
export function domainTag(text) {
  return keccak256Hex(enc.encode(String(text)));
}

export const L2_ID_DOMAIN = domainTag('zk-voting/l2-id/v1');
export const ELECTION_KEY_DOMAIN = domainTag('zk-voting/election-key/v1');
export const STATE_DOMAIN = domainTag('zk-voting/state-root/v1');
export const BATCH_DOMAIN = domainTag('zk-voting/vote-batch/v1');

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return UUID_RE.test(String(value ?? ''));
}

export function mintUuid() {
  return randomUUID();
}

/** 32 random bytes as 0x-hex. Keep it secret until the L2 is registered on L1. */
export function mintSalt() {
  return '0x' + randomBytes(32).toString('hex');
}

/** 32 random bytes for L2_ADMIN_SECRET (Node -> sequencer admin writes). */
export function mintAdminSecret() {
  return randomBytes(32).toString('hex');
}

export function uuidToBytes16(uuid) {
  if (!isUuid(uuid)) throw new Error(`not a UUID: ${uuid}`);
  return '0x' + String(uuid).replace(/-/g, '').toLowerCase();
}

function strip0x(h) {
  return String(h).replace(/^0x/i, '');
}

function assertHex(value, bytes, label) {
  const body = strip0x(value);
  if (!/^[0-9a-f]*$/i.test(body) || body.length !== bytes * 2) {
    throw new Error(`${label} must be ${bytes} bytes of hex`);
  }
  return body.toLowerCase();
}

/** ABI static words. Each returns 64 hex chars. */
export const word = {
  bytes32(v, label = 'bytes32') {
    return assertHex(v, 32, label);
  },
  /** bytesN (N < 32) is left-aligned, zero padded on the right. */
  bytes16(v, label = 'bytes16') {
    return assertHex(v, 16, label).padEnd(64, '0');
  },
  address(v, label = 'address') {
    return assertHex(v, 20, label).padStart(64, '0');
  },
  uint(v, label = 'uint') {
    const n = BigInt(v);
    if (n < 0n || n >= 1n << 256n) throw new Error(`${label} out of range`);
    return n.toString(16).padStart(64, '0');
  },
};

export function abiEncodeWords(words) {
  return '0x' + words.join('');
}

function keccakWords(words) {
  return keccak256Hex(Buffer.from(words.join(''), 'hex'));
}

export function computeL2Id({ operator, l2Uuid, salt }) {
  return keccakWords([
    word.bytes32(L2_ID_DOMAIN),
    word.address(operator, 'operator'),
    word.bytes16(uuidToBytes16(l2Uuid), 'l2Uuid'),
    word.bytes32(salt, 'salt'),
  ]);
}

export function computeElectionKey({ l1ChainId, l2Id, electionUuid }) {
  return keccakWords([
    word.bytes32(ELECTION_KEY_DOMAIN),
    word.uint(l1ChainId ?? 0, 'l1ChainId'),
    word.bytes32(l2Id, 'l2Id'),
    word.bytes16(uuidToBytes16(electionUuid), 'electionUuid'),
  ]);
}

/** Chained settlement root: each batch commits to the one before it. */
export function computeSettlementStateRoot({ l2Id, prevStateRoot, publicDataHash }) {
  return keccakWords([
    word.bytes32(STATE_DOMAIN),
    word.bytes32(l2Id || ZERO_HASH, 'l2Id'),
    word.bytes32(prevStateRoot || ZERO_HASH, 'prevStateRoot'),
    word.bytes32(publicDataHash, 'publicDataHash'),
  ]);
}

/** Same value as RollupSettlement.computeDataHash(batchIndex, prev, new). */
export function computeSettlementDataHash({ batchIndex, prevStateRoot, newStateRoot }) {
  return keccakWords([
    word.uint(batchIndex, 'batchIndex'),
    word.bytes32(prevStateRoot, 'prevStateRoot'),
    word.bytes32(newStateRoot, 'newStateRoot'),
  ]);
}

export function computeBatchDigest({
  l1ChainId,
  registry,
  l2Id,
  batchIndex,
  prevStateRoot,
  newStateRoot,
  dataHash,
}) {
  return keccakWords([
    word.bytes32(BATCH_DOMAIN),
    word.uint(l1ChainId ?? 0, 'l1ChainId'),
    word.address(registry || '0x' + '00'.repeat(20), 'registry'),
    word.bytes32(l2Id, 'l2Id'),
    word.uint(batchIndex, 'batchIndex'),
    word.bytes32(prevStateRoot, 'prevStateRoot'),
    word.bytes32(newStateRoot, 'newStateRoot'),
    word.bytes32(dataHash, 'dataHash'),
  ]);
}

function cleanAddress(value) {
  const s = String(value || '').trim();
  return /^0x[0-9a-fA-F]{40}$/.test(s) ? s.toLowerCase() : '';
}

function cleanBytes32(value) {
  const s = String(value || '').trim();
  return /^0x[0-9a-fA-F]{64}$/.test(s) ? s.toLowerCase() : '';
}

/**
 * Resolve this L2's identity from env-style values. Never returns the salt.
 * `operator` is the L1 submitter address (derive it from
 * L1_SUBMITTER_PRIVATE_KEY with viem, or set L2_OPERATOR_ADDRESS).
 */
export function resolveIdentity(src = process.env, { operator: operatorOverride } = {}) {
  const l2Uuid = String(src.L2_UUID || '').trim().toLowerCase();
  const saltRaw = String(src.L2_SALT || '').trim();
  const operator = cleanAddress(operatorOverride || src.L2_OPERATOR_ADDRESS);
  const pinned = cleanBytes32(src.L2_ID);
  const l1ChainId = String(src.L1_CHAIN_ID || '').trim();
  const problems = [];
  if (!l2Uuid) problems.push('L2_UUID is not set');
  else if (!isUuid(l2Uuid)) problems.push('L2_UUID is not a UUID');
  const salt = cleanBytes32(saltRaw);
  if (saltRaw && !salt) problems.push('L2_SALT must be 32 bytes of 0x-hex');
  let computed = '';
  if (isUuid(l2Uuid) && salt && operator) {
    computed = computeL2Id({ operator, l2Uuid, salt });
  }
  if (pinned && computed && pinned !== computed) {
    problems.push('L2_ID does not match keccak(operator, L2_UUID, L2_SALT)');
  }
  const l2Id = pinned || computed || '';
  if (!l2Id) problems.push('L2_ID unknown: set L2_ID, or L2_UUID + L2_SALT + the submitter key');
  return {
    l2Uuid: isUuid(l2Uuid) ? l2Uuid : '',
    l2Id,
    operator,
    l1ChainId,
    saltSet: Boolean(salt),
    registryAddress: cleanAddress(src.L2_REGISTRY_ADDRESS),
    configured: Boolean(l2Id) && problems.length === 0,
    problems,
  };
}

/**
 * import() a package that may live outside the module tree. ESM ignores
 * NODE_PATH, and l2/Dockerfile installs viem under /opt/deps (NODE_PATH), so
 * fall back to CommonJS resolution, which does honour NODE_PATH.
 */
export async function importOptional(specifier) {
  try {
    return await import(specifier);
  } catch (first) {
    try {
      const require = createRequire(import.meta.url);
      return await import(pathToFileURL(require.resolve(specifier)).href);
    } catch {
      throw first;
    }
  }
}

/**
 * The L1 submitter address. Prefers L2_OPERATOR_ADDRESS; otherwise derives it
 * from L1_SUBMITTER_PRIVATE_KEY (or legacy PRIVATE_KEY) with viem. The key is
 * never logged or returned.
 */
export async function resolveOperatorAddress(src = process.env) {
  const explicit = cleanAddress(src.L2_OPERATOR_ADDRESS);
  if (explicit) return explicit;
  const raw = String(src.L1_SUBMITTER_PRIVATE_KEY || src.PRIVATE_KEY || '').trim();
  if (!raw) return '';
  try {
    const { privateKeyToAccount } = await importOptional('viem/accounts');
    const pk = raw.startsWith('0x') ? raw : `0x${raw}`;
    return privateKeyToAccount(pk).address.toLowerCase();
  } catch {
    return '';
  }
}

export async function resolveIdentityAsync(src = process.env) {
  const operator = await resolveOperatorAddress(src);
  return resolveIdentity(src, { operator });
}

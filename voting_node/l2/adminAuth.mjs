// NOT FOR PROFIT — civic public good, not a commercial product.
// Operator authentication for civic admin writes on a gasless L2.
//
// The L2 charges no gas, so the only thing that stops a stranger from
// opening elections or registering voters on someone else's L2 is a secret
// the operator holds. The Node app and the sequencer share L2_ADMIN_SECRET
// (both run under the same operator). Admin txs carry
//   auth = { v: 1, mac: HMAC-SHA256(secret, message) }
// where message binds the L2 chain id, the L2 UUID, and the canonical tx body.
// Exact replays hash to the same tx hash and are dropped as already known;
// election_open and register are also unique by election / commitment.
//
// No external imports: state.mjs depends on this file.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const ADMIN_AUTH_DOMAIN = 'zk-voting/l2-admin/v1';

/** Civic types that only the L2 operator may write. */
export const ADMIN_TX_TYPES = Object.freeze([
  'election_open',
  'register',
  'disqualify',
  'tally',
  'party_add',
  'party_reject',
  'party_attest',
  'poll_params',
  'poll_tally',
]);

export function isAdminTxType(type) {
  return ADMIN_TX_TYPES.includes(String(type || '').toLowerCase());
}

/** Sorted-key JSON, the same shape on both ends. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

export function adminAuthMessage({ chainId, l2Uuid, civic }) {
  const body = { ...(civic || {}) };
  delete body.auth;
  return [ADMIN_AUTH_DOMAIN, String(chainId ?? ''), String(l2Uuid || '').toLowerCase(), canonicalJson(body)].join(
    '\n',
  );
}

export function signAdminCivic(civic, { secret, chainId, l2Uuid }) {
  if (!secret) throw new Error('L2_ADMIN_SECRET is required to sign admin txs');
  const mac = createHmac('sha256', String(secret))
    .update(adminAuthMessage({ chainId, l2Uuid, civic }))
    .digest('hex');
  return { ...civic, auth: { v: 1, mac } };
}

export function verifyAdminCivic(civic, { secret, chainId, l2Uuid }) {
  if (!secret) return { ok: false, reason: 'L2_ADMIN_SECRET is not set on this sequencer; admin writes are disabled' };
  const mac = civic?.auth?.mac;
  if (typeof mac !== 'string' || !/^[0-9a-f]{64}$/i.test(mac)) {
    return { ok: false, reason: 'admin tx is missing operator auth' };
  }
  const want = createHmac('sha256', String(secret))
    .update(adminAuthMessage({ chainId, l2Uuid, civic }))
    .digest();
  const got = Buffer.from(mac, 'hex');
  if (got.length !== want.length || !timingSafeEqual(got, want)) {
    return { ok: false, reason: 'admin tx auth does not verify for this L2' };
  }
  return { ok: true };
}

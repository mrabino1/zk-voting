// NOT FOR PROFIT — civic public good, not a commercial product.
// Per-key IPv4 allowlists and process-local rate limits.

import { SuperAdminKeyError } from './keys.mjs';

export function normalizeIp(value) {
  let ip = String(value || '').trim().toLowerCase();
  if (ip.startsWith('::ffff:')) ip = ip.slice('::ffff:'.length);
  if (ip === '::1') return '127.0.0.1';
  return ip;
}

function ipv4ToInt(ip) {
  const parts = String(ip || '').split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    n = (n << 8) | octet;
  }
  return n >>> 0;
}

export function normalizeCidr(value) {
  const raw = String(value || '').trim();
  const [base, bitsRaw] = raw.split('/');
  const ip = normalizeIp(base);
  const addr = ipv4ToInt(ip);
  if (addr == null) throw new SuperAdminKeyError('IP_ALLOWLIST', 'allowlist entries must be IPv4 or IPv4 CIDR');
  const bits = bitsRaw == null || bitsRaw === '' ? 32 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) {
    throw new SuperAdminKeyError('IP_ALLOWLIST', 'CIDR prefix must be 0-32');
  }
  return bits === 32 ? `${ip}/32` : `${ip}/${bits}`;
}

export function normalizeAllowlist(input) {
  if (input == null) return [];
  if (!Array.isArray(input)) throw new SuperAdminKeyError('IP_ALLOWLIST', 'ipAllowlist must be an array');
  const out = [];
  for (const item of input) {
    const cidr = normalizeCidr(item);
    if (!out.includes(cidr)) out.push(cidr);
  }
  if (out.length > 32) throw new SuperAdminKeyError('IP_ALLOWLIST', 'too many allowlist entries');
  return out;
}

export function ipAllowed(ip, allowlist) {
  if (!allowlist || allowlist.length === 0) return true;
  const addr = ipv4ToInt(normalizeIp(ip));
  if (addr == null) return false;
  for (const cidr of allowlist) {
    const [base, bitsRaw] = String(cidr).split('/');
    const net = ipv4ToInt(normalizeIp(base));
    const bits = Number(bitsRaw);
    if (net == null || !Number.isInteger(bits)) continue;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    if ((addr & mask) === (net & mask)) return true;
  }
  return false;
}

export function maskIp(ip) {
  const v4 = normalizeIp(ip);
  const addr = ipv4ToInt(v4);
  if (addr == null) return 'x';
  const parts = v4.split('.');
  return `${parts[0]}.${parts[1]}.${parts[2]}.x`;
}

export function normalizeRateLimit(input) {
  if (input == null || input === false) return null;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new SuperAdminKeyError('RATE_LIMIT', 'rateLimit must be an object');
  }
  const limit = Number(input.limit);
  const windowSeconds = Number(input.windowSeconds);
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
    throw new SuperAdminKeyError('RATE_LIMIT', 'rateLimit.limit must be an integer from 1 to 10000');
  }
  if (!Number.isInteger(windowSeconds) || windowSeconds < 1 || windowSeconds > 86_400) {
    throw new SuperAdminKeyError('RATE_LIMIT', 'rateLimit.windowSeconds must be an integer from 1 to 86400');
  }
  return { limit, windowSeconds };
}

const buckets = new Map();

export function resetRateLimits() {
  buckets.clear();
}

export function consumeRateLimit(keyId, rule, nowMs = Date.now()) {
  if (!rule) return { ok: true };
  const windowMs = rule.windowSeconds * 1000;
  let bucket = buckets.get(keyId);
  if (!bucket || nowMs - bucket.start >= windowMs) {
    bucket = { start: nowMs, count: 0 };
    buckets.set(keyId, bucket);
  }
  bucket.count += 1;
  if (bucket.count > rule.limit) {
    const retryAfter = Math.max(1, Math.ceil((bucket.start + windowMs - nowMs) / 1000));
    return { ok: false, retryAfter };
  }
  return { ok: true };
}

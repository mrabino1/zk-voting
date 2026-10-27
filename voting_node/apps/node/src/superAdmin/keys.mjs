// NOT FOR PROFIT — civic public good, not a commercial product.
// Platform super-admin API keys. The secret is 256 bits, shown once, and
// stored only as SHA-256 or HMAC-SHA-256 when SUPER_ADMIN_API_PEPPER is set.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const KEY_PREFIX = 'zksa_';
export const EXPIRATION_PRESETS = Object.freeze(['1h', '24h', '7d', '30d', '90d', 'never']);
export const DEFAULT_EXPIRATION = '30d';

const PRESET_MS = Object.freeze({
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
});

const TOKEN_RE = /^zksa_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;

export function hashSuperAdminSecret(secret, pepper = '') {
  const material = String(secret || '');
  const key = String(pepper || '');
  if (key) return createHmac('sha256', key).update(material).digest('hex');
  return createHash('sha256').update(material).digest('hex');
}

export function hashAlgForPepper(pepper = '') {
  return String(pepper || '') ? 'hmac-sha256' : 'sha256';
}

export function secretsEqual(stored, computed) {
  const a = Buffer.from(String(stored || ''), 'utf8');
  const b = Buffer.from(String(computed || ''), 'utf8');
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function parseSuperAdminToken(value) {
  const match = TOKEN_RE.exec(String(value || '').trim());
  if (!match) return null;
  return { keyId: match[1], secret: match[2], token: match[0] };
}

export function mintSuperAdminSecret(pepper = '') {
  const keyId = randomBytes(8).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  const token = `${KEY_PREFIX}${keyId}_${secret}`;
  return {
    keyId,
    secret,
    token,
    secretHash: hashSuperAdminSecret(secret, pepper),
    hashAlg: hashAlgForPepper(pepper),
  };
}

export class SuperAdminKeyError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} [status]
   */
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'SuperAdminKeyError';
    this.code = code;
    this.status = status;
  }
}

export function normalizeKeyName(value) {
  const name = String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .slice(0, 80);
  if (!name) throw new SuperAdminKeyError('NAME', 'name required');
  return name;
}

/**
 * @param {{ expiresIn?: unknown, expiresAt?: unknown, allowNeverExpires?: unknown, nowMs?: number }} input
 * @returns {{ expiresIn: string, expiresAt: string | null }}
 */
export function resolveKeyExpiry(input = {}) {
  const nowMs = Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
  const hasIn = input.expiresIn != null && String(input.expiresIn).trim() !== '';
  const hasAt = input.expiresAt != null && String(input.expiresAt).trim() !== '';
  if (!hasIn && !hasAt) {
    return {
      expiresIn: DEFAULT_EXPIRATION,
      expiresAt: new Date(nowMs + PRESET_MS[DEFAULT_EXPIRATION]).toISOString(),
    };
  }
  if (hasIn) {
    const expiresIn = String(input.expiresIn).trim().toLowerCase();
    if (!EXPIRATION_PRESETS.includes(expiresIn)) {
      throw new SuperAdminKeyError('EXPIRY', 'expiresIn must be 1h, 24h, 7d, 30d, 90d, or never');
    }
    if (expiresIn === 'never') {
      if (input.allowNeverExpires !== true) {
        throw new SuperAdminKeyError('EXPIRY', 'never requires allowNeverExpires: true');
      }
      return { expiresIn: 'never', expiresAt: null };
    }
    return {
      expiresIn,
      expiresAt: new Date(nowMs + PRESET_MS[expiresIn]).toISOString(),
    };
  }
  const parsed = Date.parse(String(input.expiresAt));
  if (!Number.isFinite(parsed)) {
    throw new SuperAdminKeyError('EXPIRY', 'expiresAt must be an ISO date');
  }
  if (parsed <= nowMs) {
    throw new SuperAdminKeyError('EXPIRY', 'expiresAt must be in the future');
  }
  const max = nowMs + 10 * 365 * 24 * 60 * 60 * 1000;
  if (parsed > max) {
    throw new SuperAdminKeyError('EXPIRY', 'expiresAt is too far in the future');
  }
  return { expiresIn: 'iso', expiresAt: new Date(parsed).toISOString() };
}

export function keyStatus(row, nowMs = Date.now()) {
  if (!row) return 'missing';
  if (row.revokedAt) return 'revoked';
  if (row.expiresAt && Date.parse(row.expiresAt) <= nowMs) return 'expired';
  return 'active';
}

export function publicSuperAdminKey(row, nowMs = Date.now()) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    scopes: Array.isArray(row.scopes) ? row.scopes.slice() : [],
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    expiresIn: row.expiresIn,
    lastUsedAt: row.lastUsedAt || null,
    lastUsedIp: row.lastUsedIpMasked || null,
    status: keyStatus(row, nowMs),
    ipAllowlist: Array.isArray(row.ipAllowlist) ? row.ipAllowlist.slice() : [],
    rateLimit: row.rateLimit || null,
    hashAlg: row.hashAlg || 'sha256',
    rotatedFrom: row.rotatedFrom || null,
  };
}

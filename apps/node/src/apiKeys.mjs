// NOT FOR PROFIT — civic public good, not a commercial product.
// Personal API keys for external bots. The secret is shown once and stored
// only as a SHA-256 hash. A key never outranks the account that minted it.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { HttpError } from './http.mjs';

export const API_KEY_LEVELS = Object.freeze(['read', 'voter', 'officer']);

export const API_KEY_LEVEL_RANK = Object.freeze({
  read: 1,
  voter: 2,
  officer: 3,
});

export const API_KEY_EXPIRATIONS = Object.freeze(['7d', '30d', '90d', '180d', '365d', 'never']);

export const API_KEY_DEFAULT_EXPIRATION = '30d';

export const API_KEY_DEFAULT_LEVEL = 'read';

export const API_KEY_LIMIT = 25;

const EXPIRATION_DAYS = Object.freeze({
  '7d': 7,
  '30d': 30,
  '90d': 90,
  '180d': 180,
  '365d': 365,
});

const LEVEL_LABELS = Object.freeze({
  read: 'Read-only',
  voter: 'Voter',
  officer: 'Officer',
});

export function apiKeyLevelLabel(level) {
  return LEVEL_LABELS[level] || level;
}

export function apiKeyLevelAllows(level, minimum) {
  const have = API_KEY_LEVEL_RANK[level] || 0;
  const need = API_KEY_LEVEL_RANK[minimum] || 0;
  return have >= need;
}

export function isApiKeySecret(value) {
  return /^rk_[A-Za-z0-9_-]{40,}$/.test(String(value || '').trim());
}

export function hashApiKey(secret) {
  return createHash('sha256').update(String(secret), 'utf8').digest('hex');
}

export function apiKeyHashesEqual(stored, computed) {
  if (!stored || !computed) return false;
  const a = Buffer.from(String(stored), 'utf8');
  const b = Buffer.from(String(computed), 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function mintApiKeySecret() {
  const secret = `rk_${randomBytes(32).toString('base64url')}`;
  return {
    secret,
    prefix: secret.slice(0, 12),
    secretHash: hashApiKey(secret),
  };
}

export function normalizeApiKeyName(value) {
  const name = String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .slice(0, 80);
  if (!name) throw new HttpError(400, 'name required', { code: 'API_KEY_NAME' });
  return name;
}

export function normalizeApiKeyLevel(value) {
  const level = String(value || API_KEY_DEFAULT_LEVEL).trim().toLowerCase();
  if (!API_KEY_LEVELS.includes(level)) {
    throw new HttpError(400, 'level must be read, voter, or officer', {
      code: 'API_KEY_LEVEL',
      levels: [...API_KEY_LEVELS],
    });
  }
  return level;
}

export function normalizeApiKeyExpiration(value) {
  const expiresIn = String(value || API_KEY_DEFAULT_EXPIRATION).trim().toLowerCase();
  if (!API_KEY_EXPIRATIONS.includes(expiresIn)) {
    throw new HttpError(400, 'expiresIn must be 7d, 30d, 90d, 180d, 365d, or never', {
      code: 'API_KEY_EXPIRATION',
      expirations: [...API_KEY_EXPIRATIONS],
      defaultExpiration: API_KEY_DEFAULT_EXPIRATION,
    });
  }
  return expiresIn;
}

export function apiKeyExpiresAt(expiresIn, nowMs) {
  if (expiresIn === 'never') return null;
  const days = EXPIRATION_DAYS[expiresIn];
  if (!days) throw new HttpError(400, 'invalid expiration', { code: 'API_KEY_EXPIRATION' });
  return new Date(nowMs + days * 24 * 60 * 60 * 1000).toISOString();
}

export function publicApiKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    level: row.level,
    levelLabel: apiKeyLevelLabel(row.level),
    expiresIn: row.expiresIn,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    lastUsedAt: row.lastUsedAt,
    expired: Boolean(row.expiresAt && Date.parse(row.expiresAt) <= Date.now()),
    revoked: Boolean(row.revokedAt),
  };
}

export function formatApiKeyExpiry(row) {
  if (!row?.expiresAt || row.expiresIn === 'never') return 'never';
  return `${row.expiresIn} (until ${row.expiresAt} UTC)`;
}

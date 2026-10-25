// NOT FOR PROFIT — civic public good, not a commercial product.
// Smart cards and driver’s licenses / passports: many per person, revocable.
// Civil officers review by hand today. A later third-party (DMV / AAMVA / eID)
// connector can POST the same status without changing the Person model.

import { HttpError } from './http.mjs';

export const MAX_SMART_CARDS_PER_PERSON = 5;
export const MAX_CIVIC_IDS_PER_PERSON = 5;

export const CREDENTIAL_METHOD_TYPES = Object.freeze(['smart_card', 'civic_id']);

export const CREDENTIAL_STATUSES = Object.freeze([
  'active',
  'pending_review',
  'revoked',
  'expired',
]);

export const CREDENTIAL_REVOKE_REASONS = Object.freeze([
  'EXPIRED',
  'SUSPENDED',
  'SUPERSEDED',
  'FRAUD',
  'MANUAL',
  'PROVIDER',
  'OTHER',
]);

export const MANUAL_CREDENTIAL_PROVIDER = Object.freeze({
  id: 'manual',
  mode: 'manual',
  name: 'Civil registrar (manual)',
  webhookPath: '/api/integrations/credentials/status',
  note:
    'Automated DMV / AAMVA / national-eID lookup is Future. Until a provider is configured, clerks and registrars inspect each smart card and driver’s license and revoke by hand when the civil registration has expired.',
});

export function isCredentialMethodType(type) {
  return CREDENTIAL_METHOD_TYPES.includes(String(type || ''));
}

export function isCredentialStatus(status) {
  return CREDENTIAL_STATUSES.includes(String(status || ''));
}

export function credentialProviderPublic(config = {}) {
  const secretSet = Boolean(String(config.credentialProviderSecret || '').trim());
  return {
    ...MANUAL_CREDENTIAL_PROVIDER,
    id: String(config.credentialProviderId || MANUAL_CREDENTIAL_PROVIDER.id),
    mode: secretSet ? 'manual+webhook' : 'manual',
    webhookEnabled: secretSet,
  };
}

export function parseExpiresAt(value) {
  if (value == null || value === '') return null;
  const raw = String(value).trim();
  if (!raw) return null;
  let ms;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    ms = Date.parse(`${raw}T23:59:59.000Z`);
  } else {
    ms = Date.parse(raw);
  }
  if (!Number.isFinite(ms)) throw new HttpError(400, 'invalid expiresAt');
  return new Date(ms).toISOString();
}

export function ensureCredentialFields(method) {
  if (!method || !isCredentialMethodType(method.type)) return method;
  if (!method.status || !isCredentialStatus(method.status)) method.status = 'active';
  if (!Object.prototype.hasOwnProperty.call(method, 'expiresAt')) method.expiresAt = null;
  if (!Object.prototype.hasOwnProperty.call(method, 'claimedExpiresAt')) {
    method.claimedExpiresAt = null;
  }
  if (!Object.prototype.hasOwnProperty.call(method, 'revokedAt')) method.revokedAt = null;
  if (!Object.prototype.hasOwnProperty.call(method, 'revokedBy')) method.revokedBy = null;
  if (!Object.prototype.hasOwnProperty.call(method, 'revokeReason')) method.revokeReason = null;
  if (!method.provider) method.provider = MANUAL_CREDENTIAL_PROVIDER.id;
  if (!Object.prototype.hasOwnProperty.call(method, 'providerRef')) method.providerRef = null;
  if (!Object.prototype.hasOwnProperty.call(method, 'lastCheckedAt')) method.lastCheckedAt = null;
  if (!Object.prototype.hasOwnProperty.call(method, 'lastCheckedBy')) method.lastCheckedBy = null;
  return method;
}

export function credentialLifecycleStatus(method, now = new Date()) {
  if (!method || !isCredentialMethodType(method.type)) return null;
  ensureCredentialFields(method);
  if (method.status === 'revoked') return 'revoked';
  if (method.status === 'pending_review') return 'pending_review';
  const exp = method.expiresAt ? Date.parse(method.expiresAt) : NaN;
  if (Number.isFinite(exp) && exp <= now.getTime()) return 'expired';
  if (method.status === 'expired') return 'expired';
  return 'active';
}

export function isCredentialUsable(method, now = new Date()) {
  return credentialLifecycleStatus(method, now) === 'active';
}

export function assertCredentialUsable(method, { kind } = {}) {
  const status = credentialLifecycleStatus(method);
  if (status === 'active') return method;
  const label = kind || (method?.type === 'civic_id' ? 'driver’s license or passport' : 'smart card');
  if (status === 'expired') {
    throw new HttpError(403, `${label} registration has expired`, {
      code: 'CREDENTIAL_EXPIRED',
      status,
    });
  }
  if (status === 'revoked') {
    throw new HttpError(403, `${label} has been revoked`, {
      code: 'CREDENTIAL_REVOKED',
      status,
    });
  }
  throw new HttpError(403, `${label} is not active`, {
    code: 'CREDENTIAL_INACTIVE',
    status,
  });
}

export function liveCredentialCount(user, type) {
  if (!user || !Array.isArray(user.authMethods)) return 0;
  return user.authMethods.filter((method) => {
    if (method.type !== type) return false;
    const status = credentialLifecycleStatus(method);
    return status === 'active' || status === 'pending_review';
  }).length;
}

export function assertSmartCardRoom(user) {
  if (!user) return;
  const count = liveCredentialCount(user, 'smart_card');
  if (count >= MAX_SMART_CARDS_PER_PERSON) {
    throw new HttpError(
      409,
      `A person may bind at most ${MAX_SMART_CARDS_PER_PERSON} smart cards`,
      {
        code: 'SMART_CARD_CAP',
        limit: MAX_SMART_CARDS_PER_PERSON,
        count,
      },
    );
  }
}

export function assertCivicIdRoom(user) {
  if (!user) return;
  const count = liveCredentialCount(user, 'civic_id');
  if (count >= MAX_CIVIC_IDS_PER_PERSON) {
    throw new HttpError(
      409,
      `A person may bind at most ${MAX_CIVIC_IDS_PER_PERSON} driver’s licenses or passports`,
      {
        code: 'CIVIC_ID_CAP',
        limit: MAX_CIVIC_IDS_PER_PERSON,
        count,
      },
    );
  }
}

export function publicCredential(method, { owner = false, officer = false } = {}) {
  if (!method || !isCredentialMethodType(method.type)) return null;
  ensureCredentialFields(method);
  const status = credentialLifecycleStatus(method);
  const out = {
    id: method.id,
    type: method.type,
    kind: method.kind || null,
    issuer: method.issuer || null,
    subject: method.subject || null,
    label: method.label || null,
    status,
    storedStatus: method.status,
    expiresAt: method.expiresAt || null,
    verified: Boolean(method.verified),
    verifiedBy: method.verifiedBy || null,
    verifiedAt: method.verifiedAt || null,
    provider: method.provider || MANUAL_CREDENTIAL_PROVIDER.id,
    lastCheckedAt: method.lastCheckedAt || null,
    revokedAt: method.revokedAt || null,
    revokeReason: method.revokeReason || null,
  };
  if (owner || officer) {
    if (method.type === 'smart_card') out.fingerprint = method.fingerprint || null;
    if (method.type === 'civic_id') out.civicIdHash = method.civicIdHash || method.fingerprint || null;
    out.claimedExpiresAt = method.claimedExpiresAt || null;
    out.providerRef = method.providerRef || null;
  }
  return out;
}

export function normalizeRevokeReason(value) {
  const raw = String(value || 'MANUAL')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_');
  if (!raw) return 'MANUAL';
  if (CREDENTIAL_REVOKE_REASONS.includes(raw)) return raw;
  return 'OTHER';
}

export function applyCredentialReview(method, patch, actor) {
  ensureCredentialFields(method);
  const now = new Date().toISOString();
  if (patch.expiresAt !== undefined) {
    method.expiresAt = parseExpiresAt(patch.expiresAt);
  }
  if (patch.claimedExpiresAt !== undefined) {
    method.claimedExpiresAt = parseExpiresAt(patch.claimedExpiresAt);
  }
  if (patch.providerRef !== undefined) {
    method.providerRef = patch.providerRef ? String(patch.providerRef) : null;
  }
  if (patch.provider) method.provider = String(patch.provider);
  const nextStatus = patch.status ? String(patch.status) : null;
  if (nextStatus && !isCredentialStatus(nextStatus)) {
    throw new HttpError(400, 'invalid credential status');
  }
  if (nextStatus === 'revoked') {
    method.status = 'revoked';
    method.revokedAt = now;
    method.revokedBy = actor?.id || actor?.handle || 'officer';
    method.revokeReason = normalizeRevokeReason(patch.reason || patch.revokeReason);
  } else if (nextStatus === 'expired') {
    method.status = 'expired';
    if (!method.expiresAt) method.expiresAt = now;
  } else if (nextStatus === 'active' || nextStatus === 'pending_review') {
    method.status = nextStatus;
    if (nextStatus === 'active') {
      method.revokedAt = null;
      method.revokedBy = null;
      method.revokeReason = null;
    }
  }
  method.lastCheckedAt = now;
  method.lastCheckedBy = actor?.id || actor?.handle || method.lastCheckedBy;
  if (patch.verifiedBy) method.verifiedBy = String(patch.verifiedBy);
  return method;
}

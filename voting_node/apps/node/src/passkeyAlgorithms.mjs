// NOT FOR PROFIT — civic public good, not a commercial product.
// COSE algorithm ids offered at passkey registration, and the store backfill
// that records the algorithm next to an existing credential.

import { COSEALG, isoCBOR } from '@simplewebauthn/server/helpers';

/** ES256. Used only when a stored credential has no readable COSE algorithm. */
export const ES256_COSE_ALG = COSEALG.ES256;

/**
 * Most preferred first. ML-DSA-44 (-48) and ML-DSA-65 (-49), then the
 * algorithms current devices already use: ES256 (-7), Ed25519 (-8), RS256 (-257).
 */
export const PASSKEY_SUPPORTED_ALGORITHM_IDS = Object.freeze([
  COSEALG.ML_DSA_44,
  COSEALG.ML_DSA_65,
  COSEALG.ES256,
  COSEALG.EdDSA,
  COSEALG.RS256,
]);

/** JSON store `meta.version` once credential algorithms have been filled in. */
export const PASSKEY_SCHEMA_VERSION = 10;

/**
 * Algorithm number inside a COSE public key, or null when the bytes are not a
 * COSE key we can read. Does not guess.
 * @param {Uint8Array | string | null | undefined} publicKey
 * @returns {number | null}
 */
export function coseAlgFromPublicKey(publicKey) {
  if (publicKey == null || publicKey === '') return null;
  try {
    const bytes =
      typeof publicKey === 'string' ? Buffer.from(publicKey, 'base64url') : Buffer.from(publicKey);
    if (bytes.length < 2) return null;
    const decoded = isoCBOR.decodeFirst(bytes);
    const alg = decoded instanceof Map ? decoded.get(3) : decoded?.[3];
    return Number.isInteger(alg) ? alg : null;
  } catch {
    return null;
  }
}

/**
 * Record `coseAlg` on one credential.
 * A credential that already has an integer `coseAlg` and was not filled by
 * migration is left alone. A migration fill (`coseAlgBackfilled`) is corrected
 * when the COSE key itself names an algorithm, and otherwise stays ES256.
 * @param {object} credential
 */
export function stampCredentialAlg(credential) {
  if (!credential || typeof credential !== 'object') return credential;
  const backfilled = credential.coseAlgBackfilled === true;
  const hasAlg = Number.isInteger(credential.coseAlg);
  const decoded = coseAlgFromPublicKey(credential.publicKey);
  if (hasAlg && !backfilled) return credential;
  if (hasAlg && backfilled) {
    if (decoded != null) credential.coseAlg = decoded;
    return credential;
  }
  credential.coseAlg = decoded == null ? ES256_COSE_ALG : decoded;
  credential.coseAlgBackfilled = true;
  return credential;
}

/** Fill missing credential algorithms. Idempotent. */
export function migratePasskeyCoseAlgs(data) {
  if (!data || typeof data !== 'object') return data;
  for (const user of data.users || []) {
    if (!user || !Array.isArray(user.credentials)) continue;
    for (const cred of user.credentials) stampCredentialAlg(cred);
  }
  data.meta = data.meta || {};
  data.meta.version = Math.max(Number(data.meta.version || 0), PASSKEY_SCHEMA_VERSION);
  return data;
}

/**
 * Undo a migration fill. Credentials that stored `coseAlg` at registration
 * (no `coseAlgBackfilled` flag) are kept. Idempotent.
 */
export function rollbackPasskeyCoseAlgs(data) {
  if (!data || typeof data !== 'object') return data;
  for (const user of data.users || []) {
    if (!user || !Array.isArray(user.credentials)) continue;
    for (const cred of user.credentials) {
      if (!cred || cred.coseAlgBackfilled !== true) continue;
      delete cred.coseAlg;
      delete cred.coseAlgBackfilled;
    }
  }
  if (data.meta && Number(data.meta.version) === PASSKEY_SCHEMA_VERSION) {
    data.meta.version = PASSKEY_SCHEMA_VERSION - 1;
  }
  return data;
}

/**
 * Library failure when this process cannot verify ML-DSA. Returns null for
 * every other error so callers keep the original message.
 * @param {unknown} err
 * @param {string} action
 * @returns {string | null}
 */
export function passkeyPqcError(err, action) {
  const message = err && typeof err === 'object' && 'message' in err ? String(err.message || '') : String(err || '');
  const code = err && typeof err === 'object' && 'code' in err ? err.code : '';
  const missing =
    code === 'RUNTIME_NO_PQC_SUPPORT' || /WebCrypto\.subtle does not support use of ML-DSA/.test(message);
  if (!missing) return null;
  return (
    `${action}: ${message}. ` +
    'Verifying ML-DSA-44 (-48) and ML-DSA-65 (-49) requires the WebCrypto algorithms ' +
    `ML-DSA-44 and ML-DSA-65, which Node.js provides from 24.7.0. This process is Node.js ${process.version}. ` +
    'No substitute verifier is used.'
  );
}

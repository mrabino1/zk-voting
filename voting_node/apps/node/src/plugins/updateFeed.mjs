// NOT FOR PROFIT — civic public good, not a commercial product.
// Plugin update feeds. A plugin opts in with `updateUrl` in plugin.json.
// The feed is JSON the operator's source publishes. Nothing here names a host.

import { createPublicKey, verify } from 'node:crypto';

import { assertPluginHttpUrl, ManifestError, parseSemver, sha256Hex } from './manifest.mjs';

export const UPDATE_FEED_MAX_BYTES = 64 * 1024;
export const UPDATE_FEED_TIMEOUT_MS = 15_000;
export const UPDATE_PACKAGE_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 3;

export class UpdateFeedError extends Error {
  constructor(message, code = 'UPDATE_FEED_INVALID') {
    super(message);
    this.name = 'UpdateFeedError';
    this.code = code;
  }
}

function cleanChangelog(value) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string') throw new UpdateFeedError('changelog must be text', 'UPDATE_FEED_INVALID');
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f<>]/g, '').trim().slice(0, 4000);
}

/** 64-byte ed25519 signature, hex or standard base64. */
export function decodeSignature(value) {
  const raw = String(value || '').trim();
  if (/^[0-9a-f]{128}$/i.test(raw)) return Buffer.from(raw, 'hex');
  if (/^[A-Za-z0-9+/]{86}==$/.test(raw)) {
    const buf = Buffer.from(raw, 'base64');
    if (buf.length === 64) return buf;
  }
  return null;
}

/**
 * Ed25519 signature over the raw package bytes, using the public key shipped
 * in the installed manifest (not the feed). Returns false on any mismatch.
 * @param {string} publicKeyHex 32-byte key, 64 hex chars
 * @param {Buffer} data
 * @param {string} signature
 */
export function verifyPackageSignature(publicKeyHex, data, signature) {
  const sig = decodeSignature(signature);
  if (!sig || !/^[0-9a-f]{64}$/.test(String(publicKeyHex || ''))) return false;
  try {
    const raw = Buffer.from(publicKeyHex, 'hex');
    // SubjectPublicKeyInfo prefix for an Ed25519 key.
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]);
    const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    return verify(null, data, key, sig);
  } catch {
    return false;
  }
}

/**
 * Parse an update feed body.
 * `{ version, packageUrl, sha256, minAppVersion?, changelog?, signature? }`
 * @param {Buffer} buf
 */
export function parseUpdateFeed(buf) {
  let json;
  try {
    json = JSON.parse(Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || ''));
  } catch {
    throw new UpdateFeedError('update feed is not JSON', 'UPDATE_FEED_INVALID');
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new UpdateFeedError('update feed must be a JSON object', 'UPDATE_FEED_INVALID');
  }
  const version = String(json.version || '');
  if (!parseSemver(version)) throw new UpdateFeedError('feed version must be semver', 'UPDATE_FEED_INVALID');
  let packageUrl;
  try {
    packageUrl = assertPluginHttpUrl(json.packageUrl, 'packageUrl', 2000).href;
  } catch (err) {
    if (err instanceof ManifestError) throw new UpdateFeedError(err.message, 'UPDATE_FEED_INVALID');
    throw err;
  }
  const sha256 = String(json.sha256 || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new UpdateFeedError('feed sha256 must be 64 hex characters', 'UPDATE_FEED_INVALID');
  }
  const minAppVersion = json.minAppVersion == null || json.minAppVersion === '' ? '0.0.0' : String(json.minAppVersion);
  if (!parseSemver(minAppVersion)) throw new UpdateFeedError('feed minAppVersion must be semver', 'UPDATE_FEED_INVALID');
  let signature = null;
  if (json.signature != null && json.signature !== '') {
    if (!decodeSignature(json.signature)) {
      throw new UpdateFeedError('signature must be a 64-byte ed25519 signature', 'UPDATE_FEED_INVALID');
    }
    signature = String(json.signature).trim();
  }
  return {
    version,
    packageUrl,
    sha256,
    minAppVersion,
    changelog: cleanChangelog(json.changelog),
    signature,
  };
}

function redirectAllowed(from, to) {
  if (to.username || to.password) return false;
  if (to.protocol !== 'http:' && to.protocol !== 'https:') return false;
  if (from.host !== to.host) return false;
  if (from.protocol === to.protocol) return true;
  // Same host may upgrade from http to https. Never the reverse, never a new host.
  return from.protocol === 'http:' && to.protocol === 'https:';
}

/**
 * GET a URL with a size cap, a timeout and same-host redirects only.
 * @param {string} rawUrl
 * @param {{ maxBytes: number, timeoutMs: number, fetchImpl?: typeof fetch, redirects?: number }} opts
 * @returns {Promise<Buffer>}
 */
export async function fetchBounded(rawUrl, { maxBytes, timeoutMs, fetchImpl = globalThis.fetch, redirects = MAX_REDIRECTS }) {
  let url;
  try {
    url = assertPluginHttpUrl(rawUrl, 'url', 2000);
  } catch (err) {
    throw new UpdateFeedError(err.message || 'invalid update URL', 'UPDATE_FEED_INVALID');
  }
  const res = await fetchImpl(url.href, {
    method: 'GET',
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json, application/zip, application/octet-stream, */*', 'user-agent': 'plugin-update' },
  });
  if ([301, 302, 303, 307, 308].includes(res.status)) {
    await res.arrayBuffer().catch(() => {});
    if (redirects <= 0) throw new UpdateFeedError('too many redirects', 'UPDATE_FEED_INVALID');
    const loc = res.headers.get('location');
    if (!loc) throw new UpdateFeedError('redirect missing location', 'UPDATE_FEED_INVALID');
    let next;
    try {
      next = new URL(loc, url);
    } catch {
      throw new UpdateFeedError('redirect location is not a URL', 'UPDATE_FEED_INVALID');
    }
    if (!redirectAllowed(url, next)) {
      throw new UpdateFeedError('redirect must stay on the same host', 'UPDATE_FEED_INVALID');
    }
    return fetchBounded(next.href, { maxBytes, timeoutMs, fetchImpl, redirects: redirects - 1 });
  }
  if (!res.ok) throw new UpdateFeedError(`update source returned ${res.status}`, 'UPDATE_SOURCE_UNAVAILABLE');
  const declared = Number(res.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.arrayBuffer().catch(() => {});
    throw new UpdateFeedError('response is too large', 'ZIP_LIMIT');
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new UpdateFeedError('response is too large', 'ZIP_LIMIT');
  return buf;
}

export function packageSha256(buf) {
  return sha256Hex(buf);
}

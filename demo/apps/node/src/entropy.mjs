// NOT FOR PROFIT — civic public good, not a commercial product.
// Setup entropy for this install (first-run setup steps 3–4).
//
// One accessor: `entropyInfo(config, store)`.
//   1. ZK_ENTROPY from the environment wins (a zke1 string; treat it as a
//      secret). It is validated at start; a bad value refuses to start.
//   2. Otherwise the value saved on the /setup screen (meta.setup.entropy).
//   3. Otherwise none (mode "skip").
// ENTROPY_CEREMONY_URL (not secret) likewise wins over the ceremony host saved
// on the setup screen.
//
// The value is a zk-entropy string (see zk-entropy/README.md):
//   zke1:<local|ceremony>:<64 hex output>:<64 hex transcript hash>:<8 hex check>
// This is a synchronous Node port of parseEntropyString in
// public/vendor/zk-entropy.js; test/setup-entropy.test.mjs keeps them in step.

import { createHash } from 'node:crypto';

import { readSetup } from './setup.mjs';

const CHECK_DOMAIN = 'zk-entropy/v1/check';
const STRING_RE = /^zke1:(local|ceremony):([0-9a-f]{64}):([0-9a-f]{64}):([0-9a-f]{8})$/;
export const ENTROPY_MODES = Object.freeze(['ceremony', 'local', 'skip']);

function checkFor(source, outputHex, transcriptHash) {
  return createHash('sha256').update(`${CHECK_DOMAIN}|${source}|${outputHex}|${transcriptHash}`, 'utf8').digest('hex').slice(0, 8);
}

/** { ok, source, outputHex, transcriptHash } or { ok: false, error }. Never echoes the input. */
export function parseEntropyString(input) {
  const s = String(input ?? '').trim();
  if (!s) return { ok: false, error: 'empty' };
  const m = s.match(STRING_RE);
  if (!m) return { ok: false, error: 'not a zke1 entropy string (zke1:<source>:<64 hex>:<64 hex>:<8 hex>)' };
  const [, source, outputHex, transcriptHash, check] = m;
  if (checkFor(source, outputHex, transcriptHash) !== check) {
    return { ok: false, error: 'checksum mismatch: the string was mistyped or truncated' };
  }
  return { ok: true, source, outputHex, transcriptHash, value: s };
}

/** Deploy-time ZK_ENTROPY: null when unset; throws (without the value) when invalid. */
export function resolveEnvEntropy(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const p = parseEntropyString(s);
  if (!p.ok) throw new Error(`ZK_ENTROPY is set but is not a valid zke1 entropy string (${p.error}). Refusing to start.`);
  return s;
}

/**
 * Normalise a ceremony host or URL to an origin. Accepts "ceremony.example.org"
 * or "https://ceremony.example.org/". http is allowed only for localhost.
 * Returns null when invalid.
 */
export function normalizeCeremonyUrl(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  if (!/^[a-z]+:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
  if (!local && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(u.hostname)) return null;
  return u.origin;
}

export function resolveEnvCeremonyUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const url = normalizeCeremonyUrl(s);
  if (!url) throw new Error('ENTROPY_CEREMONY_URL is set but is not an https host or URL. Refusing to start.');
  return url;
}

/**
 * The one accessor.
 * @returns {{ source: 'env'|'setup'|'none', fixed: boolean, mode: 'ceremony'|'local'|'skip',
 *   value: string|null, outputSource: string|null, transcriptHash: string|null,
 *   ceremony: { enabled: boolean|null, url: string|null, source: 'env'|'setup'|'none' }, savedAt: string|null }}
 */
export function entropyInfo(config, store) {
  const saved = readSetup(store).entropy || {};
  const envUrl = config.entropyCeremonyUrlEnv || null;
  const ceremony = envUrl
    ? { enabled: true, url: envUrl, source: 'env' }
    : { enabled: typeof saved.ceremony === 'boolean' ? saved.ceremony : null, url: saved.ceremonyUrl || null, source: typeof saved.ceremony === 'boolean' ? 'setup' : 'none' };
  const fromValue = (value) => {
    const p = parseEntropyString(value);
    return p.ok ? { outputSource: p.source, transcriptHash: p.transcriptHash } : { outputSource: null, transcriptHash: null };
  };
  if (config.entropyEnv) {
    const p = fromValue(config.entropyEnv);
    return { source: 'env', fixed: true, mode: p.outputSource === 'ceremony' ? 'ceremony' : 'local', value: config.entropyEnv, ...p, ceremony, savedAt: null };
  }
  if (saved.value && parseEntropyString(saved.value).ok) {
    return { source: 'setup', fixed: false, mode: saved.mode === 'ceremony' ? 'ceremony' : 'local', value: saved.value, ...fromValue(saved.value), ceremony, savedAt: saved.savedAt || null };
  }
  return { source: saved.mode === 'skip' ? 'setup' : 'none', fixed: false, mode: 'skip', value: null, outputSource: null, transcriptHash: null, ceremony, savedAt: saved.savedAt || null };
}

/** Public view: never includes the value. */
export function entropyPublic(info) {
  const { value, ...rest } = info;
  return { ...rest, set: Boolean(value), env: 'ZK_ENTROPY', ceremonyEnv: 'ENTROPY_CEREMONY_URL' };
}

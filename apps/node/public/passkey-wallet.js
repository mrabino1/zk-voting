/**
 * NOT FOR PROFIT — Republic is a civic public good. Not a commercial product.
 *
 * Passkey-held wallet for Republic.
 *
 * - WebAuthn resident key + userVerification required.
 * - Two PRF / HKDF domains (docs/PASSKEYS.md): account key ≠ trapdoor/nullifierSecret.
 *   prf.eval(saltAccount)  → HKDF("republic:account:v1")  → AES-GCM wrap of secp256k1 seed
 *   prf.eval(saltIdentity) → HKDF("republic:identity:v1") → (identityTrapdoor, nullifierSecret)
 * - saltAccount  = HKDF-SHA-256(ikm=credentialId, salt/info domain "republic:account:v1", binding=chain id)
 * - saltIdentity = HKDF-SHA-256(ikm=credentialId, salt/info domain "republic:identity:v1", binding=jurisdictionId)
 * - Authenticators that return only one PRF eval are prompted a second time with saltIdentity.
 *   Republic will not derive the trapdoor from the account seed or account PRF output.
 * - The seed stands in for a secp256k1 private key. This file does not ship a
 *   curve implementation, so it cannot emit an uncompressed public key.
 * - getAddress() therefore returns `0x` + first 20 bytes of SHA-256(seed) and
 *   labels the scheme `republic-local-address`.
 * - Production (Ethereum) addresses are keccak256(uncompressed secp256k1 pubkey)[12:32].
 *   A compact keccak256 remains for ballot hashes. The identity commitment is Poseidon.
 * - NEVER render a seed phrase. The seed never leaves RAM except as AES-GCM ciphertext
 *   in IndexedDB. signUserOp() unwraps, HMAC-signs, then zeroes the seed.
 *
 * IndexedDB `republic-wallet` schema version 2. Record `version` 3 stores a Poseidon
 * identity commitment (`prf-hkdf-poseidon-v3`). v1 wraps derived the ZK identity from
 * the account seed. v2 stored keccak256(trapdoor || nullifierSecret). Neither matches
 * the vote circuit. Reset the demo wallet and create a new passkey.
 */

import { POSEIDON_HASH_SCHEME, poseidonCommitmentHex } from "./poseidon.js";
import { encryptToTallyPub, packChoices } from "./tally-crypto.js";
const DB_NAME = "republic-wallet";
const DB_VERSION = 2;
const STORE = "wallet";
const RECORD_KEY = "primary";

/** @see docs/PASSKEYS.md domain-separated salts */
export const ACCOUNT_PRF_DOMAIN = "republic:account:v1";
export const IDENTITY_PRF_DOMAIN = "republic:identity:v1";
export const ACCOUNT_HKDF_INFO = "republic-secp256k1-wrap";
export const IDENTITY_HKDF_INFO = "trapdoor+nullifier";
export const WALLET_RECORD_VERSION = 3;
export const IDENTITY_SCHEME = "prf-hkdf-poseidon-v3";
export const DEFAULT_CHAIN_ID = 27427;
export const DEFAULT_JURISDICTION_ID = "demo";

const WRAP_INFO = ACCOUNT_HKDF_INFO;
const FALLBACK_INFO = "republic-prf-fallback-v1";
const FALLBACK_IDENTITY_INFO = "republic-prf-fallback-identity-v1";
const PRF_ENABLE_INFO = "republic:prf-enable:v1";

export const STALE_WALLET_MESSAGE =
  "This browser has a v1 passkey wrap or a pre-Poseidon identity commitment (IndexedDB republic-wallet). v1 derived the ZK trapdoor from the same seed as the account key. v2 hashed the leaf with keccak256. The demo leaf is now Poseidon(trapdoor, nullifierSecret), the same hash as the vote circuit. Reset the device wallet and create a new passkey. The identity commitment will change; any prior demo roll entry will not match.";

export const ADDRESS_SCHEME = "republic-local-address";
export const PRODUCTION_ADDRESS_NOTE =
  "Production uses keccak256(uncompressed secp256k1 public key), then takes the last 20 bytes (Ethereum). This demo cannot multiply on secp256k1 without a curve library, so getAddress() returns SHA-256(seed)[0:20] labeled republic-local-address.";

const textEncoder = new TextEncoder();

let webauthnQueue = Promise.resolve();

function enqueueWebAuthn(fn) {
  const run = webauthnQueue.then(fn, fn);
  webauthnQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/* -------------------------------------------------------------------------- */
/* Bytes                                                                      */
/* -------------------------------------------------------------------------- */

export function bytesToHex(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = "";
  for (let i = 0; i < arr.length; i++) out += arr[i].toString(16).padStart(2, "0");
  return out;
}

export function hexToBytes(hex) {
  const h = String(hex).replace(/^0x/i, "");
  if (h.length % 2) throw new Error("hex length must be even");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToBase64url(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64urlToBytes(value) {
  const str = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const pad = "=".repeat((4 - (str.length % 4)) % 4);
  const bin = atob(str + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function coerceBytes(value) {
  if (value == null) return new Uint8Array();
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) return new Uint8Array(value);
  if (typeof value === "string") {
    if (value.startsWith("0x") || value.startsWith("0X")) return hexToBytes(value);
    return base64urlToBytes(value);
  }
  return new Uint8Array();
}

function concatBytes(...parts) {
  const chunks = parts.map((p) => coerceBytes(p));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function utf8(value) {
  return textEncoder.encode(String(value ?? ""));
}

function zeroFill(arr) {
  if (arr && arr.fill) arr.fill(0);
}

/* -------------------------------------------------------------------------- */
/* Keccak-256 (Ethereum; not NIST SHA-3)                                      */
/*                                                                          */
/* Test vectors:                                                              */
/*   keccak256("")    = c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470 */
/*   keccak256("abc") = 4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45 */
/* -------------------------------------------------------------------------- */

const KECCAK_RC = [
  0x0000000000000001n,
  0x0000000000008082n,
  0x800000000000808an,
  0x8000000080008000n,
  0x000000000000808bn,
  0x0000000080000001n,
  0x8000000080008081n,
  0x8000000000008009n,
  0x000000000000008an,
  0x0000000000000088n,
  0x0000000080008009n,
  0x000000008000000an,
  0x000000008000808bn,
  0x800000000000008bn,
  0x8000000000008089n,
  0x8000000000008003n,
  0x8000000000008002n,
  0x8000000000000080n,
  0x000000000000800an,
  0x800000008000000an,
  0x8000000080008081n,
  0x8000000000008080n,
  0x0000000080000001n,
  0x8000000080008008n,
];

const KECCAK_RHO = [
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
];

const MASK64 = 0xffffffffffffffffn;

function rotl64(x, n) {
  const s = BigInt(n % 64);
  if (s === 0n) return x;
  return ((x << s) | (x >> (64n - s))) & MASK64;
}

function keccakF1600(a) {
  for (let round = 0; round < 24; round++) {
    const c = new Array(5);
    for (let x = 0; x < 5; x++) {
      c[x] = a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20];
    }
    const d = new Array(5);
    for (let x = 0; x < 5; x++) {
      d[x] = c[(x + 4) % 5] ^ rotl64(c[(x + 1) % 5], 1);
    }
    for (let i = 0; i < 25; i++) a[i] ^= d[i % 5];

    const b = new Array(25);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const src = x + 5 * y;
        const destX = y;
        const destY = (2 * x + 3 * y) % 5;
        b[destX + 5 * destY] = rotl64(a[src], KECCAK_RHO[src]);
      }
    }

    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const i = x + 5 * y;
        a[i] = b[i] ^ (~b[((x + 1) % 5) + 5 * y] & b[((x + 2) % 5) + 5 * y]);
        a[i] &= MASK64;
      }
    }
    a[0] ^= KECCAK_RC[round];
  }
}

/**
 * @param {BufferSource | Uint8Array | number[] | string} input bytes, or UTF-8 string
 * @returns {Uint8Array} 32-byte digest
 */
export function keccak256(input) {
  const data =
    typeof input === "string" ? textEncoder.encode(input) : coerceBytes(input);
  const rate = 136;
  const state = new Array(25).fill(0n);
  const block = new Uint8Array(rate);
  let offset = 0;
  while (offset < data.length) {
    const n = Math.min(rate, data.length - offset);
    block.fill(0);
    block.set(data.subarray(offset, offset + n));
    if (n < rate) {
      block[n] ^= 0x01;
      block[rate - 1] ^= 0x80;
      xorBlock(state, block);
      keccakF1600(state);
      offset = data.length;
      break;
    }
    xorBlock(state, block);
    keccakF1600(state);
    offset += n;
  }
  if (data.length % rate === 0) {
    block.fill(0);
    block[0] ^= 0x01;
    block[rate - 1] ^= 0x80;
    xorBlock(state, block);
    keccakF1600(state);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) store64(out, i * 8, state[i]);
  return out;
}

function xorBlock(state, block) {
  for (let i = 0; i < 17; i++) {
    state[i] ^= load64(block, i * 8);
  }
}

function load64(bytes, offset) {
  let x = 0n;
  for (let i = 0; i < 8; i++) x |= BigInt(bytes[offset + i]) << BigInt(8 * i);
  return x;
}

function store64(bytes, offset, x) {
  for (let i = 0; i < 8; i++) bytes[offset + i] = Number((x >> BigInt(8 * i)) & 0xffn);
}

export function keccak256Hex(input) {
  return "0x" + bytesToHex(keccak256(input));
}

/* -------------------------------------------------------------------------- */
/* IndexedDB                                                                  */
/* -------------------------------------------------------------------------- */

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is required to hold the wrapped passkey seed."));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    const timer = setTimeout(() => {
      try {
        req.transaction?.abort();
      } catch {
        /* ignore */
      }
      reject(new Error("IndexedDB open timed out."));
    }, 4000);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      // v1 → v2 keeps the same store. v1 records (identity HKDF of the account
      // seed) are detected via record.version / identityScheme and refused until
      // the voter resets — a breaking demo upgrade, documented in PASSKEYS.md.
    };
    req.onsuccess = () => {
      clearTimeout(timer);
      resolve(req.result);
    };
    req.onerror = () => {
      clearTimeout(timer);
      reject(req.error || new Error("IndexedDB open failed"));
    };
  });
}

async function idbGet() {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(RECORD_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

async function idbPut(record) {
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(record, RECORD_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function idbClear() {
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(RECORD_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/* -------------------------------------------------------------------------- */
/* HKDF / AES-GCM wrap — domain-separated account vs identity                 */
/* -------------------------------------------------------------------------- */

async function importHkdfIkm(raw) {
  return crypto.subtle.importKey("raw", coerceBytes(raw), "HKDF", false, ["deriveKey", "deriveBits"]);
}

/**
 * HKDF-SHA-256. `salt` and `info` may be strings (UTF-8) or bytes.
 * Exported so tests can pin domain-separation vectors without WebAuthn.
 *
 * @param {BufferSource | string} ikm
 * @param {{ salt?: BufferSource | string, info?: BufferSource | string, length?: number }} [opts]
 * @returns {Promise<Uint8Array>}
 */
export async function hkdfSha256Bits(ikm, { salt = new Uint8Array(), info = new Uint8Array(), length = 32 } = {}) {
  const key = await importHkdfIkm(ikm);
  const saltBytes = typeof salt === "string" ? utf8(salt) : coerceBytes(salt);
  const infoBytes = typeof info === "string" ? utf8(info) : coerceBytes(info);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: saltBytes,
        info: infoBytes,
      },
      key,
      length * 8
    )
  );
}

/**
 * 32-byte WebAuthn PRF eval salt (docs/PASSKEYS.md).
 *
 *   saltAccount  = HKDF-SHA-256(ikm=credentialId, salt="republic:account:v1",  info=chainId)
 *   saltIdentity = HKDF-SHA-256(ikm=credentialId, salt="republic:identity:v1", info=jurisdictionId)
 *
 * HKDF-Extract uses the domain string as salt; HKDF-Expand uses the binding as info
 * so the two domains cannot be swapped and chain id cannot be confused with jurisdiction id.
 *
 * @param {{ domain: string, credentialId: BufferSource, binding: string | number }} params
 * @returns {Promise<Uint8Array>} 32 bytes
 */
export async function derivePrfEvalSalt({ domain, credentialId, binding }) {
  if (!domain) throw new Error("PRF domain is required");
  const id = coerceBytes(credentialId);
  if (!id.length) throw new Error("credentialId is required to derive a PRF salt");
  return hkdfSha256Bits(id, {
    salt: domain,
    info: String(binding ?? ""),
    length: 32,
  });
}

/**
 * Account + identity PRF eval salts for a credential. Login can merge
 * `buildPrfEvalExtension(salts)` onto `navigator.credentials.get` extensions.
 *
 * @param {{ credentialId: BufferSource, chainId?: number, jurisdictionId?: string }} params
 */
export async function prfEvalSaltsForCredential({
  credentialId,
  chainId = DEFAULT_CHAIN_ID,
  jurisdictionId = DEFAULT_JURISDICTION_ID,
}) {
  const saltAccount = await derivePrfEvalSalt({
    domain: ACCOUNT_PRF_DOMAIN,
    credentialId,
    binding: String(chainId),
  });
  const saltIdentity = await derivePrfEvalSalt({
    domain: IDENTITY_PRF_DOMAIN,
    credentialId,
    binding: String(jurisdictionId || DEFAULT_JURISDICTION_ID),
  });
  return { saltAccount, saltIdentity, chainId: Number(chainId), jurisdictionId: String(jurisdictionId || DEFAULT_JURISDICTION_ID) };
}

/**
 * @param {{ saltAccount: BufferSource, saltIdentity?: BufferSource | null }} params
 */
export function buildPrfEvalExtension({ saltAccount, saltIdentity }) {
  const evalInput = { first: coerceBytes(saltAccount) };
  if (saltIdentity) evalInput.second = coerceBytes(saltIdentity);
  return { prf: { eval: evalInput } };
}

export function isCurrentWalletRecord(rec) {
  if (!rec || typeof rec !== "object") return false;
  return (
    Number(rec.version) >= WALLET_RECORD_VERSION &&
    rec.identityScheme === IDENTITY_SCHEME &&
    rec.prfDomains?.account === ACCOUNT_PRF_DOMAIN &&
    rec.prfDomains?.identity === IDENTITY_PRF_DOMAIN
  );
}

/**
 * HKDF the identity-domain PRF output into (trapdoor, nullifierSecret).
 * Never pass the account seed or account PRF output here in production paths.
 *
 * @param {BufferSource} prfIdentityOutput
 */
export async function deriveIdentitySecrets(prfIdentityOutput) {
  const bits = await hkdfSha256Bits(prfIdentityOutput, {
    salt: IDENTITY_PRF_DOMAIN,
    info: IDENTITY_HKDF_INFO,
    length: 64,
  });
  const trapdoor = bits.subarray(0, 32);
  const nullifierSecret = bits.subarray(32, 64);
  // 32-byte HKDF outputs are reduced mod the bn254 scalar field inside Poseidon,
  // matching PoseidonT3.hashLeftRight and the vote circuit.
  const commitment = poseidonCommitmentHex(
    BigInt(`0x${bytesToHex(trapdoor)}`),
    BigInt(`0x${bytesToHex(nullifierSecret)}`),
  );
  return {
    trapdoor,
    nullifierSecret,
    commitment,
    hasher: POSEIDON_HASH_SCHEME,
  };
}

async function aesKeyFromHkdf(ikm, { salt, info }) {
  const key = await importHkdfIkm(ikm);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: typeof salt === "string" ? utf8(salt) : coerceBytes(salt),
      info: typeof info === "string" ? utf8(info) : coerceBytes(info),
    },
    key,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function aesKeyFromPrf(prfOutput) {
  return aesKeyFromHkdf(prfOutput, { salt: ACCOUNT_PRF_DOMAIN, info: WRAP_INFO });
}

async function aesKeyFromFallback(credentialIdBytes) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    concatBytes(utf8(FALLBACK_INFO), coerceBytes(credentialIdBytes))
  );
  return aesKeyFromHkdf(digest, { salt: ACCOUNT_PRF_DOMAIN, info: FALLBACK_INFO });
}

async function fallbackIdentityIkm(credentialIdBytes) {
  return new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      concatBytes(utf8(FALLBACK_IDENTITY_INFO), coerceBytes(credentialIdBytes))
    )
  );
}

async function encryptSeed(aesKey, seed) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, seed)
  );
  return { iv: bytesToBase64url(iv), ciphertext: bytesToBase64url(ciphertext) };
}

async function decryptSeed(aesKey, wrapped) {
  const iv = base64urlToBytes(wrapped.iv);
  const ciphertext = base64urlToBytes(wrapped.ciphertext);
  const seed = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv }, aesKey, ciphertext)
  );
  if (seed.length !== 32) throw new Error("Unwrapped seed was not 32 bytes.");
  return seed;
}

/**
 * Wrap a 32-byte account seed with HKDF(account-domain, PRF output). Deterministic
 * given (prfOutput, seed, iv) — callers that need a random wrap should generate iv
 * via encryptSeed; this helper is for tests and provision.
 *
 * @param {BufferSource} prfAccountOutput
 * @param {BufferSource} seed
 */
export async function wrapSeedWithAccountPrf(prfAccountOutput, seed) {
  const aesKey = await aesKeyFromPrf(prfAccountOutput);
  return encryptSeed(aesKey, coerceBytes(seed));
}

/**
 * @param {BufferSource} prfAccountOutput
 * @param {{ iv: string, ciphertext: string }} wrapped
 */
export async function unwrapSeedWithAccountPrf(prfAccountOutput, wrapped) {
  const aesKey = await aesKeyFromPrf(prfAccountOutput);
  return decryptSeed(aesKey, wrapped);
}

/**
 * HKDF-SHA256 the authenticator **account** PRF output into an AES-GCM wrapping key,
 * then unwrap (or create and wrap) a 32-byte seed used as a secp256k1 stand-in.
 * Does not derive identity material — that is a separate PRF domain.
 *
 * @param {BufferSource} prfOutput
 * @param {{ credentialId?: BufferSource, existing?: object | null }} [opts]
 * @returns {Promise<Uint8Array>} 32-byte seed — caller MUST zeroFill after use
 */
export async function deriveOrUnwrapSecp256k1(prfOutput, opts = {}) {
  const aesKey = await aesKeyFromPrf(prfOutput);
  const existing = opts.existing !== undefined ? opts.existing : await idbGet();
  if (existing?.wrappedSeed && existing.wrapScheme === "prf-hkdf-aes-gcm") {
    if (existing.version && existing.version < WALLET_RECORD_VERSION) {
      throw new Error(STALE_WALLET_MESSAGE);
    }
    return decryptSeed(aesKey, existing.wrappedSeed);
  }
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const wrappedSeed = await encryptSeed(aesKey, seed);
  const publicParts = await publicFromSeed(seed);
  const record = {
    ...(existing || {}),
    version: WALLET_RECORD_VERSION,
    wrapScheme: "prf-hkdf-aes-gcm",
    wrappedSeed,
    prfSupported: true,
    prfDomains: { account: ACCOUNT_PRF_DOMAIN, identity: IDENTITY_PRF_DOMAIN },
    ...publicParts,
    updatedAt: new Date().toISOString(),
  };
  if (opts.credentialId) record.credentialId = bytesToBase64url(opts.credentialId);
  await idbPut(record);
  return seed;
}

async function publicFromSeed(seed) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", seed));
  const address = "0x" + bytesToHex(digest.subarray(0, 20));
  return {
    address,
    addressScheme: ADDRESS_SCHEME,
    productionAddressNote: PRODUCTION_ADDRESS_NOTE,
  };
}

function publicFromIdentity(identity) {
  return {
    identityCommitment: identity.commitment,
    hasher: identity.hasher,
    identityScheme: IDENTITY_SCHEME,
  };
}

/* -------------------------------------------------------------------------- */
/* WebAuthn                                                                   */
/* -------------------------------------------------------------------------- */

export function hasWebAuthn() {
  return (
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential !== "undefined" &&
    navigator.credentials &&
    typeof navigator.credentials.create === "function"
  );
}

export async function isPrfSupported() {
  try {
    if (typeof PublicKeyCredential !== "undefined" && PublicKeyCredential.getClientCapabilities) {
      const caps = await PublicKeyCredential.getClientCapabilities();
      if (caps && Object.prototype.hasOwnProperty.call(caps, "extension:prf")) {
        return Boolean(caps["extension:prf"]);
      }
    }
  } catch {
    /* try the extension anyway */
  }
  return true;
}

function random32() {
  return crypto.getRandomValues(new Uint8Array(32));
}

function randomChallenge() {
  return crypto.getRandomValues(new Uint8Array(32));
}

function prfEnableSalt() {
  return hkdfSha256Bits(utf8(PRF_ENABLE_INFO), {
    salt: PRF_ENABLE_INFO,
    info: PRF_ENABLE_INFO,
    length: 32,
  });
}

/**
 * @param {PublicKeyCredentialCreationOptions | object} [serverOptions]
 * @returns {Promise<PublicKeyCredential>}
 */
export async function createCredential(serverOptions = {}) {
  if (!hasWebAuthn()) {
    throw new Error("This browser does not support passkeys (WebAuthn).");
  }
  const prfOk = await isPrfSupported();
  const evalFirst =
    serverOptions.prfEvalFirst != null
      ? coerceBytes(serverOptions.prfEvalFirst)
      : await prfEnableSalt();
  const evalSecond =
    serverOptions.prfEvalSecond != null ? coerceBytes(serverOptions.prfEvalSecond) : null;

  const pk = serverOptions.publicKey || serverOptions;
  const challenge = pk.challenge ? coerceBytes(pk.challenge) : randomChallenge();
  const userId = pk.user?.id ? coerceBytes(pk.user.id) : random32();
  const rpId = pk.rp?.id || (typeof location !== "undefined" ? location.hostname : undefined);
  const rpName = pk.rp?.name || "Republic";
  const userName = pk.user?.name || serverOptions.displayName || "voter";
  const displayName = pk.user?.displayName || userName;

  const extensions = { ...(pk.extensions || {}) };
  if (prfOk) {
    extensions.prf = { eval: { first: evalFirst } };
    if (evalSecond) extensions.prf.eval.second = evalSecond;
  }

  const publicKey = {
    challenge,
    rp: rpId ? { name: rpName, id: rpId } : { name: rpName },
    user: {
      id: userId,
      name: userName,
      displayName,
    },
    pubKeyCredParams: pk.pubKeyCredParams || [
      { type: "public-key", alg: -8 },
      { type: "public-key", alg: -7 },
      { type: "public-key", alg: -257 },
    ],
    authenticatorSelection: {
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "required",
      ...(pk.authenticatorSelection || {}),
      residentKey: "required",
      userVerification: "required",
    },
    timeout: pk.timeout || 120000,
    attestation: pk.attestation || "none",
    excludeCredentials: (pk.excludeCredentials || []).map((c) => ({
      type: c.type || "public-key",
      id: coerceBytes(c.id),
      transports: c.transports,
    })),
    extensions,
  };

  const credential = await enqueueWebAuthn(() => navigator.credentials.create({ publicKey }));
  if (!credential) throw new Error("Passkey creation was cancelled.");
  credential._republicPrfEvalFirst = evalFirst;
  if (evalSecond) credential._republicPrfEvalSecond = evalSecond;
  return credential;
}

export function prfOutputsFromCredential(credential) {
  const ext =
    typeof credential.getClientExtensionResults === "function"
      ? credential.getClientExtensionResults()
      : {};
  const first = ext?.prf?.results?.first ? coerceBytes(ext.prf.results.first) : null;
  const second = ext?.prf?.results?.second ? coerceBytes(ext.prf.results.second) : null;
  return { first, second, enabled: Boolean(ext?.prf) };
}

async function assertionWithPrf(credentialId, evalFirst, extra = {}) {
  const evalExt = {};
  if (evalFirst) evalExt.first = coerceBytes(evalFirst);
  if (extra.evalSecond) evalExt.second = coerceBytes(extra.evalSecond);
  const publicKey = {
    challenge: extra.challenge ? coerceBytes(extra.challenge) : randomChallenge(),
    timeout: 120000,
    userVerification: "required",
    rpId: extra.rpId || (typeof location !== "undefined" ? location.hostname : undefined),
    allowCredentials: credentialId
      ? [{ type: "public-key", id: coerceBytes(credentialId) }]
      : undefined,
    extensions: Object.keys(evalExt).length ? { prf: { eval: evalExt } } : {},
  };
  const assertion = await enqueueWebAuthn(() => navigator.credentials.get({ publicKey }));
  if (!assertion) throw new Error("Passkey assertion was cancelled.");
  return assertion;
}

/**
 * Eval account (and optionally identity) PRF salts. If the authenticator returns
 * `first` but not `second`, a second assertion uses saltIdentity as `eval.first`.
 */
async function evalSeparatedPrf(credentialId, { chainId, jurisdictionId, needIdentity = true } = {}) {
  const salts = await prfEvalSaltsForCredential({ credentialId, chainId, jurisdictionId });
  const assertion = await assertionWithPrf(credentialId, salts.saltAccount, {
    evalSecond: needIdentity ? salts.saltIdentity : null,
  });
  const outputs = prfOutputsFromCredential(assertion);
  let prfAccount = outputs.first;
  let prfIdentity = needIdentity ? outputs.second : null;
  let prfSecondSupported = Boolean(outputs.second);

  if (needIdentity && prfAccount && !prfIdentity) {
    const secondAssertion = await assertionWithPrf(credentialId, salts.saltIdentity);
    const secondOut = prfOutputsFromCredential(secondAssertion);
    prfIdentity = secondOut.first;
    prfSecondSupported = false;
  }

  return {
    ...salts,
    prfAccount,
    prfIdentity,
    prfSecondSupported,
    assertion,
  };
}

function walletRecordFields({
  credentialId,
  displayName,
  wrapScheme,
  wrappedSeed,
  prfSupported,
  prfSecondSupported,
  salts,
  publicParts,
  identityParts,
  fallbackNote,
}) {
  return {
    version: WALLET_RECORD_VERSION,
    credentialId: bytesToBase64url(credentialId),
    prfEvalAccount: salts?.saltAccount ? bytesToBase64url(salts.saltAccount) : null,
    prfEvalIdentity: salts?.saltIdentity ? bytesToBase64url(salts.saltIdentity) : null,
    prfDomains: { account: ACCOUNT_PRF_DOMAIN, identity: IDENTITY_PRF_DOMAIN },
    chainId: salts?.chainId ?? DEFAULT_CHAIN_ID,
    jurisdictionId: salts?.jurisdictionId || DEFAULT_JURISDICTION_ID,
    wrapScheme,
    wrappedSeed,
    prfSupported: Boolean(prfSupported),
    prfSecondSupported: prfSecondSupported == null ? null : Boolean(prfSecondSupported),
    identityScheme: IDENTITY_SCHEME,
    displayName: displayName || null,
    fallbackNote: fallbackNote || null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...publicParts,
    ...identityParts,
  };
}

async function provisionFromCredential(credential, { displayName, chainId, jurisdictionId } = {}) {
  const credentialId = new Uint8Array(credential.rawId);
  const ctx = {
    chainId: Number(chainId ?? DEFAULT_CHAIN_ID),
    jurisdictionId: String(jurisdictionId || DEFAULT_JURISDICTION_ID),
  };
  let seed;
  let prfAccount;
  let prfIdentity;
  try {
    let evaluated = null;
    try {
      evaluated = await evalSeparatedPrf(credentialId, {
        chainId: ctx.chainId,
        jurisdictionId: ctx.jurisdictionId,
        needIdentity: true,
      });
    } catch (err) {
      const msg = String(err?.message || err);
      if (/cancelled|not allowed|abort/i.test(msg)) throw err;
      evaluated = null;
    }

    prfAccount = evaluated?.prfAccount || null;
    prfIdentity = evaluated?.prfIdentity || null;

    if (prfAccount && !prfIdentity) {
      throw new Error(
        "This authenticator returned an account PRF output but not an identity-domain PRF output. Republic will not derive the trapdoor from the account key."
      );
    }

    if (prfAccount && prfIdentity) {
      seed = crypto.getRandomValues(new Uint8Array(32));
      const wrappedSeed = await wrapSeedWithAccountPrf(prfAccount, seed);
      const publicParts = await publicFromSeed(seed);
      const identity = await deriveIdentitySecrets(prfIdentity);
      await idbPut(
        walletRecordFields({
          credentialId,
          displayName,
          wrapScheme: "prf-hkdf-aes-gcm",
          wrappedSeed,
          prfSupported: true,
          prfSecondSupported: evaluated.prfSecondSupported,
          salts: evaluated,
          publicParts,
          identityParts: publicFromIdentity(identity),
        })
      );
      zeroFill(identity.trapdoor);
      zeroFill(identity.nullifierSecret);
    } else {
      if (!evaluated) {
        await assertionWithPrf(credentialId, null);
      }
      seed = crypto.getRandomValues(new Uint8Array(32));
      const aesKey = await aesKeyFromFallback(credentialId);
      const wrappedSeed = await encryptSeed(aesKey, seed);
      const publicParts = await publicFromSeed(seed);
      const identityIkm = await fallbackIdentityIkm(credentialId);
      const identity = await deriveIdentitySecrets(identityIkm);
      zeroFill(identityIkm);
      await idbPut(
        walletRecordFields({
          credentialId,
          displayName,
          wrapScheme: "uv-fallback-hkdf-aes-gcm",
          wrappedSeed,
          prfSupported: false,
          prfSecondSupported: false,
          salts: await prfEvalSaltsForCredential({
            credentialId,
            chainId: ctx.chainId,
            jurisdictionId: ctx.jurisdictionId,
          }),
          publicParts,
          identityParts: publicFromIdentity(identity),
          fallbackNote:
            "PRF was unavailable. The account seed is wrapped with a key derived from the credential id after userVerification, and the ZK identity uses a *separate* HKDF domain of that credential id. This is weaker than WebAuthn PRF and is a demo-only path. The trapdoor is still not the account seed.",
        })
      );
      zeroFill(identity.trapdoor);
      zeroFill(identity.nullifierSecret);
    }
  } finally {
    zeroFill(seed);
    zeroFill(prfAccount);
    zeroFill(prfIdentity);
  }
  return getPublicRecord();
}

async function unwrapWalletMaterial({ needIdentity = false } = {}) {
  const rec = await idbGet();
  if (!rec?.wrappedSeed) throw new Error("No passkey wallet on this device. Register first.");
  if (!isCurrentWalletRecord(rec)) {
    throw new Error(STALE_WALLET_MESSAGE);
  }
  const credentialId = rec.credentialId ? base64urlToBytes(rec.credentialId) : null;
  const chainId = rec.chainId ?? DEFAULT_CHAIN_ID;
  const jurisdictionId = rec.jurisdictionId || DEFAULT_JURISDICTION_ID;

  let seed;
  let identity = null;
  let prfAccount;
  let prfIdentity;
  try {
    if (rec.wrapScheme === "prf-hkdf-aes-gcm") {
      const evaluated = await evalSeparatedPrf(credentialId, {
        chainId,
        jurisdictionId,
        needIdentity,
      });
      prfAccount = evaluated.prfAccount;
      prfIdentity = evaluated.prfIdentity;
      if (!prfAccount) {
        throw new Error("This authenticator did not return a PRF output; cannot unwrap the seed.");
      }
      seed = await unwrapSeedWithAccountPrf(prfAccount, rec.wrappedSeed);
      if (needIdentity) {
        if (!prfIdentity) {
          throw new Error(
            "This authenticator did not return a PRF output for the identity domain. Republic will not derive the trapdoor from the account key."
          );
        }
        identity = await deriveIdentitySecrets(prfIdentity);
        if (rec.identityCommitment && identity.commitment !== rec.identityCommitment) {
          throw new Error(
            "Identity commitment from the identity PRF domain does not match the stored wallet. Reset the demo wallet and register again."
          );
        }
      }
    } else {
      await assertionWithPrf(credentialId, null);
      const aesKey = await aesKeyFromFallback(credentialId);
      seed = await decryptSeed(aesKey, rec.wrappedSeed);
      if (needIdentity) {
        const identityIkm = await fallbackIdentityIkm(credentialId);
        identity = await deriveIdentitySecrets(identityIkm);
        zeroFill(identityIkm);
        if (rec.identityCommitment && identity.commitment !== rec.identityCommitment) {
          throw new Error(
            "Identity commitment from the fallback identity domain does not match the stored wallet. Reset the demo wallet and register again."
          );
        }
      }
    }
    return { rec, seed, identity };
  } catch (err) {
    zeroFill(seed);
    if (identity) {
      zeroFill(identity.trapdoor);
      zeroFill(identity.nullifierSecret);
    }
    throw err;
  } finally {
    zeroFill(prfAccount);
    zeroFill(prfIdentity);
  }
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export async function getPublicRecord() {
  try {
    const rec = await idbGet();
    if (!rec) return null;
    const staleWrap = !isCurrentWalletRecord(rec);
    return {
      credentialId: rec.credentialId,
      address: rec.address,
      addressScheme: rec.addressScheme || ADDRESS_SCHEME,
      productionAddressNote: rec.productionAddressNote || PRODUCTION_ADDRESS_NOTE,
      identityCommitment: rec.identityCommitment,
      hasher: rec.hasher,
      identityScheme: rec.identityScheme || "account-seed-hkdf-v1",
      prfSupported: Boolean(rec.prfSupported),
      prfSecondSupported: rec.prfSecondSupported ?? null,
      wrapScheme: rec.wrapScheme,
      fallbackNote: rec.fallbackNote || null,
      displayName: rec.displayName || null,
      createdAt: rec.createdAt,
      walletRecordVersion: rec.version || 1,
      prfDomains: rec.prfDomains || null,
      chainId: rec.chainId ?? null,
      jurisdictionId: rec.jurisdictionId || null,
      staleWrap,
      migrationNote: staleWrap ? STALE_WALLET_MESSAGE : null,
    };
  } catch {
    return null;
  }
}

export async function hasWallet() {
  const rec = await getPublicRecord();
  return Boolean(rec?.identityCommitment) && !rec.staleWrap;
}

/**
 * Address of the passkey-held account.
 * Demo: 0x + SHA-256(seed)[0:20], scheme republic-local-address.
 * Production: keccak256(uncompressed secp256k1 pubkey)[12:32].
 */
export async function getAddress() {
  const rec = await getPublicRecord();
  if (!rec?.address) throw new Error("No passkey wallet on this device. Register first.");
  if (rec.staleWrap) throw new Error(STALE_WALLET_MESSAGE);
  return {
    address: rec.address,
    scheme: rec.addressScheme,
    productionNote: rec.productionAddressNote,
  };
}

export async function getIdentityCommitment() {
  const rec = await getPublicRecord();
  if (!rec?.identityCommitment) throw new Error("No passkey wallet on this device. Register first.");
  if (rec.staleWrap) throw new Error(STALE_WALLET_MESSAGE);
  return rec.identityCommitment;
}

async function resolveDerivationContext({ api, chainId, jurisdictionId } = {}) {
  let chain = chainId;
  let jur = jurisdictionId;
  if ((chain == null || jur == null) && typeof api === "function") {
    try {
      const cfg = await api("/api/config");
      if (chain == null && cfg?.chainId != null) chain = cfg.chainId;
    } catch {
      /* local defaults */
    }
  }
  return {
    chainId: Number(chain ?? DEFAULT_CHAIN_ID),
    jurisdictionId: String(jur || DEFAULT_JURISDICTION_ID),
  };
}

/**
 * Register a resident-key passkey, wrap a 32-byte account seed under the account
 * PRF domain, derive (trapdoor, nullifierSecret) under the identity PRF domain,
 * and optionally finish with the Node (`POST /api/auth/passkey/register/{begin,finish}`).
 */
export async function registerPasskey({ api, displayName, chainId, jurisdictionId, acceptedTerms } = {}) {
  let server = null;
  let finishError = null;
  if (typeof api === "function") {
    try {
      server = await api("/api/auth/passkey/register/begin", {
        method: "POST",
        body: { displayName: displayName || "voter", handle: displayName || "voter", acceptedTerms },
      });
    } catch {
      server = null;
    }
  }
  const options = server?.publicKey
    ? server
    : server?.options
      ? server.options
      : server || {};
  if (displayName) options.displayName = displayName;
  const ctx = await resolveDerivationContext({ api, chainId, jurisdictionId });
  const credential = await createCredential(options);
  const publicRecord = await provisionFromCredential(credential, {
    displayName,
    chainId: ctx.chainId,
    jurisdictionId: ctx.jurisdictionId,
  });

  if (typeof api === "function") {
    try {
      await api("/api/auth/passkey/register/finish", {
        method: "POST",
        body: {
          ...serializeAttestation(credential, publicRecord),
          handle: displayName || "voter",
          acceptedTerms,
        },
      });
    } catch (err) {
      finishError = err.message || "Passkey finish did not complete on the Node.";
    }
  }
  return { ...publicRecord, finishError };
}

function serializeAttestation(credential, publicRecord) {
  const att = credential.response;
  return {
    id: credential.id,
    rawId: bytesToBase64url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment || null,
    clientExtensionResults: credential.getClientExtensionResults?.() || {},
    response: {
      clientDataJSON: bytesToBase64url(att.clientDataJSON),
      attestationObject: bytesToBase64url(att.attestationObject),
      transports: typeof att.getTransports === "function" ? att.getTransports() : [],
    },
    publicRecord,
  };
}

export function serializeAssertion(credential) {
  const res = credential.response;
  return {
    id: credential.id,
    rawId: bytesToBase64url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment || null,
    clientExtensionResults: credential.getClientExtensionResults?.() || {},
    response: {
      clientDataJSON: bytesToBase64url(res.clientDataJSON),
      authenticatorData: bytesToBase64url(res.authenticatorData),
      signature: bytesToBase64url(res.signature),
      userHandle: res.userHandle ? bytesToBase64url(res.userHandle) : null,
    },
  };
}

/**
 * Discoverable (username-less) passkey login. Optional handle scopes
 * allowCredentials when the authenticator is not resident-key capable.
 */
export async function loginPasskey({ api, handle } = {}) {
  if (!hasWebAuthn()) throw new Error(webAuthnUnavailableMessage());
  if (typeof api !== "function") throw new Error("Passkey login needs the Node API helper.");
  const trimmed = String(handle || "").trim();
  const server = await api("/api/auth/passkey/login/begin", {
    method: "POST",
    body: trimmed ? { handle: trimmed } : {},
  });
  const pk = server?.publicKey || server || {};
  const allow = (pk.allowCredentials || []).map((c) => ({
    type: c.type || "public-key",
    id: coerceBytes(c.id),
    transports: c.transports,
  }));
  const assertion = await enqueueWebAuthn(() =>
    navigator.credentials.get({
      publicKey: {
        challenge: coerceBytes(pk.challenge),
        timeout: pk.timeout || 120000,
        rpId: pk.rpId || (typeof location !== "undefined" ? location.hostname : undefined),
        userVerification: pk.userVerification || "preferred",
        allowCredentials: allow.length ? allow : undefined,
        extensions: pk.extensions || { prf: {} },
      },
    })
  );
  if (!assertion) throw new Error("Passkey sign-in was cancelled.");
  return api("/api/auth/passkey/login/finish", {
    method: "POST",
    body: serializeAssertion(assertion),
  });
}

/**
 * PRF-unwrap the seed, HMAC-SHA256 the UserOp hash, drop the key from memory.
 * Production signs with secp256k1 over the ERC-4337 UserOp hash (or WebAuthn P-256).
 *
 * @param {string | BufferSource} hash
 */
export async function signUserOp(hash) {
  const rec = await idbGet();
  if (!rec) throw new Error("No passkey wallet on this device. Register first.");
  const { seed } = await unwrapWalletMaterial({ needIdentity: false });
  try {
    const msg =
      typeof hash === "string"
        ? hash.startsWith("0x")
          ? hexToBytes(hash)
          : textEncoder.encode(hash)
        : coerceBytes(hash);
    const key = await crypto.subtle.importKey(
      "raw",
      seed,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
    return {
      signature: "0x" + bytesToHex(sig),
      algorithm: "HMAC-SHA256-demo",
      address: rec.address,
      addressScheme: rec.addressScheme || ADDRESS_SCHEME,
      userOpHash: keccak256Hex(msg),
      note: "Demo signature. Production signs the ERC-4337 UserOp hash with secp256k1, or verifies a WebAuthn assertion on PasskeyAccount.",
    };
  } finally {
    zeroFill(seed);
  }
}

/**
 * Unlock identity secrets under the **identity** PRF/HKDF domain, compute a
 * per-election nullifier, and optionally encrypt a ballot. When `tallyPubKey`
 * is set, the posted envelope is P-256 ECIES to that key (tally-opens path).
 * Otherwise the legacy seed-keyed AES-GCM stand-in is used (only the voter can
 * open it). Zeroes trapdoor and account seed before return. The trapdoor is never
 * included in the returned object.
 */
export async function authorizeBallot({ electionId, ballotBytes, tallyPubKey, choiceIndex } = {}) {
  const { rec, seed, identity } = await unwrapWalletMaterial({ needIdentity: true });
  let trapdoor = identity.trapdoor;
  let nullifierSecret = identity.nullifierSecret;
  try {
    const electionKey = keccak256(String(electionId));
    const nullifier = keccak256Hex(concatBytes(nullifierSecret, electionKey));
    let encryptedBallot = null;
    let ballotHash = null;
    if (ballotBytes || choiceIndex != null) {
      if (tallyPubKey) {
        let packed;
        if (choiceIndex != null) packed = packChoices([Number(choiceIndex)]);
        else packed = coerceBytes(ballotBytes);
        encryptedBallot = await encryptToTallyPub(tallyPubKey, packed);
        ballotHash = keccak256Hex(hexToBytes(encryptedBallot));
      } else {
        const packed = coerceBytes(ballotBytes);
        const ikm = await importHkdfIkm(seed);
        const aesKey = await crypto.subtle.deriveKey(
          {
            name: "HKDF",
            hash: "SHA-256",
            salt: electionKey,
            info: textEncoder.encode("republic-ballot-elgamal-standin"),
          },
          ikm,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt"]
        );
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ciphertext = new Uint8Array(
          await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, packed)
        );
        const blob = concatBytes(iv, ciphertext);
        encryptedBallot = "0x" + bytesToHex(blob);
        ballotHash = keccak256Hex(blob);
      }
    }
    const userOpMaterial = keccak256(
      concatBytes(
        textEncoder.encode("republic.userop.v1"),
        coerceBytes(rec.address),
        electionKey,
        ballotHash ? hexToBytes(ballotHash) : new Uint8Array(32)
      )
    );
    const key = await crypto.subtle.importKey(
      "raw",
      seed,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, userOpMaterial));
    return {
      identityCommitment: identity.commitment,
      address: rec.address,
      addressScheme: rec.addressScheme || ADDRESS_SCHEME,
      nullifier,
      encryptedBallot,
      ballotHash,
      signature: "0x" + bytesToHex(signature),
      userOpHash: keccak256Hex(userOpMaterial),
      credentialId: rec.credentialId,
    };
  } finally {
    zeroFill(seed);
    zeroFill(trapdoor);
    zeroFill(nullifierSecret);
  }
}

export async function resetWallet() {
  await idbClear();
}

export function webAuthnUnavailableMessage() {
  return "Republic requires a device passkey (WebAuthn) with a resident key and user verification. Use a current browser (Safari 16+, Chrome 108+, Firefox 122+, Edge) on a device with a platform authenticator. No seed phrase is ever shown.";
}

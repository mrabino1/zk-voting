/**
 * NOT FOR PROFIT — Republic is a civic public good. Not a commercial product.
 *
 * Inertia-style passkey-held wallet for Republic.
 *
 * - WebAuthn resident key + userVerification required.
 * - When the authenticator supports the PRF extension, `prf.eval.first` is a
 *   32-byte salt; HKDF-SHA256 of that PRF output wraps a 32-byte seed with AES-GCM.
 * - The seed stands in for a secp256k1 private key. This file does not ship a
 *   curve implementation, so it cannot emit an uncompressed public key.
 * - getAddress() therefore returns `0x` + first 20 bytes of SHA-256(seed) and
 *   labels the scheme `republic-local-address`.
 * - Production (Ethereum) addresses are keccak256(uncompressed secp256k1 pubkey)[12:32].
 *   A compact keccak256 is included here for commitments, ballot hashes, and docs.
 * - NEVER render a seed phrase. The seed never leaves RAM except as AES-GCM ciphertext
 *   in IndexedDB. signUserOp() unwraps, HMAC-signs, then zeroes the seed.
 */

import { encryptToTallyPub, packChoices } from "./tally-crypto.js";
const DB_VERSION = 1;
const STORE = "wallet";
const RECORD_KEY = "primary";
const HKDF_SALT = "republic.zk-voting.prf.v1";
const WRAP_INFO = "republic-secp256k1-wrap";
const IDENTITY_SALT = "republic.identity.v1";
const IDENTITY_INFO = "trapdoor+nullifier";
const FALLBACK_INFO = "republic-prf-fallback-v1";

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
/* HKDF / AES-GCM wrap                                                        */
/* -------------------------------------------------------------------------- */

async function importHkdfIkm(raw) {
  return crypto.subtle.importKey("raw", coerceBytes(raw), "HKDF", false, ["deriveKey", "deriveBits"]);
}

async function aesKeyFromPrf(prfOutput) {
  const ikm = await importHkdfIkm(prfOutput);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: textEncoder.encode(HKDF_SALT),
      info: textEncoder.encode(WRAP_INFO),
    },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function aesKeyFromFallback(credentialIdBytes) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    concatBytes(textEncoder.encode(FALLBACK_INFO), coerceBytes(credentialIdBytes))
  );
  const ikm = await importHkdfIkm(digest);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: textEncoder.encode(HKDF_SALT),
      info: textEncoder.encode(FALLBACK_INFO),
    },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
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
 * HKDF-SHA256 the authenticator PRF output into an AES-GCM wrapping key,
 * then unwrap (or create and wrap) a 32-byte seed used as a secp256k1 stand-in.
 *
 * @param {BufferSource} prfOutput
 * @param {{ credentialId?: BufferSource, existing?: object | null }} [opts]
 * @returns {Promise<Uint8Array>} 32-byte seed — caller MUST zeroFill after use
 */
export async function deriveOrUnwrapSecp256k1(prfOutput, opts = {}) {
  const aesKey = await aesKeyFromPrf(prfOutput);
  const existing = opts.existing !== undefined ? opts.existing : await idbGet();
  if (existing?.wrappedSeed && existing.wrapScheme === "prf-hkdf-aes-gcm") {
    return decryptSeed(aesKey, existing.wrappedSeed);
  }
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const wrappedSeed = await encryptSeed(aesKey, seed);
  const publicParts = await publicFromSeed(seed);
  const record = {
    ...(existing || {}),
    version: 1,
    wrapScheme: "prf-hkdf-aes-gcm",
    wrappedSeed,
    prfSupported: true,
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
  const identity = await identityFromSeed(seed);
  return {
    address,
    addressScheme: ADDRESS_SCHEME,
    productionAddressNote: PRODUCTION_ADDRESS_NOTE,
    identityCommitment: identity.commitment,
    hasher: "keccak256(trapdoor || nullifierSecret) demo; production circuits use Poseidon",
  };
}

async function identityFromSeed(seed) {
  const ikm = await importHkdfIkm(seed);
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: textEncoder.encode(IDENTITY_SALT),
        info: textEncoder.encode(IDENTITY_INFO),
      },
      ikm,
      512
    )
  );
  const trapdoor = bits.subarray(0, 32);
  const nullifierSecret = bits.subarray(32, 64);
  const commitment = "0x" + bytesToHex(keccak256(concatBytes(trapdoor, nullifierSecret)));
  return { trapdoor, nullifierSecret, commitment };
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
      : random32();

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
  return credential;
}

function prfOutputFromCredential(credential) {
  const ext =
    typeof credential.getClientExtensionResults === "function"
      ? credential.getClientExtensionResults()
      : {};
  const first = ext?.prf?.results?.first;
  if (first) return coerceBytes(first);
  return null;
}

async function assertionWithPrf(credentialId, evalFirst, extra = {}) {
  const publicKey = {
    challenge: extra.challenge ? coerceBytes(extra.challenge) : randomChallenge(),
    timeout: 120000,
    userVerification: "required",
    rpId: extra.rpId || (typeof location !== "undefined" ? location.hostname : undefined),
    allowCredentials: credentialId
      ? [{ type: "public-key", id: coerceBytes(credentialId) }]
      : undefined,
    extensions: evalFirst
      ? { prf: { eval: { first: coerceBytes(evalFirst) } } }
      : {},
  };
  const assertion = await enqueueWebAuthn(() => navigator.credentials.get({ publicKey }));
  if (!assertion) throw new Error("Passkey assertion was cancelled.");
  return assertion;
}

async function provisionFromCredential(credential, { displayName } = {}) {
  const credentialId = new Uint8Array(credential.rawId);
  const evalFirst = credential._republicPrfEvalFirst || random32();
  let prfOut = prfOutputFromCredential(credential);
  let assertion = null;
  if (!prfOut) {
    try {
      assertion = await assertionWithPrf(credentialId, evalFirst);
      prfOut = prfOutputFromCredential(assertion);
    } catch {
      assertion = null;
    }
  }

  let seed;
  let wrapScheme;
  let prfSupported = Boolean(prfOut);
  try {
    if (prfOut) {
      wrapScheme = "prf-hkdf-aes-gcm";
      const aesKey = await aesKeyFromPrf(prfOut);
      seed = crypto.getRandomValues(new Uint8Array(32));
      const wrappedSeed = await encryptSeed(aesKey, seed);
      const publicParts = await publicFromSeed(seed);
      await idbPut({
        version: 1,
        credentialId: bytesToBase64url(credentialId),
        prfEvalFirst: bytesToBase64url(evalFirst),
        wrapScheme,
        wrappedSeed,
        prfSupported: true,
        displayName: displayName || null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...publicParts,
      });
    } else {
      wrapScheme = "uv-fallback-hkdf-aes-gcm";
      if (!assertion) {
        assertion = await assertionWithPrf(credentialId, null);
      }
      const aesKey = await aesKeyFromFallback(credentialId);
      seed = crypto.getRandomValues(new Uint8Array(32));
      const wrappedSeed = await encryptSeed(aesKey, seed);
      const publicParts = await publicFromSeed(seed);
      await idbPut({
        version: 1,
        credentialId: bytesToBase64url(credentialId),
        prfEvalFirst: bytesToBase64url(evalFirst),
        wrapScheme,
        wrappedSeed,
        prfSupported: false,
        fallbackNote:
          "PRF was unavailable. The seed is wrapped with a key derived from the credential id after userVerification. This is weaker than WebAuthn PRF and is a demo-only path.",
        displayName: displayName || null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...publicParts,
      });
    }
  } finally {
    zeroFill(seed);
    zeroFill(prfOut);
  }
  return getPublicRecord();
}

async function unwrapSeedWithUv() {
  const rec = await idbGet();
  if (!rec?.wrappedSeed) throw new Error("No passkey wallet on this device. Register first.");
  const credentialId = rec.credentialId ? base64urlToBytes(rec.credentialId) : null;
  const evalFirst = rec.prfEvalFirst ? base64urlToBytes(rec.prfEvalFirst) : random32();
  const assertion = await assertionWithPrf(credentialId, evalFirst);
  const prfOut = prfOutputFromCredential(assertion);
  try {
    if (rec.wrapScheme === "prf-hkdf-aes-gcm") {
      if (!prfOut) {
        throw new Error("This authenticator did not return a PRF output; cannot unwrap the seed.");
      }
      const aesKey = await aesKeyFromPrf(prfOut);
      return decryptSeed(aesKey, rec.wrappedSeed);
    }
    const aesKey = await aesKeyFromFallback(credentialId);
    return decryptSeed(aesKey, rec.wrappedSeed);
  } finally {
    zeroFill(prfOut);
  }
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export async function getPublicRecord() {
  try {
    const rec = await idbGet();
    if (!rec) return null;
    return {
      credentialId: rec.credentialId,
      address: rec.address,
      addressScheme: rec.addressScheme || ADDRESS_SCHEME,
      productionAddressNote: rec.productionAddressNote || PRODUCTION_ADDRESS_NOTE,
      identityCommitment: rec.identityCommitment,
      hasher: rec.hasher,
      prfSupported: Boolean(rec.prfSupported),
      wrapScheme: rec.wrapScheme,
      fallbackNote: rec.fallbackNote || null,
      displayName: rec.displayName || null,
      createdAt: rec.createdAt,
    };
  } catch {
    return null;
  }
}

export async function hasWallet() {
  const rec = await getPublicRecord();
  return Boolean(rec?.identityCommitment);
}

/**
 * Address of the passkey-held account.
 * Demo: 0x + SHA-256(seed)[0:20], scheme republic-local-address.
 * Production: keccak256(uncompressed secp256k1 pubkey)[12:32].
 */
export async function getAddress() {
  const rec = await getPublicRecord();
  if (!rec?.address) throw new Error("No passkey wallet on this device. Register first.");
  return {
    address: rec.address,
    scheme: rec.addressScheme,
    productionNote: rec.productionAddressNote,
  };
}

export async function getIdentityCommitment() {
  const rec = await getPublicRecord();
  if (!rec?.identityCommitment) throw new Error("No passkey wallet on this device. Register first.");
  return rec.identityCommitment;
}

/**
 * Register a resident-key passkey, wrap a 32-byte seed, and optionally finish
 * with the Node (`POST /api/auth/passkey/register/{begin,finish}`).
 */
export async function registerPasskey({ api, displayName } = {}) {
  let server = null;
  let finishError = null;
  if (typeof api === "function") {
    try {
      server = await api("/api/auth/passkey/register/begin", {
        method: "POST",
        body: { displayName: displayName || "voter", handle: displayName || "voter" },
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
  const credential = await createCredential(options);
  const publicRecord = await provisionFromCredential(credential, { displayName });

  if (typeof api === "function") {
    try {
      await api("/api/auth/passkey/register/finish", {
        method: "POST",
        body: {
          ...serializeAttestation(credential, publicRecord),
          handle: displayName || "voter",
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

/**
 * PRF-unwrap the seed, HMAC-SHA256 the UserOp hash, drop the key from memory.
 * Production signs with secp256k1 over the ERC-4337 UserOp hash (or WebAuthn P-256).
 *
 * @param {string | BufferSource} hash
 */
export async function signUserOp(hash) {
  const rec = await idbGet();
  if (!rec) throw new Error("No passkey wallet on this device. Register first.");
  const seed = await unwrapSeedWithUv();
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
 * Unlock identity secrets under passkey UV, compute a per-election nullifier,
 * and optionally encrypt a ballot. When `tallyPubKey` is set, the posted
 * envelope is P-256 ECIES to that key (tally-opens path). Otherwise the
 * legacy seed-keyed AES-GCM stand-in is used (only the voter can open it).
 * Zeroes trapdoor and seed before return. The trapdoor is never included
 * in the returned object.
 */
export async function authorizeBallot({ electionId, ballotBytes, tallyPubKey, choiceIndex } = {}) {
  const rec = await idbGet();
  if (!rec) throw new Error("No passkey wallet on this device. Register first.");
  const seed = await unwrapSeedWithUv();
  let trapdoor;
  let nullifierSecret;
  try {
    const ident = await identityFromSeed(seed);
    trapdoor = ident.trapdoor;
    nullifierSecret = ident.nullifierSecret;
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
      identityCommitment: ident.commitment,
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

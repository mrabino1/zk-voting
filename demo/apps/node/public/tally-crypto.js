/**
 * NOT FOR PROFIT — Republic is a civic public good. Not a commercial product.
 *
 * Demo tally encryption: P-256 ECDH (ECIES-style) + HKDF-SHA256 + AES-GCM.
 *
 * Envelope (hex):
 *   magic "RTv1" (4) || uncompressed ephemeral pubkey (65) || iv (12) || ciphertext+tag
 *
 * Plaintext:
 *   packed: 0x01 || n || choice[0]..choice[n-1]   (uint8 option indices)
 *   or JSON starting with `{` with a `choices` array.
 *
 * The envelope is hybrid encryption under a P-256 point. Elections no longer
 * keep a threshold-1 private key: the point is a Feldman t-of-n joint public
 * key, and opening it takes threshold decryption (see src/guardians/).
 * Whether those ciphertexts are aggregated homomorphically or through a mixnet
 * is an open product decision — this file only encrypts and decrypts one
 * envelope. NON-PRODUCTION. Not a binding-election ceremony.
 *
 * Uses WebCrypto so the same module runs in Node 22 (`globalThis.crypto`) and
 * in the voter SPA.
 */

export const TALLY_SCHEME_SUM_ONLY = "sum_only";
export const TALLY_SCHEME_OPENS_BALLOTS = "opens_ballots";

export const TALLY_CRYPTO_SCHEME = "p256-ecies-aesgcm-v1";
export const TALLY_ENVELOPE_MAGIC = new Uint8Array([0x52, 0x54, 0x76, 0x31]); // RTv1
export const TALLY_HKDF_INFO = "republic-tally-ecies-p256-v1";
export const TALLY_INSTANCE_VERSION = 1;

export const DEMO_KEY_WARNING =
  "NON-PRODUCTION single P-256 key used only to exercise this envelope format. Election tallies do not use it. A binding election needs the Feldman guardian ceremony, and even that ceremony is not a production Groth16 tally.";

export const GUARDIAN_SCHEME = "p256-feldman-dkg-v1";

export const GUARDIAN_WARNING =
  "NON-PRODUCTION Feldman t-of-n guardian key. Decrypting a ballot takes t verified partial decryptions. The Node does not hold a tally private key. Homomorphic aggregation and a mixnet are an open product decision; neither is selected. Not safe for a binding election.";

export const AGGREGATION_UNDECIDED = "undecided";

const P256 = { name: "ECDH", namedCurve: "P-256" };

function subtle() {
  const c = globalThis.crypto;
  if (!c || !c.subtle) {
    throw new Error("WebCrypto subtle is required for tally encryption");
  }
  return c.subtle;
}

export function bytesToHex(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "0x";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

export function hexToBytes(hex) {
  let h = String(hex || "").trim();
  if (h.startsWith("0x") || h.startsWith("0X")) h = h.slice(2);
  if (h.length % 2 !== 0) throw new Error("hexToBytes: odd length");
  if (h.length > 0 && !/^[0-9a-fA-F]+$/.test(h)) throw new Error("hexToBytes: invalid hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function concatBytes(chunks) {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function utf8Bytes(str) {
  return new TextEncoder().encode(String(str));
}

function eqMagic(bytes) {
  if (bytes.length < 4) return false;
  for (let i = 0; i < 4; i++) if (bytes[i] !== TALLY_ENVELOPE_MAGIC[i]) return false;
  return true;
}

export function isTallyEnvelope(hexOrBytes) {
  try {
    const bytes = typeof hexOrBytes === "string" ? hexToBytes(hexOrBytes) : hexOrBytes;
    return eqMagic(bytes);
  } catch {
    return false;
  }
}

export async function generateDemoGuardian() {
  const pair = await subtle().generateKey(P256, true, ["deriveBits"]);
  const rawPub = new Uint8Array(await subtle().exportKey("raw", pair.publicKey));
  const privateJwk = await subtle().exportKey("jwk", pair.privateKey);
  return {
    scheme: TALLY_CRYPTO_SCHEME,
    threshold: 1,
    guardians: 1,
    production: false,
    warning: DEMO_KEY_WARNING,
    publicKeyRaw: bytesToHex(rawPub),
    publicKeyX: bytesToHex(rawPub.slice(1, 33)),
    publicKeyY: bytesToHex(rawPub.slice(33, 65)),
    privateJwk,
  };
}

function publicRosterEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  return {
    index: entry.index,
    guardianId: entry.guardianId,
    label: entry.label || "",
    transportPublicKey: entry.transportPublicKey || null,
    commitments: Array.isArray(entry.commitments) ? entry.commitments : null,
  };
}

export function publicCeremonyView(guardian) {
  if (!guardian) return null;
  const roster = Array.isArray(guardian.roster)
    ? guardian.roster.map(publicRosterEntry).filter(Boolean)
    : undefined;
  return {
    scheme: guardian.scheme || TALLY_CRYPTO_SCHEME,
    threshold: guardian.threshold ?? 1,
    guardians: guardian.guardians ?? 1,
    production: false,
    status: guardian.status || null,
    aggregation: guardian.aggregation || null,
    warning: guardian.warning || DEMO_KEY_WARNING,
    publicKey: guardian.publicKeyRaw || guardian.publicKey || null,
    publicKeyX: guardian.publicKeyX || null,
    publicKeyY: guardian.publicKeyY || null,
    verificationKeys: guardian.verificationKeys || null,
    ...(roster ? { roster } : {}),
  };
}

async function importRawPub(rawHexOrBytes) {
  const raw = typeof rawHexOrBytes === "string" ? hexToBytes(rawHexOrBytes) : rawHexOrBytes;
  if (raw.length !== 65 || raw[0] !== 0x04) {
    throw new Error("tally pubkey must be uncompressed P-256 (65 bytes, 0x04 prefix)");
  }
  return subtle().importKey("raw", raw, P256, true, []);
}

async function importPrivateJwk(jwk) {
  const copy = { ...jwk, key_ops: ["deriveBits"] };
  return subtle().importKey("jwk", copy, P256, true, ["deriveBits"]);
}

async function aesFromShared(sharedBits) {
  const ikm = await subtle().importKey("raw", sharedBits, "HKDF", false, ["deriveKey"]);
  return subtle().deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: utf8Bytes("republic.tally.salt.v1"),
      info: utf8Bytes(TALLY_HKDF_INFO),
    },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptToTallyPub(publicKeyRaw, plaintext) {
  const theirPub = await importRawPub(publicKeyRaw);
  const eph = await subtle().generateKey(P256, true, ["deriveBits"]);
  const ephRaw = new Uint8Array(await subtle().exportKey("raw", eph.publicKey));
  const shared = await subtle().deriveBits({ name: "ECDH", public: theirPub }, eph.privateKey, 256);
  const aesKey = await aesFromShared(shared);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const plain =
    plaintext instanceof Uint8Array
      ? plaintext
      : typeof plaintext === "string"
        ? utf8Bytes(plaintext)
        : new Uint8Array(plaintext);
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv }, aesKey, plain));
  return bytesToHex(concatBytes([TALLY_ENVELOPE_MAGIC, ephRaw, iv, ct]));
}

export function tallyEnvelopeEphemeral(envelopeHex) {
  const bytes = typeof envelopeHex === "string" ? hexToBytes(envelopeHex) : envelopeHex;
  if (!eqMagic(bytes)) throw new Error("not a Republic tally envelope (missing RTv1 magic)");
  if (bytes.length < 4 + 65 + 12 + 16) throw new Error("tally envelope too short");
  return bytes.slice(4, 69);
}

/**
 * Finish an envelope once the ECDH x-coordinate is known (32 bytes).
 * Threshold decryption recovers that coordinate from partials; it does not
 * pass the joint private scalar through here.
 */
export async function decryptTallyEnvelopeWithSharedBits(sharedBits, envelopeHex) {
  const bytes = typeof envelopeHex === "string" ? hexToBytes(envelopeHex) : envelopeHex;
  if (!eqMagic(bytes)) throw new Error("not a Republic tally envelope (missing RTv1 magic)");
  if (bytes.length < 4 + 65 + 12 + 16) throw new Error("tally envelope too short");
  const iv = bytes.subarray(69, 81);
  const ct = bytes.subarray(81);
  const ikm = sharedBits instanceof ArrayBuffer ? new Uint8Array(sharedBits) : sharedBits;
  const aesKey = await aesFromShared(ikm);
  return new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv }, aesKey, ct));
}

export async function decryptTallyEnvelope(privateJwk, envelopeHex) {
  const bytes = typeof envelopeHex === "string" ? hexToBytes(envelopeHex) : envelopeHex;
  const ephRaw = tallyEnvelopeEphemeral(bytes);
  const ephPub = await subtle().importKey("raw", ephRaw, P256, true, []);
  const priv = await importPrivateJwk(privateJwk);
  const shared = await subtle().deriveBits({ name: "ECDH", public: ephPub }, priv, 256);
  return decryptTallyEnvelopeWithSharedBits(shared, bytes);
}

export function packChoices(choices) {
  const list = Array.isArray(choices) ? choices : [choices];
  if (list.length > 255) throw new Error("too many choice slots");
  const out = new Uint8Array(2 + list.length);
  out[0] = 1;
  out[1] = list.length;
  for (let i = 0; i < list.length; i++) {
    const n = Number(list[i]);
    if (!Number.isInteger(n) || n < 0 || n > 255) throw new Error("choice must be uint8");
    out[2 + i] = n;
  }
  return out;
}

export function unpackChoices(plainBytes) {
  const bytes = plainBytes instanceof Uint8Array ? plainBytes : new Uint8Array(plainBytes);
  if (bytes.length === 0) throw new Error("empty plaintext");
  if (bytes[0] === 0x7b) {
    const json = JSON.parse(new TextDecoder().decode(bytes));
    if (Array.isArray(json.choices)) return json.choices.map((n) => Number(n));
    if (Array.isArray(json.openings)) return json.openings.map((n) => Number(n));
    throw new Error("JSON ballot plaintext missing choices[]");
  }
  if (bytes[0] !== 1) throw new Error("unknown ballot plaintext version");
  const n = bytes[1];
  if (bytes.length < 2 + n) throw new Error("truncated packed choices");
  return Array.from(bytes.subarray(2, 2 + n));
}

export function expectedCountLength(questions) {
  if (!Array.isArray(questions) || questions.length === 0) return 0;
  return questions.reduce((n, q) => n + Math.max(q.options?.length || 0, 1), 0);
}

/**
 * Map a marked ballot's answers onto a single index in the concatenated
 * option vector (first selected option across questions, first question first).
 * Compatible with sum(counts) == acceptedBallots.
 */
export function openingIndexFromAnswers(answers, questions) {
  if (!Array.isArray(questions) || questions.length === 0) return 0;
  let offset = 0;
  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi];
    const opts = Array.isArray(q.options) ? q.options : [];
    const width = Math.max(opts.length, 1);
    const ans =
      (Array.isArray(answers) &&
        answers.find((a) => String(a.questionId) === String(q.id))) ||
      (Array.isArray(answers) ? answers[qi] : null);
    const selected = ans?.optionIds?.[0] ?? ans?.optionId ?? ans?.choice;
    if (selected != null && selected !== "") {
      const local = opts.findIndex(
        (o) =>
          String(o.id) === String(selected) ||
          String(o.label) === String(selected) ||
          String(o) === String(selected),
      );
      if (local >= 0) return offset + local;
      const asNum = Number(selected);
      if (Number.isInteger(asNum) && asNum >= 0 && asNum < width) return offset + asNum;
    }
    offset += width;
  }
  return 0;
}

export function histogramFromOpenings(openings, nSlots) {
  const n = Number(nSlots);
  if (!Number.isInteger(n) || n < 1) throw new Error("nSlots must be a positive integer");
  const counts = Array(n).fill(0);
  for (const raw of openings) {
    const i = Number(raw);
    if (!Number.isInteger(i) || i < 0 || i >= n) {
      throw new Error(`option index ${raw} out of range 0..${n - 1}`);
    }
    counts[i] += 1;
  }
  return counts;
}

export function countsEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (Number(a[i]) !== Number(b[i])) return false;
  return true;
}

export function normalizeTallyScheme(value, { opensBallots } = {}) {
  if (opensBallots === true || value === true) return TALLY_SCHEME_OPENS_BALLOTS;
  if (value == null || value === "") {
    return TALLY_SCHEME_SUM_ONLY;
  }
  const s = String(value).trim().toLowerCase();
  if (s === "1" || s === "opens_ballots" || s === "opens-ballots" || s === "open") {
    return TALLY_SCHEME_OPENS_BALLOTS;
  }
  if (s === "0" || s === "sum_only" || s === "sum-only" || s === "legacy") {
    return TALLY_SCHEME_SUM_ONLY;
  }
  throw new Error(`unknown tallyScheme ${value}`);
}

export function schemeToUint8(scheme) {
  return scheme === TALLY_SCHEME_OPENS_BALLOTS ? 1 : 0;
}

/**
 * NOT FOR PROFIT — civic public good, not a commercial product.
 *
 * Sealed ranked-choice envelope. The full ranking is encrypted to the
 * election's guardian (threshold) public key Y and can only be opened after
 * the deadline, when guardians post partial decryptions of C1.
 *
 * Layout (bytes):
 *   "RK" (0x52 0x4b) || version (1) || C1 (65, uncompressed P-256) || iv (12) || AES-256-GCM ciphertext
 *
 *   C1 = k·G, S = k·Y (recovered by guardians as Σ λ_i·(s_i·C1)).
 *   key = SHA-256("zk-voting/ranking/v1|" || electionId || "|" || S.x)
 *   AAD = "zk-voting/ranking/v1|" || electionId
 *
 * The plaintext is padded to ONE fixed size per election (rankingPadBytes,
 * derived from the ballot's questions and option count), so every envelope in
 * an election has the same length. `rankingHash` = SHA-256(envelope bytes).
 * The voter binds it into the proven AG ballot tag at cast time, and the
 * relayer carries it (sorted) in BallotInbox.submitVoteBatchRanked.
 *
 * The plaintext also carries the AG first choice and its tag randomness, so
 * the tally can check per ballot that tag == Poseidon(Poseidon(choice, r), rankingHash).
 *
 * Limits: rankings are opened one by one at the deadline. There is no verified
 * shuffle yet, so an operator who also holds the voter-to-submission link could
 * read a ranking. The plurality one-hot ciphertext is still the proven path.
 */

import { P256_G, p256Mul, pointFromRaw, pointToRaw, randomScalar } from "./p256-math.js";

export const RANKING_MAGIC = new Uint8Array([0x52, 0x4b]);
export const RANKING_VERSION = 1;
const DOMAIN = "zk-voting/ranking/v1|";
const POINT = 65;
const IV = 12;
const MIN_PLAIN = 64;
const ALIGN = 64;

const enc = new TextEncoder();
const dec = new TextDecoder();

function subtle() {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("WebCrypto subtle is required");
  return s;
}

export function bytesToHex(bytes) {
  let s = "0x";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

export function hexToBytes(hex) {
  let h = String(hex || "").trim();
  if (h.startsWith("0x") || h.startsWith("0X")) h = h.slice(2);
  if (h.length % 2 !== 0 || /[^0-9a-fA-F]/.test(h)) throw new Error("bad hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function x32(point) {
  return hexToBytes(point.x.toString(16).padStart(64, "0"));
}

async function deriveKey(electionId, sharedX) {
  const pre = enc.encode(`${DOMAIN}${String(electionId)}|`);
  const buf = new Uint8Array(pre.length + sharedX.length);
  buf.set(pre, 0);
  buf.set(sharedX, pre.length);
  const digest = new Uint8Array(await subtle().digest("SHA-256", buf));
  return subtle().importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/**
 * Fixed plaintext size for one election: the longest possible plaintext
 * (every question, every option ranked, maximal first-choice fields), rounded
 * up. Same answer in the browser and on the node.
 */
export function rankingPadBytes(questions) {
  const qs = Array.isArray(questions) ? questions : [];
  const answers = qs.map((q) => ({
    questionId: String(q?.id ?? ""),
    ranking: (Array.isArray(q?.options) ? q.options : []).map((o) => String(o?.id ?? o?.label ?? o)),
  }));
  const longest = JSON.stringify({
    v: RANKING_VERSION,
    answers,
    first: { index: 65535, r: "9".repeat(78) },
  });
  const n = Math.max(MIN_PLAIN, enc.encode(longest).length + 1);
  return Math.ceil(n / ALIGN) * ALIGN;
}

/** Envelope byte length for an election's fixed plaintext size. */
export function rankingEnvelopeBytes(questions) {
  return 3 + POINT + IV + rankingPadBytes(questions) + 16;
}

function pad(json, size) {
  const body = enc.encode(json);
  if (body.length >= size) {
    throw Object.assign(new Error("ranking does not fit the election's envelope size"), { code: "BAD_RANKING" });
  }
  const out = new Uint8Array(size).fill(0x20);
  out.set(body, 0);
  return out;
}

/** Ranked answers only: [{ questionId, ranking: [optionId...] }]. */
export function rankingAnswers(answers) {
  return (Array.isArray(answers) ? answers : []).map((a) => ({
    questionId: String(a.questionId),
    ranking: (Array.isArray(a.ranking) ? a.ranking : Array.isArray(a.optionIds) ? a.optionIds : []).map(String),
  }));
}

export function isRankingEnvelope(hexOrBytes) {
  try {
    const b = typeof hexOrBytes === "string" ? hexToBytes(hexOrBytes) : hexOrBytes;
    return (
      b instanceof Uint8Array &&
      b.length >= 3 + POINT + IV + 16 + MIN_PLAIN &&
      b[0] === 0x52 &&
      b[1] === 0x4b &&
      b[2] === RANKING_VERSION &&
      b[3] === 0x04
    );
  } catch {
    return false;
  }
}

export function parseRankingEnvelope(hexOrBytes) {
  const b = typeof hexOrBytes === "string" ? hexToBytes(hexOrBytes) : hexOrBytes;
  if (!isRankingEnvelope(b)) throw Object.assign(new Error("not a ranking envelope"), { code: "BAD_RANKING" });
  const c1 = b.subarray(3, 3 + POINT);
  pointFromRaw(c1);
  return {
    c1Hex: bytesToHex(c1),
    iv: b.subarray(3 + POINT, 3 + POINT + IV),
    ciphertext: b.subarray(3 + POINT + IV),
  };
}

export async function rankingHash(hexOrBytes) {
  const b = typeof hexOrBytes === "string" ? hexToBytes(hexOrBytes) : hexOrBytes;
  return bytesToHex(new Uint8Array(await subtle().digest("SHA-256", b)));
}

/**
 * @param {{ jointPublicKey: string, electionId: string|number, answers: object[], questions: object[],
 *   first?: { index: number, r: string|bigint }, scalar?: bigint }} opts
 * @returns {Promise<{ rankingEnvelope: string, rankingHash: string }>}
 */
export async function encryptRankingEnvelope({ jointPublicKey, electionId, answers, questions, first, scalar }) {
  if (!jointPublicKey) throw Object.assign(new Error("election public key missing"), { code: "CEREMONY_INCOMPLETE" });
  const Y = pointFromRaw(hexToBytes(jointPublicKey));
  const k = scalar ?? randomScalar();
  const c1 = pointToRaw(p256Mul(k, P256_G));
  const shared = p256Mul(k, Y);
  const key = await deriveKey(electionId, x32(shared));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV));
  const doc = { v: RANKING_VERSION, answers: rankingAnswers(answers) };
  if (first && first.index != null && first.r != null) doc.first = { index: Number(first.index), r: String(first.r) };
  const plain = pad(JSON.stringify(doc), rankingPadBytes(questions));
  const ct = new Uint8Array(
    await subtle().encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(`${DOMAIN}${String(electionId)}`) }, key, plain),
  );
  const out = new Uint8Array(3 + POINT + IV + ct.length);
  out.set(RANKING_MAGIC, 0);
  out[2] = RANKING_VERSION;
  out.set(c1, 3);
  out.set(iv, 3 + POINT);
  out.set(ct, 3 + POINT + IV);
  return { rankingEnvelope: bytesToHex(out), rankingHash: await rankingHash(out) };
}

/**
 * Open one envelope with the combined guardian point S = x·C1 (uncompressed raw bytes or {x,y}).
 * @returns {Promise<{ questionId: string, ranking: string[] }[]>}
 */
export async function decryptRankingEnvelope(opts) {
  return (await openRankingEnvelope(opts)).answers;
}

/**
 * Like decryptRankingEnvelope, plus the bound first choice when present.
 * @returns {Promise<{ answers: object[], first: { index: number, r: string } | null }>}
 */
export async function openRankingEnvelope({ envelope, electionId, sharedPoint }) {
  const parsed = parseRankingEnvelope(envelope);
  const sx =
    sharedPoint instanceof Uint8Array ? sharedPoint.subarray(1, 33) : x32(sharedPoint);
  const key = await deriveKey(electionId, sx);
  let plain;
  try {
    plain = new Uint8Array(
      await subtle().decrypt(
        { name: "AES-GCM", iv: parsed.iv, additionalData: enc.encode(`${DOMAIN}${String(electionId)}`) },
        key,
        parsed.ciphertext,
      ),
    );
  } catch {
    throw Object.assign(new Error("ranking envelope did not decrypt"), { code: "RANKING_DECRYPT_FAILED" });
  }
  const doc = JSON.parse(dec.decode(plain).trimEnd());
  if (doc?.v !== RANKING_VERSION || !Array.isArray(doc.answers)) {
    throw Object.assign(new Error("ranking plaintext is malformed"), { code: "RANKING_DECRYPT_FAILED" });
  }
  const first =
    doc.first && Number.isInteger(doc.first.index) && /^[0-9]{1,78}$/.test(String(doc.first.r))
      ? { index: doc.first.index, r: String(doc.first.r) }
      : null;
  return { answers: rankingAnswers(doc.answers), first };
}

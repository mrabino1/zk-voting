/**
 * NOT FOR PROFIT — ZK-Voting is a civic public good. Not a commercial product.
 *
 * Session-less vote pass (RSA blind signature, RSA-FDH). The browser picks a
 * random token, blinds it, and asks the Node to sign the blinded value on a
 * signed-in request (session + vote PIN + any external-party clearance). It
 * unblinds locally and casts the ballot WITHOUT cookies, presenting
 * { token, signature }. The Node cannot link the pass it verifies to the
 * request that issued it. The FDH must match src/votePass.mjs (tested).
 */

export const VOTE_PASS_DOMAIN = "zk-voting.vote-pass.v1";

function hexToBigInt(h) {
  const s = String(h || "").replace(/^0x/i, "");
  return s ? BigInt(`0x${s}`) : 0n;
}

function bigIntToHex(n) {
  let h = n.toString(16);
  if (h.length % 2) h = `0${h}`;
  return h;
}

function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function byteLen(n) {
  return Math.ceil(n.toString(2).length / 8);
}

function modPow(base, exp, mod) {
  let result = 1n;
  let b = ((base % mod) + mod) % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

function modInverse(a, m) {
  let oldR = ((a % m) + m) % m;
  let r = m;
  let oldS = 1n;
  let s = 0n;
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  if (oldR !== 1n) throw new Error("blind factor not invertible");
  return ((oldS % m) + m) % m;
}

function randomBytes(len) {
  const out = new Uint8Array(len);
  globalThis.crypto.getRandomValues(out);
  return out;
}

export async function fdh(nHex, electionId, tokenHex) {
  const n = hexToBigInt(nHex);
  const need = byteLen(n);
  const enc = new TextEncoder();
  const parts = [];
  let total = 0;
  for (let i = 0; total < need; i += 1) {
    const msg = enc.encode(`${VOTE_PASS_DOMAIN}\u0000${String(electionId)}\u0000${String(tokenHex).toLowerCase()}\u0000${i}`);
    const h = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", msg));
    parts.push(h);
    total += h.length;
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    buf.set(p, off);
    off += p.length;
  }
  return hexToBigInt(bytesToHex(buf.subarray(0, need))) % n;
}

/** Blind a fresh random token for this election. Keep the result in memory only. */
export async function blindVotePass(key, electionId) {
  const n = hexToBigInt(key.n);
  const e = hexToBigInt(key.e);
  const token = bytesToHex(randomBytes(32));
  let r = 0n;
  while (r < 2n) r = hexToBigInt(bytesToHex(randomBytes(byteLen(n)))) % n;
  const m = await fdh(key.n, electionId, token);
  const blinded = (m * modPow(r, e, n)) % n;
  return { token, r: bigIntToHex(r), blinded: bigIntToHex(blinded) };
}

/** Unblind the Node's signature and check it before use. */
export async function unblindVotePass(key, electionId, pending, blindSignatureHex) {
  const n = hexToBigInt(key.n);
  const e = hexToBigInt(key.e);
  const s = (hexToBigInt(blindSignatureHex) * modInverse(hexToBigInt(pending.r), n)) % n;
  const m = await fdh(key.n, electionId, pending.token);
  if (modPow(s, e, n) !== m) throw new Error("vote pass signature did not verify");
  return { token: pending.token, signature: bigIntToHex(s) };
}

/**
 * Full flow. `api` is the SPA fetch helper. The issuance request carries the
 * session (and PIN token / identity commitment); the returned pass does not.
 */
export async function obtainVotePass(api, electionId, { pinToken, identityCommitment } = {}) {
  const key = await api(`/api/elections/${encodeURIComponent(electionId)}/vote-pass`);
  const pending = await blindVotePass(key, electionId);
  const res = await api(`/api/elections/${encodeURIComponent(electionId)}/vote-pass`, {
    method: "POST",
    body: {
      blinded: pending.blinded,
      ...(pinToken ? { pinToken } : {}),
      ...(identityCommitment != null && identityCommitment !== "" ? { identityCommitment: String(identityCommitment) } : {}),
    },
  });
  return unblindVotePass(key, electionId, pending, res.blindSignature);
}

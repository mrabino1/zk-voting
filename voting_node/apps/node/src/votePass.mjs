// NOT FOR PROFIT — civic public good, not a commercial product.
//
// Session-less vote passes (RSA blind signatures, RSA-FDH).
//
// Eligibility checks that need to know WHO is voting (signed-in session, vote
// PIN, external-party clearance of an identity commitment) happen on a
// separate request: POST /api/elections/:id/vote-pass. The browser sends only
// a *blinded* value there. The Node signs it without ever seeing the token.
// The browser unblinds, then casts the ballot on POST /api/elections/:id/vote
// without cookies, presenting { token, signature }. The Node can check the
// signature, but it cannot tell which issuance the pass came from — the blind
// factor never leaves the browser. So the vote request carries no session, no
// user id and no identity commitment, and nothing persistent ties a user to a
// nullifier.
//
// The FDH below must match public/vote-pass.js byte for byte (tested).

import { createHash, generateKeyPairSync, createPrivateKey, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { HttpError } from './http.mjs';
import { migrate, putSecretIfAbsent, readSecret, usingPostgres } from './db.mjs';

export const VOTE_PASS_DOMAIN = 'zk-voting.vote-pass.v1';
const SECRET_NAME = 'vote-pass-rsa';
const FILE_NAME = 'vote-pass.key.json';

function b64uToBigInt(s) {
  const hex = Buffer.from(String(s), 'base64url').toString('hex');
  return hex ? BigInt(`0x${hex}`) : 0n;
}

export function bigIntToHex(n) {
  let h = n.toString(16);
  if (h.length % 2) h = `0${h}`;
  return h;
}

export function hexToBigInt(h) {
  const s = String(h || '').trim().replace(/^0x/i, '');
  if (!s || !/^[0-9a-f]+$/i.test(s)) throw new HttpError(400, 'bad hex value', { code: 'VOTE_PASS_BAD' });
  return BigInt(`0x${s}`);
}

export function modPow(base, exp, mod) {
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

function byteLen(n) {
  return Math.ceil(n.toString(2).length / 8);
}

/** Full-domain hash of (electionId, token) into Z_n. Mirrors public/vote-pass.js. */
export function fdh(nHex, electionId, tokenHex) {
  const n = typeof nHex === 'bigint' ? nHex : hexToBigInt(nHex);
  const need = byteLen(n);
  const chunks = [];
  let total = 0;
  for (let i = 0; total < need; i += 1) {
    const h = createHash('sha256')
      .update(`${VOTE_PASS_DOMAIN}\u0000${String(electionId)}\u0000${String(tokenHex).toLowerCase()}\u0000${i}`, 'utf8')
      .digest();
    chunks.push(h);
    total += h.length;
  }
  const buf = Buffer.concat(chunks).subarray(0, need);
  return BigInt(`0x${buf.toString('hex')}`) % n;
}

function keyFromJwk(jwk) {
  return {
    n: b64uToBigInt(jwk.n),
    e: b64uToBigInt(jwk.e),
    d: b64uToBigInt(jwk.d),
  };
}

function mintJwk() {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 0x10001 });
  return privateKey.export({ format: 'jwk' });
}

/** Load (or mint) the RSA vote-pass key the same way the receipt PDF secret is stored. */
export async function loadVotePassJwk(config, { mint = true } = {}) {
  const fromEnv = String(process.env.VOTE_PASS_RSA_JWK || '').trim();
  if (fromEnv) return JSON.parse(fromEnv);
  if (usingPostgres(config)) {
    await migrate(config, { quiet: config.quiet });
    const stored = await readSecret(config, SECRET_NAME);
    if (stored) return JSON.parse(stored);
    if (!mint) return null;
    return JSON.parse(await putSecretIfAbsent(config, SECRET_NAME, JSON.stringify(mintJwk())));
  }
  const dir = config?.dataDir;
  if (!dir) return mint ? mintJwk() : null;
  const file = path.join(dir, FILE_NAME);
  try {
    const existing = (await fs.readFile(file, 'utf8')).trim();
    if (existing) return JSON.parse(existing);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (!mint) return null;
  const jwk = mintJwk();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(jwk)}\n`, { encoding: 'utf8', mode: 0o600 });
  return jwk;
}

export function hashVotePassToken(tokenHex) {
  return createHash('sha256').update(`${VOTE_PASS_DOMAIN}:spent:${String(tokenHex).toLowerCase()}`, 'utf8').digest('hex');
}

/**
 * Vote-pass service. `issued` is in memory only: it caps one pass per signed-in
 * user / identity commitment per election per process without writing who
 * asked for a pass to disk. Spent passes are stored as a sorted set of hashes
 * (no order, no timestamp) by the store.
 */
export function createVotePassService(config) {
  let keyPromise = null;
  const issued = new Map();

  async function key() {
    if (config.votePassJwk) return keyFromJwk(config.votePassJwk);
    if (!keyPromise) {
      keyPromise = loadVotePassJwk(config, { mint: config.writerActive !== false }).then((jwk) => {
        if (!jwk) throw new HttpError(503, 'vote pass key not ready', { code: 'VOTE_PASS_KEY' });
        // Sanity check the key parses.
        createPrivateKey({ key: jwk, format: 'jwk' });
        config.votePassJwk = jwk;
        return keyFromJwk(jwk);
      });
      keyPromise.catch(() => {
        keyPromise = null;
      });
    }
    return keyPromise;
  }

  async function publicKey() {
    const k = await key();
    return { alg: 'RSA-FDH-BLIND', domain: VOTE_PASS_DOMAIN, n: bigIntToHex(k.n), e: bigIntToHex(k.e) };
  }

  function claimIssue(electionId, subject) {
    if (!subject) return;
    const k = `${electionId}\u0000${subject}`;
    if (issued.has(k)) {
      throw new HttpError(409, 'a vote pass was already issued for this voter in this election', {
        code: 'VOTE_PASS_ALREADY_ISSUED',
      });
    }
    issued.set(k, true);
  }

  async function signBlinded(blindedHex) {
    const k = await key();
    const m = hexToBigInt(blindedHex);
    if (m <= 1n || m >= k.n) throw new HttpError(400, 'blinded value out of range', { code: 'VOTE_PASS_BAD' });
    return bigIntToHex(modPow(m, k.d, k.n));
  }

  async function verify(electionId, pass) {
    const token = String(pass?.token || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(token)) throw new HttpError(400, 'vote pass token malformed', { code: 'VOTE_PASS_BAD' });
    const k = await key();
    const sig = hexToBigInt(pass?.signature);
    if (sig <= 0n || sig >= k.n || modPow(sig, k.e, k.n) !== fdh(k.n, electionId, token)) {
      throw new HttpError(403, 'vote pass signature invalid', { code: 'VOTE_PASS_INVALID' });
    }
    return hashVotePassToken(token);
  }

  /** Test / CLI helper: blind, sign, unblind in one process. Never used by the shipped client. */
  async function mintForTest(electionId) {
    const k = await key();
    const token = randomBytes(32).toString('hex');
    let r;
    do {
      r = BigInt(`0x${randomBytes(byteLen(k.n)).toString('hex')}`) % k.n;
    } while (r < 2n);
    const blinded = (fdh(k.n, electionId, token) * modPow(r, k.e, k.n)) % k.n;
    const s = hexToBigInt(await signBlinded(bigIntToHex(blinded)));
    const sig = (s * modInverse(r, k.n)) % k.n;
    return { token, signature: bigIntToHex(sig) };
  }

  return { publicKey, claimIssue, signBlinded, verify, mintForTest };
}

export function modInverse(a, m) {
  let [oldR, r] = [((a % m) + m) % m, m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  if (oldR !== 1n) throw new Error('not invertible');
  return ((oldS % m) + m) % m;
}

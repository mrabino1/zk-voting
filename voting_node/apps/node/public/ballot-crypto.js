/**
 * NOT FOR PROFIT — civic public good, not a commercial product.
 *
 * Ballot and guardian cryptography for the ZK-Voting rollup, shared by the browser,
 * the node and the L2 operator. Matches smart-contracts/src/libraries/{BabyJub,Guardians,StateTree}.sol.
 *
 * - Baby Jubjub (twisted Edwards over the BN254 scalar field), identity (0, 1).
 * - A ballot is one exponential-ElGamal ciphertext per option under the election's joint key,
 *   with a disjunctive Chaum-Pedersen proof that each encrypts 0 or 1 and a proof that they
 *   sum to exactly 1. Neither proof needs the voter's secrets to check.
 * - Guardians: Feldman DKG with identity-key signatures, Chaum-Pedersen decryption shares,
 *   Lagrange combination. Challenges use the same ABI encodings as Guardians.sol.
 * - Only sums are ever decrypted. There is no function here that opens one ballot.
 */

import { keccak256 } from "./keccak.js";
import { poseidonHashLeftRight } from "./poseidon.js";

export const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const ORDER = 2736030358979909402780800718157159386076813972158567259200215660948447373041n;
const A = 168700n;
const D = 168696n;
export const G = Object.freeze([
  5299619240641551281634865583518297030282874472190772894086521144482721001553n,
  16950150798460657717958625567821834550301663161624707787222815936182638968203n,
]);
export const IDENTITY = Object.freeze([0n, 1n]);

const mod = (a, m = P) => ((a % m) + m) % m;

function inv(a, m = P) {
  let [r0, r1] = [mod(a, m), m];
  let [s0, s1] = [1n, 0n];
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  if (r0 !== 1n) throw new Error("not invertible");
  return mod(s0, m);
}

// ------------------------------------------------------------------------ curve

export function onCurve([x, y]) {
  if (x < 0n || y < 0n || x >= P || y >= P) return false;
  const x2 = (x * x) % P;
  const y2 = (y * y) % P;
  return mod(A * x2 + y2) === mod(1n + ((D * x2) % P) * y2);
}

export function add([x1, y1], [x2, y2]) {
  const t = (D * x1 * x2 * y1 * y2) % P;
  const x3 = mod((x1 * y2 + y1 * x2) * inv(1n + t));
  const y3 = mod((y1 * y2 - A * x1 * x2) * inv(1n - t));
  return [x3, y3];
}

export const neg = ([x, y]) => [x === 0n ? 0n : P - x, y];
export const sub = (a, b) => add(a, neg(b));
export const eq = (a, b) => a[0] === b[0] && a[1] === b[1];

// Projective twisted-Edwards formulas (as BabyJub.sol): one inversion per multiplication.
function addProj([X1, Y1, Z1], [X2, Y2, Z2]) {
  const a = (Z1 * Z2) % P;
  const b = (a * a) % P;
  const c = (X1 * X2) % P;
  const d = (Y1 * Y2) % P;
  const e = (((D * c) % P) * d) % P;
  const f = mod(b - e);
  const g = (b + e) % P;
  const x3 = (((a * f) % P) * mod((X1 + Y1) * (X2 + Y2) - c - d)) % P;
  const y3 = (((a * g) % P) * mod(d - A * c)) % P;
  return [x3, y3, (f * g) % P];
}

function dblProj([X1, Y1, Z1]) {
  const b = ((X1 + Y1) * (X1 + Y1)) % P;
  const c = (X1 * X1) % P;
  const d = (Y1 * Y1) % P;
  const e = (A * c) % P;
  const f = (e + d) % P;
  const h = (Z1 * Z1) % P;
  const j = mod(f - 2n * h);
  return [(mod(b - c - d) * j) % P, (f * mod(e - d)) % P, (f * j) % P];
}

function mulRaw(p, k) {
  let acc = [0n, 1n, 1n];
  let base = [p[0], p[1], 1n];
  while (k > 0n) {
    if (k & 1n) acc = addProj(acc, base);
    base = dblProj(base);
    k >>= 1n;
  }
  const zi = inv(acc[2]);
  return [(acc[0] * zi) % P, (acc[1] * zi) % P];
}

/** `s · p` with the scalar reduced mod ORDER (p must be in the prime subgroup). */
export function mul(p, s) {
  return mulRaw(p, mod(BigInt(s), ORDER));
}

export const mulBase = (s) => mul(G, s);

/** On the curve, not the identity, and of prime order (as BabyJub.inSubgroup). */
export function inSubgroup(p) {
  if (!onCurve(p) || eq(p, IDENTITY)) return false;
  return eq(mulRaw(p, ORDER), IDENTITY);
}

export function randomScalar() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(64));
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  const s = n % ORDER;
  return s === 0n ? 1n : s;
}

// -------------------------------------------------------------------- encoding

const toBig = (v) => (typeof v === "bigint" ? v : BigInt(v));

function word(v) {
  let n = toBig(v);
  if (n < 0n) n = (1n << 256n) + n;
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i -= 1) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * Solidity `abi.encode` for words, `uint256[]` and `string`.
 * Values: bigint | number | `{ array: bigint[] }` | `{ string: "…" }`.
 */
export function abiEncode(values) {
  const heads = [];
  const tails = [];
  let tailOffset = 32 * values.length;
  for (const v of values) {
    if (v && typeof v === "object" && ("array" in v || "string" in v)) {
      heads.push(word(tailOffset));
      let tail;
      if ("array" in v) {
        tail = concat([word(v.array.length), ...v.array.map(word)]);
      } else {
        const bytes = new TextEncoder().encode(v.string);
        const padded = new Uint8Array(Math.ceil(bytes.length / 32) * 32);
        padded.set(bytes);
        tail = concat([word(bytes.length), padded]);
      }
      tails.push(tail);
      tailOffset += tail.length;
    } else {
      heads.push(word(v));
    }
  }
  return concat([...heads, ...tails]);
}

export function bytesToBigInt(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

export const keccakWord = (bytes) => bytesToBigInt(keccak256(bytes));
const challenge = (values) => keccakWord(abiEncode(values)) % ORDER;
const domain = (name) => keccakWord(new TextEncoder().encode(name));

export const DOMAINS = Object.freeze({
  pok: domain("zk-voting.guardian.pok.v1"),
  auth: domain("zk-voting.guardian.auth.v1"),
  share: domain("zk-voting.guardian.share.v1"),
  decrypt: domain("zk-voting.guardian.decrypt.v1"),
  bit: domain("zk-voting.ballot.bit.v1"),
  sum: domain("zk-voting.ballot.sum.v1"),
});

/** Where challenges are bound: the chain and the rollup contract. */
export function contextOf({ chainId, rollup }) {
  return { chainId: toBig(chainId), rollup: toBig(rollup) };
}

// ----------------------------------------------------------------------- hashes

export const poseidon2 = (a, b) => poseidonHashLeftRight(a, b);

/** `H(…H(H(x0, x1), x2)…, xn)`, as StateTree.fold. */
export function fold(words) {
  if (!words.length) return 0n;
  let h = toBig(words[0]);
  for (let i = 1; i < words.length; i += 1) h = poseidon2(h, words[i]);
  return h;
}

export const flatten = (cts) => cts.flatMap(([c1, c2]) => [c1[0], c1[1], c2[0], c2[1]]);

/** Hiding commitment to a ballot vector: the fold of every coordinate. */
export const ballotCommitment = (cts) => fold(flatten(cts));

/** `fold(c1x₀, c1y₀, c2x₀, c2y₀, …)`, as StateTree.accumulatorHash. */
export const accumulatorHash = (acc) => fold(flatten(acc));

/** `Poseidon(nullifierSecret, electionId)`: one per voter per election. */
export const nullifierOf = (nullifierSecret, electionId) => poseidon2(mod(toBig(nullifierSecret)), toBig(electionId));

// ---------------------------------------------------------------------- ballots

export const emptyAccumulator = (options) => Array.from({ length: options }, () => [IDENTITY, IDENTITY]);

export function addCiphertexts(acc, cts) {
  if (acc.length !== cts.length) throw new Error("option count mismatch");
  return acc.map(([a1, a2], i) => [add(a1, cts[i][0]), add(a2, cts[i][1])]);
}

export function subCiphertexts(acc, cts) {
  if (acc.length !== cts.length) throw new Error("option count mismatch");
  return acc.map(([a1, a2], i) => [sub(a1, cts[i][0]), sub(a2, cts[i][1])]);
}

function bitChallenge(ctx, electionId, option, pk, c1, c2, a0, b0, a1, b1) {
  return challenge([
    DOMAINS.bit, ctx.chainId, ctx.rollup, electionId, option,
    ...pk, ...c1, ...c2, ...a0, ...b0, ...a1, ...b1,
  ]);
}

function sumChallenge(ctx, electionId, pk, c1, c2m, a, b) {
  return challenge([DOMAINS.sum, ctx.chainId, ctx.rollup, electionId, ...pk, ...c1, ...c2m, ...a, ...b]);
}

/**
 * Encrypt a one-hot vote for `choice` under `jointKey`, with its validity proof.
 * Returns `{ ciphertexts: [[c1, c2], …], proof }`. The randomness is discarded.
 */
export function encryptBallot({ ctx, electionId, jointKey, optionCount, choice }) {
  const n = Number(optionCount);
  const c = Number(choice);
  if (!Number.isInteger(c) || c < 0 || c >= n) throw new Error("choice out of range");
  const id = toBig(electionId);
  const ciphertexts = [];
  const bits = [];
  let rSum = 0n;
  for (let o = 0; o < n; o += 1) {
    const m = o === c ? 1n : 0n;
    const r = randomScalar();
    rSum = mod(rSum + r, ORDER);
    const c1 = mulBase(r);
    const c2 = add(mulBase(m), mul(jointKey, r));
    ciphertexts.push([c1, c2]);
    bits.push(proveBit(ctx, id, o, jointKey, c1, c2, m, r));
  }
  const total = sumOf(ciphertexts);
  const w = randomScalar();
  const a = mulBase(w);
  const b = mul(jointKey, w);
  const e = sumChallenge(ctx, id, jointKey, total[0], sub(total[1], G), a, b);
  const sum = { a, b, z: mod(w + e * rSum, ORDER) };
  return { ciphertexts, proof: { bits, sum } };
}

function sumOf(cts) {
  return cts.reduce(([s1, s2], [c1, c2]) => [add(s1, c1), add(s2, c2)], [IDENTITY, IDENTITY]);
}

function proveBit(ctx, electionId, option, pk, c1, c2, m, r) {
  const real = Number(m);
  const fake = 1 - real;
  const target = (j) => (j === 0 ? c2 : sub(c2, G));
  const eFake = randomScalar();
  const zFake = randomScalar();
  const aFake = sub(mulBase(zFake), mul(c1, eFake));
  const bFake = sub(mul(pk, zFake), mul(target(fake), eFake));
  const w = randomScalar();
  const aReal = mulBase(w);
  const bReal = mul(pk, w);
  const [a0, b0, a1, b1] = real === 0 ? [aReal, bReal, aFake, bFake] : [aFake, bFake, aReal, bReal];
  const e = bitChallenge(ctx, electionId, option, pk, c1, c2, a0, b0, a1, b1);
  const eReal = mod(e - eFake, ORDER);
  const zReal = mod(w + eReal * r, ORDER);
  return real === 0
    ? { a0, b0, a1, b1, e0: eReal, z0: zReal, e1: eFake, z1: zFake }
    : { a0, b0, a1, b1, e0: eFake, z0: zFake, e1: eReal, z1: zReal };
}

/** True when every option encrypts 0 or 1 and they add up to exactly 1. */
export function verifyBallot({ ctx, electionId, jointKey, optionCount, ciphertexts, proof }) {
  try {
    const n = Number(optionCount);
    if (!Array.isArray(ciphertexts) || ciphertexts.length !== n || proof?.bits?.length !== n) return false;
    const id = toBig(electionId);
    for (let o = 0; o < n; o += 1) {
      const [c1, c2] = ciphertexts[o];
      if (!inSubgroup(c1) || !onCurve(c2)) return false;
      const p = proof.bits[o];
      const e = bitChallenge(ctx, id, o, jointKey, c1, c2, p.a0, p.b0, p.a1, p.b1);
      if (mod(toBig(p.e0) + toBig(p.e1), ORDER) !== e) return false;
      for (const [j, aj, bj, ej, zj] of [[0, p.a0, p.b0, p.e0, p.z0], [1, p.a1, p.b1, p.e1, p.z1]]) {
        const target = j === 0 ? c2 : sub(c2, G);
        if (!eq(mulBase(zj), add(aj, mul(c1, ej)))) return false;
        if (!eq(mul(jointKey, zj), add(bj, mul(target, ej)))) return false;
      }
    }
    const [s1, s2] = sumOf(ciphertexts);
    const s2m = sub(s2, G);
    const { a, b, z } = proof.sum;
    const e = sumChallenge(ctx, id, jointKey, s1, s2m, a, b);
    return eq(mulBase(z), add(a, mul(s1, e))) && eq(mul(jointKey, z), add(b, mul(s2m, e)));
  } catch {
    return false;
  }
}

// --------------------------------------------------------------------- guardians

/** A guardian identity key pair. The secret never leaves the guardian's device. */
export function identityKeypair(secret = randomScalar()) {
  return { secret, key: mulBase(secret) };
}

function schnorr(secret, e) {
  const w = randomScalar();
  const r = mulBase(w);
  const ch = e(r);
  return { rX: r[0], rY: r[1], z: mod(w + ch * secret, ORDER) };
}

/** Random polynomial of degree k − 1 and its Feldman commitments. */
export function dealPolynomial(k) {
  const coefficients = Array.from({ length: Number(k) }, () => randomScalar());
  return { coefficients, commitments: coefficients.map(mulBase) };
}

export function evalPolynomial(coefficients, at) {
  let s = 0n;
  let pow = 1n;
  for (const a of coefficients) {
    s = mod(s + a * pow, ORDER);
    pow = mod(pow * toBig(at), ORDER);
  }
  return s;
}

const xs = (points) => ({ array: points.map((p) => p[0]) });
const ys = (points) => ({ array: points.map((p) => p[1]) });

/** Arguments for `commitGuardian`: commitments, proof of knowledge of a₀, identity signature. */
export function commitGuardian({ ctx, electionId, index, polynomial, identitySecret }) {
  const C = polynomial.commitments;
  const pok = schnorr(polynomial.coefficients[0], (r) =>
    challenge([DOMAINS.pok, ctx.chainId, ctx.rollup, electionId, index, xs(C), ys(C), r[0], r[1]]),
  );
  const message = keccakWord(abiEncode([{ string: "commit" }, xs(C), ys(C)]));
  const auth = signAuth({ ctx, electionId, index, message, identitySecret });
  return { cx: C.map((p) => p[0]), cy: C.map((p) => p[1]), pok, auth };
}

/** Identity-key signature over a 32-byte message, as Guardians.authChallenge. */
export function signAuth({ ctx, electionId, index, message, identitySecret }) {
  return schnorr(identitySecret, (r) =>
    challenge([DOMAINS.auth, ctx.chainId, ctx.rollup, electionId, index, toBig(message), r[0], r[1]]),
  );
}

export const disputeMessage = (dealer) => keccakWord(abiEncode([{ string: "dispute" }, dealer]));

/** Dealer's signature on the share for `recipient`, under `C₀` (as Guardians.shareChallenge). */
export function signShare({ ctx, electionId, dealer, recipient, share, polynomial }) {
  return schnorr(polynomial.coefficients[0], (r) =>
    challenge([DOMAINS.share, ctx.chainId, ctx.rollup, electionId, dealer, recipient, share, r[0], r[1]]),
  );
}

/** `share · G == Σ_t at^t · C_t`. */
export function shareOpens(commitments, at, share) {
  let acc = IDENTITY;
  let pow = 1n;
  for (const c of commitments) {
    acc = add(acc, mul(c, pow));
    pow = mod(pow * toBig(at), ORDER);
  }
  return eq(acc, mulBase(share));
}

/** Guardian `j`'s public share `Σ_i Σ_t j^t · C_{i,t}` over dealers in good standing. */
export function publicShare(dealerCommitments, j) {
  let acc = IDENTITY;
  for (const commitments of dealerCommitments) {
    let pow = 1n;
    for (const c of commitments) {
      acc = add(acc, mul(c, pow));
      pow = mod(pow * toBig(j), ORDER);
    }
  }
  return acc;
}

/** `Σ C_{i,0}` over dealers in good standing. */
export const jointKeyOf = (dealerCommitments) => dealerCommitments.reduce((acc, c) => add(acc, c[0]), IDENTITY);

/** Decryption shares for every option of the final accumulator, with Chaum-Pedersen proofs. */
export function decryptionShares({ ctx, electionId, index, secretShare, accumulator }) {
  const pk = mulBase(secretShare);
  return accumulator.map(([c1], option) => {
    const d = mul(c1, secretShare);
    const w = randomScalar();
    const a = mulBase(w);
    const b = mul(c1, w);
    const e = challenge([DOMAINS.decrypt, ctx.chainId, ctx.rollup, electionId, option, index, ...pk, ...c1, ...d, ...a, ...b]);
    return { dX: d[0], dY: d[1], aX: a[0], aY: a[1], bX: b[0], bY: b[1], z: mod(w + e * secretShare, ORDER) };
  });
}

/** `λ_i(0)` over the 1-based indexes in `subset`, mod ORDER. */
export function lagrangeAtZero(subset, i) {
  let num = 1n;
  let den = 1n;
  const xi = toBig(subset[i]);
  subset.forEach((x, j) => {
    if (j === i) return;
    num = mod(num * toBig(x), ORDER);
    den = mod(den * (toBig(x) - xi), ORDER);
  });
  return mod(num * inv(den, ORDER), ORDER);
}

/**
 * Open the final sums: `m · G = c2 − Σ λ_j D_j` per option, then the bounded discrete log.
 * `sharesByIndex` maps a guardian index to its `D` points per option.
 */
export function openTotals({ accumulator, sharesByIndex, subset, ballotCount }) {
  return accumulator.map(([, c2], option) => {
    let m = c2;
    subset.forEach((g, i) => {
      const [dX, dY] = sharesByIndex[g][option];
      m = sub(m, mul([toBig(dX), toBig(dY)], lagrangeAtZero(subset, i)));
    });
    return discreteLog(m, ballotCount);
  });
}

/** Smallest `n ≤ max` with `n · G = point` (baby-step giant-step). */
export function discreteLog(point, max) {
  const limit = BigInt(max);
  const step = BigInt(Math.max(1, Math.ceil(Math.sqrt(Number(limit) + 1))));
  const table = new Map();
  let p = IDENTITY;
  for (let j = 0n; j < step; j += 1n) {
    table.set(`${p[0]}:${p[1]}`, j);
    p = add(p, G);
  }
  const giant = neg(mul(G, step));
  let gamma = point;
  for (let i = 0n; i * step <= limit; i += 1n) {
    const j = table.get(`${gamma[0]}:${gamma[1]}`);
    if (j !== undefined && i * step + j <= limit) return i * step + j;
    gamma = add(gamma, giant);
  }
  throw new Error("total is outside the ballot count");
}

// ------------------------------------------------------------------ serializing

/** JSON-safe form (decimal strings) of points, ciphertexts and proofs. */
export function toJSONSafe(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(toJSONSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJSONSafe(v)]));
  }
  return value;
}

/** Inverse of toJSONSafe for the shapes above: every decimal string becomes a bigint. */
export function fromJSONSafe(value) {
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  if (Array.isArray(value)) return value.map(fromJSONSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fromJSONSafe(v)]));
  }
  return value;
}

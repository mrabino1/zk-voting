/**
 * NOT FOR PROFIT — civic public good, not a commercial product.
 * zk-entropy: collect, mix, and export entropy for zk-voting setup ceremonies.
 *
 * One dependency-free ES module that runs unchanged in browsers and in
 * Node >= 20 (WebCrypto `crypto.subtle` and `crypto.getRandomValues`).
 *
 * Mixing: every source is framed (tag, length, bytes) and absorbed into a
 * domain-separated SHA-256 chain, state = SHA-256(ABSORB || state || batch).
 * Finalize always adds 64 fresh bytes from crypto.getRandomValues plus a
 * timing-jitter sample, so the output is never weaker than the OS RNG.
 *
 * Portable string: zke1:<source>:<output hex>:<transcript hash hex>:<check>
 *   source   local | ceremony
 *   output   32 bytes (64 hex)
 *   transcript hash  SHA-256 of the canonical JSON transcript (64 hex)
 *   check    first 4 bytes of SHA-256(CHECK | source | output | transcript)
 * The transcript records counts and conservative bit estimates per source
 * and a commitment to the output. It never holds raw events or user text.
 */

export const VERSION = "zk-entropy/v1";
export const STRING_PREFIX = "zke1";
export const SOURCES = Object.freeze(["local", "ceremony"]);

const enc = new TextEncoder();
const D = Object.freeze({
  init: enc.encode("zk-entropy/v1/init"),
  absorb: enc.encode("zk-entropy/v1/absorb"),
  out: enc.encode("zk-entropy/v1/output"),
  commit: enc.encode("zk-entropy/v1/commit"),
  check: "zk-entropy/v1/check",
  genesis: enc.encode("zk-entropy/ceremony/v1/genesis"),
  step: enc.encode("zk-entropy/ceremony/v1/step"),
  final: enc.encode("zk-entropy/ceremony/v1/final"),
});

// Conservative estimates, in bits per event, used only for the transcript.
const BITS = Object.freeze({ random: 8 /* per byte */, keyboard: 2, pointer: 1, jitter: 0.5, text: 0, bytes: 0 });
const TAG = Object.freeze({ random: 1, keyboard: 2, pointer: 3, jitter: 4, text: 5, bytes: 6 });
const HEX64 = /^[0-9a-f]{64}$/;

function webcrypto() {
  const c = globalThis.crypto;
  if (!c?.subtle || typeof c.getRandomValues !== "function") throw new Error("zk-entropy needs WebCrypto (crypto.subtle and crypto.getRandomValues)");
  return c;
}

export function utf8(text) {
  return enc.encode(String(text));
}

export function toHex(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

export function fromHex(hex) {
  const s = String(hex);
  if (s.length % 2 || !/^[0-9a-fA-F]*$/.test(s)) throw new Error("not a hex string");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function concatBytes(...parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function u32(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0);
  return b;
}

function f64(n) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, Number(n) || 0);
  return b;
}

export async function sha256(bytes) {
  return new Uint8Array(await webcrypto().subtle.digest("SHA-256", bytes));
}

export async function sha256Hex(bytes) {
  return toHex(await sha256(bytes));
}

export function randomBytes(n) {
  const out = new Uint8Array(n);
  const c = webcrypto();
  for (let i = 0; i < n; i += 65536) c.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  return out;
}

/** Deterministic JSON: sorted object keys, no whitespace. */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
}

function now() {
  return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
}

/** Accumulates entropy from many sources. Single use: finalize() once. */
export class EntropyPool {
  constructor({ maxPendingBytes = 1 << 20 } = {}) {
    this.pending = [];
    this.pendingBytes = 0;
    this.maxPendingBytes = maxPendingBytes;
    this.counts = {};
    this.lastKey = null;
    this.lastPointer = null;
    this.finalized = false;
  }

  _count(source, events, bytes) {
    const c = (this.counts[source] ||= { events: 0, bytes: 0 });
    c.events += events;
    c.bytes += bytes;
  }

  _push(source, data) {
    if (this.finalized) throw new Error("pool already finalized");
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.pending.push(concatBytes(Uint8Array.of(TAG[source]), u32(bytes.length), bytes));
    this.pendingBytes += bytes.length + 5;
    if (this.pendingBytes > this.maxPendingBytes) throw new Error("entropy pool is full; finalize it");
  }

  /** Key timing. `code` is optional; only timing deltas matter. */
  addKeyboardEvent({ time = now(), code = 0 } = {}) {
    const delta = this.lastKey == null ? time : time - this.lastKey;
    this.lastKey = time;
    this._push("keyboard", concatBytes(f64(time), f64(delta), u32(Number(code) || 0)));
    this._count("keyboard", 1, 20);
  }

  /** Pointer position plus timing. */
  addPointerEvent({ x = 0, y = 0, time = now() } = {}) {
    const delta = this.lastPointer == null ? time : time - this.lastPointer;
    this.lastPointer = time;
    this._push("pointer", concatBytes(f64(x), f64(y), f64(time), f64(delta)));
    this._count("pointer", 1, 32);
  }

  /** Free text typed by the user. Hashed in; never stored in the transcript. */
  addText(text) {
    const bytes = utf8(text);
    if (!bytes.length) return;
    this._push("text", bytes);
    this._count("text", 1, bytes.length);
  }

  /** crypto.getRandomValues bytes. */
  addRandom(n = 64) {
    this._push("random", randomBytes(n));
    this._count("random", 1, n);
  }

  /** Timing jitter: low bits of busy-loop timing differences. */
  addJitter(samples = 256) {
    const out = new Uint8Array(samples * 2);
    let prev = now();
    let x = 0;
    for (let i = 0; i < samples; i++) {
      for (let j = 0; j < 64 + (i % 7); j++) x = (x * 1103515245 + 12345 + j) >>> 0;
      const t = now();
      const d = Math.round((t - prev) * 1e6) ^ x;
      prev = t;
      out[i * 2] = d & 0xff;
      out[i * 2 + 1] = (d >>> 8) & 0xff;
    }
    this._push("jitter", out);
    this._count("jitter", samples, out.length);
  }

  /** Opaque caller bytes (for example a pasted ceremony output). */
  addBytes(bytes, label = "bytes") {
    this._push("bytes", concatBytes(utf8(String(label).slice(0, 64)), Uint8Array.of(0), bytes));
    this._count("bytes", 1, bytes.length);
  }

  estimatedBits() {
    let bits = 0;
    for (const [src, c] of Object.entries(this.counts)) bits += src === "random" ? c.bytes * BITS.random : c.events * (BITS[src] ?? 0);
    return Math.floor(bits);
  }

  /**
   * Mix everything and return the output, portable string, and transcript.
   * Always adds 64 OS random bytes and a jitter sample first.
   */
  async finalize({ source = "local", createdAt = new Date().toISOString() } = {}) {
    if (!SOURCES.includes(source)) throw new Error("unknown source");
    this.addRandom(64);
    this.addJitter(128);
    this.finalized = true;
    let state = await sha256(D.init);
    // Absorb in batches of up to 64 KiB so huge pools do not need one giant buffer.
    let batch = [];
    let size = 0;
    const absorb = async () => {
      if (!batch.length) return;
      state = await sha256(concatBytes(D.absorb, state, u32(size), ...batch));
      for (const b of batch) b.fill(0);
      batch = [];
      size = 0;
    };
    for (const p of this.pending) {
      batch.push(p);
      size += p.length;
      if (size >= 65536) await absorb();
    }
    await absorb();
    this.pending = [];
    const output = await sha256(concatBytes(D.out, state));
    state.fill(0);
    const outputHex = toHex(output);
    const sources = {};
    for (const [src, c] of Object.entries(this.counts).sort()) {
      sources[src] = { events: c.events, bytes: c.bytes, estimatedBits: Math.floor(src === "random" ? c.bytes * BITS.random : c.events * (BITS[src] ?? 0)) };
    }
    const transcript = {
      version: VERSION,
      kind: "local",
      createdAt,
      sources,
      estimatedBits: Math.min(256, this.estimatedBits()),
      outputCommitment: await sha256Hex(concatBytes(D.commit, output)),
    };
    const transcriptHash = await transcriptHashOf(transcript);
    return { output, outputHex, transcript, transcriptHash, entropyString: await makeEntropyString(source, outputHex, transcriptHash) };
  }
}

export async function transcriptHashOf(transcript) {
  return sha256Hex(utf8(canonicalJson(transcript)));
}

async function checkFor(source, outputHex, transcriptHash) {
  return (await sha256Hex(utf8(`${D.check}|${source}|${outputHex}|${transcriptHash}`))).slice(0, 8);
}

export async function makeEntropyString(source, outputHex, transcriptHash) {
  if (!SOURCES.includes(source)) throw new Error("unknown source");
  if (!HEX64.test(outputHex) || !HEX64.test(transcriptHash)) throw new Error("output and transcript hash must be 64 lowercase hex");
  return `${STRING_PREFIX}:${source}:${outputHex}:${transcriptHash}:${await checkFor(source, outputHex, transcriptHash)}`;
}

/**
 * Validate a pasted entropy value. Accepts a zke1 string (checksum verified)
 * or, with { allowHex: true }, a bare 64-hex blob (shape only).
 * Returns { ok: true, source, outputHex, transcriptHash } or { ok: false, error }.
 */
export async function parseEntropyString(input, { allowHex = false } = {}) {
  const s = String(input ?? "").trim();
  if (!s) return { ok: false, error: "empty" };
  if (allowHex && /^(0x)?[0-9a-fA-F]{64}$/.test(s)) return { ok: true, source: "hex", outputHex: s.replace(/^0x/, "").toLowerCase(), transcriptHash: null };
  const m = s.match(/^zke1:(local|ceremony):([0-9a-f]{64}):([0-9a-f]{64}):([0-9a-f]{8})$/);
  if (!m) return { ok: false, error: "not a zke1 entropy string (zke1:<source>:<64 hex>:<64 hex>:<8 hex>)" };
  const [, source, outputHex, transcriptHash, check] = m;
  if ((await checkFor(source, outputHex, transcriptHash)) !== check) return { ok: false, error: "checksum mismatch: the string was mistyped or truncated" };
  return { ok: true, source, outputHex, transcriptHash };
}

// ---------- ceremony chain ----------

/** state_0 = SHA-256(GENESIS || salt). */
export async function ceremonyGenesis(saltHex) {
  if (!HEX64.test(saltHex)) throw new Error("salt must be 64 hex");
  return sha256Hex(concatBytes(D.genesis, fromHex(saltHex)));
}

/** state_i = SHA-256(STEP || state_{i-1} || contribution_i). */
export async function ceremonyStep(prevHex, contributionHex) {
  if (!HEX64.test(prevHex) || !HEX64.test(contributionHex)) throw new Error("state and contribution must be 64 hex");
  return sha256Hex(concatBytes(D.step, fromHex(prevHex), fromHex(contributionHex)));
}

/** Public hash of one contribution, shown in the transcript while open. */
export async function contributionHashOf(contributionHex) {
  return sha256Hex(fromHex(contributionHex));
}

/** output = SHA-256(FINAL || state_n || u32 n). */
export async function ceremonyOutput(stateHex, count) {
  return sha256Hex(concatBytes(D.final, fromHex(stateHex), u32(count)));
}

/** Fields of a closed ceremony transcript that the transcript hash covers. */
export function ceremonyHashedBody(t) {
  return {
    version: t.version,
    kind: "ceremony",
    title: t.title,
    salt: t.salt,
    genesis: t.genesis,
    openedAt: t.openedAt ?? null,
    closedAt: t.closedAt,
    closeReason: t.closeReason,
    contributions: t.contributions.map((c) => ({
      index: c.index,
      at: c.at,
      contribution: c.contribution,
      contributionHash: c.contributionHash,
      clientTranscriptHash: c.clientTranscriptHash ?? null,
    })),
    finalState: t.finalState,
    output: t.output,
  };
}

/**
 * Recompute a closed ceremony transcript end to end. Returns
 * { ok, error?, output, entropyString, transcriptHash }.
 */
export async function verifyCeremonyTranscript(t) {
  try {
    if (t?.version !== VERSION) return { ok: false, error: "unknown version" };
    let state = await ceremonyGenesis(t.salt);
    if (state !== t.genesis) return { ok: false, error: "genesis mismatch" };
    for (let i = 0; i < t.contributions.length; i++) {
      const c = t.contributions[i];
      if (c.index !== i + 1) return { ok: false, error: `contribution ${i + 1} out of order` };
      if ((await contributionHashOf(c.contribution)) !== c.contributionHash) return { ok: false, error: `contribution ${c.index} hash mismatch` };
      state = await ceremonyStep(state, c.contribution);
    }
    if (state !== t.finalState) return { ok: false, error: "final state mismatch" };
    const output = await ceremonyOutput(state, t.contributions.length);
    if (output !== t.output) return { ok: false, error: "output mismatch" };
    const transcriptHash = await transcriptHashOf(ceremonyHashedBody(t));
    if (t.transcriptHash && t.transcriptHash !== transcriptHash) return { ok: false, error: "transcript hash mismatch" };
    const entropyString = await makeEntropyString("ceremony", output, transcriptHash);
    if (t.entropyString && t.entropyString !== entropyString) return { ok: false, error: "entropy string mismatch" };
    return { ok: true, output, transcriptHash, entropyString };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

// ---------- browser helpers ----------

/**
 * Feed pointer and key events on `target` into `pool`. Returns a detach
 * function. Key values are not recorded beyond a code point; timing is the
 * entropy that matters. `onEvent(count)` is called after each event.
 */
export function attachCollectors(target, pool, { onEvent } = {}) {
  let n = 0;
  const tick = () => onEvent && onEvent(++n);
  const move = (e) => {
    pool.addPointerEvent({ x: e.clientX, y: e.clientY, time: e.timeStamp || now() });
    tick();
  };
  const key = (e) => {
    if (e.key === "Tab") return;
    pool.addKeyboardEvent({ time: e.timeStamp || now(), code: (e.key && e.key.codePointAt(0)) || 0 });
    tick();
  };
  target.addEventListener("pointermove", move);
  target.addEventListener("keydown", key);
  return () => {
    target.removeEventListener("pointermove", move);
    target.removeEventListener("keydown", key);
  };
}

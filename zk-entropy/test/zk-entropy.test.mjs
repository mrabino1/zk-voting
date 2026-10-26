import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  EntropyPool,
  canonicalJson,
  ceremonyGenesis,
  ceremonyHashedBody,
  ceremonyOutput,
  ceremonyStep,
  contributionHashOf,
  fromHex,
  makeEntropyString,
  parseEntropyString,
  sha256Hex,
  toHex,
  transcriptHashOf,
  utf8,
  verifyCeremonyTranscript,
  attachCollectors,
  VERSION,
} from "../src/index.js";

const CLI = fileURLToPath(new URL("../bin/zk-entropy.js", import.meta.url));
const H = (c) => c.repeat(64);

test("hex helpers round-trip and reject junk", () => {
  const b = Uint8Array.of(0, 1, 254, 255);
  assert.equal(toHex(b), "0001feff");
  assert.deepEqual(fromHex("0001feff"), b);
  assert.throws(() => fromHex("abc"));
  assert.throws(() => fromHex("zz"));
});

test("canonicalJson sorts keys and drops undefined", () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: undefined }], e: null }), '{"a":[{"d":2}],"b":1,"e":null}');
});

test("pool mixes all sources; output differs every run; transcript has no raw data", async () => {
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const pool = new EntropyPool();
    for (let k = 0; k < 20; k++) pool.addKeyboardEvent({ time: k * 10.5, code: 97 + k });
    for (let k = 0; k < 20; k++) pool.addPointerEvent({ x: k, y: k * 2, time: k * 3.3 });
    pool.addText("my secret phrase");
    pool.addRandom(32);
    pool.addJitter(32);
    runs.push(await pool.finalize({ createdAt: "2026-10-26T00:00:00.000Z" }));
  }
  const outs = new Set(runs.map((r) => r.outputHex));
  assert.equal(outs.size, 3, "OS randomness is always mixed in, so identical events still differ");
  const r = runs[0];
  assert.match(r.outputHex, /^[0-9a-f]{64}$/);
  assert.equal(r.transcript.version, VERSION);
  assert.deepEqual(Object.keys(r.transcript.sources).sort(), ["jitter", "keyboard", "pointer", "random", "text"]);
  assert.equal(r.transcript.sources.keyboard.events, 20);
  assert.equal(r.transcript.sources.text.estimatedBits, 0, "user text is never credited");
  const json = JSON.stringify(r.transcript);
  assert.ok(!json.includes("secret"), "user text never appears in the transcript");
  assert.ok(!json.includes(r.outputHex), "the output itself is not in the transcript");
  assert.equal(r.transcriptHash, await transcriptHashOf(r.transcript));
  assert.equal(r.transcript.estimatedBits, 256);
});

test("a pool is single use", async () => {
  const pool = new EntropyPool();
  await pool.finalize();
  assert.throws(() => pool.addText("x"), /finalized/);
});

test("pool refuses to grow without bound", () => {
  const pool = new EntropyPool({ maxPendingBytes: 1000 });
  assert.throws(() => {
    for (let i = 0; i < 100; i++) pool.addPointerEvent({ x: i, y: i });
  }, /full/);
});

test("entropy string: make, parse, checksum, and shape errors", async () => {
  const s = await makeEntropyString("ceremony", H("a"), H("b"));
  assert.match(s, /^zke1:ceremony:a{64}:b{64}:[0-9a-f]{8}$/);
  assert.deepEqual(await parseEntropyString(`  ${s}\n`), { ok: true, source: "ceremony", outputHex: H("a"), transcriptHash: H("b") });
  const flipped = s.replace(`:${H("a")}:`, `:${"a".repeat(63)}c:`);
  assert.equal((await parseEntropyString(flipped)).ok, false);
  assert.match((await parseEntropyString(flipped)).error, /checksum/);
  assert.match((await parseEntropyString("hello")).error, /not a zke1/);
  assert.equal((await parseEntropyString("")).ok, false);
  assert.equal((await parseEntropyString(H("c"))).ok, false, "bare hex needs allowHex");
  assert.deepEqual(await parseEntropyString("0x" + H("C"), { allowHex: true }), { ok: true, source: "hex", outputHex: H("c"), transcriptHash: null });
  await assert.rejects(makeEntropyString("other", H("a"), H("b")));
  await assert.rejects(makeEntropyString("local", "abc", H("b")));
});

test("fixed vector: the check digits are stable across versions", async () => {
  // Pinned so the demo's vendored validator and other implementations can be checked against it.
  const s = await makeEntropyString("local", H("0"), H("f"));
  assert.equal(s, `zke1:local:${H("0")}:${H("f")}:${(await sha256Hex(utf8(`zk-entropy/v1/check|local|${H("0")}|${H("f")}`))).slice(0, 8)}`);
});

async function buildTranscript(contribs) {
  const salt = H("5");
  const genesis = await ceremonyGenesis(salt);
  let state = genesis;
  const contributions = [];
  for (let i = 0; i < contribs.length; i++) {
    state = await ceremonyStep(state, contribs[i]);
    contributions.push({ index: i + 1, at: `2026-10-26T10:0${i}:00.000Z`, contribution: contribs[i], contributionHash: await contributionHashOf(contribs[i]), clientTranscriptHash: null });
  }
  const t = { version: VERSION, title: "Test", salt, genesis, openedAt: "2026-10-26T09:00:00.000Z", closedAt: "2026-10-26T11:00:00.000Z", closeReason: "manual", contributions, finalState: state, output: await ceremonyOutput(state, contribs.length) };
  t.transcriptHash = await transcriptHashOf(ceremonyHashedBody(t));
  t.entropyString = await makeEntropyString("ceremony", t.output, t.transcriptHash);
  return t;
}

test("ceremony chain: order matters and the transcript verifies end to end", async () => {
  const a = H("1"), b = H("2");
  const g = await ceremonyGenesis(H("5"));
  assert.notEqual(await ceremonyStep(await ceremonyStep(g, a), b), await ceremonyStep(await ceremonyStep(g, b), a));
  const t = await buildTranscript([a, b, H("3")]);
  const v = await verifyCeremonyTranscript(t);
  assert.equal(v.ok, true, v.error);
  assert.equal(v.entropyString, t.entropyString);
  assert.equal((await parseEntropyString(t.entropyString)).source, "ceremony");
});

test("ceremony verification catches tampering", async () => {
  const t = await buildTranscript([H("1"), H("2")]);
  const swap = structuredClone(t);
  swap.contributions[0].contribution = H("9");
  assert.match((await verifyCeremonyTranscript(swap)).error, /hash mismatch/);
  const out = structuredClone(t);
  out.output = H("0");
  assert.match((await verifyCeremonyTranscript(out)).error, /output mismatch/);
  const title = structuredClone(t);
  title.title = "Other";
  assert.match((await verifyCeremonyTranscript(title)).error, /transcript hash mismatch/);
  const order = structuredClone(t);
  order.contributions.reverse();
  assert.equal((await verifyCeremonyTranscript(order)).ok, false);
});

test("attachCollectors feeds events and detaches", async () => {
  const listeners = {};
  const target = { addEventListener: (t, f) => (listeners[t] = f), removeEventListener: (t) => delete listeners[t] };
  const pool = new EntropyPool();
  let seen = 0;
  const detach = attachCollectors(target, pool, { onEvent: (n) => (seen = n) });
  listeners.pointermove({ clientX: 1, clientY: 2, timeStamp: 3 });
  listeners.keydown({ key: "a", timeStamp: 4 });
  listeners.keydown({ key: "Tab", timeStamp: 5 });
  assert.equal(seen, 2);
  detach();
  assert.deepEqual(listeners, {});
  const r = await pool.finalize();
  assert.equal(r.transcript.sources.pointer.events, 1);
  assert.equal(r.transcript.sources.keyboard.events, 1);
});

test("CLI: generate (string, hex, json) and validate", () => {
  const s = execFileSync(process.execPath, [CLI, "generate", "--no-keys", "--text", "abc"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  assert.match(s, /^zke1:local:[0-9a-f]{64}:[0-9a-f]{64}:[0-9a-f]{8}$/);
  const hex = execFileSync(process.execPath, [CLI, "generate", "--no-keys", "--format", "hex"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  assert.match(hex, /^[0-9a-f]{64}$/);
  const j = JSON.parse(execFileSync(process.execPath, [CLI, "generate", "--no-keys", "--format", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  assert.equal(j.transcript.version, VERSION);
  const ok = execFileSync(process.execPath, [CLI, "validate", s], { encoding: "utf8" });
  assert.match(ok, /^ok source=local/);
  assert.ok(!ok.includes(s.split(":")[2]), "validate does not echo the output");
  assert.throws(() => execFileSync(process.execPath, [CLI, "validate", s.slice(0, -1) + (s.endsWith("0") ? "1" : "0")], { stdio: "ignore" }));
});

test("CLI: verify-transcript", async () => {
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(`${tmpdir()}/zke-`);
  const t = await buildTranscript([H("1")]);
  writeFileSync(`${dir}/t.json`, JSON.stringify({ transcript: t }));
  const outText = execFileSync(process.execPath, [CLI, "verify-transcript", `${dir}/t.json`], { encoding: "utf8" });
  assert.match(outText, /transcript verifies: 1 contributions/);
  assert.ok(outText.includes(t.entropyString));
  t.output = H("0");
  writeFileSync(`${dir}/bad.json`, JSON.stringify(t));
  assert.throws(() => execFileSync(process.execPath, [CLI, "verify-transcript", `${dir}/bad.json`], { stdio: "ignore" }));
});

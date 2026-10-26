/* NOT FOR PROFIT — civic public good, not a commercial product.
 * zk-voting trusted-setup worker. Runs snarkjs off the main thread.
 *
 * Classic worker so it can importScripts the vendored snarkjs build (served
 * from this Node, never a CDN). Served with a CSP that allows
 * 'wasm-unsafe-eval' and blob: workers; see docs/ceremony-web.md#csp.
 *
 * Entropy arrives from the page, is mixed with crypto.getRandomValues here,
 * is passed to snarkjs, and is dropped. It is never posted back or uploaded.
 */
/* global snarkjs */
"use strict";

importScripts("/vendor/snarkjs.min.js");

function captureLogger(id) {
  const lines = [];
  const push = (level) => (...args) => {
    const line = level === "info" ? args.join(" ") : "[" + level.toUpperCase() + "] " + args.join(" ");
    lines.push(line);
    self.postMessage({ id, type: "log", line });
  };
  return {
    logger: { info: push("info"), warn: push("warn"), error: push("error"), debug: () => {} },
    text: () => lines.join("\n") + "\n",
  };
}

function toHex(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

async function contribute(id, msg) {
  const cap = captureLogger(id);
  const oldZkey = { type: "mem", data: new Uint8Array(msg.zkey) };
  const newZkey = { type: "mem" };
  // Mix the page's collected entropy, the optional pasted entropy (a
  // validated zk-entropy output: 64 lowercase hex), and fresh OS randomness.
  // snarkjs then hashes this string together with its own getRandomValues draw.
  const pasted = typeof msg.pasted === "string" ? msg.pasted : "";
  if (pasted && !/^[0-9a-f]{64}$/.test(pasted)) throw new Error("pasted entropy must be 64 lowercase hex");
  const extra = new Uint8Array(64);
  self.crypto.getRandomValues(extra);
  const collected = new Uint8Array(msg.entropy);
  let entropy = toHex(collected) + pasted + toHex(extra);
  collected.fill(0);
  extra.fill(0);
  const hash = await snarkjs.zKey.contribute(oldZkey, newZkey, msg.name, entropy, cap.logger);
  entropy = "";
  const out = newZkey.data;
  const buffer = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
  self.postMessage({ id, type: "done", result: { zkey: buffer, contributionHash: toHex(hash), log: cap.text() } }, [buffer]);
}

async function verify(id, msg) {
  const cap = captureLogger(id);
  const ok = await snarkjs.zKey.verifyFromR1cs(
    { type: "mem", data: new Uint8Array(msg.r1cs) },
    { type: "mem", data: new Uint8Array(msg.ptau) },
    { type: "mem", data: new Uint8Array(msg.zkey) },
    cap.logger
  );
  self.postMessage({ id, type: "done", result: { ok: Boolean(ok), log: cap.text() } });
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  try {
    if (msg.op === "contribute") await contribute(msg.id, msg);
    else if (msg.op === "verify") await verify(msg.id, msg);
    else throw new Error("unknown op");
  } catch (err) {
    self.postMessage({ id: msg.id, type: "error", error: String((err && err.message) || err) });
  }
};

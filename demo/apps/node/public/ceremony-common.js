/**
 * NOT FOR PROFIT — civic public good, not a commercial product.
 * Shared helpers for the zk-voting trusted-setup pages.
 * No inline script or style: these pages run under a strict CSP.
 */

export const GENESIS = "0".repeat(64);

export class ApiError extends Error {
  constructor(status, data) {
    super((data && (data.error || data.message)) || `HTTP ${status}`);
    this.status = status;
    this.data = data || {};
  }
}

export async function api(path, { method = "GET", json, body, headers = {}, signal } = {}) {
  const h = { accept: "application/json", ...headers };
  if (json !== undefined) h["content-type"] = "application/json";
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(path, {
      method,
      headers: h,
      credentials: "same-origin",
      body: json !== undefined ? JSON.stringify(json) : body,
      signal,
    });
    if (res.status === 503 && attempt < 3 && method === "GET") {
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      continue;
    }
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) throw new ApiError(res.status, data);
    return data;
  }
}

/** Download a file with progress. Returns an ArrayBuffer. */
export async function download(path, onProgress) {
  const res = await fetch(path, { credentials: "same-origin" });
  if (!res.ok) throw new ApiError(res.status, null);
  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body || !onProgress) return res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress(got, total);
  }
  const out = new Uint8Array(got);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out.buffer;
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) node.setAttribute(k, "");
    else node.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 ** 3).toFixed(2)} GiB`;
}

export function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function short(hex, n = 10) {
  const s = String(hex || "");
  return s.length > n * 2 ? `${s.slice(0, n)}…${s.slice(-n)}` : s;
}

export const STATUS_LABEL = {
  initializing: "Preparing",
  draft: "Draft",
  open: "Open for contributions",
  closed: "Closed",
  finalizing: "Applying beacon",
  finalized: "Finalized",
  error: "Error",
};

const STATUS_CLASS = {
  initializing: "status-pending",
  draft: "status-created",
  open: "status-open",
  closed: "status-closed",
  finalizing: "status-pending",
  finalized: "status-tallied",
  error: "status-error",
};

export function statusPill(status) {
  return el(
    "span",
    { class: `status-pill ${STATUS_CLASS[status] || ""}` },
    el("span", { class: "status-dot", "aria-hidden": "true" }),
    STATUS_LABEL[status] || status
  );
}

export function hashCode(hex, label) {
  return el("code", { class: "hash mono", title: hex || "", "aria-label": label ? `${label}: ${hex}` : null }, short(hex));
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function sha256Hex(data) {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Mirrors contributionBody() in apps/node/src/ceremony/service.mjs. */
export function contributionBody(entry) {
  return {
    index: entry.index,
    name: entry.name,
    contributionHash: entry.contributionHash,
    zkey: entry.zkey,
    zkeySha256: entry.zkeySha256,
    zkeyBytes: entry.zkeyBytes,
    prevZkeySha256: entry.prevZkeySha256,
    attestation: entry.attestation || null,
    acceptedAt: entry.acceptedAt,
    verifiedWith: entry.verifiedWith,
  };
}

/** Recompute the transcript hash chain. Returns { ok, headHash, badIndex }. */
export async function verifyHashChain(entries) {
  let prev = GENESIS;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.prevHash !== prev) return { ok: false, badIndex: i, reason: "prevHash does not link" };
    const h = await sha256Hex(`${prev}\n${canonicalJson(contributionBody(e))}`);
    if (h !== e.hash) return { ok: false, badIndex: i, reason: "entry hash does not match its body" };
    prev = h;
  }
  return { ok: true, headHash: prev };
}

// --- snarkjs log parsing (mirror of apps/node/src/ceremony/snarkjsLog.mjs) ---

function stripLog(text) {
  return String(text)
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\[(DEBUG|INFO|WARN|ERROR)\]\s+snarkJS:\s*/g, "");
}

const HASH_BLOCK = "((?:[ \\t]*[0-9a-fA-F]{8} [0-9a-fA-F]{8} [0-9a-fA-F]{8} [0-9a-fA-F]{8}\\n){4})";

function wordsToHex(block) {
  const hex = String(block).replace(/[^0-9a-fA-F]/g, "").toLowerCase();
  if (hex.length !== 128) throw new Error("expected a 64-byte snarkjs hash");
  return hex;
}

export function parseVerifiedContributions(text) {
  const clean = stripLog(text);
  if (!/ZKey Ok!/.test(clean)) throw new Error("snarkjs did not report ZKey Ok!");
  const found = [];
  for (const section of clean.split(/-{5,}/)) {
    const m = section.match(new RegExp(`contribution #(\\d+)(?: ([^\\n:]+))?:\\s*\\n${HASH_BLOCK}`, "i"));
    if (!m) continue;
    const beacon = section.match(/Beacon generator:\s*([0-9a-fA-F]+)/);
    const iters = section.match(/Beacon iterations Exp:\s*(\d+)/);
    found.push({
      index: Number(m[1]),
      name: (m[2] || "").trim(),
      hash: wordsToHex(m[3]),
      beacon: beacon ? { hash: beacon[1].toLowerCase(), iterations: iters ? Number(iters[1]) : null } : null,
    });
  }
  return found.sort((a, b) => a.index - b.index);
}

// --- worker bridge ---

let worker = null;
let seq = 0;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker("/ceremony-worker.js");
  worker.onmessage = (event) => {
    const msg = event.data || {};
    const p = pending.get(msg.id);
    if (!p) return;
    if (msg.type === "log") p.onLog?.(msg.line);
    else if (msg.type === "done") {
      pending.delete(msg.id);
      p.resolve(msg.result);
    } else if (msg.type === "error") {
      pending.delete(msg.id);
      p.reject(new Error(msg.error));
    }
  };
  worker.onerror = (event) => {
    for (const p of pending.values()) p.reject(new Error(event.message || "worker failed to start"));
    pending.clear();
    worker = null;
  };
  return worker;
}

export function runWorker(op, payload, transfer = [], onLog) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onLog });
    getWorker().postMessage({ id, op, ...payload }, transfer);
  });
}

export function saveJson(filename, data) {
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: filename, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function errorText(err) {
  if (err instanceof ApiError) {
    if (err.status === 401) return "Sign in first.";
    if (err.status === 429) return "Too many requests. Wait a few minutes and try again.";
    return err.message;
  }
  return String((err && err.message) || err);
}

/** Polite live region for status messages. */
export function announce(region, text, kind = "") {
  if (!region) return;
  region.className = `notice ${kind ? `notice-${kind}` : ""}`.trim();
  region.hidden = !text;
  region.textContent = text || "";
}

export async function waitForJob(jobId, { onTick, intervalMs = 1500, signal } = {}) {
  for (;;) {
    const { job } = await api(`/api/ceremonies/jobs/${encodeURIComponent(jobId)}`, { signal });
    onTick?.(job);
    if (job.status !== "running") return job;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** replaceChildren that skips null/false (native replaceChildren prints "null"). */
export function fill(node, ...children) {
  node.replaceChildren(...children.flat().filter((c) => c != null && c !== false));
}

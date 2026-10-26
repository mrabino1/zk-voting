import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { parseEntropyString, verifyCeremonyTranscript, randomBytes, toHex } from "../../src/index.js";

const rnd = () => toHex(randomBytes(32));

async function boot(overrides = {}) {
  const dir = overrides.dataDir || mkdtempSync(path.join(tmpdir(), "zkc-"));
  const app = await createApp({ dataDir: dir, ratePerMinute: 0, autoCloseIntervalMs: 0, adminToken: "", setupToken: "", minContributions: 2, ...overrides }, {});
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = "";
  async function call(method, p, body, headers = {}) {
    const res = await fetch(base + p, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    const text = await res.text();
    let data = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* html */
    }
    return { status: res.status, data, headers: res.headers };
  }
  return {
    app,
    dir,
    base,
    call,
    setCookie: (c) => (cookie = c),
    getCookie: () => cookie,
    async stop() {
      await new Promise((r) => server.close(r));
      await app.close();
    },
  };
}

async function adminReady(t) {
  const r = await t.call("POST", "/api/admin/setup", { password: "correct horse battery" });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r;
}

test("health, static pages, CSP, and the browser library", async () => {
  const t = await boot();
  try {
    const h = await t.call("GET", "/health");
    assert.equal(h.status, 200);
    assert.deepEqual(h.data, { ok: true, service: "zk-entropy-ceremony", status: "draft", store: "sqlite" });
    for (const p of ["/", "/transcript", "/admin"]) {
      const r = await t.call("GET", p);
      assert.equal(r.status, 200);
      assert.match(r.headers.get("content-type"), /text\/html/);
      assert.match(r.headers.get("content-security-policy"), /default-src 'self'/);
      assert.match(r.data, /NOT FOR PROFIT/);
    }
    const lib = await t.call("GET", "/lib/zk-entropy.js");
    assert.equal(lib.status, 200);
    assert.match(lib.data, /export class EntropyPool/);
    assert.equal((await t.call("GET", "/nope")).status, 404);
    assert.equal((await t.call("GET", "/api/nope")).status, 404);
  } finally {
    await t.stop();
  }
});

test("first-run admin: first one wins, then setup refuses forever", async () => {
  const t = await boot();
  try {
    let info = await t.call("GET", "/api/admin");
    assert.equal(info.data.adminExists, false);
    assert.equal((await t.call("POST", "/api/admin/setup", { password: "short" })).status, 400);
    // Race: many setups at once, exactly one wins.
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => t.call("POST", "/api/admin/setup", { password: `passphrase-number-${i}` })));
    assert.equal(results.filter((r) => r.status === 201).length, 1);
    assert.ok(results.filter((r) => r.status !== 201).every((r) => r.status === 409 && r.data.error === "ADMIN_EXISTS"));
    const again = await t.call("POST", "/api/admin/setup", { password: "another passphrase" });
    assert.equal(again.status, 409);
    t.setCookie("");
    info = await t.call("GET", "/api/admin");
    assert.equal(info.data.adminExists, true);
    assert.equal(info.data.signedIn, false);
    assert.equal((await t.call("POST", "/api/admin/open", {})).status, 401);
    assert.equal((await t.call("POST", "/api/admin/login", { password: "wrong passphrase!" })).status, 401);
    const winner = results.findIndex((r) => r.status === 201);
    assert.equal((await t.call("POST", "/api/admin/login", { password: `passphrase-number-${winner}` })).status, 200);
    assert.equal((await t.call("GET", "/api/admin")).data.signedIn, true);
    await t.call("POST", "/api/admin/logout", {});
    assert.equal((await t.call("GET", "/api/admin")).data.signedIn, false);
  } finally {
    await t.stop();
  }
});

test("SETUP_TOKEN gates first-run setup", async () => {
  const t = await boot({ setupToken: "s3tup-token-value" });
  try {
    assert.equal((await t.call("GET", "/api/admin")).data.setupTokenRequired, true);
    const no = await t.call("POST", "/api/admin/setup", { password: "correct horse battery" });
    assert.equal(no.status, 403);
    assert.ok(!JSON.stringify(no.data).includes("s3tup"), "never echoes the token");
    assert.equal((await t.call("POST", "/api/admin/setup", { password: "correct horse battery", setupToken: "s3tup-token-value" })).status, 201);
  } finally {
    await t.stop();
  }
});

test("ADMIN_TOKEN env admin: setup is off, bearer and login work", async () => {
  const t = await boot({ adminToken: "env-admin-token-123" });
  try {
    const info = await t.call("GET", "/api/admin");
    assert.equal(info.data.adminExists, true);
    assert.equal(info.data.adminFromEnv, true);
    assert.ok(!JSON.stringify(info.data).includes("env-admin-token"));
    assert.equal((await t.call("POST", "/api/admin/setup", { password: "correct horse battery" })).data.error, "ADMIN_FROM_ENV");
    assert.equal((await t.call("POST", "/api/admin/open", {}, { authorization: "Bearer wrong" })).status, 401);
    assert.equal((await t.call("POST", "/api/admin/open", {}, { authorization: "Bearer env-admin-token-123" })).status, 200);
    assert.equal((await t.call("POST", "/api/admin/login", { token: "env-admin-token-123" })).status, 200);
  } finally {
    await t.stop();
  }
});

test("contributions: validation, chaining, privacy while open, manual close, final output", async () => {
  const t = await boot();
  try {
    assert.equal((await t.call("POST", "/api/contributions", { contribution: rnd() })).data.error, "NOT_OPEN");
    await adminReady(t);
    assert.equal((await t.call("POST", "/api/admin/open", {})).data.ceremony.status, "open");
    assert.equal((await t.call("POST", "/api/contributions", { contribution: "xyz" })).data.error, "BAD_CONTRIBUTION");
    assert.equal((await t.call("POST", "/api/contributions", { contribution: "0".repeat(64) })).data.error, "BAD_CONTRIBUTION");
    assert.equal((await t.call("POST", "/api/contributions", { contribution: rnd(), clientTranscriptHash: "nope" })).data.error, "BAD_TRANSCRIPT_HASH");
    const c1 = rnd();
    const r1 = await t.call("POST", "/api/contributions", { contribution: c1, clientTranscriptHash: rnd() });
    assert.equal(r1.status, 201);
    assert.equal(r1.data.receipt.index, 1);
    assert.match(r1.data.receipt.contributionHash, /^[0-9a-f]{64}$/);
    assert.equal((await t.call("POST", "/api/contributions", { contribution: c1 })).data.error, "DUPLICATE");
    const open = await t.call("GET", "/api/transcript");
    assert.equal(open.data.transcript.contributions.length, 1);
    assert.ok(!JSON.stringify(open.data).includes(c1), "raw contribution is hidden while open");
    assert.equal(open.data.transcript.finalState, undefined);
    // Below the minimum (2): manual close refused unless forced.
    assert.equal((await t.call("POST", "/api/admin/close", {})).data.error, "BELOW_MINIMUM");
    await t.call("POST", "/api/contributions", { contribution: rnd() });
    const closed = await t.call("POST", "/api/admin/close", {});
    assert.equal(closed.status, 200);
    assert.equal(closed.data.ceremony.status, "closed");
    const st = await t.call("GET", "/api/state");
    assert.equal(st.data.status, "closed");
    const parsed = await parseEntropyString(st.data.final.entropyString);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.source, "ceremony");
    const tr = (await t.call("GET", "/api/transcript")).data.transcript;
    assert.equal(tr.contributions[0].contribution, c1, "raw contributions are revealed after close");
    const v = await verifyCeremonyTranscript(tr);
    assert.equal(v.ok, true, v.error);
    assert.equal(v.entropyString, st.data.final.entropyString);
    assert.equal((await t.call("POST", "/api/contributions", { contribution: rnd() })).data.error, "NOT_OPEN");
    assert.equal((await t.call("PUT", "/api/admin/settings", { title: "x" })).data.error, "CLOSED");
    assert.equal((await t.call("POST", "/api/admin/open", {})).data.error, "CLOSED");
  } finally {
    await t.stop();
  }
});

test("concurrent contributions never chain off the same parent", async () => {
  const t = await boot();
  try {
    await adminReady(t);
    await t.call("POST", "/api/admin/open", {});
    const rs = await Promise.all(Array.from({ length: 25 }, () => t.call("POST", "/api/contributions", { contribution: rnd() })));
    assert.ok(rs.every((r) => r.status === 201));
    assert.deepEqual(rs.map((r) => r.data.receipt.index).sort((a, b) => a - b), Array.from({ length: 25 }, (_, i) => i + 1));
    await t.call("POST", "/api/admin/close", {});
    const v = await verifyCeremonyTranscript((await t.call("GET", "/api/transcript")).data.transcript);
    assert.equal(v.ok, true, v.error);
  } finally {
    await t.stop();
  }
});

test("auto close: by count, and by deadline only once the minimum is met", async () => {
  const t = await boot({ closeAfterCount: 3 });
  try {
    await adminReady(t);
    await t.call("POST", "/api/admin/open", {});
    for (let i = 0; i < 3; i++) assert.equal((await t.call("POST", "/api/contributions", { contribution: rnd() })).status, 201);
    const s = (await t.call("GET", "/api/state")).data;
    assert.equal(s.status, "closed");
    assert.equal(s.closeReason, "count");
    assert.equal(s.count, 3);
  } finally {
    await t.stop();
  }
  let now = Date.parse("2026-10-26T10:00:00Z");
  const d = await boot({ now: () => now, minContributions: 2 });
  try {
    await adminReady(d);
    await d.call("POST", "/api/admin/open", {});
    assert.equal((await d.call("PUT", "/api/admin/settings", { closeAt: "2026-10-26T11:00:00Z" })).status, 200);
    assert.equal((await d.call("PUT", "/api/admin/settings", { closeAt: "not a date" })).data.error, "BAD_DEADLINE");
    await d.call("POST", "/api/contributions", { contribution: rnd() });
    now = Date.parse("2026-10-26T11:30:00Z");
    assert.equal((await d.call("GET", "/api/state")).data.status, "open", "past the deadline but below the minimum stays open");
    await d.call("POST", "/api/contributions", { contribution: rnd() });
    const s = (await d.call("GET", "/api/state")).data;
    assert.equal(s.status, "closed");
    assert.equal(s.closeReason, "deadline");
  } finally {
    await d.stop();
  }
});

test("state persists across restarts (SQLite on the volume)", async () => {
  const t = await boot();
  const dir = t.dir;
  await adminReady(t);
  await t.call("POST", "/api/admin/open", {});
  await t.call("POST", "/api/contributions", { contribution: rnd() });
  await t.call("POST", "/api/contributions", { contribution: rnd() });
  await t.call("POST", "/api/admin/close", {});
  const before = (await t.call("GET", "/api/state")).data;
  await t.stop();
  const u = await boot({ dataDir: dir });
  try {
    const after = (await u.call("GET", "/api/state")).data;
    assert.deepEqual(after.final, before.final);
    assert.equal((await u.call("GET", "/api/admin")).data.adminExists, true);
    assert.equal((await u.call("POST", "/api/admin/setup", { password: "correct horse battery" })).status, 409);
  } finally {
    await u.stop();
  }
});

test("no personal data is stored: schema has no address, agent, or name columns", async () => {
  const t = await boot();
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(t.dir, "ceremony.sqlite"));
    const cols = db.prepare("PRAGMA table_info(ceremony_contributions)").all().map((c) => c.name);
    db.close();
    assert.deepEqual(cols.sort(), ["at", "client_transcript_hash", "contribution", "contribution_hash", "idx", "state_after"]);
  } finally {
    await t.stop();
  }
});

test("request hygiene: cross-origin writes, non-JSON, oversize bodies, rate limit", async () => {
  const t = await boot({ ratePerMinute: 2 });
  try {
    await adminReady(t);
    await t.call("POST", "/api/admin/open", {});
    assert.equal((await t.call("POST", "/api/admin/close", {}, { origin: "https://evil.example" })).status, 403);
    const res = await fetch(`${t.base}/api/contributions`, { method: "POST", headers: { "content-type": "text/plain" }, body: "x" });
    assert.equal(res.status, 415);
    assert.equal((await t.call("POST", "/api/contributions", { contribution: rnd(), pad: "x".repeat(10000) })).status, 413);
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await t.call("POST", "/api/contributions", { contribution: rnd() })).status);
    assert.equal(codes.at(-1), 429);
  } finally {
    await t.stop();
  }
});

test("secure cookie only when the proxy says https; never forces HTTPS", async () => {
  const t = await boot();
  try {
    const r = await t.call("POST", "/api/admin/setup", { password: "correct horse battery" }, { "x-forwarded-proto": "https" });
    assert.match(r.headers.get("set-cookie"), /; Secure/);
    assert.match(r.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
    const plain = await t.call("POST", "/api/admin/login", { password: "correct horse battery" });
    assert.doesNotMatch(plain.headers.get("set-cookie"), /Secure/);
    assert.equal((await t.call("GET", "/health")).status, 200, "plain HTTP health works (no redirect)");
  } finally {
    await t.stop();
  }
});

test("Postgres store (DATABASE_URL)", { skip: !process.env.TEST_DATABASE_URL && "set TEST_DATABASE_URL to run" }, async () => {
  const pg = (await import("pg")).default;
  const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  await c.query("DROP TABLE IF EXISTS ceremony_meta, ceremony_contributions");
  await c.end();
  const t = await boot({ databaseUrl: process.env.TEST_DATABASE_URL });
  try {
    assert.equal((await t.call("GET", "/health")).data.store, "postgres");
    const setups = await Promise.all([1, 2, 3].map((i) => t.call("POST", "/api/admin/setup", { password: `pg-passphrase-${i}xx` })));
    assert.equal(setups.filter((r) => r.status === 201).length, 1);
    await t.call("POST", "/api/admin/open", {});
    const rs = await Promise.all(Array.from({ length: 10 }, () => t.call("POST", "/api/contributions", { contribution: rnd() })));
    assert.ok(rs.every((r) => r.status === 201), JSON.stringify(rs.map((r) => r.data)));
    await t.call("POST", "/api/admin/close", {});
    const v = await verifyCeremonyTranscript((await t.call("GET", "/api/transcript")).data.transcript);
    assert.equal(v.ok, true, v.error);
  } finally {
    await t.stop();
  }
});

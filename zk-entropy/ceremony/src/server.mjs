/**
 * NOT FOR PROFIT — civic public good, not a commercial product.
 * zk-entropy ceremony service: many browsers contribute entropy, the server
 * chains it, an admin closes the ceremony, and the final output is published.
 *
 * Plain node:http, no framework. Serves HTTP only: TLS terminates upstream
 * (Cloudflare tunnel -> Traefik), so nothing here forces HTTPS.
 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig } from "./config.mjs";
import { openStore } from "./store.mjs";
import { createCeremony, CeremonyError } from "./ceremony.mjs";

const scrypt = promisify(scryptCb);
const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, "..", "public");
const LIB_FILE = path.join(here, "..", "..", "src", "index.js");
const COOKIE = "zkc_admin";
const MAX_BODY = 8 * 1024;

const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/transcript": ["transcript.html", "text/html; charset=utf-8"],
  "/admin": ["admin.html", "text/html; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
  "/common.js": ["common.js", "text/javascript; charset=utf-8"],
  "/contribute.js": ["contribute.js", "text/javascript; charset=utf-8"],
  "/transcript.js": ["transcript.js", "text/javascript; charset=utf-8"],
  "/admin.js": ["admin.js", "text/javascript; charset=utf-8"],
  "/favicon.svg": ["favicon.svg", "image/svg+xml"],
};

const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== "string" && !Buffer.isBuffer(body);
  const payload = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "content-type": isJson ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(payload);
}

function fail(res, err) {
  if (err instanceof CeremonyError) return send(res, err.status, { error: err.code, message: err.message });
  if (err?.status) return send(res, err.status, { error: err.code || "ERROR", message: err.message });
  console.error("[ceremony] error:", err?.message || err);
  return send(res, 500, { error: "INTERNAL", message: "internal error" });
}

function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

async function readJson(req) {
  if (!/^application\/json\b/i.test(req.headers["content-type"] || "")) throw httpError(415, "JSON_REQUIRED", "send application/json");
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw httpError(413, "TOO_LARGE", "request body too large");
    chunks.push(c);
  }
  try {
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  } catch {
    throw httpError(400, "BAD_JSON", "invalid JSON");
  }
}

function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sha(s) {
  return createHash("sha256").update(String(s)).digest();
}

function secretsEqual(a, b) {
  return timingSafeEqual(sha(a), sha(b));
}

async function hashPassword(password, saltHex = randomBytes(16).toString("hex")) {
  const key = await scrypt(String(password), Buffer.from(saltHex, "hex"), 32, { N: 16384, r: 8, p: 1 });
  return { salt: saltHex, hash: key.toString("hex"), algo: "scrypt-16384-8-1" };
}

export async function createApp(overrides = {}, env = process.env) {
  const config = overrides.config || loadConfig(env, overrides);
  const store = overrides.store || (await openStore(config));
  const ceremony = createCeremony(store, config);
  await ceremony.init();
  const sessions = new Map(); // id -> expiresAt (memory only; a restart signs the admin out)
  const hits = new Map(); // rate-limit bucket key (hashed client address) -> [timestamps]; memory only

  function clientKey(req) {
    const fwd = config.trustProxy ? String(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || "").split(",")[0].trim() : "";
    // Hash so not even the in-memory limiter holds a raw address.
    return sha(fwd || req.socket.remoteAddress || "?").toString("hex").slice(0, 16);
  }

  function rateLimited(req) {
    if (!config.ratePerMinute) return false;
    const key = clientKey(req);
    const t = config.now();
    const arr = (hits.get(key) || []).filter((x) => t - x < 60000);
    arr.push(t);
    hits.set(key, arr);
    if (hits.size > 10000) for (const [k, v] of hits) if (!v.some((x) => t - x < 60000)) hits.delete(k);
    return arr.length > config.ratePerMinute;
  }

  function isSecure(req) {
    return config.trustProxy && String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
  }

  async function adminExists() {
    return Boolean(config.adminToken) || Boolean(await store.getMeta("admin"));
  }

  async function checkCredential(secret) {
    if (!secret) return false;
    if (config.adminToken) return secretsEqual(secret, config.adminToken);
    const admin = await store.getMeta("admin");
    if (!admin) return false;
    const { hash } = await hashPassword(secret, admin.salt);
    return secretsEqual(hash, admin.hash);
  }

  async function isAdmin(req) {
    const auth = String(req.headers.authorization || "");
    if (auth.startsWith("Bearer ")) return checkCredential(auth.slice(7).trim());
    const sid = parseCookies(req.headers.cookie)[COOKIE];
    if (!sid) return false;
    const exp = sessions.get(sid);
    if (!exp || exp < config.now()) {
      sessions.delete(sid);
      return false;
    }
    return true;
  }

  function startSession(req, res) {
    const sid = randomBytes(32).toString("base64url");
    sessions.set(sid, config.now() + config.sessionHours * 3600_000);
    const parts = [`${COOKIE}=${sid}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${config.sessionHours * 3600}`];
    if (isSecure(req)) parts.push("Secure");
    res.setHeader("set-cookie", parts.join("; "));
  }

  async function requireAdmin(req) {
    if (!(await isAdmin(req))) throw httpError(401, "ADMIN_REQUIRED", "sign in as the ceremony admin");
  }

  // Same-origin check for cookie-authenticated writes (SameSite=Strict already blocks most CSRF).
  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    const host = req.headers["x-forwarded-host"] && config.trustProxy ? req.headers["x-forwarded-host"] : req.headers.host;
    try {
      return new URL(origin).host === host || (config.publicUrl && origin === config.publicUrl);
    } catch {
      return false;
    }
  }

  async function adminInfo(req) {
    const st = await ceremony.publicState();
    return {
      adminExists: await adminExists(),
      adminFromEnv: Boolean(config.adminToken),
      setupTokenRequired: Boolean(config.setupToken) && !(await adminExists()),
      signedIn: await isAdmin(req),
      ceremony: st,
      settings: (({ title, minContributions, closeAt, closeAfterCount }) => ({ title, minContributions, closeAt, closeAfterCount }))(await ceremony.get()),
      store: store.kind,
    };
  }

  const routes = {
    "GET /health": async (req, res) => {
      try {
        await store.ping();
        const c = await ceremony.get();
        send(res, 200, { ok: true, service: "zk-entropy-ceremony", status: c.status, store: store.kind });
      } catch {
        send(res, 503, { ok: false, service: "zk-entropy-ceremony" });
      }
    },
    "GET /api/state": async (req, res) => {
      await ceremony.maybeAutoClose();
      send(res, 200, { ...(await ceremony.publicState()), publicUrl: config.publicUrl || null });
    },
    "GET /api/transcript": async (req, res) => {
      await ceremony.maybeAutoClose();
      send(res, 200, { transcript: await ceremony.transcript() });
    },
    "POST /api/contributions": async (req, res) => {
      if (rateLimited(req)) throw httpError(429, "RATE_LIMITED", "too many contributions from this network; try again in a minute");
      const body = await readJson(req);
      await ceremony.maybeAutoClose();
      const receipt = await ceremony.contribute({ contribution: body.contribution, clientTranscriptHash: body.clientTranscriptHash });
      send(res, 201, { receipt });
    },
    "GET /api/admin": async (req, res) => send(res, 200, await adminInfo(req)),
    "POST /api/admin/setup": async (req, res) => {
      const body = await readJson(req);
      if (config.adminToken) throw httpError(409, "ADMIN_FROM_ENV", "the admin is set by ADMIN_TOKEN; first-run setup is off");
      if (await store.getMeta("admin")) throw httpError(409, "ADMIN_EXISTS", "the admin already exists");
      if (config.setupToken && !secretsEqual(String(body.setupToken || req.headers["x-setup-token"] || ""), config.setupToken)) {
        throw httpError(403, "SETUP_TOKEN_REQUIRED", "a valid setup token is required");
      }
      const password = String(body.password || "");
      if (password.length < 12 || password.length > 256) throw httpError(400, "WEAK_PASSWORD", "use a passphrase of 12 to 256 characters");
      const record = { ...(await hashPassword(password)), createdAt: new Date(config.now()).toISOString() };
      if (!(await store.setMetaIfAbsent("admin", record))) throw httpError(409, "ADMIN_EXISTS", "the admin already exists");
      startSession(req, res);
      send(res, 201, { ...(await adminInfo(req)), signedIn: true });
    },
    "POST /api/admin/login": async (req, res) => {
      const body = await readJson(req);
      if (rateLimited(req)) throw httpError(429, "RATE_LIMITED", "too many attempts; wait a minute");
      if (!(await checkCredential(String(body.password || body.token || "")))) throw httpError(401, "BAD_CREDENTIAL", "wrong admin passphrase or token");
      startSession(req, res);
      send(res, 200, { signedIn: true });
    },
    "POST /api/admin/logout": async (req, res) => {
      const sid = parseCookies(req.headers.cookie)[COOKIE];
      if (sid) sessions.delete(sid);
      res.setHeader("set-cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
      send(res, 200, { signedIn: false });
    },
    "PUT /api/admin/settings": async (req, res) => {
      await requireAdmin(req);
      const body = await readJson(req);
      await ceremony.updateSettings(body);
      await ceremony.maybeAutoClose();
      send(res, 200, await adminInfo(req));
    },
    "POST /api/admin/open": async (req, res) => {
      await requireAdmin(req);
      await readJson(req);
      await ceremony.open();
      send(res, 200, await adminInfo(req));
    },
    "POST /api/admin/close": async (req, res) => {
      await requireAdmin(req);
      const body = await readJson(req);
      await ceremony.close({ reason: "manual", force: body.force === true });
      send(res, 200, await adminInfo(req));
    },
  };

  async function serveStatic(pathname, res) {
    if (pathname === "/lib/zk-entropy.js") {
      return send(res, 200, await readFile(LIB_FILE), { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300" });
    }
    const hit = STATIC[pathname] || STATIC[pathname.replace(/\/+$/, "") || "/"];
    if (!hit) return false;
    send(res, 200, await readFile(path.join(PUBLIC_DIR, hit[0])), { "content-type": hit[1], "cache-control": hit[1].startsWith("text/html") ? "no-store" : "public, max-age=300" });
    return true;
  }

  async function handler(req, res) {
    try {
      const url = new URL(req.url, "http://local");
      const key = `${req.method} ${url.pathname}`;
      const route = routes[key];
      if (route) {
        if (req.method !== "GET" && !sameOrigin(req)) throw httpError(403, "CROSS_ORIGIN", "cross-origin request refused");
        return await route(req, res);
      }
      if (req.method === "GET" || req.method === "HEAD") {
        if ((await serveStatic(url.pathname, res)) !== false) return;
      }
      if (url.pathname.startsWith("/api/")) return send(res, 404, { error: "NOT_FOUND" });
      send(res, 404, "Not found");
    } catch (err) {
      fail(res, err);
    }
  }

  let timer = null;
  if (config.autoCloseIntervalMs > 0) {
    timer = setInterval(() => ceremony.maybeAutoClose().catch((e) => console.error("[ceremony] auto-close:", e.message)), config.autoCloseIntervalMs);
    timer.unref();
  }

  return {
    handler,
    config,
    store,
    ceremony,
    async close() {
      clearInterval(timer);
      await store.close();
    },
  };
}

export async function start(env = process.env) {
  const app = await createApp({}, env);
  const server = http.createServer(app.handler);
  server.listen(app.config.port, app.config.host, () => {
    console.log(`zk-entropy ceremony (NOT FOR PROFIT) on ${app.config.host}:${app.config.port} store=${app.store.kind}`);
  });
  const stop = () => server.close(() => app.close().then(() => process.exit(0)));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  return { server, app };
}

const isMain = (() => {
  try {
    return process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (isMain) {
  start().catch((err) => {
    console.error(`[ceremony] failed to start: ${err.message}`);
    process.exit(1);
  });
}

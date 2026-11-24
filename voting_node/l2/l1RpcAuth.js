"use strict";

// NOT FOR PROFIT — civic public good, not a commercial product.
//
// Optional bearer token for L1 JSON-RPC. L1_RPC_AUTH_TOKEN is empty by
// default. A non-empty value adds `Authorization: Bearer <token>` to L1
// calls. An unset or blank value sends no Authorization header.
// Never log, print, or put the token in an error message.

function readL1RpcAuthToken(env = process.env) {
  if (!env || typeof env !== "object") return "";
  const raw = env.L1_RPC_AUTH_TOKEN;
  if (raw == null) return "";
  return String(raw).trim();
}

/**
 * Headers for a raw fetch JSON-RPC call.
 * `content-type` matches the previous unauthenticated calls.
 * Authorization is omitted when the token is unset or blank.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {Record<string, string>} [base]
 */
function l1RpcHeaders(env = process.env, base) {
  const headers = { "content-type": "application/json" };
  if (base && typeof base === "object") {
    for (const [key, value] of Object.entries(base)) {
      if (key.toLowerCase() === "authorization") continue;
      headers[key] = value;
    }
  }
  const token = readL1RpcAuthToken(env);
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * viem `http()` transport. With no token this is `http(rpcUrl)`, the same
 * call as before. With a token, the bearer header is set on fetchOptions.
 *
 * @param {Function} http viem's `http` transport factory
 * @param {string} rpcUrl
 * @param {NodeJS.ProcessEnv} [env]
 */
function l1ViemHttp(http, rpcUrl, env = process.env) {
  if (typeof http !== "function") {
    throw new Error("l1ViemHttp: http transport factory is required");
  }
  const token = readL1RpcAuthToken(env);
  if (!token) return http(rpcUrl);
  return http(rpcUrl, {
    fetchOptions: {
      headers: { Authorization: `Bearer ${token}` },
    },
  });
}

/**
 * Replace the token with `[redacted]`. A missing token leaves the text unchanged.
 *
 * @param {unknown} text
 * @param {NodeJS.ProcessEnv|string} [env] Env object, or the token itself.
 */
function redactL1RpcAuth(text, env = process.env) {
  const token = typeof env === "string" ? String(env).trim() : readL1RpcAuthToken(env);
  const raw = text == null ? "" : String(text);
  if (!token) return raw;
  return raw.split(token).join("[redacted]");
}

/**
 * Scrub the token from an error's message, details, and stack before it is
 * logged or returned to a caller. Mutates `err` and returns it.
 *
 * @param {unknown} err
 * @param {NodeJS.ProcessEnv|string} [env]
 */
function scrubL1RpcAuthError(err, env = process.env) {
  const token = typeof env === "string" ? String(env).trim() : readL1RpcAuthToken(env);
  if (!err || !token) return err;
  if (typeof err === "string") return redactL1RpcAuth(err, token);
  for (const key of ["message", "shortMessage", "details", "stack"]) {
    if (typeof err[key] === "string" && err[key].includes(token)) {
      err[key] = err[key].split(token).join("[redacted]");
    }
  }
  if (err.cause) scrubL1RpcAuthError(err.cause, token);
  return err;
}

module.exports = {
  readL1RpcAuthToken,
  l1RpcHeaders,
  l1ViemHttp,
  redactL1RpcAuth,
  scrubL1RpcAuthError,
};

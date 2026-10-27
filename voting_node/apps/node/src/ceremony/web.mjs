// NOT FOR PROFIT — civic public good, not a commercial product.
// Page routing and the scoped Content-Security-Policy for the ceremony UI.
//
// The repo has no global CSP. These headers apply only to the ceremony pages,
// their scripts, the contribution worker, and the vendored snarkjs build.
//
// Pages:   script-src 'self'. No inline script, no eval, no CDN.
// Worker:  adds 'wasm-unsafe-eval' (snarkjs compiles its BN254 field and curve
//          code to WebAssembly) and blob: (ffjavascript starts its thread
//          pool from blob: URLs). 'wasm-unsafe-eval' permits WebAssembly
//          compilation only; it does not allow eval() or new Function().
//          It is sent on the worker script and snarkjs only, never on a page.

import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

export const CEREMONY_PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "style-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

export const CEREMONY_WORKER_CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval' blob:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "base-uri 'none'",
].join('; ');

const WORKER_SCRIPTS = new Set(['/ceremony-worker.js', '/vendor/snarkjs.min.js']);

/** Which HTML file serves a ceremony URL, or null. Checked before /admin. */
export function ceremonyHtmlFile(cleanPath) {
  if (cleanPath === '/admin/ceremony' || cleanPath.startsWith('/admin/ceremony/')) return 'admin-ceremony.html';
  if (/^\/ceremony\/[^/]+\/transcript$/.test(cleanPath)) return 'ceremony-transcript.html';
  if (cleanPath === '/ceremony' || /^\/ceremony\/[^/]+$/.test(cleanPath)) return 'ceremony.html';
  return null;
}

export function ceremonyCsp() {
  return function ceremonyCspMiddleware(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const p = req.path.replace(/\/+$/, '') || '/';
    if (WORKER_SCRIPTS.has(p)) {
      res.setHeader('Content-Security-Policy', CEREMONY_WORKER_CSP);
    } else if (ceremonyHtmlFile(p) || /^\/(admin-)?ceremony(-transcript)?\.(js|css)$/.test(p)) {
      res.setHeader('Content-Security-Policy', CEREMONY_PAGE_CSP);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'same-origin');
    }
    next();
  };
}

/** Serve the browser build of snarkjs from node_modules. No CDN. */
export function snarkjsVendorRoute() {
  const file = path.join(path.dirname(require.resolve('snarkjs')), 'snarkjs.min.js');
  return function snarkjsVendor(_req, res) {
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(file);
  };
}

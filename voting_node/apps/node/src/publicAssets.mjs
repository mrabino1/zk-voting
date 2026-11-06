// NOT FOR PROFIT — civic public good, not a commercial product.
// A named host's HTML does not contain the Demo chip. Script URLs carry a
// content version so a reload cannot keep the previous passkey page.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const VERSION_FILES = ['app.js', 'setup.js', 'passkey-wallet.js', 'styles.css', 'index.html', 'host-chrome.js'];

export function assetVersion(dir) {
  const hash = crypto.createHash('sha256');
  for (const name of VERSION_FILES) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    hash.update(name);
    hash.update(fs.readFileSync(file));
  }
  return hash.digest('hex').slice(0, 12);
}

export function stripNamedHostDemo(html) {
  return String(html || '')
    .replace(/\s*<span class="topbar-chip" id="topbar-demo"[^>]*>\s*Demo\s*<\/span>/, '')
    .replace(/\s*<p class="footer-meta" id="footer-demo"[\s\S]*?<\/p>/, '');
}

export function versionHtmlAssets(html, version) {
  const v = encodeURIComponent(version || '');
  if (!v) return String(html || '');
  return String(html || '').replace(
    /(\s(?:src|href)=["'])(\/(?:[^"'?#]+)\.(?:js|css))(?:\?[^"']*)?(["'])/gi,
    (_, lead, url, quote) => `${lead}${url}?v=${v}${quote}`,
  );
}

export function rewriteModuleSpecifiers(source, version) {
  const v = encodeURIComponent(version || '');
  if (!v) return String(source || '');
  return String(source || '').replace(
    /((?:from|import)\s*(?:\(\s*)?)(['"])(\.{1,2}\/[^'"?#]+\.js)(?:\?[^'"]*)?\2/g,
    (_, lead, quote, spec) => `${lead}${quote}${spec}?v=${v}${quote}`,
  );
}

/**
 * @param {string} html
 * @param {{ voteFqdn?: string, assetVersion?: string }} [opts]
 */
export function renderPublicHtml(html, { voteFqdn = '', assetVersion: version = '' } = {}) {
  let out = String(html || '');
  if (String(voteFqdn || '').trim()) out = stripNamedHostDemo(out);
  if (version) out = versionHtmlAssets(out, version);
  return out;
}

export function versionedPublicScripts(root, version) {
  const rootResolved = path.resolve(root);
  return function versionedScript(req, res, next) {
    if (!req.path.endsWith('.js')) return next();
    const file = path.resolve(rootResolved, `.${req.path}`);
    if (file !== rootResolved && !file.startsWith(`${rootResolved}${path.sep}`)) return next();
    if (!fs.existsSync(file)) return next();
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return next();
    }
    if (!stat.isFile()) return next();
    const body = rewriteModuleSpecifiers(fs.readFileSync(file, 'utf8'), version);
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', req.query?.v ? 'public, max-age=31536000, immutable' : 'no-cache');
    res.send(body);
  };
}

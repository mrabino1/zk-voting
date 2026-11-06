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

function escapeAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const POWERED_BY =
  '<p class="powered-by"><a class="powered-by-link" href="https://zk-voting.org">' +
  '<img class="powered-by-mark" src="/brand-mark.svg" alt="" width="16" height="16" />' +
  'powered by zk-voting.org</a></p>';

/**
 * A deployed host (VOTE_FQDN) is the client's site. Drop the civic ribbon,
 * the "not for profit" badge, and the ZK-Voting footer. Leave a small
 * powered-by link. Logo, name, and optional link come from clientBrand.
 */
export function applyClientHostHtml(html, clientBrand) {
  if (!clientBrand?.active) return String(html || '');
  let out = String(html || '');
  if (clientBrand.logoUrl) {
    const src = escapeAttr(clientBrand.logoUrl);
    out = out.replace(
      /(<span\b[^>]*\bclass="[^"]*\bbrand-mark\b[^"]*"[^>]*>\s*<img\b[^>]*\ssrc=")[^"]+(")/gi,
      `$1${src}$2`,
    );
  }
  if (clientBrand.href) {
    const href = escapeAttr(clientBrand.href);
    out = out.replace(/<a\b[^>]*\bclass="[^"]*\bbrand\b[^"]*"[^>]*>/gi, (tag) =>
      /\bhref="/.test(tag) ? tag.replace(/\bhref="[^"]*"/, `href="${href}"`) : tag.replace(/<a\b/i, `<a href="${href}"`),
    );
  }
  const civicSub =
    /<span\b[^>]*\bclass="[^"]*\bbrand-sub\b[^"]*"[^>]*\bdata-i18n="chrome\.brandSub"[^>]*>[\s\S]*?<\/span>/gi;
  if (clientBrand.subtitle) {
    const text = escapeAttr(clientBrand.subtitle);
    out = out.replace(civicSub, `<span class="brand-sub">${text}</span>`);
  } else {
    out = out.replace(civicSub, '');
  }
  out = out.replace(/<!--[\s\S]*?-->/g, (comment) =>
    /not for profit|civic public good|not a commercial product/i.test(comment) ? '' : comment,
  );
  out = out.replace(
    /<li>\s*<a\b[^>]*\bhref="https:\/\/(?:www\.|community\.)?zk-voting\.org\/?"[^>]*>[\s\S]*?<\/a>\s*<\/li>/gi,
    '',
  );
  out = out.replace(/<div\b[^>]*\bnfp-banner\b[^>]*>[\s\S]*?<\/div>/gi, '');
  out = out.replace(/<span\b[^>]*\bclass="[^"]*\boffice-badge\b[^"]*"[^>]*>[\s\S]*?<\/span>/gi, '');
  out = out.replace(/<footer\b([^>]*)>([\s\S]*?)<\/footer>/gi, (full, attrs) => {
    if (!/\bsite-footer\b/.test(attrs)) return full;
    const withClass = /\bsite-footer-client\b/.test(attrs)
      ? attrs
      : attrs.replace(/\bclass="([^"]*)"/, 'class="$1 site-footer-client"');
    return `<footer${withClass}>${POWERED_BY}</footer>`;
  });
  out = out.replace(/\sdata-i18n="chrome\.titleHome"/g, '');
  out = out.replace(/\sdata-i18n-content="chrome\.metaDescription"/g, '');
  out = out.replace(/ — civic elections/g, '');
  if (/<html\b/i.test(out) && !/\bdata-client-host=/.test(out)) {
    out = out.replace(/<html\b/i, '<html data-client-host="1"');
  }
  return out;
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
/** Replace the header mark. An empty URL keeps the built-in /brand-mark.svg. */
export function applyHeaderLogo(html, logoUrl) {
  const src = String(logoUrl || '').trim();
  if (!src) return String(html || '');
  const safe = escapeAttr(src);
  return String(html || '').replace(
    /(<span\b[^>]*\bclass="[^"]*\bbrand-mark\b[^"]*"[^>]*>\s*<img\b[^>]*\ssrc=")[^"]+(")/gi,
    `$1${safe}$2`,
  );
}

export function renderPublicHtml(html, { voteFqdn = '', assetVersion: version = '', clientBrand = null, logoUrl = '' } = {}) {
  let out = String(html || '');
  if (String(voteFqdn || '').trim()) {
    out = stripNamedHostDemo(out);
    out = applyClientHostHtml(out, clientBrand?.active ? clientBrand : { active: true });
  }
  const mark = logoUrl || (clientBrand?.active ? clientBrand.logoUrl : '');
  if (mark) out = applyHeaderLogo(out, mark);
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

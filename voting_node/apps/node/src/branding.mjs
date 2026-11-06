// NOT FOR PROFIT — civic public good, not a commercial product.
// Branding: the one source of truth for the product's display name.
//
// Precedence, highest first:
//   1. Site admin (Layout & appearance > Branding), saved in the store by a
//      super admin or admin (`manage_branding`).
//   2. Optional layout file / code override (LAYOUT_FILE, layout.override.mjs).
//   3. Environment defaults: BRAND_NAME, BRAND_SHORT_NAME, BRAND_TAGLINE.
//   4. Built-in defaults: "ZK-Voting".
//
// Branding is display text only. Storage keys, cookie names, headers, env var
// names, schema ids, EIP-712 domains, hash domain tags and smart-contract names
// use fixed zk-voting identifiers and never read from here.

export const DEFAULT_BRAND_NAME = 'ZK-Voting';
export const DEFAULT_BRAND_TAGLINE = 'Private, publicly verifiable civic voting.';
export const BRAND_NAME_MAX = 60;
export const BRAND_SHORT_NAME_MAX = 24;
export const BRAND_TAGLINE_MAX = 160;
export const BRAND_SUBTITLE_MAX = 80;

/**
 * Names that earlier releases wrote into saved layouts / site rows as the
 * built-in default. They mean "not renamed", so the current default applies.
 */
export const LEGACY_DEFAULT_NAMES = Object.freeze(['zk-voting', 'ZK-Voting']);

const UNSAFE_RE = /[<>{}"`\\]/;

/** Trim, drop control characters, cap length. Returns '' for unusable input. */
export function cleanBrandText(value, max) {
  const s = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s || s.length > max || UNSAFE_RE.test(s)) return '';
  return s;
}

/** True when `value` is a safe brand string (used by validators to reject bad input). */
export function isSafeBrandText(value, max) {
  const s = String(value ?? '').trim();
  return !s || (s.length <= max && !UNSAFE_RE.test(s));
}

/**
 * A path on this site, or an https URL. Empty, javascript:, data:, and
 * protocol-relative URLs are rejected. A bad value is ignored, not thrown,
 * so a mistyped logo does not take the Node down.
 */
export function cleanPublicUrl(value) {
  const s = String(value ?? '').trim();
  if (!s || s.length > 512 || /[\s<>"']/.test(s)) return '';
  if (/^\/(?!\/)[A-Za-z0-9\-._~!$&'()*+,;=:@%/?#]*$/.test(s)) return s;
  if (!/^https:\/\//i.test(s)) return '';
  try {
    const url = new URL(s);
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    return url.toString();
  } catch {
    return '';
  }
}

/**
 * Face of a deployed client. Ignored unless VOTE_FQDN is set, so a demo keeps
 * the ZK-Voting mark and "Office of civic elections".
 *
 * CLIENT_BRAND_NAME   header and product display name (optional)
 * CLIENT_LOGO_URL     header mark: site path or https URL (optional)
 * CLIENT_BRAND_URL    where the logo and name link (optional; default is /)
 * CLIENT_BRAND_SUBTITLE  line under the name (optional; default is none)
 */
export function resolveClientBrand({ voteFqdn = '', env = process.env } = {}) {
  const active = Boolean(String(voteFqdn || '').trim());
  if (!active) {
    return { active: false, name: '', logoUrl: '', href: '', subtitle: '' };
  }
  return {
    active: true,
    name: cleanBrandText(env.CLIENT_BRAND_NAME, BRAND_NAME_MAX),
    logoUrl: cleanPublicUrl(env.CLIENT_LOGO_URL),
    href: cleanPublicUrl(env.CLIENT_BRAND_URL),
    subtitle: cleanBrandText(env.CLIENT_BRAND_SUBTITLE, BRAND_SUBTITLE_MAX),
  };
}

/** Env / built-in defaults. */
export function brandDefaults(env = process.env) {
  const name = cleanBrandText(env.BRAND_NAME, BRAND_NAME_MAX) || DEFAULT_BRAND_NAME;
  return {
    name,
    shortName: cleanBrandText(env.BRAND_SHORT_NAME, BRAND_SHORT_NAME_MAX) || name,
    tagline: cleanBrandText(env.BRAND_TAGLINE, BRAND_TAGLINE_MAX) || DEFAULT_BRAND_TAGLINE,
  };
}

let provider = null;

/** Register the live branding source (createApp wires the layout service). */
export function setBrandingProvider(fn) {
  provider = typeof fn === 'function' ? fn : null;
}

/** Current branding: `{ name, shortName, tagline }`. Never throws. */
export function getBranding() {
  const defaults = brandDefaults();
  if (!provider) return defaults;
  try {
    const live = provider() || {};
    const name = cleanBrandText(live.name, BRAND_NAME_MAX) || defaults.name;
    return {
      name,
      shortName:
        cleanBrandText(live.shortName, BRAND_SHORT_NAME_MAX) ||
        (cleanBrandText(live.name, BRAND_NAME_MAX) ? name : defaults.shortName),
      tagline: cleanBrandText(live.tagline, BRAND_TAGLINE_MAX) || defaults.tagline,
    };
  } catch {
    return defaults;
  }
}

/** Current display name, e.g. "ZK-Voting". */
export function brandName() {
  return getBranding().name;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Split a display name for the two-tone wordmark.
 * A leading "ZK" (any case) followed by the end of the name, a space, or a
 * dash keeps that prefix separate from the rest. Any other name stays whole
 * so a custom display name is not cut in the middle of a word.
 * @returns {{ lead: string, rest: string } | null}
 */
export function splitBrandWordmark(name) {
  const value = String(name ?? '');
  const match = /^(zk)(?=$|[\s\u2010-\u2015-])/i.exec(value);
  if (!match) return null;
  return { lead: value.slice(0, match[1].length), rest: value.slice(match[1].length) };
}

/** HTML for the header wordmark. The name stays text; the mark is a separate image. */
export function brandWordmarkHtml(name) {
  const split = splitBrandWordmark(name);
  if (!split) return `<span class="brand-name-text">${escapeHtml(name)}</span>`;
  let html = `<span class="brand-zk">${escapeHtml(split.lead)}</span>`;
  if (split.rest) html += `<span class="brand-rest">${escapeHtml(split.rest)}</span>`;
  return html;
}

/**
 * Server-render branding into an HTML page. Pages use the placeholders
 * %BRAND_NAME%, %BRAND_SHORT_NAME%, %BRAND_TAGLINE%, and %BRAND_WORDMARK%.
 * Name, short name, and tagline are HTML-escaped. The wordmark placeholder
 * is safe markup built from the escaped display name.
 */
export function renderBrandedHtml(html, branding = getBranding()) {
  return String(html)
    .replace(/%BRAND_WORDMARK%/g, brandWordmarkHtml(branding.name))
    .replace(/%BRAND_NAME%/g, escapeHtml(branding.name))
    .replace(/%BRAND_SHORT_NAME%/g, escapeHtml(branding.shortName))
    .replace(/%BRAND_TAGLINE%/g, escapeHtml(branding.tagline));
}

/** Replace `{brand}` in plain text (server-side templates). */
export function withBrand(text, branding = getBranding()) {
  return String(text ?? '').replace(/\{brand\}/g, branding.name);
}

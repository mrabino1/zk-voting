// NOT FOR PROFIT — civic public good, not a commercial product.
//
// Site identity: who runs this site, and which project it is built from. This repository is
// meant to be forked, so nothing here may send a fork's visitors to the upstream project's
// inbox or advertise upstream's services on someone else's site.
//
// Two kinds of link:
//   Operator (this site's own; empty by default, hidden when empty)
//     contactEmail     the footer "Contact" address
//     contractingCta   the "available for contracting" line + button (off by default)
//   Project (the software this site runs; defaults point upstream, like "Powered by Discourse")
//     sourceUrl        "open source" link + GitHub icon. AGPL-3.0: a site running modified code
//                      must offer *its* source, so a fork should point this at its own repo.
//     projectUrl       "About" nav item, "What ZK Voting is", "powered by"; "none" hides them
//     forumUrl         community forum link; "none" hides it
//
// Precedence, highest first: saved in the app (/setup, Site admin), environment
// (SITE_CONTACT_EMAIL, SITE_CONTRACTING_CTA, SITE_SOURCE_URL, SITE_PROJECT_URL,
// SITE_FORUM_URL), built-in defaults below.

import { escapeHtml } from './branding.mjs';

export const UPSTREAM = Object.freeze({
  sourceUrl: 'https://github.com/mrabino1/zk-voting',
  projectUrl: 'https://zk-voting.org',
  forumUrl: 'https://community.zk-voting.org',
});

/** Values the upstream HTML pages are written with; replaced per site at render time. */
const PAGE = Object.freeze({
  contactEmail: 'hello@zk-voting.org',
  sourceUrl: 'https://github.com/mrabino1/zk-voting',
  projectUrl: 'https://zk-voting.org',
  forumUrl: 'https://community.zk-voting.org',
});

export const IDENTITY_FIELDS = Object.freeze(['contactEmail', 'contractingCta', 'sourceUrl', 'projectUrl', 'forumUrl']);

const EMAIL_RE = /^[^\s@<>"'`]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,}$/;

export function cleanEmail(value) {
  const s = String(value ?? '').trim();
  return EMAIL_RE.test(s) ? s : '';
}

/** https URL, or "" when unusable. */
export function cleanHttpsUrl(value) {
  const s = String(value ?? '').trim();
  if (!s || s.length > 300 || /[\s<>"'`]/.test(s)) return '';
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' || u.username || u.password) return '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function flag(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
}

/** A URL setting: "none" hides it, a valid https URL sets it, anything else falls through. */
function urlSetting(value) {
  if (value === null || value === undefined) return undefined;
  const s = String(value).trim();
  if (!s) return undefined;
  if (/^none$/i.test(s)) return '';
  return cleanHttpsUrl(s) || undefined;
}

/**
 * @param {{ env?: Record<string,string|undefined>, saved?: Record<string, unknown>|null }} opts
 * @returns {{ contactEmail: string, contractingCta: boolean, sourceUrl: string, projectUrl: string, forumUrl: string, sources: Record<string,string> }}
 */
export function resolveSiteIdentity({ env = process.env, saved = null } = {}) {
  const s = saved && typeof saved === 'object' ? saved : {};
  const sources = {};
  const pick = (field, savedValue, envValue, fallback) => {
    if (savedValue !== undefined) {
      sources[field] = 'saved';
      return savedValue;
    }
    if (envValue !== undefined) {
      sources[field] = 'environment';
      return envValue;
    }
    sources[field] = 'default';
    return fallback;
  };
  const emailSaved = typeof s.contactEmail === 'string' ? cleanEmail(s.contactEmail) || (s.contactEmail.trim() === '' ? '' : undefined) : undefined;
  const emailEnv = String(env.SITE_CONTACT_EMAIL ?? '').trim() ? cleanEmail(env.SITE_CONTACT_EMAIL) || undefined : undefined;
  return {
    contactEmail: pick('contactEmail', emailSaved, emailEnv, ''),
    contractingCta: pick(
      'contractingCta',
      typeof s.contractingCta === 'boolean' ? s.contractingCta : undefined,
      String(env.SITE_CONTRACTING_CTA ?? '').trim() ? flag(env.SITE_CONTRACTING_CTA) : undefined,
      false,
    ),
    sourceUrl: pick('sourceUrl', urlSetting(s.sourceUrl), urlSetting(env.SITE_SOURCE_URL), UPSTREAM.sourceUrl),
    projectUrl: pick('projectUrl', urlSetting(s.projectUrl), urlSetting(env.SITE_PROJECT_URL), UPSTREAM.projectUrl),
    forumUrl: pick('forumUrl', urlSetting(s.forumUrl), urlSetting(env.SITE_FORUM_URL), UPSTREAM.forumUrl),
    sources,
  };
}

/** Validate a save from /setup or Site admin. Returns the stored object, or throws Error(message). */
export function parseIdentityInput(body = {}) {
  const out = {};
  if ('contactEmail' in body) {
    const raw = String(body.contactEmail ?? '').trim();
    if (raw && !cleanEmail(raw)) throw new Error('Contact email must be a plain address like contact@example.org.');
    out.contactEmail = raw ? cleanEmail(raw) : '';
  }
  if ('contractingCta' in body) out.contractingCta = Boolean(body.contractingCta);
  for (const field of ['sourceUrl', 'projectUrl', 'forumUrl']) {
    if (!(field in body)) continue;
    const raw = body[field];
    if (raw === null) {
      out[field] = null; // back to the environment / default
      continue;
    }
    const s = String(raw ?? '').trim();
    if (!s || /^none$/i.test(s)) {
      if (field === 'sourceUrl') throw new Error('The source code link cannot be hidden: the AGPL licence requires offering the source.');
      out[field] = 'none';
      continue;
    }
    const url = cleanHttpsUrl(s);
    if (!url) throw new Error(`${field === 'sourceUrl' ? 'Source code' : field === 'forumUrl' ? 'Forum' : 'Project'} link must be an https:// address.`);
    out[field] = url;
  }
  return out;
}

function removeBlock(html, className) {
  const re = new RegExp(`\\s*<p\\b[^>]*\\bclass="${className}"[^>]*>[\\s\\S]*?<\\/p>`, 'gi');
  return html.replace(re, '');
}

/**
 * Render the identity into a page written with the upstream values (public/*.html).
 * Every replacement is HTML-escaped; empty operator values remove their block.
 */
export function applySiteIdentityHtml(html, identity) {
  if (!identity) return String(html || '');
  let out = String(html || '');
  const attr = (v) => escapeHtml(v);

  // Operator: contact line and contracting offer.
  if (identity.contactEmail) {
    out = out
      .split(`mailto:${PAGE.contactEmail}`)
      .join(`mailto:${attr(identity.contactEmail)}`)
      .split(`>${PAGE.contactEmail}<`)
      .join(`>${attr(identity.contactEmail)}<`);
  } else {
    out = removeBlock(out, 'footer-contact-line');
  }
  if (!identity.contractingCta || !identity.contactEmail) out = removeBlock(out, 'footer-contract');
  // Nothing left in the contact section's heading? Keep the section (it still holds the source link).
  out = out.replace(/(<section class="footer-extra")\s+aria-labelledby="footer-contact-label"/, (m, open) =>
    /id="footer-contact-label"/.test(out) ? m : open,
  );

  // Project: source, about, forum.
  out = out.split(PAGE.sourceUrl).join(attr(identity.sourceUrl));
  if (identity.forumUrl) {
    out = out.split(`"${PAGE.forumUrl}"`).join(`"${attr(identity.forumUrl)}"`);
  } else {
    out = out.replace(/\s*·\s*Discuss it on the\s*<a href="https:\/\/community\.zk-voting\.org">community forum<\/a>/g, '');
  }
  if (identity.projectUrl) {
    out = out.split(`"${PAGE.projectUrl}"`).join(`"${attr(identity.projectUrl)}"`);
  } else {
    out = out.replace(/\s*<li><a href="https:\/\/zk-voting\.org">About<\/a><\/li>/g, '');
    out = out.replace(/\s*What ZK Voting is and why it matters:\s*<a href="https:\/\/zk-voting\.org">zk-voting\.org<\/a>\s*(·)?/g, '');
  }
  return out;
}

/** <meta> tags the browser code reads (audience.js) for links it builds itself. */
export function identityMetaTags(identity) {
  if (!identity) return '';
  return (
    `<meta name="site-project-url" content="${escapeHtml(identity.projectUrl)}"/>\n` +
    `  <meta name="site-forum-url" content="${escapeHtml(identity.forumUrl)}"/>\n` +
    `  <meta name="site-source-url" content="${escapeHtml(identity.sourceUrl)}"/>\n`
  );
}

export function withIdentityMeta(html, identity) {
  if (!identity || /<meta name="site-project-url"/.test(html)) return html;
  const tags = identityMetaTags(identity);
  const charset = /<meta charset[^>]*>\s*/i;
  return charset.test(html) ? html.replace(charset, (m) => `${m}${tags}  `) : html.replace(/<head([^>]*)>\s*/i, (m) => `${m}${tags}  `);
}

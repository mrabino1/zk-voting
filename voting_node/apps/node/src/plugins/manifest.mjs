// NOT FOR PROFIT — civic public good, not a commercial product.
// Plugin manifest (`plugin.json`) schema and package checks.

import { createHash } from 'node:crypto';

import { CAPABILITIES } from '../capabilities.mjs';
import { safeEntryPath } from './zip.mjs';

export const PLUGIN_TYPES = Object.freeze(['ui', 'backoffice', 'both']);

/** Permissions a plugin may request. Shown to the admin before enable. */
export const PLUGIN_PERMISSIONS = Object.freeze({
  routes: 'Add HTTP routes under /api/plugins/<name>/',
  admin_pages: 'Add pages to the Site admin screen',
  menu: 'Add items to the Site admin menu',
  events: 'Receive app events (role changes, layout updates, plugin lifecycle)',
  storage: 'Keep its own small key/value settings (64 KiB)',
  'users:read': 'Read public user fields only (id, handle, role) and counts by role',
  'elections:read': 'Read public election summaries (no ballots, votes or keys)',
  layout: 'Adjust the site layout (re-validated like any layout edit)',
  client: 'Run a browser module in page slots (banner, header, sidebar, home, footer, admin pages)',
});

export const CLIENT_SLOTS = Object.freeze([
  'banner',
  'header',
  'sidebar',
  'home',
  'footer',
  'site-admin.page',
  'site-admin.dashboard',
]);

export const PLUGIN_EVENTS = Object.freeze([
  'user.role_changed',
  'layout.updated',
  'plugin.enabled',
  'plugin.disabled',
]);

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;
const SEMVER_RE = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})(?:-([0-9A-Za-z.-]{1,32}))?$/;
const ALLOWED_EXT = new Set(['.json', '.mjs', '.js', '.css', '.md', '.txt', '.png', '.webp']);
const BARE_FILES = new Set(['LICENSE', 'NOTICE', 'README', 'CHANGELOG']);

export class ManifestError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'ManifestError';
    this.code = 'MANIFEST_INVALID';
    this.field = field || null;
  }
}

export function parseSemver(v) {
  const parts = semverParts(v);
  return parts ? parts.nums : null;
}

function semverParts(v) {
  const m = SEMVER_RE.exec(String(v || ''));
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || '' };
}

/** Numeric semver compare. A release is newer than its own prerelease. Returns -1, 0, 1, or null. */
export function semverCmp(a, b) {
  const pa = semverParts(a);
  const pb = semverParts(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i += 1) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] > pb.nums[i] ? 1 : -1;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre && !pb.pre) return -1;
  if (!pa.pre && pb.pre) return 1;
  const as = pa.pre.split('.');
  const bs = pb.pre.split('.');
  const n = Math.min(as.length, bs.length);
  for (let i = 0; i < n; i += 1) {
    const aNum = /^\d+$/.test(as[i]);
    const bNum = /^\d+$/.test(bs[i]);
    if (aNum && bNum) {
      const d = Number(as[i]) - Number(bs[i]);
      if (d !== 0) return d > 0 ? 1 : -1;
    } else if (aNum !== bNum) {
      return aNum ? -1 : 1;
    } else if (as[i] !== bs[i]) {
      return as[i] > bs[i] ? 1 : -1;
    }
  }
  if (as.length === bs.length) return 0;
  return as.length > bs.length ? 1 : -1;
}

export function semverGt(a, b) {
  return semverCmp(a, b) === 1;
}

export function semverGte(a, b) {
  const c = semverCmp(a, b);
  return c === 1 || c === 0;
}

/**
 * Absolute http(s) URL with no credentials. Used for a plugin's update feed
 * and for the package URL inside that feed. There is no default host.
 * @param {unknown} raw
 * @param {string} field
 * @param {number} [max]
 * @returns {URL}
 */
export function assertPluginHttpUrl(raw, field, max = 2000) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > max || /[\u0000-\u0020\\]/.test(raw)) {
    throw new ManifestError(`${field} must be an http(s) URL`, field);
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ManifestError(`${field} must be an http(s) URL`, field);
  }
  if (url.username || url.password) throw new ManifestError(`${field} must not include credentials`, field);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ManifestError(`${field} must be an http(s) URL`, field);
  }
  if (!url.hostname || url.hostname.length > 253) throw new ManifestError(`${field} must be an http(s) URL`, field);
  url.hash = '';
  return url;
}

function str(m, key, max, required = true) {
  const v = m[key];
  if (v == null || v === '') {
    if (required) throw new ManifestError(`${key} is required`, key);
    return '';
  }
  if (typeof v !== 'string' || v.length > max || /[\u0000-\u001f<>]/.test(v)) {
    throw new ManifestError(`${key} must be plain text up to ${max} characters`, key);
  }
  return v.trim();
}

function entry(file, exts, field) {
  if (file == null || file === '') return null;
  let rel;
  try {
    rel = safeEntryPath(String(file));
  } catch {
    throw new ManifestError(`${field} path is unsafe`, field);
  }
  if (rel.endsWith('/') || !exts.some((e) => rel.endsWith(e))) {
    throw new ManifestError(`${field} must end with ${exts.join(' or ')}`, field);
  }
  return rel;
}

/**
 * Validate a parsed manifest. Returns a normalised copy.
 * @param {unknown} m
 * @param {{ appVersion?: string }} [ctx]
 */
export function validateManifest(m, ctx = {}) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new ManifestError('plugin.json must be an object');
  const name = String(m.name || '');
  if (!NAME_RE.test(name)) throw new ManifestError('name must be 3-50 chars of a-z, 0-9 and dashes', 'name');
  const version = String(m.version || '');
  if (!parseSemver(version)) throw new ManifestError('version must be semver (1.2.3)', 'version');
  const type = String(m.type || '');
  if (!PLUGIN_TYPES.includes(type)) throw new ManifestError(`type must be one of ${PLUGIN_TYPES.join(', ')}`, 'type');
  const minAppVersion = String(m.minAppVersion || '0.0.0');
  if (!parseSemver(minAppVersion)) throw new ManifestError('minAppVersion must be semver', 'minAppVersion');
  if (ctx.appVersion && !semverGte(ctx.appVersion, minAppVersion)) {
    throw new ManifestError(`needs app ${minAppVersion} or newer (running ${ctx.appVersion})`, 'minAppVersion');
  }

  const permissions = Array.isArray(m.permissions) ? [...new Set(m.permissions.map(String))] : [];
  for (const p of permissions) {
    if (!Object.hasOwn(PLUGIN_PERMISSIONS, p)) throw new ManifestError(`unknown permission ${p.slice(0, 40)}`, 'permissions');
  }

  const ep = m.entrypoints && typeof m.entrypoints === 'object' ? m.entrypoints : {};
  const entrypoints = {
    server: entry(ep.server, ['.mjs', '.js'], 'entrypoints.server'),
    client: entry(ep.client, ['.mjs', '.js'], 'entrypoints.client'),
    styles: entry(ep.styles, ['.css'], 'entrypoints.styles'),
  };
  if ((type === 'backoffice' || type === 'both') && !entrypoints.server && !entrypoints.client) {
    throw new ManifestError('backoffice plugins need a server or client entrypoint', 'entrypoints');
  }
  if (type === 'ui' && !entrypoints.client && !entrypoints.styles) {
    throw new ManifestError('ui plugins need a client or styles entrypoint', 'entrypoints');
  }
  if ((entrypoints.client || entrypoints.styles) && !permissions.includes('client')) {
    throw new ManifestError('client entrypoints require the "client" permission', 'permissions');
  }

  const slots = Array.isArray(m.slots) ? [...new Set(m.slots.map(String))] : [];
  for (const s of slots) {
    if (!CLIENT_SLOTS.includes(s)) throw new ManifestError(`unknown slot ${s.slice(0, 40)}`, 'slots');
  }
  if (slots.length && !entrypoints.client) throw new ManifestError('slots need a client entrypoint', 'slots');

  const hooks = Array.isArray(m.hooks) ? [...new Set(m.hooks.map(String))] : [];
  const hookPermission = { routes: 'routes', adminPages: 'admin_pages', menu: 'menu', layout: 'layout' };
  for (const h of hooks) {
    if (h.startsWith('event:')) {
      if (!PLUGIN_EVENTS.includes(h.slice(6))) throw new ManifestError(`unknown event ${h.slice(6, 46)}`, 'hooks');
      if (!permissions.includes('events')) throw new ManifestError('event hooks require the "events" permission', 'hooks');
      continue;
    }
    if (!hookPermission[h]) throw new ManifestError(`unknown hook ${h.slice(0, 40)}`, 'hooks');
    if (!permissions.includes(hookPermission[h])) {
      throw new ManifestError(`hook ${h} requires the "${hookPermission[h]}" permission`, 'hooks');
    }
  }
  if (hooks.length && !entrypoints.server) throw new ManifestError('server hooks need a server entrypoint', 'hooks');

  const adminPages = (Array.isArray(m.adminPages) ? m.adminPages : []).slice(0, 8).map((p, i) => {
    const id = String(p?.id || '');
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) throw new ManifestError(`adminPages[${i}].id invalid`, 'adminPages');
    const capability = String(p?.capability || 'access_site_admin');
    if (!CAPABILITIES.includes(capability)) throw new ManifestError(`adminPages[${i}].capability unknown`, 'adminPages');
    return { id, title: str(p, 'title', 60), capability };
  });
  if (adminPages.length && !permissions.includes('admin_pages')) {
    throw new ManifestError('adminPages require the "admin_pages" permission', 'adminPages');
  }
  const menu = (Array.isArray(m.menu) ? m.menu : []).slice(0, 8).map((item, i) => {
    const page = String(item?.page || '');
    if (!adminPages.some((p) => p.id === page)) throw new ManifestError(`menu[${i}].page must name an admin page`, 'menu');
    return { label: str(item, 'label', 60), page };
  });
  if (menu.length && !permissions.includes('menu')) throw new ManifestError('menu requires the "menu" permission', 'menu');

  const checksums = {};
  if (m.checksums != null) {
    if (typeof m.checksums !== 'object' || Array.isArray(m.checksums)) throw new ManifestError('checksums must be an object', 'checksums');
    for (const [file, hash] of Object.entries(m.checksums)) {
      if (!/^[0-9a-f]{64}$/.test(String(hash))) throw new ManifestError(`checksum for ${file} must be sha256 hex`, 'checksums');
      checksums[safeEntryPath(file)] = String(hash);
    }
  }

  // Optional update feed. Absent means this plugin is not checked. There is
  // no built-in catalogue and no default host.
  let updateUrl = '';
  if (m.updateUrl != null && m.updateUrl !== '') {
    updateUrl = assertPluginHttpUrl(m.updateUrl, 'updateUrl', 500).href;
  }
  let updatePublicKey = '';
  if (m.updatePublicKey != null && m.updatePublicKey !== '') {
    updatePublicKey = String(m.updatePublicKey).trim().replace(/^ed25519:/i, '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(updatePublicKey)) {
      throw new ManifestError('updatePublicKey must be a 32-byte ed25519 key (64 hex characters)', 'updatePublicKey');
    }
  }

  return {
    name,
    displayName: str(m, 'displayName', 80, false) || name,
    version,
    description: str(m, 'description', 400, false),
    author: str(m, 'author', 120),
    license: str(m, 'license', 60),
    homepage: m.homepage ? str(m, 'homepage', 200, false) : '',
    type,
    minAppVersion,
    permissions,
    entrypoints,
    hooks,
    slots,
    adminPages,
    menu,
    checksums,
    updateUrl,
    updatePublicKey,
  };
}

export function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** Deterministic package checksum: sha256 over sorted `path\0sha256(file)\n`. */
export function packageChecksum(files) {
  const lines = [...files.keys()].sort().map((name) => `${name}\0${sha256Hex(files.get(name))}\n`);
  return sha256Hex(Buffer.from(lines.join(''), 'utf8'));
}

const CSP_UNSAFE = [
  [/\beval\s*\(/, 'eval()'],
  [/\bnew\s+Function\s*\(/, 'new Function()'],
  [/\bset(?:Timeout|Interval)\s*\(\s*['"`]/, 'string timers'],
  [/\bdocument\.write(?:ln)?\s*\(/, 'document.write'],
  [/\bimport\s*\(\s*['"`](?:https?:)?\/\//, 'remote dynamic import'],
  [/\bfrom\s+['"](?:https?:)?\/\//, 'remote static import'],
  [/javascript:/i, 'javascript: URL'],
];

/**
 * Check every file in a plugin package (path rules, allowed types, checksums,
 * CSP-safe client code). Returns the validated manifest.
 * @param {Map<string, Buffer>} files
 * @param {{ appVersion?: string }} [ctx]
 */
export function validatePackage(files, ctx = {}) {
  const raw = files.get('plugin.json');
  if (!raw) throw new ManifestError('plugin.json missing at the plugin root', 'plugin.json');
  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new ManifestError('plugin.json is not valid JSON', 'plugin.json');
  }
  const manifest = validateManifest(parsed, ctx);
  for (const name of files.keys()) {
    const base = name.split('/').pop();
    const dot = base.lastIndexOf('.');
    const ext = dot > 0 ? base.slice(dot).toLowerCase() : '';
    if (!(ext ? ALLOWED_EXT.has(ext) : BARE_FILES.has(base))) {
      throw new ManifestError(`file type not allowed: ${name}`, 'files');
    }
    if (base.startsWith('.')) throw new ManifestError(`hidden files are not allowed: ${name}`, 'files');
  }
  for (const [field, rel] of Object.entries(manifest.entrypoints)) {
    if (rel && !files.has(rel)) throw new ManifestError(`entrypoints.${field} file missing: ${rel}`, 'entrypoints');
  }
  for (const [file, hash] of Object.entries(manifest.checksums)) {
    const data = files.get(file);
    if (!data) throw new ManifestError(`checksum names a missing file: ${file}`, 'checksums');
    if (sha256Hex(data) !== hash) throw new ManifestError(`checksum mismatch: ${file}`, 'checksums');
  }
  for (const [name, data] of files) {
    if (!/\.(m?js)$/.test(name)) continue;
    if (isServerFile(manifest, name)) continue;
    const src = data.toString('utf8');
    for (const [re, label] of CSP_UNSAFE) {
      if (re.test(src)) throw new ManifestError(`${name}: ${label} is not allowed in client code (CSP)`, 'csp');
    }
  }
  return manifest;
}

/** Server-side files are never served to browsers. */
export function isServerFile(manifest, name) {
  return name === manifest.entrypoints.server || name.startsWith('server/');
}

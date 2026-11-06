// NOT FOR PROFIT — civic public good, not a commercial product.
// Site layout: navigation, regions/widgets, order, visibility and theme tokens.
//
// Effective layout = defaults
//   <- database layout (edited on the Layout screen, `edit_layout`)
//   <- optional JSON file override (LAYOUT_FILE, default apps/node/site/layout.json)
//   <- optional handwritten code override (LAYOUT_OVERRIDE_MODULE, default
//      apps/node/site/layout.override.mjs) exporting `default (layout) => layout`.
// Every layer is validated with the same rules, so no layer can inject script,
// `javascript:` links or CSS outside the theme-token allow-list.

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  BRAND_NAME_MAX,
  BRAND_SHORT_NAME_MAX,
  BRAND_TAGLINE_MAX,
  DEFAULT_BRAND_NAME,
  LEGACY_DEFAULT_NAMES,
  brandDefaults,
  cleanPublicUrl,
  isSafeBrandText,
} from './branding.mjs';
import { HttpError } from './http.mjs';

export const LAYOUT_VERSION = 1;
/**
 * Product name until a super admin or admin renames it (Appearance > Branding).
 * BRAND_NAME in the environment replaces this default; see branding.mjs.
 */
export const DEFAULT_PRODUCT_NAME = DEFAULT_BRAND_NAME;
/** Branding fields a layout may set. Empty string = inherit (env / built-in default). */
export const BRANDING_FIELDS = Object.freeze({
  productName: BRAND_NAME_MAX,
  shortName: BRAND_SHORT_NAME_MAX,
  tagline: BRAND_TAGLINE_MAX,
});
export const REGIONS = Object.freeze(['banner', 'header', 'sidebar', 'home', 'footer']);
export const AUDIENCES = Object.freeze(['all', 'signed_in', 'signed_out', 'officer', 'admin']);
export const WIDGET_TYPES = Object.freeze(['notice', 'links', 'plugin']);

/** Theme tokens a layout may set. Keys map to existing CSS custom properties in styles.css. */
export const THEME_TOKENS = Object.freeze({
  canvas: 'color',
  card: 'color',
  fg: 'color',
  muted: 'color',
  border: 'color',
  project: 'color',
  'project-text': 'color',
  org: 'color',
  focus: 'color',
  radius: 'length',
  'radius-card': 'length',
  'font-sans': 'font',
  measure: 'length',
});

const ID_RE = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;
const COLOR_RE = /^(#[0-9a-f]{3}|#[0-9a-f]{4}|#[0-9a-f]{6}|#[0-9a-f]{8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\))$/i;
const LENGTH_RE = /^(0|\d{1,3}(\.\d{1,3})?(rem|em|px|ch|%))$/;
const FONT_RE = /^[A-Za-z0-9 ,"'-]{1,160}$/;
const MAX_NAV = 24;
const MAX_WIDGETS_PER_REGION = 12;

export function defaultLayout() {
  return {
    version: LAYOUT_VERSION,
    nav: {
      // When `managed` is false the page keeps its built-in navigation and the
      // runtime only appends `items` marked `extra` and hides `hidden` hrefs.
      managed: false,
      items: [],
      hidden: [],
    },
    regions: Object.fromEntries(REGIONS.map((r) => [r, []])),
    theme: { light: {}, dark: {} },
    // Empty strings mean "not renamed": the env / built-in default applies.
    branding: { productName: '', shortName: '', tagline: '', logoUrl: '' },
  };
}

/** Header mark until Branding sets a logo. Not stored; an empty logoUrl means this. */
export const DEFAULT_LOGO_URL = '/brand-mark.svg';

export function brandingLayer(input) {
  const out = { productName: '', shortName: '', tagline: '', logoUrl: '' };
  for (const [field, max] of Object.entries(BRANDING_FIELDS)) {
    const value = text(input?.[field], max, field === 'productName' ? 'product name' : field);
    if (!isSafeBrandText(value, max)) {
      throw new HttpError(400, `${field === 'productName' ? 'product name' : field} has unsupported characters`, {
        code: 'LAYOUT_INVALID',
        field,
      });
    }
    out[field] = value;
  }
  // Earlier releases always saved the built-in default; treat it as "not renamed".
  if (LEGACY_DEFAULT_NAMES.includes(out.productName)) out.productName = '';
  const logoRaw = String(input?.logoUrl ?? '').trim();
  if (logoRaw && logoRaw !== DEFAULT_LOGO_URL) {
    const logo = cleanPublicUrl(logoRaw);
    if (!logo) {
      throw new HttpError(400, 'logo URL must be a site path or an https URL', { code: 'LAYOUT_INVALID', field: 'logoUrl' });
    }
    out.logoUrl = logo;
  }
  return out;
}

/** Fill empty branding fields from the env / built-in defaults. */
export function resolveBranding(branding, defaults = brandDefaults()) {
  const productName = branding?.productName || defaults.name;
  return {
    productName,
    shortName: branding?.shortName || (branding?.productName ? productName : defaults.shortName),
    tagline: branding?.tagline || defaults.tagline,
    logoUrl: branding?.logoUrl || defaults.logoUrl || '',
  };
}

function text(value, max, field) {
  const s = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (s.length > max) throw new HttpError(400, `${field} is too long`, { code: 'LAYOUT_INVALID', field });
  return s;
}

/** Same-origin path or https URL. Never javascript:, data:, protocol-relative. */
export function safeHref(value, field = 'href') {
  const s = String(value ?? '').trim();
  if (/^\/(?!\/)[A-Za-z0-9\-._~!$&'()*+,;=:@%/?#]*$/.test(s) && s.length <= 512) return s;
  if (/^https:\/\/[^\s<>"']+$/i.test(s) && s.length <= 512) {
    try {
      const url = new URL(s);
      if (url.protocol === 'https:' && !url.username && !url.password) return url.toString();
    } catch {
      /* fallthrough */
    }
  }
  throw new HttpError(400, `${field} must be a site path or https URL`, { code: 'LAYOUT_INVALID', field });
}

function id(value, field) {
  const s = String(value ?? '').trim();
  if (!ID_RE.test(s)) throw new HttpError(400, `${field} must be a short id`, { code: 'LAYOUT_INVALID', field });
  return s;
}

function audience(value) {
  const s = String(value || 'all');
  if (!AUDIENCES.includes(s)) throw new HttpError(400, 'invalid audience', { code: 'LAYOUT_INVALID' });
  return s;
}

function order(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(-1000, Math.min(1000, Math.round(n))) : fallback;
}

export function validateThemeValue(token, value) {
  const kind = THEME_TOKENS[token];
  if (!kind) throw new HttpError(400, `unknown theme token ${String(token).slice(0, 40)}`, { code: 'LAYOUT_INVALID' });
  const s = String(value ?? '').trim();
  const ok =
    (kind === 'color' && COLOR_RE.test(s)) ||
    (kind === 'length' && LENGTH_RE.test(s)) ||
    (kind === 'font' && FONT_RE.test(s));
  if (!ok) throw new HttpError(400, `invalid value for --${token}`, { code: 'LAYOUT_INVALID', token });
  return s;
}

function theme(input) {
  const out = { light: {}, dark: {} };
  for (const mode of ['light', 'dark']) {
    const tokens = input?.[mode];
    if (tokens == null) continue;
    if (typeof tokens !== 'object' || Array.isArray(tokens)) {
      throw new HttpError(400, 'theme tokens must be an object', { code: 'LAYOUT_INVALID' });
    }
    for (const [key, value] of Object.entries(tokens)) {
      if (value === '' || value == null) continue;
      out[mode][key] = validateThemeValue(key, value);
    }
  }
  return out;
}

function widget(input, index, region) {
  if (!input || typeof input !== 'object') throw new HttpError(400, 'widget must be an object', { code: 'LAYOUT_INVALID' });
  const type = String(input.type || '');
  if (!WIDGET_TYPES.includes(type)) throw new HttpError(400, 'invalid widget type', { code: 'LAYOUT_INVALID' });
  const out = {
    id: id(input.id || `${region}-${index + 1}`, 'widget id'),
    type,
    title: text(input.title, 120, 'widget title'),
    visible: input.visible !== false,
    order: order(input.order, index * 10),
    audience: audience(input.audience),
  };
  if (type === 'notice') {
    out.body = text(input.body, 600, 'notice body');
    out.tone = ['info', 'ok', 'warn'].includes(input.tone) ? input.tone : 'info';
  } else if (type === 'links') {
    const links = Array.isArray(input.links) ? input.links.slice(0, 12) : [];
    out.links = links.map((l, i) => ({
      label: text(l?.label, 80, `link ${i + 1} label`) || `Link ${i + 1}`,
      href: safeHref(l?.href, `link ${i + 1} href`),
    }));
  } else if (type === 'plugin') {
    out.plugin = id(input.plugin, 'widget plugin');
    out.slot = id(input.slot, 'widget slot');
  }
  return out;
}

/**
 * Validate and normalise a full or partial layout document.
 * @param {unknown} input
 * @returns {ReturnType<typeof defaultLayout>}
 */
export function validateLayout(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HttpError(400, 'layout must be an object', { code: 'LAYOUT_INVALID' });
  }
  const base = defaultLayout();
  const nav = input.nav || {};
  const items = Array.isArray(nav.items) ? nav.items : [];
  if (items.length > MAX_NAV) throw new HttpError(400, 'too many nav items', { code: 'LAYOUT_INVALID' });
  base.nav.managed = Boolean(nav.managed);
  base.nav.items = items.map((item, i) => ({
    id: id(item?.id || `nav-${i + 1}`, 'nav id'),
    label: text(item?.label, 60, 'nav label') || `Item ${i + 1}`,
    href: safeHref(item?.href, 'nav href'),
    order: order(item?.order, i * 10),
    visible: item?.visible !== false,
    audience: audience(item?.audience),
  }));
  base.nav.hidden = (Array.isArray(nav.hidden) ? nav.hidden : []).slice(0, MAX_NAV).map((h) => safeHref(h, 'hidden href'));
  const regions = input.regions || {};
  for (const region of REGIONS) {
    const list = Array.isArray(regions[region]) ? regions[region] : [];
    if (list.length > MAX_WIDGETS_PER_REGION) {
      throw new HttpError(400, `too many widgets in ${region}`, { code: 'LAYOUT_INVALID' });
    }
    base.regions[region] = list.map((w, i) => widget(w, i, region));
  }
  for (const key of Object.keys(regions)) {
    if (!REGIONS.includes(key)) throw new HttpError(400, `unknown region ${key.slice(0, 40)}`, { code: 'LAYOUT_INVALID' });
  }
  base.theme = theme(input.theme || {});
  base.branding = brandingLayer(input.branding || {});
  return base;
}

/** Shallow merge of layers: later layers replace whole nav / regions / theme modes they define. */
export function mergeLayout(base, layer) {
  if (!layer) return base;
  const out = structuredClone(base);
  if (layer.nav) out.nav = structuredClone(layer.nav);
  if (layer.regions) {
    for (const region of REGIONS) {
      if (Array.isArray(layer.regions[region]) && layer.regions[region].length) {
        out.regions[region] = structuredClone(layer.regions[region]);
      }
    }
  }
  if (layer.branding) {
    const next = { ...(out.branding || {}) };
    for (const field of [...Object.keys(BRANDING_FIELDS), 'logoUrl']) {
      const v = layer.branding[field];
      if (v && !(field === 'productName' && LEGACY_DEFAULT_NAMES.includes(v))) next[field] = v;
    }
    out.branding = next;
  }
  if (layer.theme) {
    out.theme = {
      light: { ...out.theme.light, ...(layer.theme.light || {}) },
      dark: { ...out.theme.dark, ...(layer.theme.dark || {}) },
    };
  }
  return out;
}

function readFileLayer(file) {
  if (!file) return null;
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    return validateLayout(JSON.parse(raw));
  } catch (err) {
    console.warn(`[layout] ignoring invalid layout file: ${err.message}`);
    return null;
  }
}

async function loadCodeOverride(file) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    const mod = await import(pathToFileURL(file).href);
    return typeof mod.default === 'function' ? mod.default : null;
  } catch (err) {
    console.warn(`[layout] ignoring layout override module: ${err.message}`);
    return null;
  }
}

/**
 * Layout service. `filters` are synchronous functions from enabled plugins or
 * repo code; each must return a layout and the result is re-validated.
 */
export async function createLayoutService({ store, config }) {
  const codeOverride = await loadCodeOverride(config.layoutOverrideModule);
  const filters = new Map();

  function dbLayer() {
    const saved = store.data.layout;
    if (!saved) return null;
    try {
      return validateLayout(saved);
    } catch {
      return null;
    }
  }

  function effective() {
    const sources = ['defaults'];
    let layout = defaultLayout();
    const db = dbLayer();
    if (db) {
      layout = mergeLayout(layout, db);
      sources.push('database');
    }
    const file = readFileLayer(config.layoutFile);
    if (file) {
      layout = mergeLayout(layout, file);
      sources.push('file');
    }
    const fns = [];
    if (codeOverride) fns.push(['code', codeOverride]);
    for (const [name, fn] of filters) fns.push([`plugin:${name}`, fn]);
    for (const [label, fn] of fns) {
      try {
        const next = fn(structuredClone(layout));
        if (next) {
          layout = validateLayout(next);
          sources.push(label);
        }
      } catch (err) {
        console.warn(`[layout] ${label} filter rejected: ${err.message}`);
      }
    }
    layout.branding = resolveBranding(layout.branding, {
      ...brandDefaults(),
      logoUrl: config.clientBrand?.logoUrl || '',
    });
    return { layout, sources };
  }

  return {
    effective,
    saved: () => dbLayer() || defaultLayout(),
    hasFileOverride: () => Boolean(readFileLayer(config.layoutFile)),
    hasCodeOverride: () => Boolean(codeOverride),
    addFilter(name, fn) {
      filters.set(name, fn);
    },
    removeFilter(name) {
      filters.delete(name);
    },
    async save(input) {
      const layout = validateLayout(input);
      store.data.layout = layout;
      await store.persist();
      return layout;
    },
    async reset() {
      store.data.layout = null;
      await store.persist();
    },
  };
}

/** Theme tokens as an external stylesheet (CSP-safe: no inline styles). */
export function themeCss(layout) {
  const block = (tokens) =>
    Object.entries(tokens || {})
      .filter(([k, v]) => THEME_TOKENS[k] && (() => {
        try {
          validateThemeValue(k, v);
          return true;
        } catch {
          return false;
        }
      })())
      .map(([k, v]) => `  --${k}: ${v};`)
      .join('\n');
  const light = block(layout.theme?.light);
  const dark = block(layout.theme?.dark);
  let css = '/* Theme tokens (generated from the site layout). */\n';
  if (light) css += `:root {\n${light}\n}\n`;
  if (dark) css += `@media (prefers-color-scheme: dark) {\n  :root {\n${dark.replace(/^/gm, '  ')}\n  }\n}\n`;
  return css;
}

/** Strip widgets/items the viewer's audience should not see. */
export function layoutForAudience(layout, viewer) {
  const allowed = new Set(['all', viewer ? 'signed_in' : 'signed_out']);
  if (viewer?.officer) allowed.add('officer');
  if (viewer?.admin) allowed.add('admin');
  const out = structuredClone(layout);
  out.nav.items = out.nav.items.filter((i) => i.visible && allowed.has(i.audience)).sort((a, b) => a.order - b.order);
  for (const region of REGIONS) {
    out.regions[region] = out.regions[region]
      .filter((w) => w.visible && allowed.has(w.audience))
      .sort((a, b) => a.order - b.order);
  }
  return out;
}

/** WCAG relative-luminance contrast for #rgb/#rrggbb pairs; null when not comparable. */
export function contrastRatio(a, b) {
  const lum = (hex) => {
    let h = String(hex || '').replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (!/^[0-9a-f]{6}$/i.test(h)) return null;
    const ch = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) =>
      c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
    );
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };
  const la = lum(a);
  const lb = lum(b);
  if (la == null || lb == null) return null;
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Warn (not block) when theme tokens drop text contrast below WCAG AA. */
export function themeWarnings(layout) {
  const warnings = [];
  for (const mode of ['light', 'dark']) {
    const t = layout.theme?.[mode] || {};
    for (const [fg, bg] of [['fg', 'canvas'], ['fg', 'card'], ['muted', 'card'], ['project-text', 'card']]) {
      if (!t[fg] || !t[bg]) continue;
      const ratio = contrastRatio(t[fg], t[bg]);
      if (ratio != null && ratio < 4.5) {
        warnings.push(`${mode}: --${fg} on --${bg} contrast ${ratio.toFixed(2)}:1 is below 4.5:1`);
      }
    }
  }
  return warnings;
}

// NOT FOR PROFIT — civic public good, not a commercial product.
// Layout + client-plugin runtime. CSP-safe: no inline script, no eval, DOM
// built with createElement/textContent only. Plugins are ES modules served
// from /plugins-assets/<name>/ and loaded with import().
//
// Client plugin contract (see docs/plugins/README.md):
//   export function register(host) {
//     host.slot('banner', (el, ctx) => { el.append(...); });
//   }

const REGION_SLOTS = ['banner', 'header', 'sidebar', 'home', 'footer'];
const DEFAULT_PRODUCT_NAME = 'ZK-Voting';
let cached = null;

export async function fetchLayout() {
  if (cached) return cached;
  cached = fetch('/api/layout', { credentials: 'same-origin', headers: { accept: 'application/json' } })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  return cached;
}

let csrfPromise = null;
async function csrfToken() {
  if (!csrfPromise) {
    csrfPromise = fetch('/api/site-admin/me', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j?.csrfToken || '')
      .catch(() => '');
  }
  return csrfPromise;
}

/** Context handed to a plugin's slot renderer. */
function pluginContext(plugin, layout, extra = {}) {
  const base = `/api/plugins/${encodeURIComponent(plugin.name)}/`;
  return Object.freeze({
    plugin: plugin.name,
    version: plugin.version,
    productName: layout?.branding?.productName || DEFAULT_PRODUCT_NAME,
    ...extra,
    async fetchJson(rel, opts = {}) {
      const url = new URL(String(rel).replace(/^\/+/, ''), new URL(base, location.origin));
      if (!url.pathname.startsWith(base) || url.origin !== location.origin) throw new Error('plugin fetch outside its namespace');
      const method = (opts.method || 'GET').toUpperCase();
      const headers = { accept: 'application/json' };
      if (opts.body !== undefined) headers['content-type'] = 'application/json';
      if (!['GET', 'HEAD'].includes(method)) headers['x-csrf-token'] = await csrfToken();
      const res = await fetch(url, {
        method,
        credentials: 'same-origin',
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw Object.assign(new Error(json?.error || `HTTP ${res.status}`), { status: res.status });
      return json;
    },
  });
}

const loadedModules = new Map();

/** Import a plugin's client module once and collect its slot renderers. */
export async function loadPlugin(plugin) {
  if (loadedModules.has(plugin.name)) return loadedModules.get(plugin.name);
  const slots = new Map();
  const p = (async () => {
    if (plugin.styles) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = plugin.styles;
      link.dataset.plugin = plugin.name;
      document.head.append(link);
    }
    if (plugin.client) {
      const mod = await import(plugin.client);
      if (typeof mod.register === 'function') {
        mod.register(
          Object.freeze({
            slot(name, fn) {
              if (typeof fn === 'function' && (plugin.slots || []).includes(name)) slots.set(name, fn);
            },
          }),
        );
      }
    }
    return slots;
  })().catch((err) => {
    console.warn(`[plugins] ${plugin.name} failed to load`, err);
    return slots;
  });
  loadedModules.set(plugin.name, p);
  return p;
}

/** Render one plugin slot into `el`. Returns true when something rendered. */
export async function renderSlot(plugin, slotName, el, layout, extra) {
  const slots = await loadPlugin(plugin);
  const fn = slots.get(slotName);
  if (!fn) return false;
  try {
    await fn(el, pluginContext(plugin, layout, extra));
    return true;
  } catch (err) {
    console.warn(`[plugins] ${plugin.name}:${slotName} failed`, err);
    return false;
  }
}

/**
 * Region containers live in stable chrome so SPA route renders (which replace
 * <main> and repaint the nav) don't wipe them. On the wide grid layout the
 * banner/header regions share the ribbon's full-width "banner" grid area.
 */
function topStrip() {
  let top = document.querySelector('.layout-top');
  if (top) return top;
  const ribbon = document.getElementById('nfp-banner');
  if (!ribbon || ribbon.parentElement !== document.body) return null;
  top = document.createElement('div');
  top.className = 'layout-top';
  ribbon.before(top);
  top.append(ribbon);
  return top;
}

function placeRegion(region, host) {
  const header = document.querySelector('header.site-header');
  const main = document.getElementById('main');
  const footer = document.querySelector('footer.site-footer');
  if (region === 'banner' || region === 'header') {
    const top = topStrip();
    if (top) {
      const ribbon = top.querySelector('.nfp-banner');
      if (region === 'banner' && ribbon) ribbon.after(host);
      else top.append(host);
    } else if (header) {
      if (region === 'banner') header.before(host);
      else header.after(host);
    } else document.body.prepend(host);
  } else if (region === 'home') {
    if (main) main.prepend(host);
  } else if (region === 'sidebar') {
    if (header) header.append(host);
    else if (main) main.append(host);
  } else if (region === 'footer') {
    if (footer) footer.prepend(host);
    else document.body.append(host);
  }
}

function regionHost(region) {
  const host = document.createElement(region === 'sidebar' ? 'aside' : 'div');
  host.className = `layout-region layout-region-${region}`;
  host.dataset.layoutRegion = region;
  if (region === 'sidebar') host.setAttribute('aria-label', 'More');
  return host;
}

const isHomePath = () => location.pathname === '/' || location.pathname === '';

/** Keep the home region at the top of <main> on "/" across SPA re-renders. */
function keepHome(host) {
  const main = document.getElementById('main');
  if (!main || typeof MutationObserver === 'undefined') return;
  const sync = () => {
    const want = isHomePath();
    if (want && main.firstElementChild !== host) main.prepend(host);
    else if (!want && host.isConnected) host.remove();
  };
  new MutationObserver(sync).observe(main, { childList: true });
  window.addEventListener('popstate', sync);
  sync();
}

function renderWidget(w) {
  const box = document.createElement('section');
  box.className = `layout-widget layout-widget-${w.type}`;
  box.dataset.widget = w.id;
  if (w.title) {
    const h = document.createElement('h2');
    h.className = 'layout-widget-title';
    h.textContent = w.title;
    box.append(h);
    box.setAttribute('aria-label', w.title);
  }
  if (w.type === 'notice') {
    box.classList.add(`tone-${w.tone || 'info'}`);
    box.setAttribute('role', 'note');
    const p = document.createElement('p');
    p.textContent = w.body || '';
    box.append(p);
  } else if (w.type === 'links') {
    const ul = document.createElement('ul');
    for (const l of w.links || []) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = l.href;
      a.textContent = l.label;
      li.append(a);
      ul.append(li);
    }
    box.append(ul);
  }
  return box;
}

function paintNav(ul, layout) {
  const hidden = new Set(layout.nav?.hidden || []);
  for (const li of ul.querySelectorAll('li[data-layout-nav]')) li.remove();
  for (const li of ul.querySelectorAll('li[data-layout-hidden]')) {
    li.removeAttribute('hidden');
    delete li.dataset.layoutHidden;
  }
  if (layout.nav?.managed) {
    for (const li of ul.children) {
      li.setAttribute('hidden', '');
      li.dataset.layoutHidden = '';
    }
  } else {
    for (const a of ul.querySelectorAll('a[href]')) {
      const li = a.closest('li');
      if (li && hidden.has(a.getAttribute('href'))) {
        li.setAttribute('hidden', '');
        li.dataset.layoutHidden = '';
      }
    }
  }
  const items = (layout.nav?.items || []).filter((i) => i.visible !== false && !hidden.has(i.href));
  items.sort((x, y) => (x.order ?? 0) - (y.order ?? 0));
  for (const item of items) {
    const li = document.createElement('li');
    li.dataset.layoutNav = item.id;
    const a = document.createElement('a');
    a.href = item.href;
    a.textContent = item.label;
    li.append(a);
    ul.append(li);
  }
}

/** Nav changes survive the SPA repainting its menu (re-applied on mutation). */
function applyNav(layout) {
  const nav = document.querySelector('nav.nav-main');
  if (!nav) return;
  const hasChanges = (layout.nav?.items || []).length || (layout.nav?.hidden || []).length || layout.nav?.managed;
  if (!hasChanges) return;
  let busy = false;
  const run = () => {
    if (busy) return;
    const ul = nav.querySelector('ul');
    if (!ul) return;
    busy = true;
    observer?.disconnect();
    try {
      paintNav(ul, layout);
    } finally {
      observer?.observe(nav, { childList: true, subtree: true });
      busy = false;
    }
  };
  const observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver(run);
  run();
}

function applyBranding(layout) {
  const name = layout.branding?.productName || DEFAULT_PRODUCT_NAME;
  // The server already renders the name into each page; this keeps the chrome
  // right if the layout changes while the page is open.
  for (const el of document.querySelectorAll('[data-product-name], .brand-name')) el.textContent = name;
}

function applyTheme() {
  if (document.querySelector('link[data-layout-theme]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/api/layout/theme.css';
  link.dataset.layoutTheme = '';
  document.head.append(link);
}

/**
 * Apply theme, branding, nav and regions to the current page.
 * Site admin passes `{ nav: false, regions: false }` so its own chrome stays fixed.
 */
export async function applyLayout({ nav = true, regions = true } = {}) {
  const data = await fetchLayout();
  if (!data?.layout) return null;
  const { layout, plugins = [] } = data;
  applyTheme();
  applyBranding(layout);
  if (nav) applyNav(layout);
  if (!regions) return data;
  for (const region of REGION_SLOTS) {
    const widgets = layout.regions?.[region] || [];
    const slotPlugins = plugins.filter((p) => (p.slots || []).includes(region));
    if (!widgets.length && !slotPlugins.length) continue;
    const host = regionHost(region);
    for (const w of widgets) {
      if (w.type === 'plugin') {
        const plugin = plugins.find((p) => p.name === w.plugin);
        if (!plugin) continue;
        const el = document.createElement('div');
        el.className = 'layout-widget layout-widget-plugin';
        el.dataset.plugin = plugin.name;
        host.append(el);
        if (!(await renderSlot(plugin, w.slot, el, layout)) || !el.childNodes.length) el.remove();
      } else {
        host.append(renderWidget(w));
      }
    }
    for (const plugin of slotPlugins) {
      if (widgets.some((w) => w.type === 'plugin' && w.plugin === plugin.name)) continue;
      const el = document.createElement('div');
      el.className = 'layout-plugin-slot';
      el.dataset.plugin = plugin.name;
      host.append(el);
      if (!(await renderSlot(plugin, region, el, layout)) || !el.childNodes.length) el.remove();
    }
    if (!host.children.length) continue;
    if (region === 'home') keepHome(host);
    else placeRegion(region, host);
  }
  return data;
}

if (document.documentElement.dataset.layoutRuntime !== 'manual') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => applyLayout());
  } else {
    applyLayout();
  }
}

// NOT FOR PROFIT — civic public good, not a commercial product.
// Plugin manager: discovery (repo `plugins/` + uploaded), registry state,
// enable/disable/uninstall, the scoped server API, events and client assets.
//
// TRUST MODEL: a plugin's *server* entrypoint runs inside the Node process
// with full trust (it can import any Node module). The scoped API below is a
// convenience and a contract, not a sandbox. Only install server plugins you
// have reviewed. See docs/plugins/README.md.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import express from 'express';

import { capabilitiesOf, hasCapability, requireCapability } from '../capabilities.mjs';
import { HttpError } from '../http.mjs';
import { appendSiteAudit } from '../siteAudit.mjs';
import { requireCsrf, requireSession } from '../siteAdminGuard.mjs';
import {
  isServerFile,
  ManifestError,
  packageChecksum,
  PLUGIN_EVENTS,
  PLUGIN_PERMISSIONS,
  sha256Hex,
  validatePackage,
} from './manifest.mjs';
import { readZip, stripCommonRoot, ZIP_LIMITS, ZipError } from './zip.mjs';

export const PLUGIN_STORAGE_MAX_BYTES = 64 * 1024;

const CONTENT_TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/** Read a plugin folder from disk with the same limits as a zip upload. */
export async function readPluginDir(dir, limits = ZIP_LIMITS) {
  const files = new Map();
  let total = 0;
  async function walk(rel) {
    const abs = path.join(dir, rel);
    const entries = await fsp.readdir(abs, { withFileTypes: true });
    for (const ent of entries) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
      const st = await fsp.lstat(path.join(dir, childRel));
      if (st.isSymbolicLink()) throw new ZipError(`symlink rejected: ${childRel}`, 'ZIP_SYMLINK');
      if (st.isDirectory()) {
        await walk(childRel);
        continue;
      }
      if (!st.isFile()) continue;
      if (files.size >= limits.maxEntries) throw new ZipError('too many files', 'ZIP_LIMIT');
      if (st.size > limits.maxFileBytes) throw new ZipError(`file too large: ${childRel}`, 'ZIP_LIMIT');
      total += st.size;
      if (total > limits.maxTotalBytes) throw new ZipError('plugin too large', 'ZIP_LIMIT');
      files.set(childRel, await fsp.readFile(path.join(dir, childRel)));
    }
  }
  await walk('');
  return files;
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

/**
 * @param {{ store: any, config: any, layout: any }} deps
 */
export async function createPluginManager({ store, config, layout }) {
  /** @type {Map<string, any>} */
  const plugins = new Map();
  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map(PLUGIN_EVENTS.map((e) => [e, new Set()]));

  const registry = () => store.data.plugins;

  function state(name) {
    return registry()[name] || null;
  }

  function warn(name, msg) {
    if (!config.quiet) console.warn(`[plugins] ${name}: ${msg}`);
  }

  async function emit(event, payload) {
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        await fn(structuredClone(payload));
      } catch (err) {
        warn(fn.pluginName || '?', `event ${event} handler failed: ${err?.message || err}`);
      }
    }
  }

  function buildApi(p) {
    const granted = new Set(state(p.manifest.name)?.grantedPermissions || []);
    const name = p.manifest.name;
    const need = (perm) => {
      if (!granted.has(perm)) throw new Error(`plugin ${name} was not granted "${perm}"`);
    };
    const active = p.active;
    const api = {
      name,
      version: p.manifest.version,
      appVersion: config.appVersion,
      manifest: Object.freeze(structuredClone(p.manifest)),
      permissions: Object.freeze([...granted]),
      log: {
        info: (...args) => !config.quiet && console.log(`[plugin:${name}]`, ...args),
        warn: (...args) => console.warn(`[plugin:${name}]`, ...args),
        error: (...args) => console.error(`[plugin:${name}]`, ...args),
      },
      /** Express router mounted at /api/plugins/<name>/. */
      routes() {
        need('routes');
        if (!active.router) {
          active.router = express.Router();
        }
        return active.router;
      },
      /** JSON body parser (max 64 KiB) so plugins need no imports of their own. */
      json(opts = {}) {
        const limit = Math.min(Number(opts.limitBytes) || 16 * 1024, 64 * 1024);
        return express.json({ limit });
      },
      /** Middleware: signed-in session holding `cap`, CSRF on writes. */
      requireCapability(cap) {
        return [requireSession, requireCsrf, requireCapability(cap)];
      },
      /** Middleware: any signed-in session, CSRF on writes. */
      requireSession() {
        return [requireSession, requireCsrf];
      },
      can(user, cap) {
        return hasCapability(user, cap);
      },
      on(event, fn) {
        need('events');
        if (!p.manifest.hooks.includes(`event:${event}`)) throw new Error(`plugin ${name} did not declare hook event:${event}`);
        if (typeof fn !== 'function') throw new Error('handler must be a function');
        const wrapped = (payload) => fn(payload);
        wrapped.pluginName = name;
        listeners.get(event).add(wrapped);
        active.listeners.push([event, wrapped]);
      },
      storage: {
        get(key) {
          need('storage');
          const bag = store.data.pluginData[name] || {};
          return Object.hasOwn(bag, key) ? structuredClone(bag[key]) : undefined;
        },
        all() {
          need('storage');
          return structuredClone(store.data.pluginData[name] || {});
        },
        async set(key, value) {
          need('storage');
          const k = String(key).slice(0, 64);
          const bag = { ...(store.data.pluginData[name] || {}), [k]: structuredClone(value) };
          if (Buffer.byteLength(JSON.stringify(bag)) > PLUGIN_STORAGE_MAX_BYTES) {
            throw new HttpError(413, 'plugin storage is full', { code: 'PLUGIN_STORAGE_FULL' });
          }
          store.data.pluginData[name] = bag;
          await store.persist();
        },
        async delete(key) {
          need('storage');
          const bag = { ...(store.data.pluginData[name] || {}) };
          delete bag[String(key)];
          store.data.pluginData[name] = bag;
          await store.persist();
        },
      },
      users: {
        getPublic(id) {
          need('users:read');
          const u = store.getUser(String(id));
          return u ? { id: u.id, handle: u.handle, role: u.role } : null;
        },
        countByRole() {
          need('users:read');
          const out = {};
          for (const u of store.data.users || []) out[u.role] = (out[u.role] || 0) + 1;
          return out;
        },
      },
      elections: {
        listPublic() {
          need('elections:read');
          return (store.data.elections || []).map((e) =>
            pick(e, ['id', 'title', 'jurisdictionId', 'status', 'phase', 'createdAt', 'opensAt', 'closesAt']),
          );
        },
      },
      layout: {
        filter(fn) {
          need('layout');
          if (!p.manifest.hooks.includes('layout')) throw new Error(`plugin ${name} did not declare hook layout`);
          layout.addFilter(name, fn);
          active.layoutFilter = true;
        },
      },
    };
    return Object.freeze(api);
  }

  async function activate(p) {
    p.active = { router: null, listeners: [], layoutFilter: false };
    p.error = null;
    if (!p.manifest.entrypoints.server) return;
    const file = path.join(p.dir, p.manifest.entrypoints.server);
    const mod = await import(`${pathToFileURL(file).href}?v=${p.checksum}`);
    if (typeof mod.register !== 'function') throw new Error('server entrypoint must export register(api)');
    await mod.register(buildApi(p));
  }

  function deactivate(p) {
    if (!p.active) return;
    for (const [event, fn] of p.active.listeners) listeners.get(event)?.delete(fn);
    if (p.active.layoutFilter) layout.removeFilter(p.manifest.name);
    p.active = null;
  }

  async function loadFromDir(dir, source) {
    const files = await readPluginDir(dir);
    const manifest = validatePackage(files, { appVersion: config.appVersion });
    if (path.basename(dir) !== manifest.name) throw new ManifestError(`folder name must equal plugin name ${manifest.name}`, 'name');
    return { manifest, dir, source, files: [...files.keys()], checksum: packageChecksum(files), active: null, error: null };
  }

  async function scan(root, source) {
    if (!root || !fs.existsSync(root)) return;
    for (const ent of await fsp.readdir(root, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
      const dir = path.join(root, ent.name);
      try {
        const p = await loadFromDir(dir, source);
        if (plugins.has(p.manifest.name)) {
          warn(p.manifest.name, `duplicate plugin name in ${source}; keeping ${plugins.get(p.manifest.name).source}`);
          continue;
        }
        plugins.set(p.manifest.name, p);
      } catch (err) {
        warn(ent.name, `not loaded: ${err.message}`);
        plugins.set(`invalid:${source}:${ent.name}`, { invalid: true, name: ent.name, source, error: err.message });
      }
    }
  }

  async function syncRegistry() {
    const reg = registry();
    for (const p of plugins.values()) {
      if (p.invalid) continue;
      const name = p.manifest.name;
      const prev = reg[name];
      if (!prev) {
        reg[name] = {
          enabled: false,
          source: p.source,
          version: p.manifest.version,
          checksum: p.checksum,
          installedAt: new Date().toISOString(),
          installedBy: p.source === 'repo' ? 'repo' : null,
          grantedPermissions: [],
        };
        continue;
      }
      if (prev.checksum !== p.checksum || prev.version !== p.manifest.version) {
        // Code changed on disk: never keep running new code under an old grant.
        const wasEnabled = prev.enabled;
        Object.assign(prev, {
          enabled: false,
          version: p.manifest.version,
          checksum: p.checksum,
          grantedPermissions: [],
          source: p.source,
        });
        if (wasEnabled) {
          warn(name, 'files changed since it was enabled; disabled until re-approved');
          await appendSiteAudit(store, {
            area: 'plugins',
            action: 'plugin.auto_disabled',
            after: { name, version: p.manifest.version, reason: 'checksum_changed' },
          });
        }
      }
    }
    await store.persist();
  }

  async function init() {
    await scan(config.pluginsBundledDir, 'repo');
    await scan(config.pluginsUploadDir, 'upload');
    // A standby node must not write the shared store; it reconciles on promotion.
    const writer = store.writerActive !== false;
    if (writer) await syncRegistry();
    for (const p of plugins.values()) {
      if (p.invalid || !state(p.manifest.name)?.enabled) continue;
      if (!writer && state(p.manifest.name)?.checksum !== p.checksum) continue;
      try {
        await activate(p);
      } catch (err) {
        p.error = err.message;
        deactivate(p);
        warn(p.manifest.name, `failed to start: ${err.message}`);
      }
    }
  }

  function describe(p, viewer) {
    if (p.invalid) return { name: p.name, source: p.source, invalid: true, error: p.error };
    const s = state(p.manifest.name) || {};
    return {
      ...p.manifest,
      source: p.source,
      checksum: p.checksum,
      files: p.files,
      enabled: Boolean(s.enabled),
      running: Boolean(s.enabled && p.active),
      error: p.error,
      installedAt: s.installedAt || null,
      installedBy: s.installedBy || null,
      enabledAt: s.enabledAt || null,
      enabledBy: s.enabledBy || null,
      grantedPermissions: s.grantedPermissions || [],
      permissionDetails: p.manifest.permissions.map((perm) => ({ id: perm, description: PLUGIN_PERMISSIONS[perm] })),
      canUninstall: p.source === 'upload' && Boolean(viewer && hasCapability(viewer, 'manage_plugins')),
    };
  }

  function get(name) {
    const p = plugins.get(String(name));
    if (!p || p.invalid) throw new HttpError(404, 'plugin not found', { code: 'PLUGIN_NOT_FOUND' });
    return p;
  }

  async function enable(name, { actor, acceptPermissions }) {
    const p = get(name);
    const requested = [...p.manifest.permissions].sort();
    const accepted = [...new Set((Array.isArray(acceptPermissions) ? acceptPermissions : []).map(String))].sort();
    if (requested.join(',') !== accepted.join(',')) {
      throw new HttpError(400, 'review and accept exactly the requested permissions', {
        code: 'PERMISSIONS_NOT_ACCEPTED',
        requested,
      });
    }
    const s = state(p.manifest.name);
    s.enabled = true;
    s.grantedPermissions = requested;
    s.enabledAt = new Date().toISOString();
    s.enabledBy = actor?.handle || null;
    await store.persist();
    try {
      deactivate(p);
      await activate(p);
    } catch (err) {
      deactivate(p);
      s.enabled = false;
      s.grantedPermissions = [];
      await store.persist();
      p.error = err.message;
      throw new HttpError(400, `plugin failed to start: ${err.message}`, { code: 'PLUGIN_START_FAILED' });
    }
    await emit('plugin.enabled', { name: p.manifest.name, version: p.manifest.version });
    return describe(p, actor);
  }

  async function disable(name, { actor }) {
    const p = get(name);
    const s = state(p.manifest.name);
    deactivate(p);
    s.enabled = false;
    s.grantedPermissions = [];
    s.disabledAt = new Date().toISOString();
    s.disabledBy = actor?.handle || null;
    await store.persist();
    await emit('plugin.disabled', { name: p.manifest.name, version: p.manifest.version });
    return describe(p, actor);
  }

  async function uninstall(name, { actor }) {
    const p = get(name);
    if (p.source !== 'upload') {
      throw new HttpError(400, 'repo plugins cannot be uninstalled here; disable it or remove it from plugins/', {
        code: 'PLUGIN_REPO_OWNED',
      });
    }
    if (state(p.manifest.name)?.enabled) await disable(name, { actor });
    const root = path.resolve(config.pluginsUploadDir);
    const dir = path.resolve(p.dir);
    if (!dir.startsWith(`${root}${path.sep}`)) throw new HttpError(500, 'plugin path outside upload dir');
    await fsp.rm(dir, { recursive: true, force: true });
    plugins.delete(p.manifest.name);
    delete registry()[p.manifest.name];
    delete store.data.pluginData[p.manifest.name];
    await store.persist();
    return { name: p.manifest.name, version: p.manifest.version };
  }

  /**
   * Install an uploaded zip. Always lands disabled.
   * @param {Buffer} zip
   */
  async function installZip(zip, { actor, expectedSha256 }) {
    if (!config.pluginsAllowUpload) {
      throw new HttpError(403, 'plugin upload is disabled (set PLUGINS_ALLOW_UPLOAD=1)', { code: 'PLUGIN_UPLOAD_DISABLED' });
    }
    if (!Buffer.isBuffer(zip) || !zip.length) throw new HttpError(400, 'send the zip as the request body', { code: 'ZIP_INVALID' });
    if (zip.length > config.pluginMaxZipBytes) throw new HttpError(413, 'zip too large', { code: 'ZIP_LIMIT' });
    const digest = sha256Hex(zip);
    if (!/^[0-9a-f]{64}$/.test(String(expectedSha256 || '')) || expectedSha256 !== digest) {
      throw new HttpError(400, 'x-plugin-sha256 must equal the sha256 of the uploaded zip', { code: 'CHECKSUM_MISMATCH' });
    }
    let files;
    let manifest;
    try {
      files = stripCommonRoot(readZip(zip));
      manifest = validatePackage(files, { appVersion: config.appVersion });
    } catch (err) {
      if (err instanceof ZipError || err instanceof ManifestError) {
        throw new HttpError(400, err.message, { code: err.code, field: err.field || undefined });
      }
      throw err;
    }
    const existing = plugins.get(manifest.name);
    if (existing) {
      throw new HttpError(409, `a plugin named ${manifest.name} is already installed (${existing.source}); uninstall it first`, {
        code: 'PLUGIN_EXISTS',
      });
    }
    const root = path.resolve(config.pluginsUploadDir);
    await fsp.mkdir(root, { recursive: true });
    const staging = await fsp.mkdtemp(path.join(root, '.staging-'));
    const finalDir = path.join(root, manifest.name);
    try {
      for (const [rel, data] of files) {
        const target = path.resolve(staging, rel);
        if (!target.startsWith(`${staging}${path.sep}`)) throw new HttpError(400, 'zip-slip rejected', { code: 'ZIP_PATH' });
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.writeFile(target, data, { flag: 'wx', mode: 0o644 });
      }
      await fsp.rename(staging, finalDir);
    } catch (err) {
      await fsp.rm(staging, { recursive: true, force: true });
      throw err;
    }
    const p = await loadFromDir(finalDir, 'upload');
    plugins.set(p.manifest.name, p);
    registry()[p.manifest.name] = {
      enabled: false,
      source: 'upload',
      version: p.manifest.version,
      checksum: p.checksum,
      zipSha256: digest,
      installedAt: new Date().toISOString(),
      installedBy: actor?.handle || null,
      grantedPermissions: [],
    };
    await store.persist();
    return describe(p, actor);
  }

  /** Mount at /api/plugins/:name — dispatches to the plugin's router while enabled. */
  function routeDispatcher() {
    return function pluginRoutes(req, res, next) {
      const p = plugins.get(String(req.params.name || ''));
      if (!p || p.invalid || !p.active?.router || !state(p.manifest.name)?.enabled) {
        res.status(404).json({ error: 'not found', nfp: true });
        return;
      }
      res.set('X-Content-Type-Options', 'nosniff');
      p.active.router(req, res, (err) => {
        if (err) {
          next(err);
          return;
        }
        res.status(404).json({ error: 'not found', nfp: true });
      });
    };
  }

  /** GET /plugins-assets/:name/<file> — client files of enabled plugins only. */
  function assetHandler() {
    return function pluginAsset(req, res) {
      const name = String(req.params.name || '');
      const rel = String(req.params[0] || '');
      const p = plugins.get(name);
      const notFound = () => res.status(404).type('text/plain').send('not found');
      if (!p || p.invalid || !state(name)?.enabled || !p.manifest.permissions.includes('client')) return notFound();
      if (!p.files.includes(rel) || rel === 'plugin.json' || isServerFile(p.manifest, rel)) return notFound();
      const type = CONTENT_TYPES[path.extname(rel).toLowerCase()];
      if (!type) return notFound();
      res.set({
        'Content-Type': type,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-cache',
        'Content-Security-Policy': "default-src 'none'",
        'Cross-Origin-Resource-Policy': 'same-origin',
      });
      res.sendFile(path.join(p.dir, rel));
    };
  }

  /** Client manifest for the layout runtime: enabled plugins with client code. */
  function clientManifest(viewer) {
    const out = [];
    for (const p of plugins.values()) {
      if (p.invalid || !state(p.manifest.name)?.enabled) continue;
      if (!p.manifest.permissions.includes('client')) continue;
      const base = `/plugins-assets/${p.manifest.name}/`;
      out.push({
        name: p.manifest.name,
        version: p.manifest.version,
        slots: p.manifest.slots,
        client: p.manifest.entrypoints.client ? `${base}${p.manifest.entrypoints.client}?v=${p.checksum.slice(0, 12)}` : null,
        styles: p.manifest.entrypoints.styles ? `${base}${p.manifest.entrypoints.styles}?v=${p.checksum.slice(0, 12)}` : null,
        adminPages: viewer
          ? p.manifest.adminPages.filter((page) => capabilitiesOf(viewer).includes(page.capability))
          : [],
      });
    }
    return out;
  }

  /** Site-admin menu items from enabled plugins the viewer may open. */
  function adminMenu(viewer) {
    const items = [];
    for (const p of plugins.values()) {
      if (p.invalid || !state(p.manifest.name)?.enabled) continue;
      for (const m of p.manifest.menu) {
        const page = p.manifest.adminPages.find((x) => x.id === m.page);
        if (!page || !hasCapability(viewer, page.capability)) continue;
        items.push({ plugin: p.manifest.name, label: m.label, page: page.id, href: `/site-admin/plugin/${p.manifest.name}/${page.id}` });
      }
    }
    return items;
  }

  await init();

  return {
    list: (viewer) => [...plugins.values()].map((p) => describe(p, viewer)),
    get: (name, viewer) => describe(get(name), viewer),
    enable,
    disable,
    uninstall,
    installZip,
    emit,
    routeDispatcher,
    assetHandler,
    clientManifest,
    adminMenu,
    /** Called after a standby takes the writer lease and reloads the store. */
    onPromoted: async () => {
      for (const p of plugins.values()) if (!p.invalid) deactivate(p);
      plugins.clear();
      await init();
    },
    rescan: async () => {
      for (const p of plugins.values()) if (!p.invalid) deactivate(p);
      plugins.clear();
      await init();
    },
  };
}

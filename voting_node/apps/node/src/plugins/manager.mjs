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
  semverGt,
  semverGte,
  sha256Hex,
  validatePackage,
} from './manifest.mjs';
import {
  fetchBounded,
  parseUpdateFeed,
  UPDATE_FEED_MAX_BYTES,
  UPDATE_FEED_TIMEOUT_MS,
  UPDATE_PACKAGE_TIMEOUT_MS,
  UpdateFeedError,
  verifyPackageSignature,
} from './updateFeed.mjs';
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
          for (const u of store.data.users || []) {
            if (!u || u.is_deleted === true) continue;
            out[u.role] = (out[u.role] || 0) + 1;
          }
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
        reg[name] = freshPluginState(p, p.source === 'repo' ? 'repo' : null);
        continue;
      }
      if (typeof prev.autoUpdate !== 'boolean') prev.autoUpdate = false;
      if (prev.checksum !== p.checksum || prev.version !== p.manifest.version) {
        // Code changed on disk: never keep running new code under an old grant.
        const wasEnabled = prev.enabled;
        Object.assign(prev, {
          enabled: false,
          version: p.manifest.version,
          checksum: p.checksum,
          grantedPermissions: [],
          source: p.source,
          updateAvailable: null,
          updateCheckError: null,
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
    armUpdateTimer();
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
      // `notice`: bundled copy with no update source (listed only).
      // `source`: manifest set updateUrl, so check / update / auto-update apply.
      // `none`: uploaded plugin with no update source.
      updateMode: p.manifest.updateUrl ? 'source' : p.source === 'repo' ? 'notice' : 'none',
      canUpdate: Boolean(p.manifest.updateUrl),
      autoUpdate: Boolean(s.autoUpdate),
      updateAvailable: publicUpdateNotice(s.updateAvailable),
      updateCheckedAt: s.updateCheckedAt || null,
      updateCheckError: s.updateCheckError || null,
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
    armUpdateTimer();
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
      ...freshPluginState(p, actor?.handle || null),
      zipSha256: digest,
      source: 'upload',
    };
    await store.persist();
    armUpdateTimer();
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

  function freshPluginState(p, installedBy) {
    return {
      enabled: false,
      source: p.source,
      version: p.manifest.version,
      checksum: p.checksum,
      installedAt: new Date().toISOString(),
      installedBy: installedBy || null,
      grantedPermissions: [],
      autoUpdate: false,
      updateAvailable: null,
      updateCheckedAt: null,
      updateCheckError: null,
    };
  }

  function publicUpdateNotice(notice) {
    if (!notice || typeof notice !== 'object') return null;
    return {
      version: String(notice.version || ''),
      changelog: String(notice.changelog || ''),
      minAppVersion: String(notice.minAppVersion || '0.0.0'),
      sha256: String(notice.sha256 || ''),
      checkedAt: notice.checkedAt || null,
      compatible: notice.compatible !== false,
      needsReview: Boolean(notice.needsReview),
    };
  }

  function hasUpdateSource() {
    for (const p of plugins.values()) {
      if (!p.invalid && p.manifest.updateUrl) return true;
    }
    return false;
  }

  function pendingUpdateCount() {
    let n = 0;
    for (const p of plugins.values()) {
      if (p.invalid) continue;
      if (state(p.manifest.name)?.updateAvailable) n += 1;
    }
    return n;
  }

  const updateLocks = new Map();
  function withUpdateLock(name, fn) {
    const prev = updateLocks.get(name) || Promise.resolve();
    const run = prev.then(fn, fn);
    updateLocks.set(
      name,
      run.then(
        () => {},
        () => {},
      ),
    );
    return run;
  }

  let updateTimer = null;
  let updateInitial = null;
  function armUpdateTimer() {
    if (updateTimer) clearInterval(updateTimer);
    if (updateInitial) clearTimeout(updateInitial);
    updateTimer = null;
    updateInitial = null;
    const ms = Number(config.pluginUpdateIntervalMs) || 0;
    // Idle unless the interval is on, this process may write, and at least
    // one plugin declared an update source. Repo copies with no source are
    // not polled.
    if (!ms || store.writerActive === false || !hasUpdateSource()) return;
    const kick = () => {
      checkUpdates({ automatic: true }).catch((err) => warn('updates', err?.message || err));
    };
    updateInitial = setTimeout(kick, Math.min(ms, 30_000));
    updateTimer = setInterval(kick, ms);
    if (typeof updateInitial.unref === 'function') updateInitial.unref();
    if (typeof updateTimer.unref === 'function') updateTimer.unref();
  }

  function stopUpdates() {
    if (updateTimer) clearInterval(updateTimer);
    if (updateInitial) clearTimeout(updateInitial);
    updateTimer = null;
    updateInitial = null;
  }

  function refuseWithoutSource(p) {
    if (p.manifest.updateUrl) return;
    if (p.source === 'repo') {
      throw new HttpError(400, 'bundled plugins are listed here only; set updateUrl in the manifest to take updates', {
        code: 'PLUGIN_REPO_NOTICE_ONLY',
      });
    }
    throw new HttpError(400, 'this plugin has no update source', { code: 'PLUGIN_NO_UPDATE_SOURCE' });
  }

  function asUpdateHttp(err) {
    if (err instanceof HttpError) return err;
    if (err instanceof UpdateFeedError) {
      const status = err.code === 'UPDATE_SOURCE_UNAVAILABLE' ? 502 : err.code === 'ZIP_LIMIT' ? 413 : 400;
      return new HttpError(status, err.message, { code: err.code });
    }
    if (err instanceof ZipError || err instanceof ManifestError) {
      return new HttpError(400, err.message, { code: err.code, field: err.field || undefined });
    }
    const aborted = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return new HttpError(502, aborted ? 'update source timed out' : 'update source could not be read', {
      code: 'UPDATE_SOURCE_UNAVAILABLE',
    });
  }

  async function auditUpdate(action, { actor, automatic = false, result = 200, before = null, after = null } = {}) {
    await appendSiteAudit(store, {
      actor: actor || null,
      actorHandle: actor?.handle || (automatic ? 'system' : null),
      area: 'plugins',
      action,
      result,
      before,
      after,
    });
  }

  function noticeFrom(feed, { compatible, needsReview = false } = {}) {
    return {
      version: feed.version,
      changelog: feed.changelog,
      minAppVersion: feed.minAppVersion,
      sha256: feed.sha256,
      checkedAt: new Date().toISOString(),
      compatible: Boolean(compatible),
      needsReview: Boolean(needsReview),
    };
  }

  async function readFeed(p) {
    const buf = await fetchBounded(p.manifest.updateUrl, {
      maxBytes: UPDATE_FEED_MAX_BYTES,
      timeoutMs: UPDATE_FEED_TIMEOUT_MS,
    });
    return parseUpdateFeed(buf);
  }

  /**
   * Replace `dir` with `files`. Returns the backup directory, which the
   * caller deletes after the new copy has started. On failure the original
   * directory is put back when the swap itself got that far.
   */
  async function swapPluginDir(dir, files) {
    const parent = path.dirname(dir);
    const base = path.basename(dir);
    const staging = await fsp.mkdtemp(path.join(parent, `.staging-${base}-`));
    try {
      for (const [rel, data] of files) {
        const target = path.resolve(staging, rel);
        if (!target.startsWith(`${staging}${path.sep}`)) {
          throw new HttpError(400, 'zip-slip rejected', { code: 'ZIP_PATH' });
        }
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.writeFile(target, data, { flag: 'wx', mode: 0o644 });
      }
      const backup = path.join(parent, `.backup-${base}-${process.pid}-${Date.now()}`);
      await fsp.rename(dir, backup);
      try {
        await fsp.rename(staging, dir);
      } catch (err) {
        await fsp.rename(backup, dir);
        throw err;
      }
      return backup;
    } catch (err) {
      await fsp.rm(staging, { recursive: true, force: true });
      throw err;
    }
  }

  async function applyUpdateInner(p, { actor = null, acceptPermissions, automatic = false, expectedVersion = null, feed = null } = {}) {
    refuseWithoutSource(p);
    const name = p.manifest.name;
    const s = state(name);
    if (!s) throw new HttpError(404, 'plugin not found', { code: 'PLUGIN_NOT_FOUND' });
    const fromVersion = p.manifest.version;

    let resolved = feed;
    let digest = null;
    try {
      if (!resolved) resolved = await readFeed(p);
      if (expectedVersion && resolved.version !== expectedVersion) {
        if (semverGt(resolved.version, fromVersion)) {
          const compatible = semverGte(config.appVersion, resolved.minAppVersion);
          s.updateAvailable = noticeFrom(resolved, { compatible });
          s.updateCheckedAt = s.updateAvailable.checkedAt;
          s.updateCheckError = null;
          await store.persist();
          await auditUpdate('plugin.update_available', {
            actor,
            automatic,
            after: { name, from: fromVersion, to: resolved.version, sha256: resolved.sha256 },
          });
        }
        throw new HttpError(409, `the update source now offers ${resolved.version}`, {
          code: 'PLUGIN_UPDATE_CHANGED',
          version: resolved.version,
        });
      }
      if (!semverGt(resolved.version, fromVersion)) {
        s.updateAvailable = null;
        s.updateCheckedAt = new Date().toISOString();
        s.updateCheckError = null;
        await store.persist();
        throw new HttpError(409, 'plugin is already at this version', { code: 'PLUGIN_UP_TO_DATE' });
      }
      if (!semverGte(config.appVersion, resolved.minAppVersion)) {
        throw new HttpError(409, `update needs app ${resolved.minAppVersion} or newer`, {
          code: 'PLUGIN_APP_TOO_OLD',
          minAppVersion: resolved.minAppVersion,
        });
      }
      if (p.manifest.updatePublicKey && !resolved.signature) {
        throw new HttpError(400, 'update feed is missing a signature', { code: 'SIGNATURE_REQUIRED' });
      }
    } catch (err) {
      const http = asUpdateHttp(err);
      if (!['PLUGIN_UP_TO_DATE', 'PLUGIN_UPDATE_CHANGED'].includes(http.extra?.code)) {
        s.updateCheckError = http.message.slice(0, 200);
        await store.persist().catch(() => {});
        await auditUpdate('plugin.update_failed', {
          actor,
          automatic,
          result: http.status,
          after: { name, from: fromVersion, to: resolved?.version || null, code: http.extra?.code || null, message: http.message.slice(0, 200) },
        });
      }
      throw http;
    }

    let files;
    let manifest;
    try {
      const zip = await fetchBounded(resolved.packageUrl, {
        maxBytes: config.pluginMaxZipBytes,
        timeoutMs: UPDATE_PACKAGE_TIMEOUT_MS,
      });
      digest = sha256Hex(zip);
      if (digest !== resolved.sha256) {
        throw new HttpError(400, 'downloaded package does not match the feed sha256', { code: 'CHECKSUM_MISMATCH' });
      }
      if (p.manifest.updatePublicKey && !verifyPackageSignature(p.manifest.updatePublicKey, zip, resolved.signature)) {
        throw new HttpError(400, 'package signature does not match the installed update key', { code: 'SIGNATURE_INVALID' });
      }
      try {
        files = stripCommonRoot(readZip(zip));
        manifest = validatePackage(files, { appVersion: config.appVersion });
      } catch (err) {
        if (err instanceof ZipError || err instanceof ManifestError) {
          throw new HttpError(400, err.message, { code: err.code, field: err.field || undefined });
        }
        throw err;
      }
      if (manifest.name !== name) {
        throw new HttpError(400, `package name ${manifest.name} does not match ${name}`, { code: 'PLUGIN_NAME_MISMATCH' });
      }
      if (manifest.version !== resolved.version || !semverGt(manifest.version, fromVersion)) {
        throw new HttpError(400, 'package version does not match the feed', { code: 'PLUGIN_VERSION_MISMATCH' });
      }
    } catch (err) {
      const http = asUpdateHttp(err);
      await auditUpdate('plugin.update_failed', {
        actor,
        automatic,
        result: http.status,
        after: { name, from: fromVersion, to: resolved.version, code: http.extra?.code || null, message: http.message.slice(0, 200) },
      });
      throw http;
    }

    const requested = [...manifest.permissions].sort();
    const granted = [...(s.grantedPermissions || [])].sort();
    const samePerms = requested.join(',') === granted.join(',');
    if (s.enabled && !samePerms) {
      if (automatic) {
        s.updateAvailable = noticeFrom(resolved, { compatible: true, needsReview: true });
        s.updateCheckedAt = s.updateAvailable.checkedAt;
        await store.persist();
        return { applied: false, needsReview: true, plugin: describe(p, actor) };
      }
      const accepted = [...new Set((Array.isArray(acceptPermissions) ? acceptPermissions : []).map(String))].sort();
      if (requested.join(',') !== accepted.join(',')) {
        throw new HttpError(400, 'review and accept the updated permissions', {
          code: 'PERMISSIONS_NOT_ACCEPTED',
          requested,
        });
      }
    }

    const keepEnabled = Boolean(s.enabled);
    const snap = {
      enabled: Boolean(s.enabled),
      grantedPermissions: [...(s.grantedPermissions || [])],
      version: s.version,
      checksum: s.checksum,
      zipSha256: s.zipSha256 || null,
      source: s.source,
      updateAvailable: s.updateAvailable,
      updateCheckError: s.updateCheckError || null,
    };
    const root = path.resolve(p.source === 'upload' ? config.pluginsUploadDir : config.pluginsBundledDir);
    const dir = path.resolve(p.dir);
    if (!dir.startsWith(`${root}${path.sep}`)) throw new HttpError(500, 'plugin path outside its directory');

    deactivate(p);
    let backup = null;
    let swapped = false;
    try {
      backup = await swapPluginDir(dir, files);
      swapped = true;
      const next = await loadFromDir(dir, p.source);
      plugins.set(name, next);
      s.version = next.manifest.version;
      s.checksum = next.checksum;
      s.zipSha256 = digest;
      s.source = p.source;
      s.enabled = keepEnabled;
      s.grantedPermissions = keepEnabled ? requested : [];
      s.updateAvailable = null;
      s.updateCheckError = null;
      s.updatedAt = new Date().toISOString();
      s.updatedBy = actor?.handle || (automatic ? 'auto' : null);
      if (keepEnabled) await activate(next);
      await store.persist();
      await auditUpdate('plugin.updated', {
        actor,
        automatic,
        before: { name, version: fromVersion, checksum: snap.checksum },
        after: {
          name,
          version: next.manifest.version,
          checksum: next.checksum,
          sha256: digest,
          automatic: Boolean(automatic),
          enabled: keepEnabled,
        },
      });
      await fsp.rm(backup, { recursive: true, force: true });
      backup = null;
      armUpdateTimer();
      return { applied: true, needsReview: false, plugin: describe(next, actor) };
    } catch (err) {
      try {
        const cur = plugins.get(name);
        if (cur && !cur.invalid) deactivate(cur);
        if (swapped && backup) {
          await fsp.rm(dir, { recursive: true, force: true });
          await fsp.rename(backup, dir);
          backup = null;
        } else if (backup && !swapped) {
          await fsp.rm(backup, { recursive: true, force: true }).catch(() => {});
        }
        const restored = await loadFromDir(dir, snap.source || p.source);
        plugins.set(name, restored);
        Object.assign(s, snap);
        if (snap.enabled) {
          try {
            await activate(restored);
          } catch (startErr) {
            restored.error = startErr.message;
            s.enabled = false;
            s.grantedPermissions = [];
          }
        }
        await store.persist();
      } catch (rollbackErr) {
        warn(name, `rollback failed: ${rollbackErr.message}`);
      }
      const http = asUpdateHttp(err);
      await auditUpdate('plugin.update_failed', {
        actor,
        automatic,
        result: http.status === 500 ? 400 : http.status,
        after: {
          name,
          from: fromVersion,
          to: resolved.version,
          code: 'PLUGIN_UPDATE_FAILED',
          message: String(http.message || '').slice(0, 200),
          restored: swapped,
        },
      });
      throw new HttpError(400, swapped ? `update failed and the previous version was restored: ${http.message}` : http.message, {
        code: 'PLUGIN_UPDATE_FAILED',
      });
    }
  }

  async function inspectUpdate(p, { actor = null, automatic = false } = {}) {
    const name = p.manifest.name;
    const s = state(name);
    const fromVersion = p.manifest.version;
    let feed;
    try {
      feed = await readFeed(p);
    } catch (err) {
      const http = asUpdateHttp(err);
      if (s) {
        s.updateCheckedAt = new Date().toISOString();
        s.updateCheckError = http.message.slice(0, 200);
        await store.persist();
      }
      return { name, available: false, error: http.message };
    }
    if (!s) return { name, available: false, error: 'plugin not found' };
    s.updateCheckedAt = new Date().toISOString();
    if (!semverGt(feed.version, fromVersion)) {
      s.updateAvailable = null;
      s.updateCheckError = null;
      await store.persist();
      return { name, from: fromVersion, to: feed.version, available: false, applied: false };
    }
    if (p.manifest.updatePublicKey && !feed.signature) {
      s.updateAvailable = null;
      s.updateCheckError = 'update feed is missing a signature';
      await store.persist();
      return { name, from: fromVersion, to: feed.version, available: false, error: s.updateCheckError };
    }
    const compatible = semverGte(config.appVersion, feed.minAppVersion);
    const prev = s.updateAvailable;
    const same = prev && prev.version === feed.version && prev.sha256 === feed.sha256;
    s.updateAvailable = noticeFrom(feed, { compatible, needsReview: same ? Boolean(prev.needsReview) : false });
    s.updateCheckError = null;
    await store.persist();
    if (!same) {
      await auditUpdate('plugin.update_available', {
        actor,
        automatic,
        after: {
          name,
          from: fromVersion,
          to: feed.version,
          sha256: feed.sha256,
          changelog: feed.changelog.slice(0, 300),
          compatible,
        },
      });
    }
    if (s.autoUpdate && compatible && !s.updateAvailable.needsReview) {
      try {
        const result = await applyUpdateInner(p, {
          actor: actor || { handle: s.autoUpdateEnabledBy || 'auto' },
          automatic: true,
          feed,
        });
        return {
          name,
          from: fromVersion,
          to: feed.version,
          changelog: feed.changelog,
          available: !result.applied,
          applied: Boolean(result.applied),
          needsReview: Boolean(result.needsReview),
          compatible,
          error: null,
        };
      } catch (err) {
        return {
          name,
          from: fromVersion,
          to: feed.version,
          changelog: feed.changelog,
          available: true,
          applied: false,
          needsReview: Boolean(state(name)?.updateAvailable?.needsReview),
          compatible,
          error: String(err.message || err).slice(0, 200),
        };
      }
    }
    return {
      name,
      from: fromVersion,
      to: feed.version,
      changelog: feed.changelog,
      available: true,
      applied: false,
      needsReview: Boolean(s.updateAvailable?.needsReview),
      compatible,
      error: null,
    };
  }

  async function checkUpdates({ actor = null, automatic = false } = {}) {
    if (store.writerActive === false) return { checked: 0, updates: [], errors: [], skipped: 'standby' };
    const targets = [...plugins.values()].filter((item) => !item.invalid && item.manifest.updateUrl);
    if (!targets.length) return { checked: 0, updates: [], errors: [] };
    const updates = [];
    const errors = [];
    for (const p of targets) {
      try {
        const row = await withUpdateLock(p.manifest.name, () => inspectUpdate(p, { actor, automatic }));
        if (row.available || row.applied) updates.push(row);
        if (row.error) errors.push({ name: p.manifest.name, message: row.error });
      } catch (err) {
        errors.push({ name: p.manifest.name, message: String(err.message || err).slice(0, 200) });
      }
    }
    return { checked: targets.length, updates, errors };
  }

  async function applyUpdate(name, opts = {}) {
    const p = get(name);
    return withUpdateLock(p.manifest.name, () => applyUpdateInner(p, opts));
  }

  async function setAutoUpdate(name, { actor, enabled }) {
    const p = get(name);
    refuseWithoutSource(p);
    const s = state(p.manifest.name);
    const on = Boolean(enabled);
    s.autoUpdate = on;
    s.autoUpdateEnabledAt = on ? new Date().toISOString() : null;
    s.autoUpdateEnabledBy = on ? actor?.handle || null : null;
    await store.persist();
    await auditUpdate(on ? 'plugin.auto_update_on' : 'plugin.auto_update_off', {
      actor,
      after: { name: p.manifest.name, version: p.manifest.version, autoUpdate: on },
    });
    let applied = false;
    let needsReview = Boolean(s.updateAvailable?.needsReview);
    let applyError = null;
    if (on && s.updateAvailable && s.updateAvailable.compatible !== false) {
      try {
        const result = await applyUpdate(p.manifest.name, { actor, automatic: true });
        applied = Boolean(result.applied);
        needsReview = Boolean(result.needsReview);
      } catch (err) {
        const http = asUpdateHttp(err);
        if (http.extra?.code !== 'PLUGIN_UP_TO_DATE') {
          applyError = { code: http.extra?.code || 'PLUGIN_UPDATE_FAILED', message: http.message };
        }
      }
    }
    const current = plugins.get(p.manifest.name) || p;
    return { plugin: describe(current, actor), applied, needsReview, applyError };
  }

  await init();

  return {
    list: (viewer) => [...plugins.values()].map((p) => describe(p, viewer)),
    get: (name, viewer) => describe(get(name), viewer),
    enable,
    disable,
    uninstall,
    installZip,
    checkUpdates,
    applyUpdate,
    setAutoUpdate,
    pendingUpdateCount,
    updateCheckActive: () => Boolean(config.pluginUpdateIntervalMs) && hasUpdateSource() && store.writerActive !== false,
    stop: stopUpdates,
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

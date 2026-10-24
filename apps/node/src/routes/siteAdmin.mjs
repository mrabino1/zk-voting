// NOT FOR PROFIT — civic public good, not a commercial product.
// Site admin API: roles & users, layout, plugins, audit.
// Session only (API keys are refused), CSRF on every write, capability checks
// on every route. See docs/roles.md and docs/plugins/README.md.

import express from 'express';

import {
  CAPABILITIES,
  CAPABILITY_LABELS,
  capabilitiesOf,
  hasCapability,
  normalizeRoleInput,
  requireCapability,
  roleCatalogue,
  roleChangeError,
} from '../capabilities.mjs';
import { asyncHandler, HttpError } from '../http.mjs';
import {
  AUDIENCES,
  layoutForAudience,
  REGIONS,
  THEME_TOKENS,
  themeCss,
  themeWarnings,
  WIDGET_TYPES,
} from '../layout.mjs';
import { CLIENT_SLOTS, PLUGIN_EVENTS, PLUGIN_PERMISSIONS } from '../plugins/manifest.mjs';
import { isOfficerRole, isPlatformOperator } from '../roles.mjs';
import { appendSiteAudit, listSiteAudit } from '../siteAudit.mjs';
import { loginAgeMs, requireCsrf, requireRecentLogin, requireSession } from '../siteAdminGuard.mjs';

function countSuperAdmins(store) {
  return store.data.users.filter((u) => u.role === 'platform_super_admin' && !u.suspendedAt).length;
}

function userRow(u) {
  return {
    id: u.id,
    handle: u.handle,
    role: u.role,
    createdAt: u.createdAt || null,
    suspended: Boolean(u.suspendedAt),
    capabilities: capabilitiesOf(u),
  };
}

function layoutSummary(layout) {
  if (!layout) return null;
  return {
    navManaged: Boolean(layout.nav?.managed),
    navItems: (layout.nav?.items || []).map((i) => `${i.id}:${i.visible ? 'on' : 'off'}:${i.order}`),
    hidden: layout.nav?.hidden || [],
    widgets: Object.fromEntries(Object.entries(layout.regions || {}).map(([r, list]) => [r, list.map((w) => w.id)])),
    theme: layout.theme || {},
    productName: layout.branding?.productName || null,
  };
}

/**
 * Change a user's global role with all safety rules and an audit entry.
 * Shared by the site-admin API and the legacy PATCH /api/admin/users/:id.
 */
export async function changeUserRole(deps, { actor, targetId, role, req }) {
  const { store, plugins } = deps;
  const target = store.getUser(String(targetId));
  const nextRole = normalizeRoleInput(role);
  const err = roleChangeError({ actor, target, nextRole, superAdminCount: countSuperAdmins(store) });
  if (err) {
    if (target && err.status !== 400) {
      await appendSiteAudit(store, {
        actor,
        area: 'roles',
        action: 'role.change_denied',
        method: req?.method,
        path: req?.originalUrl?.split('?')[0],
        result: err.status,
        before: { userId: target.id, handle: target.handle, role: target.role },
        after: { role: nextRole, code: err.extra?.code || null },
      });
    }
    throw err;
  }
  const before = target.role;
  if (before === nextRole) return { user: target, changed: false };
  await store.updateUserRole(target.id, nextRole);
  await appendSiteAudit(store, {
    actor,
    area: 'roles',
    action: 'role.change',
    method: req?.method,
    path: req?.originalUrl?.split('?')[0],
    result: 200,
    before: { userId: target.id, handle: target.handle, role: before },
    after: { userId: target.id, handle: target.handle, role: nextRole },
  });
  await plugins?.emit('user.role_changed', {
    userId: target.id,
    handle: target.handle,
    from: before,
    to: nextRole,
    by: actor?.handle || null,
  });
  return { user: target, changed: true, before };
}

/** Public: effective layout for the viewer + enabled client plugins. */
export function layoutPublicRouter(deps) {
  const { layoutService, plugins } = deps;
  const router = express.Router();
  router.get('/layout', (req, res) => {
    const viewer = req.user
      ? {
          officer: isOfficerRole(req.user.role),
          admin: isPlatformOperator(req.user) || hasCapability(req.user, 'access_site_admin'),
        }
      : null;
    const { layout } = layoutService.effective();
    res.set('Cache-Control', 'no-store');
    res.json({ layout: layoutForAudience(layout, viewer), plugins: plugins.clientManifest(req.user), nfp: true });
  });
  router.get('/layout/theme.css', (_req, res) => {
    const { layout } = layoutService.effective();
    res.set({ 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.send(themeCss(layout));
  });
  return router;
}

export function siteAdminRouter(deps) {
  const { store, config, layoutService, plugins } = deps;
  const router = express.Router();
  router.use(requireSession, requireCsrf);
  const cap = (c) => requireCapability(c);
  const reauth = requireRecentLogin(config.pluginReauthMs);

  router.get('/me', (req, res) => {
    const caps = capabilitiesOf(req.user);
    res.set('Cache-Control', 'no-store');
    res.json({
      user: { id: req.user.id, handle: req.user.handle, role: req.user.role },
      capabilities: caps,
      csrfToken: req.session.csrfToken,
      loginAgeSeconds: Math.round(loginAgeMs(req.session) / 1000),
      reauthWindowSeconds: Math.round(config.pluginReauthMs / 1000),
      pluginUploadsEnabled: Boolean(config.pluginsAllowUpload),
      menu: caps.includes('access_site_admin') ? plugins.adminMenu(req.user) : [],
      nfp: true,
    });
  });

  // ---- roles & users ------------------------------------------------------
  router.get('/roles', cap('access_site_admin'), (_req, res) => {
    res.json({
      roles: roleCatalogue(),
      capabilities: CAPABILITIES.map((id) => ({ id, label: CAPABILITY_LABELS[id] })),
      superAdmins: countSuperAdmins(store),
      nfp: true,
    });
  });

  router.get('/users', cap('view_users'), (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase().slice(0, 80);
    const role = String(req.query.role || '').trim();
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50) || 50));
    let rows = store.data.users;
    if (q) rows = rows.filter((u) => String(u.handle || '').toLowerCase().includes(q));
    if (role) rows = rows.filter((u) => u.role === role);
    res.json({ users: rows.slice(0, limit).map(userRow), total: rows.length, nfp: true });
  });

  router.put(
    '/users/:id/role',
    cap('manage_roles'),
    asyncHandler(async (req, res) => {
      const result = await changeUserRole(deps, {
        actor: req.user,
        targetId: req.params.id,
        role: req.body?.role,
        req,
      });
      res.json({ user: userRow(result.user), changed: result.changed, nfp: true });
    }),
  );

  // ---- layout -------------------------------------------------------------
  router.get('/layout', cap('edit_layout'), (_req, res) => {
    const { layout, sources } = layoutService.effective();
    res.json({
      saved: layoutService.saved(),
      effective: layout,
      sources,
      warnings: themeWarnings(layout),
      fileOverride: layoutService.hasFileOverride(),
      codeOverride: layoutService.hasCodeOverride(),
      schema: {
        regions: REGIONS,
        audiences: AUDIENCES,
        widgetTypes: WIDGET_TYPES,
        themeTokens: Object.entries(THEME_TOKENS).map(([id, kind]) => ({ id, kind })),
        slots: CLIENT_SLOTS,
      },
      nfp: true,
    });
  });

  router.put(
    '/layout',
    cap('edit_layout'),
    asyncHandler(async (req, res) => {
      const before = layoutService.saved();
      const raw = req.body?.layout ?? req.body;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new HttpError(400, 'layout must be an object', { code: 'LAYOUT_INVALID' });
      }
      const nextName = String(raw.branding?.productName ?? before.branding.productName).trim();
      const input = { ...raw, branding: { productName: nextName } };
      if (nextName !== before.branding.productName && !hasCapability(req.user, 'manage_branding')) {
        throw new HttpError(403, 'only a super admin or admin may rename the product', {
          code: 'CAPABILITY',
          capability: 'manage_branding',
        });
      }
      const saved = await layoutService.save(input);
      await appendSiteAudit(store, {
        actor: req.user,
        area: 'layout',
        action: 'layout.update',
        method: req.method,
        path: req.originalUrl,
        before: layoutSummary(before),
        after: layoutSummary(saved),
      });
      await plugins.emit('layout.updated', { by: req.user.handle });
      const { layout, sources } = layoutService.effective();
      res.json({ saved, effective: layout, sources, warnings: themeWarnings(layout), nfp: true });
    }),
  );

  router.post(
    '/layout/reset',
    cap('edit_layout'),
    asyncHandler(async (req, res) => {
      const before = layoutService.saved();
      await layoutService.reset();
      await appendSiteAudit(store, {
        actor: req.user,
        area: 'layout',
        action: 'layout.reset',
        method: req.method,
        path: req.originalUrl,
        before: layoutSummary(before),
        after: null,
      });
      await plugins.emit('layout.updated', { by: req.user.handle, reset: true });
      res.json({ ok: true, nfp: true });
    }),
  );

  // ---- plugins ------------------------------------------------------------
  router.get('/plugins', cap('manage_plugins'), (req, res) => {
    res.json({
      plugins: plugins.list(req.user),
      uploadsEnabled: Boolean(config.pluginsAllowUpload),
      maxZipBytes: config.pluginMaxZipBytes,
      reauthWindowSeconds: Math.round(config.pluginReauthMs / 1000),
      permissions: Object.entries(PLUGIN_PERMISSIONS).map(([id, description]) => ({ id, description })),
      events: PLUGIN_EVENTS,
      slots: CLIENT_SLOTS,
      nfp: true,
    });
  });

  const uploadGate = (_req, _res, next) => {
    if (!config.pluginsAllowUpload) {
      next(new HttpError(403, 'plugin upload is disabled (set PLUGINS_ALLOW_UPLOAD=1)', { code: 'PLUGIN_UPLOAD_DISABLED' }));
      return;
    }
    next();
  };

  router.post(
    '/plugins/upload',
    cap('manage_plugins'),
    uploadGate,
    reauth,
    express.raw({ type: ['application/zip', 'application/octet-stream', 'application/x-zip-compressed'], limit: config.pluginMaxZipBytes }),
    asyncHandler(async (req, res) => {
      try {
        const plugin = await plugins.installZip(req.body, {
          actor: req.user,
          expectedSha256: String(req.get('x-plugin-sha256') || '').toLowerCase(),
        });
        await appendSiteAudit(store, {
          actor: req.user,
          area: 'plugins',
          action: 'plugin.install',
          method: req.method,
          path: req.originalUrl,
          result: 201,
          after: { name: plugin.name, version: plugin.version, checksum: plugin.checksum, enabled: false },
        });
        res.status(201).json({ plugin, nfp: true });
      } catch (err) {
        await appendSiteAudit(store, {
          actor: req.user,
          area: 'plugins',
          action: 'plugin.install_rejected',
          method: req.method,
          path: req.originalUrl,
          result: Number(err.status || 500),
          after: { code: err.extra?.code || err.code || null, message: String(err.message || '').slice(0, 200) },
        });
        throw err;
      }
    }),
  );

  router.post(
    '/plugins/:name/enable',
    cap('manage_plugins'),
    // Enabling runs plugin code with full trust, so it needs a recent sign-in too.
    reauth,
    asyncHandler(async (req, res) => {
      const plugin = await plugins.enable(req.params.name, {
        actor: req.user,
        acceptPermissions: req.body?.acceptPermissions,
      });
      await appendSiteAudit(store, {
        actor: req.user,
        area: 'plugins',
        action: 'plugin.enable',
        method: req.method,
        path: req.originalUrl,
        after: { name: plugin.name, version: plugin.version, checksum: plugin.checksum, permissions: plugin.grantedPermissions },
      });
      res.json({ plugin, nfp: true });
    }),
  );

  router.post(
    '/plugins/:name/disable',
    cap('manage_plugins'),
    asyncHandler(async (req, res) => {
      const plugin = await plugins.disable(req.params.name, { actor: req.user });
      await appendSiteAudit(store, {
        actor: req.user,
        area: 'plugins',
        action: 'plugin.disable',
        method: req.method,
        path: req.originalUrl,
        after: { name: plugin.name, version: plugin.version },
      });
      res.json({ plugin, nfp: true });
    }),
  );

  router.delete(
    '/plugins/:name',
    cap('manage_plugins'),
    reauth,
    asyncHandler(async (req, res) => {
      const removed = await plugins.uninstall(req.params.name, { actor: req.user });
      await appendSiteAudit(store, {
        actor: req.user,
        area: 'plugins',
        action: 'plugin.uninstall',
        method: req.method,
        path: req.originalUrl,
        before: removed,
      });
      res.json({ removed, nfp: true });
    }),
  );

  // ---- audit --------------------------------------------------------------
  router.get('/audit', cap('view_audit'), (req, res) => {
    res.json({ ...listSiteAudit(store, req.query), nfp: true });
  });

  return router;
}

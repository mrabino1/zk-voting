// NOT FOR PROFIT — civic public good, not a commercial product.
// Capability model for site administration (roles, layout, plugins, audit).
//
// A user still holds exactly one global `user.role` (see roles.mjs). This
// module maps that role to a set of capabilities. Election, ballot, roll and
// tally routes keep their existing role / jurisdiction checks. Capabilities
// gate the site-admin surface (roles, layout, plugins, audit) and the scoped
// plugin API. Nothing here touches ZK, crypto, voting or tally logic.

import { HttpError } from './http.mjs';
import { ROLES, ROLE_LABELS } from './roles.mjs';

export const CAPABILITIES = Object.freeze([
  'access_site_admin',
  'manage_admins',
  'manage_roles',
  'view_users',
  'manage_plugins',
  'edit_layout',
  'manage_branding',
  'manage_elections',
  'view_audit',
  'moderate_content',
]);

export const CAPABILITY_LABELS = Object.freeze({
  access_site_admin: 'Open the site admin screens',
  manage_admins: 'Grant or remove admin and super admin',
  manage_roles: 'Change other users\u2019 global roles (below admin)',
  view_users: 'List users and their roles',
  manage_plugins: 'Import, enable, disable and uninstall plugins',
  edit_layout: 'Edit navigation, widgets, regions and theme tokens',
  manage_branding: 'Rename the product (default \u201czk-voting\u201d)',
  manage_elections: 'Manage elections in plugins and admin pages',
  view_audit: 'Read the site-admin audit log',
  moderate_content: 'Moderate public content and feedback in plugins',
});

/**
 * Global site roles. Canonical ids stay compatible with the existing store
 * (`platform_super_admin`, `platform_admin`). Short aliases are accepted on
 * input only.
 */
export const SITE_ROLES = Object.freeze([
  'platform_super_admin',
  'platform_admin',
  'designer',
  'election_manager',
  'auditor',
  'moderator',
]);

export const ROLE_ALIASES = Object.freeze({
  super_admin: 'platform_super_admin',
  superadmin: 'platform_super_admin',
  admin: 'platform_admin',
  editor: 'designer',
});

const ALL = CAPABILITIES.slice();

export const ROLE_CAPABILITIES = Object.freeze({
  platform_super_admin: Object.freeze(ALL),
  platform_admin: Object.freeze([
    'access_site_admin',
    'manage_roles',
    'view_users',
    'manage_plugins',
    'edit_layout',
    'manage_branding',
    'manage_elections',
    'view_audit',
    'moderate_content',
  ]),
  designer: Object.freeze(['access_site_admin', 'edit_layout']),
  election_manager: Object.freeze(['access_site_admin', 'manage_elections']),
  auditor: Object.freeze(['access_site_admin', 'view_audit', 'view_users']),
  moderator: Object.freeze(['access_site_admin', 'moderate_content']),
  voter: Object.freeze([]),
  observer: Object.freeze([]),
  clerk: Object.freeze([]),
  registrar: Object.freeze([]),
  disqualification_officer: Object.freeze([]),
  tally_operator: Object.freeze([]),
  election_staff: Object.freeze([]),
});

/** Roles that only a holder of `manage_admins` may grant or take away. */
export const PROTECTED_ROLES = Object.freeze(['platform_super_admin', 'platform_admin']);

export function normalizeRoleInput(role) {
  const raw = String(role || '').trim().toLowerCase();
  return ROLE_ALIASES[raw] || raw;
}

export function isCapability(cap) {
  return CAPABILITIES.includes(cap);
}

export function capabilitiesForRole(role) {
  return (ROLE_CAPABILITIES[String(role || '')] || []).slice();
}

export function capabilitiesOf(user) {
  if (!user || user.suspendedAt) return [];
  return capabilitiesForRole(user.role);
}

export function hasCapability(user, cap) {
  if (!isCapability(cap)) return false;
  return capabilitiesOf(user).includes(cap);
}

/** Role catalogue for the Roles screen and docs. */
export function roleCatalogue() {
  return ROLES.map((id) => ({
    id,
    label: ROLE_LABELS[id] || id,
    capabilities: capabilitiesForRole(id),
    protected: PROTECTED_ROLES.includes(id),
    site: SITE_ROLES.includes(id),
  }));
}

/**
 * Express middleware. Session only: API keys cannot reach site-admin
 * capabilities (they already 403 at enforceApiKeyAccess for uncatalogued
 * routes; this is defence in depth).
 */
export function requireCapability(cap, { allowApiKey = false } = {}) {
  if (!isCapability(cap)) throw new Error(`unknown capability ${cap}`);
  return function capabilityGuard(req, _res, next) {
    if (!req.user) {
      next(new HttpError(401, 'unauthenticated'));
      return;
    }
    if (req.apiKey && !allowApiKey) {
      next(new HttpError(403, 'api key cannot use site admin', { code: 'API_KEY_SCOPE' }));
      return;
    }
    if (!hasCapability(req.user, cap)) {
      next(new HttpError(403, 'missing capability', { code: 'CAPABILITY', capability: cap }));
      return;
    }
    next();
  };
}

/**
 * Decide whether `actor` may move `target` from its current role to `nextRole`.
 * Returns null when allowed, or an HttpError to throw.
 * @param {{ actor: object, target: object, nextRole: string, superAdminCount: number }} input
 */
export function roleChangeError({ actor, target, nextRole, superAdminCount }) {
  if (!actor) return new HttpError(401, 'unauthenticated');
  if (!target) return new HttpError(404, 'user not found');
  if (!ROLES.includes(nextRole)) return new HttpError(400, 'invalid role', { code: 'INVALID_ROLE' });
  if (!hasCapability(actor, 'manage_roles')) {
    return new HttpError(403, 'missing capability', { code: 'CAPABILITY', capability: 'manage_roles' });
  }
  const touchesProtected = PROTECTED_ROLES.includes(nextRole) || PROTECTED_ROLES.includes(target.role);
  if (touchesProtected && !hasCapability(actor, 'manage_admins')) {
    return new HttpError(403, 'only a super admin may grant or remove admin roles', {
      code: 'CAPABILITY',
      capability: 'manage_admins',
    });
  }
  if (
    target.role === 'platform_super_admin' &&
    nextRole !== 'platform_super_admin' &&
    Number(superAdminCount) <= 1
  ) {
    return new HttpError(409, 'cannot demote the last super admin', { code: 'LAST_SUPER_ADMIN' });
  }
  return null;
}

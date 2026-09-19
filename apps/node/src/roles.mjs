// NOT FOR PROFIT — civic public good, not a commercial product.

export const ROLES = [
  'voter',
  'clerk',
  'registrar',
  'disqualification_officer',
  'tally_operator',
  'platform_admin',
  'observer',
];

/** Officer roles that are granted per jurisdiction. platform_admin is global. */
export const OFFICER_ROLES = [
  'clerk',
  'registrar',
  'disqualification_officer',
  'tally_operator',
];

export function isRole(role) {
  return ROLES.includes(role);
}

export function isOfficerRole(role) {
  return OFFICER_ROLES.includes(String(role || '').toLowerCase());
}

/**
 * Election officials: platform_admin (global) or a jurisdiction grant
 * (clerk / registrar / disqualification_officer / tally_operator).
 * A global user.role of those officer names also counts (dev-login tests).
 */
export function userIsOfficer(user, jurisdictionRoles = []) {
  if (!user) return false;
  const role = String(user.role || '').toLowerCase();
  if (role === 'platform_admin') return true;
  if (OFFICER_ROLES.includes(role)) return true;
  return (jurisdictionRoles || []).some((grant) => isOfficerRole(grant?.role));
}

export function audienceOfUser(user, jurisdictionRoles = []) {
  if (!user) return 'public';
  return userIsOfficer(user, jurisdictionRoles) ? 'officer' : 'registered';
}

export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    handle: user.handle,
    role: user.role,
    createdAt: user.createdAt,
    credentialCount: Array.isArray(user.credentials) ? user.credentials.length : 0,
    authMethodCount: Array.isArray(user.authMethods) ? user.authMethods.length : 0,
    activeEthAddress: user.activeEthAddress || null,
    personKeyBound: Boolean(user.personKeyHash),
  };
}

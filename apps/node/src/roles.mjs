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
  return OFFICER_ROLES.includes(role);
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

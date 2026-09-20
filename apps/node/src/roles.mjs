// NOT FOR PROFIT — civic public good, not a commercial product.

export const ROLES = [
  'voter',
  'clerk',
  'registrar',
  'disqualification_officer',
  'tally_operator',
  'election_staff',
  'platform_admin',
  'platform_super_admin',
  'observer',
];

/** Officer roles granted per jurisdiction (or, for election_staff, per election). */
export const OFFICER_ROLES = [
  'clerk',
  'registrar',
  'disqualification_officer',
  'tally_operator',
  'election_staff',
];

/** Super admin approves admins. Admin approves election staff. Staff approve external parties. */
export const APPROVAL_CHAIN = Object.freeze({
  platform_super_admin: 'Approves platform admins. Wires the host and factory.',
  platform_admin: 'Approves election staff. Creates jurisdictions and grants officers.',
  election_staff: 'Registers unbounded external eligibility parties for an election.',
});

export function isRole(role) {
  return ROLES.includes(role);
}

export function isOfficerRole(role) {
  return OFFICER_ROLES.includes(role);
}

export function isSuperAdmin(user) {
  return Boolean(user && user.role === 'platform_super_admin');
}

/** Super admin or platform admin. */
export function isPlatformOperator(user) {
  return Boolean(user && (user.role === 'platform_super_admin' || user.role === 'platform_admin'));
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

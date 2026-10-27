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
  // Site roles (capability based, see capabilities.mjs and docs/roles.md).
  'designer',
  'election_manager',
  'auditor',
  'moderator',
];

export const ROLE_LABELS = Object.freeze({
  voter: 'Voter',
  clerk: 'Election clerk',
  registrar: 'Registrar',
  disqualification_officer: 'Disqualification officer',
  tally_operator: 'Tally operator',
  election_staff: 'Election staff',
  platform_admin: 'Platform admin',
  platform_super_admin: 'Platform super admin',
  observer: 'Observer',
  designer: 'Designer (layout editor)',
  election_manager: 'Election manager',
  auditor: 'Auditor',
  moderator: 'Moderator',
});

/** Officer roles that are granted per jurisdiction. platform_admin is global. */
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
  return OFFICER_ROLES.includes(String(role || '').toLowerCase());
}

export function isSuperAdmin(user) {
  return Boolean(user && user.role === 'platform_super_admin');
}

/** Super admin or platform admin. */
export function isPlatformOperator(user) {
  return Boolean(user && (user.role === 'platform_super_admin' || user.role === 'platform_admin'));
}

/**
 * Election officials: platform_admin (global) or a jurisdiction grant
 * (clerk / registrar / disqualification_officer / tally_operator).
 * A global user.role of those officer names also counts (dev-login tests).
 */
export function userIsOfficer(user, jurisdictionRoles = []) {
  if (!user) return false;
  const role = String(user.role || '').toLowerCase();
  if (isPlatformOperator(user)) return true;
  if (OFFICER_ROLES.includes(role)) return true;
  return (jurisdictionRoles || []).some((grant) => isOfficerRole(grant?.role));
}

export function audienceOfUser(user, jurisdictionRoles = []) {
  if (!user) return 'public';
  return userIsOfficer(user, jurisdictionRoles) ? 'officer' : 'registered';
}

export function publicUser(user, { includeContactEmail = false } = {}) {
  if (!user) return null;
  const out = {
    id: user.id,
    handle: user.handle,
    role: user.role,
    createdAt: user.createdAt,
    credentialCount: Array.isArray(user.credentials) ? user.credentials.length : 0,
    emailCount: Array.isArray(user.authMethods)
      ? user.authMethods.filter((m) => m.type === 'email').length
      : 0,
    authMethodCount: Array.isArray(user.authMethods) ? user.authMethods.length : 0,
    activeEthAddress: user.activeEthAddress || null,
    personKeyBound: Boolean(user.personKeyHash),
    pinBound: Boolean(user.pinHash),
    termsHash: user.termsHash || null,
    termsVersion: user.termsVersion || null,
    termsAcceptedAt: user.termsAcceptedAt || null,
    termsEmailSentAt: user.termsEmailSentAt || null,
    termsNotifiedHash: user.termsNotifiedHash || null,
    termsNotifiedAt: user.termsNotifiedAt || null,
    hasContactEmail: Boolean(user.contactEmail),
  };
  if (includeContactEmail) out.contactEmail = user.contactEmail || '';
  return out;
}

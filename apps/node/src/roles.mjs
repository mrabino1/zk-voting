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

export function isRole(role) {
  return ROLES.includes(role);
}

export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    handle: user.handle,
    role: user.role,
    createdAt: user.createdAt,
    credentialCount: Array.isArray(user.credentials) ? user.credentials.length : 0,
  };
}

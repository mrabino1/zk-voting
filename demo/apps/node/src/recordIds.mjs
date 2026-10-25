// NOT FOR PROFIT — civic public good, not a commercial product.
// Public record ids are UUIDs so a path cannot be counted (1, 2, 3…).

import { isUuid } from './electionIds.mjs';
import { HttpError } from './http.mjs';

/** Seeded local jurisdiction. Not a counter. `demo` remains a lookup alias. */
export const DEMO_JURISDICTION_ID = '6b8e1c24-5a70-4f3d-9c12-8e4a7b6d5c30';

export function canonicalJurisdictionId(value) {
  const raw = String(value ?? '').trim();
  if (raw === 'demo') return DEMO_JURISDICTION_ID;
  return raw;
}

/**
 * Express `router.param` guard. Mail template names stay stable strings.
 * Ballot labels, page slugs, guardian indexes, and WebAuthn credential ids
 * use other parameter names and are not passed through here.
 */
export function uuidParam(name = 'id') {
  return (req, _res, next, value) => {
    const full = `${req.baseUrl || ''}${req.path || ''}`;
    if (name === 'id' && full.includes('/mail/templates/')) {
      next();
      return;
    }
    if (!isUuid(value)) {
      next(new HttpError(400, `${name} must be a uuid`, { code: 'ID_NOT_UUID' }));
      return;
    }
    next();
  };
}

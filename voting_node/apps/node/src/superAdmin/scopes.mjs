// NOT FOR PROFIT — civic public good, not a commercial product.
// Platform super-admin scope registry. Deny by default. Read and write are
// separate grants: write does not imply read. There is no wildcard.
// `apikeys` is session-only. Reserved writes are named so they can be
// enabled later; they are not grantable and have no route.

export const SA_RESOURCES = Object.freeze([
  'health',
  'config',
  'store',
  'elections',
  'users',
  'l2',
  'l1',
  'mail',
  'logs',
  'audit',
  'apikeys',
]);

/**
 * resource -> { read, write, writeState }
 * writeState: grantable | reserved | none | session-only
 * read: scope string or null when a key must not hold it
 */
export const SCOPE_REGISTRY = Object.freeze({
  health: { read: 'read:health', write: 'write:health', writeState: 'reserved' },
  config: { read: 'read:config', write: 'write:config', writeState: 'grantable' },
  store: { read: 'read:store', write: 'write:store', writeState: 'reserved' },
  elections: { read: 'read:elections', write: 'write:elections', writeState: 'grantable' },
  users: { read: 'read:users', write: 'write:users', writeState: 'grantable' },
  l2: { read: 'read:l2', write: 'write:l2', writeState: 'grantable' },
  l1: { read: 'read:l1', write: 'write:l1', writeState: 'reserved' },
  mail: { read: 'read:mail', write: 'write:mail', writeState: 'grantable' },
  logs: { read: 'read:logs', write: 'write:logs', writeState: 'grantable' },
  audit: { read: 'read:audit', write: null, writeState: 'none' },
  apikeys: { read: null, write: null, writeState: 'session-only' },
});

const RESERVED_WRITE = new Set(
  SA_RESOURCES.filter((name) => SCOPE_REGISTRY[name].writeState === 'reserved').map(
    (name) => SCOPE_REGISTRY[name].write,
  ),
);

export function scopeName(kind, resource) {
  return `${kind}:${resource}`;
}

export function grantableScopes() {
  const out = [];
  for (const name of SA_RESOURCES) {
    const row = SCOPE_REGISTRY[name];
    if (row.read) out.push(row.read);
    if (row.write && row.writeState === 'grantable') out.push(row.write);
  }
  return out;
}

export function reservedScopes() {
  return [...RESERVED_WRITE];
}

/** Scopes a signed-in platform super admin session may exercise. Never apikeys-via-key. */
export function sessionScopes() {
  return grantableScopes();
}

export function isGrantableScope(scope) {
  return grantableScopes().includes(scope);
}

/**
 * @param {unknown} input
 * @returns {string[]}
 */
export function normalizeScopeList(input) {
  if (!Array.isArray(input)) {
    const err = new Error('scopes must be an array');
    err.code = 'SCOPE';
    throw err;
  }
  const cleaned = [];
  for (const raw of input) {
    const scope = String(raw || '').trim();
    if (!scope) {
      const err = new Error('empty scope');
      err.code = 'SCOPE';
      throw err;
    }
    if (scope.includes('*') || scope === 'read' || scope === 'write' || scope === 'ops' || scope.endsWith(':*')) {
      const err = new Error('wildcard scopes are not allowed');
      err.code = 'SCOPE_WILDCARD';
      throw err;
    }
    if (scope.startsWith('ops:') || scope.startsWith('diag:')) {
      const err = new Error('scope is not grantable');
      err.code = 'SCOPE_RESERVED';
      throw err;
    }
    if (RESERVED_WRITE.has(scope) || scope === 'read:apikeys' || scope === 'write:apikeys') {
      const err = new Error('scope is not grantable');
      err.code = 'SCOPE_RESERVED';
      err.scope = scope;
      throw err;
    }
    if (!isGrantableScope(scope)) {
      const err = new Error('unknown scope');
      err.code = 'SCOPE';
      err.scope = scope;
      throw err;
    }
    if (!cleaned.includes(scope)) cleaned.push(scope);
  }
  return cleaned;
}

export function actorHasScope(scopes, needed) {
  return Array.isArray(scopes) && scopes.includes(needed);
}

export function registryMatrix() {
  return SA_RESOURCES.map((resource) => {
    const row = SCOPE_REGISTRY[resource];
    return {
      resource,
      read: row.read,
      write: row.write,
      writeState: row.writeState,
      keyMayHoldRead: Boolean(row.read) && row.writeState !== 'session-only' && resource !== 'apikeys',
      keyMayHoldWrite: row.writeState === 'grantable',
    };
  });
}

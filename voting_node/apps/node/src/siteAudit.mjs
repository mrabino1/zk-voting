// NOT FOR PROFIT — civic public good, not a commercial product.
// Append-only, hash-chained audit log for site administration: role changes,
// layout edits and plugin lifecycle. Same chain format as the super-admin API
// log (superAdmin/audit.mjs) but a separate collection, so neither log can be
// used to forge the other. Entries carry handles and ids, never emails or IPs.

import { filterAuditEntries, nextAuditEntry, verifyAuditChain } from './superAdmin/audit.mjs';

export const SITE_AUDIT_MAX = 5000;

export function ensureSiteAdminCollections(data) {
  if (!data || typeof data !== 'object') return data;
  if (!Array.isArray(data.siteAudit)) data.siteAudit = [];
  if (!data.layout || typeof data.layout !== 'object' || Array.isArray(data.layout)) data.layout = null;
  if (!data.plugins || typeof data.plugins !== 'object' || Array.isArray(data.plugins)) data.plugins = {};
  if (!data.pluginData || typeof data.pluginData !== 'object' || Array.isArray(data.pluginData)) {
    data.pluginData = {};
  }
  return data;
}

/**
 * Append one entry and persist. Callers that already persisted their change
 * still call this; the audit write is its own persist.
 * @param {import('./store.mjs').Store} store
 * @param {{ actor?: object|null, action: string, area: string, method?: string, path?: string,
 *   result?: number, before?: unknown, after?: unknown }} event
 */
export async function appendSiteAudit(store, event) {
  ensureSiteAdminCollections(store.data);
  const rows = store.data.siteAudit;
  const entry = nextAuditEntry(rows[rows.length - 1] || null, {
    timestamp: new Date().toISOString(),
    keyId: null,
    sessionUser: event.actor?.handle || event.actorHandle || null,
    method: event.method || 'INTERNAL',
    path: event.path || null,
    scope: event.area,
    result: Number(event.result || 200),
    reason: event.action,
    before: event.before ?? null,
    after: event.after ?? null,
  });
  rows.push(entry);
  await store.persist();
  return entry;
}

export function listSiteAudit(store, query = {}) {
  ensureSiteAdminCollections(store.data);
  let rows = store.data.siteAudit;
  if (query.area) rows = rows.filter((row) => row.scope === String(query.area));
  if (query.action) rows = rows.filter((row) => row.reason === String(query.action));
  const newestFirst = rows.slice().reverse();
  const page = filterAuditEntries(newestFirst, { limit: query.limit });
  return { ...page, next: null, verify: verifyAuditChain(store.data.siteAudit) };
}

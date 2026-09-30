// NOT FOR PROFIT — civic public good, not a commercial product.

export function ensureSuperAdminCollections(data) {
  if (!data || typeof data !== 'object') return data;
  if (!Array.isArray(data.superAdminKeys)) data.superAdminKeys = [];
  if (!Array.isArray(data.superAdminAudit)) data.superAdminAudit = [];
  if (!data.runtime || typeof data.runtime !== 'object' || Array.isArray(data.runtime)) {
    data.runtime = {};
  }
  return data;
}

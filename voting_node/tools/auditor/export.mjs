// NOT FOR PROFIT — civic public good, not a commercial product.
// Export a public poll auditor bundle from Node HTTP. Civic votes: see rollup.mjs.
// Does not open apps/node/data/zk-voting.json.

import { verifyAuditorBundle, AUDITOR_SCHEMA } from './verify.mjs';

/**
 * Fetch GET /api/elections/:id/artifacts from a ZK-Voting Node (public HTTP).
 */
export async function exportFromNode(baseUrl, electionId) {
  const url = `${String(baseUrl).replace(/\/+$/, '')}/api/elections/${encodeURIComponent(electionId)}/artifacts`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Node artifacts ${res.status}: ${text.slice(0, 400)}`);
  }
  return res.json();
}

export async function loadBundle(source) {
  if (source && typeof source === 'object' && !Array.isArray(source)) return source;
  throw new Error('loadBundle: expected object');
}

export { verifyAuditorBundle, AUDITOR_SCHEMA };

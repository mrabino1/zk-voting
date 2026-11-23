// NOT FOR PROFIT — civic public good, not a commercial product.
// The outcomes monitor's L1 audit of a civic vote: the same checks as
// `tools/auditor/cli.mjs verify-rollup`, run from this Node against L1. It reads only public
// L1 data (batch pubdata, the final sum, guardian shares, the result), so a reader can rerun
// it anywhere and expect the same answer.

import { auditRollupElection } from '../../../../tools/auditor/rollup.mjs';

const FINAL = new Set(['finalized', 'withheld', 'halted']);
const OPEN_TTL_MS = 60_000;
const cache = new Map();

/**
 * `{ ok, checks: { name: bool }, errors, summary }`, or `{ ok: null, error }` when L1 cannot be
 * read. Results of finished elections are cached for good; others for a minute.
 */
export async function rollupAudit(election, deps, { now = Date.now() } = {}) {
  const id = election?.rollup?.electionId;
  const cfg = deps.config?.rollup;
  if (!id || !cfg?.l1Rpc || !cfg?.address) return null;
  const key = `${cfg.address}:${id}`;
  const hit = cache.get(key);
  if (hit && (hit.final || now - hit.at < OPEN_TTL_MS)) return hit.value;
  let value;
  try {
    const audit = await auditRollupElection({ rpc: cfg.l1Rpc, rollup: cfg.address, electionId: id, fromBlock: BigInt(cfg.fromBlock || 0) });
    value = {
      ok: audit.ok,
      errors: audit.errors,
      checks: Object.fromEntries(audit.checks.map((c) => [c.name, c.ok])),
      details: Object.fromEntries(audit.checks.map((c) => [c.name, c.detail || null])),
      summary: audit.summary,
    };
    cache.set(key, { value, at: now, final: FINAL.has(audit.summary.status) });
  } catch (err) {
    value = { ok: null, error: `L1 audit unavailable: ${err?.shortMessage || err?.message || 'error'}` };
    cache.set(key, { value, at: now, final: false });
  }
  return value;
}

/** Test hook. */
export function clearRollupAuditCache() {
  cache.clear();
}

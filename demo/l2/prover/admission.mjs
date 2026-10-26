// NOT FOR PROFIT — civic public good, not a commercial product.
// Prover-side admission re-check (defence in depth). The sequencer already
// rejects unauthenticated admin txs and votes for unknown elections in strict
// mode; the prover refuses to batch blocks that slipped past it (for example a
// block written by an older sequencer build, or a tampered data volume).
import { isAdminTxType, verifyAdminCivic } from '../adminAuth.mjs';
import { isUuid } from '../identity.mjs';

const SCOPED = new Set(['register', 'vote', 'disqualify', 'tally', 'userop']);

/**
 * @param {object[]} blocks  full blocks (transactions as objects)
 * @param {object} opts      { admission, adminSecret, chainId, l2Uuid, getElection(uuid) -> Promise<object|null> }
 */
export async function checkBatchAdmission(blocks, { admission, adminSecret, chainId, l2Uuid, getElection }) {
  if (admission !== 'strict') return { ok: true };
  const opened = new Set();
  const known = new Map();
  for (const block of blocks) {
    for (const tx of block.transactions || []) {
      if (!tx || typeof tx !== 'object') continue;
      // The RPC block view exposes only public fields in tx.civic; the full
      // body (with the operator auth) is the JSON in tx.input.
      let civic = null;
      if (typeof tx.input === 'string' && tx.input.startsWith('0x')) {
        try {
          civic = JSON.parse(Buffer.from(tx.input.slice(2), 'hex').toString('utf8'));
        } catch {
          civic = null;
        }
      }
      if (!civic || typeof civic !== 'object') civic = tx.civic || {};
      const type = String(civic.type || tx.civicType || '').toLowerCase();
      if (isAdminTxType(type) && adminSecret) {
        const v = verifyAdminCivic(civic, { secret: adminSecret, chainId, l2Uuid });
        if (!v.ok) return { ok: false, reason: `block ${block.number} tx ${tx.hash}: ${v.reason}` };
      }
      const id = String(civic.electionId ?? '').toLowerCase();
      if (type === 'election_open') {
        if (!isUuid(id)) return { ok: false, reason: `block ${block.number}: election_open without a UUID` };
        opened.add(id);
        continue;
      }
      if (!SCOPED.has(type)) continue;
      if (!isUuid(id)) return { ok: false, reason: `block ${block.number} tx ${tx.hash}: electionId is not a UUID` };
      if (opened.has(id)) continue;
      if (!known.has(id)) known.set(id, getElection ? await getElection(id) : null);
      if (!known.get(id)) return { ok: false, reason: `block ${block.number} tx ${tx.hash}: election ${id} is not open on this L2` };
    }
  }
  return { ok: true };
}

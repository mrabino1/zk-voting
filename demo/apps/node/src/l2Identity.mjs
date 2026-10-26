// NOT FOR PROFIT — civic public good, not a commercial product.
// Node side of L2 identity: who this L2 is, whether its L1 submitter can pay
// for batches, a civic-tx client for the operator's admin writes, and readers
// that rebuild an election outcome from the L2 or from L1.
//
// Election outcomes are addressable by (l2Id, electionUuid) everywhere:
//   L2: zkv_getElection(electionUuid) on the sequencer whose l2Id matches
//   L1: resultOf(electionKey) on the L1 tally mirror, where
//       electionKey = keccak256(abi.encode(domain, l1ChainId, l2Id, bytes16(electionUuid)))
import { computeElectionKey, isUuid, resolveIdentity, resolveOperatorAddress } from '../../../l2/identity.mjs';
import { signAdminCivic } from '../../../l2/adminAuth.mjs';
import { checkSubmitterFunding } from '../../../l2/prover/funding.mjs';
import { keccak256Hex } from '../../../l2/sequencer/state.mjs';

/** Placeholder until the canonical mainnet addresses are published (README). */
export const L1_ADDRESSES_TBD = 'l1-addresses-tbd';

export async function readL2IdentityConfig(env = process.env) {
  const operator = await resolveOperatorAddress(env);
  const identity = resolveIdentity(env, { operator });
  return {
    ...identity,
    civicRpc: String(env.L2_CIVIC_RPC || '').trim(),
    l1Rpc: String(env.L1_RPC || '').trim(),
    l1TallyMirror: cleanAddr(env.L1_TALLY_MIRROR_ADDRESS),
    submitterKeySet: Boolean(String(env.L1_SUBMITTER_PRIVATE_KEY || '').trim()),
    adminSecretSet: Boolean(String(env.L2_ADMIN_SECRET || '').trim()),
  };
}

function cleanAddr(v) {
  const s = String(v || '').trim();
  return /^0x[0-9a-fA-F]{40}$/.test(s) ? s.toLowerCase() : '';
}

/** Public view: never the salt, admin secret or submitter key. */
export function publicL2Identity(cfg) {
  return {
    l2Uuid: cfg.l2Uuid,
    l2Id: cfg.l2Id,
    operator: cfg.operator,
    l1ChainId: cfg.l1ChainId,
    registryAddress: cfg.registryAddress || null,
    l1TallyMirror: cfg.l1TallyMirror || null,
    l1Status: cfg.l1Rpc && (cfg.registryAddress || cfg.l1TallyMirror) ? 'configured' : L1_ADDRESSES_TBD,
    configured: cfg.configured,
    problems: cfg.problems,
    submitterKeySet: cfg.submitterKeySet,
    adminWritesEnabled: cfg.adminSecretSet,
  };
}

export async function l2FundingStatus(cfg, { fetchImpl = fetch } = {}) {
  return checkSubmitterFunding({ l1Rpc: cfg.l1Rpc, address: cfg.operator, fetchImpl });
}

export function electionKeyFor(cfg, electionUuid) {
  if (!cfg.l2Id || !isUuid(electionUuid)) return null;
  return computeElectionKey({ l1ChainId: cfg.l1ChainId || 0, l2Id: cfg.l2Id, electionUuid });
}

async function jsonRpc(url, method, params, fetchImpl) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(8000),
  });
  const json = await res.json();
  if (json.error) throw Object.assign(new Error(json.error.message || 'rpc error'), { rpcCode: json.error.code });
  return json.result;
}

/**
 * Send an operator-signed civic admin tx (election_open, register, tally …).
 * Only the operator's Node app holds L2_ADMIN_SECRET.
 */
export async function sendAdminCivic(cfg, civic, { env = process.env, chainId, fetchImpl = fetch } = {}) {
  if (!cfg.civicRpc) throw new Error('L2_CIVIC_RPC is not set');
  const secret = String(env.L2_ADMIN_SECRET || '');
  const signed = signAdminCivic(civic, { secret, chainId: chainId ?? env.CHAIN_ID ?? 27427, l2Uuid: cfg.l2Uuid });
  const raw = '0x' + Buffer.from(JSON.stringify(signed), 'utf8').toString('hex');
  return jsonRpc(cfg.civicRpc, 'eth_sendRawTransaction', [raw], fetchImpl);
}

/** Open an election UUID on this L2 (unique per L2, enforced by the sequencer). */
export async function openElectionOnL2(cfg, { electionUuid, approvedSenders = [] }, opts = {}) {
  if (!isUuid(electionUuid)) throw new Error('electionUuid must be a UUID');
  return sendAdminCivic(
    cfg,
    { type: 'election_open', electionId: electionUuid.toLowerCase(), approvedSenders, l2Uuid: cfg.l2Uuid },
    opts,
  );
}

/** Outcome as recorded on the L2 itself. */
export async function readOutcomeFromL2(cfg, { l2Id, electionUuid }, { fetchImpl = fetch } = {}) {
  if (!cfg.civicRpc) return { status: 'l2-not-configured', source: 'l2' };
  const ident = await jsonRpc(cfg.civicRpc, 'zkv_l2Identity', [], fetchImpl);
  if (l2Id && ident?.l2Id && ident.l2Id.toLowerCase() !== String(l2Id).toLowerCase()) {
    return { status: 'wrong-l2', source: 'l2', expected: l2Id, rpcL2Id: ident.l2Id };
  }
  const info = await jsonRpc(cfg.civicRpc, 'zkv_getElection', [electionUuid], fetchImpl);
  if (!info) return { status: 'not-found', source: 'l2' };
  return { status: 'ok', source: 'l2', l2: ident, election: info };
}

// resultOf(bytes32) — see docs/proposals/L2-REGISTRY-AND-ELECTION-KEYS.md.
const RESULT_OF_SELECTOR_SIG = 'resultOf(bytes32)';

/** Outcome as mirrored on L1. Stubbed until the canonical addresses exist. */
export async function readOutcomeFromL1(cfg, { l2Id, electionUuid }, { fetchImpl = fetch } = {}) {
  const key =
    l2Id && isUuid(electionUuid)
      ? computeElectionKey({ l1ChainId: cfg.l1ChainId || 0, l2Id, electionUuid })
      : null;
  if (!cfg.l1Rpc || !cfg.l1TallyMirror) {
    return {
      status: L1_ADDRESSES_TBD,
      source: 'l1',
      electionKey: key,
      message: 'L1 tally mirror address is TBD (see README "Canonical contract addresses"); set L1_RPC and L1_TALLY_MIRROR_ADDRESS once published.',
    };
  }
  const selector = keccak256Hex(Buffer.from(RESULT_OF_SELECTOR_SIG)).slice(0, 10);
  const data = selector + key.slice(2);
  const raw = await jsonRpc(cfg.l1Rpc, 'eth_call', [{ to: cfg.l1TallyMirror, data }, 'latest'], fetchImpl);
  // (bytes32 resultHash, bytes32 countsHash, uint64 postedAt, uint64 batchIndex)
  const hex = String(raw || '0x').slice(2).padEnd(256, '0');
  const resultHash = '0x' + hex.slice(0, 64);
  const countsHash = '0x' + hex.slice(64, 128);
  const postedAt = Number(BigInt('0x' + hex.slice(128, 192)));
  const batchIndex = Number(BigInt('0x' + hex.slice(192, 256)));
  if (/^0x0+$/.test(resultHash)) return { status: 'not-found', source: 'l1', electionKey: key };
  return { status: 'ok', source: 'l1', electionKey: key, resultHash, countsHash, postedAt, batchIndex };
}

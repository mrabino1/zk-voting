// NOT FOR PROFIT — civic public good, not a commercial product.
// Optional ElectionFactory create + BallotInbox submit via viem when CHAIN_RPC
// is configured. JSON-only demo remains when CHAIN_RPC is unset.

import { createPublicClient, createWalletClient, decodeEventLog, defineChain, getAddress, http, isAddress, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { jurisdictionBytes32 } from './electionIds.mjs';
import { PASS_ELECTION_TYPE_ON_CHAIN } from './electionType.mjs';
import { HttpError } from './http.mjs';

export const ballotInboxAbi = [
  {
    type: 'function',
    name: 'submitVote',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'electionId', type: 'uint256' },
      { name: 'a', type: 'uint256[2]' },
      { name: 'b', type: 'uint256[2][2]' },
      { name: 'c', type: 'uint256[2]' },
      { name: 'publicInputs', type: 'uint256[]' },
      { name: 'encryptedBallot', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'submitVoteBatch',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'electionId', type: 'uint256' },
      { name: 'a', type: 'uint256[2][]' },
      { name: 'b', type: 'uint256[2][2][]' },
      { name: 'c', type: 'uint256[2][]' },
      { name: 'publicInputs', type: 'uint256[][]' },
      { name: 'encryptedBallots', type: 'bytes[]' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'nullifierUsed',
    stateMutability: 'view',
    inputs: [
      { name: 'electionId', type: 'uint256' },
      { name: 'nullifier', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'submitVoteBatchRanked',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'electionId', type: 'uint256' },
      { name: 'a', type: 'uint256[2][]' },
      { name: 'b', type: 'uint256[2][2][]' },
      { name: 'c', type: 'uint256[2][]' },
      { name: 'publicInputs', type: 'uint256[][]' },
      { name: 'encryptedBallots', type: 'bytes[]' },
      { name: 'rankingHashes', type: 'bytes32[]' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'rankingCount',
    stateMutability: 'view',
    inputs: [{ name: 'electionId', type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'rankingRoot',
    stateMutability: 'view',
    inputs: [{ name: 'electionId', type: 'uint256' }],
    outputs: [{ type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'rankingCount',
    stateMutability: 'view',
    inputs: [{ name: 'electionId', type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'closedBallotCount',
    stateMutability: 'view',
    inputs: [{ name: 'electionId', type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
  },
];

/** Same shape as `@zk-voting/chain-client` FACTORY_ABI (create + ElectionCreated). */
export const electionFactoryAbi = [
  {
    type: 'function',
    name: 'createElection',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'title', type: 'string' },
          { name: 'metadataURI', type: 'string' },
          { name: 'startTime', type: 'uint64' },
          { name: 'cutoffTime', type: 'uint64' },
          { name: 'maxParticipants', type: 'uint32' },
          { name: 'treeDepth', type: 'uint8' },
          { name: 'ballotSpecHash', type: 'bytes32' },
          { name: 'clerk', type: 'address' },
          { name: 'registrar', type: 'address' },
          { name: 'disqualificationOfficer', type: 'address' },
          { name: 'tallyOperator', type: 'address' },
          { name: 'verifier', type: 'address' },
          { name: 'questionCount', type: 'uint8' },
          { name: 'jurisdictionId', type: 'bytes32' },
          { name: 'tallyPubKeyX', type: 'bytes32' },
          { name: 'tallyPubKeyY', type: 'bytes32' },
          { name: 'tallyScheme', type: 'uint8' },
          { name: 'electionType', type: 'uint8' },
        ],
      },
    ],
    outputs: [
      { name: 'electionId', type: 'uint256' },
      { name: 'election', type: 'address' },
    ],
  },
  {
    type: 'event',
    name: 'ElectionCreated',
    inputs: [
      { name: 'electionId', type: 'uint256', indexed: true },
      { name: 'election', type: 'address', indexed: true },
      { name: 'jurisdictionId', type: 'bytes32', indexed: true },
      { name: 'startTime', type: 'uint64', indexed: false },
      { name: 'cutoffTime', type: 'uint64', indexed: false },
      { name: 'electionType', type: 'uint8', indexed: false },
    ],
  },
];

export function decodeElectionCreated(receipt) {
  if (!receipt || !Array.isArray(receipt.logs)) return {};
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: electionFactoryAbi,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === 'ElectionCreated') {
        return {
          electionId: decoded.args.electionId,
          election: decoded.args.election,
          jurisdictionId: decoded.args.jurisdictionId,
          startTime: decoded.args.startTime,
          cutoffTime: decoded.args.cutoffTime,
          electionType: decoded.args.electionType,
        };
      }
    } catch {
      continue;
    }
  }
  return {};
}

function unpackCreateResult(result) {
  if (result == null) return {};
  if (Array.isArray(result)) {
    return { electionId: result[0], election: result[1] };
  }
  if (typeof result === 'object') {
    return {
      electionId: result.electionId ?? result[0],
      election: result.election ?? result[1],
    };
  }
  return {};
}

export function zkVotingChain(chainId, rpc) {
  return defineChain({
    id: chainId,
    name: 'ZK-Voting',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpc || 'http://127.0.0.1:8545'] } },
  });
}

function asBigInt(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  return BigInt(String(value));
}

function dummyPoints() {
  return {
    a: [1n, 2n],
    b: [
      [1n, 2n],
      [3n, 4n],
    ],
    c: [5n, 6n],
  };
}

/**
 * When the disclosure interval is 0, each ballot is its own transaction.
 * Otherwise the relayer holds ballots off chain and submits one batch after
 * the interval, sorted by nullifier. At cutoff the remainder is a final
 * batch of the same shape. A one-ballot batch is still a singleton.
 * The existing submitVoteBatch call accepts at most 64 ballots.
 * @param {{ pending: object[], interval: number, now: number, startTime: number, lastBatchAt: number, cutoffTime?: number }} input
 */
export function planDisclosureBatch({ pending, interval, now, startTime, lastBatchAt, cutoffTime }) {
  const rows = Array.isArray(pending) ? pending : [];
  const sorted = [...rows].sort((a, b) => {
    const left = BigInt(a.nullifier);
    const right = BigInt(b.nullifier);
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  });
  const wait = Number(interval) || 0;
  if (wait <= 0) return { action: 'immediate', batch: sorted.slice(0, 64) };
  const t = Number(now) || 0;
  const end = Number(cutoffTime);
  if (Number.isFinite(end) && t >= end) return { action: 'final', batch: sorted.slice(0, 64) };
  const start = Number(startTime) || 0;
  const last = Number(lastBatchAt) || 0;
  const due = last > 0 ? t >= last + wait : t >= start + wait;
  if (!due) return { action: 'wait', batch: [] };
  return { action: 'batch', batch: sorted.slice(0, 64) };
}

export function groth16Points(proof) {
  if (!proof || proof.accept === true || proof.accept === 'true') {
    return dummyPoints();
  }
  if (proof.pi_a && proof.pi_b && proof.pi_c) {
    return {
      a: [asBigInt(proof.pi_a[0]), asBigInt(proof.pi_a[1])],
      b: [
        [asBigInt(proof.pi_b[0][0]), asBigInt(proof.pi_b[0][1])],
        [asBigInt(proof.pi_b[1][0]), asBigInt(proof.pi_b[1][1])],
      ],
      c: [asBigInt(proof.pi_c[0]), asBigInt(proof.pi_c[1])],
    };
  }
  if (proof.a && proof.b && proof.c) {
    return {
      a: [asBigInt(proof.a[0]), asBigInt(proof.a[1])],
      b: [
        [asBigInt(proof.b[0][0]), asBigInt(proof.b[0][1])],
        [asBigInt(proof.b[1][0]), asBigInt(proof.b[1][1])],
      ],
      c: [asBigInt(proof.c[0]), asBigInt(proof.c[1])],
    };
  }
  return dummyPoints();
}

export function isNonZeroAddress(value) {
  if (!value) return false;
  try {
    if (!isAddress(String(value))) return false;
    return getAddress(String(value)) !== zeroAddress;
  } catch {
    return false;
  }
}

export function pickAddress(...candidates) {
  for (const c of candidates) {
    if (isNonZeroAddress(c)) return getAddress(c);
  }
  return null;
}

/** bytes32 jurisdiction id, or keccak256 of the Node's string id (e.g. "demo"). */
export function toJurisdictionBytes32(id) {
  return jurisdictionBytes32(id);
}

export function chainElectionIdOf(election) {
  if (!election) return null;
  if (election.onChainElectionId != null && election.onChainElectionId !== '') {
    return String(election.onChainElectionId);
  }
  return election.id != null ? String(election.id) : null;
}

/**
 * Map a clerk POST body onto ElectionFactory ElectionParams.
 * Officer roles default to the relayer when the form omits addresses
 * (same as `CreateElection.s.sol` using msg.sender). Verifier must be set.
 */
export function resolveCreateElectionParams(config, input, fromAddress) {
  const from = pickAddress(fromAddress);
  const clerk = pickAddress(input.clerk, config.clerkAddress, from);
  const registrar = pickAddress(input.registrar, config.registrarAddress, from);
  const disqualificationOfficer = pickAddress(
    input.disqualificationOfficer,
    config.disqualificationOfficerAddress,
    from,
  );
  const tallyOperator = pickAddress(input.tallyOperator, config.tallyOperatorAddress, from);
  const verifier = pickAddress(input.verifier, config.verifierAddress);
  const missing = [];
  if (!clerk) missing.push('clerk');
  if (!registrar) missing.push('registrar');
  if (!disqualificationOfficer) missing.push('disqualificationOfficer');
  if (!tallyOperator) missing.push('tallyOperator');
  if (!verifier) missing.push('verifier (set VERIFIER_ADDRESS from DeployLocal VERIFIER=)');
  if (missing.length) {
    throw new HttpError(
      503,
      `CHAIN_RPC is set but missing on-chain role address(es): ${missing.join(', ')}`,
      { code: 'CHAIN_NOT_READY', missing },
    );
  }
  const questionCount = Number(
    input.questionCount ?? (Array.isArray(input.questions) ? input.questions.length : 0),
  );
  if (!Number.isInteger(questionCount) || questionCount < 1) {
    throw new HttpError(
      400,
      'on-chain elections require at least one question (ElectionFactory questionCount >= 1)',
      { code: 'QUESTION_COUNT' },
    );
  }
  return {
    title: String(input.title),
    metadataURI: String(input.metadataURI || ''),
    startTime: input.startTime,
    cutoffTime: input.cutoffTime,
    maxParticipants: Number(input.maxParticipants ?? 0),
    treeDepth: Number(input.treeDepth),
    ballotSpecHash: input.ballotSpecHash,
    clerk,
    registrar,
    disqualificationOfficer,
    tallyOperator,
    verifier,
    questionCount,
    jurisdictionId: toJurisdictionBytes32(input.jurisdictionId),
    tallyPubKeyX: input.tallyPubKeyX || `0x${'00'.repeat(32)}`,
    tallyPubKeyY: input.tallyPubKeyY || `0x${'00'.repeat(32)}`,
    tallyScheme:
      input.tallyScheme === 'opens_ballots' || input.tallyScheme === 1 || input.tallyScheme === '1'
        ? 1
        : Number(input.tallyScheme || 0) || 0,
    electionType:
      input.electionType === 'VOTE' || input.electionType === 1 || input.electionType === '1' ? 1 : 0,
  };
}

/**
 * Factory tuple builder. electionType is appended as the last component
 * while PASS_ELECTION_TYPE_ON_CHAIN is true.
 */
export function factoryElectionParams(params, electionType) {
  const tuple = {
    title: params.title,
    metadataURI: params.metadataURI,
    startTime: params.startTime,
    cutoffTime: params.cutoffTime,
    maxParticipants: params.maxParticipants,
    treeDepth: params.treeDepth,
    ballotSpecHash: params.ballotSpecHash,
    clerk: params.clerk,
    registrar: params.registrar,
    disqualificationOfficer: params.disqualificationOfficer,
    tallyOperator: params.tallyOperator,
    verifier: params.verifier,
    questionCount: params.questionCount,
    jurisdictionId: params.jurisdictionId,
    tallyPubKeyX: params.tallyPubKeyX,
    tallyPubKeyY: params.tallyPubKeyY,
    tallyScheme: params.tallyScheme,
  };
  if (PASS_ELECTION_TYPE_ON_CHAIN) {
    tuple.electionType = Number(electionType) || 0;
  }
  return tuple;
}

/** Decimal string, so a hex nullifier and its bigint match. */
function nullifierKey(value) {
  try {
    return BigInt(value).toString();
  } catch {
    return String(value);
  }
}

function errorText(err) {
  return err?.extra?.code || err?.code || err?.message || String(err);
}

/** An isolated row that reverts this many times is dead-lettered. Transport errors do not count. */
const FLUSH_RETRY_CAP = 3;
/** A broadcast whose receipt never arrives is reconciled after this long. */
const RECEIPT_TIMEOUT_SECONDS = 10 * 60;
const TRANSPORT_BACKOFF_SECONDS = 30;
const TRANSPORT_BACKOFF_CAP_SECONDS = 15 * 60;
/** Wait between retries of one reverting row. A bisect does not wait. */
export const REVERT_RETRY_BACKOFF_SECONDS = 30;

/**
 * A contract revert counts toward the cap. Timeouts, RPC failures, and nonce
 * errors stay queued. Unknown failures stay queued too: an outage must not
 * drop ballots the node already accepted.
 */
function failureKind(err) {
  if (err?.revert === true || err?.extra?.revert === true || err?.cause?.revert === true) return 'revert';
  if (err?.transport === true || err?.extra?.transport === true) return 'transport';
  const name = `${err?.name || ''} ${err?.cause?.name || ''}`;
  const msg = `${err?.shortMessage || ''} ${err?.details || ''} ${err?.message || ''} ${err?.cause?.shortMessage || ''} ${err?.cause?.message || ''}`.toLowerCase();
  if (
    err?.extra?.code === 'CHAIN_REVERT' ||
    name.includes('Revert') ||
    msg.includes('execution reverted') ||
    msg.includes('contractfunctionreverted')
  ) {
    return 'revert';
  }
  return 'transport';
}

/** True when a ranking hash is present but not a non-zero 32-byte hex value. */
export function isBadRankingHash(value) {
  if (value == null || value === '') return false;
  const h = String(value).toLowerCase();
  return !/^0x[0-9a-f]{64}$/.test(h) || /^0x0+$/.test(h);
}

function assertRankingHashOk(rankingHash) {
  if (isBadRankingHash(rankingHash)) {
    throw new HttpError(400, 'rankingHash must be a non-zero 32-byte hex value', { code: 'BAD_RANKING_HASH' });
  }
}

/**
 * Ranking hashes of a batch, ascending (the inbox requires strict order).
 * Rows without a ranking are fine. A malformed or zero hash is never dropped
 * silently: it throws BAD_RANKING_HASH so the batch stays queued and is flagged
 * instead of landing ballots without their rankings.
 */
export function sortedRankingHashes(batch) {
  const out = [];
  const bad = [];
  for (const row of batch || []) {
    if (row?.rankingHash == null || row.rankingHash === '') continue;
    const h = String(row.rankingHash).toLowerCase();
    if (isBadRankingHash(h)) {
      bad.push(row?.nullifier != null ? String(row.nullifier) : null);
      continue;
    }
    out.push(h);
  }
  if (bad.length) {
    const err = new Error(`BAD_RANKING_HASH: ${bad.length} malformed ranking hash(es) in batch`);
    err.code = 'BAD_RANKING_HASH';
    err.nullifiers = bad;
    throw err;
  }
  out.sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : BigInt(x) > BigInt(y) ? 1 : 0));
  return out.filter((h, i) => i === 0 || h !== out[i - 1]);
}

const RANKED_BATCH_GAS_DEFAULT = 24_000_000n;
const RANKED_BATCH_GAS_CEILING = 200_000_000n;

/** Gas for a ranked batch: RANKED_BATCH_GAS (default 24M), capped at 200M. */
export function rankedBatchGas(config = {}) {
  let gas = RANKED_BATCH_GAS_DEFAULT;
  try {
    if (config.rankedBatchGas != null && config.rankedBatchGas !== '') gas = BigInt(config.rankedBatchGas);
  } catch {
    gas = RANKED_BATCH_GAS_DEFAULT;
  }
  if (gas <= 0n) gas = RANKED_BATCH_GAS_DEFAULT;
  return gas > RANKED_BATCH_GAS_CEILING ? RANKED_BATCH_GAS_CEILING : gas;
}

function rowToStored(electionKey, row) {
  return {
    electionKey,
    nullifier: nullifierKey(row.nullifier),
    a: row.a.map((n) => n.toString()),
    b: row.b.map((pair) => pair.map((n) => n.toString())),
    c: row.c.map((n) => n.toString()),
    inputs: row.inputs.map((n) => n.toString()),
    encryptedBallot: row.encryptedBallot,
    ...(row.rankingHash ? { rankingHash: String(row.rankingHash) } : {}),
    startTime: row.startTime ?? 0,
    cutoffTime: row.cutoffTime ?? null,
    ...(Number(row.replayedAfterCutoffAt) > 0
      ? { replayedAfterCutoffAt: Math.floor(Number(row.replayedAfterCutoffAt)) }
      : {}),
  };
}

function storedToRow(stored) {
  return {
    nullifier: BigInt(stored.nullifier),
    a: stored.a.map((n) => BigInt(n)),
    b: stored.b.map((pair) => pair.map((n) => BigInt(n))),
    c: stored.c.map((n) => BigInt(n)),
    inputs: stored.inputs.map((n) => BigInt(n)),
    encryptedBallot: stored.encryptedBallot,
    ...(stored.rankingHash ? { rankingHash: String(stored.rankingHash) } : {}),
    startTime: stored.startTime ?? 0,
    cutoffTime: stored.cutoffTime ?? null,
    ...(Number(stored.replayedAfterCutoffAt) > 0
      ? { replayedAfterCutoffAt: Math.floor(Number(stored.replayedAfterCutoffAt)) }
      : {}),
  };
}

export function createChain(config, extras = {}) {
  const rpc = config.chainRpc;
  let key = config.relayerPrivateKey || '';
  if (key && !key.startsWith('0x')) key = `0x${key}`;

  const injectedBatch = typeof extras.writeSubmitBatch === 'function';
  const configured = Boolean(rpc) || injectedBatch;
  const hasWallet = Boolean(rpc && key) || injectedBatch;
  const factoryAddress = () => config.electionFactoryAddress || '';
  const inboxAddress = () => config.ballotInboxAddress || '';
  const queueStore = extras.queueStore || null;

  let wallet;
  let publicClient;
  let account;
  const voteQueue = new Map();
  const lastBatchAt = new Map();
  const flushing = new Set();
  const inFlight = new Map();
  const attempts = new Map();
  const deadLetter = [];
  const supplementary = [];
  const backoffUntil = new Map();
  const splitLimit = new Map();
  const transportStrikes = new Map();
  const alerts = [];

  if (rpc && key) {
    const chain = zkVotingChain(config.chainId, rpc);
    account = privateKeyToAccount(key);
    publicClient = createPublicClient({ chain, transport: http(rpc) });
    wallet = createWalletClient({ account, chain, transport: http(rpc) });
  }

  function loadQueue() {
    voteQueue.clear();
    lastBatchAt.clear();
    inFlight.clear();
    attempts.clear();
    deadLetter.length = 0;
    supplementary.length = 0;
    if (!queueStore || typeof queueStore.loadChainVoteQueue !== 'function') return;
    const loaded = queueStore.loadChainVoteQueue() || {};
    for (const stored of loaded.rows || []) {
      if (!stored || stored.electionKey == null) continue;
      const id = String(stored.electionKey);
      const list = voteQueue.get(id) || [];
      list.push(storedToRow(stored));
      voteQueue.set(id, list);
    }
    const batchAt = loaded.batchAt && typeof loaded.batchAt === 'object' ? loaded.batchAt : {};
    for (const [id, at] of Object.entries(batchAt)) {
      lastBatchAt.set(id, Number(at) || 0);
    }
    const markers = loaded.inFlight && typeof loaded.inFlight === 'object' ? loaded.inFlight : {};
    for (const [id, marker] of Object.entries(markers)) {
      if (!marker || typeof marker !== 'object') continue;
      inFlight.set(String(id), {
        txHash: marker.txHash ? String(marker.txHash) : null,
        nullifiers: Array.isArray(marker.nullifiers) ? marker.nullifiers.map((n) => String(n)) : [],
        sentAt: Number(marker.sentAt) || 0,
      });
    }
    const savedAttempts = loaded.attempts && typeof loaded.attempts === 'object' ? loaded.attempts : {};
    for (const [id, n] of Object.entries(savedAttempts)) {
      // Per-row keys only. An old per-election counter must not retire a new ballot.
      if (!String(id).includes(':')) continue;
      const num = Number(n);
      if (Number.isFinite(num) && num > 0) attempts.set(String(id), Math.floor(num));
    }
    if (Array.isArray(loaded.deadLetter)) deadLetter.push(...loaded.deadLetter);
    if (Array.isArray(loaded.supplementary)) supplementary.push(...loaded.supplementary);
    const savedBackoff = loaded.backoffUntil && typeof loaded.backoffUntil === 'object' ? loaded.backoffUntil : {};
    for (const [id, at] of Object.entries(savedBackoff)) {
      const num = Number(at);
      if (Number.isFinite(num) && num > 0) backoffUntil.set(String(id), Math.floor(num));
    }
    const savedSplit = loaded.splitLimit && typeof loaded.splitLimit === 'object' ? loaded.splitLimit : {};
    for (const [id, n] of Object.entries(savedSplit)) {
      const num = Number(n);
      if (Number.isFinite(num) && num > 0 && num < 64) splitLimit.set(String(id), Math.floor(num));
    }
    const savedStrikes = loaded.transportStrikes && typeof loaded.transportStrikes === 'object' ? loaded.transportStrikes : {};
    for (const [id, n] of Object.entries(savedStrikes)) {
      const num = Number(n);
      if (Number.isFinite(num) && num > 0) transportStrikes.set(String(id), Math.floor(num));
    }
    if (Array.isArray(loaded.alerts)) alerts.push(...loaded.alerts.filter((item) => item && typeof item === 'object'));
  }

  async function persistQueue() {
    if (!queueStore || typeof queueStore.saveChainVoteQueue !== 'function') return;
    const rows = [];
    for (const [id, list] of voteQueue) {
      for (const row of list) rows.push(rowToStored(id, row));
    }
    const batchAt = {};
    for (const [id, at] of lastBatchAt) batchAt[id] = at;
    const markers = {};
    for (const [id, marker] of inFlight) markers[id] = marker;
    const attemptDoc = {};
    for (const [id, n] of attempts) attemptDoc[id] = n;
    const backoffDoc = {};
    for (const [id, at] of backoffUntil) backoffDoc[id] = at;
    const splitDoc = {};
    for (const [id, n] of splitLimit) splitDoc[id] = n;
    const strikeDoc = {};
    for (const [id, n] of transportStrikes) strikeDoc[id] = n;
    await queueStore.saveChainVoteQueue({
      rows,
      batchAt,
      inFlight: markers,
      deadLetter: deadLetter.slice(),
      supplementary: supplementary.slice(),
      attempts: attemptDoc,
      backoffUntil: backoffDoc,
      splitLimit: splitDoc,
      transportStrikes: strikeDoc,
      alerts: alerts.slice(-20),
    });
  }

  loadQueue();

  async function writeSubmitVote({ inbox, electionId, a, b, c, inputs, encryptedBallot }) {
    try {
      const hash = await wallet.writeContract({
        address: inbox,
        abi: ballotInboxAbi,
        functionName: 'submitVote',
        args: [asBigInt(electionId), a, b, c, inputs, encryptedBallot],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      return { hash, receipt, batched: false };
    } catch (err) {
      throw new HttpError(502, `BallotInbox submitVote failed: ${err.message || err}`, {
        code: 'CHAIN_VOTE_FAILED',
      });
    }
  }

  function classifiedBatchError(err) {
    const kind = failureKind(err);
    return new HttpError(502, `BallotInbox submitVoteBatch failed: ${err.message || err}`, {
      code: kind === 'revert' ? 'CHAIN_REVERT' : 'CHAIN_VOTE_FAILED',
      revert: kind === 'revert',
      transport: kind !== 'revert',
    });
  }

  async function writeSubmitBatch({ inbox, electionId, batch, onHash }) {
    if (injectedBatch) return extras.writeSubmitBatch({ inbox, electionId, batch, onHash });
    let hash;
    // Sealed ranked-choice: the batch carries its ranking hashes, sorted so
    // calldata order does not line up with ballot (nullifier) order.
    const rankingHashes = sortedRankingHashes(batch);
    const args = [
      asBigInt(electionId),
      batch.map((row) => row.a),
      batch.map((row) => row.b),
      batch.map((row) => row.c),
      batch.map((row) => row.inputs),
      batch.map((row) => row.encryptedBallot),
    ];
    try {
      hash = await wallet.writeContract({
        address: inbox,
        abi: ballotInboxAbi,
        functionName: rankingHashes.length ? 'submitVoteBatchRanked' : 'submitVoteBatch',
        args: rankingHashes.length ? [...args, rankingHashes] : args,
        ...(rankingHashes.length ? { gas: rankedBatchGas(config) } : {}),
      });
    } catch (err) {
      throw classifiedBatchError(err);
    }
    // The hash is durable before the receipt wait, so a crash in the mempool
    // does not send the same nullifiers again.
    if (typeof onHash === 'function') await onHash(hash);
    try {
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt && receipt.status && receipt.status !== 'success') {
        const reverted = new Error('execution reverted');
        reverted.revert = true;
        throw reverted;
      }
      return { hash, receipt, batched: true, count: batch.length };
    } catch (err) {
      const wrapped = classifiedBatchError(err);
      wrapped.extra.txHash = hash ? String(hash) : null;
      throw wrapped;
    }
  }

  function queuedCutoff(rows) {
    for (const row of rows) {
      const end = Number(row?.cutoffTime);
      if (Number.isFinite(end)) return end;
    }
    return null;
  }

  function dropNullifiers(key, nullifiers) {
    const drop = new Set((nullifiers || []).map((n) => nullifierKey(n)));
    const queued = voteQueue.get(key) || [];
    const left = queued.filter((row) => !drop.has(nullifierKey(row.nullifier)));
    if (left.length) voteQueue.set(key, left);
    else voteQueue.delete(key);
    return left.length;
  }

  function attemptKey(electionKey, nullifier) {
    return `${electionKey}:${nullifierKey(nullifier)}`;
  }

  function pushAlert(alert) {
    alerts.push(alert);
    if (alerts.length > 20) alerts.splice(0, alerts.length - 20);
  }

  function revertBackoffKey(electionKey, nullifier) {
    return `row:${attemptKey(electionKey, nullifier)}`;
  }

  /**
   * The wait is per ballot. One reverting row does not hold the rest of the
   * election, including the final batch. Transport backoff stays on the
   * election key because an RPC failure applies to every row.
   */
  function rememberRevertRetry(electionKey, nullifier, err, now) {
    const at = Number(now) || Math.floor(Date.now() / 1000);
    backoffUntil.set(revertBackoffKey(electionKey, nullifier), at + REVERT_RETRY_BACKOFF_SECONDS);
    pushAlert({
      kind: 'chain_revert_retry',
      electionKey,
      nullifier: nullifierKey(nullifier),
      error: errorText(err),
      at,
    });
  }

  function revertBackoffActive(electionKey, nullifier, now) {
    const until = backoffUntil.get(revertBackoffKey(electionKey, nullifier)) || 0;
    return until > Number(now);
  }

  function releaseSupplementary(key, nullifiers) {
    const drop = new Set((nullifiers || []).map((n) => nullifierKey(n)));
    if (!drop.size || !supplementary.length) return;
    const still = supplementary.filter(
      (item) => !(String(item.electionKey) === String(key) && drop.has(nullifierKey(item.nullifier))),
    );
    if (still.length === supplementary.length) return;
    supplementary.length = 0;
    supplementary.push(...still);
  }

  /** Drop the local proof copy and any supplementary hold once the inbox has the nullifier. */
  async function forgetMined(key, nullifiers) {
    releaseSupplementary(key, nullifiers);
    if (!nullifiers?.length || typeof queueStore?.dropChainBallotPayloads !== 'function') return;
    try {
      await queueStore.dropChainBallotPayloads(key, nullifiers);
    } catch (err) {
      if (!config.quiet) {
        console.warn(`could not drop a mined ballot payload: ${errorText(err)}`);
      }
    }
  }

  /** RPC/transport: keep every row queued, back off, and alert. Never dead-letter. */
  function rememberTransport(key, err, now) {
    const strikes = (transportStrikes.get(key) || 0) + 1;
    transportStrikes.set(key, strikes);
    const delay = Math.min(TRANSPORT_BACKOFF_CAP_SECONDS, TRANSPORT_BACKOFF_SECONDS * 2 ** Math.min(strikes - 1, 8));
    const at = Number(now) || Math.floor(Date.now() / 1000);
    backoffUntil.set(key, at + delay);
    pushAlert({ kind: 'chain_transport', electionKey: key, error: errorText(err), at });
    if (!config.quiet) {
      console.warn(`[zk-voting] vote batch for election ${key} stays queued after a transport error: ${errorText(err)}`);
    }
  }

  function deadLetterRow(key, row, err, at, kind = 'chain_dead_letter') {
    const id = nullifierKey(row.nullifier);
    attempts.delete(attemptKey(key, id));
    const letter = {
      electionKey: key,
      nullifier: id,
      error: errorText(err),
      at,
      row: rowToStored(key, row),
    };
    // A replay after the deadline that fails again may be excluded.
    const replayed = Number(row.replayedAfterCutoffAt);
    if (Number.isFinite(replayed) && replayed > 0) letter.replayFailedAt = Math.floor(Number(at) || replayed);
    deadLetter.push(letter);
    dropNullifiers(key, [row.nullifier]);
    backoffUntil.delete(revertBackoffKey(key, row.nullifier));
    splitLimit.delete(key);
    pushAlert({ kind, electionKey: key, nullifier: id, error: errorText(err), at });
    if (kind !== 'chain_dead_letter') letter.kind = kind;
    if (!config.quiet) {
      console.warn(`[zk-voting] isolated ballot ${id} for election ${key} moved to the dead letter: ${errorText(err)}`);
    }
  }

  async function receiptStatus(marker) {
    if (typeof extras.settleInFlight === 'function') {
      const status = await extras.settleInFlight(marker);
      if (status === 'mined' || status === 'reverted' || status === 'unknown') return status;
      return 'unknown';
    }
    if (!publicClient || !marker?.txHash) return 'unknown';
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash: marker.txHash });
      if (!receipt) return 'unknown';
      return receipt.status === 'success' ? 'mined' : 'reverted';
    } catch {
      return 'unknown';
    }
  }

  async function isNullifierSpent(electionId, nullifier) {
    if (typeof extras.nullifierSpent === 'function') {
      const spent = await extras.nullifierSpent(electionId, nullifier);
      return spent == null ? null : Boolean(spent);
    }
    const inbox = inboxAddress();
    if (!publicClient || !inbox) return null;
    try {
      const used = await publicClient.readContract({
        address: inbox,
        abi: ballotInboxAbi,
        functionName: 'nullifierUsed',
        args: [asBigInt(electionId), asBigInt(nullifier)],
      });
      return Boolean(used);
    } catch {
      return null;
    }
  }

  function clearAttempts(key, nullifiers) {
    for (const n of nullifiers || []) attempts.delete(attemptKey(key, n));
  }

  async function spentMap(key, batch) {
    const map = new Map();
    for (const row of batch) {
      const flag = await isNullifierSpent(key, row.nullifier);
      if (flag == null) return { unknown: true, map };
      map.set(nullifierKey(row.nullifier), Boolean(flag));
    }
    return { unknown: false, map };
  }

  /**
   * A crash after the transaction mines leaves the marker and the rows.
   * A known receipt or a spent nullifier drops them. An unknown receipt
   * stays put until sentAt times out, then the spent-nullifier check
   * decides whether to resend.
   * @returns {'ready'|'pending'}
   */
  async function settleMarker(key, now) {
    const marker = inFlight.get(key);
    if (!marker) return 'ready';
    const nullifiers = marker.nullifiers || [];
    const at = Number(now) || Math.floor(Date.now() / 1000);
    const timeout = Number(extras.receiptTimeoutSeconds ?? config.chainReceiptTimeoutSeconds ?? RECEIPT_TIMEOUT_SECONDS);
    if (marker.txHash) {
      const status = await receiptStatus(marker);
      if (status === 'unknown') {
        const sentAt = Number(marker.sentAt) || 0;
        if (!sentAt || at - sentAt < timeout) return 'pending';
        const flags = await spentMap(key, nullifiers.map((n) => ({ nullifier: n })));
        if (flags.unknown) return 'pending';
        const spent = [];
        for (const [id, flag] of flags.map) if (flag) spent.push(id);
        if (spent.length) {
          dropNullifiers(key, spent);
          await forgetMined(key, spent);
        }
        inFlight.delete(key);
        if (spent.length === nullifiers.length) clearAttempts(key, nullifiers);
        await persistQueue();
        return 'ready';
      }
      if (status === 'mined') {
        dropNullifiers(key, nullifiers);
        clearAttempts(key, nullifiers);
        await forgetMined(key, nullifiers);
      }
      inFlight.delete(key);
      await persistQueue();
      return 'ready';
    }
    const spent = [];
    for (const n of nullifiers) {
      const flag = await isNullifierSpent(key, n);
      if (flag == null) return 'pending';
      if (flag) spent.push(n);
    }
    if (spent.length) {
      dropNullifiers(key, spent);
      await forgetMined(key, spent);
    }
    inFlight.delete(key);
    if (spent.length === nullifiers.length) clearAttempts(key, nullifiers);
    await persistQueue();
    return 'ready';
  }

  /**
   * On a revert, drop nullifiers the inbox already spent and bisect the rest.
   * Only a row that reverts alone FLUSH_RETRY_CAP times is dead-lettered.
   * @returns {{action: 'pending'|'transport'|'delivered'|'split'|'dead', error?: string, nullifier?: string}}
   */
  async function handleFlushError(key, batch, err, now) {
    const at = Number(now) || Math.floor(Date.now() / 1000);
    if (err?.code === 'BAD_RANKING_HASH') {
      // Nothing was broadcast. Quarantine only the malformed rows (found from
      // the batch itself, so a row without a nullifier is still caught) and let
      // the rest of the batch, and the final batch, flush. Never retried.
      inFlight.delete(key);
      const listed = new Set((err.nullifiers || []).filter((n) => n != null).map((n) => String(n)));
      const bad = batch.filter(
        (row) => isBadRankingHash(row?.rankingHash) || (row?.nullifier != null && listed.has(nullifierKey(row.nullifier))),
      );
      if (!bad.length) {
        rememberTransport(key, err, at);
        return { action: 'transport' };
      }
      for (const row of bad) {
        if (row?.nullifier == null) {
          const queued = voteQueue.get(key) || [];
          const left = queued.filter((q) => q !== row);
          if (left.length) voteQueue.set(key, left);
          else voteQueue.delete(key);
          deadLetter.push({ electionKey: key, nullifier: null, kind: 'bad_ranking_hash', error: errorText(err), at });
          pushAlert({ kind: 'bad_ranking_hash', electionKey: key, nullifier: null, error: errorText(err), at });
          continue;
        }
        deadLetterRow(key, row, err, at, 'bad_ranking_hash');
      }
      return { action: 'dead', error: errorText(err), nullifier: bad[0]?.nullifier != null ? nullifierKey(bad[0].nullifier) : null };
    }
    const kind = failureKind(err);
    const marker = inFlight.get(key);
    const flags = await spentMap(key, batch);
    if (flags.unknown) {
      if (marker?.txHash) return { action: 'pending' };
      rememberTransport(key, err, at);
      inFlight.delete(key);
      return { action: 'transport' };
    }
    const spent = [];
    const unspent = [];
    for (const row of batch) {
      if (flags.map.get(nullifierKey(row.nullifier))) spent.push(row);
      else unspent.push(row);
    }
    if (spent.length) {
      dropNullifiers(key, spent.map((row) => row.nullifier));
      await forgetMined(key, spent.map((row) => row.nullifier));
    }
    if (!unspent.length) {
      inFlight.delete(key);
      clearAttempts(key, batch.map((row) => row.nullifier));
      backoffUntil.delete(key);
      return { action: 'delivered' };
    }
    if (kind !== 'revert') {
      if (marker?.txHash) return { action: 'pending' };
      inFlight.delete(key);
      rememberTransport(key, err, at);
      return { action: 'transport' };
    }
    inFlight.delete(key);
    if (unspent.length === 1 && batch.length === 1) {
      const row = unspent[0];
      const id = nullifierKey(row.nullifier);
      const next = (attempts.get(attemptKey(key, id)) || 0) + 1;
      if (next >= FLUSH_RETRY_CAP) {
        deadLetterRow(key, row, err, at);
        return { action: 'dead', error: errorText(err), nullifier: id };
      }
      attempts.set(attemptKey(key, id), next);
      rememberRevertRetry(key, id, err, at);
      return { action: 'backoff' };
    }
    splitLimit.set(key, Math.max(1, Math.ceil(unspent.length / 2)));
    return { action: 'split' };
  }

  async function flushElection(key, now) {
    if (flushing.has(key)) return { queued: true, inFlight: true };
    flushing.add(key);
    try {
      const at = now ?? config.nowFn?.() ?? Math.floor(Date.now() / 1000);
      if ((await settleMarker(key, at)) === 'pending') {
        return { queued: true, inFlight: true, pending: true };
      }
      const until = backoffUntil.get(key) || 0;
      if (until > at) {
        return { queued: true, submitted: false, backoff: true, waiting: (voteQueue.get(key) || []).length };
      }
      let first = null;
      for (;;) {
        const queuedAll = voteQueue.get(key) || [];
        if (!queuedAll.length) return first || { queued: false };
        const ready = queuedAll.filter((row) => !revertBackoffActive(key, row.nullifier, at));
        if (!ready.length) {
          const payload = { queued: true, submitted: false, backoff: true, waiting: queuedAll.length };
          if (!first) return payload;
          first.backoff = true;
          return first;
        }
        const interval = Number(config.disclosureIntervalSeconds) || 0;
        const isolating = splitLimit.has(key);
        const plan = planDisclosureBatch({
          pending: ready,
          interval,
          now: at,
          startTime: ready[0].startTime,
          lastBatchAt: isolating ? 0 : lastBatchAt.get(key) || 0,
          cutoffTime: queuedCutoff(ready),
        });
        if (!isolating && (plan.action === 'wait' || plan.batch.length === 0)) {
          return first || { queued: true, submitted: false, waiting: queuedAll.length };
        }
        if (plan.batch.length === 0) return first || { queued: true, submitted: false, waiting: queuedAll.length };
        const cap = splitLimit.get(key) || 64;
        const batch = plan.batch.slice(0, cap);
        const nullifiers = batch.map((row) => nullifierKey(row.nullifier));
        inFlight.set(key, { txHash: null, nullifiers, sentAt: at });
        await persistQueue();
        let result;
        try {
          result = await writeSubmitBatch({
            inbox: inboxAddress(),
            electionId: key,
            batch,
            onHash: async (hash) => {
              inFlight.set(key, { txHash: hash ? String(hash) : null, nullifiers, sentAt: at });
              await persistQueue();
            },
          });
        } catch (err) {
          const outcome = await handleFlushError(key, batch, err, at);
          await persistQueue();
          if (outcome.action === 'pending') {
            const payload = { queued: true, pending: true, inFlight: true };
            if (!first) first = payload;
            return first;
          }
          if (outcome.action === 'transport') throw err;
          if (outcome.action === 'backoff') continue;
          if (outcome.action === 'dead') {
            const payload = { deadLetter: true, error: outcome.error, nullifier: outcome.nullifier };
            if (!first) first = payload;
            else first.continued = payload;
            continue;
          }
          continue;
        }
        const fresh = voteQueue.get(key) || [];
        const sent = new Set(batch);
        const left = fresh.filter((row) => !sent.has(row));
        if (left.length) voteQueue.set(key, left);
        else voteQueue.delete(key);
        inFlight.delete(key);
        clearAttempts(key, nullifiers);
        await forgetMined(key, nullifiers);
        for (const n of nullifiers) backoffUntil.delete(revertBackoffKey(key, n));
        backoffUntil.delete(key);
        transportStrikes.delete(key);
        const currentCap = splitLimit.get(key);
        if (currentCap && currentCap < 64) splitLimit.set(key, Math.min(64, currentCap * 2));
        if ((splitLimit.get(key) || 64) >= 64) splitLimit.delete(key);
        const stillIsolating = splitLimit.has(key);
        if (!stillIsolating) lastBatchAt.set(key, Number(at));
        await persistQueue();
        const payload = plan.action === 'final' ? { ...result, final: true } : result;
        if (!first) first = payload;
        else first.continued = payload;
        // The batch ABI takes 64 ballots. A deadline, or a bisect, drains the rest in this lock.
        if ((plan.action === 'final' || stillIsolating) && left.length) continue;
        return first;
      }
    } finally {
      flushing.delete(key);
    }
  }

  return {
    configured,
    get ready() {
      return Boolean(hasWallet && inboxAddress());
    },
    account,
    isConfigured() {
      return configured;
    },
    isReady() {
      return Boolean(hasWallet && inboxAddress());
    },
    isFactoryReady() {
      return Boolean(hasWallet && factoryAddress());
    },
    /**
     * @returns {Promise<null|{onChainElectionId: string, onChainElectionAddress: string|null, createTxHash: string|null, factoryAddress: string, chainId: number, params: object}>}
     */
    async createElection(input) {
      if (!configured) return null;
      if (!hasWallet) {
        throw new HttpError(503, 'CHAIN_RPC is set but RELAYER_PRIVATE_KEY is missing', {
          code: 'CHAIN_NOT_READY',
        });
      }
      const factoryAddr = factoryAddress();
      if (!factoryAddr) {
        throw new HttpError(
          503,
          'CHAIN_RPC is set but ELECTION_FACTORY_ADDRESS is missing. Deploy once, then pin the shared factory on this Node (env or /office/site). Do not deploy a new factory per jurisdiction fork.',
          { code: 'CHAIN_NOT_READY' },
        );
      }
      const params = factoryElectionParams(
        resolveCreateElectionParams(config, input, account.address),
        input.electionType,
      );
      try {
        const viemParams = {
          ...params,
          startTime: asBigInt(params.startTime),
          cutoffTime: asBigInt(params.cutoffTime),
        };
        let hash;
        let simulated = null;
        const sim = await publicClient.simulateContract({
          address: getAddress(factoryAddr),
          abi: electionFactoryAbi,
          functionName: 'createElection',
          args: [viemParams],
          account,
        });
        simulated = sim.result;
        hash = await wallet.writeContract(sim.request);
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        const fromSim = unpackCreateResult(simulated);
        const decoded = decodeElectionCreated(receipt);
        const electionId = fromSim.electionId ?? decoded.electionId;
        const election = fromSim.election ?? decoded.election;
        if (electionId == null || electionId === '') {
          throw new Error('factory transaction did not return electionId (no ElectionCreated log)');
        }
        return {
          onChainElectionId: String(electionId),
          onChainElectionAddress: election ? getAddress(election) : null,
          createTxHash: hash || null,
          factoryAddress: getAddress(factoryAddr),
          chainId: config.chainId,
          params,
        };
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(502, `ElectionFactory createElection failed: ${err.message || err}`, {
          code: 'CHAIN_CREATE_FAILED',
        });
      }
    },
    async submitVote({ electionId, proof, publicInputs, encryptedBallot, rankingHash, startTime, cutoffTime, now }) {
      if (!configured) return null;
      const inbox = inboxAddress();
      if (!hasWallet || !inbox) {
        throw new HttpError(
          503,
          'CHAIN_RPC is set but BALLOT_INBOX_ADDRESS or RELAYER_PRIVATE_KEY is missing',
          { code: 'CHAIN_NOT_READY' },
        );
      }
      assertRankingHashOk(rankingHash);
      const interval = Number(config.disclosureIntervalSeconds) || 0;
      const key = String(electionId);
      const { a, b, c } = groth16Points(proof);
      const inputs = publicInputs.map((x) => asBigInt(x));
      const nullifier = inputs[2];
      if (interval <= 0) {
        if (rankingHash) {
          // A ranked ballot always goes through the batch path so its ranking
          // hash is accepted in the same transaction as the ballot.
          return writeSubmitBatch({
            inbox,
            electionId,
            batch: [{ nullifier, a, b, c, inputs, encryptedBallot, rankingHash }],
          });
        }
        return writeSubmitVote({ inbox, electionId, a, b, c, inputs, encryptedBallot });
      }
      const queued = voteQueue.get(key) || [];
      if (queued.some((row) => nullifierKey(row.nullifier) === nullifierKey(nullifier))) {
        return { queued: true, submitted: false, duplicate: true };
      }
      queued.push({
        nullifier,
        a,
        b,
        c,
        inputs,
        encryptedBallot,
        ...(rankingHash ? { rankingHash } : {}),
        startTime: startTime ?? 0,
        cutoffTime: cutoffTime ?? null,
      });
      voteQueue.set(key, queued);
      await persistQueue();
      // The writer timer flushes. This request does not, so a failed batch
      // cannot leave a second copy of the same nullifier in the queue.
      return { queued: true, submitted: false };
    },
    /**
     * Queue, in-flight, spent, or an existing chain record. A repair may
     * enqueue only when every one of these is false.
     */
    async nullifierChainState(electionId, nullifier) {
      const key = String(electionId);
      const id = nullifierKey(nullifier);
      const queued = (voteQueue.get(key) || []).some((row) => nullifierKey(row.nullifier) === id);
      const marker = inFlight.get(key);
      const inFlightRow = Boolean(marker && (marker.nullifiers || []).some((n) => nullifierKey(n) === id));
      const lettered = deadLetter.some(
        (item) => String(item.electionKey) === key && nullifierKey(item.nullifier) === id,
      );
      const flag = await isNullifierSpent(key, nullifier);
      return {
        queued,
        inFlight: inFlightRow,
        spent: flag === true,
        spentKnown: flag != null,
        chainRecord: Boolean((marker?.txHash && inFlightRow) || lettered),
        deadLetter: lettered,
      };
    },
    /**
     * A duplicate enqueue keeps this request's row. An in-flight broadcast
     * is left alone so the caller can retry without deleting the stored ballot.
     */
    async replaceQueuedVote({ electionId, proof, publicInputs, encryptedBallot, rankingHash, startTime, cutoffTime }) {
      assertRankingHashOk(rankingHash);
      const key = String(electionId);
      const { a, b, c } = groth16Points(proof);
      const inputs = (publicInputs || []).map((x) => asBigInt(x));
      const id = nullifierKey(inputs[2]);
      const marker = inFlight.get(key);
      if (marker && (marker.nullifiers || []).some((n) => nullifierKey(n) === id)) {
        return { replaced: false, inFlight: true };
      }
      const queued = voteQueue.get(key) || [];
      const idx = queued.findIndex((row) => nullifierKey(row.nullifier) === id);
      if (idx === -1) return { replaced: false, missing: true };
      queued[idx] = {
        nullifier: inputs[2],
        a,
        b,
        c,
        inputs,
        encryptedBallot,
        ...(rankingHash ? { rankingHash } : {}),
        startTime: startTime ?? 0,
        cutoffTime: cutoffTime ?? null,
      };
      voteQueue.set(key, queued);
      await persistQueue();
      return { replaced: true };
    },
    deadLettersFor(electionId) {
      const key = String(electionId);
      return deadLetter
        .filter((item) => String(item.electionKey) === key)
        .map((item) => ({
          electionKey: item.electionKey,
          nullifier: item.nullifier,
          error: item.error,
          at: item.at,
          replayFailedAt: item.replayFailedAt || null,
        }));
    },
    /** Writer puts one dead-lettered row, or every row for the election, back on the queue. */
    async replayDeadLetter(electionId, nullifier, { now, cutoffTime } = {}) {
      const key = String(electionId);
      const id = nullifier == null || nullifier === '' ? null : nullifierKey(nullifier);
      const kept = [];
      let restored = 0;
      for (const item of deadLetter) {
        if (String(item.electionKey) !== key || (id && nullifierKey(item.nullifier) !== id)) {
          kept.push(item);
          continue;
        }
        let putBack = false;
        try {
          if (item.row) {
            const list = voteQueue.get(key) || [];
            const row = storedToRow(item.row);
            if (row && row.nullifier != null) {
              const at = Number(now);
              const end = Number(cutoffTime);
              if (Number.isFinite(at) && Number.isFinite(end) && at >= end) {
                row.replayedAfterCutoffAt = Math.floor(at);
              }
              if (!list.some((queued) => nullifierKey(queued.nullifier) === nullifierKey(row.nullifier))) {
                list.push(row);
                voteQueue.set(key, list);
              } else {
                const queued = list.find((item) => nullifierKey(item.nullifier) === nullifierKey(row.nullifier));
                if (queued && row.replayedAfterCutoffAt) queued.replayedAfterCutoffAt = row.replayedAfterCutoffAt;
              }
              attempts.delete(attemptKey(key, row.nullifier));
              putBack = true;
              restored += 1;
            }
          }
        } catch {
          putBack = false;
        }
        // A row we cannot queue stays dead-lettered so the tally stays blocked.
        if (!putBack) {
          const at = Number(now);
          const end = Number(cutoffTime);
          if (Number.isFinite(at) && Number.isFinite(end) && at >= end) item.replayFailedAt = Math.floor(at);
          kept.push(item);
        }
      }
      deadLetter.length = 0;
      deadLetter.push(...kept);
      if (restored) splitLimit.delete(key);
      await persistQueue();
      return { restored, kept: deadLetter.filter((item) => String(item.electionKey) === key).length };
    },
    /**
     * Move dead letters the supplementary hook accepted into a holding list.
     * A row without a payload stays in the dead letter.
     */
    async holdSupplementary(electionId, nullifiers) {
      const key = String(electionId);
      const want = new Set((nullifiers || []).map((n) => nullifierKey(n)));
      const kept = [];
      let moved = 0;
      for (const item of deadLetter) {
        if (String(item.electionKey) === key && want.has(nullifierKey(item.nullifier)) && item.row) {
          supplementary.push(item);
          moved += 1;
        } else {
          kept.push(item);
        }
      }
      if (!moved) return { moved: 0 };
      deadLetter.length = 0;
      deadLetter.push(...kept);
      await persistQueue();
      return { moved };
    },
    supplementaryFor(electionId) {
      const key = String(electionId);
      return supplementary
        .filter((item) => String(item.electionKey) === key)
        .map((item) => ({
          electionKey: item.electionKey,
          nullifier: item.nullifier,
          error: item.error,
          at: item.at,
          replayFailedAt: item.replayFailedAt || null,
        }));
    },
    /**
     * Drop one accounted-for dead letter or supplementary hold. Returns false
     * when the nullifier is in neither list, and does not delete other rows.
     */
    async releaseExcluded(electionId, nullifier) {
      const key = String(electionId);
      const id = nullifierKey(nullifier);
      const before = deadLetter.length + supplementary.length;
      const stillDead = [];
      for (const item of deadLetter) {
        if (String(item.electionKey) === key && nullifierKey(item.nullifier) === id) continue;
        stillDead.push(item);
      }
      const stillHeld = [];
      for (const item of supplementary) {
        if (String(item.electionKey) === key && nullifierKey(item.nullifier) === id) continue;
        stillHeld.push(item);
      }
      const released = before - (stillDead.length + stillHeld.length);
      if (!released) return false;
      deadLetter.length = 0;
      deadLetter.push(...stillDead);
      supplementary.length = 0;
      supplementary.push(...stillHeld);
      await persistQueue();
      return true;
    },
    /** Nullifiers still on the queue, in a broadcast, or held for a supplementary batch. */
    pendingFor(electionId) {
      const key = String(electionId);
      const queued = (voteQueue.get(key) || []).map((row) => nullifierKey(row.nullifier));
      const marker = inFlight.get(key);
      const flying = (marker?.nullifiers || []).map((n) => nullifierKey(n));
      const held = supplementary
        .filter((item) => String(item.electionKey) === key)
        .map((item) => nullifierKey(item.nullifier));
      return { queued, inFlight: [...flying, ...held] };
    },
    diagnostics() {
      return {
        deadLetter: deadLetter.map((item) => ({
          electionKey: item.electionKey,
          nullifier: item.nullifier,
          error: item.error,
          at: item.at,
        })),
        alerts: alerts.slice(),
        backoffUntil: Object.fromEntries(backoffUntil),
        supplementary: supplementary.map((item) => ({
          electionKey: item.electionKey,
          nullifier: item.nullifier,
          error: item.error,
          at: item.at,
        })),
      };
    },
    /** Remove one queued nullifier that the node rejected. A mined marker stays. */
    async dropQueuedVote(electionId, nullifier) {
      const key = String(electionId);
      const id = nullifierKey(nullifier);
      const queued = voteQueue.get(key) || [];
      const left = queued.filter((row) => nullifierKey(row.nullifier) !== id);
      if (left.length === queued.length) return false;
      if (left.length) voteQueue.set(key, left);
      else voteQueue.delete(key);
      const marker = inFlight.get(key);
      if (marker && !marker.txHash) {
        marker.nullifiers = (marker.nullifiers || []).filter((n) => nullifierKey(n) !== id);
        if (!marker.nullifiers.length) inFlight.delete(key);
      }
      await persistQueue();
      return true;
    },
    async noteAlert(alert) {
      pushAlert(alert && typeof alert === 'object' ? alert : { kind: 'note', error: String(alert || '') });
      await persistQueue();
    },
    async clearAlert(match) {
      const kind = match && match.kind;
      const electionKey = match && match.electionKey != null ? String(match.electionKey) : null;
      const nullifier = match && match.nullifier != null ? String(match.nullifier) : null;
      const before = alerts.length;
      for (let i = alerts.length - 1; i >= 0; i -= 1) {
        const row = alerts[i];
        if (!row || row.kind !== kind) continue;
        if (electionKey != null && String(row.electionKey) !== electionKey) continue;
        if (nullifier != null && String(row.nullifier) !== nullifier) continue;
        alerts.splice(i, 1);
      }
      if (alerts.length !== before) await persistQueue();
    },
    reloadVoteQueue() {
      loadQueue();
    },
    /** Inbox ranking root (sorted ranking hashes carried by ranked batches). */
    async readRankingRoot(electionId) {
      if (typeof extras.readRankingRoot === 'function') return extras.readRankingRoot(asBigInt(electionId));
      const inbox = inboxAddress();
      if (!configured || !publicClient || !inbox) return null;
      return publicClient.readContract({
        address: inbox,
        abi: ballotInboxAbi,
        functionName: 'rankingRoot',
        args: [asBigInt(electionId)],
      });
    },
    async flushVoteQueue(now) {
      if (!configured) return [];
      const keys = new Set([...voteQueue.keys(), ...inFlight.keys()]);
      const out = [];
      for (const key of keys) {
        try {
          const result = await flushElection(key, now);
          if (result) out.push({ electionId: key, ...result });
        } catch (err) {
          const error = errorText(err);
          if (!config.quiet) console.warn(`[zk-voting] vote flush failed for election ${key}: ${error}`);
          out.push({ electionId: key, error });
        }
      }
      return out;
    },
  };
}

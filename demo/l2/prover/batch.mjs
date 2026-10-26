// NOT FOR PROFIT — civic public good, not a commercial prover.
// Batch construction for ZK-Voting L2. Public data is nullifiers, roots, and
// ballot hashes only — never ballot plaintext.
import {
  keccak256Hex,
  hexToBytes,
  publicFieldsForTx,
  stableStringify,
  ZERO_HASH,
} from '../sequencer/state.mjs';
import {
  computeElectionKey,
  computeSettlementDataHash,
  computeSettlementStateRoot,
  isUuid,
} from '../identity.mjs';

export function mockProof() {
  return {
    a: [1, 0],
    b: [
      [1, 0],
      [1, 0],
    ],
    c: [1, 0],
  };
}

export function extractPublicBatchData(blocks) {
  const nullifiers = [];
  const roots = [];
  const ballotHashes = [];
  const identityCommitments = [];
  const txHashes = [];
  const civic = [];
  const seenRoots = new Set();

  const addRoot = (value, label) => {
    if (!value) return;
    const key = `${label}:${value}`;
    if (seenRoots.has(key)) return;
    seenRoots.add(key);
    roots.push({ label, value });
  };

  for (const block of blocks) {
    const txs = Array.isArray(block.transactions) ? block.transactions : [];
    for (const tx of txs) {
      if (!tx || typeof tx === 'string') {
        if (typeof tx === 'string') txHashes.push(tx);
        continue;
      }
      txHashes.push(tx.hash);
      const pub = publicFieldsForTx(tx);
      civic.push({
        blockNumber: block.number,
        hash: pub.hash,
        type: pub.type,
        electionId: pub.electionId,
        nullifier: pub.nullifier,
        ballotHash: pub.ballotHash,
        identityCommitment: pub.identityCommitment,
        eligibleRoot: pub.eligibleRoot,
        disqualificationRoot: pub.disqualificationRoot,
        reasonCode: pub.reasonCode,
        evidenceHash: pub.evidenceHash,
        countsHash: pub.countsHash,
      });
      if (pub.nullifier) nullifiers.push(pub.nullifier);
      if (pub.ballotHash) ballotHashes.push(pub.ballotHash);
      if (pub.identityCommitment) identityCommitments.push(pub.identityCommitment);
      addRoot(pub.eligibleRoot, 'eligible');
      addRoot(pub.disqualificationRoot, 'disqualification');
    }
  }

  return {
    nullifiers,
    roots,
    ballotHashes,
    identityCommitments,
    txHashes,
    civic,
  };
}

export function computeDataHash(publicData) {
  return keccak256Hex(stableStringify(publicData));
}

/**
 * Elections touched by this batch, keyed the way L1 keys them:
 * electionKey = keccak(abi.encode(domain, l1ChainId, l2Id, bytes16(electionUuid))).
 */
export function electionsInBatch(civic, identity) {
  const byId = new Map();
  for (const c of civic) {
    const id = String(c.electionId || '').toLowerCase();
    if (!id) continue;
    const row = byId.get(id) || { electionUuid: id, electionKey: null, votes: 0, registered: 0, tally: false };
    if (c.type === 'vote') row.votes += 1;
    if (c.type === 'register') row.registered += 1;
    if (c.type === 'tally') row.tally = true;
    byId.set(id, row);
  }
  const l2Id = identity?.l2Id;
  for (const row of byId.values()) {
    if (l2Id && isUuid(row.electionUuid)) {
      row.electionKey = computeElectionKey({
        l1ChainId: identity.l1ChainId || 0,
        l2Id,
        electionUuid: row.electionUuid,
      });
    }
  }
  return [...byId.values()].sort((a, b) => a.electionUuid.localeCompare(b.electionUuid));
}

/**
 * The values sent to L1. RollupSettlement requires prevStateRoot to equal the
 * last accepted newStateRoot and dataHash = keccak(abi.encode(index, prev, new)),
 * so the L1 root chains batch to batch and commits to the public data hash.
 */
export function settlementForBatch({ batchIndex, publicDataHash, prevSettlementRoot, l2Id }) {
  const prev = prevSettlementRoot || ZERO_HASH;
  const next = computeSettlementStateRoot({ l2Id: l2Id || ZERO_HASH, prevStateRoot: prev, publicDataHash });
  return {
    batchIndex: Number(batchIndex),
    prevStateRoot: prev,
    newStateRoot: next,
    dataHash: computeSettlementDataHash({ batchIndex, prevStateRoot: prev, newStateRoot: next }),
  };
}

export function buildBatch({ batchIndex, blocks, prevStateRoot, identity = null, prevSettlementRoot = null }) {
  if (!blocks.length) {
    throw new Error('empty batch');
  }
  const first = blocks[0];
  const last = blocks[blocks.length - 1];
  const publicData = extractPublicBatchData(blocks);
  publicData.batchIndex = Number(batchIndex);
  publicData.startBlock = first.number;
  publicData.endBlock = last.number;
  publicData.prevStateRoot = prevStateRoot || ZERO_HASH;
  const hashBytes = publicData.txHashes.map((h) => Buffer.from(hexToBytes(h)));
  publicData.newStateRoot = hashBytes.length
    ? keccak256Hex(Buffer.concat(hashBytes))
    : last.stateRoot;
  if (identity && (identity.l2Id || identity.l2Uuid)) {
    publicData.identity = {
      l2Uuid: identity.l2Uuid || '',
      l2Id: identity.l2Id || '',
      l1ChainId: String(identity.l1ChainId || ''),
    };
  }
  publicData.elections = electionsInBatch(publicData.civic, identity);
  const dataHash = computeDataHash(publicData);
  const settlement = settlementForBatch({
    batchIndex,
    publicDataHash: dataHash,
    prevSettlementRoot,
    l2Id: identity?.l2Id,
  });
  return {
    notForProfit: true,
    batchIndex: Number(batchIndex),
    prevStateRoot: publicData.prevStateRoot,
    newStateRoot: publicData.newStateRoot,
    dataHash,
    startBlock: first.number,
    endBlock: last.number,
    blockHashes: blocks.map((b) => b.hash),
    publicData,
    settlement,
    proof: mockProof(),
  };
}

export const ROLLUP_SETTLEMENT_ABI = [
  {
    type: 'function',
    name: 'submitBatch',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'batchIndex', type: 'uint64' },
      { name: 'prevStateRoot', type: 'bytes32' },
      { name: 'newStateRoot', type: 'bytes32' },
      { name: 'dataHash', type: 'bytes32' },
      { name: 'a', type: 'uint256[2]' },
      { name: 'b', type: 'uint256[2][2]' },
      { name: 'c', type: 'uint256[2]' },
    ],
    outputs: [],
  },
];

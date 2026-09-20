// NOT FOR PROFIT — civic public good, not a commercial prover.
// Batch construction for Republic L2. Public data is nullifiers, roots, and
// ballot hashes only — never ballot plaintext.
import {
  keccak256Hex,
  hexToBytes,
  publicFieldsForTx,
  stableStringify,
  ZERO_HASH,
} from '../sequencer/state.mjs';

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
        partyId: pub.partyId,
        partyName: pub.partyName,
        mode: pub.mode,
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

export function buildBatch({ batchIndex, blocks, prevStateRoot }) {
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
  const dataHash = computeDataHash(publicData);
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

// NOT FOR PROFIT — civic public good, not a commercial product.
// Batch building and the batch commitment, as ZkVotingRollup.commitBatch computes it.

import { createHash } from 'node:crypto';

import { abiEncode, keccakWord } from '../../apps/node/public/ballot-crypto.js';
import { keccak256 } from '../../apps/node/public/keccak.js';
import { OP, concat, encodeBallot, encodeCloseResponse } from './pubdata.mjs';

const COMMITMENT_MASK = (1n << 253n) - 1n;

const sha256 = (bytes) => new Uint8Array(createHash('sha256').update(bytes).digest());
const word = (v) => {
  const out = new Uint8Array(32);
  let n = BigInt(v);
  for (let i = 31; i >= 0; i -= 1) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
};
const u64 = (v) => word(v).subarray(24);
const big = (bytes) => bytes.reduce((acc, x) => (acc << 8n) | BigInt(x), 0n);

/** keccak256(abi.encode(prev, h)), the chain both op hashes use. */
export const chain = (prev, h) => keccakWord(abiEncode([prev, h]));

export function batchCommitment({ prevStateRoot, newStateRoot, batchNumber, timestamp, pubdata, priorityOpsHash, onchainOpsHash }) {
  const preimage = concat([
    word(prevStateRoot),
    word(newStateRoot),
    u64(batchNumber),
    u64(timestamp),
    sha256(pubdata),
    word(priorityOpsHash),
    word(onchainOpsHash),
  ]);
  return big(sha256(preimage)) & COMMITMENT_MASK;
}

/** keccak256(abi.encode(StoredBatchInfo)), the hash L1 stores per batch. */
export function storedBatchHash(b) {
  return keccakWord(
    abiEncode([b.batchNumber, b.timestamp, b.priorityOperations, b.priorityOpsHash, b.onchainOpsHash, b.stateRoot, b.commitment]),
  );
}

/**
 * Apply queued requests (in queue order) and then mempool ballots to `state`.
 *
 * `requests`: `{ id, pubdata: Uint8Array, payload? }` — the request part as L1 queued it.
 * `ballots`:  `{ electionId, nullifier, ciphertexts }` — already proof-checked.
 * Returns the pubdata, the on-chain ops (CLOSE ops, for executeBatches), the priority op
 * count and hash, the new root, and the ballots that could not be included.
 */
export function buildBatch({ state, requests, ballots, timestamp, verifyForced }) {
  const parts = [];
  const onchain = [];
  let priorityOpsHash = 0n;
  let onchainOpsHash = 0n;
  const forcedResults = [];

  for (const r of requests) {
    const result = state.applyRequest(r.pubdata, { forcedPayload: r.payload, verifyForced });
    priorityOpsHash = chain(priorityOpsHash, keccakWord(r.pubdata));
    const type = r.pubdata[0];
    if (type === OP.FORCED_BALLOT) {
      parts.push(concat([r.pubdata, Uint8Array.of(result.accepted ? 1 : 0)]));
      forcedResults.push({ id: r.id, accepted: result.accepted });
    } else if (type === OP.CLOSE) {
      const op = concat([r.pubdata, encodeCloseResponse(result)]);
      parts.push(op);
      onchain.push(op);
      onchainOpsHash = chain(onchainOpsHash, keccakWord(op));
    } else {
      parts.push(r.pubdata);
    }
  }

  const included = [];
  const rejected = [];
  for (const b of ballots) {
    const reason = state.ballotError(b.electionId, timestamp);
    if (reason) {
      rejected.push({ ...b, reason });
      continue;
    }
    const { commitment, revote } = state.applyBallot(b, timestamp);
    parts.push(encodeBallot({ electionId: b.electionId, nullifier: b.nullifier, commitment }));
    included.push({ electionId: b.electionId, nullifier: b.nullifier, commitment, revote });
  }

  return {
    pubdata: concat(parts),
    onchainOps: concat(onchain),
    priorityOperations: requests.length,
    priorityOpsHash,
    onchainOpsHash,
    newStateRoot: state.root,
    included,
    rejected,
    forcedResults,
  };
}

export { keccak256 };

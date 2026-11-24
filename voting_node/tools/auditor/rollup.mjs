// NOT FOR PROFIT — civic public good, not a commercial product.
//
// Independent audit of a civic vote on ZkVotingRollup, from L1 alone. It trusts neither the
// Node nor the L2 operator, and it re-derives what the contract checked:
//
//   1. Ballots: every executed batch's pubdata is decoded from its commitBatch calldata; the
//      ballots for the election (BALLOT, and FORCED_BALLOT the operator accepted) are counted
//      once per nullifier and must equal the ballot count L1 stored at close.
//   2. Key: the joint key equals the sum of the constant terms of the guardians' Feldman
//      commitments (dealers in good standing).
//   3. Withheld: exactly when the ballot count is below the anonymity floor.
//   4. Result: the certified counts add up to the ballot count, their hash matches, and every
//      k-subset of the guardians who posted decryption shares opens the final accumulator to
//      those same counts.
//
// Nothing here can learn a choice: it sees only the final sum and the shares of it.

import { createRequire } from 'node:module';

import { createPublicClient, decodeFunctionData, encodeAbiParameters, getAddress, http, keccak256, parseAbiItem } from 'viem';

import * as bc from '../../apps/node/public/ballot-crypto.js';
import { l1ViemHttp } from '../../l2/l1RpcAuth.js';
import { OP, splitOps } from '../../l2/rollup/pubdata.mjs';

const require = createRequire(import.meta.url);
const { ROLLUP_ABI, decodeElectionInfo } = require('@zk-voting/chain-client');

export const ROLLUP_AUDIT_SCHEMA = 'zk-voting.rollup-audit.v1';
/** Upper bound on k-subsets re-opened, so a large committee stays quick. */
const MAX_SUBSETS = 64;

const EVENTS = {
  committed: parseAbiItem('event BatchCommitted(uint64 indexed batchNumber, bytes32 stateRoot, bytes32 commitment)'),
  executed: parseAbiItem('event BatchExecuted(uint64 indexed batchNumber, bytes32 stateRoot)'),
};

const big = (v) => BigInt(v);
const readUint = (b, offset, size) => {
  let n = 0n;
  for (let i = 0; i < size; i += 1) n = (n << 8n) | BigInt(b[offset + i]);
  return n;
};

/** All k-element subsets of `items`, at most `limit` of them. */
export function subsets(items, k, limit = MAX_SUBSETS) {
  const out = [];
  const pick = (start, acc) => {
    if (out.length >= limit) return;
    if (acc.length === k) {
      out.push(acc.slice());
      return;
    }
    for (let i = start; i < items.length; i += 1) {
      acc.push(items[i]);
      pick(i + 1, acc);
      acc.pop();
    }
  };
  pick(0, []);
  return out;
}

/**
 * Ballots for `electionId` in a list of pubdata blobs: `{ nullifiers: Set, replaced, forced }`.
 * A FORCED_BALLOT counts only when the operator marked it accepted (its response byte). A
 * nullifier seen again is a replacement (the later ballot replaces the earlier vector in L2
 * state), so it counts once.
 */
export function countBallots(pubdatas, electionId) {
  const nullifiers = new Set();
  let replaced = 0;
  let forced = 0;
  for (const pubdata of pubdatas) {
    for (const op of splitOps(pubdata)) {
      if (op.type !== OP.BALLOT && op.type !== OP.FORCED_BALLOT) continue;
      if (Number(readUint(op.bytes, 1, 4)) !== Number(electionId)) continue;
      if (op.type === OP.FORCED_BALLOT && op.response[0] === 0) continue;
      const nullifier = readUint(op.bytes, 5, 32).toString();
      if (nullifiers.has(nullifier)) replaced += 1;
      nullifiers.add(nullifier);
      if (op.type === OP.FORCED_BALLOT) forced += 1;
    }
  }
  return { nullifiers, replaced, forced };
}

/** The hash `finalizeResult` stores: keccak256(abi.encode(chainid, rollup, electionId, counts)). */
export function resultHashOf({ chainId, rollup, electionId, counts }) {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'address' }, { type: 'uint32' }, { type: 'uint256[]' }],
      [BigInt(chainId), getAddress(rollup), Number(electionId), counts.map(big)],
    ),
  );
}

/**
 * Pure checks over data already read from L1. `data` is
 * `{ chainId, rollup, electionId, info, pubdatas, accumulator, sharesByIndex, counts, resultHash, dealerCommitments }`.
 */
export function checkRollupElection(data) {
  const errors = [];
  const checks = [];
  const ok = (name, detail) => checks.push({ name, ok: true, ...(detail ? { detail } : {}) });
  const fail = (name, message) => {
    checks.push({ name, ok: false, detail: message });
    errors.push(`${name}: ${message}`);
  };
  const { info } = data;
  const closed = ['closed', 'finalized', 'withheld'].includes(info.status);

  // 1. Ballots in pubdata.
  const ballots = countBallots(data.pubdatas, data.electionId);
  ok(
    'ballots.pubdata',
    `${ballots.nullifiers.size} distinct nullifiers in ${data.pubdatas.length} executed batch(es)` +
      (ballots.replaced ? `, ${ballots.replaced} replacement(s)` : ''),
  );
  if (closed) {
    if (ballots.nullifiers.size === Number(info.ballotCount)) ok('ballots.count', `${info.ballotCount} ballots, as L1 stored at close`);
    else fail('ballots.count', `pubdata has ${ballots.nullifiers.size} ballots, L1 stored ${info.ballotCount}`);
  }

  // 2. Joint key.
  if (data.dealerCommitments?.length) {
    const joint = bc.jointKeyOf(data.dealerCommitments.map((cs) => cs.map(([x, y]) => [big(x), big(y)])));
    if (String(joint[0]) === String(info.jointKey[0]) && String(joint[1]) === String(info.jointKey[1])) {
      ok('key.joint', `sum of ${data.dealerCommitments.length} dealers' constant terms`);
    } else {
      fail('key.joint', 'the joint key is not the sum of the dealers’ constant terms');
    }
  }

  // 3. Anonymity floor.
  if (closed) {
    const below = Number(info.ballotCount) < Number(info.minBallots);
    if (below === (info.status === 'withheld')) {
      ok('floor', below ? `withheld: ${info.ballotCount} < ${info.minBallots}` : `${info.ballotCount} ≥ ${info.minBallots}`);
    } else {
      fail('floor', `status ${info.status} with ${info.ballotCount} ballots and floor ${info.minBallots}`);
    }
  }

  // 4. Result.
  if (info.status === 'finalized') {
    const counts = data.counts.map(big);
    const total = counts.reduce((a, b) => a + b, 0n);
    if (counts.length !== Number(info.optionCount)) fail('result.options', `${counts.length} counts for ${info.optionCount} options`);
    if (total === big(info.ballotCount)) ok('result.sum', `counts add up to ${total}`);
    else fail('result.sum', `counts add up to ${total}, ballot count is ${info.ballotCount}`);
    const hash = resultHashOf({ chainId: data.chainId, rollup: data.rollup, electionId: data.electionId, counts });
    if (hash.toLowerCase() === String(data.resultHash).toLowerCase()) ok('result.hash', hash);
    else fail('result.hash', `L1 stored ${data.resultHash}, recomputed ${hash}`);

    const posted = Object.keys(data.sharesByIndex).map(Number).sort((a, b) => a - b);
    const k = Number(info.threshold);
    if (posted.length < k) {
      fail('result.shares', `${posted.length} guardians posted shares, ${k} needed`);
    } else {
      const accumulator = data.accumulator.map(([c1, c2]) => [c1.map(big), c2.map(big)]);
      const tried = subsets(posted, k);
      let mismatch = null;
      for (const subset of tried) {
        const opened = bc.openTotals({ accumulator, sharesByIndex: data.sharesByIndex, subset, ballotCount: info.ballotCount });
        if (opened.some((n, i) => big(n) !== counts[i])) {
          mismatch = { subset, opened: opened.map(String) };
          break;
        }
      }
      if (mismatch) fail('result.shares', `guardians ${mismatch.subset.join(',')} open the sum to ${mismatch.opened.join(',')}`);
      else ok('result.shares', `${tried.length} subset(s) of ${k} from guardians ${posted.join(',')} all open the sum to the certified counts`);
    }
  } else if (!closed) {
    checks.push({ name: 'result', ok: true, detail: `not closed yet (status ${info.status}); result checks skipped` });
  }

  return {
    ok: errors.length === 0,
    errors,
    checks,
    summary: {
      status: info.status,
      ballotCount: info.ballotCount,
      ballotsInPubdata: ballots.nullifiers.size,
      forcedBallots: ballots.forced,
      replacedBallots: ballots.replaced,
      threshold: info.threshold,
      guardianCount: info.guardianCount,
      minBallots: info.minBallots,
      counts: info.status === 'finalized' ? data.counts.map(String) : null,
    },
  };
}

/** Read everything the checks need from L1. */
export async function readRollupElection({ rpc, rollup, electionId, fromBlock = 0n, client, env = process.env }) {
  const pub = client || createPublicClient({ transport: l1ViemHttp(http, rpc, env) });
  const address = getAddress(rollup);
  const read = (functionName, args) => pub.readContract({ address, abi: ROLLUP_ABI, functionName, args });
  const chainId = await pub.getChainId();
  const info = decodeElectionInfo(await read('election', [Number(electionId)]));

  // Executed batches, each with the commit that was executed (a reverted commit is replaced
  // by a later one with the same number).
  const [commits, executions] = await Promise.all([
    pub.getLogs({ address, event: EVENTS.committed, fromBlock: big(fromBlock), toBlock: 'latest' }),
    pub.getLogs({ address, event: EVENTS.executed, fromBlock: big(fromBlock), toBlock: 'latest' }),
  ]);
  const order = (log) => [big(log.blockNumber), Number(log.logIndex)];
  const before = (a, b) => {
    const [ab, ai] = order(a);
    const [bb, bi] = order(b);
    return ab < bb || (ab === bb && ai < bi);
  };
  const pubdatas = [];
  for (const exec of executions) {
    const number = exec.args.batchNumber;
    const commit = commits.filter((c) => c.args.batchNumber === number && before(c, exec)).pop();
    if (!commit) throw new Error(`no commit found for executed batch ${number}`);
    const tx = await pub.getTransaction({ hash: commit.transactionHash });
    // The genesis batch is recorded by the deployment itself; it carries no ops.
    if (tx.to == null) continue;
    if (getAddress(tx.to) !== address) throw new Error(`batch ${number} was committed through another contract; decode it by hand`);
    const { functionName, args } = decodeFunctionData({ abi: ROLLUP_ABI, data: tx.input });
    if (functionName !== 'commitBatch') throw new Error(`batch ${number}: unexpected call ${functionName}`);
    pubdatas.push(args[1].pubdata);
  }

  const dealerCommitments = [];
  const sharesByIndex = {};
  for (let i = 1; i <= Number(info.guardianCount); i += 1) {
    const [, , committed, excluded, sharesPosted] = await read('guardian', [Number(electionId), i]);
    if (committed && !excluded) {
      const [cx, cy] = await read('guardianCommitments', [Number(electionId), i]);
      dealerCommitments.push(cx.map((x, t) => [x, cy[t]]));
    }
    if (sharesPosted) {
      sharesByIndex[i] = (await read('decryptionShares', [Number(electionId), i])).map(([x, y]) => [x, y]);
    }
  }
  const accumulator = ['closed', 'finalized', 'withheld'].includes(info.status)
    ? (await read('accumulator', [Number(electionId)])).map((w) => [[w[0], w[1]], [w[2], w[3]]])
    : [];
  let counts = [];
  let resultHash = null;
  if (info.status === 'finalized') [counts, resultHash] = await read('result', [Number(electionId)]);
  return { chainId, rollup: address, electionId: Number(electionId), info, pubdatas, accumulator, sharesByIndex, counts, resultHash, dealerCommitments };
}

/** Read and check. Returns `{ schema, ok, errors, checks, summary, electionId, rollup, chainId }`. */
export async function auditRollupElection(opts) {
  const data = await readRollupElection(opts);
  return { schema: ROLLUP_AUDIT_SCHEMA, nfp: true, chainId: data.chainId, rollup: data.rollup, electionId: data.electionId, ...checkRollupElection(data) };
}

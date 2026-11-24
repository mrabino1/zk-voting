// NOT FOR PROFIT — civic public good, not a commercial product.
// The L2 state machine. Every rule here is a rule the batch circuit must prove
// (smart-contracts/docs/ROLLUP.md); StateTree.sol commits to the same leaves.
//
// The operator keeps each ballot's ciphertexts privately, only so a revote can subtract the
// old vector. They never appear in pubdata or in any API. Only the final per-option sum
// leaves this process, in the CLOSE response.

import * as bc from '../../apps/node/public/ballot-crypto.js';
import { OP, decodeRequest } from './pubdata.mjs';
import { RollTree, SparseMerkleTree } from './trees.mjs';

export const ELECTION_TREE_DEPTH = 32;
export const ROLL_DEPTH = 20;
export const NULLIFIER_DEPTH = 254;
export const STATUS_OPEN = 1n;
export const STATUS_CLOSED = 2n;

const key = (v) => BigInt(v).toString();

function newElection(req) {
  return {
    id: req.electionId,
    configHash: req.configHash % bc.P,
    startTime: req.startTime,
    cutoffTime: req.cutoffTime,
    optionCount: req.optionCount,
    jointKey: req.jointKey,
    roll: new RollTree(ROLL_DEPTH),
    rollIndex: new Map(),
    disqualified: new Set(),
    nullifiers: new SparseMerkleTree(NULLIFIER_DEPTH),
    ballots: new Map(),
    accumulator: bc.emptyAccumulator(req.optionCount),
    ballotCount: 0,
    status: STATUS_OPEN,
  };
}

export class RollupState {
  constructor() {
    this.elections = new Map();
    this.tree = new SparseMerkleTree(ELECTION_TREE_DEPTH);
  }

  get root() {
    return this.tree.root;
  }

  election(id) {
    return this.elections.get(Number(id)) ?? null;
  }

  leafFields(e) {
    return {
      configHash: e.configHash,
      eligibleRoot: e.roll.root,
      nullifierRoot: e.nullifiers.root,
      accumulatorHash: bc.accumulatorHash(e.accumulator),
      ballotCount: BigInt(e.ballotCount),
      status: e.status,
    };
  }

  leafHash(e) {
    const f = this.leafFields(e);
    return bc.fold([f.configHash, f.eligibleRoot, f.nullifierRoot, f.accumulatorHash, f.ballotCount, f.status]);
  }

  _commit(e) {
    this.tree.set(BigInt(e.id), this.leafHash(e));
  }

  /**
   * Apply one queued L1 request. Returns the response bytes' inputs:
   * `{ accepted }` for a forced ballot, `{ ballotCount, accumulator }` for CLOSE.
   */
  applyRequest(request, { forcedPayload, verifyForced } = {}) {
    const req = request.type ? request : decodeRequest(request);
    switch (req.type) {
      case OP.CREATE_ELECTION: {
        if (this.elections.has(req.electionId)) throw new Error(`election ${req.electionId} exists`);
        const e = newElection(req);
        this.elections.set(req.electionId, e);
        this._commit(e);
        return {};
      }
      case OP.REGISTER: {
        const e = this._require(req.electionId);
        for (const c of req.commitments) {
          if (e.rollIndex.has(key(c)) || e.disqualified.has(key(c))) continue;
          e.rollIndex.set(key(c), e.roll.append(c));
        }
        this._commit(e);
        return {};
      }
      case OP.DISQUALIFY: {
        const e = this._require(req.electionId);
        e.disqualified.add(key(req.commitment));
        const index = e.rollIndex.get(key(req.commitment));
        if (index !== undefined) e.roll.clear(index);
        this._commit(e);
        return {};
      }
      case OP.FORCED_BALLOT: {
        const e = this._require(req.electionId);
        const ballot = forcedPayload && verifyForced ? verifyForced(e, req, forcedPayload) : null;
        if (!ballot || e.status !== STATUS_OPEN) return { accepted: false };
        this._cast(e, req.nullifier, ballot.ciphertexts);
        return { accepted: true };
      }
      case OP.CLOSE: {
        const e = this._require(req.electionId);
        e.status = STATUS_CLOSED;
        e.ballots.clear();
        this._commit(e);
        return { ballotCount: e.ballotCount, accumulator: e.accumulator };
      }
      default:
        throw new Error(`unknown request type ${req.type}`);
    }
  }

  /**
   * Can an L2 ballot be cast now? Checks the election window at batch time `timestamp`
   * (seconds). The ballot proof itself is checked by the operator before this.
   */
  ballotError(electionId, timestamp) {
    const e = this.election(electionId);
    if (!e) return 'unknown election';
    if (e.status !== STATUS_OPEN) return 'election is closed';
    if (timestamp < e.startTime) return 'voting has not started';
    if (timestamp >= e.cutoffTime) return 'voting has ended';
    return null;
  }

  /** Apply an L2 ballot. A second ballot under the same nullifier replaces the first. */
  applyBallot({ electionId, nullifier, ciphertexts }, timestamp) {
    const reason = this.ballotError(electionId, timestamp);
    if (reason) throw new Error(reason);
    return this._cast(this.election(electionId), nullifier, ciphertexts);
  }

  _cast(e, nullifier, ciphertexts) {
    const n = BigInt(nullifier);
    const previous = e.ballots.get(key(n));
    if (previous) e.accumulator = bc.subCiphertexts(e.accumulator, previous);
    else e.ballotCount += 1;
    e.accumulator = bc.addCiphertexts(e.accumulator, ciphertexts);
    e.ballots.set(key(n), ciphertexts);
    const commitment = bc.ballotCommitment(ciphertexts);
    e.nullifiers.set(n, commitment);
    this._commit(e);
    return { commitment, revote: Boolean(previous) };
  }

  _require(id) {
    const e = this.election(id);
    if (!e) throw new Error(`unknown election ${id}`);
    return e;
  }

  /** Membership path of a commitment in an election's roll, for the voter's ballot proof. */
  rollPath(electionId, commitment) {
    const e = this.election(electionId);
    const index = e?.rollIndex.get(key(commitment));
    if (index === undefined || e.disqualified.has(key(commitment))) return null;
    return { root: e.roll.root, ...e.roll.path(index) };
  }

  /** Arguments for `desertClose`: the leaf, its accumulator and the election-tree path. */
  desertProof(electionId) {
    const e = this._require(electionId);
    return {
      leaf: this.leafFields(e),
      accumulator: e.accumulator.map(([c1, c2]) => [c1[0], c1[1], c2[0], c2[1]]),
      siblings: this.tree.siblings(BigInt(e.id)),
    };
  }

  /** Public view of an election. No live ballot count before close. */
  publicView(electionId) {
    const e = this.election(electionId);
    if (!e) return null;
    const closed = e.status === STATUS_CLOSED;
    return {
      electionId: e.id,
      status: closed ? 'closed' : 'open',
      startTime: e.startTime,
      cutoffTime: e.cutoffTime,
      optionCount: e.optionCount,
      jointKey: e.jointKey.map(String),
      eligibleRoot: e.roll.root.toString(),
      rollSize: e.roll.size,
      nullifierRoot: e.nullifiers.root.toString(),
      ballotCount: closed ? e.ballotCount : null,
    };
  }

  // ------------------------------------------------------------- persistence

  toJSON() {
    return {
      elections: [...this.elections.values()].map((e) =>
        bc.toJSONSafe({
          id: e.id,
          configHash: e.configHash,
          startTime: e.startTime,
          cutoffTime: e.cutoffTime,
          optionCount: e.optionCount,
          jointKey: e.jointKey,
          roll: e.roll.toJSON(),
          rollIndex: [...e.rollIndex],
          disqualified: [...e.disqualified],
          nullifiers: e.nullifiers.toJSON(),
          ballots: [...e.ballots],
          accumulator: e.accumulator,
          ballotCount: e.ballotCount,
          status: e.status,
        }),
      ),
      tree: this.tree.toJSON(),
    };
  }

  static fromJSON(j) {
    const s = new RollupState();
    for (const raw of j.elections) {
      s.elections.set(raw.id, {
        id: raw.id,
        configHash: BigInt(raw.configHash),
        startTime: raw.startTime,
        cutoffTime: raw.cutoffTime,
        optionCount: raw.optionCount,
        jointKey: raw.jointKey.map(BigInt),
        roll: RollTree.fromJSON(raw.roll),
        rollIndex: new Map(raw.rollIndex.map(([k, v]) => [k, Number(v)])),
        disqualified: new Set(raw.disqualified),
        nullifiers: SparseMerkleTree.fromJSON(raw.nullifiers),
        ballots: new Map(raw.ballots.map(([k, v]) => [k, bc.fromJSONSafe(v)])),
        accumulator: bc.fromJSONSafe(raw.accumulator),
        ballotCount: raw.ballotCount,
        status: BigInt(raw.status),
      });
    }
    s.tree = SparseMerkleTree.fromJSON(j.tree);
    return s;
  }
}

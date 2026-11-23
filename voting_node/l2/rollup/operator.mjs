// NOT FOR PROFIT — civic public good, not a commercial product.
// The L2 operator: follow the L1 queue, accept ballots, and settle batches
// (commit → prove → verify → execute). See smart-contracts/docs/ROLLUP.md.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import * as bc from '../../apps/node/public/ballot-crypto.js';
import { keccak256 } from '../../apps/node/public/keccak.js';
import { batchCommitment, buildBatch } from './batch.mjs';
import { OP, decodeRequest, fromHex, toHex } from './pubdata.mjs';
import { RollupState } from './state.mjs';

const MOCK_PROOF = [1n, 0n, 0n, 0n, 0n, 0n, 0n, 0n];
const MAX_BALLOTS_PER_BATCH = 256;
const MAX_REQUESTS_PER_BATCH = 64;

export class Operator {
  /**
   * @param {object} opts
   * @param {ReturnType<import('./l1.mjs').createL1>} opts.l1
   * @param {string} [opts.dataDir] where the operator keeps its private state
   * @param {number} opts.chainId L1 chain id (bound into ballot proofs)
   * @param {(ballot, election) => boolean|Promise<boolean>} [opts.checkEligibility]
   *        verifies the voter's eligibility proof. Without one, only mock eligibility is
   *        accepted, and only when `allowMockProofs` is set.
   * @param {boolean} [opts.allowMockProofs]
   * @param {(batch) => Promise<bigint[]>} [opts.prove] batch prover. Defaults to the mock
   *        proof, which only a mock L1 verifier accepts.
   */
  constructor({ l1, dataDir, chainId, checkEligibility, allowMockProofs = false, prove, log = () => {} }) {
    this.l1 = l1;
    this.dataDir = dataDir;
    this.ctx = bc.contextOf({ chainId, rollup: l1.address });
    this.checkEligibility = checkEligibility;
    this.allowMockProofs = allowMockProofs;
    this.prove = prove ?? (async () => MOCK_PROOF);
    this.log = log;
    this.state = new RollupState();
    this.requests = new Map();
    this.payloads = new Map();
    this.nextRequest = 0;
    this.mempool = new Map();
    this.receipts = new Map();
    this.batches = [];
    /** Committed batches still waiting for verify/execute, oldest first. */
    this.unsettled = [];
    this.last = null;
    this.syncedBlock = -1n;
    this.l1Time = 0;
    this.l1TimeAt = 0;
    this.desert = false;
    this.busy = false;
  }

  // ---------------------------------------------------------------- lifecycle

  async init() {
    if (this.dataDir && existsSync(this._file())) {
      this._load(JSON.parse(readFileSync(this._file(), 'utf8')));
    } else {
      const g = await this.l1.genesis();
      this.last = g.stored;
      this.syncedBlock = g.block - 1n;
      if (this.state.root !== this.last.stateRoot) throw new Error('L1 genesis root is not the empty L2 state');
    }
    await this.sync();
    return this;
  }

  /** Pull new L1 requests and forced-ballot payloads, and the L1 clock. */
  async sync() {
    const head = await this.l1.latestBlock();
    this.l1Time = Number(head.timestamp);
    this.l1TimeAt = Date.now();
    if (head.number > this.syncedBlock) {
      const { requests, payloads } = await this.l1.requestsBetween(this.syncedBlock + 1n, head.number);
      for (const r of requests) this.requests.set(r.id, r);
      for (const [id, p] of payloads) this.payloads.set(id, p);
      this.syncedBlock = head.number;
    }
    this.desert = await this.l1.read('desertMode');
  }

  // ------------------------------------------------------------------ ballots

  /**
   * Check and queue one ballot. `ciphertexts`/`proof` are ballot-crypto objects (bigints).
   * Returns a receipt. Throws `{ status, message }` errors for the API.
   */
  async submitBallot({ electionId, nullifier, ciphertexts, proof, eligibility }) {
    const fail = (status, message) => Object.assign(new Error(message), { status });
    if (this.desert) throw fail(503, 'the rollup is in desert mode');
    const e = this.state.election(electionId);
    if (!e) throw fail(404, 'unknown election');
    const reason = this.state.ballotError(electionId, this.estimatedL1Time());
    if (reason) throw fail(409, reason);
    const n = BigInt(nullifier);
    if (n <= 0n || n >= bc.P) throw fail(400, 'bad nullifier');
    const ok = bc.verifyBallot({ ctx: this.ctx, electionId, jointKey: e.jointKey, optionCount: e.optionCount, ciphertexts, proof });
    if (!ok) throw fail(400, 'ballot proof does not verify');
    const eligible = this.checkEligibility
      ? await this.checkEligibility({ electionId, nullifier: n, ciphertexts, eligibility }, this.state.publicView(electionId))
      : this.allowMockProofs;
    if (!eligible) throw fail(403, 'eligibility proof does not verify');
    const commitment = bc.ballotCommitment(ciphertexts);
    this.mempool.set(`${electionId}:${n}`, { electionId: Number(electionId), nullifier: n, ciphertexts });
    this.receipts.set(`${electionId}:${n}`, { status: 'pending', commitment: commitment.toString(), receivedAt: Date.now() });
    this._save();
    return { electionId: Number(electionId), nullifier: n.toString(), commitment: commitment.toString(), status: 'pending' };
  }

  /** L1 time now, from the last block seen plus the wall time since. */
  estimatedL1Time() {
    return this.l1Time + Math.floor((Date.now() - this.l1TimeAt) / 1000);
  }

  receipt(electionId, nullifier) {
    return this.receipts.get(`${electionId}:${BigInt(nullifier)}`) ?? null;
  }

  // ------------------------------------------------------------------ batches

  /** Build and settle one batch if there is anything to settle. */
  async tick() {
    if (this.busy) return null;
    this.busy = true;
    try {
      await this.sync();
      if (this.desert) return null;
      await this._finishUnsettled();
      const requests = this._nextRequests();
      const ballots = [...this.mempool.values()].slice(0, MAX_BALLOTS_PER_BATCH);
      if (!requests.length && !ballots.length) return null;
      return await this._settle(requests, ballots);
    } finally {
      this.busy = false;
    }
  }

  _nextRequests() {
    const out = [];
    for (let id = this.nextRequest; out.length < MAX_REQUESTS_PER_BATCH; id += 1) {
      const r = this.requests.get(id);
      if (!r) break;
      const bytes = fromHex(r.pubdata);
      if (bytes[0] === OP.FORCED_BALLOT && !this.payloads.has(id)) break;
      out.push({ id, pubdata: bytes, payload: this.payloads.get(id) });
    }
    return out;
  }

  /** A forced ballot's payload is JSON `{ ciphertexts, proof }`; it must match the request. */
  verifyForced = (e, req, payloadHex) => {
    try {
      const bytes = fromHex(payloadHex);
      if (BigInt(toHex(keccak256(bytes))) !== req.payloadHash) return null;
      const body = bc.fromJSONSafe(JSON.parse(Buffer.from(bytes).toString('utf8')));
      if (bc.ballotCommitment(body.ciphertexts) !== req.commitment) return null;
      const ok = bc.verifyBallot({
        ctx: this.ctx,
        electionId: e.id,
        jointKey: e.jointKey,
        optionCount: e.optionCount,
        ciphertexts: body.ciphertexts,
        proof: body.proof,
      });
      return ok ? body : null;
    } catch {
      return null;
    }
  };

  async _settle(requests, ballots) {
    const snapshot = JSON.stringify(this.state.toJSON());
    const timestamp = this.l1Time;
    const prevRoot = this.state.root;
    const built = buildBatch({ state: this.state, requests, ballots, timestamp, verifyForced: this.verifyForced });
    const number = BigInt(this.last.batchNumber) + 1n;
    const expected = batchCommitment({
      prevStateRoot: prevRoot,
      newStateRoot: built.newStateRoot,
      batchNumber: number,
      timestamp,
      pubdata: built.pubdata,
      priorityOpsHash: built.priorityOpsHash,
      onchainOpsHash: built.onchainOpsHash,
    });
    let stored;
    const txs = {};
    try {
      const committed = await this.l1.commitBatch(this.last, {
        newStateRoot: built.newStateRoot,
        timestamp,
        pubdata: toHex(built.pubdata),
      });
      txs.commit = committed.receipt.transactionHash;
      if (committed.commitment !== expected) throw new Error('L1 batch commitment differs from the L2 one');
      stored = {
        batchNumber: number,
        timestamp: BigInt(timestamp),
        priorityOperations: BigInt(built.priorityOperations),
        priorityOpsHash: built.priorityOpsHash,
        onchainOpsHash: built.onchainOpsHash,
        stateRoot: built.newStateRoot,
        commitment: expected,
      };
    } catch (err) {
      this.state = RollupState.fromJSON(JSON.parse(snapshot));
      this.log('commit failed', err.shortMessage || err.message);
      throw err;
    }

    this.last = stored;
    this.nextRequest += requests.length;
    for (const b of built.included) this.mempool.delete(`${b.electionId}:${b.nullifier}`);
    for (const b of built.rejected) {
      this.mempool.delete(`${b.electionId}:${b.nullifier}`);
      this.receipts.set(`${b.electionId}:${b.nullifier}`, { status: 'rejected', reason: b.reason });
    }

    const record = {
      batchNumber: Number(number),
      timestamp,
      stateRoot: built.newStateRoot.toString(),
      commitment: expected.toString(),
      pubdataBytes: built.pubdata.length,
      ops: summarize(requests, built),
      txs,
      included: built.included.map((b) => `${b.electionId}:${b.nullifier}`),
    };
    this.batches.push(record);
    for (const b of built.included) {
      this.receipts.set(`${b.electionId}:${b.nullifier}`, {
        status: 'committed',
        commitment: b.commitment.toString(),
        batchNumber: record.batchNumber,
        stateRoot: record.stateRoot,
        l1Tx: txs.commit,
      });
    }
    this.unsettled.push({ stored, pubdata: toHex(built.pubdata), onchainOps: toHex(built.onchainOps) });
    this._save();
    await this._finishUnsettled();
    this.log(`batch ${record.batchNumber}: ${JSON.stringify(record.ops)}`);
    return record;
  }

  /** Prove, verify and execute committed batches in order. Safe to retry. */
  async _finishUnsettled() {
    while (this.unsettled.length) {
      const { stored, pubdata, onchainOps } = this.unsettled[0];
      const number = stored.batchNumber;
      const record = this.batches.find((b) => BigInt(b.batchNumber) === number);
      if (BigInt(await this.l1.read('totalBatchesVerified')) < number) {
        const proof = await this.prove({ stored, pubdata: fromHex(pubdata) });
        record.txs.verify = (await this.l1.verifyBatch(stored, proof)).transactionHash;
      }
      if (BigInt(await this.l1.read('totalBatchesExecuted')) < number) {
        record.txs.execute = (await this.l1.executeBatches([stored], [onchainOps])).transactionHash;
      }
      record.executed = true;
      for (const key of record.included || []) {
        const r = this.receipts.get(key);
        if (r && r.batchNumber === record.batchNumber) r.status = 'settled';
      }
      this.unsettled.shift();
      this._save();
    }
  }

  // ------------------------------------------------------------- persistence

  _file() {
    return path.join(this.dataDir, 'rollup-operator.json');
  }

  _save() {
    if (!this.dataDir) return;
    mkdirSync(this.dataDir, { recursive: true });
    const body = bc.toJSONSafe({
      version: 1,
      rollup: this.l1.address,
      state: this.state.toJSON(),
      last: this.last,
      nextRequest: this.nextRequest,
      requests: [...this.requests.values()],
      payloads: [...this.payloads],
      mempool: [...this.mempool.values()],
      receipts: [...this.receipts],
      batches: this.batches,
      unsettled: this.unsettled,
      syncedBlock: this.syncedBlock,
    });
    const tmp = `${this._file()}.tmp`;
    writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
    renameSync(tmp, this._file());
  }

  _load(raw) {
    if (raw.rollup !== this.l1.address) throw new Error(`state belongs to rollup ${raw.rollup}`);
    this.state = RollupState.fromJSON(raw.state);
    this.last = bc.fromJSONSafe(raw.last);
    this.nextRequest = raw.nextRequest;
    this.requests = new Map(raw.requests.map((r) => [Number(r.id), { ...r, id: Number(r.id) }]));
    this.payloads = new Map(raw.payloads.map(([k, v]) => [Number(k), v]));
    this.mempool = new Map(
      raw.mempool.map((b) => {
        const ballot = { ...bc.fromJSONSafe(b), electionId: Number(b.electionId) };
        return [`${ballot.electionId}:${ballot.nullifier}`, ballot];
      }),
    );
    this.receipts = new Map(raw.receipts);
    this.batches = raw.batches;
    this.unsettled = (raw.unsettled || []).map((u) => ({ ...u, stored: bc.fromJSONSafe(u.stored) }));
    this.syncedBlock = BigInt(raw.syncedBlock);
  }

  // ------------------------------------------------------------------- views

  status() {
    return {
      rollup: this.l1.address,
      chainId: Number(this.ctx.chainId),
      desertMode: this.desert,
      lastBatch: this.last ? Number(this.last.batchNumber) : 0,
      stateRoot: this.state.root.toString(),
      queued: this.requests.size - this.nextRequest,
      pendingBallots: this.mempool.size,
      l1Time: this.l1Time,
    };
  }
}

function summarize(requests, built) {
  const names = { 1: 'create', 2: 'register', 3: 'disqualify', 5: 'forced', 6: 'close' };
  const ops = {};
  for (const r of requests) {
    const name = names[r.pubdata[0]];
    ops[name] = (ops[name] || 0) + (name === 'register' ? decodeRequest(r.pubdata).commitments.length : 1);
  }
  if (built.included.length) ops.ballots = built.included.length;
  return ops;
}

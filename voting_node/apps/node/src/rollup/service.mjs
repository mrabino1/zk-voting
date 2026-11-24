// NOT FOR PROFIT — civic public good, not a commercial product.
// Civic VOTEs on the rollup: the node's side of smart-contracts/docs/ROLLUP.md.
//
//   draft (node) → guardians enrolled with identity keys → publish (createElection on L1)
//   → guardians commit, dealing shares through the node mailbox → finalizeKey
//   → roll synced to L1 until startTime → ballots to the L2 → close after cutoff
//   → guardians post decryption shares → finalizeResult (the totals, checked on L1).
//
// The node stores no ciphertext and opens nothing: the totals are computed from the
// on-chain sum and the guardians' on-chain shares, and L1 checks them.

import * as bc from '../../public/ballot-crypto.js';
import { ELECTION_TYPE_VOTE, electionTypeOf } from '../electionType.mjs';
import { HttpError } from '../http.mjs';
import { RollupError } from './client.mjs';

/** L1 statuses after which closing is already done (or no longer possible). */
const PAST_VOTING = new Set(['closing', 'closed', 'finalized', 'withheld', 'halted']);
export const DEFAULT_MIN_BALLOTS = 5;
const MAX_GUARDIANS = 16;
const MAX_OPTIONS = 8;

export const isRollupElection = (election) => electionTypeOf(election) === ELECTION_TYPE_VOTE && Boolean(election?.rollup);

function parsePoint(raw, what) {
  try {
    const p = Array.isArray(raw) ? raw.map((v) => BigInt(v)) : null;
    if (!p || p.length !== 2 || !bc.onCurve(p) || bc.eq(p, bc.IDENTITY)) throw new Error();
    return p;
  } catch {
    throw new HttpError(400, `${what} must be a Baby Jubjub point [x, y]`, { code: 'BAD_POINT' });
  }
}

function asHttp(err) {
  if (err instanceof RollupError) throw new HttpError(err.status, err.message, { code: err.code });
  throw err;
}

export class RollupService {
  /**
   * @param {{ store, client, config, nowFn?: () => number, log?: Function }} deps
   *        `client` is createRollupClient(); null disables the rollup.
   */
  constructor({ store, client, config, nowFn = () => Math.floor(Date.now() / 1000), log = () => {} }) {
    this.store = store;
    this.client = client;
    this.config = config;
    this.now = nowFn;
    this.log = log;
    this.inFlight = new Set();
  }

  get enabled() {
    return Boolean(this.client);
  }

  requireEnabled() {
    if (!this.client) {
      throw new HttpError(503, 'this node is not connected to the rollup (ROLLUP_ADDRESS, L1_RPC)', {
        code: 'ROLLUP_DISABLED',
      });
    }
  }

  ctx() {
    return bc.contextOf({ chainId: this.client.chainId, rollup: this.client.address });
  }

  // ------------------------------------------------------------------- setup

  /** Turn a VOTE draft into a rollup election: one question, 2–8 options, guardians by key. */
  async prepare(electionId, { threshold, minBallots } = {}) {
    const election = this.store.requireElection(electionId);
    if (electionTypeOf(election) !== ELECTION_TYPE_VOTE) {
      throw new HttpError(409, 'only civic votes run on the rollup; polls stay on this node', { code: 'NOT_A_VOTE' });
    }
    if (election.rollup?.electionId) throw new HttpError(409, 'already published to L1', { code: 'ALREADY_PUBLISHED' });
    const questions = election.questions || [];
    const options = questions[0]?.options || [];
    if (questions.length !== 1 || options.length < 2 || options.length > MAX_OPTIONS) {
      throw new HttpError(400, `a rollup vote has one question with 2 to ${MAX_OPTIONS} options`, { code: 'BAD_BALLOT_SHAPE' });
    }
    election.rollup = {
      ...(election.rollup || {}),
      guardians: election.rollup?.guardians || [],
      threshold: Number(threshold ?? election.rollup?.threshold ?? 0) || null,
      minBallots: Number(minBallots ?? election.rollup?.minBallots ?? DEFAULT_MIN_BALLOTS),
      mailbox: election.rollup?.mailbox || [],
      synced: election.rollup?.synced || { commitments: [], disqualified: [] },
      receipts: election.rollup?.receipts || {},
    };
    if (!Number.isInteger(election.rollup.minBallots) || election.rollup.minBallots < 1) {
      throw new HttpError(400, 'minBallots must be at least 1', { code: 'BAD_MIN_BALLOTS' });
    }
    await this.store.persist();
    return election.rollup;
  }

  async enrollGuardian(electionId, { label, identityKey }) {
    const election = this.store.requireElection(electionId);
    if (!election.rollup) await this.prepare(electionId);
    const r = election.rollup;
    if (r.electionId) throw new HttpError(409, 'guardians are fixed once the vote is on L1', { code: 'ROSTER_CLOSED' });
    const key = parsePoint(identityKey, 'identityKey');
    if (r.guardians.some((g) => g.identityKey[0] === String(key[0]))) {
      throw new HttpError(409, 'this identity key is already a guardian', { code: 'DUPLICATE_GUARDIAN' });
    }
    if (r.guardians.length >= MAX_GUARDIANS) throw new HttpError(409, `at most ${MAX_GUARDIANS} guardians`);
    const guardian = {
      index: r.guardians.length + 1,
      label: String(label || `Guardian ${r.guardians.length + 1}`).slice(0, 120),
      identityKey: key.map(String),
    };
    r.guardians.push(guardian);
    await this.store.persist();
    return guardian;
  }

  /** createElection on L1. The node account must be a clerk of the L1 jurisdiction. */
  async publish(electionId, { metadataURI } = {}) {
    this.requireEnabled();
    const election = this.store.requireElection(electionId);
    const r = election.rollup || (await this.prepare(electionId));
    if (r.electionId) throw new HttpError(409, 'already published to L1', { code: 'ALREADY_PUBLISHED' });
    const n = r.guardians.length;
    const k = r.threshold || Math.floor(n / 2) + 1;
    if (n < 1 || k < 1 || k > n) {
      throw new HttpError(409, 'enroll guardians and pick a threshold first', { code: 'NO_GUARDIANS' });
    }
    if (Number(election.startTime) <= (await this.client.now())) {
      throw new HttpError(409, 'the start time has passed; move it later before publishing', { code: 'START_PASSED' });
    }
    const config = {
      jurisdictionId: this.client.jurisdictionId,
      startTime: BigInt(election.startTime),
      cutoffTime: BigInt(election.cutoffTime),
      optionCount: election.questions[0].options.length,
      minBallots: r.minBallots,
      registrar: this.client.account,
      officer: this.client.account,
      guardians: r.guardians.map((g) => g.identityKey.map(BigInt)),
      threshold: k,
      ballotSpecHash: this.client.hex32(BigInt(election.ballotSpecHash || 0)),
      metadataURI: String(metadataURI || ''),
    };
    const created = await this.client.createElection(config).catch(asHttp);
    r.electionId = created.electionId;
    r.threshold = k;
    r.configHash = created.configHash;
    r.publishedTx = created.tx;
    await this.store.persist();
    return this.view(electionId);
  }

  // ------------------------------------------------------- key ceremony relay

  /** Relay a guardian's signed commitment (from the guardian CLI). */
  async commitGuardian(electionId, index, body) {
    const { r } = this._published(electionId);
    const c = bc.fromJSONSafe(body);
    await this.client.commitGuardian(r.electionId, Number(index), c).catch(asHttp);
    return this.view(electionId);
  }

  /** Encrypted share for one recipient. The node only stores and forwards it. */
  async postShareMessage(electionId, { from, to, box }) {
    const { election, r } = this._published(electionId);
    const known = (i) => r.guardians.some((g) => g.index === Number(i));
    if (!known(from) || !known(to) || !box || typeof box !== 'object') {
      throw new HttpError(400, 'from, to and box are required', { code: 'BAD_MESSAGE' });
    }
    r.mailbox = r.mailbox.filter((m) => !(m.from === Number(from) && m.to === Number(to)));
    r.mailbox.push({ from: Number(from), to: Number(to), box, at: this.now() });
    await this.store.persist();
    return { ok: true, electionId: election.id };
  }

  inbox(electionId, index) {
    const { r } = this._published(electionId);
    return r.mailbox.filter((m) => m.to === Number(index));
  }

  async dispute(electionId, action, body) {
    const { r } = this._published(electionId);
    const b = bc.fromJSONSafe(body || {});
    const id = r.electionId;
    const call = {
      complain: () => this.client.complainShare(id, Number(b.dealer), Number(b.recipient), b.share, b.signature),
      open: () => this.client.openShareDispute(id, Number(b.dealer), Number(b.recipient), b.signature),
      reveal: () => this.client.revealShare(id, Number(b.dealer), b.share),
      expire: () => this.client.expireShareDispute(id, Number(b.dealer)),
    }[action];
    if (!call) throw new HttpError(404, 'unknown dispute action');
    await call().catch(asHttp);
    return this.view(electionId);
  }

  async finalizeKey(electionId) {
    const { r } = this._published(electionId);
    await this.client.finalizeKey(r.electionId).catch(asHttp);
    await this.syncRoll(electionId);
    return this.view(electionId);
  }

  // -------------------------------------------------------------------- roll

  /** Send new registrations and disqualifications to L1 (allowed until startTime). */
  async syncRoll(electionId) {
    const { election, r } = this._published(electionId);
    const info = await this.client.election(r.electionId);
    if (info?.status !== 'scheduled' || (await this.client.now()) >= info.startTime) return { registered: 0, disqualified: 0 };
    const done = new Set(r.synced.commitments);
    const fresh = this.store
      .listEligibleRegistrations(election.id)
      .map((reg) => BigInt(reg.identityCommitment).toString())
      .filter((c) => !done.has(c));
    if (fresh.length) {
      await this.client.registerVoters(r.electionId, fresh).catch(asHttp);
      r.synced.commitments.push(...fresh);
    }
    const dqDone = new Set(r.synced.disqualified);
    const dq = this.store
      .listDisqualifications(election.id)
      .filter((d) => !d.revokedAt && !dqDone.has(BigInt(d.identityCommitment).toString()));
    for (const d of dq) {
      await this.client.disqualify(r.electionId, d.identityCommitment, d.reasonCode).catch(asHttp);
      r.synced.disqualified.push(BigInt(d.identityCommitment).toString());
    }
    if (fresh.length || dq.length) await this.store.persist();
    return { registered: fresh.length, disqualified: dq.length };
  }

  // ----------------------------------------------------------------- ballots

  /** What a voter's browser needs to encrypt and bind a ballot. */
  async ballotContext(electionId) {
    const { election, r } = this._published(electionId);
    const info = await this.client.election(r.electionId);
    return {
      electionId: r.electionId,
      chainId: this.client.chainId,
      rollup: this.client.address,
      jointKey: info.jointKey,
      optionCount: info.optionCount,
      options: election.questions[0].options.map((o) => ({ id: o.id, label: o.label ?? o.text ?? String(o.id) })),
      startTime: info.startTime,
      cutoffTime: info.cutoffTime,
      status: info.status,
    };
  }

  /**
   * Hand an encrypted ballot to the L2. The caller has already checked the voter's vote
   * pass. The node keeps only the receipt (nullifier, commitment, status), never the vector.
   */
  async castBallot(electionId, body) {
    const { r } = this._published(electionId);
    const ballot = bc.fromJSONSafe(body || {});
    if (ballot.nullifier == null || !Array.isArray(ballot.ciphertexts) || !ballot.proof) {
      throw new HttpError(400, 'nullifier, ciphertexts and proof are required', { code: 'BAD_BALLOT' });
    }
    // One ballot per nullifier: nothing proves yet that the sender owns it, and the
    // operator would replace the earlier vector. Reserved before the await so two
    // concurrent submissions cannot both pass.
    let key;
    try {
      key = `${r.electionId}:${BigInt(ballot.nullifier)}`;
    } catch {
      throw new HttpError(400, 'nullifier must be an integer', { code: 'BAD_BALLOT' });
    }
    const receiptKey = String(BigInt(ballot.nullifier));
    const used = () => new HttpError(409, 'a ballot under this nullifier was already cast', { code: 'NULLIFIER_USED' });
    if (this.inFlight.has(key)) throw used();
    this.inFlight.add(key);
    try {
      if (r.receipts[receiptKey]) {
        // Only a ballot the batch rejected may be cast again under the same nullifier.
        const earlier = await this.client.receipt(r.electionId, ballot.nullifier).catch(asHttp);
        if (earlier?.status !== 'rejected') throw used();
      }
      const receipt = await this.client
        .submitBallot({
          electionId: r.electionId,
          nullifier: ballot.nullifier,
          ciphertexts: ballot.ciphertexts,
          proof: ballot.proof,
          eligibility: ballot.eligibility ?? { kind: 'node-vote-pass' },
        })
        .catch(asHttp);
      r.receipts[receiptKey] = { commitment: receipt.commitment, at: this.now() };
      await this.store.persist();
      return receipt;
    } finally {
      this.inFlight.delete(key);
    }
  }

  async receipt(electionId, nullifier) {
    const { r } = this._published(electionId);
    return this.client.receipt(r.electionId, nullifier).catch(asHttp);
  }

  // ----------------------------------------------------------------- results

  /** Idempotent: the node's tick may already have closed the vote; a second request just reads it. */
  async close(electionId) {
    const { r } = this._published(electionId);
    const info = await this.client.election(r.electionId);
    if (!PAST_VOTING.has(info.status)) await this.client.closeElection(r.electionId).catch(asHttp);
    return this.view(electionId);
  }

  async postShares(electionId, index, shares) {
    const { r } = this._published(electionId);
    await this.client.postDecryptionShares(r.electionId, Number(index), bc.fromJSONSafe(shares)).catch(asHttp);
    return this.view(electionId);
  }

  /**
   * Compute the totals from public L1 data (the sum and the guardians' shares) and have
   * L1 check them. Needs `threshold` guardians to have posted.
   */
  async finalize(electionId) {
    const { r } = this._published(electionId);
    const info = await this.client.election(r.electionId);
    // Idempotent like close: the tick may have finalized first.
    if (info.status === 'finalized' || info.status === 'withheld') return this.view(electionId);
    if (info.status !== 'closed') throw new HttpError(409, `the vote is ${info.status}`, { code: 'NOT_CLOSED' });
    const posted = [];
    for (const g of r.guardians) {
      if ((await this.client.guardian(r.electionId, g.index)).sharesPosted) posted.push(g.index);
    }
    if (posted.length < info.threshold) {
      throw new HttpError(409, `${posted.length} of ${info.threshold} guardians have posted shares`, { code: 'THRESHOLD_NOT_MET' });
    }
    const subset = posted.slice(0, info.threshold);
    const accumulator = await this.client.accumulator(r.electionId);
    const sharesByIndex = {};
    for (const g of subset) sharesByIndex[g] = await this.client.decryptionShares(r.electionId, g);
    const totals = bc.openTotals({ accumulator, sharesByIndex, subset, ballotCount: info.ballotCount });
    await this.client.finalizeResult(r.electionId, totals, subset).catch(asHttp);
    return this.view(electionId);
  }

  // ------------------------------------------------------------------- views

  async view(electionId) {
    const election = this.store.requireElection(electionId);
    const r = election.rollup;
    if (!r) return { enabled: this.enabled, published: false };
    const base = {
      enabled: this.enabled,
      published: Boolean(r.electionId),
      threshold: r.threshold,
      minBallots: r.minBallots,
      guardians: r.guardians.map((g) => ({ index: g.index, label: g.label, identityKey: g.identityKey })),
      rollSynced: r.synced.commitments.length,
    };
    if (!r.electionId || !this.client) return base;
    const info = await this.client.election(r.electionId);
    const guardians = [];
    for (const g of base.guardians) {
      const state = await this.client.guardian(r.electionId, g.index);
      const commitments = state.committed ? await this.client.guardianCommitments(r.electionId, g.index) : [];
      guardians.push({ ...g, ...state, commitments });
    }
    const committee = await this.client.committee(r.electionId);
    const result = info.status === 'finalized' ? await this.client.result(r.electionId) : null;
    const closedOrLater = ['closed', 'finalized'].includes(info.status);
    return bc.toJSONSafe({
      ...base,
      l1: { chainId: this.client.chainId, rollup: this.client.address, electionId: r.electionId, ...info },
      committee,
      guardians: guardians.map(({ key, ...g }) => g),
      // The final sum, once L1 holds it. Never a running sum.
      accumulator: closedOrLater ? await this.client.accumulator(r.electionId) : null,
      result,
    });
  }

  // -------------------------------------------------------------- automation

  /** Background step: sync rolls, close after cutoff, finalize once shares are in. */
  async tick() {
    if (!this.client) return;
    for (const election of this.store.listElections()) {
      if (!isRollupElection(election) || !election.rollup.electionId) continue;
      try {
        const info = await this.client.election(election.rollup.electionId);
        const now = await this.client.now();
        if (info.status === 'scheduled' && now < info.startTime) await this.syncRoll(election.id);
        if (info.status === 'scheduled' && now >= info.cutoffTime) await this.close(election.id);
        if (info.status === 'closed') await this.finalize(election.id).catch((err) => {
          if (err.code !== 'THRESHOLD_NOT_MET') throw err;
        });
      } catch (err) {
        this.log(`rollup tick ${election.id}: ${err.message}`);
      }
    }
  }

  _published(electionId) {
    this.requireEnabled();
    const election = this.store.requireElection(electionId);
    const r = election.rollup;
    if (!r?.electionId) throw new HttpError(409, 'this vote is not on L1 yet', { code: 'NOT_PUBLISHED' });
    return { election, r };
  }
}

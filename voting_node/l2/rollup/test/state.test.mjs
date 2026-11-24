// NOT FOR PROFIT — civic public good, not a commercial product.
// L2 state rules: the rules the batch circuit must prove.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as bc from '../../../apps/node/public/ballot-crypto.js';
import { buildBatch } from '../batch.mjs';
import { OP, concat, decodeRequest, splitOps } from '../pubdata.mjs';
import { RollupState } from '../state.mjs';

const ctx = bc.contextOf({ chainId: 31337, rollup: 1n });
const secret = 777n;
const jointKey = bc.mulBase(secret);
const be = (v, n) => {
  const out = new Uint8Array(n);
  let x = BigInt(v);
  for (let i = n - 1; i >= 0; i -= 1) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
};
const create = (id, start = 100, cutoff = 200, options = 3) =>
  concat([Uint8Array.of(OP.CREATE_ELECTION), be(id, 4), be(42, 32), be(start, 8), be(cutoff, 8), Uint8Array.of(options), be(jointKey[0], 32), be(jointKey[1], 32)]);
const register = (id, cs) => concat([Uint8Array.of(OP.REGISTER), be(id, 4), Uint8Array.of(cs.length), ...cs.map((c) => be(c, 32))]);
const disqualify = (id, c) => concat([Uint8Array.of(OP.DISQUALIFY), be(id, 4), be(c, 32), be(5, 2)]);
const close = (id) => concat([Uint8Array.of(OP.CLOSE), be(id, 4)]);

/** Decrypt a sum with the single test key (tests only: the real key is shared). */
function decryptSum(acc, max) {
  return acc.map(([c1, c2]) => bc.discreteLog(bc.sub(c2, bc.mul(c1, secret)), max));
}

const ballot = (id, choice) => bc.encryptBallot({ ctx, electionId: id, jointKey, optionCount: 3, choice });

test('requests decode as Ops.sol lays them out', () => {
  const r = decodeRequest(create(9, 1000, 2000));
  assert.equal(r.electionId, 9);
  assert.equal(r.startTime, 1000);
  assert.equal(r.optionCount, 3);
  assert.deepEqual(r.jointKey, jointKey);
  assert.deepEqual(decodeRequest(register(9, [5n, 6n])).commitments, [5n, 6n]);
});

test('register skips duplicates and disqualified commitments; disqualify zeroes a leaf', () => {
  const s = new RollupState();
  s.applyRequest(create(1));
  s.applyRequest(disqualify(1, 7n));
  s.applyRequest(register(1, [5n, 6n, 5n, 7n]));
  assert.equal(s.election(1).roll.size, 2);
  assert.ok(s.rollPath(1, 6n));
  s.applyRequest(disqualify(1, 6n));
  assert.equal(s.rollPath(1, 6n), null);
  assert.equal(s.election(1).roll.tree.get(1n), 0n);
});

test('ballots count once per nullifier and a revote replaces the vector', () => {
  const s = new RollupState();
  s.applyRequest(create(1));
  s.applyBallot({ electionId: 1, nullifier: 11n, ...ballot(1, 0) }, 150);
  s.applyBallot({ electionId: 1, nullifier: 12n, ...ballot(1, 2) }, 150);
  const before = s.root;
  const again = s.applyBallot({ electionId: 1, nullifier: 11n, ...ballot(1, 1) }, 151);
  assert.equal(again.revote, true);
  assert.notEqual(s.root, before);
  assert.equal(s.election(1).ballotCount, 2);
  assert.deepEqual(decryptSum(s.election(1).accumulator, 2), [0n, 1n, 1n]);
});

test('the window is [startTime, cutoffTime) by batch time, and CLOSE ends it', () => {
  const s = new RollupState();
  s.applyRequest(create(1, 100, 200));
  assert.equal(s.ballotError(1, 99), 'voting has not started');
  assert.equal(s.ballotError(1, 200), 'voting has ended');
  assert.equal(s.ballotError(1, 150), null);
  const res = s.applyRequest(close(1));
  assert.equal(res.ballotCount, 0);
  assert.equal(s.ballotError(1, 150), 'election is closed');
  assert.equal(s.election(1).ballots.size, 0, 'the operator forgets the vectors at close');
});

test('a batch carries nullifiers and commitments only; the sum appears only in CLOSE', () => {
  const s = new RollupState();
  s.applyRequest(create(1));
  const b = ballot(1, 2);
  const built = buildBatch({
    state: s,
    requests: [{ id: 0, pubdata: close(1) }],
    ballots: [],
    timestamp: 150,
  });
  assert.equal(built.onchainOps.length, 10 + 128 * 3);

  const s2 = new RollupState();
  s2.applyRequest(create(1));
  const built2 = buildBatch({ state: s2, requests: [], ballots: [{ electionId: 1, nullifier: 9n, ...b }], timestamp: 150 });
  const [op] = splitOps(built2.pubdata);
  assert.equal(op.type, OP.BALLOT);
  assert.equal(op.bytes.length, 69);
  const hexPub = Buffer.from(built2.pubdata).toString('hex');
  for (const [c1, c2] of b.ciphertexts) {
    for (const w of [c1[0], c2[0]]) assert.ok(!hexPub.includes(w.toString(16).padStart(64, '0')), 'no ciphertext in pubdata');
  }
  assert.equal(built2.onchainOps.length, 0);
});

test('late ballots are rejected from a batch, not applied', () => {
  const s = new RollupState();
  s.applyRequest(create(1, 100, 200));
  const built = buildBatch({ state: s, requests: [], ballots: [{ electionId: 1, nullifier: 9n, ...ballot(1, 0) }], timestamp: 250 });
  assert.equal(built.included.length, 0);
  assert.equal(built.rejected[0].reason, 'voting has ended');
});

test('a forced ballot is applied only with a matching, valid payload', () => {
  const s = new RollupState();
  s.applyRequest(create(1));
  const b = ballot(1, 1);
  const req = { type: OP.FORCED_BALLOT, electionId: 1, nullifier: 5n, commitment: bc.ballotCommitment(b.ciphertexts) };
  assert.equal(s.applyRequest(req, { forcedPayload: 'x', verifyForced: () => null }).accepted, false);
  assert.equal(s.election(1).ballotCount, 0);
  assert.equal(s.applyRequest(req, { forcedPayload: 'x', verifyForced: () => b }).accepted, true);
  assert.equal(s.election(1).ballotCount, 1);
});

test('state survives a save and load with the same root', () => {
  const s = new RollupState();
  s.applyRequest(create(1));
  s.applyRequest(register(1, [5n, 6n]));
  s.applyBallot({ electionId: 1, nullifier: 11n, ...ballot(1, 0) }, 150);
  const copy = RollupState.fromJSON(JSON.parse(JSON.stringify(s.toJSON())));
  assert.equal(copy.root, s.root);
  copy.applyBallot({ electionId: 1, nullifier: 11n, ...ballot(1, 2) }, 150);
  assert.deepEqual(decryptSum(copy.election(1).accumulator, 1), [0n, 0n, 1n], 'revote after reload subtracts the stored vector');
});

test('ballot proofs reject a vote for two options or for none', () => {
  const ok = ballot(1, 0);
  assert.equal(bc.verifyBallot({ ctx, electionId: 1, jointKey, optionCount: 3, ...ok }), true);
  const twice = ballot(1, 0);
  twice.ciphertexts[2] = ballot(1, 2).ciphertexts[2];
  assert.equal(bc.verifyBallot({ ctx, electionId: 1, jointKey, optionCount: 3, ...twice }), false);
  assert.equal(bc.verifyBallot({ ctx, electionId: 2, jointKey, optionCount: 3, ...ok }), false, 'bound to the election');
  assert.equal(bc.verifyBallot({ ctx: bc.contextOf({ chainId: 1, rollup: 1n }), electionId: 1, jointKey, optionCount: 3, ...ok }), false, 'bound to the chain');
});

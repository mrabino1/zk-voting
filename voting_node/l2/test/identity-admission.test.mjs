// NOT FOR PROFIT — civic public good, not a commercial product.
// L2 identity, election keys, strict admission, settlement chaining, funding.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

import { encodeAbiParameters, keccak256, toHex } from 'viem';

import { signAdminCivic, verifyAdminCivic } from '../adminAuth.mjs';
import {
  BATCH_DOMAIN,
  ELECTION_KEY_DOMAIN,
  L2_ID_DOMAIN,
  STATE_DOMAIN,
  computeBatchDigest,
  computeElectionKey,
  computeL2Id,
  computeSettlementDataHash,
  computeSettlementStateRoot,
  resolveIdentity,
  uuidToBytes16,
} from '../identity.mjs';
import { buildBatch } from '../prover/batch.mjs';
import { checkBatchAdmission } from '../prover/admission.mjs';
import { assessFunding } from '../prover/funding.mjs';
import { createWriteLimiter } from '../rpc/server.mjs';
import { ChainState, loadConfig } from '../sequencer/state.mjs';

const OPERATOR = '0x' + 'ab'.repeat(20);
const SQUATTER = '0x' + 'cd'.repeat(20);
const L2_UUID = '3f9c1a52-7b0e-4d61-9a2f-5c8e1b7d4a30';
const ELECTION = 'b5d2c3e4-1f6a-4b7c-8d9e-0a1b2c3d4e5f';
const OTHER_ELECTION = 'c6e3d4f5-2a7b-4c8d-9e0f-1b2c3d4e5f60';
const SALT = '0x' + '11'.repeat(32);
const SECRET = 'test-admin-secret';

function civicHex(obj) {
  return '0x' + Buffer.from(JSON.stringify(obj), 'utf8').toString('hex');
}

describe('identity hashes match Solidity abi.encode', () => {
  test('domain tags are keccak256 of the ASCII tag', () => {
    assert.equal(L2_ID_DOMAIN, keccak256(toHex('zk-voting/l2-id/v1')));
    assert.equal(ELECTION_KEY_DOMAIN, keccak256(toHex('zk-voting/election-key/v1')));
    assert.equal(STATE_DOMAIN, keccak256(toHex('zk-voting/state-root/v1')));
    assert.equal(BATCH_DOMAIN, keccak256(toHex('zk-voting/vote-batch/v1')));
  });

  test('l2Id, electionKey, state root, dataHash, batch digest', () => {
    const l2Id = computeL2Id({ operator: OPERATOR, l2Uuid: L2_UUID, salt: SALT });
    assert.equal(
      l2Id,
      keccak256(
        encodeAbiParameters(
          [{ type: 'bytes32' }, { type: 'address' }, { type: 'bytes16' }, { type: 'bytes32' }],
          [L2_ID_DOMAIN, OPERATOR, uuidToBytes16(L2_UUID), SALT],
        ),
      ),
    );
    const key = computeElectionKey({ l1ChainId: 1, l2Id, electionUuid: ELECTION });
    assert.equal(
      key,
      keccak256(
        encodeAbiParameters(
          [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'bytes16' }],
          [ELECTION_KEY_DOMAIN, 1n, l2Id, uuidToBytes16(ELECTION)],
        ),
      ),
    );
    const prev = '0x' + '00'.repeat(32);
    const pdh = '0x' + '22'.repeat(32);
    const root = computeSettlementStateRoot({ l2Id, prevStateRoot: prev, publicDataHash: pdh });
    assert.equal(
      root,
      keccak256(
        encodeAbiParameters(
          [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }],
          [STATE_DOMAIN, l2Id, prev, pdh],
        ),
      ),
    );
    const dh = computeSettlementDataHash({ batchIndex: 3, prevStateRoot: prev, newStateRoot: root });
    assert.equal(
      dh,
      keccak256(
        encodeAbiParameters([{ type: 'uint64' }, { type: 'bytes32' }, { type: 'bytes32' }], [3n, prev, root]),
      ),
    );
    const registry = '0x' + '99'.repeat(20);
    const digest = computeBatchDigest({
      l1ChainId: 1,
      registry,
      l2Id,
      batchIndex: 3,
      prevStateRoot: prev,
      newStateRoot: root,
      dataHash: dh,
    });
    assert.equal(
      digest,
      keccak256(
        encodeAbiParameters(
          [
            { type: 'bytes32' },
            { type: 'uint256' },
            { type: 'address' },
            { type: 'bytes32' },
            { type: 'uint64' },
            { type: 'bytes32' },
            { type: 'bytes32' },
            { type: 'bytes32' },
          ],
          [BATCH_DOMAIN, 1n, registry, l2Id, 3n, prev, root, dh],
        ),
      ),
    );
  });

  test('a squatter copying UUID + salt gets a different l2Id; keys differ per L2 and per election', () => {
    const mine = computeL2Id({ operator: OPERATOR, l2Uuid: L2_UUID, salt: SALT });
    const theirs = computeL2Id({ operator: SQUATTER, l2Uuid: L2_UUID, salt: SALT });
    assert.notEqual(mine, theirs);
    const a = computeElectionKey({ l1ChainId: 1, l2Id: mine, electionUuid: ELECTION });
    const b = computeElectionKey({ l1ChainId: 1, l2Id: theirs, electionUuid: ELECTION });
    const c = computeElectionKey({ l1ChainId: 1, l2Id: mine, electionUuid: OTHER_ELECTION });
    const d = computeElectionKey({ l1ChainId: 11155111, l2Id: mine, electionUuid: ELECTION });
    assert.equal(new Set([a, b, c, d]).size, 4);
  });

  test('resolveIdentity flags a pinned L2_ID mismatch and never returns the salt', () => {
    const ok = resolveIdentity({ L2_UUID, L2_SALT: SALT, L2_OPERATOR_ADDRESS: OPERATOR });
    assert.equal(ok.configured, true);
    assert.equal(JSON.stringify(ok).includes(SALT.slice(2)), false);
    const bad = resolveIdentity({
      L2_UUID,
      L2_SALT: SALT,
      L2_OPERATOR_ADDRESS: OPERATOR,
      L2_ID: '0x' + '33'.repeat(32),
    });
    assert.equal(bad.configured, false);
    assert.ok(bad.problems.some((p) => p.includes('does not match')));
  });
});

describe('strict admission on the gasless L2', () => {
  const temps = [];
  after(async () => {
    for (const dir of temps) await rm(dir, { recursive: true, force: true });
  });

  async function strictState() {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-l2-admission-'));
    temps.push(tmp);
    const config = loadConfig();
    config.dataDir = tmp;
    config.disclosureIntervalSeconds = 0;
    config.disclosureDelaySeconds = 0;
    config.resultsMinVotes = 0;
    config.disclosureMinBlockVotes = 1;
    config.nowFn = () => 1_700_000_000;
    config.zkVotingNodeUrl = '';
    config.admission = 'strict';
    config.adminSecret = SECRET;
    config.l2Uuid = L2_UUID;
    return ChainState.open(config);
  }

  const sign = (civic, state) =>
    signAdminCivic(civic, { secret: SECRET, chainId: state.config.chainId, l2Uuid: L2_UUID });

  test('admin tx without or with a wrong MAC is rejected', async () => {
    const state = await strictState();
    const open = { type: 'election_open', electionId: ELECTION, eligibleRoot: '0x01' };
    assert.throws(() => state.enqueueRaw(civicHex(open)), /not admitted: admin tx is missing operator auth/);
    const forged = signAdminCivic(open, { secret: 'wrong', chainId: state.config.chainId, l2Uuid: L2_UUID });
    assert.throws(() => state.enqueueRaw(civicHex(forged)), /does not verify/);
    // A MAC for another L2 (different UUID) does not replay here.
    const otherL2 = signAdminCivic(open, {
      secret: SECRET,
      chainId: state.config.chainId,
      l2Uuid: '00000000-0000-4000-8000-000000000000',
    });
    assert.throws(() => state.enqueueRaw(civicHex(otherL2)), /does not verify/);
  });

  test('election UUIDs are unique per L2 and must be UUIDs', async () => {
    const state = await strictState();
    state.enqueueRaw(civicHex(sign({ type: 'election_open', electionId: ELECTION, eligibleRoot: '0x01' }, state)));
    assert.throws(
      () => state.enqueueRaw(civicHex(sign({ type: 'election_open', electionId: ELECTION, eligibleRoot: '0x02' }, state))),
      /already exists/,
    );
    assert.throws(
      () => state.enqueueRaw(civicHex(sign({ type: 'election_open', electionId: '7' }, state))),
      /must be a UUID/,
    );
  });

  test('votes need an opened election and an approved eligibility root', async () => {
    const state = await strictState();
    const vote = (electionId, eligibleRoot, n) =>
      civicHex({ type: 'vote', electionId, eligibleRoot, nullifier: `0x${n}`, ballotCommitment: '0xaa' });
    assert.throws(() => state.enqueueRaw(vote(ELECTION, '0x01', 'a1')), /unknown election/);
    state.enqueueRaw(civicHex(sign({ type: 'election_open', electionId: ELECTION, eligibleRoot: '0x01' }, state)));
    assert.throws(() => state.enqueueRaw(vote(ELECTION, '0x02', 'a2')), /not an approved voter set/);
    assert.throws(() => state.enqueueRaw(vote(OTHER_ELECTION, '0x01', 'a3')), /unknown election/);
    const h = state.enqueueRaw(vote(ELECTION, '0x01', 'a4'));
    assert.match(h, /^0x[0-9a-f]{64}$/);
    // Junk bytes become a userop with no election: rejected.
    assert.throws(() => state.enqueueRaw('0xdeadbeef'), /not admitted/);
    await state.produceBlock();
    const info = state.electionInfo(ELECTION);
    assert.equal(info.electionUuid, ELECTION);
  });

  test('open mode (default) keeps the legacy behaviour', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-l2-open-'));
    temps.push(tmp);
    const config = loadConfig();
    config.dataDir = tmp;
    config.zkVotingNodeUrl = '';
    config.admission = 'open';
    const state = ChainState.open(config);
    assert.match(state.enqueueRaw(civicHex({ type: 'register', electionId: '7', identityCommitment: '0x1' })), /^0x/);
  });

  test('admin MAC verify helper', () => {
    const civic = signAdminCivic({ type: 'tally', electionId: ELECTION }, { secret: SECRET, chainId: 1, l2Uuid: L2_UUID });
    assert.equal(verifyAdminCivic(civic, { secret: SECRET, chainId: 1, l2Uuid: L2_UUID }).ok, true);
    assert.equal(verifyAdminCivic({ ...civic, electionId: OTHER_ELECTION }, { secret: SECRET, chainId: 1, l2Uuid: L2_UUID }).ok, false);
    assert.equal(verifyAdminCivic(civic, { secret: '', chainId: 1, l2Uuid: L2_UUID }).ok, false);
  });
});

describe('prover: settlement values, admission re-check, funding', () => {
  const l2Id = computeL2Id({ operator: OPERATOR, l2Uuid: L2_UUID, salt: SALT });
  const identity = { l2Id, l2Uuid: L2_UUID, l1ChainId: '1' };
  const blk = (n, txs) => ({
    number: '0x' + n.toString(16),
    hash: '0x' + String(n).padStart(64, '0'),
    stateRoot: '0x' + String(n).padStart(64, '1'),
    timestamp: '0x1',
    transactions: txs,
  });
  const tx = (h, civic) => ({
    hash: '0x' + h.padStart(64, '0'),
    civicType: civic.type,
    civic,
    input: civicHex(civic),
  });

  test('batch.settlement chains roots and matches RollupSettlement dataHash', () => {
    const b0 = buildBatch({
      batchIndex: 0,
      blocks: [blk(1, [tx('1', { type: 'vote', electionId: ELECTION, nullifier: '0x1' })])],
      prevStateRoot: '0x' + '00'.repeat(32),
      identity,
    });
    assert.equal(b0.settlement.prevStateRoot, '0x' + '00'.repeat(32));
    assert.equal(
      b0.settlement.dataHash,
      computeSettlementDataHash({ batchIndex: 0, prevStateRoot: b0.settlement.prevStateRoot, newStateRoot: b0.settlement.newStateRoot }),
    );
    assert.equal(b0.publicData.elections[0].electionKey, computeElectionKey({ l1ChainId: 1, l2Id, electionUuid: ELECTION }));
    assert.equal(b0.publicData.identity.l2Id, l2Id);
    const b1 = buildBatch({
      batchIndex: 1,
      blocks: [blk(2, [tx('2', { type: 'vote', electionId: ELECTION, nullifier: '0x2' })])],
      prevStateRoot: b0.newStateRoot,
      identity,
      prevSettlementRoot: b0.settlement.newStateRoot,
    });
    assert.equal(b1.settlement.prevStateRoot, b0.settlement.newStateRoot, 'L1 prev root = last accepted root');
    assert.notEqual(b1.settlement.newStateRoot, b0.settlement.newStateRoot);
  });

  test('admission re-check fails closed on forged admin txs and unknown elections', async () => {
    const opts = { admission: 'strict', adminSecret: SECRET, chainId: 27427, l2Uuid: L2_UUID, getElection: async () => null };
    const forged = { type: 'register', electionId: ELECTION, identityCommitment: '0x1', auth: { v: 1, mac: 'ab'.repeat(32) } };
    let r = await checkBatchAdmission([blk(1, [tx('1', forged)])], opts);
    assert.equal(r.ok, false);
    const signedOpen = signAdminCivic({ type: 'election_open', electionId: ELECTION }, { secret: SECRET, chainId: 27427, l2Uuid: L2_UUID });
    r = await checkBatchAdmission(
      [blk(1, [tx('1', signedOpen), tx('2', { type: 'vote', electionId: ELECTION, nullifier: '0x9' })])],
      opts,
    );
    assert.equal(r.ok, true);
    r = await checkBatchAdmission([blk(1, [tx('3', { type: 'vote', electionId: OTHER_ELECTION })])], opts);
    assert.equal(r.ok, false);
    r = await checkBatchAdmission([blk(1, [tx('3', { type: 'vote', electionId: OTHER_ELECTION })])], { ...opts, admission: 'open' });
    assert.equal(r.ok, true);
  });

  test('funding levels', () => {
    const gp = 10n ** 9n; // 1 gwei
    assert.equal(assessFunding({ balanceWei: 0n, gasPriceWei: gp }).level, 'empty');
    assert.equal(assessFunding({ balanceWei: 250_000n * gp - 1n, gasPriceWei: gp }).level, 'empty');
    assert.equal(assessFunding({ balanceWei: 250_000n * gp * 3n, gasPriceWei: gp }).level, 'low');
    const ok = assessFunding({ balanceWei: 10n ** 17n, gasPriceWei: gp });
    assert.equal(ok.level, 'ok');
    assert.equal(ok.batchesLeft, 400);
  });

  test('write limiter', () => {
    let t = 0;
    const allow = createWriteLimiter(2, () => t);
    assert.equal(allow('a'), true);
    assert.equal(allow('a'), true);
    assert.equal(allow('a'), false);
    assert.equal(allow('b'), true);
    t = 30_000;
    assert.equal(allow('a'), true);
    assert.equal(createWriteLimiter(0)('x'), true);
  });
});

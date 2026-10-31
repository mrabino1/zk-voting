// NOT FOR PROFIT — civic public good, not a commercial product.
// Sealed ranked-choice (IRV): RK envelopes, ranking partials, tally, chain commit.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { aggregateCiphertexts, encryptAggregateBallot } from '../src/aggregateBallot.mjs';
import { partialDecrypt } from '../src/guardians/threshold.mjs';
import { createSealedDeal, finalizeShare, initGuardian } from '../src/guardians/index.mjs';
import { createApp } from '../src/server.mjs';
import { decryptRankingEnvelope, encryptRankingEnvelope, isRankingEnvelope, rankingEnvelopeBytes } from '../public/ranked-envelope.js';
import { rankingTag } from '../src/rankedTally.mjs';
import { rankedBatchGas, sortedRankingHashes } from '../src/chain.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { computeIrv } from '../src/irv.mjs';
import { createChain } from '../src/chain.mjs';

let tmp;
let app;
let store;
let server;
let base;
const adminJar = {};

function applyCookies(res, jar) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const c of list) {
    const pair = c.split(';')[0];
    const i = pair.indexOf('=');
    if (i === -1) continue;
    jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
}

function cookieHeader(jar) {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

async function api(method, url, { body, jar } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(jar ? { cookie: cookieHeader(jar) } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (jar) applyCookies(res, jar);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { json, status: res.status, text };
}

function listen(application) {
  return new Promise((resolve, reject) => {
    const s = application.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

async function voteEncrypted(electionId, nullifier, envelopeHex, identityCommitment) {
  return api('POST', `/api/elections/${electionId}/vote`, {
    body: {
      proof: { accept: true },
      publicInputs: { nullifier, electionId },
      encryptedBallot: envelopeHex,
      identityCommitment,
    },
  });
}

async function registerVoter(electionId, identityCommitment) {
  const res = await api('POST', `/api/elections/${electionId}/register`, {
    jar: adminJar,
    body: { identityCommitment },
  });
  if (res.status === 202) {
    const approved = await api(
      'POST',
      `/api/elections/${electionId}/registration-requests/${res.json.request.id}/approve`,
      { jar: adminJar, body: {} },
    );
    assert.equal(approved.status, 200, approved.text);
    return approved;
  }
  assert.equal(res.status, 201, res.text);
  return res;
}

async function establishGuardians(electionId, { guardians = 3, threshold = 2 } = {}) {
  const secrets = [];
  for (let i = 1; i <= guardians; i++) {
    secrets.push(await initGuardian({ index: i, guardianId: `g${i}` }));
  }
  for (const secret of secrets) {
    const enrolled = await api('POST', `/api/elections/${electionId}/guardians`, {
      jar: adminJar,
      body: {
        guardianId: secret.guardianId,
        label: secret.guardianId,
        transportPublicKey: secret.transportPublicKey,
      },
    });
    assert.equal(enrolled.status, 201, enrolled.text);
  }
  const roster = secrets.map((secret) => ({
    index: secret.index,
    transportPublicKey: secret.transportPublicKey,
  }));
  const deals = [];
  for (const secret of secrets) {
    const deal = await createSealedDeal({ index: secret.index, threshold, roster });
    deals.push(deal);
    const posted = await api('POST', `/api/elections/${electionId}/guardians/deals`, {
      jar: adminJar,
      body: deal,
    });
    assert.equal(posted.status, 201, posted.text);
  }
  const shares = [];
  for (const secret of secrets) {
    shares.push(
      await finalizeShare({
        index: secret.index,
        privateJwk: secret.transportPrivateJwk,
        deals,
        threshold,
        guardianCount: guardians,
      }),
    );
  }
  return shares;
}

function partialBody(share, electionId, envelopes) {
  const product = aggregateCiphertexts(envelopes.map((env) => env.encryptedBallot));
  return {
    index: share.index,
    partials: product.options.map((opt, j) =>
      partialDecrypt({
        shareScalar: share.shareScalar,
        index: share.index,
        electionId,
        ballotHash: `aggregate:${j}`,
        jointPublicKey: share.jointPublicKey,
        ephemeral: opt.c1Hex,
      }),
    ),
  };
}

function rankingPartialBody(share, electionId, rankings) {
  // Guardians work from the published `rankings` list (random ids, sorted).
  return {
    index: share.index,
    partials: rankings.map((row) =>
      partialDecrypt({
        shareScalar: share.shareScalar,
        index: share.index,
        electionId,
        ballotHash: rankingTag(row.rankingId),
        jointPublicKey: share.jointPublicKey,
        ephemeral: `0x${row.rankingEnvelope.slice(2 + 6, 2 + 6 + 130)}`,
      }),
    ),
  };
}

const OPTIONS = ['a', 'b', 'c', 'd'];
const QUESTIONS = [
  { id: 'q-seat', type: 'RANKED', prompt: 'Rank the seat', options: OPTIONS.map((id) => ({ id, label: id.toUpperCase() })) },
];

const CAST_R = new Set();

/** A bound ranked ballot: the ranking hash is folded into the AG tag. */
async function sealedPair(pub, electionId, ranking, { firstChoice, seed = 1n, swapTo } = {}) {
  const first = firstChoice ?? ranking[0] ?? 'a';
  const index = OPTIONS.indexOf(first);
  // Distinctive tag randomness so a leak of r into any published output is detectable.
  const r = 7n * 10n ** 40n + BigInt(seed);
  CAST_R.add(r);
  const rk = await encryptRankingEnvelope({
    jointPublicKey: pub,
    electionId,
    answers: [{ questionId: 'q-seat', ranking }],
    questions: QUESTIONS,
    first: { index, r: r.toString() },
  });
  const ag = encryptAggregateBallot({
    jointPublicKey: pub,
    choice: index,
    choiceRandomness: r,
    nOptions: OPTIONS.length,
    bindHash: rk.rankingHash,
  });
  let sent = rk;
  if (swapTo) {
    // Same first choice and r, different ranking: hash no longer matches the tag.
    sent = await encryptRankingEnvelope({
      jointPublicKey: pub,
      electionId,
      answers: [{ questionId: 'q-seat', ranking: swapTo }],
      questions: QUESTIONS,
      first: { index, r: r.toString() },
    });
  }
  return { ag, rk: sent, bound: rk };
}

async function castRanked(electionId, pub, nullifier, ranking, commitment, opts = {}) {
  const { ag, rk } = await sealedPair(pub, electionId, ranking, { seed: BigInt(nullifier), ...opts });
  const res = await api('POST', `/api/elections/${electionId}/vote`, {
    body: {
      proof: { accept: true },
      publicInputs: { nullifier, electionId },
      encryptedBallot: ag.encryptedBallot,
      encryptedRanking: rk.rankingEnvelope,
      identityCommitment: commitment,
    },
  });
  return { res, rk };
}

describe('ranking envelope (RK)', () => {
  test('round-trips through a combined guardian point; padding hides ranking length', async () => {
    const { p256 } = await import('@noble/curves/p256');
    const x = 0x1234567n;
    const Y = `0x${Buffer.from(p256.ProjectivePoint.BASE.multiply(x).toRawBytes(false)).toString('hex')}`;
    const qs = [{ id: 'q', type: 'RANKED', options: ['a', 'b', 'c', 'd'].map((id) => ({ id })) }];
    const one = await encryptRankingEnvelope({
      jointPublicKey: Y, electionId: 'e1', questions: qs, first: { index: 0, r: '1' },
      answers: [{ questionId: 'q', ranking: ['a'] }],
    });
    const all = await encryptRankingEnvelope({
      jointPublicKey: Y,
      electionId: 'e1',
      questions: qs,
      first: { index: 3, r: '9'.repeat(76) },
      answers: [{ questionId: 'q', ranking: ['a', 'b', 'c', 'd'] }],
    });
    assert.ok(isRankingEnvelope(one.rankingEnvelope));
    // One fixed envelope size per election, independent of ranking length or r.
    assert.equal(one.rankingEnvelope.length, all.rankingEnvelope.length);
    assert.equal((all.rankingEnvelope.length - 2) / 2, rankingEnvelopeBytes(qs));
    assert.match(one.rankingHash, /^0x[0-9a-f]{64}$/);
    const c1 = p256.ProjectivePoint.fromHex(all.rankingEnvelope.slice(8, 8 + 130));
    const shared = c1.multiply(x).toRawBytes(false);
    const opened = await decryptRankingEnvelope({ envelope: all.rankingEnvelope, electionId: 'e1', sharedPoint: shared });
    assert.deepEqual(opened, [{ questionId: 'q', ranking: ['a', 'b', 'c', 'd'] }]);
    // A ranking that cannot fit the fixed pad is refused, never grown.
    await assert.rejects(
      encryptRankingEnvelope({
        jointPublicKey: Y, electionId: 'e1', questions: qs, first: { index: 0, r: '1' },
        answers: [{ questionId: 'q', ranking: ['x'.repeat(5000)] }],
      }),
      (err) => err.code === 'BAD_RANKING',
    );
    await assert.rejects(
      decryptRankingEnvelope({ envelope: all.rankingEnvelope, electionId: 'e2', sharedPoint: shared }),
      /did not decrypt/,
    );
    const tampered = `${all.rankingEnvelope.slice(0, -2)}${all.rankingEnvelope.endsWith('00') ? '01' : '00'}`;
    await assert.rejects(
      decryptRankingEnvelope({ envelope: tampered, electionId: 'e1', sharedPoint: shared }),
      /did not decrypt/,
    );
  });

  test('IRV ties break deterministically and exhausted ballots are counted', () => {
    const tie = computeIrv(['a', 'b'], [['a'], ['b']]);
    assert.equal(tie.winner, 'a');
    assert.equal(tie.tieBroken, true);
    const ex = computeIrv(['a', 'b', 'c'], [['a'], ['a'], ['b'], ['b', 'a'], ['c'], ['c']]);
    assert.ok(ex.exhausted >= 1);
  });
});

async function createRankedElection(extra = {}) {
  return api('POST', '/api/elections', {
    jar: adminJar,
    body: {
      title: 'Sealed IRV',
      startTime: nowSec() - 10,
      cutoffTime: nowSec() + 3600,
      ballotMethod: 'ranked_choice',
      questions: QUESTIONS,
      jurisdictionId: 'demo',
      tallyScheme: 'opens_ballots',
      threshold: 2,
      guardianCount: 3,
      ...extra,
    },
  });
}

describe('sealed ranked-choice tally (guardian threshold)', () => {
  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-ranked-sealed-'));
    const created = await createApp({
      dataDir: tmp,
      allowDevLogin: true,
      adminHandle: 'admin',
      quiet: true,
      port: 0,
      disclosureIntervalSeconds: 0,
      allowRevote: true,
    });
    created.store.allowRevote = true;
    app = created.app;
    store = created.store;
    server = await listen(app);
    base = `http://127.0.0.1:${server.address().port}`;
    const login = await api('POST', '/api/auth/dev-login', {
      body: { handle: 'ranked-admin', role: 'platform_admin' },
      jar: adminJar,
    });
    assert.equal(login.status, 200, login.text);
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await rm(tmp, { recursive: true, force: true });
  });

  test('sealed vote with the setting off: no rankings accepted, ranked tally disabled', async () => {
    // Turning the setting on without the acknowledgment is refused.
    const noAck = await createRankedElection({ electionType: 1, sealedRankedChoice: true });
    assert.equal(noAck.status, 400, noAck.text);
    assert.equal(noAck.json.code, 'DISCLOSURE_ACK_REQUIRED');

    const created = await createRankedElection({ electionType: 1 });
    assert.equal(created.status, 201, created.text);
    const electionId = created.json.election.id;
    assert.notEqual(store.requireElection(electionId).sealedRankedChoice, true);
    await establishGuardians(electionId);
    const pub = store.requireElection(electionId).tallyPubKey;
    const commitment = '0xf01';
    await registerVoter(electionId, commitment);
    const freeze = await api('POST', `/api/elections/${electionId}/freeze`, { jar: adminJar });
    assert.equal(freeze.status, 200, freeze.text);
    const { res } = await castRanked(electionId, pub, 3001, ['a', 'b'], commitment);
    assert.equal(res.status, 400, res.text);
    assert.equal(res.json.code, 'RANKING_NOT_ALLOWED');
    const election = store.requireElection(electionId);
    election.cutoffTime = nowSec() - 1;
    await store.persist();
    const tallied = await api('POST', `/api/elections/${electionId}/tally`, { jar: adminJar, body: {} });
    assert.equal(tallied.status, 409, tallied.text);
    assert.equal(tallied.json.code, 'RANKED_TALLY_DISABLED');
  });

  test('setting is bound into ballotSpecHash and locked after creation', async () => {
    const off = await createRankedElection({ electionType: 1 });
    const on = await createRankedElection({ electionType: 1, sealedRankedChoice: true, sealedRankedDisclosureAck: true });
    assert.equal(on.status, 201, on.text);
    const a = store.requireElection(off.json.election.id);
    const b = store.requireElection(on.json.election.id);
    assert.equal(b.sealedRankedChoice, true);
    assert.ok(a.ballotSpecHash && b.ballotSpecHash);
    assert.notEqual(a.ballotSpecHash, b.ballotSpecHash);
    const patched = await api('PATCH', `/api/elections/${b.id}`, { jar: adminJar, body: { sealedRankedChoice: false } });
    assert.equal(patched.status, 409, patched.text);
    assert.equal(patched.json.code, 'SETTING_LOCKED');
  });

  test('opt-in sealed vote: 4-option IRV end to end, re-vote, swap rejected, no nullifier linkage', async () => {
    const created = await createRankedElection({ electionType: 1, sealedRankedChoice: true, sealedRankedDisclosureAck: true });
    assert.equal(created.status, 201, created.text);
    const electionId = created.json.election.id;
    const shares = await establishGuardians(electionId, { guardians: 3, threshold: 2 });
    const pub = store.requireElection(electionId).tallyPubKey;

    const stacks = [['a', 'b'], ['a', 'b'], ['a'], ['b', 'c'], ['b', 'c'], ['b', 'a'], ['c', 'b'], ['c', 'b'], ['d']];
    const commitments = [...stacks, null, null].map((_, i) => `0x${(0xc01 + i).toString(16)}`);
    for (const c of commitments) await registerVoter(electionId, c);
    const freeze = await api('POST', `/api/elections/${electionId}/freeze`, { jar: adminJar });
    assert.equal(freeze.status, 200, freeze.text);

    const bare = encryptAggregateBallot({ jointPublicKey: pub, choice: 0, choiceRandomness: 9n, nOptions: 4 });
    const noRanking = await voteEncrypted(electionId, 77, bare.encryptedBallot, commitments[0]);
    assert.equal(noRanking.status, 400, noRanking.text);
    assert.equal(noRanking.json.code, 'RANKING_REQUIRED');
    const badRanking = await api('POST', `/api/elections/${electionId}/vote`, {
      body: {
        proof: { accept: true },
        publicInputs: { nullifier: 78, electionId },
        encryptedBallot: bare.encryptedBallot,
        encryptedRanking: '0x524b01',
        identityCommitment: commitments[0],
      },
    });
    assert.equal(badRanking.status, 400, badRanking.text);
    assert.equal(badRanking.json.code, 'BAD_RANKING');
    // A well-formed envelope with the wrong (larger) padding is refused.
    const bigger = await encryptRankingEnvelope({
      jointPublicKey: pub,
      electionId,
      questions: [...QUESTIONS, { ...QUESTIONS[0], id: 'q-extra' }],
      first: { index: 0, r: '1' },
      answers: [{ questionId: 'q-seat', ranking: ['a'] }],
    });
    const wrongSize = await api('POST', `/api/elections/${electionId}/vote`, {
      body: {
        proof: { accept: true },
        publicInputs: { nullifier: 79, electionId },
        encryptedBallot: bare.encryptedBallot,
        encryptedRanking: bigger.rankingEnvelope,
        identityCommitment: commitments[0],
      },
    });
    assert.equal(wrongSize.status, 400, wrongSize.text);
    assert.equal(wrongSize.json.code, 'BAD_RANKING');

    const nullifiers = [];
    for (let i = 0; i < stacks.length; i++) {
      if (i === 5) {
        // Voter 5 first casts ['d'], then re-votes ['b','a']: last vote counts.
        const first = await castRanked(electionId, pub, 2000 + i, ['d'], commitments[i]);
        assert.equal(first.res.status, 201, first.res.text);
        nullifiers.push(String(first.res.json.vote.nullifier));
        const { ag, rk } = await sealedPair(pub, electionId, stacks[i], { seed: 77n });
        const stored = store.findVote(electionId, first.res.json.vote.nullifier);
        const spent = store.votePassSpent;
        store.votePassSpent = () => true;
        try {
          await store.replaceVote(
            { ...stored, electionId, spentPassHash: '0x01', ballotHash: `0x${'ab'.repeat(32)}` },
            { encryptedBallot: ag.encryptedBallot, rankingEnvelope: rk.rankingEnvelope, rankingHash: rk.rankingHash },
          );
        } finally {
          store.votePassSpent = spent;
        }
        continue;
      }
      const { res, rk } = await castRanked(electionId, pub, 2000 + i, stacks[i], commitments[i]);
      assert.equal(res.status, 201, res.text);
      assert.equal(res.json.rankingHash, rk.rankingHash);
      assert.equal(JSON.stringify(res.json).includes('"ranking"'), false);
      nullifiers.push(String(res.json.vote.nullifier));
    }
    // First choice 'a' in the one-hot, but the ranking starts with 'z': fatal for this ballot.
    const rogue = await castRanked(electionId, pub, 2100, ['z'], commitments[stacks.length], { firstChoice: 'a' });
    assert.equal(rogue.res.status, 201, rogue.res.text);
    // Swap: the AG tag binds ['c','b'] but a different ranking ['d'] is sent.
    const swap = await castRanked(electionId, pub, 2101, ['c', 'b'], commitments[stacks.length + 1], { swapTo: ['d'] });
    assert.equal(swap.res.status, 201, swap.res.text);

    const election = store.requireElection(electionId);
    election.cutoffTime = nowSec() - 1;
    await store.persist();

    // Guardian download: rankings in a separate list, sorted by random id, no nullifier.
    const dl = await api('GET', `/api/elections/${electionId}/envelopes`, { jar: adminJar });
    assert.equal(dl.status, 200, dl.text);
    const { envelopes, rankings } = dl.json;
    assert.equal(rankings.length, stacks.length + 2);
    const ids = rankings.map((row) => row.rankingId);
    assert.deepEqual([...ids].sort(), ids);
    for (const row of rankings) assert.deepEqual(Object.keys(row).sort(), ['rankingEnvelope', 'rankingId']);
    for (const row of envelopes) {
      for (const k of ['rankingEnvelope', 'rankingHash', 'rankingId', 'tallyRankingEnvelope', 'tallyRankingId']) {
        assert.equal(k in row, false, k);
      }
    }
    const rankingsJson = JSON.stringify(rankings);
    for (const n of nullifiers) assert.equal(rankingsJson.includes(n), false);
    assert.equal(rankingsJson.includes('nullifier'), false);
    assert.equal(rankingsJson.includes('ranking:'), false);

    for (const share of shares.slice(0, 2)) {
      const posted = await api('POST', `/api/elections/${electionId}/guardians/partials`, {
        jar: adminJar,
        body: partialBody(share, electionId, envelopes.map((env) => ({ encryptedBallot: env.tallyEncryptedBallot || env.encryptedBallot }))),
      });
      assert.equal(posted.status, 201, posted.text);
    }
    const r1 = await api('POST', `/api/elections/${electionId}/guardians/partials`, {
      jar: adminJar,
      body: rankingPartialBody(shares[0], electionId, rankings),
    });
    assert.equal(r1.status, 201, r1.text);
    const early = await api('POST', `/api/elections/${electionId}/tally`, { jar: adminJar, body: {} });
    assert.equal(early.status, 409, early.text);
    assert.equal(early.json.code, 'THRESHOLD_NOT_MET');

    const wrong = rankingPartialBody(shares[1], electionId, rankings);
    wrong.partials[0] = { ...wrong.partials[1], ballotHash: wrong.partials[0].ballotHash };
    const refused = await api('POST', `/api/elections/${electionId}/guardians/partials`, { jar: adminJar, body: wrong });
    assert.equal(refused.status, 400, refused.text);

    const r2 = await api('POST', `/api/elections/${electionId}/guardians/partials`, {
      jar: adminJar,
      body: rankingPartialBody(shares[1], electionId, rankings),
    });
    assert.equal(r2.status, 201, r2.text);

    const tallied = await api('POST', `/api/elections/${electionId}/tally`, { jar: adminJar, body: {} });
    assert.equal(tallied.status, 200, tallied.text);
    const tally = store.requireElection(electionId).tally;
    const q = tally.questions.find((row) => row.questionId === 'q-seat');
    assert.equal(q.ballotMethod, 'ranked_choice');
    assert.equal(q.winner, 'b');
    assert.ok(q.exhausted >= 3, `exhausted ${q.exhausted}`);
    assert.equal(tally.ranked.rankedBallots, stacks.length + 2);
    assert.equal(tally.ranked.invalidRankings, 2);
    assert.equal(tally.ranked.swappedRankings, 1);
    assert.equal(tally.ranked.firstChoiceMismatches, 1);
    assert.equal(tally.ranked.firstChoiceConsistent, false);
    assert.match(tally.ranked.rankingSetHash, /^0x[0-9a-f]{64}$/);
    assert.match(tally.ranked.roundsHash, /^0x[0-9a-f]{64}$/);
    assert.match(tally.ranked.verification, /recomputable, not ZK proof-verified; no verified shuffle/);
    assert.deepEqual(tally.counts, [4, 3, 3, 1]);
    // Published output: sorted canonical lines and sorted hashes, no ids, no nullifiers.
    const published = JSON.stringify(tally.ranked);
    for (const n of nullifiers) assert.equal(published.includes(`"${n}"`), false);
    for (const id of ids) assert.equal(published.includes(id.slice(2)), false);
    assert.equal(published.includes('nullifier'), false);
    // The tag randomness r never leaves the opener: not in the opened set, the result or the tally.
    const everything = JSON.stringify(tally);
    assert.ok(CAST_R.size >= stacks.length);
    for (const r of CAST_R) {
      assert.equal(everything.includes(r.toString()), false, 'r (decimal) published');
      assert.equal(everything.includes(r.toString(16)), false, 'r (hex) published');
    }
    assert.equal(/"(first|r)"\s*:/.test(published), false);
    const lines = tally.ranked.openedRankings || [];
    assert.deepEqual([...lines].sort(), lines);
    const hashes = tally.ranked.rankingHashes || [];
    assert.deepEqual([...hashes].sort(), hashes);
  });

  test('poll: sealed rankings work without the opt-in', async () => {
    const created = await createRankedElection({});
    assert.equal(created.status, 201, created.text);
    const electionId = created.json.election.id;
    await establishGuardians(electionId);
    const pub = store.requireElection(electionId).tallyPubKey;
    await registerVoter(electionId, '0xe01');
    await api('POST', `/api/elections/${electionId}/freeze`, { jar: adminJar });
    const { res } = await castRanked(electionId, pub, 4001, ['b', 'a'], '0xe01');
    assert.equal(res.status, 201, res.text);
  });
});

describe('ranking hashes ride the ballot batches', () => {
  const INBOX = '0x0000000000000000000000000000000000000001';
  const h = (b) => `0x${b.repeat(32)}`;

  test('hourly batch carries sorted ranking hashes; interval 0 sends a batch of one', async () => {
    const sent = [];
    const chain = createChain(
      { chainRpc: 'http://127.0.0.1:9', ballotInboxAddress: INBOX, disclosureIntervalSeconds: 3600, chainId: 31337, nowFn: () => 10_000, quiet: true },
      { writeSubmitBatch: async ({ batch }) => { sent.push(batch); return { hash: '0xabc', batched: true, count: batch.length }; } },
    );
    const vote = (n, rankingHash) => ({
      electionId: '7', proof: { accept: true }, publicInputs: [1n, 2n, BigInt(n), 4n, 5n],
      encryptedBallot: '0x01', rankingHash, startTime: 0, cutoffTime: 99_999, now: 100,
    });
    await chain.submitVote(vote(1, h('cc')));
    await chain.submitVote(vote(2, h('11')));
    await chain.submitVote(vote(3, h('77')));
    assert.equal(sent.length, 0);
    await chain.flushVoteQueue(3600);
    assert.equal(sent.length, 1);
    assert.deepEqual(sortedRankingHashes(sent[0]), [h('11'), h('77'), h('cc')]);

    const now = [];
    const instant = createChain(
      { chainRpc: 'http://127.0.0.1:9', ballotInboxAddress: INBOX, disclosureIntervalSeconds: 0, chainId: 31337, quiet: true },
      { writeSubmitBatch: async ({ batch }) => { now.push(batch); return { hash: '0xdef' }; } },
    );
    await instant.submitVote(vote(9, h('aa')));
    assert.equal(now.length, 1);
    assert.equal(now[0][0].rankingHash, h('aa'));
  });

  test('sortedRankingHashes sorts, skips unranked rows, throws on bad or zero hashes; ranked gas default 24M, ceiling 200M', () => {
    assert.deepEqual(sortedRankingHashes([{ rankingHash: h('22') }, { rankingHash: h('0a') }, {}]), [h('0a'), h('22')]);
    assert.throws(() => sortedRankingHashes([{ rankingHash: h('22') }, { rankingHash: '0x12', nullifier: '5' }]), (e) => e.code === 'BAD_RANKING_HASH' && e.nullifiers[0] === '5');
    assert.throws(() => sortedRankingHashes([{ rankingHash: h('00') }]), /BAD_RANKING_HASH/);
    assert.equal(rankedBatchGas({}), 24_000_000n);
    assert.equal(rankedBatchGas({ rankedBatchGas: '30000000' }), 30_000_000n);
    assert.equal(rankedBatchGas({ rankedBatchGas: '900000000' }), 200_000_000n);
    assert.equal(typeof createChain({ chainRpc: '', quiet: true }).commitRankings, 'undefined');
  });
});

describe('guardian CLI skips excluded and deleted envelopes', () => {
  test('partial counts only live envelopes and rankings', async () => {
    const { p256 } = await import('@noble/curves/p256');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-guardian-cli-'));
    try {
      const x = 0x2345n;
      const Y = `0x${Buffer.from(p256.ProjectivePoint.BASE.multiply(x).toRawBytes(false)).toString('hex')}`;
      const ag = () => encryptAggregateBallot({ jointPublicKey: Y, choice: 0, choiceRandomness: 3n, nOptions: 2 }).encryptedBallot;
      const live = ag();
      const rk = await encryptRankingEnvelope({
        jointPublicKey: Y, electionId: 'e1', questions: QUESTIONS, first: { index: 0, r: '3' },
        answers: [{ questionId: 'q-seat', ranking: ['a'] }],
      });
      const doc = {
        envelopes: [
          { ballotHash: '0x01', encryptedBallot: live },
          { ballotHash: '0x02', encryptedBallot: '0xdeadbeef', excluded: true },
          { ballotHash: '0x03', encryptedBallot: '0xdeadbeef', is_deleted: true },
        ],
        rankings: [
          { rankingId: '0x01', rankingEnvelope: rk.rankingEnvelope },
          { rankingId: '0x02', rankingEnvelope: rk.rankingEnvelope, excluded: true },
          { rankingId: '0x03', rankingEnvelope: rk.rankingEnvelope, is_deleted: true },
        ],
      };
      const share = { index: 1, shareScalar: '0x05', jointPublicKey: Y };
      await writeFile(path.join(dir, 'env.json'), JSON.stringify(doc));
      await writeFile(path.join(dir, 'share.json'), JSON.stringify(share));
      const script = fileURLToPath(new URL('../scripts/guardian.mjs', import.meta.url));
      await promisify(execFile)(process.execPath, [
        script, 'partial', '--share', path.join(dir, 'share.json'), '--election', 'e1',
        '--envelopes', path.join(dir, 'env.json'), '--out', path.join(dir, 'out.json'),
      ]);
      const out = JSON.parse(await readFile(path.join(dir, 'out.json'), 'utf8'));
      // 2 aggregate option partials + 1 live ranking.
      assert.equal(out.partials.length, 3);
      assert.deepEqual(out.partials.filter((p) => String(p.ballotHash).startsWith('ranking:')).map((p) => p.ballotHash), ['ranking:0x01']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('sealed ranked disclosure: one localized source', () => {
  test('server, ballot and back office share the catalog text; every locale has it', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const { SEALED_RANKED_DISCLOSURE } = await import('../src/rankedTally.mjs');
    const en = (await import('../public/locales/en.js')).default;
    assert.equal(SEALED_RANKED_DISCLOSURE, en.sealedRanked.disclosure);
    assert.match(SEALED_RANKED_DISCLOSURE, /match each ranking to its encrypted ballot on chain/);
    assert.match(SEALED_RANKED_DISCLOSURE, /show a coercer which on-chain ballot is theirs/);
    const dir = new URL('../public/locales/', import.meta.url);
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.js'))) {
      const cat = (await import(new URL(f, dir))).default;
      assert.ok(cat.sealedRanked?.disclosure?.length > 80, `${f} lacks sealedRanked.disclosure`);
    }
    const vote = readFileSync(new URL('../public/vote.js', import.meta.url), 'utf8');
    const office = readFileSync(new URL('../public/back-office.html', import.meta.url), 'utf8');
    for (const src of [vote, office]) assert.equal(src.includes('verified shuffle exists'), false);
    assert.match(vote, /t\(SEALED_RANKED_DISCLOSURE_KEY\)/);
  });
});

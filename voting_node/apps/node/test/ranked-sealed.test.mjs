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
import { decryptRankingEnvelope, encryptRankingEnvelope, isRankingEnvelope } from '../public/ranked-envelope.js';
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

function rankingPartialBody(share, electionId, envelopes) {
  const partials = [];
  for (const env of envelopes) {
    const ranking = env.tallyRankingEnvelope || env.rankingEnvelope;
    if (!ranking) continue;
    const c1 = `0x${ranking.slice(2 + 6, 2 + 6 + 130)}`;
    partials.push(
      partialDecrypt({
        shareScalar: share.shareScalar,
        index: share.index,
        electionId,
        ballotHash: `ranking:${String(env.nullifier).toLowerCase()}`,
        jointPublicKey: share.jointPublicKey,
        ephemeral: c1,
      }),
    );
  }
  return { index: share.index, partials };
}

const OPTIONS = ['a', 'b', 'c', 'd'];

async function castRanked(electionId, pub, nullifier, ranking, commitment, { firstChoice } = {}) {
  const first = firstChoice ?? ranking[0] ?? 'a';
  const ag = encryptAggregateBallot({
    jointPublicKey: pub,
    choice: OPTIONS.indexOf(first),
    choiceRandomness: 5000n + BigInt(nullifier),
    nOptions: OPTIONS.length,
  });
  const rk = await encryptRankingEnvelope({
    jointPublicKey: pub,
    electionId,
    answers: [{ questionId: 'q-seat', ranking }],
  });
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
    const one = await encryptRankingEnvelope({ jointPublicKey: Y, electionId: 'e1', answers: [{ questionId: 'q', ranking: ['a'] }] });
    const all = await encryptRankingEnvelope({
      jointPublicKey: Y,
      electionId: 'e1',
      answers: [{ questionId: 'q', ranking: ['a', 'b', 'c', 'd'] }],
    });
    assert.ok(isRankingEnvelope(one.rankingEnvelope));
    assert.equal(one.rankingEnvelope.length, all.rankingEnvelope.length);
    assert.match(one.rankingHash, /^0x[0-9a-f]{64}$/);
    const c1 = p256.ProjectivePoint.fromHex(all.rankingEnvelope.slice(8, 8 + 130));
    const shared = c1.multiply(x).toRawBytes(false);
    const opened = await decryptRankingEnvelope({ envelope: all.rankingEnvelope, electionId: 'e1', sharedPoint: shared });
    assert.deepEqual(opened, [{ questionId: 'q', ranking: ['a', 'b', 'c', 'd'] }]);
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

  test('4-option IRV with re-vote, exhausted and invalid rankings, threshold partials', async () => {
    const created = await api('POST', '/api/elections', {
      jar: adminJar,
      body: {
        title: 'Sealed IRV',
        startTime: nowSec() - 10,
        cutoffTime: nowSec() + 3600,
        ballotMethod: 'ranked_choice',
        questions: [
          {
            id: 'q-seat',
            type: 'RANKED',
            prompt: 'Rank the seat',
            options: OPTIONS.map((id) => ({ id, label: id.toUpperCase() })),
          },
        ],
        jurisdictionId: 'demo',
        tallyScheme: 'opens_ballots',
        threshold: 2,
        guardianCount: 3,
      },
    });
    assert.equal(created.status, 201, created.text);
    const electionId = created.json.election.id;
    const shares = await establishGuardians(electionId, { guardians: 3, threshold: 2 });
    const pub = store.requireElection(electionId).tallyPubKey;

    // a:3 b:3 c:2 d:1 first choices. d is eliminated and transfers to c,
    // then b vs c ... see assertions. One ballot ranks only d (exhausts).
    const stacks = [
      ['a', 'b'],
      ['a', 'b'],
      ['a'],
      ['b', 'c'],
      ['b', 'c'],
      ['b', 'a'],
      ['c', 'b'],
      ['c', 'b'],
      ['d'],
    ];
    const commitments = [...stacks, null].map((_, i) => `0x${(0xc01 + i).toString(16)}`);
    for (const c of commitments) await registerVoter(electionId, c);
    const freeze = await api('POST', `/api/elections/${electionId}/freeze`, { jar: adminJar });
    assert.equal(freeze.status, 200, freeze.text);

    // A ranked election with a ready ceremony refuses a ballot with no ranking.
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

    const hashes = [];
    for (let i = 0; i < stacks.length; i++) {
      // Voter 5 first casts ['d'] and then re-votes ['b','a']: last vote counts.
      if (i === 5) {
        const first = await castRanked(electionId, pub, 2000 + i, ['d'], commitments[i]);
        assert.equal(first.res.status, 201, first.res.text);
        const ag = encryptAggregateBallot({ jointPublicKey: pub, choice: 1, choiceRandomness: 77n, nOptions: 4 });
        const rk = await encryptRankingEnvelope({ jointPublicKey: pub, electionId, answers: [{ questionId: 'q-seat', ranking: stacks[i] }] });
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
        hashes.push(rk.rankingHash);
        continue;
      }
      const { res, rk } = await castRanked(electionId, pub, 2000 + i, stacks[i], commitments[i]);
      assert.equal(res.status, 201, res.text);
      assert.equal(res.json.rankingHash, rk.rankingHash);
      assert.equal(JSON.stringify(res.json).includes('"ranking"'), false);
      hashes.push(rk.rankingHash);
    }
    // One ranking names an unknown option: it opens but counts as exhausted.
    const rogue = await castRanked(electionId, pub, 2100, ['z'], commitments[stacks.length], { firstChoice: 'a' });
    assert.equal(rogue.res.status, 201, rogue.res.text);

    const election = store.requireElection(electionId);
    election.cutoffTime = nowSec() - 1;
    await store.persist();

    const envelopes = store.listEnvelopes(electionId);
    const revoted = envelopes.find((env) => env.tallyRankingEnvelope);
    assert.ok(revoted, 'the re-vote keeps a tally copy of the replacement ranking');
    assert.notEqual(revoted.rankingHash, revoted.tallyRankingHash);
    for (const share of shares.slice(0, 2)) {
      const posted = await api('POST', `/api/elections/${electionId}/guardians/partials`, {
        jar: adminJar,
        body: partialBody(share, electionId, envelopes.map((env) => ({ encryptedBallot: env.tallyEncryptedBallot || env.encryptedBallot }))),
      });
      assert.equal(posted.status, 201, posted.text);
    }
    // Only one guardian has opened the rankings so far: below threshold.
    const r1 = await api('POST', `/api/elections/${electionId}/guardians/partials`, {
      jar: adminJar,
      body: rankingPartialBody(shares[0], electionId, envelopes),
    });
    assert.equal(r1.status, 201, r1.text);
    const early = await api('POST', `/api/elections/${electionId}/tally`, { jar: adminJar, body: {} });
    assert.equal(early.status, 409, early.text);
    assert.equal(early.json.code, 'THRESHOLD_NOT_MET');

    // A partial computed on the wrong C1 is refused.
    const wrong = rankingPartialBody(shares[1], electionId, envelopes);
    wrong.partials[0] = { ...wrong.partials[1], ballotHash: wrong.partials[0].ballotHash };
    const refused = await api('POST', `/api/elections/${electionId}/guardians/partials`, { jar: adminJar, body: wrong });
    assert.equal(refused.status, 400, refused.text);

    const r2 = await api('POST', `/api/elections/${electionId}/guardians/partials`, {
      jar: adminJar,
      body: rankingPartialBody(shares[1], electionId, envelopes),
    });
    assert.equal(r2.status, 201, r2.text);

    const tallied = await api('POST', `/api/elections/${electionId}/tally`, { jar: adminJar, body: {} });
    assert.equal(tallied.status, 200, tallied.text);
    const tally = store.requireElection(electionId).tally;
    const q = tally.questions.find((row) => row.questionId === 'q-seat');
    assert.equal(q.ballotMethod, 'ranked_choice');
    // Round 1: a3 b3 c2 d1 (+1 invalid exhausted). d out (exhausts).
    // Round 2: a3 b3 c2. c out → b. Round 3: b5 a3. b wins.
    assert.equal(q.winner, 'b');
    assert.ok(q.exhausted >= 2, `exhausted ${q.exhausted}`);
    assert.equal(tally.ranked.rankedBallots, stacks.length + 1);
    assert.equal(tally.ranked.invalidRankings, 1);
    // The rogue ballot's one-hot says 'a' but its ranking is invalid, so the
    // homomorphic first choices and IRV round one differ; reported, not fatal.
    assert.equal(tally.ranked.firstChoiceConsistent, false);
    assert.match(tally.ranked.rankingSetHash, /^0x[0-9a-f]{64}$/);
    assert.match(tally.ranked.roundsHash, /^0x[0-9a-f]{64}$/);
    assert.match(tally.ranked.verification, /recomputable, not ZK proof-verified; no verified shuffle/);
    assert.deepEqual(tally.counts, [4, 3, 2, 1]);
  });
});

describe('chain.commitRankings', () => {
  test('commits each ranking once and reports the root (injected writer)', async () => {
    const seen = new Map();
    const chain = createChain(
      { chainRpc: '', quiet: true },
      {
        writeSubmitBatch: async () => ({}),
        writeCommitRanking: async ({ submissionId, rankingHash }) => {
          if (seen.has(submissionId)) return { already: true };
          seen.set(submissionId, rankingHash);
          return {};
        },
        readRankingRoot: async () => '0xabc',
      },
    );
    const rows = [
      { nullifier: '1', rankingHash: `0x${'11'.repeat(32)}` },
      { nullifier: '2', rankingHash: `0x${'22'.repeat(32)}` },
    ];
    const first = await chain.commitRankings('7', rows);
    assert.deepEqual(first, { committed: 2, already: 0, rankingRoot: '0xabc' });
    const again = await chain.commitRankings('7', rows);
    assert.equal(again.already, 2);
  });
});

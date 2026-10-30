// NOT FOR PROFIT — civic public good, not a commercial product.
// Poll keeps today's disclosure. A vote stays sealed until cutoff for every role.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { createApp } from '../src/server.mjs';
import { planPublicBlocks } from '../src/disclosure.mjs';
import { PASS_ELECTION_TYPE_ON_CHAIN } from '../src/electionType.mjs';
import { electionFactoryAbi, factoryElectionParams } from '../src/chain.mjs';
import { electionsDiag, storeDiag } from '../src/superAdmin/diagnostics.mjs';

const HOUR = 3600;
const HOUR_START = 1_699_999_200;
const CAST = 7;

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

function listen(application) {
  return new Promise((resolve, reject) => {
    const s = application.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
}

async function startApp(clock, extra) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-etype-'));
  const created = await createApp({
    dataDir: tmp,
    allowDevLogin: true,
    adminHandle: 'admin',
    quiet: true,
    port: 0,
    disclosureIntervalSeconds: HOUR,
    disclosureDelaySeconds: 0,
    resultsMinVotes: 2,
    disclosureMinBlockVotes: 1,
    nowFn: () => clock.t,
    ...extra,
  });
  const server = await listen(created.app);
  const base = `http://127.0.0.1:${server.address().port}`;
  const adminJar = {};
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
    return { json, text, status: res.status };
  }
  await api('POST', '/api/auth/dev-login', { body: { handle: 'admin' }, jar: adminJar });
  return {
    tmp,
    server,
    api,
    adminJar,
    store: created.store,
    async stop() {
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await rm(tmp, { recursive: true, force: true });
    },
  };
}

function electionBody(clock, title, electionType) {
  const body = {
    title,
    startTime: clock.t - 60,
    cutoffTime: clock.t + 8 * HOUR,
    treeDepth: 16,
    jurisdictionId: 'demo',
    questions: [{ type: 'YES_NO', prompt: 'Adopt the measure?' }],
  };
  if (electionType !== undefined) body.electionType = electionType;
  return body;
}

async function createElection(api, adminJar, clock, title, electionType) {
  const created = await api('POST', '/api/elections', {
    jar: adminJar,
    body: electionBody(clock, title, electionType),
  });
  assert.equal(created.status, 201, created.json?.error || created.text);
  return { id: created.json.election.id, created: created.json.election };
}

async function openElection(api, adminJar, clock, title, electionType) {
  const made = await createElection(api, adminJar, clock, title, electionType);
  const reg = await api('POST', `/api/elections/${made.id}/register`, {
    jar: adminJar,
    body: { identityCommitment: '0xabc1' },
  });
  assert.equal(reg.status, 201, reg.json?.error);
  const freeze = await api('POST', `/api/elections/${made.id}/freeze`, { jar: adminJar });
  assert.equal(freeze.status, 200, freeze.json?.error);
  return made;
}

async function cast(api, id, n) {
  const vote = await api('POST', `/api/elections/${id}/vote`, {
    body: {
      proof: { accept: true },
      publicInputs: { nullifier: String(n), electionId: id },
      encryptedBallot: '0xaa',
      identityCommitment: '0xabc1',
    },
  });
  return { vote, nullifier: vote.json?.vote?.nullifier || null };
}

async function voteTxs(api, id) {
  const blocks = await api('GET', '/api/explorer/blocks');
  const found = [];
  for (const block of blocks.json?.blocks || []) {
    const one = await api('GET', `/api/explorer/blocks/${block.number}`);
    for (const tx of one.json?.block?.txs || []) {
      if (String(tx.type).toUpperCase() === 'VOTE' && String(tx.electionId) === String(id)) found.push(tx);
    }
  }
  return found;
}

function assertNoMarks(text, marks, label) {
  for (const mark of marks) {
    assert.equal(text.includes(mark), false, `${label} leaked ${mark}`);
  }
  assert.doesNotMatch(text, /"acceptedBallots":\s*7\b/, label);
  assert.doesNotMatch(text, /"acceptedBallotsDisclosed":\s*7\b/, label);
  assert.doesNotMatch(text, /"castCount":\s*7\b/, label);
  assert.doesNotMatch(text, /"voteCount":\s*7\b/, label);
  assert.doesNotMatch(text, /"count":\s*7\b/, label);
  assert.doesNotMatch(text, /"certifiedBallots":\s*7\b/, label);
  assert.doesNotMatch(text, /"publishedAcceptedBallots":\s*7\b/, label);
  assert.doesNotMatch(text, /"publicAcceptedBallots":\s*7\b/, label);
}

function assertSealedShape(body, label) {
  assert.equal(body.resultsSealed, true, label);
  assert.equal(body.electionType, 1, label);
  assert.equal(body.electionTypeName, 'vote', label);
  assert.equal(body.acceptedBallots ?? null, null, label);
  assert.equal(body.tally ?? null, null, label);
  const message = body.message || body.resultsMessage || body.note || body.disclosure?.note || '';
  assert.match(message, /^Results sealed until /, label);
  if (body.disclosure) assert.equal(body.disclosure.acceptedBallotsDisclosed, undefined, label);
  if (Array.isArray(body.ballots)) assert.equal(body.ballots.length, 0, label);
  if (Array.isArray(body.disclosedBallots)) assert.equal(body.disclosedBallots.length, 0, label);
  if (Array.isArray(body.hours)) assert.equal(body.hours.length, 0, label);
  if (body.results) {
    assert.equal(body.results.sealed, true, label);
    assert.equal(body.results.available, false, label);
    assert.equal(body.results.certifiedBallots, null, label);
    assert.equal(body.results.publishedAcceptedBallots, null, label);
    for (const question of body.results.questions || []) {
      for (const option of question.options || []) assert.equal(option.count, undefined, label);
    }
  }
  if (body.turnout) {
    assert.equal(body.turnout.acceptedBallots, null, label);
    assert.equal(body.turnout.participantCount, null, label);
  }
  if (body.code) assert.equal(body.code, 'RESULTS_SEALED', label);
}

describe('election type is chosen once', () => {
  let app;
  const clock = { t: HOUR_START + 10 * 60 };

  before(async () => {
    app = await startApp(clock);
  });
  after(async () => {
    await app.stop();
  });

  test('omitted type is a poll, names are accepted, and a bad type is rejected', async () => {
    const poll = await createElection(app.api, app.adminJar, clock, 'Plain poll');
    assert.equal(poll.created.electionType, 0);
    assert.equal(poll.created.electionTypeName, 'poll');
    assert.equal(poll.created.resultsSealed, false);

    const named = await createElection(app.api, app.adminJar, clock, 'Named vote', 'vote');
    assert.equal(named.created.electionType, 1);
    assert.equal(named.created.electionTypeName, 'vote');
    assert.equal(named.created.resultsSealed, true);
    assert.match(named.created.resultsMessage, /^Results sealed until /);

    const numbered = await app.api('POST', '/api/elections', {
      jar: app.adminJar,
      body: {
        title: 'Numbered vote',
        electionType: 1,
        startTime: clock.t - 60,
        cutoffTime: clock.t + HOUR,
        treeDepth: 16,
        jurisdictionId: 'demo',
        questions: [{ type: 'YES_NO', prompt: 'Yes?' }],
      },
    });
    assert.equal(numbered.status, 201, numbered.json?.error);
    assert.equal(numbered.json.election.electionType, 1);

    const bad = await app.api('POST', '/api/elections', {
      jar: app.adminJar,
      body: {
        title: 'Bad type',
        electionType: 'nope',
        startTime: clock.t - 60,
        cutoffTime: clock.t + HOUR,
        treeDepth: 16,
        jurisdictionId: 'demo',
        questions: [{ type: 'YES_NO', prompt: 'Yes?' }],
      },
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.code, 'INVALID_ELECTION_TYPE');
  });

  test('type cannot be changed after creation', async () => {
    const poll = await createElection(app.api, app.adminJar, clock, 'Locked poll');
    const vote = await createElection(app.api, app.adminJar, clock, 'Locked vote', 1);
    const flip = await app.api('PATCH', `/api/elections/${poll.id}`, {
      jar: app.adminJar,
      body: { electionType: 1, title: 'Should stay a poll' },
    });
    assert.equal(flip.status, 409);
    assert.equal(flip.json.code, 'ELECTION_TYPE_IMMUTABLE');
    const stored = app.store.requireElection(poll.id);
    assert.equal(stored.electionType, 0);
    assert.equal(stored.title, 'Locked poll');

    const renamed = await app.api('PATCH', `/api/elections/${poll.id}`, {
      jar: app.adminJar,
      body: { title: 'Renamed poll' },
    });
    assert.equal(renamed.status, 200, renamed.json?.error);
    assert.equal(app.store.requireElection(poll.id).electionType, 0);
    assert.equal(app.store.requireElection(poll.id).title, 'Renamed poll');

    const freeze = await app.api('POST', `/api/elections/${poll.id}/freeze`, { jar: app.adminJar });
    assert.equal(freeze.status, 200, freeze.json?.error);
    const frozenFlip = await app.api('PATCH', `/api/elections/${poll.id}`, {
      jar: app.adminJar,
      body: { electionType: 'vote' },
    });
    assert.equal(frozenFlip.status, 409);
    assert.equal(frozenFlip.json.code, 'ELECTION_TYPE_IMMUTABLE');
    assert.equal(app.store.requireElection(poll.id).electionType, 0);

    const same = await app.api('PATCH', `/api/elections/${vote.id}`, {
      jar: app.adminJar,
      body: { electionType: 'vote', title: 'Still a vote' },
    });
    assert.equal(same.status, 200, same.json?.error);
    assert.equal(app.store.requireElection(vote.id).electionType, 1);

    const back = await app.api('PUT', `/api/elections/${vote.id}`, {
      jar: app.adminJar,
      body: { electionType: 0 },
    });
    assert.equal(back.status, 409);
    assert.equal(back.json.code, 'ELECTION_TYPE_IMMUTABLE');
    assert.equal(app.store.requireElection(vote.id).electionType, 1);
  });
});

describe('vote interim data is refused', () => {
  let app;
  const clock = { t: HOUR_START + 20 * 60 };
  let pollId;
  let voteId;
  let marks;

  before(async () => {
    app = await startApp(clock);
    pollId = (await openElection(app.api, app.adminJar, clock, 'Dashboard poll')).id;
    voteId = (await openElection(app.api, app.adminJar, clock, 'Sealed vote', 1)).id;
    const castPoll = await cast(app.api, pollId, 11);
    assert.equal(castPoll.vote.status, 201, castPoll.vote.json?.error || castPoll.vote.text);
    marks = [];
    for (let n = 1; n <= CAST; n += 1) {
      const row = await cast(app.api, voteId, 7000 + n);
      assert.equal(row.vote.status, 201, row.vote.json?.error || row.vote.text);
      marks.push(row.nullifier);
    }
    clock.t = HOUR_START + HOUR;
  });
  after(async () => {
    await app.stop();
  });

  test('hourly disclosure publishes a poll that cleared the gate and skips a vote', async () => {
    const pollEarly = await app.api('GET', `/api/elections/${pollId}`);
    assert.equal(pollEarly.json.resultsSealed, false);
    assert.equal(pollEarly.json.electionType, 0);
    assert.equal(pollEarly.json.acceptedBallots, 0);
    assert.equal((await voteTxs(app.api, pollId)).length, 0);

    const second = await cast(app.api, pollId, 12);
    assert.equal(second.vote.status, 201, second.vote.json?.error);
    clock.t = HOUR_START + HOUR + 30;
    const pollNow = await app.api('GET', `/api/elections/${pollId}/ballots`);
    assert.equal(pollNow.json.resultsSealed, false);
    assert.equal(pollNow.json.acceptedBallots, 1);
    assert.equal((await voteTxs(app.api, pollId)).length, 1);

    const voteNow = await app.api('GET', `/api/elections/${voteId}`);
    assertSealedShape(voteNow.json, 'vote detail');
    assert.equal((await voteTxs(app.api, voteId)).length, 0);
    assertNoMarks(JSON.stringify(voteNow.json), marks, 'vote detail');
  });

  test('every role, including admin, receives a sealed vote and no interim rows', async () => {
    const roles = [
      { name: 'anonymous', jar: null },
      { name: 'voter', handle: 'voter-one', role: 'voter' },
      { name: 'observer', handle: 'observer-one', role: 'observer' },
      { name: 'clerk', handle: 'clerk-one', role: 'clerk' },
      { name: 'tally_operator', handle: 'tally-one', role: 'tally_operator' },
      { name: 'platform_admin', handle: 'padmin-one', role: 'platform_admin' },
      { name: 'platform_super_admin', jar: app.adminJar },
    ];
    const jars = { anonymous: null, platform_super_admin: app.adminJar };
    for (const role of roles) {
      if (role.handle) {
        const jar = {};
        const login = await app.api('POST', '/api/auth/dev-login', {
          body: { handle: role.handle, role: role.role },
          jar,
        });
        assert.equal(login.status, 200, login.text);
        jars[role.name] = jar;
      }
    }

    const paths = [
      `/api/elections/${voteId}`,
      `/api/elections/${voteId}/results`,
      `/api/elections/${voteId}/summary`,
      `/api/elections/${voteId}/ballots`,
      `/api/elections/${voteId}/artifacts`,
      `/api/elections/${voteId}/info`,
      `/api/explorer/elections/${voteId}`,
      `/api/outcomes/${voteId}`,
      `/api/receipts/metrics?electionId=${encodeURIComponent(voteId)}`,
    ];

    let anonDetail = null;
    let adminDetail = null;
    for (const [name, jar] of Object.entries(jars)) {
      for (const path of paths) {
        const res = await app.api('GET', path, { jar });
        assert.equal(res.status, 200, `${name} ${path} ${res.text}`);
        assertNoMarks(res.text, marks, `${name} ${path}`);
        if (path.endsWith('/info')) {
          assert.equal(res.json.resultsSealed, true, path);
          assert.match(res.json.resultsMessage, /^Results sealed until /);
          continue;
        }
        if (path.includes('/explorer/elections/')) {
          assertSealedShape(res.json.election, `${name} explorer`);
          const votes = (res.json.txs || []).filter((tx) => String(tx.type).toUpperCase() === 'VOTE');
          assert.equal(votes.length, 0, name);
          continue;
        }
        if (path.includes('/receipts/metrics')) {
          assert.equal(res.json.resultsSealed, true);
          assert.equal(res.json.acceptedBallotsDisclosed, null);
          assert.equal(res.json.participantCount, null);
          assert.deepEqual(res.json.hours, []);
          assert.match(res.json.message, /^Results sealed until /);
          continue;
        }
        assertSealedShape(res.json, `${name} ${path}`);
      }
      const list = await app.api('GET', '/api/elections', { jar });
      const card = (list.json.elections || []).find((row) => String(row.id) === String(voteId));
      assertSealedShape(card, `${name} list`);
      assertNoMarks(JSON.stringify(card), marks, `${name} list`);
      const board = await app.api('GET', '/api/outcomes', { jar });
      const outcome = (board.json.elections || []).find((row) => String(row.id) === String(voteId));
      assert.equal(outcome.resultsSealed, true);
      assert.equal(outcome.acceptedBallots, null);
      assertNoMarks(JSON.stringify(outcome), marks, `${name} outcomes`);
      if (name === 'anonymous') anonDetail = await app.api('GET', `/api/elections/${voteId}`, { jar });
      if (name === 'platform_super_admin') adminDetail = await app.api('GET', `/api/elections/${voteId}`, { jar });
    }

    assert.equal(anonDetail.json.acceptedBallots, adminDetail.json.acceptedBallots);
    assert.equal(anonDetail.json.resultsSealed, adminDetail.json.resultsSealed);
    assert.equal(anonDetail.json.tally, adminDetail.json.tally);
    assert.equal(JSON.stringify(anonDetail.json.disclosure), JSON.stringify(adminDetail.json.disclosure));

    const sa = await app.api('GET', '/api/_sa/v1/elections', { jar: app.adminJar });
    assert.equal(sa.status, 200, sa.text);
    const meta = (sa.json.elections || []).find((row) => String(row.id) === String(voteId));
    assert.equal(meta.resultsSealed, true);
    assert.equal(meta.castCount, null);
    assert.equal(meta.tallied, false);
    assertNoMarks(JSON.stringify(meta), marks, 'admin elections diag');
    const store = await app.api('GET', '/api/_sa/v1/store', { jar: app.adminJar });
    assert.equal(store.status, 200, store.text);
    assert.notEqual(store.json.counts.voteCount, CAST);
    assert.ok(store.json.counts.voteCount < CAST);
    const clerk = await app.api('GET', '/api/_sa/v1/elections', { jar: jars.clerk });
    assert.equal(clerk.status, 404);
    assertNoMarks(clerk.text, marks, 'clerk diagnostics');

    const direct = electionsDiag(app.store, clock.t);
    const directMeta = direct.elections.find((row) => String(row.id) === String(voteId));
    assert.equal(directMeta.castCount, null);
    const counts = storeDiag(app.store, clock.t);
    assert.notEqual(counts.counts.voteCount, CAST);
  });

  test('a vote under the poll threshold stays sealed, then both types reject ballots after close', async () => {
    const small = await openElection(app.api, app.adminJar, clock, 'One ballot vote', 1);
    const one = await cast(app.api, small.id, 21);
    assert.equal(one.vote.status, 201, one.vote.json?.error);
    const sealed = await app.api('GET', `/api/elections/${small.id}/results`);
    assertSealedShape(sealed.json, 'under threshold');
    assert.equal((await voteTxs(app.api, small.id)).length, 0);

    clock.t = HOUR_START + 2 * HOUR;
    const poll = app.store.requireElection(pollId);
    const vote = app.store.requireElection(voteId);
    const lone = app.store.requireElection(small.id);
    poll.cutoffTime = clock.t - 1;
    vote.cutoffTime = clock.t - 1;
    lone.cutoffTime = clock.t - 1;
    await app.store.persist();

    const pollClosed = await app.api('GET', `/api/elections/${pollId}/ballots`);
    assert.equal(pollClosed.json.resultsSealed, false);
    assert.equal(pollClosed.json.electionType, 0);
    assert.ok(pollClosed.json.acceptedBallots >= 1);

    const opened = await app.api('GET', `/api/elections/${voteId}/ballots`);
    assert.equal(opened.json.resultsSealed, false);
    assert.equal(opened.json.acceptedBallots, CAST);
    assert.equal((await voteTxs(app.api, voteId)).length, CAST);

    const loneOpened = await app.api('GET', `/api/elections/${small.id}/ballots`);
    assert.equal(loneOpened.json.resultsSealed, false);
    assert.equal(loneOpened.json.acceptedBallots, 1);

    const pollLate = await cast(app.api, pollId, 13);
    const voteLate = await cast(app.api, voteId, 7099);
    assert.equal(pollLate.vote.status, 400);
    assert.equal(pollLate.vote.json.code, 'CLOSED');
    assert.equal(voteLate.vote.status, 400);
    assert.equal(voteLate.vote.json.code, 'CLOSED');
    assert.equal((await app.api('GET', `/api/elections/${voteId}/ballots`)).json.acceptedBallots, CAST);
  });
});

describe('interval 0 still holds a vote', () => {
  let app;
  const clock = { t: HOUR_START + 5 * 60 };

  before(async () => {
    app = await startApp(clock, { disclosureIntervalSeconds: 0, resultsMinVotes: 0 });
  });
  after(async () => {
    await app.stop();
  });

  test('a poll is public immediately and a vote waits for the close', async () => {
    const poll = await openElection(app.api, app.adminJar, clock, 'Instant poll');
    const vote = await openElection(app.api, app.adminJar, clock, 'Instant vote', 'vote');
    const pollCast = await cast(app.api, poll.id, 31);
    const voteCast = await cast(app.api, vote.id, 32);
    assert.equal(pollCast.vote.status, 201, pollCast.vote.json?.error);
    assert.equal(voteCast.vote.status, 201, voteCast.vote.json?.error);
    assert.equal(pollCast.vote.json.published, true);
    assert.equal(voteCast.vote.json.published, false);

    const pollPublic = await app.api('GET', `/api/elections/${poll.id}`);
    assert.equal(pollPublic.json.acceptedBallots, 1);
    assert.equal(pollPublic.json.resultsSealed, false);
    assert.equal((await voteTxs(app.api, poll.id)).length, 1);

    const votePublic = await app.api('GET', `/api/elections/${vote.id}/ballots`);
    assertSealedShape(votePublic.json, 'interval 0');
    assert.equal((await voteTxs(app.api, vote.id)).length, 0);
    assert.equal(votePublic.text.includes(voteCast.nullifier), false);

    const election = app.store.requireElection(vote.id);
    election.cutoffTime = clock.t - 1;
    await app.store.persist();
    const opened = await app.api('GET', `/api/elections/${vote.id}/ballots`);
    assert.equal(opened.json.resultsSealed, false);
    assert.equal(opened.json.acceptedBallots, 1);
    assert.equal((await voteTxs(app.api, vote.id)).length, 1);
  });
});

describe('on-chain create stays on the current factory tuple', () => {
  test('electionType is not an ElectionParams component and is not attached', () => {
    assert.equal(PASS_ELECTION_TYPE_ON_CHAIN, false);
    const components = electionFactoryAbi.find((item) => item.name === 'createElection').inputs[0].components;
    assert.equal(components.at(-1).name, 'tallyScheme');
    assert.equal(
      components.some((item) => item.name === 'electionType'),
      false,
    );
    const tuple = factoryElectionParams(
      {
        title: 'T',
        metadataURI: '',
        startTime: 1,
        cutoffTime: 2,
        maxParticipants: 0,
        treeDepth: 16,
        ballotSpecHash: `0x${'11'.repeat(32)}`,
        clerk: `0x${'22'.repeat(20)}`,
        registrar: `0x${'22'.repeat(20)}`,
        disqualificationOfficer: `0x${'22'.repeat(20)}`,
        tallyOperator: `0x${'22'.repeat(20)}`,
        verifier: `0x${'33'.repeat(20)}`,
        questionCount: 1,
        jurisdictionId: `0x${'44'.repeat(32)}`,
        tallyPubKeyX: `0x${'00'.repeat(32)}`,
        tallyPubKeyY: `0x${'00'.repeat(32)}`,
        tallyScheme: 0,
      },
      1,
    );
    assert.equal(Object.hasOwn(tuple, 'electionType'), false);
  });
});

describe('sealed votes are not bucketed', () => {
  test('planPublicBlocks holds a sealed vote without counting it into a block', () => {
    const items = [
      { electionId: 'vote', receivedAt: HOUR_START + 10 },
      { electionId: 'vote', receivedAt: HOUR_START + 20 },
      { electionId: 'poll', receivedAt: HOUR_START + 15 },
    ];
    const planned = planPublicBlocks(items, {
      now: HOUR_START + HOUR,
      intervalSeconds: 0,
      delaySeconds: 0,
      minBlockVotes: 1,
      minVotes: 0,
      electionContext: (id) =>
        id === 'vote'
          ? { resultsSealed: true, submittedVotes: 0, endTime: HOUR_START + 5 * HOUR, tallied: false, minVotes: 0 }
          : { resultsSealed: false, submittedVotes: 1, endTime: HOUR_START + 5 * HOUR, tallied: false, minVotes: 0 },
    });
    assert.equal(planned.publish.length, 1);
    assert.equal(planned.publish[0].electionId, 'poll');
    assert.equal(planned.hold.length, 2);
    assert.ok(planned.hold.every((row) => row.electionId === 'vote'));
  });
});

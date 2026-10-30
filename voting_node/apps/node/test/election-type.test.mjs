// NOT FOR PROFIT — civic public good, not a commercial product.
// Poll keeps today's disclosure. A vote stays sealed until cutoff for every role.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { createApp } from '../src/server.mjs';
import { planPublicBlocks } from '../src/disclosure.mjs';
import { PASS_ELECTION_TYPE_ON_CHAIN } from '../src/electionType.mjs';
import { electionOpenCivic } from '../src/l2Identity.mjs';
import { electionFactoryAbi, factoryElectionParams } from '../src/chain.mjs';
import { electionsDiag, l2Diag, storeDiag } from '../src/superAdmin/diagnostics.mjs';
import { submitHeldBallotsAtCutoff } from '../src/heldBallots.mjs';

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
    l2CivicRpc: '',
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
}

function assertNoChoice(text, label) {
  assert.doesNotMatch(text, /"counts"\s*:/, label);
  assert.doesNotMatch(text, /"countsHash"\s*:/, label);
  assert.doesNotMatch(text, /"winner"\s*:/, label);
  assert.doesNotMatch(text, /"winners"\s*:/, label);
  assert.doesNotMatch(text, /"openedBallots"\s*:/, label);
  assert.doesNotMatch(text, /"plaintext"\s*:/, label);
  assert.doesNotMatch(text, /"choice"\s*:/, label);
  assert.doesNotMatch(text, /"count"\s*:\s*\d/, label);
  assert.doesNotMatch(text, /"certifiedBallots"\s*:\s*\d/, label);
}

function assertNoLiveCounters(text, label) {
  assert.doesNotMatch(text, /"castCount"\s*:\s*7\b/, label);
  assert.doesNotMatch(text, /"voteCount"\s*:\s*7\b/, label);
  assert.doesNotMatch(text, /"receiptCount"\s*:\s*7\b/, label);
  assert.doesNotMatch(text, /"sealedCount"\s*:\s*7\b/, label);
}

function assertSealedShape(body, label) {
  assert.equal(body.resultsSealed, true, label);
  assert.equal(body.electionType, 1, label);
  assert.equal(body.electionTypeName, 'vote', label);
  assert.equal(body.tally ?? null, null, label);
  if (body.acceptedBallots != null) assert.equal(typeof body.acceptedBallots, 'number', label);
  const message = body.message || body.resultsMessage || body.note || body.disclosure?.note || '';
  assert.match(message, /^Results sealed until /, label);
  if (body.results) {
    assert.equal(body.results.sealed, true, label);
    assert.equal(body.results.available, false, label);
    assert.equal(body.results.certifiedBallots, null, label);
    if (body.results.publishedAcceptedBallots != null) {
      assert.equal(typeof body.results.publishedAcceptedBallots, 'number', label);
    }
    for (const question of body.results.questions || []) {
      assert.equal(question.outcome ?? null, null, label);
      for (const option of question.options || []) assert.equal(option.count, undefined, label);
    }
  }
  if (body.code) assert.equal(body.code, 'RESULTS_SEALED', label);
  assertNoChoice(JSON.stringify(body), label);
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

  test('hourly disclosure publishes a poll and a vote, and withholds vote choice results', async () => {
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
    assert.equal(voteNow.json.acceptedBallots, CAST);
    assert.equal(voteNow.json.tally, null);
    assert.equal((await voteTxs(app.api, voteId)).length, CAST);
    assertNoChoice(JSON.stringify(voteNow.json), 'vote detail');
  });

  test('every role sees disclosed turnout and no choice data before the deadline', async () => {
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
        assertNoChoice(res.text, `${name} ${path}`);
        assertNoLiveCounters(res.text, `${name} ${path}`);
        const showsRows =
          path.endsWith('/ballots') || path.includes('/explorer/elections/') || path.endsWith('/artifacts');
        if (!showsRows) assertNoMarks(res.text, marks, `${name} ${path}`);
        if (path.endsWith('/info')) {
          assert.equal(res.json.resultsSealed, true, path);
          assert.match(res.json.resultsMessage, /^Results sealed until /);
          continue;
        }
        if (path.includes('/explorer/elections/')) {
          assertSealedShape(res.json.election, `${name} explorer`);
          const votes = (res.json.txs || []).filter((tx) => String(tx.type).toUpperCase() === 'VOTE');
          assert.equal(votes.length, CAST, name);
          continue;
        }
        if (path.includes('/receipts/metrics')) {
          assert.equal(res.json.resultsSealed, true);
          assert.equal(res.json.acceptedBallotsDisclosed, CAST);
          assert.ok(Array.isArray(res.json.hours) && res.json.hours.length > 0);
          assert.match(res.json.message, /^Results sealed until /);
          assertNoChoice(res.text, `${name} metrics`);
          continue;
        }
        if (path.endsWith('/ballots')) {
          assert.equal(res.json.acceptedBallots, CAST);
          assert.equal(res.json.ballots.length, CAST);
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
      assert.equal(outcome.acceptedBallots, CAST);
      assertNoChoice(JSON.stringify(outcome), `${name} outcomes`);
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
    assert.notEqual(store.json.counts.receiptCount, CAST);
    assert.ok(store.json.counts.receiptCount < CAST);
    const l2 = await app.api('GET', '/api/_sa/v1/l2', { jar: app.adminJar });
    assert.equal(l2.status, 200, l2.text);
    assert.notEqual(l2.json.explorer.sealedCount, CAST);
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
    assert.equal(sealed.json.acceptedBallots, 0);
    assert.equal(sealed.json.tally, null);
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

describe('interval 0 publishes ballot rows and still seals choice results', () => {
  let app;
  const clock = { t: HOUR_START + 5 * 60 };

  before(async () => {
    app = await startApp(clock, { disclosureIntervalSeconds: 0, resultsMinVotes: 0 });
  });
  after(async () => {
    await app.stop();
  });

  test('a poll and a vote both publish ballot rows, and the vote has no choice totals', async () => {
    const poll = await openElection(app.api, app.adminJar, clock, 'Instant poll');
    const vote = await openElection(app.api, app.adminJar, clock, 'Instant vote', 'vote');
    const pollCast = await cast(app.api, poll.id, 31);
    const voteCast = await cast(app.api, vote.id, 32);
    assert.equal(pollCast.vote.status, 201, pollCast.vote.json?.error);
    assert.equal(voteCast.vote.status, 201, voteCast.vote.json?.error);
    assert.equal(pollCast.vote.json.published, true);
    assert.equal(voteCast.vote.json.published, true);

    const pollPublic = await app.api('GET', `/api/elections/${poll.id}`);
    assert.equal(pollPublic.json.acceptedBallots, 1);
    assert.equal(pollPublic.json.resultsSealed, false);
    assert.equal((await voteTxs(app.api, poll.id)).length, 1);

    const votePublic = await app.api('GET', `/api/elections/${vote.id}/ballots`);
    assertSealedShape(votePublic.json, 'interval 0');
    assert.equal(votePublic.json.acceptedBallots, 1);
    assert.equal(votePublic.json.tally ?? null, null);
    assert.equal((await voteTxs(app.api, vote.id)).length, 1);
    assert.equal(votePublic.text.includes(voteCast.nullifier), true);
    assertNoChoice(votePublic.text, 'interval 0 ballots');
    const live = await app.api('GET', '/api/_sa/v1/store', { jar: app.adminJar });
    assert.equal(live.json.counts.receiptCount, 1);
    assert.equal(live.json.counts.voteCount, 1);

    const election = app.store.requireElection(vote.id);
    election.cutoffTime = clock.t - 1;
    await app.store.persist();
    const opened = await app.api('GET', `/api/elections/${vote.id}/ballots`);
    assert.equal(opened.json.resultsSealed, false);
    assert.equal(opened.json.acceptedBallots, 1);
    assert.equal((await voteTxs(app.api, vote.id)).length, 1);
  });
});

describe('live diagnostics omit a sealed vote', () => {
  let app;
  const clock = { t: HOUR_START + 12 * 60 };

  before(async () => {
    app = await startApp(clock);
  });
  after(async () => {
    await app.stop();
  });

  test('store and l2 counters ignore receipts and the hourly queue', async () => {
    const vote = await openElection(app.api, app.adminJar, clock, 'Queued vote', 1);
    const castRow = await cast(app.api, vote.id, 44);
    assert.equal(castRow.vote.status, 201, castRow.vote.json?.error);
    const store = await app.api('GET', '/api/_sa/v1/store', { jar: app.adminJar });
    assert.equal(store.status, 200, store.text);
    assert.equal(store.json.counts.voteCount, 0);
    assert.equal(store.json.counts.receiptCount, 0);
    const l2 = await app.api('GET', '/api/_sa/v1/l2', { jar: app.adminJar });
    assert.equal(l2.status, 200, l2.text);
    assert.equal(l2.json.explorer.sealedCount, 0);
    const diag = await app.api('GET', '/api/_sa/v1/elections', { jar: app.adminJar });
    const meta = diag.json.elections.find((row) => String(row.id) === String(vote.id));
    assert.equal(meta.castCount, null);
    assert.equal(meta.resultsSealed, true);
    const publicView = await app.api('GET', `/api/elections/${vote.id}`);
    assert.equal(publicView.json.acceptedBallots, 0);
    assert.equal(publicView.json.tally, null);
    assertNoChoice(JSON.stringify(publicView.json), 'before the hour');
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

  test('the sequencer open carries type and cutoff while the factory flag stays off', () => {
    assert.equal(PASS_ELECTION_TYPE_ON_CHAIN, false);
    const civic = electionOpenCivic(
      { l2Uuid: '11111111-1111-4111-8111-111111111111' },
      {
        electionUuid: '22222222-2222-4222-8222-222222222222',
        electionType: 'vote',
        cutoffTime: 1_700_000_000,
      },
    );
    assert.equal(civic.electionType, 1);
    assert.equal(civic.cutoffTime, 1_700_000_000);
    assert.equal(PASS_ELECTION_TYPE_ON_CHAIN, false);
  });
});

describe('hourly blocks are not held for a sealed vote', () => {
  test('planPublicBlocks publishes ballot rows for a sealed vote and a poll', () => {
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
    assert.equal(planned.hold.length, 0);
    assert.deepEqual(
      planned.publish.map((block) => block.electionId).sort(),
      ['poll', 'vote'],
    );
  });
});

function mockChain() {
  const calls = [];
  const creates = [];
  let nextId = 100;
  return {
    calls,
    creates,
    configured: true,
    isConfigured: () => true,
    isReady: () => true,
    async createElection(input) {
      nextId += 1;
      creates.push(input);
      return { onChainElectionId: String(nextId), chainId: 27427, params: {} };
    },
    async submitVote(args) {
      calls.push(args);
      return { hash: `0x${'ab'.repeat(32)}` };
    },
  };
}

describe('vote turnout counters are absent before close for every role', () => {
  let app;
  const clock = { t: HOUR_START + 12 * 60 };
  const chain = mockChain();
  const roles = [
    { name: 'anonymous', jar: null },
    { name: 'voter', handle: 'voter-diag', role: 'voter' },
    { name: 'observer', handle: 'observer-diag', role: 'observer' },
    { name: 'clerk', handle: 'clerk-diag', role: 'clerk' },
    { name: 'tally_operator', handle: 'tally-diag', role: 'tally_operator' },
    { name: 'platform_admin', handle: 'padmin-diag', role: 'platform_admin' },
    { name: 'platform_super_admin' },
  ];

  before(async () => {
    app = await startApp(clock, { chain });
  });
  after(async () => {
    await app.stop();
  });

  test('store, l2, and the relayer omit a sealed vote', async () => {
    const poll = await openElection(app.api, app.adminJar, clock, 'Counter poll');
    const vote = await openElection(app.api, app.adminJar, clock, 'Counter vote', 1);
    const pollCast = await cast(app.api, poll.id, 81);
    assert.equal(pollCast.vote.status, 201, pollCast.vote.json?.error);
    const beforeStore = await app.api('GET', '/api/_sa/v1/store', { jar: app.adminJar });
    const beforeL2 = await app.api('GET', '/api/_sa/v1/l2', { jar: app.adminJar });
    assert.equal(beforeStore.status, 200, beforeStore.text);
    assert.equal(beforeL2.status, 200, beforeL2.text);
    const receiptBefore = beforeStore.json.counts.receiptCount;
    const sealedBefore = beforeL2.json.explorer.sealedCount;
    const voteBefore = beforeStore.json.counts.voteCount;
    const heightBefore = beforeL2.json.explorer.height;

    for (let n = 0; n < 4; n += 1) {
      const row = await cast(app.api, vote.id, 900 + n);
      assert.equal(row.vote.status, 201, row.vote.json?.error);
    }

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

    for (const role of roles) {
      const jar = jars[role.name];
      const store = await app.api('GET', '/api/_sa/v1/store', { jar });
      const l2 = await app.api('GET', '/api/_sa/v1/l2', { jar });
      if (role.name !== 'platform_super_admin') {
        assert.equal(store.status, 404, `${role.name} store ${store.text}`);
        assert.equal(l2.status, 404, `${role.name} l2 ${l2.text}`);
        assert.equal(store.text.includes('receiptCount'), false, role.name);
        assert.equal(l2.text.includes('sealedCount'), false, role.name);
        continue;
      }
      assert.equal(store.status, 200, store.text);
      assert.equal(l2.status, 200, l2.text);
      assert.equal(store.json.counts.receiptCount, receiptBefore);
      assert.equal(store.json.counts.voteCount, voteBefore);
      assert.equal(l2.json.explorer.sealedCount, sealedBefore);
      assert.equal(store.text.includes('heldChainBallots'), false);
      assert.equal(l2.text.includes('"sealedCount":4'), false);
      assert.equal(store.text.includes('"receiptCount":4'), false);
      const diag = electionsDiag(app.store, clock.t);
      const meta = diag.elections.find((row) => String(row.id) === String(vote.id));
      assert.equal(meta.castCount, null);
      assert.equal(JSON.stringify(storeDiag(app.store, clock.t)).includes('"receiptCount":4'), false);
      assert.equal(JSON.stringify(l2Diag({ store: app.store, explorer: app.store, config: { nowFn: () => clock.t } })).includes('"sealedCount":4'), false);
    }

    assert.equal(chain.calls.length, 1);
    assert.equal(String(chain.calls[0].electionId), String(poll.created.onChainElectionId));
    assert.notEqual(String(chain.calls[0].electionId), String(vote.created.onChainElectionId));

    const saved = JSON.parse(await readFile(app.store.filePath, 'utf8'));
    assert.equal(saved.heldChainBallots.length, 4);
    for (const row of saved.heldChainBallots) {
      assert.equal(Object.hasOwn(row, 'count'), false);
      assert.ok(row.proof);
      assert.equal(String(row.electionId), String(vote.id));
    }

    const earlyHook = submitHeldBallotsAtCutoff({
      store: app.store,
      election: app.store.requireElection(vote.id),
      now: clock.t,
    });
    assert.equal(earlyHook.reason, 'not-due');
    assert.equal(earlyHook.submitted, false);
    assert.deepEqual(Object.keys(earlyHook), ['submitted', 'reason']);

    clock.t = HOUR_START + HOUR + 30;
    const mid = await app.api('GET', `/api/elections/${vote.id}`, { jar: app.adminJar });
    assert.equal(mid.status, 200, mid.text);
    const afterHour = await app.api('GET', '/api/_sa/v1/l2', { jar: app.adminJar });
    const afterStore = await app.api('GET', '/api/_sa/v1/store', { jar: app.adminJar });
    assert.equal(afterStore.json.counts.receiptCount, receiptBefore);
    assert.equal(afterHour.json.explorer.sealedCount === 4, false);
    assert.equal(afterHour.json.explorer.height, heightBefore);
    assert.equal(chain.calls.length, 1);

    const election = app.store.requireElection(vote.id);
    election.cutoffTime = clock.t - 1;
    await app.store.persist();
    const hook = submitHeldBallotsAtCutoff({ store: app.store, election, now: clock.t });
    assert.equal(hook.submitted, false);
    assert.equal(hook.reason, 'chain-batch-abi-not-final');
    assert.equal(Object.hasOwn(hook, 'count'), false);
    assert.deepEqual(Object.keys(hook), ['submitted', 'reason']);
    const opened = await app.api('GET', `/api/elections/${vote.id}/ballots`, { jar: app.adminJar });
    assert.equal(opened.status, 200, opened.text);
    assert.equal(chain.calls.length, 1);
  });
});

describe('sequencer open is idempotent', () => {
  const clock = { t: HOUR_START + 15 * 60 };

  test('a failed open is retried on the same election', async () => {
    let attempts = 0;
    const chain = mockChain();
    const app = await startApp(clock, {
      chain,
      l2CivicRpc: 'http://127.0.0.1:9',
      openElectionOnL2: async (_cfg, fields) => {
        attempts += 1;
        assert.equal(typeof fields.electionUuid, 'string');
        if (attempts === 1) throw new Error('sequencer down');
        return '0xopen';
      },
    });
    try {
      const body = electionBody(clock, 'Retry vote', 'vote');
      const first = await app.api('POST', '/api/elections', { jar: app.adminJar, body });
      assert.equal(first.status, 502, first.text);
      assert.equal(first.json.code, 'L2_OPEN_FAILED');
      assert.equal(app.store.data.elections.length, 1);
      assert.equal(chain.creates.length, 1);
      assert.equal(app.store.data.elections[0].l2OpenStatus, 'pending');
      const second = await app.api('POST', '/api/elections', { jar: app.adminJar, body });
      assert.equal(second.status, 201, second.text);
      assert.equal(second.json.l2Open, 'open');
      assert.equal(second.json.id, app.store.data.elections[0].id);
      assert.equal(app.store.data.elections.length, 1);
      assert.equal(chain.creates.length, 1);
      assert.equal(attempts, 2);
      assert.equal(app.store.data.elections[0].l2OpenStatus, 'open');
    } finally {
      await app.stop();
    }
  });

  test('an unset sequencer rpc is flagged and does not open', async () => {
    let called = false;
    const warnings = [];
    const orig = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    const app = await startApp(clock, {
      quiet: false,
      l2CivicRpc: '',
      openElectionOnL2: async () => {
        called = true;
      },
    });
    try {
      const created = await app.api('POST', '/api/elections', {
        jar: app.adminJar,
        body: electionBody(clock, 'No sequencer', 'vote'),
      });
      assert.equal(created.status, 201, created.text);
      assert.equal(created.json.l2Open, 'skipped');
      assert.equal(called, false);
      assert.equal(app.store.requireElection(created.json.id).l2OpenStatus, 'unconfigured');
      assert.match(warnings.join('\n'), /L2_CIVIC_RPC is unset/);
    } finally {
      console.warn = orig;
      await app.stop();
    }
  });
});

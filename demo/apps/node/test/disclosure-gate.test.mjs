// NOT FOR PROFIT — civic public good, not a commercial product.
// Delay, results gate, and small-block merging on the public API.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { createApp } from '../src/server.mjs';

const HOUR = 3600;
const HOUR_START = 1_699_999_200;

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
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-gate-'));
  const created = await createApp({
    dataDir: tmp,
    allowDevLogin: true,
    adminHandle: 'admin',
    quiet: true,
    port: 0,
    disclosureIntervalSeconds: HOUR,
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

async function openElection(api, adminJar, clock, title) {
  const created = await api('POST', '/api/elections', {
    jar: adminJar,
    body: {
      title,
      startTime: clock.t - 60,
      cutoffTime: clock.t + 8 * HOUR,
      treeDepth: 16,
      jurisdictionId: 'demo',
      questions: [{ type: 'YES_NO', prompt: 'Adopt?' }],
    },
  });
  assert.equal(created.status, 201, created.json?.error);
  const id = created.json.election.id;
  const reg = await api('POST', `/api/elections/${id}/register`, {
    jar: adminJar,
    body: { identityCommitment: '0xabc1' },
  });
  assert.equal(reg.status, 201, reg.json?.error);
  const freeze = await api('POST', `/api/elections/${id}/freeze`, { jar: adminJar });
  assert.equal(freeze.status, 200, freeze.json?.error);
  return id;
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
  assert.equal(vote.status, 201, vote.json?.error);
  return vote;
}

async function publicCount(api, id) {
  const detail = await api('GET', `/api/elections/${id}`);
  const ballots = await api('GET', `/api/elections/${id}/ballots`);
  const summary = await api('GET', `/api/elections/${id}/summary`);
  const results = await api('GET', `/api/elections/${id}/results`);
  const blocks = await api('GET', '/api/explorer/blocks');
  let voteTxs = 0;
  for (const block of blocks.json.blocks || []) {
    const one = await api('GET', `/api/explorer/blocks/${block.number}`);
    voteTxs += (one.json.block.txs || []).filter((tx) => String(tx.type).toUpperCase() === 'VOTE' && String(tx.electionId) === String(id)).length;
  }
  return {
    detail: detail.json.acceptedBallots,
    ballots: ballots.json.ballots.length,
    summary: summary.json.acceptedBallots,
    results: results.json.acceptedBallots,
    disclosed: detail.json.disclosure.acceptedBallotsDisclosed,
    voteTxs,
  };
}

describe('disclosure delay on the public API', () => {
  let app;
  const clock = { t: HOUR_START + 59 * 60 };

  before(async () => {
    app = await startApp(clock, { disclosureDelaySeconds: 1800, resultsMinVotes: 0, disclosureMinBlockVotes: 1 });
  });
  after(async () => {
    await app.stop();
  });

  test('08:59 stays hidden at 09:00 and appears at 09:30', async () => {
    const id = await openElection(app.api, app.adminJar, clock, 'Delay precinct');
    const vote = await cast(app.api, id, 1);
    assert.equal(vote.json.published, false);
    assert.equal(vote.json.nextPublishAt, HOUR_START + HOUR + 1800);

    clock.t = HOUR_START + HOUR;
    const atClose = await publicCount(app.api, id);
    assert.deepEqual(atClose, { detail: 0, ballots: 0, summary: 0, results: 0, disclosed: 0, voteTxs: 0 });

    clock.t = HOUR_START + HOUR + 1800 - 1;
    const almost = await publicCount(app.api, id);
    assert.equal(almost.detail, 0);
    assert.equal(almost.voteTxs, 0);

    clock.t = HOUR_START + HOUR + 1800;
    const published = await publicCount(app.api, id);
    assert.equal(published.detail, 1);
    assert.equal(published.ballots, 1);
    assert.equal(published.summary, 1);
    assert.equal(published.results, 1);
    assert.equal(published.disclosed, 1);
    assert.equal(published.voteTxs, 1);
    const blocks = await app.api('GET', '/api/explorer/blocks');
    const one = await app.api('GET', `/api/explorer/blocks/${blocks.json.blocks[0].number}`);
    const votes = (one.json.block.txs || []).filter((tx) => String(tx.type).toUpperCase() === 'VOTE');
    assert.equal(votes.length, 1);
    assert.equal(votes[0].timestamp, HOUR_START + HOUR + 1800);
  });
});

describe('results gate on the public API', () => {
  let app;
  const clock = { t: HOUR_START + 20 * 60 };

  before(async () => {
    app = await startApp(clock, { disclosureDelaySeconds: 0, resultsMinVotes: 3, disclosureMinBlockVotes: 1 });
  });
  after(async () => {
    await app.stop();
  });

  test('turnout stays hidden until the Nth ballot, even after the hour closes', async () => {
    const id = await openElection(app.api, app.adminJar, clock, 'Count gate');
    await cast(app.api, id, 1);
    await cast(app.api, id, 2);
    clock.t = HOUR_START + HOUR;
    const early = await publicCount(app.api, id);
    assert.equal(early.detail, 0);
    assert.equal(early.voteTxs, 0);
    assert.equal(early.ballots, 0);

    clock.t = HOUR_START + HOUR + 30;
    await cast(app.api, id, 3);
    const still = await publicCount(app.api, id);
    assert.equal(still.detail, 2, 'the two delay-ready ballots publish; the new hour stays sealed');
    assert.equal(still.voteTxs, 2);
    assert.equal(still.ballots, 2);
  });

  test('scheduled end opens the gate before the count is reached', async () => {
    const id = await openElection(app.api, app.adminJar, clock, 'End gate');
    await cast(app.api, id, 11);
    clock.t = HOUR_START + 2 * HOUR;
    const beforeEnd = await publicCount(app.api, id);
    assert.equal(beforeEnd.detail, 0);
    const election = app.store.requireElection(id);
    election.cutoffTime = clock.t - 1;
    await app.store.persist();
    const afterEnd = await publicCount(app.api, id);
    assert.equal(afterEnd.detail, 1);
    assert.equal(afterEnd.voteTxs, 1);
    assert.equal(afterEnd.ballots, 1);
  });
});

describe('small disclosure blocks merge forward', () => {
  let app;
  const clock = { t: HOUR_START + 15 * 60 };

  before(async () => {
    app = await startApp(clock, { disclosureDelaySeconds: 0, resultsMinVotes: 0, disclosureMinBlockVotes: 4 });
  });
  after(async () => {
    await app.stop();
  });

  test('two short hours become one block, and a short election waits for the tally', async () => {
    const id = await openElection(app.api, app.adminJar, clock, 'Merge hours');
    await cast(app.api, id, 21);
    await cast(app.api, id, 22);
    clock.t = HOUR_START + HOUR;
    const firstHour = await publicCount(app.api, id);
    assert.equal(firstHour.detail, 0);
    assert.equal(firstHour.voteTxs, 0);

    clock.t = HOUR_START + HOUR + 10 * 60;
    await cast(app.api, id, 23);
    await cast(app.api, id, 24);
    clock.t = HOUR_START + 2 * HOUR;
    const merged = await publicCount(app.api, id);
    assert.equal(merged.detail, 4);
    assert.equal(merged.voteTxs, 4);
    const blocks = await app.api('GET', '/api/explorer/blocks');
    let found = 0;
    for (const block of blocks.json.blocks || []) {
      const one = await app.api('GET', `/api/explorer/blocks/${block.number}`);
      const votes = (one.json.block.txs || []).filter(
        (tx) => String(tx.type).toUpperCase() === 'VOTE' && String(tx.electionId) === String(id),
      );
      if (votes.length) {
        found += 1;
        assert.equal(votes.length, 4);
        assert.equal(one.json.block.timestamp, HOUR_START + 2 * HOUR);
      }
    }
    assert.equal(found, 1);

    const shortId = await openElection(app.api, app.adminJar, clock, 'Below minimum');
    clock.t = HOUR_START + 2 * HOUR + 5 * 60;
    await cast(app.api, shortId, 31);
    await cast(app.api, shortId, 32);
    const election = app.store.requireElection(shortId);
    election.cutoffTime = clock.t - 1;
    await app.store.persist();
    clock.t = HOUR_START + 4 * HOUR;
    const withheld = await publicCount(app.api, shortId);
    assert.equal(withheld.detail, 0);
    assert.equal(withheld.voteTxs, 0);
    const tallied = await app.api('POST', `/api/elections/${shortId}/tally`, {
      jar: app.adminJar,
      body: { counts: [2, 0] },
    });
    assert.equal(tallied.status, 200, tallied.json?.error);
    const released = await publicCount(app.api, shortId);
    assert.equal(released.detail, 2);
    assert.equal(released.voteTxs, 2);
  });
});

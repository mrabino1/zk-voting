// NOT FOR PROFIT — civic public good, not a commercial product.
// Hourly public disclosure: votes are accepted immediately but do not appear on
// any dashboard until the hour that contained them has closed.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { createApp } from '../src/server.mjs';
import { toBytes32 } from '../src/merkle.mjs';

const HOUR = 3600;
const HOUR_START = 1_699_999_200;

let tmp;
let app;
let server;
let base;
let clock;
let store;
const adminJar = {};
const voterJar = {};

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
  return { res, json, text, status: res.status };
}

function listen(application) {
  return new Promise((resolve, reject) => {
    const s = application.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
}

function leakKeys(value, acc = []) {
  if (!value || typeof value !== 'object') return acc;
  for (const [k, v] of Object.entries(value)) {
    if (
      /pending|unpublished|sealed|actual/i.test(k) &&
      k !== 'accepted' &&
      k !== 'published'
    ) {
      acc.push(k);
    }
    leakKeys(v, acc);
  }
  return acc;
}

describe('hourly polling-place unlinkability', () => {
  before(async () => {
    clock = HOUR_START + 23 * 60;
    tmp = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-hourly-'));
    const created = await createApp({
      dataDir: tmp,
      allowDevLogin: true,
      adminHandle: 'admin',
      quiet: true,
      port: 0,
      disclosureIntervalSeconds: HOUR,
      nowFn: () => clock,
    });
    app = created.app;
    server = await listen(app);
    base = `http://127.0.0.1:${server.address().port}`;
    await api('POST', '/api/auth/dev-login', { body: { handle: 'admin' }, jar: adminJar });
    await api('POST', '/api/auth/dev-login', {
      body: { handle: 'voter1', role: 'voter' },
      jar: voterJar,
    });
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await rm(tmp, { recursive: true, force: true });
  });

  test('config advertises the hourly policy and never a pending count', async () => {
    const { status, json } = await api('GET', '/api/config');
    assert.equal(status, 200);
    assert.equal(json.disclosure.intervalSeconds, HOUR);
    assert.equal(json.disclosure.policy, 'hourly-polling-place-unlinkability');
    assert.equal(json.disclosure.lastPublishedAt, HOUR_START);
    assert.equal(json.disclosure.lastClosedHourAt, HOUR_START);
    assert.equal(json.disclosure.lastClosedHourStart, HOUR_START - HOUR);
    assert.equal(json.disclosure.nextPublishAt, HOUR_START + HOUR);
    assert.equal(json.disclosure.secondsUntilNext, 2220);
    assert.equal(json.disclosure.acceptedBallotsDisclosed, 0);
    assert.equal(leakKeys(json).length, 0);
  });

  test('a vote is accepted immediately but absent from every public dashboard until the hour closes', async () => {
    const created = await api('POST', '/api/elections', {
      jar: adminJar,
      body: {
        title: 'Precinct privacy',
        startTime: clock - 60,
        cutoffTime: clock + 7 * HOUR,
        treeDepth: 16,
        jurisdictionId: 'demo',
        questions: [{ type: 'YES_NO', prompt: 'Adopt?' }],
      },
    });
    assert.equal(created.status, 201, created.json?.error);
    const id = created.json.election.id;
    assert.equal(created.json.election.acceptedBallots, 0);

    const reg = await api('POST', `/api/elections/${id}/register`, {
      jar: adminJar,
      body: { identityCommitment: '0xabc1' },
    });
    assert.equal(reg.status, 201, reg.json?.error);
    const freeze = await api('POST', `/api/elections/${id}/freeze`, { jar: adminJar });
    assert.equal(freeze.status, 200, freeze.json?.error);

    const laterNullifier = toBytes32('2');
    const earlierNullifier = toBytes32('1');
    const v2 = await api('POST', `/api/elections/${id}/vote`, {
      body: {
        proof: { accept: true },
        publicInputs: { nullifier: '2', electionId: id },
        encryptedBallot: '0xaa',
        identityCommitment: '0xabc1',
      },
    });
    assert.equal(v2.status, 201, v2.json?.error);
    assert.equal(v2.json.accepted, true);
    assert.equal(v2.json.published, false);
    assert.equal(v2.json.nextPublishAt, HOUR_START + HOUR);
    assert.deepEqual(Object.keys(v2.json.vote).sort(), [
      'ballotHash',
      'electionId',
      'nullifier',
      'relayer',
    ]);

    const v1 = await api('POST', `/api/elections/${id}/vote`, {
      body: {
        proof: { accept: true },
        publicInputs: { nullifier: '1', electionId: id },
        encryptedBallot: '0xbb',
        identityCommitment: '0xabc1',
      },
    });
    assert.equal(v1.status, 201, v1.json?.error);

    const dup = await api('POST', `/api/elections/${id}/vote`, {
      body: {
        proof: { accept: true },
        publicInputs: { nullifier: '2', electionId: id },
        encryptedBallot: '0xaa',
        identityCommitment: '0xabc1',
      },
    });
    assert.equal(dup.status, 409);

    const detail = await api('GET', `/api/elections/${id}`);
    assert.equal(detail.json.acceptedBallots, 0);
    assert.equal(detail.json.operatorInbox, undefined);
    assert.equal(detail.json.acceptedBallotsActual, undefined);
    assert.equal(leakKeys(detail.json).length, 0);

    const resultsLive = await api('GET', `/api/elections/${id}/results`);
    assert.equal(resultsLive.status, 200);
    assert.equal(resultsLive.json.acceptedBallots, 0);
    assert.equal(resultsLive.json.results.available, false);
    assert.equal(resultsLive.json.results.status, 'open');
    assert.equal(resultsLive.json.results.questions[0].options[0].count, null);
    assert.equal(resultsLive.json.results.questions[0].outcome, null);
    assert.equal(resultsLive.json.operatorInbox, undefined);
    assert.equal(leakKeys(resultsLive.json).length, 0);

    const list = await api('GET', '/api/elections');
    const row = list.json.elections.find((e) => e.id === id);
    assert.equal(row.acceptedBallots, 0);
    assert.equal(leakKeys(list.json).length, 0);

    const ballots = await api('GET', `/api/elections/${id}/ballots`);
    assert.equal(ballots.json.acceptedBallots, 0);
    assert.equal(ballots.json.ballots.length, 0);

    const n404 = await api('GET', `/api/explorer/nullifiers/${laterNullifier}`);
    assert.equal(n404.status, 404);

    const blocks = await api('GET', '/api/explorer/blocks');
    const voteBlocks = [];
    for (const b of blocks.json.blocks) {
      const one = await api('GET', `/api/explorer/blocks/${b.number}`);
      for (const tx of one.json.block.txs || []) {
        if (String(tx.type).toUpperCase() === 'VOTE') voteBlocks.push(tx);
      }
    }
    assert.equal(voteBlocks.length, 0);
    assert.equal(leakKeys(blocks.json).length, 0);
    assert.equal(blocks.json.disclosure.lastClosedHourAt, HOUR_START);
    assert.equal(blocks.json.disclosure.secondsUntilNext, 2220);
    assert.equal(blocks.json.disclosure.acceptedBallotsDisclosed, 0);

    const snap = await api('GET', '/api/explorer/disclosure');
    assert.equal(snap.status, 200);
    assert.equal(snap.json.disclosure.acceptedBallotsDisclosed, 0);
    assert.equal(snap.json.disclosure.lastClosedHourAt, HOUR_START);

    const summaryBefore = await api('GET', `/api/elections/${id}/summary`);
    assert.equal(summaryBefore.status, 200);
    assert.equal(summaryBefore.json.acceptedBallots, 0);
    assert.equal(summaryBefore.json.disclosure.acceptedBallotsDisclosed, 0);
    assert.equal(summaryBefore.json.disclosure.secondsUntilNext, 2220);
    assert.equal(summaryBefore.json.resultsUrl, null);
    assert.equal(summaryBefore.json.winner, undefined);
    assert.equal(leakKeys(summaryBefore.json).length, 0);

    clock = HOUR_START + HOUR;

    const publishedBallots = await api('GET', `/api/elections/${id}/ballots`);
    assert.equal(publishedBallots.json.acceptedBallots, 2);
    assert.equal(publishedBallots.json.ballots.length, 2);
    assert.equal(publishedBallots.json.ballots[0].acceptedAt, undefined);

    const after = await api('GET', `/api/elections/${id}`);
    assert.equal(after.json.acceptedBallots, 2);
    assert.equal(after.json.disclosure.acceptedBallotsDisclosed, 2);
    assert.equal(after.json.disclosure.lastClosedHourAt, HOUR_START + HOUR);
    assert.equal(after.json.disclosure.secondsUntilNext, HOUR);

    const summaryAfter = await api('GET', `/api/elections/${id}/summary`);
    assert.equal(summaryAfter.json.acceptedBallots, 2);
    assert.equal(summaryAfter.json.disclosure.acceptedBallotsDisclosed, 2);
    assert.equal(summaryAfter.json.resultsUrl, null);

    const explorerAfter = await api('GET', '/api/explorer/disclosure');
    assert.equal(explorerAfter.json.disclosure.acceptedBallotsDisclosed, 2);
    assert.equal(explorerAfter.json.disclosure.lastClosedHourAt, HOUR_START + HOUR);

    const resultsAfterHour = await api('GET', `/api/elections/${id}/results`);
    assert.equal(resultsAfterHour.json.acceptedBallots, 2);
    assert.equal(resultsAfterHour.json.results.available, false);
    assert.equal(resultsAfterHour.json.results.questions[0].options[0].count, null);

    const found = await api('GET', `/api/explorer/nullifiers/${laterNullifier}`);
    assert.equal(found.status, 200);
    assert.equal(found.json.tx.timestamp, HOUR_START + HOUR);
    assert.equal(found.json.tx.payload?.choice, undefined);

    const publishedBlocks = await api('GET', '/api/explorer/blocks');
    let lumped = null;
    for (const b of publishedBlocks.json.blocks) {
      const one = await api('GET', `/api/explorer/blocks/${b.number}`);
      const votes = (one.json.block.txs || []).filter((tx) => String(tx.type).toUpperCase() === 'VOTE');
      if (votes.length >= 2) lumped = { block: one.json.block, votes };
    }
    assert.ok(lumped, 'both votes of the hour must share one disclosure block');
    assert.equal(lumped.block.timestamp, HOUR_START + HOUR);
    assert.equal(lumped.votes[0].timestamp, HOUR_START + HOUR);
    assert.equal(lumped.votes[1].timestamp, HOUR_START + HOUR);
    const nullifiers = lumped.votes.map((tx) => String(tx.nullifier));
    assert.deepEqual(
      nullifiers,
      [earlierNullifier, laterNullifier].sort((a, b) => a.localeCompare(b)),
    );
    assert.deepEqual(
      lumped.votes.map((tx) => String(tx.nullifier)),
      [...nullifiers].sort((a, b) => a.localeCompare(b)),
    );
  });
});

describe('disclosure hour-boundary vote', () => {
  const boundaryAdminJar = {};
  const boundaryVoterJar = {};

  before(async () => {
    clock = HOUR_START;
    tmp = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-boundary-'));
    const created = await createApp({
      dataDir: tmp,
      allowDevLogin: true,
      adminHandle: 'admin',
      quiet: true,
      port: 0,
      disclosureIntervalSeconds: HOUR,
      nowFn: () => clock,
    });
    app = created.app;
    store = created.store;
    server = await listen(app);
    base = `http://127.0.0.1:${server.address().port}`;
    await api('POST', '/api/auth/dev-login', { body: { handle: 'admin' }, jar: boundaryAdminJar });
    await api('POST', '/api/auth/dev-login', {
      body: { handle: 'voter1', role: 'voter' },
      jar: boundaryVoterJar,
    });
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await rm(tmp, { recursive: true, force: true });
  });

  test('a vote at the exact hour start stays sealed until the next hour closes', async () => {
    const created = await api('POST', '/api/elections', {
      jar: boundaryAdminJar,
      body: {
        title: 'Boundary precinct',
        startTime: clock - 60,
        cutoffTime: clock + 7 * HOUR,
        treeDepth: 16,
        jurisdictionId: 'demo',
        questions: [{ type: 'YES_NO', prompt: 'Adopt?' }],
      },
    });
    assert.equal(created.status, 201, created.json?.error);
    const id = created.json.election.id;
    const reg = await api('POST', `/api/elections/${id}/register`, {
      jar: boundaryAdminJar,
      body: { identityCommitment: '0xabc1' },
    });
    assert.equal(reg.status, 201, reg.json?.error);
    const freeze = await api('POST', `/api/elections/${id}/freeze`, { jar: boundaryAdminJar });
    assert.equal(freeze.status, 200, freeze.json?.error);

    const vote = await api('POST', `/api/elections/${id}/vote`, {
      body: {
        proof: { accept: true },
        publicInputs: { nullifier: '7', electionId: id },
        encryptedBallot: '0xee',
        identityCommitment: '0xabc1',
      },
    });
    assert.equal(vote.status, 201, vote.json?.error);
    assert.equal(vote.json.published, false);
    assert.equal(vote.json.nextPublishAt, HOUR_START + HOUR);

    const stillSealed = await api('GET', `/api/elections/${id}/summary`);
    assert.equal(stillSealed.json.acceptedBallots, 0);
    assert.equal(stillSealed.json.disclosure.acceptedBallotsDisclosed, 0);
    assert.equal(stillSealed.json.disclosure.lastClosedHourAt, HOUR_START);
    assert.equal(stillSealed.json.disclosure.secondsUntilNext, HOUR);
    assert.equal(stillSealed.json.resultsUrl, null);

    const explorerSealed = await api('GET', '/api/explorer/disclosure');
    assert.equal(explorerSealed.json.disclosure.acceptedBallotsDisclosed, 0);

    clock = HOUR_START + HOUR;

    const opened = await api('GET', `/api/elections/${id}/summary`);
    assert.equal(opened.json.acceptedBallots, 1);
    assert.equal(opened.json.disclosure.acceptedBallotsDisclosed, 1);
    assert.equal(opened.json.disclosure.lastClosedHourAt, HOUR_START + HOUR);
    assert.equal(opened.json.resultsUrl, null);

    const explorerOpen = await api('GET', '/api/explorer/disclosure');
    assert.equal(explorerOpen.json.disclosure.acceptedBallotsDisclosed, 1);

    const election = store.requireElection(id);
    election.cutoffTime = clock - 1;
    await store.persist();

    const tallied = await api('POST', `/api/elections/${id}/tally`, {
      jar: boundaryAdminJar,
      body: { counts: [1, 0] },
    });
    assert.equal(tallied.status, 200, tallied.json?.error);

    const afterTally = await api('GET', `/api/elections/${id}/summary`);
    assert.equal(afterTally.json.resultsUrl, `/elections/${id}/results`);
    assert.equal(afterTally.json.winner, undefined);
    assert.equal(afterTally.json.tally, undefined);
    assert.equal(afterTally.json.disclosure.acceptedBallotsDisclosed, 1);
    assert.equal(leakKeys(afterTally.json).length, 0);
  });

  test('explorer HTML hosts the hour-bucket snapshot region', async () => {
    const page = await api('GET', '/explorer');
    assert.equal(page.status, 200);
    assert.match(page.text, /disclosure-banner/);
    assert.match(page.text, /disclosure-snapshot/);
    assert.match(page.text, /Last closed hour|hour that contained them closes/i);
  });
});

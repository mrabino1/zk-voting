// NOT FOR PROFIT — civic public good, not a commercial product.
// IS_DEMO monthly soft-delete. Missing or unrecognised IS_DEMO is not a demo.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

import { getConfig, parseIsDemo } from '../src/config.mjs';
import { MIGRATIONS } from '../src/db.mjs';
import {
  demoPurgeMode,
  noteDemoAbuse,
  registerDemoPurgeSchedule,
  runDemoMonthlyPurge,
} from '../src/demoPurge.mjs';
import { isClaimedPerson } from '../src/identity.mjs';
import { hasClaimedSuperAdmin, readSetup } from '../src/setup.mjs';
import { Store } from '../src/store.mjs';
import { openBallots } from '../src/tallyOpen.mjs';

const dirs = [];

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function openStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zk-demo-purge-'));
  dirs.push(dir);
  const store = await Store.open({ dataDir: dir, adminHandle: 'admin', quiet: true });
  return store;
}

function superAdmin(store) {
  return store.data.users.find((user) => user.role === 'platform_super_admin');
}

describe('parseIsDemo', () => {
  test('unset, blank, false, and 0 are not a demo and do not warn', () => {
    const warnings = [];
    const warn = (message) => warnings.push(message);
    assert.equal(parseIsDemo(undefined, { warn }), false);
    assert.equal(parseIsDemo(null, { warn }), false);
    assert.equal(parseIsDemo('', { warn }), false);
    assert.equal(parseIsDemo('   ', { warn }), false);
    assert.equal(parseIsDemo('false', { warn }), false);
    assert.equal(parseIsDemo('FALSE', { warn }), false);
    assert.equal(parseIsDemo('0', { warn }), false);
    assert.equal(parseIsDemo(false, { warn }), false);
    assert.equal(warnings.length, 0);
  });

  test('only true and 1 are a demo; anything else is false with a warning', () => {
    assert.equal(parseIsDemo('true'), true);
    assert.equal(parseIsDemo('TRUE'), true);
    assert.equal(parseIsDemo(' 1 '), true);
    assert.equal(parseIsDemo(true), true);
    const warnings = [];
    for (const value of ['yes', 'on', 'no', '2', 'demo']) {
      assert.equal(parseIsDemo(value, { warn: (message) => warnings.push(message) }), false);
    }
    assert.equal(warnings.length, 5);
    assert.match(warnings[0], /treating as false/);
  });

  test('getConfig with IS_DEMO unset is false', () => {
    const prev = process.env.IS_DEMO;
    delete process.env.IS_DEMO;
    try {
      assert.equal(getConfig({}).isDemo, false);
    } finally {
      if (prev === undefined) delete process.env.IS_DEMO;
      else process.env.IS_DEMO = prev;
    }
  });
});

describe('scheduler registration', () => {
  test('unset, false, and garbage do not register; true does', () => {
    const timers = [];
    const setIntervalFn = (fn) => {
      timers.push(fn);
      return { unref() {} };
    };
    const setTimeoutFn = () => ({ unref() {} });
    for (const isDemo of [undefined, false, parseIsDemo('garbage', { warn() {} }), parseIsDemo(undefined)]) {
      timers.length = 0;
      const schedule = registerDemoPurgeSchedule({
        config: { isDemo },
        store: { data: {} },
        setIntervalFn,
        setTimeoutFn,
      });
      assert.equal(schedule.registered, false);
      assert.equal(timers.length, 0);
      schedule.stop();
    }
    const on = registerDemoPurgeSchedule({
      config: { isDemo: true },
      store: { data: {} },
      setIntervalFn,
      setTimeoutFn,
    });
    assert.equal(on.registered, true);
    assert.equal(timers.length, 1);
    on.stop();
  });
});

describe('runDemoMonthlyPurge', () => {
  test('a direct call does nothing unless isDemo is strictly true', async () => {
    const store = await openStore();
    store.data.votes.push({ id: 'v', electionId: 'e', nullifier: 'n' });
    const before = JSON.stringify(store.data);
    const logs = [];
    const log = (line) => logs.push(line);
    for (const isDemo of [undefined, false, 'true', 'false', 1]) {
      const result = await runDemoMonthlyPurge({ config: { isDemo }, store, log });
      assert.equal(result.ran, false);
      assert.equal(result.reason, 'not_demo');
      assert.equal(result.marked, 0);
    }
    assert.equal(JSON.stringify(store.data), before);
    assert.ok(logs.every((line) => line.includes('IS_DEMO is not true')));
  });

  test('January targets abusive logins and leaves civic votes and shells', async () => {
    assert.equal(demoPurgeMode(new Date(Date.UTC(2026, 0, 15))), 'targeted');
    const store = await openStore();
    const abuser = store.createUser({ handle: 'abuser', role: 'voter' });
    abuser.suspendedAt = '2026-01-02T00:00:00.000Z';
    abuser.activeEthAddress = '0xAbC';
    const fraud = store.createUser({ handle: 'fraud', role: 'voter' });
    store.data.identityLinks.push({
      userId: fraud.id,
      identityCommitment: '0xabc',
      electionId: 'e1',
    });
    store.data.disqualifications.push({
      electionId: 'e1',
      identityCommitment: '0xABC',
      reasonCode: 11,
    });
    const clean = store.createUser({ handle: 'clean', role: 'voter' });
    const far = Date.now() + 60_000;
    store.data.sessions.push(
      { id: 's-abuser', userId: abuser.id, expiresAt: far },
      { id: 's-fraud', userId: fraud.id, expiresAt: far },
      { id: 's-clean', userId: clean.id, expiresAt: far },
    );
    store.data.pollBallots.push(
      { id: 'pb-abuser', pollId: 'p1', voter: '0xabc' },
      { id: 'pb-clean', pollId: 'p1', voter: '0xdef' },
    );
    store.data.votes.push({ id: 'vote-1', electionId: 'e1', nullifier: 'n1', ballotHash: 'b1' });
    store.data.elections.push({
      id: 'e1',
      title: 'Shell',
      questions: [{ id: 'q1', options: ['yes', 'no'] }],
      acceptedBallots: 1,
    });
    const result = await runDemoMonthlyPurge({
      config: { isDemo: true },
      store,
      now: new Date(Date.UTC(2026, 0, 15)),
      log() {},
    });
    assert.equal(result.ran, true);
    assert.equal(result.mode, 'targeted');
    assert.equal(result.monthKey, '2026-01');
    assert.equal(store.getSession('s-abuser'), null);
    assert.equal(store.getSession('s-fraud'), null);
    assert.ok(store.getSession('s-clean'));
    assert.equal(store.data.sessions.find((row) => row.id === 's-abuser').is_deleted, true);
    assert.equal(store.listPollBallots('p1').map((row) => row.id).join(','), 'pb-clean');
    assert.equal(store.data.pollBallots.find((row) => row.id === 'pb-abuser').is_deleted, true);
    assert.equal(store.listVotes('e1').length, 1);
    assert.deepEqual(store.getElection('e1').questions[0].options, ['yes', 'no']);
    const again = await runDemoMonthlyPurge({
      config: { isDemo: true },
      store,
      now: new Date(Date.UTC(2026, 0, 20)),
      log() {},
    });
    assert.equal(again.reason, 'already_ran');
    await store.savePollBallot({ id: 'pb-new', pollId: 'p1', voter: '0xabc' });
    assert.equal(store.data.pollBallots.filter((row) => row.voter === '0xabc' && row.is_deleted === true).length, 1);
    assert.equal(store.listPollBallots('p1').some((row) => row.id === 'pb-new'), true);
  });

  test('February soft-deletes user data and keeps the shell, admin, and setup', async () => {
    assert.equal(demoPurgeMode(new Date(Date.UTC(2026, 1, 15))), 'full');
    const store = await openStore();
    const admin = superAdmin(store);
    admin.credentials = [{ id: 'cred-admin', publicKey: 'aa', counter: 0 }];
    store.data.meta.setup = { completedAt: '2026-01-01T00:00:00.000Z', chainId: 1 };
    store.data.meta.version = 9;
    store.data.meta.nodeId = 'node-1';
    const voter = store.createUser({ handle: 'voter', role: 'voter' });
    voter.email = 'voter@example.org';
    const far = Date.now() + 60_000;
    store.data.sessions.push(
      { id: 's-admin', userId: admin.id, expiresAt: far },
      { id: 's-voter', userId: voter.id, expiresAt: far },
    );
    store.data.votes.push({ id: 'vote-1', electionId: 'e1', nullifier: 'n1', ballotHash: 'b1' });
    store.data.envelopes.push({ id: 'env-1', electionId: 'e1', encryptedBallot: { c: 1 } });
    store.data.registrations.push({ id: 'reg-1', electionId: 'e1', identityCommitment: '0x1' });
    store.data.jurisdictions.push({ id: 'j1', name: 'City' });
    store.data.elections.push({
      id: 'e1',
      title: 'Shell',
      questions: [{ id: 'q1', options: ['a', 'b'] }],
      acceptedBallots: 4,
      tally: { counts: [1, 0] },
    });
    const result = await runDemoMonthlyPurge({
      config: { isDemo: true },
      store,
      now: new Date(Date.UTC(2026, 1, 15)),
      log() {},
    });
    assert.equal(result.ran, true);
    assert.equal(result.mode, 'full');
    assert.equal(store.listVotes('e1').length, 0);
    assert.equal(store.data.votes.length, 1);
    assert.equal(store.data.votes[0].is_deleted, true);
    assert.equal(store.data.votes[0].deleted_at, '2026-02-15T00:00:00.000Z');
    assert.equal(store.listEnvelopes('e1').length, 0);
    assert.equal(store.data.envelopes[0].is_deleted, true);
    assert.equal(store.getUser(voter.id), null);
    assert.equal(store.data.users.find((row) => row.id === voter.id).is_deleted, true);
    assert.equal(store.getSession('s-voter'), null);
    assert.equal(store.getSession('s-admin'), null);
    assert.equal(store.getUser(admin.id).role, 'platform_super_admin');
    assert.equal(store.getUser(admin.id).credentials[0].id, 'cred-admin');
    assert.equal(hasClaimedSuperAdmin(store, isClaimedPerson), true);
    assert.equal(readSetup(store).completedAt, '2026-01-01T00:00:00.000Z');
    assert.equal(store.data.meta.version, 9);
    assert.equal(store.data.meta.nodeId, 'node-1');
    assert.deepEqual(store.getElection('e1').questions[0].options, ['a', 'b']);
    assert.deepEqual(store.getElection('e1').tally.counts, [1, 0]);
    assert.equal(store.data.registrations.length, 1);
    assert.equal(store.data.registrations[0].is_deleted, undefined);
    assert.equal(store.data.jurisdictions.find((row) => row.id === 'j1').name, 'City');
    assert.equal(store.visibleAcceptedBallots(store.getElection('e1')), 3);
    await store.createSession(admin.id, 60_000);
    assert.equal(store.data.sessions.filter((row) => row.is_deleted === true).length, 2);
  });

  test('standby does not run and does not record the month', async () => {
    const store = await openStore();
    store.writerActive = false;
    const result = await runDemoMonthlyPurge({
      config: { isDemo: true },
      store,
      now: new Date(Date.UTC(2026, 0, 15)),
      log() {},
    });
    assert.equal(result.reason, 'standby');
    assert.equal(store.data.meta.demoPurge, undefined);
  });
});

describe('soft-delete visibility', () => {
  test('openBallots ignores a soft-deleted extra envelope', async () => {
    const election = {
      id: 'e1',
      acceptedBallots: 1,
      questions: [],
      tallyCeremony: { status: 'ready', publicKey: 'pk', verificationKeys: ['vk'] },
    };
    await assert.rejects(
      () => openBallots(election, [{ encryptedBallot: null }, { encryptedBallot: null }], [], []),
      (err) => err.extra?.code === 'ENVELOPE_GAP',
    );
    election.acceptedBallots = 2;
    await assert.rejects(
      () =>
        openBallots(
          election,
          [{ is_deleted: true, encryptedBallot: { c: 1 } }, { encryptedBallot: null }],
          [],
          [],
        ),
      (err) => err.extra?.code !== 'ENVELOPE_GAP',
    );
  });

  test('migration 2 adds the columns idempotently', () => {
    const migration = MIGRATIONS.find((row) => row.version === 2);
    assert.equal(migration.name, 'soft-delete flags on document rows');
    assert.match(migration.sql, /ADD COLUMN IF NOT EXISTS is_deleted boolean NOT NULL DEFAULT false/);
    assert.match(migration.sql, /ADD COLUMN IF NOT EXISTS deleted_at timestamptz/);
  });
});

describe('noteDemoAbuse', () => {
  test('records a signal only when IS_DEMO is true and the user is not super admin', async () => {
    const store = await openStore();
    const voter = store.createUser({ handle: 'voter', role: 'voter' });
    const admin = superAdmin(store);
    assert.equal(noteDemoAbuse(store, { isDemo: false }, voter.id, 'PIN_LOCKED'), false);
    assert.equal(voter.demoAbuseSignals, undefined);
    assert.equal(noteDemoAbuse(store, { isDemo: true }, admin.id, 'PIN_LOCKED'), false);
    assert.equal(noteDemoAbuse(store, { isDemo: true }, voter.id, 'PIN_LOCKED'), true);
    assert.equal(voter.demoAbuseSignals[0].code, 'PIN_LOCKED');
    const targeted = await runDemoMonthlyPurge({
      config: { isDemo: true },
      store,
      now: new Date(Date.UTC(2026, 0, 15)),
      log() {},
    });
    assert.equal(targeted.ran, true);
    assert.equal(store.getUser(voter.id).demoAbuseSignals[0].code, 'PIN_LOCKED');
    assert.equal(store.data.sessions.filter((row) => row.userId === voter.id && row.is_deleted).length, 0);
  });
});

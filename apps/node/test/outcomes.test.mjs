// NOT FOR PROFIT — civic public good, not a commercial product.
// Public outcomes monitor: before / during / after from chain status, with verification.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { createApp } from '../src/server.mjs';
import { outcomePhase, hexEq, verifyChainStatus } from '../src/outcomes.mjs';
import { electionState } from '../src/electionState.mjs';
import { mintScopedPublicId } from '../src/electionIds.mjs';

const ZEBRA = 'ZEBRA-CANDIDATE-ALPHA';
const NOW = 1_700_000_000;

let tmp;
let app;
let store;
let server;
let base;
let clock;
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

function leakChoice(value, acc = []) {
  if (value == null) return acc;
  if (typeof value === 'string') {
    if (value.includes(ZEBRA) || /I voted for/i.test(value)) acc.push(value.slice(0, 80));
    return acc;
  }
  if (typeof value !== 'object') return acc;
  for (const [k, v] of Object.entries(value)) {
    if (/^(choice|optionId|optionIds|answers|selected|plaintext|ranking|candidate)$/i.test(k)) {
      acc.push(k);
    }
    leakChoice(v, acc);
  }
  return acc;
}

function unofficialCounts(payload) {
  const hits = [];
  function walk(node, trail) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${trail}[${i}]`));
      return;
    }
    if ('count' in node && node.count != null && (node.label || node.id) && trail.includes('option')) {
      hits.push(`${trail}.count=${node.count}`);
    }
    if (Array.isArray(node.counts) && trail.includes('certified') === false && trail.includes('tally') ) {
      hits.push(`${trail}.counts`);
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === 'certified') continue;
      walk(v, `${trail}.${k}`);
    }
  }
  walk(payload, 'root');
  return hits;
}

const YES_NO = [
  {
    type: 'YES_NO',
    prompt: 'Adopt the sample ordinance?',
    options: [
      { id: 'yes', label: 'Yes' },
      { id: 'no', label: 'No' },
    ],
  },
];

describe('outcome phase helpers', () => {
  test('maps election states onto before / during / after', () => {
    assert.equal(outcomePhase(0), 'before');
    assert.equal(outcomePhase(1), 'before');
    assert.equal(outcomePhase(2), 'during');
    assert.equal(outcomePhase(3), 'after');
    assert.equal(outcomePhase(4), 'after');
    assert.equal(hexEq('0xabc', '0x000abc'), true);
  });

  test('chain status fails when freeze roots drift', () => {
    const election = {
      startTime: NOW - 100,
      cutoffTime: NOW + 100,
      rollFrozen: true,
      lateUpdateAllowed: false,
      frozenEligibleRoot: '0x01',
      eligibleRoot: '0x02',
      frozenDisqualificationRoot: '0xaa',
      disqualificationRoot: '0xaa',
      onChainElectionId: '1',
    };
    const state = electionState(election, NOW);
    assert.equal(state, 2);
    const result = verifyChainStatus(election, { config: { chainId: 27427 } }, NOW, state, 'during');
    assert.equal(result.ok, false);
    assert.equal(result.checks.frozenEligibleRoot, false);
    assert.equal(result.checks.frozenDisqualificationRoot, true);
  });

  test('copied UUID from another jurisdiction fails publicIdMatchesScope', () => {
    const honest = mintScopedPublicId({
      factoryAddress: '0x1111111111111111111111111111111111111111',
      chainId: 27427,
      onChainElectionId: '1',
      jurisdictionId: 'north',
    });
    const election = {
      id: honest,
      startTime: NOW - 100,
      cutoffTime: NOW + 100,
      rollFrozen: true,
      lateUpdateAllowed: false,
      frozenEligibleRoot: '0x01',
      eligibleRoot: '0x01',
      frozenDisqualificationRoot: '0xaa',
      disqualificationRoot: '0xaa',
      onChainElectionId: '1',
      jurisdictionId: 'south',
      factoryAddress: '0x1111111111111111111111111111111111111111',
      chainId: 27427,
    };
    const state = electionState(election, NOW);
    const result = verifyChainStatus(election, { config: { chainId: 27427 } }, NOW, state, 'during');
    assert.equal(result.checks.publicIdMatchesScope, false);
    assert.equal(result.ok, false);
  });

  test('posted L1 factory that is not the pin fails l1FactoryMatchesPinned', () => {
    const pin = '0x1111111111111111111111111111111111111111';
    const rogue = '0x2222222222222222222222222222222222222222';
    const hash = `0x${'ab'.repeat(32)}`;
    const election = {
      id: mintScopedPublicId({
        factoryAddress: rogue,
        chainId: 27427,
        onChainElectionId: '1',
        jurisdictionId: 'north',
      }),
      startTime: NOW - 100,
      cutoffTime: NOW + 100,
      rollFrozen: true,
      lateUpdateAllowed: false,
      frozenEligibleRoot: '0x01',
      eligibleRoot: '0x01',
      frozenDisqualificationRoot: '0xaa',
      disqualificationRoot: '0xaa',
      onChainElectionId: '1',
      jurisdictionId: 'north',
      factoryAddress: rogue,
      chainId: 27427,
      tally: {
        countsHash: hash,
        l1: { posted: true, status: 'posted', resultHash: hash, factory: rogue },
      },
    };
    const state = electionState(election, NOW);
    const result = verifyChainStatus(
      election,
      { config: { chainId: 27427, electionFactoryAddress: pin } },
      NOW,
      state,
      'during',
    );
    assert.equal(result.checks.l1FactoryMatchesPinned, false);
    assert.equal(result.ok, false);
  });
});

describe('outcomes monitor HTTP', () => {
  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'republic-outcomes-'));
    clock = NOW;
    const created = await createApp({
      dataDir: tmp,
      allowDevLogin: true,
      adminHandle: 'admin',
      quiet: true,
      port: 0,
      disclosureIntervalSeconds: 0,
      electionFactoryAddress: '0x1111111111111111111111111111111111111111',
      nowFn: () => clock,
    });
    app = created.app;
    store = created.store;
    server = await listen(app);
    base = `http://127.0.0.1:${server.address().port}`;
    await api('POST', '/api/auth/dev-login', {
      body: { handle: 'admin', role: 'platform_admin' },
      jar: adminJar,
    });
    await api('POST', '/api/auth/dev-login', {
      body: { handle: 'outcomes-voter', role: 'voter' },
      jar: voterJar,
    });
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await rm(tmp, { recursive: true, force: true });
  });

  async function createElection(title, { startTime, cutoffTime } = {}) {
    const created = await api('POST', '/api/elections', {
      jar: adminJar,
      body: {
        title,
        startTime: startTime ?? clock + 3600,
        cutoffTime: cutoffTime ?? clock + 7200,
        treeDepth: 16,
        questions: YES_NO,
      },
    });
    assert.equal(created.status, 201, created.json?.error);
    return created.json.id;
  }

  test('GET /outcomes is the public SPA; config advertises the portal', async () => {
    const page = await api('GET', '/outcomes');
    assert.equal(page.status, 200);
    assert.match(page.res.headers.get('content-type') || '', /html/);
    assert.match(page.text, /NOT FOR PROFIT/);
    const alias = await api('GET', '/monitor');
    assert.equal(alias.status, 200);
    const cfg = await api('GET', '/api/config');
    assert.equal(cfg.json.outcomes.portal, '/outcomes');
    assert.deepEqual(cfg.json.outcomes.phases, ['before', 'during', 'after']);
    assert.equal(cfg.json.outcomes.unofficialCounts, false);
    assert.equal(cfg.json.outcomes.proveChoice, false);
  });

  test('missing election is 404', async () => {
    const missing = await api('GET', '/api/outcomes/not-a-real-election');
    assert.equal(missing.status, 404);
  });

  test('one contest moves before → during → after with verification', async () => {
    const id = await createElection('Outcomes clock contest', {
      startTime: clock + 60,
      cutoffTime: clock + 3600,
    });

    const before = await api('GET', `/api/outcomes/${id}`);
    assert.equal(before.status, 200, before.json?.error);
    assert.equal(before.json.schema, 'republic.outcomes.v1');
    assert.equal(before.json.phase, 'before');
    assert.equal(before.json.state, 0);
    assert.equal(before.json.certified, null);
    assert.equal(before.json.verification.ok, true, before.json.verification.errors?.join('; '));
    assert.equal(before.json.coercion.receiptsProveChoice, false);
    assert.equal(before.json.chain.mode, 'demo');
    assert.deepEqual(unofficialCounts(before.json), []);
    assert.deepEqual(leakChoice(before.json), []);

    await api('POST', `/api/elections/${id}/register`, {
      jar: adminJar,
      body: { identityCommitment: '0x0a11' },
    });
    const freeze = await api('POST', `/api/elections/${id}/freeze`, { jar: adminJar });
    assert.equal(freeze.status, 200, freeze.json?.error);

    const frozen = await api('GET', `/api/outcomes/${id}`);
    assert.equal(frozen.json.phase, 'before');
    assert.equal(frozen.json.state, 1);
    assert.equal(frozen.json.freeze.rollFrozen, true);
    assert.equal(frozen.json.verification.ok, true, frozen.json.verification.errors?.join('; '));
    assert.equal(frozen.json.verification.chain.checks.frozenEligibleRoot, true);

    clock = NOW + 120;
    const during = await api('GET', `/api/outcomes/${id}`);
    assert.equal(during.json.phase, 'during');
    assert.equal(during.json.state, 2);
    assert.equal(during.json.certified, null);
    assert.equal(during.json.verification.ok, true, during.json.verification.errors?.join('; '));
    assert.ok(during.json.questions?.length);
    assert.equal(during.json.questions[0].options[0].count, undefined);
    assert.deepEqual(unofficialCounts(during.json), []);

    const voted = await api('POST', `/api/elections/${id}/vote`, {
      body: {
        proof: { accept: true },
        publicInputs: { nullifier: '0x0b0d', electionId: id },
        encryptedBallot: '0x01',
        identityCommitment: '0x0a11',
      },
    });
    assert.equal(voted.status, 201, voted.json?.error);

    const stillOpen = await api('GET', `/api/outcomes/${id}`);
    assert.equal(stillOpen.json.phase, 'during');
    assert.equal(stillOpen.json.certified, null);
    assert.equal(stillOpen.json.turnout.acceptedBallots, 1);
    assert.deepEqual(unofficialCounts(stillOpen.json), []);
    assert.deepEqual(leakChoice(stillOpen.json), []);
    assert.doesNotMatch(JSON.stringify(stillOpen.json), new RegExp(ZEBRA));

    clock = NOW + 4000;
    const closed = await api('GET', `/api/outcomes/${id}`);
    assert.equal(closed.json.phase, 'after');
    assert.equal(closed.json.state, 3);
    assert.equal(closed.json.certified, null);
    assert.equal(closed.json.verification.ok, true, closed.json.verification.errors?.join('; '));

    const tally = await api('POST', `/api/elections/${id}/tally`, {
      jar: adminJar,
      body: { counts: [1, 0] },
    });
    assert.equal(tally.status, 200, tally.json?.error);

    const afterTally = await api('GET', `/api/outcomes/${id}`);
    assert.equal(afterTally.json.phase, 'after');
    assert.equal(afterTally.json.state, 4);
    assert.equal(afterTally.json.certified.available, true);
    assert.equal(afterTally.json.certified.questions[0].options[0].count, 1);
    assert.equal(afterTally.json.verification.ok, true, afterTally.json.verification.errors?.join('; '));
    assert.equal(afterTally.json.verification.auditor.ok, true);
    assert.match(afterTally.json.certified.questions[0].outcome.note, /Yes wins/i);
    assert.deepEqual(leakChoice(afterTally.json), []);
  });

  test('board columns split before / during / after from chain status', async () => {
    clock = NOW + 10_000;
    const beforeId = await createElection('Board before', {
      startTime: clock + 1000,
      cutoffTime: clock + 2000,
    });
    const duringId = await createElection('Board during', {
      startTime: clock - 10,
      cutoffTime: clock + 2000,
    });
    await api('POST', `/api/elections/${duringId}/freeze`, { jar: adminJar });
    const afterId = await createElection('Board after', {
      startTime: clock - 2000,
      cutoffTime: clock - 10,
    });
    await api('POST', `/api/elections/${afterId}/freeze`, { jar: adminJar });

    const onchainId = await createElection('Board onchain', {
      startTime: clock + 5000,
      cutoffTime: clock + 8000,
    });
    const onchain = store.requireElection(onchainId);
    onchain.createTxHash = `0x${'ab'.repeat(32)}`;
    onchain.onChainElectionAddress = '0x3333333333333333333333333333333333333333';
    await store.persist();

    const board = await api('GET', '/api/outcomes');
    assert.equal(board.status, 200);
    assert.equal(board.json.schema, 'republic.outcomes.v1');
    const ids = (list) => (list || []).map((e) => e.id);
    assert.ok(ids(board.json.phases.before).includes(beforeId));
    assert.ok(ids(board.json.phases.during).includes(duringId));
    assert.ok(ids(board.json.phases.after).includes(afterId));
    const onchainRow = board.json.elections.find((e) => e.id === onchainId);
    assert.equal(onchainRow.chainMode, 'onchain');
    assert.equal(onchainRow.phase, 'before');
    assert.equal(onchainRow.verificationOk, true);

    const duringDetail = await api('GET', `/api/outcomes/${duringId}`);
    assert.equal(duringDetail.json.phase, 'during');
    assert.equal(duringDetail.json.certified, null);

    const onchainDetail = await api('GET', `/api/outcomes/${onchainId}`);
    assert.equal(onchainDetail.json.chain.mode, 'onchain');
    assert.equal(onchainDetail.json.verification.chain.checks.chainModeConsistent, true);
  });

  test('mismatched L1 hash fails verification after tally', async () => {
    clock = NOW + 20_000;
    const id = await createElection('L1 mismatch', {
      startTime: clock - 100,
      cutoffTime: clock + 500,
    });
    await api('POST', `/api/elections/${id}/register`, {
      jar: adminJar,
      body: { identityCommitment: '0x0c01' },
    });
    await api('POST', `/api/elections/${id}/freeze`, { jar: adminJar });
    const voted = await api('POST', `/api/elections/${id}/vote`, {
      body: {
        proof: { accept: true },
        publicInputs: { nullifier: '0x0c02', electionId: id },
        encryptedBallot: '0x01',
        identityCommitment: '0x0c01',
      },
    });
    assert.equal(voted.status, 201, voted.json?.error);
    clock = NOW + 20_600;
    const tally = await api('POST', `/api/elections/${id}/tally`, {
      jar: adminJar,
      body: { counts: [1, 0] },
    });
    assert.equal(tally.status, 200, tally.json?.error);
    const election = store.requireElection(id);
    election.tally.l1 = {
      status: 'posted',
      posted: true,
      resultHash: `0x${'ff'.repeat(32)}`,
      countsHash: election.tally.countsHash,
    };
    await store.persist();
    const detail = await api('GET', `/api/outcomes/${id}`);
    assert.equal(detail.json.phase, 'after');
    assert.equal(detail.json.verification.ok, false);
    assert.equal(detail.json.verification.chain.checks.l1HashMatchesTally, false);
  });
});

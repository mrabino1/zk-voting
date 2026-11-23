// NOT FOR PROFIT — civic public good, not a commercial product.
// A civic vote on the rollup has no zero-knowledge eligibility proof yet, so the vote pass is
// its gate: only a signed-in voter on the roll gets one, one each, the ballot needs it, and a
// second ballot under a nullifier is refused (nothing proves the sender owns the nullifier).

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import * as bc from '../public/ballot-crypto.js';
import { blindVotePass, unblindVotePass } from '../public/vote-pass.js';
import { createApp } from '../src/server.mjs';
import { votePassIssueKey } from '../src/votePass.mjs';

let tmp;
let created;
let server;
let base;
const adminJar = {};
const voterJar = {};
const strangerJar = {};

function applyCookies(res, jar) {
  for (const c of res.headers.getSetCookie?.() || []) {
    const pair = c.split(';')[0];
    const i = pair.indexOf('=');
    if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
}

async function api(method, url, { body, jar } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(jar ? { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
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

/** A PIN token for a signed-in user, as POST /api/me/pin/verify would mint. */
function pinTokenFor(jarUserHandle) {
  const user = created.store.getUserByHandle(jarUserHandle);
  user.pinHash = user.pinHash || 'scrypt$test';
  const token = `pin-${jarUserHandle}-${Math.random()}`;
  created.pin.tokens.set(token, { userId: user.id, expiresAt: Date.now() + 60_000 });
  return token;
}

async function requestPass(id, jar, handle) {
  const key = await api('GET', `/api/elections/${id}/vote-pass`);
  const pending = await blindVotePass(key.json, id);
  const issued = await api('POST', `/api/elections/${id}/vote-pass`, {
    jar,
    body: { blinded: pending.blinded, ...(handle ? { pinToken: pinTokenFor(handle) } : {}) },
  });
  if (issued.status !== 201) return { issued };
  return { issued, pass: await unblindVotePass(key.json, id, pending, issued.json.blindSignature) };
}

const submitted = [];
const fakeClient = {
  chainId: 31337,
  address: '0x00000000000000000000000000000000000000aa',
  account: '0x00000000000000000000000000000000000000bb',
  submitBallot: async (b) => {
    submitted.push(b);
    return { status: 'pending', commitment: '99' };
  },
  receipt: async () => ({ status: 'pending' }),
  l2Status: async () => ({ rollup: '0xaa', chainId: 31337, lastBatch: 2, pendingBallots: 9, desertMode: false }),
  l2Batches: async () => ({ batches: [{ batchNumber: 2, ops: { ballots: 3 }, stateRoot: '1', txs: { commit: '0xc' }, executed: true }] }),
};

function ballot(nullifier) {
  const ctx = bc.contextOf({ chainId: 31337, rollup: fakeClient.address });
  return bc.toJSONSafe({ nullifier, ...bc.encryptBallot({ ctx, electionId: 7, jointKey: bc.mulBase(5n), optionCount: 2, choice: 0 }) });
}

describe('vote pass gate for a civic vote on the rollup', () => {
  let id;

  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'zkv-rollup-pass-'));
    created = await createApp({ dataDir: tmp, allowDevLogin: true, adminHandle: 'admin', quiet: true, port: 0, disclosureIntervalSeconds: 0 });
    // The rollup service with a fake L1/L2 client: these tests are about the node's gate.
    created.rollup.client = fakeClient;
    server = await new Promise((resolve) => {
      const s = created.app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${server.address().port}`;
    await api('POST', '/api/auth/dev-login', { jar: adminJar, body: { handle: 'admin', role: 'platform_admin' } });
    await api('POST', '/api/auth/dev-login', { jar: voterJar, body: { handle: 'voter-on-roll', role: 'voter' } });
    await api('POST', '/api/auth/dev-login', { jar: strangerJar, body: { handle: 'voter-off-roll', role: 'voter' } });
    const now = Math.floor(Date.now() / 1000);
    const made = await api('POST', '/api/elections', {
      jar: adminJar,
      body: {
        title: 'Parks bond',
        electionType: 'vote',
        startTime: now - 10,
        cutoffTime: now + 3600,
        treeDepth: 16,
        questions: [{ type: 'YES_NO', prompt: 'Adopt?' }],
      },
    });
    assert.equal(made.status, 201, made.text);
    id = made.json.id;
    const voter = created.store.getUserByHandle('voter-on-roll');
    const reg = await api('POST', `/api/elections/${id}/register`, {
      jar: adminJar,
      body: { identityCommitment: '0xfeed01', userId: voter.id },
    });
    assert.equal(reg.status, 201, reg.text);
    const election = created.store.requireElection(id);
    election.rollup = { electionId: 7, guardians: [], synced: { commitments: [], disqualified: [] }, receipts: {}, mailbox: [] };
    await created.store.persist();
  });

  after(async () => {
    await new Promise((r) => server.close(r));
    await rm(tmp, { recursive: true, force: true });
  });

  test('a civic vote not yet on L1 takes no pass and no ballot', async () => {
    const now = Math.floor(Date.now() / 1000);
    const draft = await api('POST', '/api/elections', {
      jar: adminJar,
      body: { title: 'Draft vote', electionType: 'vote', startTime: now - 10, cutoffTime: now + 3600, treeDepth: 16, questions: [{ type: 'YES_NO', prompt: '?' }] },
    });
    assert.equal(draft.status, 201, draft.text);
    const pass = await requestPass(draft.json.id, voterJar, 'voter-on-roll');
    assert.equal(pass.issued.status, 409, pass.issued.text);
    assert.equal(pass.issued.json.code, 'VOTE_NOT_ON_L1');
    const cast = await api('POST', `/api/elections/${draft.json.id}/vote`, { body: ballot(77n) });
    assert.equal(cast.status, 409, cast.text);
    assert.equal(cast.json.code, 'VOTE_NOT_ON_L1');
  });

  test('no session, or not on the roll: no pass', async () => {
    const anon = await requestPass(id);
    assert.equal(anon.issued.status, 401, anon.issued.text);
    assert.equal(anon.issued.json.code, 'SIGN_IN_REQUIRED');
    const stranger = await requestPass(id, strangerJar, 'voter-off-roll');
    assert.equal(stranger.issued.status, 403, stranger.issued.text);
    assert.equal(stranger.issued.json.code, 'NOT_ON_ROLL');
  });

  test('a ballot without a pass is refused, even from a signed-in voter with a PIN token', async () => {
    const res = await api('POST', `/api/elections/${id}/vote`, {
      jar: voterJar,
      body: { ...ballot(41n), pinToken: pinTokenFor('voter-on-roll') },
    });
    assert.equal(res.status, 403, res.text);
    assert.equal(res.json.code, 'VOTE_PASS_REQUIRED');
    assert.equal(submitted.length, 0);
  });

  test('one pass per voter; it casts one ballot; a nullifier takes one ballot', async () => {
    const { issued, pass } = await requestPass(id, voterJar, 'voter-on-roll');
    assert.equal(issued.status, 201, issued.text);
    const again = await requestPass(id, voterJar, 'voter-on-roll');
    assert.equal(again.issued.status, 409);
    assert.equal(again.issued.json.code, 'VOTE_PASS_ALREADY_ISSUED');

    const cast = await api('POST', `/api/elections/${id}/vote`, { body: { ...ballot(42n), votePass: pass } });
    assert.equal(cast.status, 201, cast.text);
    assert.equal(cast.json.rollup, true);
    assert.equal(submitted.length, 1);

    const reuse = await api('POST', `/api/elections/${id}/vote`, { body: { ...ballot(43n), votePass: pass } });
    assert.equal(reuse.status, 409);
    assert.equal(reuse.json.code, 'VOTE_PASS_SPENT');

    // Another voter's fresh pass cannot overwrite the ballot under nullifier 42.
    const other = created.store.getUserByHandle('voter-off-roll');
    const reg = await api('POST', `/api/elections/${id}/register`, {
      jar: adminJar,
      body: { identityCommitment: '0xfeed02', userId: other.id },
    });
    assert.equal(reg.status, 201, reg.text);
    const second = await requestPass(id, strangerJar, 'voter-off-roll');
    assert.equal(second.issued.status, 201, second.issued.text);
    const overwrite = await api('POST', `/api/elections/${id}/vote`, { body: { ...ballot(42n), votePass: second.pass } });
    assert.equal(overwrite.status, 409, overwrite.text);
    assert.equal(overwrite.json.code, 'NULLIFIER_USED');
    assert.equal(submitted.length, 1);
  });

  test('the poll book survives a restart: no second pass, and it holds no raw user id', async () => {
    const restarted = await createApp({ dataDir: tmp, allowDevLogin: true, adminHandle: 'admin', quiet: true, port: 0, disclosureIntervalSeconds: 0 });
    const user = restarted.store.getUserByHandle('voter-on-roll');
    const book = restarted.store.data.votePassIssued[String(id)];
    assert.ok(Array.isArray(book) && book.length === 2, 'both voters who took a pass are in the poll book');
    assert.equal(JSON.stringify(book).includes(user.id), false);
    assert.equal(restarted.store.votePassIssued(id, votePassIssueKey(id, `u:${user.id}`)), true);
    // A fresh vote-pass service on the restarted store refuses the voter.
    assert.throws(() => restarted.votePass.assertNotIssued(id, `u:${user.id}`), (err) => err.extra?.code === 'VOTE_PASS_ALREADY_ISSUED');
    await assert.rejects(() => restarted.votePass.claimIssue(id, `u:${user.id}`), (err) => err.extra?.code === 'VOTE_PASS_ALREADY_ISSUED');
  });

  test('the explorer lists rollup batches without the live pending-ballot count', async () => {
    const res = await api('GET', '/api/explorer/rollup');
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.configured, true);
    assert.equal(res.json.batches[0].batchNumber, 2);
    assert.equal(res.json.status.lastBatch, 2);
    assert.equal('pendingBallots' in res.json.status, false);
  });
});

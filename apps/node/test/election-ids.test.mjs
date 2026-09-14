// NOT FOR PROFIT — civic public good, not a commercial product.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import {
  SHORT_CODE_ALPHABET,
  SHORT_CODE_LENGTH,
  UUID_V4_RE,
  chainElectionId,
  electionMatchesRef,
  isShortCodeShape,
  isUuid,
  mintShortCode,
  mintUuid,
  parseOnChainElectionId,
  refsOf,
} from '../src/electionIds.mjs';
import { emptyTree } from '../src/merkle.mjs';
import { parseRoute } from '../public/router.js';
import { createApp } from '../src/server.mjs';

let tmp;
let app;
let store;
let server;
let base;
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

async function api(method, url, { body, jar, redirect } = {}) {
  const res = await fetch(base + url, {
    method,
    redirect: redirect || 'follow',
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

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

describe('election UUID + short code', () => {
  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'republic-eid-'));
    const created = await createApp({
      dataDir: tmp,
      allowDevLogin: true,
      adminHandle: 'admin',
      quiet: true,
      port: 0,
      disclosureIntervalSeconds: 0,
    });
    app = created.app;
    store = created.store;
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

  test('mintUuid is UUID v4; short codes are opaque url-safe tokens', () => {
    const id = mintUuid();
    assert.equal(isUuid(id), true);
    assert.match(id, UUID_V4_RE);
    const seen = new Set();
    for (let i = 0; i < 200; i += 1) {
      const code = mintShortCode();
      assert.equal(code.length, SHORT_CODE_LENGTH);
      assert.equal(isShortCodeShape(code), true);
      for (const ch of code) assert.ok(SHORT_CODE_ALPHABET.includes(ch));
      seen.add(code);
    }
    assert.equal(seen.size, 200);
    assert.equal(isUuid('1'), false);
    assert.equal(isUuid('not-a-uuid'), false);
  });

  test('refs resolve UUID, short code, on-chain id, and legacy aliases', () => {
    const election = {
      id: '3f1c0a6e-9b2d-4e11-8c7a-1a2b3c4d5e01',
      shortCode: 'nbrdge2k3m',
      onChainElectionId: '1',
      aliases: ['1'],
    };
    assert.equal(electionMatchesRef(election, election.id), true);
    assert.equal(electionMatchesRef(election, 'nbrdge2k3m'), true);
    assert.equal(electionMatchesRef(election, '1'), true);
    assert.equal(electionMatchesRef(election, 'missing'), false);
    assert.equal(chainElectionId(election), '1');
    assert.ok(refsOf(election).has(election.id));
    assert.equal(parseOnChainElectionId('42'), '42');
    assert.equal(parseOnChainElectionId(null), null);
  });

  test('SPA router treats /vote/:id, /v/:code, and /e/:code as the same page', () => {
    const uuid = '3f1c0a6e-9b2d-4e11-8c7a-1a2b3c4d5e01';
    const loc = (pathname) => ({ pathname, hash: '', search: '' });
    const vote = parseRoute(loc(`/vote/${uuid}`));
    assert.equal(vote.name, 'vote');
    assert.equal(vote.params.id, uuid);
    const short = parseRoute(loc('/v/nbrdge2k3m'));
    assert.equal(short.name, 'vote');
    assert.equal(short.params.id, 'nbrdge2k3m');
    const alt = parseRoute(loc('/e/nbrdge2k3m'));
    assert.equal(alt.name, 'vote');
    assert.equal(alt.params.id, 'nbrdge2k3m');
  });

  test('create election returns UUID canonical id and a short code', async () => {
    const { status, json } = await api('POST', '/api/elections', {
      jar: adminJar,
      body: {
        title: 'UUID poll',
        startTime: nowSec() - 30,
        cutoffTime: nowSec() + 3600,
        treeDepth: 16,
        questions: [{ type: 'YES_NO', prompt: 'Adopt?' }],
      },
    });
    assert.equal(status, 201, json?.error);
    assert.equal(isUuid(json.election.id), true);
    assert.equal(json.id, json.election.id);
    assert.equal(isShortCodeShape(json.shortCode), true);
    assert.equal(json.election.shortCode, json.shortCode);
    assert.match(String(json.onChainElectionId), /^\d+$/);
    assert.equal(json.election.onChainElectionId, json.onChainElectionId);
    assert.equal(json.election.links.vote, `/vote/${json.election.id}`);
    assert.equal(json.election.links.short, `/v/${json.shortCode}`);

    const byUuid = await api('GET', `/api/elections/${json.election.id}`);
    const byShort = await api('GET', `/api/elections/${json.shortCode}`);
    const byChain = await api('GET', `/api/elections/${json.onChainElectionId}`);
    assert.equal(byUuid.status, 200);
    assert.equal(byShort.status, 200);
    assert.equal(byChain.status, 200);
    assert.equal(byUuid.json.id, json.election.id);
    assert.equal(byShort.json.id, json.election.id);
    assert.equal(byChain.json.id, json.election.id);
  });

  test('short HTTP routes 302 to /vote/<uuid>; vote/register accept both forms', async () => {
    const created = await api('POST', '/api/elections', {
      jar: adminJar,
      body: {
        title: 'Short-link poll',
        startTime: nowSec() - 60,
        cutoffTime: nowSec() + 3600,
        treeDepth: 16,
        questions: [{ type: 'YES_NO', prompt: '?' }],
      },
    });
    assert.equal(created.status, 201, created.json?.error);
    const uuid = created.json.election.id;
    const short = created.json.shortCode;
    assert.equal(isUuid(uuid), true);

    const v = await api('GET', `/v/${short}`, { redirect: 'manual' });
    assert.equal(v.status, 302);
    assert.equal(v.res.headers.get('location'), `/vote/${uuid}`);

    const e = await api('GET', `/e/${short}`, { redirect: 'manual' });
    assert.equal(e.status, 302);
    assert.equal(e.res.headers.get('location'), `/vote/${uuid}`);

    const votePage = await api('GET', `/vote/${uuid}`);
    assert.equal(votePage.status, 200);
    assert.match(votePage.text, /NOT FOR PROFIT/);

    const regShort = await api('POST', `/api/elections/${short}/register`, {
      jar: voterJar,
      body: { identityCommitment: '0xabc1' },
    });
    assert.equal(regShort.status, 201, regShort.json?.error);
    assert.equal(regShort.json.electionId, uuid);

    const freeze = await api('POST', `/api/elections/${uuid}/freeze`, { jar: adminJar });
    assert.equal(freeze.status, 200, freeze.json?.error);

    const voteShort = await api('POST', `/api/elections/${short}/vote`, {
      body: {
        proof: { accept: true },
        publicInputs: { nullifier: '7', electionId: uuid },
        encryptedBallot: '0xab',
      },
    });
    assert.equal(voteShort.status, 201, voteShort.json?.error);
    assert.equal(voteShort.json.vote.electionId, uuid);

    const voteOnChain = await api('POST', `/api/elections/${uuid}/vote`, {
      body: {
        proof: { accept: true },
        publicInputs: {
          nullifier: '8',
          electionId: created.json.onChainElectionId,
        },
        encryptedBallot: '0xcd',
      },
    });
    assert.equal(voteOnChain.status, 201, voteOnChain.json?.error);
  });

  test('legacy non-UUID election ids still resolve after short-code backfill', () => {
    const tree = emptyTree(16);
    store.data.elections.push({
      id: 7,
      title: 'Legacy fixture',
      metadataURI: '',
      startTime: nowSec() - 10,
      cutoffTime: nowSec() + 3600,
      maxParticipants: 0,
      treeDepth: 16,
      ballotSpecHash: '0x' + '11'.repeat(32),
      questions: [],
      questionCount: 0,
      jurisdictionId: 'demo',
      clerk: '',
      registrar: '',
      disqualificationOfficer: '',
      tallyOperator: '',
      verifier: '',
      lateUpdateAllowed: false,
      rollFrozen: false,
      frozenAt: null,
      participantCount: 0,
      acceptedBallots: 0,
      eligibleRoot: tree.root,
      disqualificationRoot: tree.root,
      eligibleTree: tree,
      disqualificationTree: { ...tree, filled: [], leaves: [] },
      tally: null,
      createdAt: new Date().toISOString(),
    });
    store.ensureElectionPublicIds();
    const legacy = store.getElection(7);
    assert.ok(legacy);
    assert.equal(String(legacy.id), '7');
    assert.equal(isShortCodeShape(legacy.shortCode), true);
    assert.equal(legacy.onChainElectionId, '7');
    assert.equal(store.getElection(legacy.shortCode).id, 7);
  });
});

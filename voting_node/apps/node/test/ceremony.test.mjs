// NOT FOR PROFIT — civic public good, not a commercial product.
// Phase-2 trusted-setup ceremony: uploads, ordering, chain verification,
// beacon, finalize/export, and auth gating. Uses the one-constraint toy
// circuit in test/fixtures/ceremony (published entropy, never trusted).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';

import * as snarkjs from 'snarkjs';

import { createApp } from '../src/server.mjs';
import {
  CHAIN_GENESIS,
  contributionBody,
  createCeremonyService,
  verifyHashChain,
} from '../src/ceremony/service.mjs';
import { beaconLookupUrl, parseBeaconValue, parsePrecommit } from '../src/ceremony/beacon.mjs';
import { createEthRpc, parseRpcUrls } from '../src/ceremony/eth.mjs';
import { ceremonyHtmlFile, CEREMONY_PAGE_CSP, CEREMONY_WORKER_CSP } from '../src/ceremony/web.mjs';
import { createSlidingLimiter } from '../src/routes/ceremony.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures', 'ceremony');
const R1CS_SHA256 = '85342b9193ec76169c4331f90dae3cf4b037a26ab1d0f03e76e0513d84d8ea45';
const PTAU_SHA256 = 'cbc0a81821de303eed70e924bc621192118d372dd7b310b36922eef277f01a08';
const BEACON = 'a'.repeat(64);
const HEAD = 21_000_000;

/** Mock Ethereum JSON-RPC: tests move `head` and `finalized` by hand. */
async function mockEth(state) {
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const { id, method, params } = JSON.parse(raw);
      const hex = (n) => `0x${n.toString(16)}`;
      const blockAt = (n) =>
        n > state.head ? null : { number: hex(n), hash: state.hashOf(n), parentHash: state.hashOf(n - 1), timestamp: hex(1_700_000_000 + n * 12) };
      let result;
      if (method === 'eth_chainId') result = hex(state.chainId ?? 1);
      else if (method === 'eth_blockNumber') result = hex(state.head);
      else if (method === 'eth_getBlockByNumber') {
        result = params[0] === 'finalized' ? blockAt(state.finalized) : blockAt(Number.parseInt(params[0].slice(2), 16));
      } else {
        res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'no' } }));
        return;
      }
      state.calls = (state.calls || 0) + 1;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, url: `http://127.0.0.1:${srv.address().port}` };
}

const ethState = {
  head: HEAD,
  finalized: HEAD - 64,
  hashOf: (n) => `0x${createHash('sha256').update(`block ${n}`).digest('hex')}`,
};
let eth;

let tmp;
let app;
let server;
let base;
const cookies = {};

function listen(application) {
  return new Promise((resolve, reject) => {
    const s = application.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
}

async function login(handle, role) {
  const res = await fetch(`${base}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(role ? { handle, role } : { handle }),
  });
  assert.equal(res.status, 200, `dev-login ${handle}`);
  const set = res.headers.getSetCookie();
  return set.map((c) => c.split(';')[0]).join('; ');
}

async function call(method, url, { who, json, body, headers = {} } = {}) {
  const h = { ...headers };
  if (who) h.cookie = cookies[who];
  if (json !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(`${base}${url}`, {
    method,
    headers: h,
    body: json !== undefined ? JSON.stringify(json) : body,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let data = null;
  try {
    data = JSON.parse(buf.toString('utf8'));
  } catch {
    data = null;
  }
  return { status: res.status, data, buf, res };
}

function octet(who, url, bytes, extra = {}) {
  return call('POST', url, {
    who,
    body: bytes,
    headers: { 'content-type': 'application/octet-stream', ...extra },
  });
}

async function waitJob(jobId, who = 'admin') {
  for (let i = 0; i < 300; i++) {
    const r = await call('GET', `/api/ceremonies/jobs/${jobId}`, { who });
    assert.equal(r.status, 200);
    if (r.data.job.status !== 'running') return r.data.job;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error('job timed out');
}

async function contributeLocally(id, parentIndex, name, entropy) {
  const tip = await call('GET', `/api/ceremonies/${id}/files/zkey_${String(parentIndex).padStart(4, '0')}.zkey`);
  assert.equal(tip.status, 200);
  const dir = await mkdtemp(path.join(tmp, 'contrib-'));
  const inFile = path.join(dir, 'in.zkey');
  const outFile = path.join(dir, 'out.zkey');
  await writeFile(inFile, tip.buf);
  await snarkjs.zKey.contribute(inFile, outFile, name, entropy);
  return readFile(outFile);
}

before(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'zkv-ceremony-'));
  eth = await mockEth(ethState);
  const created = await createApp({
    ceremonyEthRpcUrls: [eth.url],
    dataDir: path.join(tmp, 'data'),
    superAdminEmail: '',
    ceremonyMaxInputBytes: 200 * 1024,
    ceremonyRateLimits: { join: 1000, upload: 1000 },
  });
  app = created;
  server = await listen(created.app);
  base = `http://127.0.0.1:${server.address().port}`;
  cookies.admin = await login('admin');
  cookies.alice = await login('alice');
  cookies.bob = await login('bob');
  cookies.carol = await login('carol');
  cookies.dave = await login('dave');
  cookies.erin = await login('erin');
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => eth.srv.close(resolve));
  await rm(tmp, { recursive: true, force: true });
  // ffjavascript keeps worker threads alive; end them so node --test exits.
  await globalThis.curve_bn128?.terminate?.();
});

describe('ceremony auth gating', () => {
  test('coordinator API needs the platform super admin', async () => {
    assert.equal((await call('GET', '/api/ceremony-admin/options')).status, 401);
    assert.equal((await call('GET', '/api/ceremony-admin/options', { who: 'alice' })).status, 403);
    assert.equal((await call('POST', '/api/ceremony-admin/ceremonies', { who: 'alice', json: {} })).status, 403);
    const ok = await call('GET', '/api/ceremony-admin/options', { who: 'admin' });
    assert.equal(ok.status, 200);
    assert.ok(ok.data.ptauPresets.some((p) => p.power === 16));
    assert.deepEqual(ok.data.beacon, {
      source: 'ethereum-block',
      network: 'ethereum-mainnet',
      minBlocksAhead: 32,
      rpcConfigured: true,
    });
    assert.equal(ok.data.drandChains, undefined, 'drand is not offered');
    assert.equal(ok.data.blockNetworks, undefined, 'no Bitcoin or other networks');
    const chain = await call('GET', '/api/ceremony-admin/beacon/chain', { who: 'admin' });
    assert.equal(chain.status, 200);
    assert.equal(chain.data.headBlock, HEAD);
    assert.equal(chain.data.earliestCommit, HEAD + 32);
    assert.equal((await call('GET', '/api/ceremony-admin/beacon/chain', { who: 'alice' })).status, 403);
  });

  test('joining and uploading need a session', async () => {
    assert.equal((await call('POST', '/api/ceremonies/cer_x/queue')).status, 401);
    assert.equal((await octet(undefined, '/api/ceremonies/cer_x/contributions?parent=0&name=x', Buffer.from('x'))).status, 401);
    assert.equal((await call('POST', '/api/ceremonies/cer_x/invites/accept', { json: { token: 'x' } })).status, 401);
    assert.equal((await call('POST', '/api/ceremony-admin/ceremonies/cer_x/invites', { who: 'alice', json: { handle: 'bob' } })).status, 403);
    assert.equal((await call('DELETE', '/api/ceremony-admin/ceremonies/cer_x/invites/inv_000000000000', { who: 'alice' })).status, 403);
  });

  test('ceremony pages map before /admin and carry a scoped CSP', async () => {
    assert.equal(ceremonyHtmlFile('/admin/ceremony'), 'admin-ceremony.html');
    assert.equal(ceremonyHtmlFile('/ceremony'), 'ceremony.html');
    assert.equal(ceremonyHtmlFile('/ceremony/cer_1'), 'ceremony.html');
    assert.equal(ceremonyHtmlFile('/ceremony/cer_1/transcript'), 'ceremony-transcript.html');
    assert.equal(ceremonyHtmlFile('/admin'), null);
    const page = await call('GET', '/ceremony');
    assert.equal(page.status, 200);
    assert.equal(page.res.headers.get('content-security-policy'), CEREMONY_PAGE_CSP);
    assert.doesNotMatch(CEREMONY_PAGE_CSP, /unsafe-inline|unsafe-eval|wasm-unsafe-eval/);
    const vendor = await call('GET', '/vendor/snarkjs.min.js');
    assert.equal(vendor.status, 200);
    assert.equal(vendor.res.headers.get('content-security-policy'), CEREMONY_WORKER_CSP);
    assert.match(CEREMONY_WORKER_CSP, /'wasm-unsafe-eval'/);
    assert.doesNotMatch(CEREMONY_WORKER_CSP, /'unsafe-eval'|'unsafe-inline'/);
    const home = await call('GET', '/');
    assert.equal(home.res.headers.get('content-security-policy'), null, 'no global CSP added');
  });
});

describe('ceremony inputs', () => {
  test('upload validation', async () => {
    const r1cs = await readFile(path.join(FIX, 'toy.r1cs'));
    const ptau = await readFile(path.join(FIX, 'toy_phase2.ptau'));
    let r = await call('POST', '/api/ceremony-admin/inputs?name=toy.r1cs', {
      who: 'admin',
      body: r1cs,
      headers: { 'content-type': 'text/plain' },
    });
    assert.equal(r.status, 415);
    r = await octet('admin', '/api/ceremony-admin/inputs?name=../evil.r1cs', r1cs);
    assert.equal(r.status, 400);
    r = await octet('admin', '/api/ceremony-admin/inputs?name=evil.txt', r1cs);
    assert.equal(r.status, 400);
    r = await octet('admin', '/api/ceremony-admin/inputs?name=big.ptau', Buffer.alloc(300 * 1024));
    assert.equal(r.status, 413);
    assert.ok(!fs.existsSync(path.join(app.ceremonies.inputDir, 'big.ptau')));
    r = await octet('admin', '/api/ceremony-admin/inputs?name=toy.r1cs', r1cs);
    assert.equal(r.status, 201);
    assert.equal(r.data.input.sha256, R1CS_SHA256);
    r = await octet('admin', '/api/ceremony-admin/inputs?name=toy.r1cs', r1cs);
    assert.equal(r.status, 409);
    r = await octet('admin', '/api/ceremony-admin/inputs?name=toy_phase2.ptau', ptau);
    assert.equal(r.status, 201);
    const opts = await call('GET', '/api/ceremony-admin/options', { who: 'admin' });
    assert.deepEqual(opts.data.inputs.map((i) => i.name), ['toy.r1cs', 'toy_phase2.ptau']);
  });
});

describe('ceremony lifecycle on the toy circuit', () => {
  let id;
  let receipt1;
  let daveInvite;
  let erinInviteId;

  test('create pins the ptau hash', async () => {
    let r = await call('POST', '/api/ceremony-admin/ceremonies', {
      who: 'admin',
      json: { circuitName: 'toy', r1cs: 'toy.r1cs', ptau: 'toy_phase2.ptau', ptauHash: 'b'.repeat(64) },
    });
    assert.equal(r.status, 400);
    assert.equal(r.data.code, 'CEREMONY_PTAU_HASH');
    r = await call('POST', '/api/ceremony-admin/ceremonies', {
      who: 'admin',
      json: { circuitName: 'toy', r1cs: 'toy.r1cs', ptau: 'toy_phase2.ptau' },
    });
    assert.equal(r.status, 400, 'a pinned hash is required');
    r = await call('POST', '/api/ceremony-admin/ceremonies', {
      who: 'admin',
      json: {
        circuitName: 'toy',
        label: 'Toy square',
        r1cs: 'toy.r1cs',
        r1csSha256: R1CS_SHA256,
        ptau: 'toy_phase2.ptau',
        ptauHash: PTAU_SHA256,
        minContributions: 2,
        participation: { handles: 'nobody-has-this' },
      },
    });
    assert.equal(r.status, 404, 'unknown handle');
    assert.equal(r.data.code, 'CEREMONY_INVITE_NO_USER');
    r = await call('POST', '/api/ceremony-admin/ceremonies', {
      who: 'admin',
      json: {
        circuitName: 'toy',
        r1cs: 'toy.r1cs',
        ptau: 'toy_phase2.ptau',
        ptauHash: PTAU_SHA256,
        participation: { mode: 'open' },
      },
    });
    assert.equal(r.status, 400, 'open participation is gone');
    assert.equal(r.data.code, 'CEREMONY_INVITE_ONLY_MODE');
    r = await call('POST', '/api/ceremony-admin/ceremonies', {
      who: 'admin',
      json: {
        circuitName: 'toy',
        label: 'Toy square',
        r1cs: 'toy.r1cs',
        r1csSha256: R1CS_SHA256,
        ptau: 'toy_phase2.ptau',
        ptauHash: PTAU_SHA256,
        minContributions: 2,
        participation: { handles: 'alice' },
      },
    });
    assert.equal(r.status, 202);
    id = r.data.ceremony.id;
    const job = await waitJob(r.data.job.id);
    assert.equal(job.status, 'done', job.error);
    const detail = await call('GET', `/api/ceremony-admin/ceremonies/${id}`, { who: 'admin' });
    assert.equal(detail.data.ceremony.status, 'draft');
    assert.match(detail.data.ceremony.initial.circuitHash, /^[0-9a-f]{128}$/);
    assert.equal(detail.data.ceremony.circuit.sha256, R1CS_SHA256);
    assert.equal(detail.data.ceremony.participation.mode, 'invite');
    assert.deepEqual(
      detail.data.ceremony.invites.map((i) => [i.kind, i.handle, i.status]),
      [['account', 'alice', 'active']],
    );
  });

  test('coordinator manages the invite list', async () => {
    let r = await call('POST', `/api/ceremony-admin/ceremonies/${id}/invites`, { who: 'admin', json: { handle: 'bob' } });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.invites[0].handle, 'bob');
    assert.equal(r.data.token, undefined, 'account invites have no token');
    r = await call('POST', `/api/ceremony-admin/ceremonies/${id}/invites`, { who: 'admin', json: { handle: 'bob' } });
    assert.equal(r.status, 409, 'already invited');
    r = await call('POST', `/api/ceremony-admin/ceremonies/${id}/invites`, { who: 'admin', json: { handle: 'ghost' } });
    assert.equal(r.status, 404);
    r = await call('POST', `/api/ceremony-admin/ceremonies/${id}/invites`, { who: 'admin', json: { email: 'not-an-email' } });
    assert.equal(r.status, 400);
    r = await call('POST', `/api/ceremony-admin/ceremonies/${id}/invites`, { who: 'admin', json: { email: 'Dave.Invitee@Example.org' } });
    assert.equal(r.status, 201);
    assert.match(r.data.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(r.data.invitePath, `/ceremony/${id}#invite=${r.data.token}`, 'token travels in the fragment');
    assert.equal(r.data.invites[0].email, 'dave.invitee@example.org');
    assert.equal(r.data.invites[0].status, 'pending');
    daveInvite = { token: r.data.token, id: r.data.invites[0].id };
    r = await call('POST', `/api/ceremony-admin/ceremonies/${id}/invites`, { who: 'admin', json: { email: 'dave.invitee@example.org' } });
    assert.equal(r.status, 409, 'one unused link per address');
    r = await call('POST', `/api/ceremony-admin/ceremonies/${id}/invites`, { who: 'admin', json: { email: 'erin@example.org' } });
    erinInviteId = r.data.invites[0].id;
    const erinToken = r.data.token;
    r = await call('DELETE', `/api/ceremony-admin/ceremonies/${id}/invites/${erinInviteId}`, { who: 'admin' });
    assert.equal(r.status, 200);
    assert.equal(r.data.ceremony.invites.find((i) => i.id === erinInviteId).status, 'revoked');
    r = await call('POST', `/api/ceremonies/${id}/invites/accept`, { who: 'erin', json: { token: erinToken } });
    assert.equal(r.status, 403, 'a revoked email invite cannot be redeemed');
    assert.equal(r.data.code, 'CEREMONY_INVITE_INVALID');
    r = await call('DELETE', `/api/ceremony-admin/ceremonies/${id}/invites/${erinInviteId}`, { who: 'admin' });
    assert.equal(r.status, 409);
    r = await call('DELETE', `/api/ceremony-admin/ceremonies/${id}/invites/bogus`, { who: 'admin' });
    assert.equal(r.status, 400);
    const admin = (await call('GET', `/api/ceremony-admin/ceremonies/${id}`, { who: 'admin' })).data.ceremony;
    assert.ok(!JSON.stringify(admin).includes(daveInvite.token), 'token is never stored or shown again');
    assert.ok(!JSON.stringify(admin).includes('tokenSha256'));
    const audit = admin.audit.filter((a) => a.action.startsWith('invite_'));
    assert.deepEqual(
      audit.map((a) => a.action),
      ['invite_added', 'invite_added', 'invite_added', 'invite_added', 'invite_removed'],
    );
    assert.ok(!JSON.stringify(admin.audit).includes('example.org'), 'audit log carries no email addresses');
    assert.equal(admin.auditChain.ok, true);
  });

  test('queue: window, list, ordering', async () => {
    let r = await call('POST', `/api/ceremonies/${id}/queue`, { who: 'alice' });
    assert.equal(r.status, 409, 'closed window');
    r = await call('POST', `/api/ceremony-admin/ceremonies/${id}/open`, { who: 'admin' });
    assert.equal(r.status, 200);
    r = await call('POST', `/api/ceremonies/${id}/queue`, { who: 'carol' });
    assert.equal(r.status, 403, 'carol is not invited');
    assert.equal(r.data.code, 'CEREMONY_INVITE_ONLY');
    assert.match(r.data.error, /invite only/);
    const carolView = (await call('GET', `/api/ceremonies/${id}`, { who: 'carol' })).data.ceremony;
    assert.equal(carolView.me.invited, false);
    assert.equal(carolView.participationMode, 'invite');
    r = await call('POST', `/api/ceremonies/${id}/queue`, { who: 'alice' });
    assert.equal(r.status, 200);
    assert.equal(r.data.ceremony.me.position, 1);
    assert.equal(r.data.ceremony.me.yourTurn, true);
    r = await call('POST', `/api/ceremonies/${id}/queue`, { who: 'alice' });
    assert.equal(r.status, 409);
    r = await call('POST', `/api/ceremonies/${id}/queue`, { who: 'bob' });
    assert.equal(r.data.ceremony.me.position, 2);
    assert.equal(r.data.ceremony.me.invited, true);
    // dave redeems his single-use email link and queues.
    r = await call('POST', `/api/ceremonies/${id}/queue`, { who: 'dave' });
    assert.equal(r.status, 403, 'dave has not accepted yet');
    r = await call('POST', `/api/ceremonies/${id}/invites/accept`, { who: 'dave', json: { token: 'z'.repeat(43) } });
    assert.equal(r.status, 403);
    r = await call('POST', `/api/ceremonies/${id}/invites/accept`, { who: 'dave', json: { token: daveInvite.token } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.ceremony.me.invited, true);
    r = await call('POST', `/api/ceremonies/${id}/invites/accept`, { who: 'carol', json: { token: daveInvite.token } });
    assert.equal(r.status, 403, 'single use: carol cannot reuse it');
    r = await call('POST', `/api/ceremonies/${id}/queue`, { who: 'dave' });
    assert.equal(r.status, 200);
    assert.equal(r.data.ceremony.me.position, 3);
    const pub = await call('GET', `/api/ceremonies/${id}`);
    const text = pub.buf.toString('utf8');
    assert.doesNotMatch(text, /alice|bob|dave|example\.org/, 'public view hides handles and emails');
    assert.doesNotMatch(text, /userId/);
    assert.equal(pub.data.ceremony.invitedCount, 3);
  });

  test('a revoked invite is blocked from the queue and upload', async () => {
    let r = await call('DELETE', `/api/ceremony-admin/ceremonies/${id}/invites/${daveInvite.id}`, { who: 'admin' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.ceremony.queue.map((q) => q.handle), ['alice', 'bob'], 'dave left the queue');
    const removed = r.data.ceremony.audit.at(-1);
    assert.equal(removed.action, 'invite_removed');
    assert.equal(removed.details.droppedFromQueue, true);
    r = await call('POST', `/api/ceremonies/${id}/queue`, { who: 'dave' });
    assert.equal(r.status, 403);
    assert.equal(r.data.code, 'CEREMONY_INVITE_ONLY');
    r = await octet('dave', `/api/ceremonies/${id}/contributions?parent=0&name=dave`, Buffer.alloc(10));
    assert.equal(r.status, 403);
    assert.equal(r.data.code, 'CEREMONY_INVITE_ONLY');
  });

  test('a non-invited account cannot upload', async () => {
    const good = await contributeLocally(id, 0, 'carol', 'carol entropy');
    const r = await octet('carol', `/api/ceremonies/${id}/contributions?parent=0&name=carol`, good);
    assert.equal(r.status, 403);
    assert.equal(r.data.code, 'CEREMONY_INVITE_ONLY');
  });

  test('upload validation and ordering', async () => {
    const good = await contributeLocally(id, 0, 'alice', 'alice entropy');
    let r = await octet('bob', `/api/ceremonies/${id}/contributions?parent=0&name=bob`, good);
    assert.equal(r.status, 409);
    assert.equal(r.data.code, 'CEREMONY_NOT_YOUR_TURN');
    r = await octet('alice', `/api/ceremonies/${id}/contributions?parent=1&name=alice`, good);
    assert.equal(r.data.code, 'CEREMONY_STALE_PARENT');
    r = await octet('alice', `/api/ceremonies/${id}/contributions?parent=0&name=bad%20%20name`, good);
    assert.equal(r.status, 400);
    r = await octet('alice', `/api/ceremonies/${id}/contributions?parent=0&name=alice`, Buffer.alloc(good.length + 70 * 1024));
    assert.equal(r.status, 413, 'size cap is tip + 64 KiB');
    r = await octet('alice', `/api/ceremonies/${id}/contributions?parent=0&name=alice`, Buffer.alloc(10));
    assert.equal(r.data.code, 'CEREMONY_NOT_A_CONTRIBUTION');
    // Right size, wrong bytes: verify must reject it.
    const junk = Buffer.from(good);
    junk.fill(7, 200, 600);
    r = await octet('alice', `/api/ceremonies/${id}/contributions?parent=0&name=alice`, junk);
    assert.equal(r.status, 202);
    let job = await waitJob(r.data.job.id, 'alice');
    assert.equal(job.status, 'failed');
    // Name in the zkey must match the claimed name.
    r = await octet('alice', `/api/ceremonies/${id}/contributions?parent=0&name=mallory`, good);
    job = await waitJob(r.data.job.id, 'alice');
    assert.equal(job.status, 'failed');
    assert.match(job.error, /names its contributor/);
    const attestation = Buffer.from('I destroyed my entropy. — alice', 'utf8').toString('base64url');
    r = await octet('alice', `/api/ceremonies/${id}/contributions?parent=0&name=alice`, good, {
      'x-ceremony-attestation': attestation,
    });
    assert.equal(r.status, 202);
    job = await waitJob(r.data.job.id, 'alice');
    assert.equal(job.status, 'done', job.error);
    receipt1 = job.result.receipt;
    assert.equal(receipt1.index, 1);
    assert.equal(receipt1.zkeySha256, createHash('sha256').update(good).digest('hex'));
    assert.match(receipt1.contributionHash, /^[0-9a-f]{128}$/);
    r = await call('POST', `/api/ceremonies/${id}/queue`, { who: 'alice' });
    assert.equal(r.data.code, 'CEREMONY_ALREADY_CONTRIBUTED');
  });

  test('a file with two new contributions is refused', async () => {
    const one = await contributeLocally(id, 1, 'bob', 'bob 1');
    const dir = await mkdtemp(path.join(tmp, 'double-'));
    await writeFile(path.join(dir, 'a.zkey'), one);
    await snarkjs.zKey.contribute(path.join(dir, 'a.zkey'), path.join(dir, 'b.zkey'), 'bob', 'bob 2');
    const two = await readFile(path.join(dir, 'b.zkey'));
    let r = await octet('bob', `/api/ceremonies/${id}/contributions?parent=1&name=bob`, two);
    const job = await waitJob(r.data.job.id, 'bob');
    assert.equal(job.status, 'failed');
    assert.match(job.error, /exactly one new contribution/);
    // A contribution built on #0 instead of the tip forks the chain.
    const fork = await contributeLocally(id, 0, 'bob', 'bob fork');
    r = await octet('bob', `/api/ceremonies/${id}/contributions?parent=1&name=bob`, fork);
    if (r.status === 202) {
      const forkJob = await waitJob(r.data.job.id, 'bob');
      assert.equal(forkJob.status, 'failed');
    } else {
      // Same size as the tip, so it is refused before verification.
      assert.equal(r.data.code, 'CEREMONY_NOT_A_CONTRIBUTION', JSON.stringify(r.data));
    }
    r = await octet('bob', `/api/ceremonies/${id}/contributions?parent=1&name=bob`, one);
    const ok = await waitJob(r.data.job.id, 'bob');
    assert.equal(ok.status, 'done', ok.error);
    assert.equal(ok.result.receipt.index, 2);
  });

  test('transcript is append-only and hash-chained', async () => {
    const r = await call('GET', `/api/ceremonies/${id}/transcript.json`);
    assert.equal(r.status, 200);
    const tr = r.data;
    assert.equal(tr.contributions.length, 2);
    assert.equal(tr.chainOk, true);
    assert.equal(tr.contributions[0].prevHash, CHAIN_GENESIS);
    assert.equal(tr.contributions[0].attestation, 'I destroyed my entropy. — alice');
    assert.equal(tr.contributions[1].prevZkeySha256, tr.contributions[0].zkeySha256);
    assert.equal(tr.contributions[0].contributionHash, receipt1.contributionHash);
    assert.equal(tr.participation.mode, 'invite-only');
    assert.ok(tr.participation.invitees.every((i) => /^inv_[0-9a-f]{12}$/.test(i.id) && Object.keys(i).length === 2));
    assert.doesNotMatch(r.buf.toString('utf8'), /example\.org|"dave"|userId|tokenSha256|"handle"|"email"/, 'transcript has pseudonymous ids only');
    const v = verifyHashChain(tr.contributions, contributionBody);
    assert.ok(v.ok);
    const tampered = structuredClone(tr.contributions);
    tampered[0].name = 'eve';
    assert.equal(verifyHashChain(tampered, contributionBody).ok, false);
    const admin = await call('GET', `/api/ceremony-admin/ceremonies/${id}`, { who: 'admin' });
    assert.equal(admin.data.ceremony.auditChain.ok, true);
    const actions = admin.data.ceremony.audit.map((a) => a.action);
    assert.ok(actions.includes('contribution_rejected'));
    assert.equal(actions.filter((a) => a === 'contribution_accepted').length, 2);
    assert.ok(!JSON.stringify(admin.data.ceremony.audit).includes('127.0.0.1'), 'audit stores no IPs');
  });

  test('files endpoint only serves whitelisted names', async () => {
    assert.equal((await call('GET', `/api/ceremonies/${id}/files/zkey_0002.zkey`)).status, 200);
    assert.equal((await call('GET', `/api/ceremonies/${id}/files/..%2F..%2Fzk-voting.json`)).status, 404);
    assert.equal((await call('GET', `/api/ceremonies/${id}/files/zkey_0009.zkey`)).status, 404);
    assert.equal((await call('GET', `/api/ceremonies/${id}/export/export.json`)).status, 404);
  });

  test('close needs a committed Ethereum block; finalize waits for finality', async () => {
    let r = await call('POST', `/api/ceremony-admin/ceremonies/${id}/close`, { who: 'admin' });
    assert.equal(r.data.code, 'CEREMONY_NO_BEACON');
    for (const body of [
      { source: 'drand', chain: 'quicknet', round: 1 },
      { source: 'block-hash', network: 'bitcoin-mainnet', height: 99999999 },
    ]) {
      r = await call('POST', `/api/ceremony-admin/ceremonies/${id}/beacon/precommit`, { who: 'admin', json: body });
      assert.equal(r.status, 400, `refuses ${body.source}`);
    }
    r = await call('POST', `/api/ceremony-admin/ceremonies/${id}/beacon/precommit`, {
      who: 'admin',
      json: { blockNumber: HEAD + 31 },
    });
    assert.equal(r.status, 400, 'must be at least 32 blocks ahead');
    assert.match(r.data.error, /at least 32 blocks ahead/);
    r = await call('POST', `/api/ceremony-admin/ceremonies/${id}/beacon/precommit`, { who: 'admin', json: {} });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.ceremony.beacon.precommit.blockNumber, HEAD + 32, 'defaults to head + 32');
    // The committed block appears before close: close must refuse.
    ethState.head = HEAD + 40;
    r = await call('POST', `/api/ceremony-admin/ceremonies/${id}/close`, { who: 'admin' });
    assert.equal(r.status, 409);
    assert.equal(r.data.code, 'CEREMONY_BEACON_PAST');
    const target = ethState.head + 50;
    r = await call('POST', `/api/ceremony-admin/ceremonies/${id}/beacon/precommit`, {
      who: 'admin',
      json: { source: 'ethereum-block', network: 'ethereum-mainnet', blockNumber: target },
    });
    assert.equal(r.status, 200);
    const pre = r.data.ceremony.beacon.precommit;
    assert.equal(pre.source, 'ethereum-block');
    assert.equal(pre.chainId, 1);
    assert.equal(pre.headAtCommit, HEAD + 40);
    assert.equal(pre.lookupUrl, `https://etherscan.io/block/${target}`);
    r = await call('POST', `/api/ceremony-admin/ceremonies/${id}/finalize`, { who: 'admin', json: {} });
    assert.equal(r.status, 409, 'must close first');
    r = await call('POST', `/api/ceremony-admin/ceremonies/${id}/close`, { who: 'admin' });
    assert.equal(r.status, 200);
    assert.equal(r.data.ceremony.status, 'closed');
    r = await call('POST', `/api/ceremonies/${id}/queue`, { who: 'bob' });
    assert.equal(r.status, 409);
    // Not mined yet.
    r = await call('POST', `/api/ceremony-admin/ceremonies/${id}/finalize`, { who: 'admin', json: {} });
    assert.equal(r.status, 409);
    assert.equal(r.data.code, 'CEREMONY_BEACON_FUTURE');
    // Mined but not finalized.
    ethState.head = target + 5;
    ethState.finalized = target - 1;
    r = await call('POST', `/api/ceremony-admin/ceremonies/${id}/finalize`, { who: 'admin', json: {} });
    assert.equal(r.status, 409);
    assert.equal(r.data.code, 'CEREMONY_BEACON_NOT_FINALIZED');
    ethState.head = target + 70;
    ethState.finalized = target + 2;
    r = await call('POST', `/api/ceremony-admin/ceremonies/${id}/finalize`, { who: 'admin', json: { beaconValue: BEACON } });
    assert.equal(r.status, 400, 'a pasted value that is not the block hash is refused');
    r = await call('POST', `/api/ceremony-admin/ceremonies/${id}/finalize`, { who: 'admin', json: { iterations: 99 } });
    assert.equal(r.status, 400);
    assert.equal(
      (await call('GET', `/api/ceremony-admin/ceremonies/${id}`, { who: 'admin' })).data.ceremony.status,
      'closed',
      'refusals leave the ceremony closed',
    );
    r = await call('POST', `/api/ceremony-admin/ceremonies/${id}/finalize`, {
      who: 'admin',
      json: { iterations: 10 },
    });
    assert.equal(r.status, 202);
    const job = await waitJob(r.data.job.id);
    assert.equal(job.status, 'done', job.error);
    const c = (await call('GET', `/api/ceremonies/${id}`)).data.ceremony;
    assert.equal(c.status, 'finalized');
    const blockHash = ethState.hashOf(c.beacon.precommit.blockNumber);
    assert.equal(c.beacon.applied.blockHash, blockHash);
    assert.equal(c.beacon.applied.value, blockHash.slice(2), 'the applied value is the block hash read from the RPC');
    assert.equal(c.beacon.applied.blockNumber, c.beacon.precommit.blockNumber);
    assert.equal(c.beacon.applied.source, 'ethereum-block');
    const tr = (await call('GET', `/api/ceremonies/${id}/transcript.json`)).data;
    assert.equal(tr.beacon.applied.blockHash, blockHash);
    assert.match(tr.beaconCheck, /eth_getBlockByNumber/);
    const files = Object.keys(c.exported.files).sort();
    assert.deepEqual(files, ['export.json', 'toy_Groth16Verifier.sol', 'toy_final.zkey', 'toy_verification_key.json']);
    const manifest = (await call('GET', `/api/ceremonies/${id}/export/export.json`)).data;
    assert.equal(manifest.trusted, false);
    assert.equal(manifest.review, 'pending-human-review');
    const sol = (await call('GET', `/api/ceremonies/${id}/export/toy_Groth16Verifier.sol`)).buf.toString('utf8');
    assert.match(sol, /REVIEW BEFORE USE/);
    assert.match(sol, /contract Groth16Verifier/);
    const vkey = (await call('GET', `/api/ceremonies/${id}/export/toy_verification_key.json`)).data;
    assert.equal(vkey.protocol, 'groth16');
    // Independent check of the whole chain with snarkjs.
    const finalZkey = (await call('GET', `/api/ceremonies/${id}/export/toy_final.zkey`)).buf;
    const dir = await mkdtemp(path.join(tmp, 'final-'));
    await writeFile(path.join(dir, 'final.zkey'), finalZkey);
    const ok = await snarkjs.zKey.verifyFromR1cs(
      path.join(FIX, 'toy.r1cs'),
      path.join(FIX, 'toy_phase2.ptau'),
      path.join(dir, 'final.zkey'),
    );
    assert.equal(ok, true);
    // Exports stay in the data dir. Nothing touches smart-contracts/.
    assert.ok(app.ceremonies.rootDir.startsWith(path.join(tmp, 'data')));
    r = await call('POST', `/api/ceremony-admin/ceremonies/${id}/open`, { who: 'admin' });
    assert.equal(r.status, 409, 'a finalized ceremony cannot reopen');
  });
});

function fakeStore() {
  return { data: { ceremonies: [] }, writerActive: true, refuseIfStandby() {}, async persist() {} };
}

function fakeCeremony(id, extra = {}) {
  return {
    id,
    circuitName: 'fake',
    status: 'open',
    minContributions: 2,
    participation: { mode: 'invite', turnMinutes: 30 },
    contributions: [{}, {}],
    queue: [],
    contributors: [],
    invites: [],
    beacon: { precommit: null, history: [], applied: null },
    audit: [],
    ...extra,
  };
}

describe('beacon rules (Ethereum mainnet block hash)', () => {
  test('precommit and value parsing', () => {
    assert.throws(() => parsePrecommit({ source: 'drand', round: 5 }, { headBlock: 100 }), /only beacon source/);
    assert.throws(() => parsePrecommit({ blockNumber: 131 }, { headBlock: 100 }), /at least 32 blocks ahead/);
    assert.throws(() => parsePrecommit({ blockNumber: 'x' }, { headBlock: 100 }));
    const pre = parsePrecommit({ blockNumber: 132 }, { headBlock: 100 });
    assert.equal(pre.blockNumber, 132);
    assert.equal(pre.network, 'ethereum-mainnet');
    assert.equal(parsePrecommit({}, { headBlock: 100, minBlocksAhead: 64 }).blockNumber, 164);
    assert.equal(beaconLookupUrl(pre), 'https://etherscan.io/block/132');
    assert.equal(parseBeaconValue(`0x${'AB'.repeat(32)}`), 'ab'.repeat(32));
    assert.throws(() => parseBeaconValue('ab'));
    assert.throws(() => parseRpcUrls('http://rpc.example.org'), /https/);
    assert.deepEqual(parseRpcUrls(' https://a.example.org/x , http://127.0.0.1:8545 ').length, 2);
  });

  test('fails closed with no RPC configured', async () => {
    const store = fakeStore();
    const svc = createCeremonyService({ config: { dataDir: path.join(tmp, 'svc-norpc') }, store });
    store.data.ceremonies.push(fakeCeremony('cer_norpc'));
    await assert.rejects(svc.precommitBeacon('cer_norpc', {}, null), (err) => err.status === 503 && err.extra?.code === 'CEREMONY_ETH_RPC_UNSET');
    svc.find('cer_norpc').beacon.precommit = { source: 'ethereum-block', network: 'ethereum-mainnet', chainId: 1, blockNumber: 50 };
    await assert.rejects(svc.close('cer_norpc', null), (err) => err.extra?.code === 'CEREMONY_ETH_RPC_UNSET');
    svc.find('cer_norpc').status = 'closed';
    await assert.rejects(svc.finalize('cer_norpc', {}, null), (err) => err.extra?.code === 'CEREMONY_ETH_RPC_UNSET');
    assert.equal(svc.find('cer_norpc').status, 'closed');
  });

  test('refuses a non-mainnet RPC and disagreeing endpoints', async () => {
    const sepolia = await mockEth({ ...ethState, head: 100, finalized: 90, chainId: 11155111 });
    const other = await mockEth({ head: ethState.head, finalized: ethState.finalized, hashOf: (n) => `0x${'f'.repeat(63)}${n % 10}` });
    try {
      await assert.rejects(createEthRpc({ urls: [sepolia.url] }).headBlock(), /not mainnet/);
      const both = createEthRpc({ urls: [eth.url, other.url] });
      await assert.rejects(both.block(ethState.finalized), /disagree/);
      const head = await both.headBlock();
      assert.equal(head, ethState.head);
    } finally {
      await new Promise((r) => sepolia.srv.close(r));
      await new Promise((r) => other.srv.close(r));
    }
  });

  test('finalize refuses until the block is reached and finalized (mock RPC)', async () => {
    const chain = { head: 1000, finalized: 930 };
    const rpc = {
      configured: true,
      endpointCount: 1,
      headBlock: async () => chain.head,
      finalizedBlock: async () => chain.finalized,
      block: async (n) => ({ number: n, hash: `0x${'c'.repeat(64)}`, parentHash: null, timestamp: 1 }),
    };
    const store = fakeStore();
    const svc = createCeremonyService({ config: { dataDir: path.join(tmp, 'svc') }, store, ethRpc: rpc });
    store.data.ceremonies.push(fakeCeremony('cer_fake'));
    await svc.precommitBeacon('cer_fake', { blockNumber: 1040 }, null);
    chain.head = 1040;
    await assert.rejects(svc.close('cer_fake', null), /already exists/);
    chain.head = 1039;
    await svc.close('cer_fake', null);
    await assert.rejects(svc.finalize('cer_fake', {}, null), (err) => err.extra?.code === 'CEREMONY_BEACON_FUTURE');
    chain.head = 1100;
    chain.finalized = 1039;
    await assert.rejects(svc.finalize('cer_fake', {}, null), (err) => err.extra?.code === 'CEREMONY_BEACON_NOT_FINALIZED');
    assert.equal(svc.find('cer_fake').status, 'closed');
    const c = svc.find('cer_fake');
    assert.equal(verifyHashChain(c.audit, (e) => ({ seq: e.seq, at: e.at, action: e.action, actor: e.actor, details: e.details })).ok, true);
  });
});

describe('invite rules (service)', () => {
  test('email links expire and bind to one account', async () => {
    let clock = 1_800_000_000_000;
    const store = fakeStore();
    const svc = createCeremonyService({ config: { dataDir: path.join(tmp, 'svc-inv') }, store, now: () => clock });
    store.data.ceremonies.push(fakeCeremony('cer_inv'));
    const a = await svc.addInvites('cer_inv', { email: 'x@example.org', expiresInDays: 1 }, null);
    clock += 25 * 60 * 60 * 1000;
    await assert.rejects(svc.acceptInvite('cer_inv', a.token, { id: 'u1', handle: 'one' }), (err) => err.extra?.code === 'CEREMONY_INVITE_EXPIRED');
    const b = await svc.addInvites('cer_inv', { email: 'x@example.org' }, null);
    await svc.acceptInvite('cer_inv', b.token, { id: 'u1', handle: 'one' });
    assert.equal(svc.isInvited(svc.find('cer_inv'), { id: 'u1' }), true);
    assert.equal(svc.isInvited(svc.find('cer_inv'), { id: 'u2' }), false);
    await assert.rejects(svc.acceptInvite('cer_inv', b.token, { id: 'u2', handle: 'two' }), (err) => err.extra?.code === 'CEREMONY_INVITE_INVALID');
    await assert.rejects(svc.join('cer_inv', { id: 'u2', handle: 'two' }), (err) => err.extra?.code === 'CEREMONY_INVITE_ONLY');
    const legacy = fakeCeremony('cer_legacy', { participation: { mode: 'open', handles: [], turnMinutes: 30 } });
    delete legacy.invites;
    store.data.ceremonies.push(legacy);
    await assert.rejects(svc.join('cer_legacy', { id: 'u1', handle: 'one' }), (err) => err.extra?.code === 'CEREMONY_INVITE_ONLY', 'old open records are invite-only too');
  });

  test('turns expire and the queue advances', async () => {
    let clock = 1_800_000_000_000;
    const store = { data: { ceremonies: [] }, writerActive: true, refuseIfStandby() {}, async persist() {} };
    const svc = createCeremonyService({ config: { dataDir: path.join(tmp, 'svc2') }, store, now: () => clock });
    store.data.ceremonies.push({
      id: 'cer_q',
      circuitName: 'q',
      status: 'open',
      minContributions: 2,
      participation: { mode: 'invite', turnMinutes: 1 },
      contributions: [],
      queue: [],
      contributors: [],
      invites: [
        { id: 'inv_000000000001', kind: 'account', status: 'active', userId: 'u1', handle: 'one' },
        { id: 'inv_000000000002', kind: 'account', status: 'active', userId: 'u2', handle: 'two' },
      ],
      beacon: { precommit: null, history: [], applied: null },
      audit: [],
    });
    await svc.join('cer_q', { id: 'u1', handle: 'one' });
    await svc.join('cer_q', { id: 'u2', handle: 'two' });
    assert.equal(svc.publicView(svc.find('cer_q'), { id: 'u2', handle: 'two' }).me.position, 2);
    clock += 61 * 1000;
    await svc.tick(svc.find('cer_q'));
    const v = svc.publicView(svc.find('cer_q'), { id: 'u2', handle: 'two' });
    assert.equal(v.me.position, 1);
    assert.equal(v.me.yourTurn, true);
  });
});

test('sliding limiter', () => {
  let t = 0;
  const lim = createSlidingLimiter({ limit: 2, windowMs: 1000, now: () => t });
  assert.equal(lim.take('k'), 0);
  assert.equal(lim.take('k'), 0);
  assert.ok(lim.take('k') > 0);
  t = 1001;
  assert.equal(lim.take('k'), 0);
});

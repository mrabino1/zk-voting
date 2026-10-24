// NOT FOR PROFIT — civic public good, not a commercial product.
// Phase-2 trusted-setup ceremony: uploads, ordering, chain verification,
// beacon, finalize/export, and auth gating. Uses the one-constraint toy
// circuit in test/fixtures/ceremony (published entropy, never trusted).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
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
import { drandRoundAt, drandRoundTime, parseBeaconValue, parsePrecommit } from '../src/ceremony/beacon.mjs';
import { ceremonyHtmlFile, CEREMONY_PAGE_CSP, CEREMONY_WORKER_CSP } from '../src/ceremony/web.mjs';
import { createSlidingLimiter } from '../src/routes/ceremony.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures', 'ceremony');
const R1CS_SHA256 = '85342b9193ec76169c4331f90dae3cf4b037a26ab1d0f03e76e0513d84d8ea45';
const PTAU_SHA256 = 'cbc0a81821de303eed70e924bc621192118d372dd7b310b36922eef277f01a08';
const BEACON = 'a'.repeat(64);

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
  const created = await createApp({
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
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
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
  });

  test('joining and uploading need a session', async () => {
    assert.equal((await call('POST', '/api/ceremonies/cer_x/queue')).status, 401);
    assert.equal((await octet(undefined, '/api/ceremonies/cer_x/contributions?parent=0&name=x', Buffer.from('x'))).status, 401);
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
        participation: { mode: 'list', handles: 'alice, bob' },
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
  });

  test('queue: window, list, ordering', async () => {
    let r = await call('POST', `/api/ceremonies/${id}/queue`, { who: 'alice' });
    assert.equal(r.status, 409, 'closed window');
    r = await call('POST', `/api/ceremony-admin/ceremonies/${id}/open`, { who: 'admin' });
    assert.equal(r.status, 200);
    r = await call('POST', `/api/ceremonies/${id}/queue`, { who: 'carol' });
    assert.equal(r.status, 403, 'carol is not listed');
    r = await call('POST', `/api/ceremonies/${id}/queue`, { who: 'alice' });
    assert.equal(r.status, 200);
    assert.equal(r.data.ceremony.me.position, 1);
    assert.equal(r.data.ceremony.me.yourTurn, true);
    r = await call('POST', `/api/ceremonies/${id}/queue`, { who: 'alice' });
    assert.equal(r.status, 409);
    r = await call('POST', `/api/ceremonies/${id}/queue`, { who: 'bob' });
    assert.equal(r.data.ceremony.me.position, 2);
    const pub = await call('GET', `/api/ceremonies/${id}`);
    const text = pub.buf.toString('utf8');
    assert.doesNotMatch(text, /alice|bob/, 'public view hides handles');
    assert.doesNotMatch(text, /userId/);
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
    assert.equal((await call('GET', `/api/ceremonies/${id}/files/..%2F..%2Frepublic.json`)).status, 404);
    assert.equal((await call('GET', `/api/ceremonies/${id}/files/zkey_0009.zkey`)).status, 404);
    assert.equal((await call('GET', `/api/ceremonies/${id}/export/export.json`)).status, 404);
  });

  test('close needs a committed beacon; finalize exports artifacts', async () => {
    let r = await call('POST', `/api/ceremony-admin/ceremonies/${id}/close`, { who: 'admin' });
    assert.equal(r.data.code, 'CEREMONY_NO_BEACON');
    r = await call('POST', `/api/ceremony-admin/ceremonies/${id}/beacon/precommit`, {
      who: 'admin',
      json: { source: 'block-hash', network: 'ethereum-mainnet', height: 99999999 },
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    r = await call('POST', `/api/ceremony-admin/ceremonies/${id}/finalize`, {
      who: 'admin',
      json: { beaconValue: BEACON },
    });
    assert.equal(r.status, 409, 'must close first');
    r = await call('POST', `/api/ceremony-admin/ceremonies/${id}/close`, { who: 'admin' });
    assert.equal(r.status, 200);
    assert.equal(r.data.ceremony.status, 'closed');
    r = await call('POST', `/api/ceremonies/${id}/queue`, { who: 'bob' });
    assert.equal(r.status, 409);
    r = await call('POST', `/api/ceremony-admin/ceremonies/${id}/finalize`, {
      who: 'admin',
      json: { beaconValue: 'xyz' },
    });
    assert.equal(r.status, 400);
    r = await call('POST', `/api/ceremony-admin/ceremonies/${id}/finalize`, {
      who: 'admin',
      json: { beaconValue: `0x${BEACON}`, iterations: 10 },
    });
    assert.equal(r.status, 202);
    const job = await waitJob(r.data.job.id);
    assert.equal(job.status, 'done', job.error);
    const c = (await call('GET', `/api/ceremonies/${id}`)).data.ceremony;
    assert.equal(c.status, 'finalized');
    assert.equal(c.beacon.applied.value, BEACON);
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

describe('beacon rules', () => {
  test('drand rounds and values', () => {
    const t = drandRoundTime('quicknet', 1);
    assert.equal(t, 1692803367);
    assert.equal(drandRoundAt('quicknet', 1692803367 + 30), 11);
    assert.throws(() => parsePrecommit({ source: 'drand', chain: 'quicknet', round: 1 }, 1_800_000_000));
    const pre = parsePrecommit({ source: 'drand', chain: 'quicknet', round: 50_000_000 }, 1_800_000_000);
    assert.equal(pre.round, 50_000_000);
    assert.match(pre.lookupUrl, /api\.drand\.sh/);
    assert.equal(parseBeaconValue(`0x${'AB'.repeat(32)}`), 'ab'.repeat(32));
    assert.throws(() => parseBeaconValue('ab'));
  });

  test('close refuses a drand round that is already public; finalize waits for it', async () => {
    let clock = 1_800_000_000_000;
    const store = {
      data: { ceremonies: [] },
      writerActive: true,
      refuseIfStandby() {},
      async persist() {},
    };
    const svc = createCeremonyService({
      config: { dataDir: path.join(tmp, 'svc') },
      store,
      now: () => clock,
    });
    const round = drandRoundAt('quicknet', clock / 1000) + 100;
    store.data.ceremonies.push({
      id: 'cer_fake',
      circuitName: 'fake',
      status: 'open',
      minContributions: 2,
      participation: { mode: 'open', handles: [], turnMinutes: 30 },
      contributions: [{}, {}],
      queue: [],
      contributors: [],
      beacon: { precommit: null, history: [], applied: null },
      audit: [],
    });
    await svc.precommitBeacon('cer_fake', { source: 'drand', chain: 'quicknet', round }, null);
    clock += 400 * 1000;
    await assert.rejects(svc.close('cer_fake', null), /already public/);
    clock -= 400 * 1000;
    await svc.close('cer_fake', null);
    await assert.rejects(svc.finalize('cer_fake', { beaconValue: BEACON }, null), /not published yet/);
    const c = svc.find('cer_fake');
    assert.equal(verifyHashChain(c.audit, (e) => ({ seq: e.seq, at: e.at, action: e.action, actor: e.actor, details: e.details })).ok, true);
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
      participation: { mode: 'open', handles: [], turnMinutes: 1 },
      contributions: [],
      queue: [],
      contributors: [],
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

// NOT FOR PROFIT — civic public good, not a commercial product.
// First-run setup steps 3–4: entropy ceremony host and setup entropy. One
// accessor (entropyInfo): ZK_ENTROPY / ENTROPY_CEREMONY_URL in env win over
// the setup screen; the value is shown only to the super admin. The vendored
// browser library must stay identical to zk-entropy/src/index.js.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';

import { getConfig } from '../src/config.mjs';
import { normalizeCeremonyUrl, parseEntropyString, resolveEnvEntropy } from '../src/entropy.mjs';
import { createApp } from '../src/server.mjs';
import * as lib from '../public/vendor/zk-entropy.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const tmps = [];
const servers = [];
const setupTokens = new WeakMap();

function withSetupToken(api, headers) {
  const out = { ...(headers || {}) };
  if (!out['x-setup-token'] && !out['X-Setup-Token']) {
    const token = setupTokens.get(api);
    if (token) out['x-setup-token'] = token;
  }
  return out;
}

after(async () => {
  for (const s of servers) await new Promise((r) => s.close(() => r()));
  for (const t of tmps) await rm(t, { recursive: true, force: true });
});

function applyCookies(res, jar) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const c of list) {
    const pair = c.split(';')[0];
    const i = pair.indexOf('=');
    if (i !== -1) jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
}

function client(base) {
  return async function api(method, url, { body, jar, headers } = {}) {
    const res = await fetch(base + url, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(jar ? { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
        ...(headers || {}),
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
    return { status: res.status, json, text };
  };
}

function registrationBody({ id, challenge }) {
  return {
    id,
    rawId: id,
    type: 'public-key',
    response: {
      clientDataJSON: Buffer.from(
        JSON.stringify({ type: 'webauthn.create', challenge, origin: 'http://localhost' }),
      ).toString('base64url'),
      attestationObject: Buffer.from('00', 'hex').toString('base64url'),
      transports: ['internal'],
    },
  };
}

function hooks({ verifyDelayMs = 0 } = {}) {
  return {
    generateRegistrationOptions: async (opts) => ({
      challenge: `chal-${opts.userName}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      rp: { name: 'zk-voting', id: 'localhost' },
      user: { name: opts.userName, id: opts.userID },
      authenticatorSelection: { residentKey: 'required' },
      excludeCredentials: opts.excludeCredentials || [],
    }),
    verifyRegistrationResponse: async ({ response }) => {
      if (verifyDelayMs) await new Promise((r) => setTimeout(r, verifyDelayMs));
      return {
        verified: true,
        registrationInfo: {
          credential: { id: response.id, publicKey: Buffer.from(`pk-${response.id}`), counter: 0, transports: ['internal'] },
          credentialDeviceType: 'singleDevice',
          credentialBackedUp: false,
        },
      };
    },
  };
}

async function boot(extra = {}, { dataDir } = {}) {
  const dir = dataDir || (await mkdtemp(path.join(os.tmpdir(), 'zk-setup-')));
  if (!dataDir) tmps.push(dir);
  const created = await createApp({
    dataDir: dir,
    adminHandle: 'admin',
    superAdminEmail: '',
    quiet: true,
    port: 0,
    disclosureIntervalSeconds: 0,
    requireEmailMfa: false,
    passkeyHooks: hooks(extra.hookOpts),
    ...extra,
    hookOpts: undefined,
  });
  const server = await new Promise((resolve, reject) => {
    const s = created.app.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  servers.push(server);
  const api = client(`http://127.0.0.1:${server.address().port}`);
  setupTokens.set(api, created.config.setupToken);
  return { ...created, dir, api };
}

async function createAdmin(api, { handle = 'admin', jar = {}, id = 'admin-cred', headers } = {}) {
  const hdrs = withSetupToken(api, headers);
  const begin = await api('POST', '/api/setup/admin/begin', { body: { handle, acceptedTerms: true }, headers: hdrs });
  assert.equal(begin.status, 200, begin.text);
  const finish = await api('POST', '/api/setup/admin/finish', {
    jar,
    headers: hdrs,
    body: { handle, ...registrationBody({ id, challenge: begin.json.challenge }) },
  });
  return { begin, finish, jar };
}


async function sample(source) {
  const out = lib.toHex(lib.randomBytes(32));
  const th = lib.toHex(lib.randomBytes(32));
  return lib.makeEntropyString(source, out, th);
}

describe('zk-entropy in the demo', () => {
  const upstreamPath = path.join(here, '../../../../zk-entropy/src/index.js');
  test('vendored public/vendor/zk-entropy.js is identical to zk-entropy/src/index.js', { skip: !existsSync(upstreamPath) && 'zk-entropy/ not in this checkout (demo-only build context)' }, async () => {
    const vendored = await readFile(path.join(here, '../public/vendor/zk-entropy.js'), 'utf8');
    const upstream = await readFile(upstreamPath, 'utf8');
    assert.equal(vendored, upstream, 'run: cp zk-entropy/src/index.js voting_node/apps/node/public/vendor/zk-entropy.js');
  });

  test('the Node validator agrees with the browser library', async () => {
    for (const source of ['local', 'ceremony']) {
      const s = await sample(source);
      const a = parseEntropyString(s);
      const b = await lib.parseEntropyString(s);
      assert.equal(a.ok, true);
      assert.equal(b.ok, true);
      assert.equal(a.outputHex, b.outputHex);
      assert.equal(a.source, source);
      const flipped = s.slice(0, -1) + (s.at(-1) === '0' ? '1' : '0');
      assert.equal(parseEntropyString(flipped).ok, false);
      assert.equal((await lib.parseEntropyString(flipped)).ok, false);
    }
    assert.equal(parseEntropyString('zke1:other:' + 'a'.repeat(64)).ok, false);
    assert.equal(parseEntropyString('').ok, false);
  });

  test('ZK_ENTROPY: unset is null; invalid refuses to start without echoing it', async () => {
    assert.equal(resolveEnvEntropy(undefined), null);
    assert.equal(resolveEnvEntropy('  '), null);
    assert.throws(() => resolveEnvEntropy('zke1:local:nope-secret-ish'), (err) => !err.message.includes('nope-secret-ish'));
    const good = await sample('ceremony');
    assert.equal(resolveEnvEntropy(good), good);
    assert.throws(() => getConfig({ entropy: 'bad' }), /ZK_ENTROPY/);
    assert.throws(() => getConfig({ entropyCeremonyUrl: 'ftp://x' }), /ENTROPY_CEREMONY_URL/);
  });

  test('ceremony host normalisation', () => {
    assert.equal(normalizeCeremonyUrl('ceremony.zk-voting.org'), 'https://ceremony.zk-voting.org');
    assert.equal(normalizeCeremonyUrl('https://ceremony.zk-voting.org/'), 'https://ceremony.zk-voting.org');
    assert.equal(normalizeCeremonyUrl('http://localhost:8080'), 'http://localhost:8080');
    for (const bad of ['', 'http://ceremony.zk-voting.org', 'javascript:alert(1)', 'https://user:pw@x.org', 'not a host', 'localhostonly']) {
      assert.equal(normalizeCeremonyUrl(bad), null, bad);
    }
  });
});

describe('first-run setup entropy (steps 3–4)', () => {
  test('super admin saves the ceremony host and pastes its output; value is super-admin only', async () => {
    const { api, config, dir } = await boot({ allowDevLogin: true });
    const { jar } = await createAdmin(api);

    let s = await api('GET', '/api/setup');
    assert.equal(s.json.entropy.source, 'none');
    assert.equal(s.json.entropy.set, false);
    assert.equal(s.json.entropy.ceremony.enabled, null);

    assert.equal((await api('PUT', '/api/setup/ceremony', { body: { enabled: true, url: 'ceremony.zk-voting.org' } })).status, 401);
    const badUrl = await api('PUT', '/api/setup/ceremony', { jar, body: { enabled: true, url: 'http://ceremony.zk-voting.org' } });
    assert.equal(badUrl.json.code, 'SETUP_BAD_CEREMONY_URL');
    // Ceremony output before saying there is a ceremony.
    const ceremonyValue = await sample('ceremony');
    const early = await api('PUT', '/api/setup/entropy', { jar, body: { mode: 'ceremony', value: ceremonyValue } });
    assert.equal(early.status, 409);
    assert.equal(early.json.code, 'SETUP_NO_CEREMONY');

    const cer = await api('PUT', '/api/setup/ceremony', { jar, body: { enabled: true, url: 'ceremony.zk-voting.org' } });
    assert.equal(cer.status, 200, cer.text);
    assert.deepEqual(cer.json.entropy.ceremony, { enabled: true, url: 'https://ceremony.zk-voting.org', source: 'setup' });

    const mismatch = await api('PUT', '/api/setup/entropy', { jar, body: { mode: 'ceremony', value: await sample('local') } });
    assert.equal(mismatch.json.code, 'SETUP_ENTROPY_SOURCE_MISMATCH');
    const typo = ceremonyValue.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'));
    const bad = await api('PUT', '/api/setup/entropy', { jar, body: { mode: 'ceremony', value: typo } });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.code, 'SETUP_BAD_ENTROPY');
    assert.equal(bad.text.includes(typo), false, 'never echoes the value');

    const put = await api('PUT', '/api/setup/entropy', { jar, body: { mode: 'ceremony', value: ceremonyValue } });
    assert.equal(put.status, 200, put.text);
    assert.equal(put.json.entropy.set, true);
    assert.equal(put.json.entropy.mode, 'ceremony');
    assert.equal(put.json.entropy.transcriptHash, ceremonyValue.split(':')[3]);
    assert.equal(put.text.includes(ceremonyValue), false, 'status never carries the value');
    s = await api('GET', '/api/setup');
    assert.equal(s.text.includes(ceremonyValue.split(':')[2]), false, 'public status never carries the output');

    const mine = await api('GET', '/api/setup/entropy', { jar });
    assert.equal(mine.status, 200);
    assert.equal(mine.json.entropy.value, ceremonyValue);
    assert.equal((await api('GET', '/api/setup/entropy')).status, 401);
    const voter = {};
    await api('POST', '/api/auth/dev-login', { body: { handle: 'voter1', role: 'voter' }, jar: voter });
    assert.equal((await api('GET', '/api/setup/entropy', { jar: voter })).status, 403);
    assert.equal((await api('PUT', '/api/setup/entropy', { jar: voter, body: { mode: 'skip' } })).status, 403);

    // Turning the ceremony off drops a pasted ceremony output.
    const off = await api('PUT', '/api/setup/ceremony', { jar, body: { enabled: false } });
    assert.equal(off.json.entropy.set, false);
    assert.equal(off.json.entropy.ceremony.enabled, false);

    const local = await sample('local');
    const lput = await api('PUT', '/api/setup/entropy', { jar, body: { mode: 'local', value: local } });
    assert.equal(lput.json.entropy.mode, 'local');

    await api('POST', '/api/setup/complete', { jar, body: {} });
    const late = await api('PUT', '/api/setup/entropy', { jar, body: { mode: 'skip' } });
    assert.equal(late.json.code, 'SETUP_COMPLETE');
    assert.equal((await api('PUT', '/api/setup/ceremony', { jar, body: { enabled: false } })).json.code, 'SETUP_COMPLETE');

    // Survives a restart; still readable by the super admin after finish.
    const again = await boot({}, { dataDir: dir });
    const st = await again.api('GET', '/api/setup');
    assert.equal(st.json.entropy.set, true);
    assert.equal(st.json.entropy.source, 'setup');
    void config;
  });

  test('skip is a saved choice', async () => {
    const { api } = await boot();
    const { jar } = await createAdmin(api);
    const r = await api('PUT', '/api/setup/entropy', { jar, body: { mode: 'skip' } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.entropy.source, 'setup');
    assert.equal(r.json.entropy.mode, 'skip');
    assert.equal(r.json.entropy.set, false);
    assert.equal((await api('PUT', '/api/setup/entropy', { jar, body: { mode: 'nope' } })).json.code, 'SETUP_BAD_ENTROPY_MODE');
  });

  test('ZK_ENTROPY and ENTROPY_CEREMONY_URL in the environment win and are read-only', async () => {
    const envValue = await sample('ceremony');
    const { api, store, config } = await boot({ entropy: envValue, entropyCeremonyUrl: 'ceremony.zk-voting.org' });
    assert.equal(Object.keys(config).includes('entropyEnv'), false, 'non-enumerable: never in a config dump');
    const fresh = getConfig({ entropy: envValue });
    assert.equal(fresh.entropyEnv, envValue);
    assert.equal(JSON.stringify(fresh).includes(envValue), false, 'never in a JSON config dump');
    const s = await api('GET', '/api/setup');
    assert.equal(s.json.entropy.source, 'env');
    assert.equal(s.json.entropy.fixed, true);
    assert.equal(s.json.entropy.set, true);
    assert.equal(s.json.entropy.ceremony.source, 'env');
    assert.equal(s.text.includes(envValue), false);
    const { jar } = await createAdmin(api);
    assert.equal((await api('PUT', '/api/setup/entropy', { jar, body: { mode: 'skip' } })).json.code, 'ENTROPY_FIXED_BY_ENV');
    assert.equal((await api('PUT', '/api/setup/ceremony', { jar, body: { enabled: false } })).json.code, 'ENTROPY_CEREMONY_FIXED_BY_ENV');
    store.data.meta.setup.entropy = { mode: 'local', value: await sample('local') };
    const mine = await api('GET', '/api/setup/entropy', { jar });
    assert.equal(mine.json.entropy.value, envValue, 'env wins over the stored value');
  });

  test('setup page wires steps 3–4 and the contribution page has the validated paste field', async () => {
    const app = await readFile(path.join(here, '../public/app.js'), 'utf8');
    assert.match(app, /setupExtraSteps: \[\.\.\.entropySetupSteps, \.\.\.siteSetupSteps\]/);
    const steps = await readFile(path.join(here, '../public/setup-entropy.js'), 'utf8');
    assert.match(steps, /export const entropySetupSteps = \[ceremonyStep, entropyStep\]/);
    const cer = await readFile(path.join(here, '../public/ceremony.js'), 'utf8');
    assert.match(cer, /id: "contrib-entropy"/);
    assert.match(cer, /parseEntropyString\(raw, \{ allowHex: true \}\)/);
    const worker = await readFile(path.join(here, '../public/ceremony-worker.js'), 'utf8');
    assert.match(worker, /toHex\(collected\) \+ pasted \+ toHex\(extra\)/);
    assert.match(worker, /\^\[0-9a-f\]\{64\}\$/);
  });
});

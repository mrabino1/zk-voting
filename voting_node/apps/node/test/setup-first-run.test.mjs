// NOT FOR PROFIT — civic public good, not a commercial product.
// First-run setup: the first visitor creates the platform super admin
// (first finish wins), the endpoint then refuses for ever, and the chain id
// has one accessor (env CHAIN_ID > setup choice > 27427).

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

import { getConfig } from '../src/config.mjs';
import { createPasskeyService } from '../src/passkey.mjs';
import { createApp } from '../src/server.mjs';
import { CHAIN_ID_PRESETS, parseChainId, resolveEnvChainId } from '../src/setup.mjs';

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

function unclaimSuperAdmin(store) {
  const admin = store.data.users.find((u) => u.role === 'platform_super_admin');
  admin.credentials = [];
  admin.authMethods = [];
  admin.ethAccounts = [];
  admin.email = '';
  admin.activeEthAddress = null;
  return admin;
}

describe('chain id parsing', () => {
  test('parseChainId accepts positive safe integers only', () => {
    assert.equal(parseChainId(27427), 27427);
    assert.equal(parseChainId('11155111'), 11155111);
    assert.equal(parseChainId(' 1 '), 1);
    for (const bad of [0, -1, '0', '01', '1.5', 1.5, 'abc', '', null, undefined, '1e3', '99999999999999999']) {
      assert.equal(parseChainId(bad), null, String(bad));
    }
  });

  test('CHAIN_ID unset means not fixed; invalid refuses to start', () => {
    assert.equal(resolveEnvChainId(undefined), null);
    assert.equal(resolveEnvChainId(''), null);
    assert.equal(resolveEnvChainId('31337'), 31337);
    assert.throws(() => resolveEnvChainId('mainnet'), /CHAIN_ID/);
    assert.throws(() => getConfig({ chainId: 'nope' }), /CHAIN_ID/);
  });

  test('presets are the documented networks', () => {
    assert.deepEqual(
      CHAIN_ID_PRESETS.map((p) => p.chainId),
      [27427, 1, 11155111, 31337],
    );
  });
});

describe('first-run super admin', () => {
  test('fresh install reports needsAdmin and the default chain id', async () => {
    const { api } = await boot();
    const s = await api('GET', '/api/setup');
    assert.equal(s.status, 200);
    assert.equal(s.json.needsAdmin, true);
    assert.equal(s.json.setupComplete, false);
    assert.equal(s.json.redirect, false, 'redirect is off under NODE_ENV=test by default');
    assert.equal(s.json.suggestedHandle, 'admin');
    assert.deepEqual(s.json.chainId, { value: 27427, source: 'default', fixed: false, env: 'CHAIN_ID' });
  });

  test('redirect flag turns on for a fresh install when enabled', async () => {
    const { api } = await boot({ firstRunRedirect: true });
    const s = await api('GET', '/api/setup');
    assert.equal(s.json.redirect, true);
  });

  test('begin validates terms and handle', async () => {
    const { api } = await boot();
    const headers = withSetupToken(api);
    const noTerms = await api('POST', '/api/setup/admin/begin', { body: { handle: 'admin' }, headers });
    assert.equal(noTerms.status, 400, noTerms.text);
    const badHandle = await api('POST', '/api/setup/admin/begin', {
      body: { handle: 'a b!', acceptedTerms: true },
      headers,
    });
    assert.equal(badHandle.status, 400);
    assert.equal(badHandle.json.code, 'SETUP_BAD_HANDLE');
  });

  test('creates the super admin, signs them in, then closes for good', async () => {
    const { api, store } = await boot();
    const { finish, jar } = await createAdmin(api, { handle: 'root-admin' });
    assert.equal(finish.status, 200, finish.text);
    assert.equal(finish.json.user.role, 'platform_super_admin');
    assert.equal(finish.json.user.handle, 'root-admin');
    assert.ok(jar['zk-voting.sid'], 'session cookie set');
    assert.equal(finish.json.setup.needsAdmin, false);

    const supers = store.data.users.filter((u) => u.role === 'platform_super_admin');
    assert.equal(supers.length, 1, 'the seed row was claimed, not a second super admin');
    assert.equal(supers[0].credentials.length, 1);

    const me = await api('GET', '/api/me', { jar });
    assert.equal((me.json.me || me.json.user).role, 'platform_super_admin');

    const again = await api('POST', '/api/setup/admin/begin', { body: { handle: 'evil', acceptedTerms: true } });
    assert.equal(again.status, 409);
    assert.equal(again.json.code, 'SETUP_ADMIN_EXISTS');
    const againFinish = await api('POST', '/api/setup/admin/finish', {
      body: { handle: 'evil', ...registrationBody({ id: 'evil', challenge: 'x' }) },
    });
    assert.equal(againFinish.status, 409);
    const status = await api('GET', '/api/setup');
    assert.equal(status.json.needsAdmin, false);
    assert.equal(status.json.suggestedHandle, null);
  });

  test('race: of two parallel finishes only the first wins', async () => {
    const { api, store } = await boot({ hookOpts: { verifyDelayMs: 20 } });
    const headers = withSetupToken(api);
    const b1 = await api('POST', '/api/setup/admin/begin', { body: { handle: 'admin', acceptedTerms: true }, headers });
    const b2 = await api('POST', '/api/setup/admin/begin', { body: { handle: 'admin', acceptedTerms: true }, headers });
    assert.equal(b1.status, 200);
    assert.equal(b2.status, 200);
    const [f1, f2] = await Promise.all([
      api('POST', '/api/setup/admin/finish', { headers, body: { handle: 'admin', ...registrationBody({ id: 'cred-a', challenge: b1.json.challenge }) } }),
      api('POST', '/api/setup/admin/finish', { headers, body: { handle: 'admin', ...registrationBody({ id: 'cred-b', challenge: b2.json.challenge }) } }),
    ]);
    const statuses = [f1.status, f2.status].sort();
    assert.deepEqual(statuses, [200, 409], `${f1.text} | ${f2.text}`);
    const loser = f1.status === 409 ? f1 : f2;
    assert.equal(loser.json.code, 'SETUP_ADMIN_EXISTS');
    const admin = store.data.users.find((u) => u.role === 'platform_super_admin');
    assert.equal(admin.credentials.length, 1, 'exactly one credential attached');
  });

  test('race at the service: same-tick finishes for the seed attach one credential', async () => {
    const { store, config } = await boot();
    const passkeys = createPasskeyService(config, store, hooks());
    const seed = store.data.users.find((u) => u.role === 'platform_super_admin');
    const o1 = await passkeys.beginRegister({ user: seed, handle: seed.handle, acceptedTerms: true });
    const o2 = await passkeys.beginRegister({ user: seed, handle: seed.handle, acceptedTerms: true });
    const results = await Promise.allSettled([
      passkeys.finishRegister({
        body: registrationBody({ id: 's-a', challenge: o1.challenge }),
        user: null,
        handle: seed.handle,
        claimSeedOnly: seed.id,
      }),
      passkeys.finishRegister({
        body: registrationBody({ id: 's-b', challenge: o2.challenge }),
        user: null,
        handle: seed.handle,
        claimSeedOnly: seed.id,
      }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
    const rejected = results.find((r) => r.status === 'rejected');
    assert.equal(rejected.reason.status ?? rejected.reason.statusCode, 409);
    assert.equal(store.getUser(seed.id).credentials.length, 1);
  });

  test('bare register cannot claim the seed; setup can', async () => {
    const { api, store } = await boot({ hookOpts: { verifyDelayMs: 20 } });
    const headers = withSetupToken(api);
    const b1 = await api('POST', '/api/setup/admin/begin', { body: { handle: 'admin', acceptedTerms: true }, headers });
    const b2 = await api('POST', '/api/auth/passkey/register/begin', { body: { handle: 'admin', acceptedTerms: true } });
    assert.equal(b1.status, 200, b1.text);
    assert.equal(b2.status, 403, b2.text);
    assert.equal(b2.json.code, 'SETUP_TOKEN_REQUIRED');
    const f1 = await api('POST', '/api/setup/admin/finish', {
      headers,
      body: { handle: 'admin', ...registrationBody({ id: 'cred-a', challenge: b1.json.challenge }) },
    });
    assert.equal(f1.status, 200, f1.text);
    const admin = store.data.users.find((u) => u.role === 'platform_super_admin');
    assert.equal(admin.credentials.length, 1);
  });

  test('unset SETUP_TOKEN mints a one-time token and refuses the bare-handle claim', async () => {
    const { api, config, store } = await boot({ adminHandle: 'ops', setupToken: '' });
    assert.equal(config.setupTokenGenerated, true);
    assert.equal(typeof config.setupToken, 'string');
    assert.ok(config.setupToken.length >= 16);
    const s = await api('GET', '/api/setup');
    assert.equal(s.json.suggestedHandle, 'ops');
    assert.equal(s.json.setupTokenRequired, true);
    assert.equal(s.json.setupTokenSource, 'generated');
    const echoed = [s.text, (await api('GET', '/health')).text, (await api('GET', '/api/config')).text].some((text) =>
      text.includes(config.setupToken),
    );
    assert.equal(echoed, false);
    const begin = await api('POST', '/api/auth/passkey/register/begin', { body: { handle: 'ops', acceptedTerms: true } });
    assert.equal(begin.status, 403);
    assert.equal(begin.json.code, 'SETUP_TOKEN_REQUIRED');
    const { finish } = await createAdmin(api, { handle: 'ops' });
    assert.equal(finish.status, 200, finish.text);
    assert.equal(finish.json.user.role, 'platform_super_admin');
    unclaimSuperAdmin(store);
    const again = await api('POST', '/api/setup/admin/begin', {
      body: { handle: 'ops', acceptedTerms: true },
      headers: { 'x-setup-token': config.setupToken },
    });
    assert.equal(again.status, 403);
    assert.equal(again.json.code, 'SETUP_TOKEN_USED');
    assert.equal(again.text.includes(config.setupToken), false);
  });

  test('SUPER_ADMIN_EMAIL bootstrap: contact email lands on the row setup claims', async () => {
    const { api, store } = await boot({ superAdminEmail: 'ops@example.org' });
    assert.equal((await api('GET', '/api/setup')).json.needsAdmin, true);
    const { finish } = await createAdmin(api);
    assert.equal(finish.status, 200, finish.text);
    const admin = store.data.users.find((u) => u.role === 'platform_super_admin');
    assert.equal(admin.contactEmail, 'ops@example.org');
    assert.equal(store.data.users.filter((u) => u.role === 'platform_super_admin').length, 1);
  });

  test('SETUP_TOKEN gates setup and blocks the bare-handle claim', async () => {
    const { api } = await boot({ setupToken: 'test-setup-token-value' });
    const s = await api('GET', '/api/setup');
    assert.equal(s.json.setupTokenRequired, true);
    assert.equal(s.json.setupTokenSource, 'environment');
    const none = await api('POST', '/api/setup/admin/begin', { body: { handle: 'admin', acceptedTerms: true } });
    assert.equal(none.status, 403);
    assert.equal(none.json.code, 'SETUP_TOKEN_REQUIRED');
    const wrong = await api('POST', '/api/setup/admin/begin', {
      body: { handle: 'admin', acceptedTerms: true },
      headers: { 'x-setup-token': 'wrong' },
    });
    assert.equal(wrong.status, 403);

    const lb = await api('POST', '/api/auth/passkey/register/begin', { body: { handle: 'admin', acceptedTerms: true } });
    assert.equal(lb.status, 403, lb.text);
    assert.equal(lb.json.code, 'SETUP_TOKEN_REQUIRED');

    const ok = await createAdmin(api, { headers: { 'x-setup-token': 'test-setup-token-value' } });
    assert.equal(ok.finish.status, 200, ok.finish.text);
    assert.equal(JSON.stringify(ok.finish.json).includes('test-setup-token-value'), false, 'token never echoed');
  });

  test('an environment setup token can be retried until a super admin exists', async () => {
    const { api, config, store } = await boot({ setupToken: 'test-setup-token-value' });
    assert.equal(config.setupTokenGenerated, false);
    const { finish } = await createAdmin(api, { headers: { 'x-setup-token': 'test-setup-token-value' } });
    assert.equal(finish.status, 200, finish.text);
    unclaimSuperAdmin(store);
    const again = await api('POST', '/api/setup/admin/begin', {
      body: { handle: 'admin', acceptedTerms: true },
      headers: { 'x-setup-token': 'test-setup-token-value' },
    });
    assert.equal(again.status, 200, again.text);
    assert.equal(again.text.includes('test-setup-token-value'), false);
  });
});

describe('first-run chain id', () => {
  test('super admin picks the chain id; every reader uses it; finish pins it', async () => {
    const { api, config, dir } = await boot();
    const { jar } = await createAdmin(api);

    const anon = await api('PUT', '/api/setup/chain-id', { body: { chainId: 1 } });
    assert.equal(anon.status, 401);
    const bad = await api('PUT', '/api/setup/chain-id', { jar, body: { chainId: '0x1' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.code, 'SETUP_BAD_CHAIN_ID');

    const put = await api('PUT', '/api/setup/chain-id', { jar, body: { chainId: 11155111 } });
    assert.equal(put.status, 200, put.text);
    assert.deepEqual(put.json.chainId, { value: 11155111, source: 'setup', fixed: false, env: 'CHAIN_ID' });
    assert.equal(config.chainId, 11155111, 'config.chainId is the one accessor');
    const health = await api('GET', '/api/health');
    assert.equal(health.json.chainId, 11155111);

    const custom = await api('PUT', '/api/setup/chain-id', { jar, body: { chainId: '424242' } });
    assert.equal(custom.status, 200);
    assert.equal(config.chainId, 424242);

    const done = await api('POST', '/api/setup/complete', { jar, body: {} });
    assert.equal(done.status, 200);
    assert.equal(done.json.setupComplete, true);
    const late = await api('PUT', '/api/setup/chain-id', { jar, body: { chainId: 1 } });
    assert.equal(late.status, 409);
    assert.equal(late.json.code, 'SETUP_COMPLETE');

    // Survives a restart on the same data dir.
    const again = await boot({}, { dataDir: dir });
    assert.equal(again.config.chainId, 424242);
    const s = await again.api('GET', '/api/setup');
    assert.equal(s.json.needsAdmin, false);
    assert.equal(s.json.setupComplete, true);
  });

  test('CHAIN_ID in the environment wins and is read-only', async () => {
    const { api, config, store } = await boot({ chainId: 31337 });
    const s = await api('GET', '/api/setup');
    assert.deepEqual(s.json.chainId, { value: 31337, source: 'env', fixed: true, env: 'CHAIN_ID' });
    const { jar } = await createAdmin(api);
    const put = await api('PUT', '/api/setup/chain-id', { jar, body: { chainId: 1 } });
    assert.equal(put.status, 409);
    assert.equal(put.json.code, 'CHAIN_ID_FIXED_BY_ENV');
    // Even a stored value cannot override the env.
    store.data.meta.setup.chainId = 1;
    assert.equal(config.chainId, 31337);
  });

  test('non-super-admin cannot set the chain id', async () => {
    const { api } = await boot({ allowDevLogin: true });
    await createAdmin(api);
    const jar = {};
    await api('POST', '/api/auth/dev-login', { body: { handle: 'voter1', role: 'voter' }, jar });
    const put = await api('PUT', '/api/setup/chain-id', { jar, body: { chainId: 1 } });
    assert.equal(put.status, 403);
  });
});

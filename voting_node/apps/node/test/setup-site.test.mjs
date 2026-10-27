// NOT FOR PROFIT — civic public good, not a commercial product.
// First-run setup steps 5–6: site and environment (read-only env, product
// name) and the L2 identity step. Nothing here may return a secret.

import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';
import { createApp } from '../src/server.mjs';

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



describe('first-run setup steps 5–6', () => {
  test('site info is super-admin only and never carries a secret', async () => {
    const { api } = await boot({
      allowDevLogin: true,
      setupToken: 'tok-0123456789abcdef-secret',
      databaseUrl: '',
    });
    const headers = { 'x-setup-token': 'tok-0123456789abcdef-secret' };
    let anon = await api('GET', '/api/setup');
    assert.equal(anon.json.site, null);
    const { jar } = await createAdmin(api, { headers });
    const s = await api('GET', '/api/setup', { jar });
    assert.equal(s.status, 200);
    const site = s.json.site;
    assert.equal(site.database, 'json');
    assert.equal(site.setupTokenSet, true);
    assert.equal(typeof site.port, 'number');
    assert.ok(site.productName);
    assert.ok(!s.text.includes('tok-0123456789abcdef-secret'));
    anon = await api('GET', '/api/setup');
    assert.equal(anon.json.site, null);
  });

  test('PUT /api/setup/site saves the product name with the Site admin inherit rule', async () => {
    const { api } = await boot({ allowDevLogin: true });
    assert.equal((await api('PUT', '/api/setup/site', { body: { productName: 'X' } })).status, 401);
    const { jar } = await createAdmin(api);
    const def = (await api('GET', '/api/setup', { jar })).json.site.productNameDefault;

    const bad = await api('PUT', '/api/setup/site', { jar, body: { productName: 'a<b>' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.code, 'SETUP_BAD_NAME');
    assert.equal((await api('PUT', '/api/setup/site', { jar, body: {} })).json.code, 'SETUP_BAD_NAME');

    let r = await api('PUT', '/api/setup/site', { jar, body: { productName: '  Springfield Votes ' } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.site.productName, 'Springfield Votes');
    assert.equal(r.json.site.productNameSaved, true);
    const layout = await api('GET', '/api/layout');
    assert.equal(layout.json.layout.branding.productName, 'Springfield Votes');

    // The default (BRAND_NAME or built-in) is saved as inherit.
    r = await api('PUT', '/api/setup/site', { jar, body: { productName: def } });
    assert.equal(r.json.site.productName, def);
    assert.equal(r.json.site.productNameSaved, false);

    await api('PUT', '/api/setup/site', { jar, body: { productName: 'Springfield Votes' } });
    assert.equal((await api('POST', '/api/setup/complete', { jar, body: {} })).status, 200);
    const late = await api('PUT', '/api/setup/site', { jar, body: { productName: 'Other' } });
    assert.equal(late.status, 409);
    assert.equal(late.json.code, 'SETUP_COMPLETE');
  });

  test('GET /api/l2/identity never returns the salt, admin secret or submitter key', async () => {
    const { api } = await boot();
    const r = await api('GET', '/api/l2/identity');
    assert.equal(r.status, 200);
    for (const k of ['l2Salt', 'salt', 'adminSecret', 'privateKey', 'submitterKey']) assert.equal(k in r.json, false, k);
    assert.equal(typeof r.json.submitterKeySet, 'boolean');
    assert.equal(typeof r.json.adminWritesEnabled, 'boolean');
  });

  test('setup page wires steps 5–6 with the low-balance warning and l2:identity hints', async () => {
    const app = await readFile(path.join(here, '../public/app.js'), 'utf8');
    assert.match(app, /import \{ siteSetupSteps \} from "\.\/setup-site\.js"/);
    const steps = await readFile(path.join(here, '../public/setup-site.js'), 'utf8');
    assert.match(steps, /export const siteSetupSteps = \[siteStep, l2Step\]/);
    assert.match(steps, /\/api\/l2\/identity\$\{funding \? "\?funding=1" : ""\}/);
    assert.match(steps, /Warning: L1 balance/);
    assert.match(steps, /npm run l2:identity -- check-funding/);
    assert.doesNotMatch(steps, /L2_SALT"\s*\]|\.l2Salt|adminSecret\b/);
    assert.match(steps, /\/api\/setup\/site/);
  });
});

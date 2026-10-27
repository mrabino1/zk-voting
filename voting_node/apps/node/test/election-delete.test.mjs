// NOT FOR PROFIT — civic public good, not a commercial product.
// Unused elections can be deleted after the clerk types the saved title.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { createApp } from '../src/server.mjs';

let tmp;
let server;
let base;
const adminJar = {};

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
  return { status: res.status, json, text };
}

function listen(application) {
  return new Promise((resolve, reject) => {
    const s = application.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
}

function electionBody(title) {
  const now = Math.floor(Date.now() / 1000);
  return {
    title,
    startTime: now - 30,
    cutoffTime: now + 3600,
    treeDepth: 16,
    questions: [{ type: 'YES_NO', prompt: 'Adopt the measure?' }],
  };
}

describe('DELETE unused election', () => {
  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-delete-'));
    const created = await createApp({
      dataDir: tmp,
      allowDevLogin: true,
      adminHandle: 'admin',
      quiet: true,
      port: 0,
      disclosureIntervalSeconds: 0,
    });
    server = await listen(created.app);
    base = `http://127.0.0.1:${server.address().port}`;
    const login = await api('POST', '/api/auth/dev-login', { body: { handle: 'admin' }, jar: adminJar });
    assert.equal(login.status, 200);
  });

  after(async () => {
    if (server) {
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  test('requires the saved title, then removes the election', async () => {
    const created = await api('POST', '/api/elections', {
      jar: adminJar,
      body: electionBody('Harbor bond'),
    });
    assert.equal(created.status, 201, created.json?.error);
    const id = created.json.election.id;

    const missing = await api('DELETE', `/api/elections/${id}`, { jar: adminJar, body: {} });
    assert.equal(missing.status, 400);
    assert.equal(missing.json.code, 'CONFIRM_TITLE');

    const wrong = await api('DELETE', `/api/elections/${id}`, {
      jar: adminJar,
      body: { confirmTitle: 'harbor bond' },
    });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.json.code, 'CONFIRM_TITLE');

    const still = await api('GET', `/api/elections/${id}`);
    assert.equal(still.status, 200);

    const deleted = await api('DELETE', `/api/elections/${id}`, {
      jar: adminJar,
      body: { confirmTitle: 'Harbor bond' },
    });
    assert.equal(deleted.status, 200, deleted.json?.error);
    assert.equal(deleted.json.deleted.id, id);
    assert.equal(deleted.json.deleted.title, 'Harbor bond');
    assert.equal(deleted.json.nfp, true);

    const gone = await api('GET', `/api/elections/${id}`);
    assert.equal(gone.status, 404);
  });

  test('refuses a frozen roll', async () => {
    const created = await api('POST', '/api/elections', {
      jar: adminJar,
      body: electionBody('School levy'),
    });
    assert.equal(created.status, 201, created.json?.error);
    const id = created.json.election.id;
    const frozen = await api('POST', `/api/elections/${id}/freeze`, { jar: adminJar, body: {} });
    assert.equal(frozen.status, 200, frozen.json?.error);
    const denied = await api('DELETE', `/api/elections/${id}`, {
      jar: adminJar,
      body: { confirmTitle: 'School levy' },
    });
    assert.equal(denied.status, 409);
    assert.equal(denied.json.code, 'ROLL_FROZEN');
    const kept = await api('GET', `/api/elections/${id}`);
    assert.equal(kept.status, 200);
  });
});

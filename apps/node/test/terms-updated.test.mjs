// NOT FOR PROFIT — civic public good, not a commercial product.
// Sign-in terms notice: plain-text SHA-256, once per member per hash.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { createMailer } from '../src/mailer.mjs';
import { createApp } from '../src/server.mjs';
import { Store } from '../src/store.mjs';
import {
  createTermsService,
  getTermsDocument,
  loadTermsDocument,
  sha256Hex,
} from '../src/terms.mjs';

function person(id, email) {
  return {
    id,
    handle: id,
    role: 'voter',
    email,
    credentials: [],
    authMethods: [],
    ethAccounts: [],
    termsNotifiedHash: null,
    termsNotifiedAt: null,
  };
}

function memoryStore(list) {
  const byId = new Map(list.map((user) => [user.id, user]));
  return {
    users: list,
    getUser(id) {
      return byId.get(id) || null;
    },
    async persist() {},
  };
}

function updatedMessages(mailer) {
  return mailer.sent.filter((row) => row.meta?.purpose === 'terms-updated');
}

describe('terms plain-text hash', () => {
  test('plainTextSha256 is SHA-256 of the /terms plain text and changes with that text', async () => {
    const doc = getTermsDocument();
    assert.equal(doc.plainText, doc.markdown);
    assert.equal(doc.plainTextSha256, doc.markdownSha256);
    assert.equal(sha256Hex(Buffer.from(doc.plainText, 'utf8')), doc.plainTextSha256);
    assert.equal(createHash('sha256').update(doc.markdownBytes).digest('hex'), doc.plainTextSha256);

    const dir = await mkdtemp(path.join(os.tmpdir(), 'republic-terms-plain-'));
    const filePath = path.join(dir, 'terms.md');
    const header = '---\nversion: 3\nlastUpdated: 2026-09-19\ntitle: Test Terms\nfilename: test.pdf\n---\n\n';
    await writeFile(filePath, `${header}# Test\n\nAlpha text.\n`, 'utf8');
    const alpha = loadTermsDocument({ filePath });
    await writeFile(filePath, `${header}# Test\n\nBeta text.\n`, 'utf8');
    const beta = loadTermsDocument({ filePath });
    assert.notEqual(alpha.plainTextSha256, beta.plainTextSha256);
    assert.match(alpha.plainText, /Alpha text/);
    assert.match(beta.plainText, /Beta text/);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('terms notice service', () => {
  test('hash change sends once per member; unchanged does not; failure does not store the hash', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'republic-terms-svc-'));
    const filePath = path.join(dir, 'terms.md');
    const header = '---\nversion: 4\nlastUpdated: 2026-09-19\ntitle: Test Terms\nfilename: notice.pdf\n---\n\n';
    await writeFile(filePath, `${header}# Test\n\nFirst wording.\n`, 'utf8');
    let current = loadTermsDocument({ filePath });
    const alice = person('alice', 'alice@example.com');
    const bob = person('bob', 'bob@example.com');
    const store = memoryStore([alice, bob]);
    const mailer = createMailer({ captureEmail: true, allowCaptureMailer: true });
    const realSend = mailer.send.bind(mailer);
    let fail = false;
    const warnings = [];
    const orig = console.warn;
    console.warn = (...args) => {
      warnings.push(args.map(String).join(' '));
    };
    mailer.send = async (msg) => {
      if (fail && msg?.meta?.purpose === 'terms-updated') {
        throw new Error('ses down for alice@example.com AKIAFAKESECRETKEY');
      }
      return realSend(msg);
    };
    const terms = createTermsService({
      store,
      mailer,
      config: { publicBaseUrl: 'https://vote.example' },
      getDocument: () => current,
    });

    try {
      const first = await terms.maybeNotifyTermsUpdated(alice);
      assert.equal(first.sent, true);
      assert.equal(alice.termsNotifiedHash, current.plainTextSha256);
      assert.ok(alice.termsNotifiedAt);
      const stamped = alice.termsNotifiedAt;
      assert.equal(updatedMessages(mailer).length, 1);
      assert.equal(updatedMessages(mailer)[0].to, 'alice@example.com');
      assert.match(updatedMessages(mailer)[0].text, /https:\/\/vote\.example\/terms/);
      assert.equal(updatedMessages(mailer)[0].meta.plainTextSha256, current.plainTextSha256);
      assert.equal(updatedMessages(mailer)[0].attachments[0].sha256, current.pdfSha256);

      const again = await terms.maybeNotifyTermsUpdated(alice);
      assert.equal(again.sent, false);
      assert.equal(again.reason, 'unchanged');
      assert.equal(alice.termsNotifiedAt, stamped);
      assert.equal(updatedMessages(mailer).length, 1);

      const bobFirst = await terms.maybeNotifyTermsUpdated(bob);
      assert.equal(bobFirst.sent, true);
      assert.equal(bob.termsNotifiedHash, current.plainTextSha256);
      assert.equal(updatedMessages(mailer).filter((row) => row.to === 'bob@example.com').length, 1);

      await writeFile(filePath, `${header}# Test\n\nSecond wording.\n`, 'utf8');
      current = loadTermsDocument({ filePath });
      assert.notEqual(alice.termsNotifiedHash, current.plainTextSha256);
      const changed = await terms.maybeNotifyTermsUpdated(alice);
      assert.equal(changed.sent, true);
      assert.equal(alice.termsNotifiedHash, current.plainTextSha256);
      assert.notEqual(alice.termsNotifiedAt, stamped);
      assert.equal(updatedMessages(mailer).filter((row) => row.to === 'alice@example.com').length, 2);
      const still = await terms.maybeNotifyTermsUpdated(alice);
      assert.equal(still.reason, 'unchanged');
      assert.equal(updatedMessages(mailer).filter((row) => row.to === 'alice@example.com').length, 2);

      const cara = person('cara', 'cara@example.com');
      store.users.push(cara);
      store.getUser = (id) => store.users.find((user) => user.id === id) || null;
      fail = true;
      const broken = await terms.maybeNotifyTermsUpdated(cara);
      assert.equal(broken.sent, false);
      assert.equal(broken.reason, 'send_failed');
      assert.equal(cara.termsNotifiedHash, null);
      assert.equal(cara.termsNotifiedAt, null);
      assert.equal(updatedMessages(mailer).filter((row) => row.to === 'cara@example.com').length, 0);
      assert.ok(warnings.some((line) => line.includes('reason=send_failed')));
      assert.ok(warnings.every((line) => !line.includes('cara@example.com')));
      assert.ok(warnings.every((line) => !line.includes('AKIAFAKESECRETKEY')));
      assert.ok(warnings.every((line) => !line.includes('alice@example.com')));

      fail = false;
      const retried = await terms.maybeNotifyTermsUpdated(cara);
      assert.equal(retried.sent, true);
      assert.equal(cara.termsNotifiedHash, current.plainTextSha256);
      assert.ok(cara.termsNotifiedAt);
    } finally {
      console.warn = orig;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('two overlapping sign-ins send one message for that hash', async () => {
    const doc = getTermsDocument();
    const member = person('overlap', 'overlap@example.com');
    const store = memoryStore([member]);
    const mailer = createMailer({ captureEmail: true, allowCaptureMailer: true });
    const realSend = mailer.send.bind(mailer);
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let entered = 0;
    mailer.send = async (msg) => {
      entered += 1;
      await gate;
      return realSend(msg);
    };
    const terms = createTermsService({
      store,
      mailer,
      config: { publicBaseUrl: 'https://vote.example' },
      getDocument: () => doc,
    });
    const pending = Promise.all([
      terms.maybeNotifyTermsUpdated(member),
      terms.maybeNotifyTermsUpdated(member),
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(entered, 1);
    release();
    const [left, right] = await pending;
    const sent = [left, right].filter((row) => row.sent);
    assert.equal(sent.length, 1);
    assert.equal(updatedMessages(mailer).length, 1);
    assert.equal(member.termsNotifiedHash, doc.plainTextSha256);
  });
});

describe('terms notice on sign-in', () => {
  let tmp;
  let app;
  let store;
  let mailer;
  let server;
  let base;
  let failTerms = false;
  const warnings = [];
  let origWarn;

  function applyCookies(res, cookieJar) {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const c of list) {
      const pair = c.split(';')[0];
      const i = pair.indexOf('=');
      if (i === -1) continue;
      cookieJar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
    }
  }

  function cookieHeader(cookieJar) {
    return Object.entries(cookieJar)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  async function api(method, url, { body, jar: cookieJar } = {}) {
    const res = await fetch(base + url, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(cookieJar ? { cookie: cookieHeader(cookieJar) } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (cookieJar) applyCookies(res, cookieJar);
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { res, json, text, status: res.status };
  }

  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'republic-terms-signin-'));
    const createdMailer = createMailer({ captureEmail: true, allowCaptureMailer: true });
    const realSend = createdMailer.send.bind(createdMailer);
    createdMailer.send = async (msg) => {
      if (failTerms && msg?.meta?.purpose === 'terms-updated') {
        throw new Error('ses down for new-member@example.com AKIAFAKESECRETKEY');
      }
      return realSend(msg);
    };
    mailer = createdMailer;
    const created = await createApp({
      dataDir: tmp,
      allowDevLogin: true,
      requireEmailMfa: true,
      adminHandle: 'admin',
      quiet: true,
      port: 0,
      publicBaseUrl: 'https://vote.example.test',
      disclosureIntervalSeconds: 0,
      mailer,
    });
    app = created.app;
    store = created.store;
    server = await new Promise((resolve, reject) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
      listening.on('error', reject);
    });
    base = `http://127.0.0.1:${server.address().port}`;
    origWarn = console.warn;
    console.warn = (...args) => {
      warnings.push(args.map(String).join(' '));
    };
  });

  after(async () => {
    console.warn = origWarn;
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await rm(tmp, { recursive: true, force: true });
  });

  test('GET /health and /api/terms publish the plain-text hash', async () => {
    const health = await api('GET', '/health');
    assert.equal(health.status, 200);
    assert.equal(health.json.ok, true);
    const terms = await api('GET', '/api/terms');
    assert.equal(terms.status, 200);
    const doc = getTermsDocument();
    assert.equal(terms.json.plainTextSha256, doc.plainTextSha256);
    assert.equal(terms.json.markdownSha256, doc.plainTextSha256);
  });

  test('a new account is notified once on first sign-in and not again', async () => {
    const doc = getTermsDocument();
    store.createUser({ handle: 'new-member', role: 'voter', email: 'new-member@example.com' });
    const jar = {};
    const login = await api('POST', '/api/auth/dev-login', {
      body: { handle: 'new-member', role: 'voter' },
      jar,
    });
    assert.equal(login.status, 200, login.text);
    assert.equal(login.json.verified, true);
    assert.ok(jar['republic.sid']);
    assert.equal(login.json.user.termsNotifiedHash, doc.plainTextSha256);
    assert.ok(login.json.user.termsNotifiedAt);
    const stamped = login.json.user.termsNotifiedAt;
    const mine = updatedMessages(mailer).filter((row) => row.to === 'new-member@example.com');
    assert.equal(mine.length, 1);
    assert.equal(mine[0].subject, 'Republic Terms of Use were updated');
    assert.match(mine[0].text, /https:\/\/vote\.example\.test\/terms/);
    assert.match(mine[0].text, new RegExp(doc.plainTextSha256));
    assert.equal(mine[0].attachments.length, 1);
    assert.equal(mine[0].attachments[0].contentType, 'application/pdf');
    assert.equal(mine[0].attachments[0].sha256, doc.pdfSha256);
    assert.equal(mine[0].meta.purpose, 'terms-updated');
    assert.equal(mailer.vendor, 'ses');

    const second = await api('POST', '/api/auth/dev-login', {
      body: { handle: 'new-member' },
      jar,
    });
    assert.equal(second.status, 200, second.text);
    assert.equal(second.json.user.termsNotifiedAt, stamped);
    assert.equal(updatedMessages(mailer).filter((row) => row.to === 'new-member@example.com').length, 1);

    const disk = JSON.parse(await readFile(path.join(tmp, 'republic.json'), 'utf8'));
    const row = disk.users.find((user) => user.handle === 'new-member');
    assert.equal(row.termsNotifiedHash, doc.plainTextSha256);
    assert.equal(row.termsNotifiedAt, stamped);
    assert.ok(disk.meta.version >= 8);
  });

  test('unchanged hash does not send; a different stored hash does', async () => {
    const doc = getTermsDocument();
    const same = store.createUser({ handle: 'unchanged-member', role: 'voter', email: 'unchanged@example.com' });
    same.termsNotifiedHash = doc.plainTextSha256;
    same.termsNotifiedAt = '2026-01-01T00:00:00.000Z';
    await store.persist();
    const before = updatedMessages(mailer).length;
    const login = await api('POST', '/api/auth/dev-login', {
      body: { handle: 'unchanged-member' },
    });
    assert.equal(login.status, 200, login.text);
    assert.equal(login.json.user.termsNotifiedHash, doc.plainTextSha256);
    assert.equal(login.json.user.termsNotifiedAt, '2026-01-01T00:00:00.000Z');
    assert.equal(updatedMessages(mailer).length, before);

    const moved = store.createUser({ handle: 'changed-member', role: 'voter', email: 'changed@example.com' });
    moved.termsNotifiedHash = 'ab'.repeat(32);
    moved.termsNotifiedAt = '2026-01-01T00:00:00.000Z';
    await store.persist();
    const next = await api('POST', '/api/auth/dev-login', {
      body: { handle: 'changed-member' },
    });
    assert.equal(next.status, 200, next.text);
    assert.equal(next.json.user.termsNotifiedHash, doc.plainTextSha256);
    assert.notEqual(next.json.user.termsNotifiedAt, '2026-01-01T00:00:00.000Z');
    const mailed = updatedMessages(mailer).filter((row) => row.to === 'changed@example.com');
    assert.equal(mailed.length, 1);
    assert.equal(mailed[0].meta.plainTextSha256, doc.plainTextSha256);
  });

  test('email sign-in still succeeds when the terms message fails, then retries once', async () => {
    const doc = getTermsDocument();
    store.createUser({ handle: 'retry-member', role: 'voter', email: 'retry-member@example.com' });
    const jar = {};
    failTerms = true;
    warnings.length = 0;
    const start = await api('POST', '/api/auth/email/start', {
      body: { email: 'retry-member@example.com' },
      jar,
    });
    assert.equal(start.status, 200, start.text);
    assert.equal(start.json.mfaRequired, true);
    const code = mailer.lastOtp()?.code;
    assert.ok(code);
    const verify = await api('POST', '/api/auth/mfa/verify', {
      body: { code },
      jar,
    });
    assert.equal(verify.status, 200, verify.text);
    assert.equal(verify.json.verified, true);
    assert.equal(verify.json.user.handle, 'retry-member');
    assert.equal(verify.json.user.termsNotifiedHash, null);
    assert.equal(verify.json.user.termsNotifiedAt, null);
    assert.ok(jar['republic.sid']);
    assert.equal(updatedMessages(mailer).filter((row) => row.to === 'retry-member@example.com').length, 0);
    assert.ok(warnings.some((line) => line.includes('userId=') && line.includes('reason=send_failed')));
    assert.ok(warnings.every((line) => !line.includes('retry-member@example.com')));
    assert.ok(warnings.every((line) => !line.includes('AKIAFAKESECRETKEY')));

    await api('POST', '/api/auth/logout', { jar });
    failTerms = false;
    const again = await api('POST', '/api/auth/email/start', {
      body: { email: 'retry-member@example.com' },
      jar,
    });
    assert.equal(again.status, 200, again.text);
    const secondCode = mailer.lastOtp()?.code;
    const done = await api('POST', '/api/auth/mfa/verify', {
      body: { code: secondCode },
      jar,
    });
    assert.equal(done.status, 200, done.text);
    assert.equal(done.json.user.termsNotifiedHash, doc.plainTextSha256);
    assert.ok(done.json.user.termsNotifiedAt);
    assert.equal(updatedMessages(mailer).filter((row) => row.to === 'retry-member@example.com').length, 1);

    await api('POST', '/api/auth/logout', { jar });
    const third = await api('POST', '/api/auth/email/start', {
      body: { email: 'retry-member@example.com' },
      jar,
    });
    const thirdCode = mailer.lastOtp()?.code;
    const quiet = await api('POST', '/api/auth/mfa/verify', {
      body: { code: thirdCode },
      jar,
    });
    assert.equal(quiet.status, 200, quiet.text);
    assert.equal(updatedMessages(mailer).filter((row) => row.to === 'retry-member@example.com').length, 1);
    assert.equal(third.status, 200);
  });

  test('a member with no email signs in and is not marked notified', async () => {
    const before = updatedMessages(mailer).length;
    const login = await api('POST', '/api/auth/dev-login', {
      body: { handle: 'no-mail-member', role: 'voter' },
    });
    assert.equal(login.status, 200, login.text);
    assert.equal(login.json.user.termsNotifiedHash, null);
    assert.equal(login.json.user.termsNotifiedAt, null);
    assert.equal(updatedMessages(mailer).length, before);
  });
});

describe('terms notice store migration', () => {
  test('an older republic.json gains null notice fields and version 8', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'republic-terms-migrate-'));
    await writeFile(
      path.join(dir, 'republic.json'),
      JSON.stringify({
        meta: { nfp: true, app: 'zk-voting', version: 7, nextElectionId: 1 },
        users: [
          {
            id: 'old-1',
            handle: 'old-member',
            role: 'voter',
            createdAt: '2026-01-01T00:00:00.000Z',
            credentials: [],
          },
        ],
      }),
      'utf8',
    );
    const store = await Store.open({ dataDir: dir, adminHandle: 'admin' });
    const user = store.getUserByHandle('old-member');
    assert.equal(user.termsNotifiedHash, null);
    assert.equal(user.termsNotifiedAt, null);
    assert.ok(store.data.meta.version >= 8);
    const disk = JSON.parse(await readFile(path.join(dir, 'republic.json'), 'utf8'));
    const row = disk.users.find((item) => item.handle === 'old-member');
    assert.equal(row.termsNotifiedHash, null);
    assert.equal(row.termsNotifiedAt, null);
    assert.ok(disk.meta.version >= 8);
    await rm(dir, { recursive: true, force: true });
  });
});

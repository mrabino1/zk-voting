// NOT FOR PROFIT — civic public good, not a commercial product.
// Regression tests for the web security review: constant-time secret compare,
// open redirects, prototype-key smuggling, and credentialed CORS.

import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { canonicalPublicPath, safeNextPath } from '../public/audience.js';
import { credentialedOrigins } from '../src/corsPolicy.mjs';
import { parseCookies, stripBallotPii } from '../src/http.mjs';
import { stripReceiptChoice } from '../src/receipts.mjs';
import { relayTokenPollBallot } from '../src/relay.mjs';
import { secretsEqual } from '../src/secureCompare.mjs';
import { createApp } from '../src/server.mjs';

describe('secretsEqual', () => {
  test('matches only identical non-empty secrets', () => {
    assert.equal(secretsEqual('s3cret-value', 's3cret-value'), true);
    assert.equal(secretsEqual('s3cret-value', 's3cret-valuE'), false);
    assert.equal(secretsEqual('s3cret-value', 's3cret'), false);
    assert.equal(secretsEqual('s3cret', 's3cret-value-longer'), false);
    assert.equal(secretsEqual('', ''), false);
    assert.equal(secretsEqual('x', ''), false);
    assert.equal(secretsEqual(undefined, undefined), false);
    assert.equal(secretsEqual(null, 'x'), false);
  });
});

describe('redirect path safety', () => {
  test('canonicalPublicPath never yields a protocol-relative path', () => {
    assert.equal(canonicalPublicPath('//evil.example/x.html'), '/evil.example/x');
    assert.equal(canonicalPublicPath('///evil.example/x'), '/evil.example/x');
    assert.equal(canonicalPublicPath('/\\evil.example/x.html'), '/evil.example/x');
    assert.equal(canonicalPublicPath('\\\\evil.example'), '/evil.example');
    assert.equal(canonicalPublicPath('/admin.html'), '/admin');
    assert.equal(canonicalPublicPath('/index.html'), '/');
    assert.equal(canonicalPublicPath('/about/?a=1#h'), '/about?a=1#h');
  });

  test('safeNextPath rejects control characters that browsers strip', () => {
    assert.equal(safeNextPath('/\t/evil.example'), null);
    assert.equal(safeNextPath('/%09/evil.example'), null);
    assert.equal(safeNextPath('/\n/evil.example'), null);
    assert.equal(safeNextPath('/%0d%0a/evil.example'), null);
    assert.equal(safeNextPath('/\u007f/evil.example'), null);
    assert.equal(safeNextPath('/admin'), '/admin');
    assert.equal(safeNextPath('/elections/abc?tab=1'), '/elections/abc?tab=1');
  });
});

describe('prototype keys from untrusted JSON', () => {
  const smuggled = () => JSON.parse('{"choice":1,"__proto__":{"nullifier":"0xabc","pin":"1234"}}');

  test('relayTokenPollBallot does not inherit banned identity keys', () => {
    const out = relayTokenPollBallot(smuggled());
    assert.equal(Object.getPrototypeOf(out), Object.prototype);
    assert.equal(out.nullifier, undefined);
    assert.equal(out.pin, undefined);
    assert.equal(out.choice, 1);
  });

  test('stripBallotPii and stripReceiptChoice keep a plain prototype', () => {
    for (const fn of [stripBallotPii, stripReceiptChoice]) {
      const out = fn(JSON.parse('{"a":1,"__proto__":{"x":2},"constructor":{"y":3},"nested":{"__proto__":{"z":4}}}'));
      assert.equal(Object.getPrototypeOf(out), Object.prototype);
      assert.equal(Object.getPrototypeOf(out.nested), Object.prototype);
      assert.equal(out.x, undefined);
      assert.equal(out.nested.z, undefined);
      assert.equal(out.constructor, Object);
      assert.equal(out.a, 1);
    }
  });

  test('parseCookies ignores a __proto__ cookie name', () => {
    const jar = parseCookies('__proto__=x; sid=abc');
    assert.equal(Object.getPrototypeOf(jar), Object.prototype);
    assert.equal(jar.sid, 'abc');
    assert.equal(Object.hasOwn(jar, '__proto__'), false);
  });
});

describe('credentialed CORS allowlist', () => {
  test('collects WebAuthn origins, public base URL, and operator extras', () => {
    const set = credentialedOrigins({
      origins: ['https://vote.example.org', 'not a url'],
      publicBaseUrl: 'https://vote.example.org/path',
      corsOrigins: 'https://ops.example.org, ',
    });
    assert.deepEqual([...set].sort(), ['https://ops.example.org', 'https://vote.example.org']);
  });
});

let tmp;
let server;
let port;

function rawGet(pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res));
    });
    req.on('error', reject);
    req.end();
  });
}

function rawOptions(pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'OPTIONS', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('HTTP: redirects and CORS', () => {
  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-sec-'));
    const created = await createApp({
      dataDir: tmp,
      allowDevLogin: true,
      adminHandle: 'admin',
      quiet: true,
      port: 0,
      disclosureIntervalSeconds: 0,
    });
    server = await new Promise((resolve, reject) => {
      const s = created.app.listen(0, '127.0.0.1', () => resolve(s));
      s.on('error', reject);
    });
    port = server.address().port;
  });

  after(async () => {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await rm(tmp, { recursive: true, force: true });
  });

  test('.html clean-URL redirect stays on this origin', async () => {
    for (const p of ['//evil.example/x.html', '/%2F/evil.example/x.html', '/\\evil.example/x.html']) {
      const res = await rawGet(p);
      const location = res.headers.location;
      if (location === undefined) continue;
      assert.ok(location.startsWith('/'), `${p} -> ${location}`);
      assert.ok(!/^[/\\]{2}/.test(location), `${p} redirected off-site to ${location}`);
    }
    const ok = await rawGet('/admin.html');
    assert.equal(ok.statusCode, 301);
    assert.equal(ok.headers.location, '/admin');
  });

  test('untrusted origins can read public API but get no credentials', async () => {
    const res = await rawOptions('/api/elections', {
      origin: 'https://evil.example',
      'access-control-request-method': 'POST',
    });
    assert.equal(res.headers['access-control-allow-origin'], 'https://evil.example');
    assert.equal(res.headers['access-control-allow-credentials'], undefined);
  });

  test('trusted local origin keeps credentialed CORS', async () => {
    const res = await rawOptions('/api/elections', {
      origin: 'http://localhost:5173',
      'access-control-request-method': 'POST',
    });
    assert.equal(res.headers['access-control-allow-origin'], 'http://localhost:5173');
    assert.equal(res.headers['access-control-allow-credentials'], 'true');
  });
});

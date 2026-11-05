// NOT FOR PROFIT — civic public good, not a commercial product.
// Registration verification uses the authenticator data: challenge, origin,
// RP ID hash, and the user-verification flag. A public key beside the
// attestation is not what gets stored.

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { isoBase64URL, isoCBOR } from '@simplewebauthn/server/helpers';

import { createApp } from '../src/server.mjs';

const tmps = [];
const servers = [];

after(async () => {
  for (const server of servers) await new Promise((resolve) => server.close(() => resolve()));
  for (const dir of tmps) await rm(dir, { recursive: true, force: true });
});

function b64(bytes) {
  return isoBase64URL.fromBuffer(bytes);
}

function coseP256() {
  const x = randomBytes(32);
  const y = randomBytes(32);
  const encoded = isoCBOR.encode(
    new Map([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, x],
      [-3, y],
    ]),
  );
  return { x, y, encoded: Uint8Array.from(encoded) };
}

function authenticatorData({ rpID, credId, flags, cose }) {
  const rpIdHash = createHash('sha256').update(rpID).digest();
  const cred = Buffer.from(credId);
  const coseBytes = Buffer.from(cose);
  const out = Buffer.alloc(55 + cred.length + coseBytes.length);
  rpIdHash.copy(out, 0);
  out[32] = flags;
  out.writeUInt16BE(cred.length, 53);
  cred.copy(out, 55);
  coseBytes.copy(out, 55 + cred.length);
  return new Uint8Array(out);
}

function attestationBody({ rpID, origin, challenge, credId, flags, cose, decoy }) {
  const authData = authenticatorData({ rpID, credId, flags, cose });
  const attestationObject = isoCBOR.encode(
    new Map([
      ['fmt', 'none'],
      ['attStmt', new Map()],
      ['authData', authData],
    ]),
  );
  const id = b64(credId);
  return {
    id,
    rawId: id,
    type: 'public-key',
    publicKey: decoy,
    response: {
      clientDataJSON: b64(
        Buffer.from(
          JSON.stringify({
            type: 'webauthn.create',
            challenge,
            origin,
            crossOrigin: false,
          }),
        ),
      ),
      attestationObject: b64(attestationObject),
      transports: ['internal'],
    },
  };
}

async function boot() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zk-webauthn-'));
  tmps.push(dir);
  const created = await createApp({
    dataDir: dir,
    adminHandle: 'admin',
    superAdminEmail: '',
    quiet: true,
    port: 0,
    disclosureIntervalSeconds: 0,
    requireEmailMfa: false,
    setupToken: 'attestation-setup-token',
  });
  const server = await new Promise((resolve, reject) => {
    const listening = created.app.listen(0, '127.0.0.1', () => resolve(listening));
    listening.on('error', reject);
  });
  servers.push(server);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  async function api(method, url, { body, headers } = {}) {
    const res = await fetch(base + url, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(headers || {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, json, text };
  }
  return { ...created, api, origin: base };
}

test('none attestation is verified and the stored key comes from authenticator data', async () => {
  const { api, store, origin } = await boot();
  const headers = { 'x-setup-token': 'attestation-setup-token' };
  const begin = await api('POST', '/api/setup/admin/begin', {
    headers,
    body: { handle: 'admin', acceptedTerms: true },
  });
  assert.equal(begin.status, 200, begin.text);
  assert.equal(begin.json.authenticatorSelection.residentKey, 'required');
  assert.equal(begin.json.authenticatorSelection.userVerification, 'required');
  assert.equal(begin.json.rp.id, 'localhost');
  assert.deepEqual(
    begin.json.pubKeyCredParams.map((param) => param.alg),
    [-48, -49, -7, -8, -257],
  );

  const credId = randomBytes(16);
  const cose = coseP256();
  const ok = await api('POST', '/api/setup/admin/finish', {
    headers,
    body: {
      handle: 'admin',
      ...attestationBody({
        rpID: 'localhost',
        origin,
        challenge: begin.json.challenge,
        credId,
        flags: 0x45,
        cose: cose.encoded,
        decoy: 'decoy-client-supplied-key',
      }),
    },
  });
  assert.equal(ok.status, 200, ok.text);
  const admin = store.data.users.find((user) => user.role === 'platform_super_admin');
  assert.equal(admin.credentials.length, 1);
  assert.equal(admin.credentials[0].coseAlg, -7);
  assert.equal(admin.credentials[0].coseAlgBackfilled, undefined);
  assert.notEqual(admin.credentials[0].publicKey, 'decoy-client-supplied-key');
  const decoded = isoCBOR.decodeFirst(Buffer.from(admin.credentials[0].publicKey, 'base64url'));
  const x = decoded instanceof Map ? decoded.get(-2) : decoded[-2];
  assert.equal(Buffer.from(x).equals(cose.x), true);

  const badOrigin = await api('POST', '/api/setup/admin/begin', {
    headers,
    body: { handle: 'other-admin', acceptedTerms: true },
  });
  assert.equal(badOrigin.status, 409, 'the claim already closed setup');
});

test('wrong origin, challenge, rpId hash, and a missing UV flag are rejected', async () => {
  const { api, store, origin } = await boot();
  const headers = { 'x-setup-token': 'attestation-setup-token' };

  async function begin() {
    const response = await api('POST', '/api/setup/admin/begin', {
      headers,
      body: { handle: 'admin', acceptedTerms: true },
    });
    assert.equal(response.status, 200, response.text);
    return response.json.challenge;
  }

  async function finish(body) {
    return api('POST', '/api/setup/admin/finish', { headers, body: { handle: 'admin', ...body } });
  }

  const cose = coseP256();
  const credId = randomBytes(16);
  const challenge = await begin();
  const wrongOrigin = await finish(
    attestationBody({
      rpID: 'localhost',
      origin: 'https://evil.example',
      challenge,
      credId,
      flags: 0x45,
      cose: cose.encoded,
      decoy: 'decoy-client-supplied-key',
    }),
  );
  assert.equal(wrongOrigin.status, 400, wrongOrigin.text);

  const challengeForClient = await begin();
  const wrongChallenge = await finish(
    attestationBody({
      rpID: 'localhost',
      origin,
      challenge: 'not-the-server-challenge',
      credId,
      flags: 0x45,
      cose: cose.encoded,
      decoy: 'decoy-client-supplied-key',
    }),
  );
  assert.equal(challengeForClient.length > 0, true);
  assert.equal(wrongChallenge.status, 400, wrongChallenge.text);

  const challengeForRp = await begin();
  const wrongRp = await finish(
    attestationBody({
      rpID: 'evil.example',
      origin,
      challenge: challengeForRp,
      credId: randomBytes(16),
      flags: 0x45,
      cose: cose.encoded,
      decoy: 'decoy-client-supplied-key',
    }),
  );
  assert.equal(wrongRp.status, 400, wrongRp.text);

  const challengeForUv = await begin();
  const noUv = await finish(
    attestationBody({
      rpID: 'localhost',
      origin,
      challenge: challengeForUv,
      credId: randomBytes(16),
      flags: 0x41,
      cose: cose.encoded,
      decoy: 'decoy-client-supplied-key',
    }),
  );
  assert.equal(noUv.status, 400, noUv.text);
  assert.match(noUv.text, /user verification/i);

  const admin = store.data.users.find((user) => user.role === 'platform_super_admin');
  assert.equal(admin.credentials.length, 0);
  assert.equal(JSON.stringify(admin).includes('decoy-client-supplied-key'), false);
});

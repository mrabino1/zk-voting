// NOT FOR PROFIT — civic public good, not a commercial product.
// COSE algorithm preference, backfill for credentials that predate it, and
// authentication of an existing ES256 passkey. ML-DSA is verified by the
// WebAuthn library or rejected with the missing runtime. It is not faked.

import assert from 'node:assert/strict';
import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

import {
  browserSupportsPasskeys,
  browserSupportsWebAuthn,
  getBrowserCapabilities,
  sendSignal,
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser';
import { SettingsService } from '@simplewebauthn/server';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import pg from 'pg';

import { MIGRATIONS, closePools, migrate, rollbackMigration } from '../src/db.mjs';
import {
  ES256_COSE_ALG,
  PASSKEY_SCHEMA_VERSION,
  PASSKEY_SUPPORTED_ALGORITHM_IDS,
  migratePasskeyCoseAlgs,
  rollbackPasskeyCoseAlgs,
  stampCredentialAlg,
} from '../src/passkeyAlgorithms.mjs';
import { createApp } from '../src/server.mjs';

const tmps = [];

after(async () => {
  await closePools();
  for (const dir of tmps) await rm(dir, { recursive: true, force: true });
});

function listen(application) {
  return new Promise((resolve, reject) => {
    const server = application.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

async function boot(dir) {
  const created = await createApp({
    dataDir: dir,
    allowDevLogin: true,
    adminHandle: 'admin',
    quiet: true,
    port: 0,
    disclosureIntervalSeconds: 0,
    requireEmailMfa: false,
  });
  const server = await listen(created.app);
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    ...created,
    server,
    base,
    async close() {
      try {
        created.writer?.release();
      } catch {
        /* lease already released */
      }
      await new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}

function applyCookies(res, jar) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const cookie of list) {
    const pair = cookie.split(';')[0];
    const i = pair.indexOf('=');
    if (i === -1) continue;
    jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
}

async function api(base, method, url, { body, jar } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(jar && Object.keys(jar).length ? { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
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

function coseKey(pairs) {
  return Buffer.from(isoCBOR.encode(new Map(pairs))).toString('base64url');
}

function es256Key() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const encoded = coseKey([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, Buffer.from(jwk.x, 'base64url')],
    [-3, Buffer.from(jwk.y, 'base64url')],
  ]);
  return { privateKey, publicKey: encoded };
}

function ed25519PublicKey() {
  return coseKey([
    [1, 1],
    [3, -8],
    [-1, 6],
    [-2, randomBytes(32)],
  ]);
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
  return out;
}

function signedAssertion({ privateKey, rpID, origin, challenge, credentialId, counter = 0 }) {
  const rpIdHash = createHash('sha256').update(rpID).digest();
  const authData = Buffer.alloc(37);
  rpIdHash.copy(authData, 0);
  authData[32] = 0x05;
  authData.writeUInt32BE(counter, 33);
  const clientDataJSON = Buffer.from(
    JSON.stringify({
      type: 'webauthn.get',
      challenge,
      origin,
      crossOrigin: false,
    }),
  );
  const signer = createSign('SHA256');
  signer.update(Buffer.concat([authData, createHash('sha256').update(clientDataJSON).digest()]));
  signer.end();
  return {
    id: credentialId,
    rawId: credentialId,
    type: 'public-key',
    response: {
      clientDataJSON: clientDataJSON.toString('base64url'),
      authenticatorData: authData.toString('base64url'),
      signature: signer.sign(privateKey).toString('base64url'),
    },
  };
}

test('registration prefers ML-DSA-44 and ML-DSA-65, then current device algorithms', () => {
  assert.deepEqual([...PASSKEY_SUPPORTED_ALGORITHM_IDS], [-48, -49, -7, -8, -257]);
  assert.equal(ES256_COSE_ALG, -7);
});

test('@simplewebauthn/browser v14 ceremony helpers load', async () => {
  assert.equal(typeof startRegistration, 'function');
  assert.equal(typeof startAuthentication, 'function');
  assert.equal(typeof browserSupportsPasskeys, 'function');
  assert.equal(typeof getBrowserCapabilities, 'function');
  assert.equal(typeof sendSignal, 'function');
  assert.equal(browserSupportsWebAuthn(), false);
  assert.equal(await browserSupportsPasskeys(), false);
});

test('JSON backfill reads the COSE key, assumes ES256 when it cannot, and rolls back', () => {
  const data = {
    meta: { version: 9 },
    users: [
      {
        credentials: [
          { id: 'ed', publicKey: ed25519PublicKey(), counter: 0 },
          { id: 'kept', publicKey: 'not-cose', coseAlg: -49, counter: 0 },
          { id: 'unknown', publicKey: 'not-cose', counter: 0 },
        ],
      },
    ],
  };
  migratePasskeyCoseAlgs(data);
  assert.equal(data.meta.version, PASSKEY_SCHEMA_VERSION);
  assert.equal(data.users[0].credentials[0].coseAlg, -8);
  assert.equal(data.users[0].credentials[0].coseAlgBackfilled, true);
  assert.equal(data.users[0].credentials[1].coseAlg, -49);
  assert.equal(data.users[0].credentials[1].coseAlgBackfilled, undefined);
  assert.equal(data.users[0].credentials[2].coseAlg, -7);
  assert.equal(data.users[0].credentials[2].coseAlgBackfilled, true);
  const once = JSON.parse(JSON.stringify(data));
  migratePasskeyCoseAlgs(data);
  assert.deepEqual(data, once);

  const assumed = { id: 'sql', publicKey: ed25519PublicKey(), coseAlg: -7, coseAlgBackfilled: true };
  stampCredentialAlg(assumed);
  assert.equal(assumed.coseAlg, -8);
  assert.equal(assumed.coseAlgBackfilled, true);

  rollbackPasskeyCoseAlgs(data);
  assert.equal(data.meta.version, PASSKEY_SCHEMA_VERSION - 1);
  assert.equal(data.users[0].credentials[0].coseAlg, undefined);
  assert.equal(data.users[0].credentials[0].coseAlgBackfilled, undefined);
  assert.equal(data.users[0].credentials[1].coseAlg, -49);
  assert.equal(data.users[0].credentials[2].coseAlg, undefined);
  rollbackPasskeyCoseAlgs(data);
  assert.equal(data.users[0].credentials[1].coseAlg, -49);
  migratePasskeyCoseAlgs(data);
  assert.equal(data.users[0].credentials[0].coseAlg, -8);
  assert.equal(data.users[0].credentials[2].coseAlg, -7);
});

test('an existing ES256 passkey still authenticates after the algorithm backfill', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zk-cose-auth-'));
  tmps.push(dir);
  const { privateKey, publicKey } = es256Key();
  const credentialId = Buffer.from(randomBytes(16)).toString('base64url');
  const first = await boot(dir);
  let second;
  let third;
  const user = first.store.createUser({ handle: 'legacy-voter', role: 'voter' });
  user.credentials.push({
    id: credentialId,
    publicKey,
    counter: 0,
    transports: ['internal'],
    createdAt: '2020-01-01T00:00:00.000Z',
  });
  user.credentials.push({
    id: 'explicit-mldsa',
    publicKey: 'not-cose',
    coseAlg: -49,
    counter: 0,
  });
  await first.store.persist();
  await first.close();

  second = await boot(dir);
  try {
  const stored = second.store.getUserByHandle('legacy-voter');
  const legacy = stored.credentials.find((cred) => cred.id === credentialId);
  const explicit = stored.credentials.find((cred) => cred.id === 'explicit-mldsa');
  assert.equal(legacy.coseAlg, -7);
  assert.equal(legacy.coseAlgBackfilled, true);
  assert.equal(explicit.coseAlg, -49);
  assert.equal(explicit.coseAlgBackfilled, undefined);
  assert.equal(second.store.data.meta.version, PASSKEY_SCHEMA_VERSION);

  const jar = {};
  const origin = second.base;
  const begin = await api(origin, 'POST', '/api/auth/passkey/login/begin', {
    body: { handle: 'legacy-voter' },
  });
  assert.equal(begin.status, 200, begin.text);
  const finish = await api(origin, 'POST', '/api/auth/passkey/login/finish', {
    jar,
    body: signedAssertion({
      privateKey,
      rpID: 'localhost',
      origin,
      challenge: begin.json.challenge,
      credentialId,
    }),
  });
  assert.equal(finish.status, 200, finish.text);
  assert.ok(jar['zk-voting.sid']);
  const listed = await api(origin, 'GET', '/api/me/passkeys', { jar });
  assert.equal(listed.status, 200, listed.text);
  const mine = listed.json.passkeys.find((row) => row.credentialId === credentialId);
  assert.equal(mine.coseAlg, -7);
  assert.equal(mine.coseAlgBackfilled, undefined);

  rollbackPasskeyCoseAlgs(second.store.data);
  await second.store.persist();
  assert.equal(second.store.getUserByHandle('legacy-voter').credentials.find((c) => c.id === credentialId).coseAlg, undefined);
  const again = await api(origin, 'POST', '/api/auth/passkey/login/begin', {
    body: { handle: 'legacy-voter' },
  });
  const still = await api(origin, 'POST', '/api/auth/passkey/login/finish', {
    jar,
    body: signedAssertion({
      privateKey,
      rpID: 'localhost',
      origin,
      challenge: again.json.challenge,
      credentialId,
    }),
  });
  assert.equal(still.status, 200, still.text);
  } finally {
    await second?.close();
  }

  third = await boot(dir);
  try {
  assert.equal(
    third.store.getUserByHandle('legacy-voter').credentials.find((c) => c.id === credentialId).coseAlg,
    -7,
  );
  assert.equal(
    third.store.getUserByHandle('legacy-voter').credentials.find((c) => c.id === 'explicit-mldsa').coseAlg,
    -49,
  );
  } finally {
    await third?.close();
  }
});

test('ML-DSA is verified by the library or rejected with the missing WebCrypto algorithm', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zk-cose-pqc-'));
  tmps.push(dir);
  const node = await boot(dir);
  try {
  const begin = await api(node.base, 'POST', '/api/auth/passkey/register/begin', {
    body: { handle: 'pq-voter', acceptedTerms: true },
  });
  assert.equal(begin.status, 200, begin.text);
  assert.deepEqual(
    begin.json.pubKeyCredParams.map((param) => param.alg),
    [-48, -49, -7, -8, -257],
  );

  const credId = randomBytes(16);
  const cose = Buffer.from(
    isoCBOR.encode(
      new Map([
        [1, 7],
        [3, -48],
        [-1, randomBytes(32)],
      ]),
    ),
  );
  const authData = authenticatorData({ rpID: 'localhost', credId, flags: 0x45, cose });
  const attestationObject = isoCBOR.encode(
    new Map([
      ['fmt', 'none'],
      ['attStmt', new Map()],
      ['authData', authData],
    ]),
  );
  const id = Buffer.from(credId).toString('base64url');
  const finish = await api(node.base, 'POST', '/api/auth/passkey/register/finish', {
    body: {
      handle: 'pq-voter',
      id,
      rawId: id,
      type: 'public-key',
      response: {
        clientDataJSON: Buffer.from(
          JSON.stringify({
            type: 'webauthn.create',
            challenge: begin.json.challenge,
            origin: node.base,
            crossOrigin: false,
          }),
        ).toString('base64url'),
        attestationObject: Buffer.from(attestationObject).toString('base64url'),
        transports: ['internal'],
      },
    },
  });

  if (!SettingsService.runtimeSupportsPQC()) {
    assert.equal(finish.status, 400, finish.text);
    assert.match(finish.text, /WebCrypto\.subtle does not support use of ML-DSA-44/);
    assert.match(finish.text, /24\.7\.0/);
    assert.match(finish.text, new RegExp(process.version.replace(/[.]/g, '\\.')));
    assert.match(finish.text, /No substitute verifier is used/);
    assert.equal(node.store.getUserByHandle('pq-voter'), null);
  } else {
    assert.equal(finish.status, 200, finish.text);
    assert.equal(node.store.getUserByHandle('pq-voter').credentials[0].coseAlg, -48);
    const login = await api(node.base, 'POST', '/api/auth/passkey/login/begin', {
      body: { handle: 'pq-voter' },
    });
    assert.equal(login.status, 200, login.text);
    const forged = await api(node.base, 'POST', '/api/auth/passkey/login/finish', {
      body: {
        id,
        rawId: id,
        type: 'public-key',
        response: {
          clientDataJSON: Buffer.from(
            JSON.stringify({
              type: 'webauthn.get',
              challenge: login.json.challenge,
              origin: node.base,
              crossOrigin: false,
            }),
          ).toString('base64url'),
          authenticatorData: Buffer.alloc(37, 0).toString('base64url'),
          signature: Buffer.from('00', 'hex').toString('base64url'),
        },
      },
    });
    assert.equal(forged.status, 400, forged.text);
  }
  } finally {
    await node.close();
  }
});

const pgUrl = process.env.TEST_DATABASE_URL || '';

describe('postgres passkey algorithm migration', { skip: pgUrl ? false : 'TEST_DATABASE_URL unset' }, () => {
  after(async () => {
    await closePools();
  });

  test('migration 3 backfill is idempotent and rolls back', async () => {
    const client = new pg.Client({ connectionString: pgUrl });
    await client.connect();
    try {
    await client.query(
      'DROP TABLE IF EXISTS zkv_schema_migrations, zkv_collections, zkv_rows, zkv_writer, zkv_secrets, zkv_imports',
    );
    await closePools();
    const edKey = ed25519PublicKey();
    const first = await migrate({ databaseUrl: pgUrl }, { quiet: true });
    assert.deepEqual(first.applied, MIGRATIONS.map((row) => row.version));

    const user = {
      id: 'user-1',
      credentials: [
        { id: 'missing', publicKey: edKey, counter: 0 },
        { id: 'kept', publicKey: 'not-cose', coseAlg: -49, counter: 0 },
      ],
    };
    await client.query(
      `INSERT INTO zkv_rows (ns, collection, key, pos, doc) VALUES ('store', 'users', '0', 0, $1::jsonb)`,
      [JSON.stringify(user)],
    );

    const undone = await rollbackMigration({ databaseUrl: pgUrl }, 3, { quiet: true });
    assert.equal(undone.rolledBack, true);
    const again = await migrate({ databaseUrl: pgUrl }, { quiet: true });
    assert.deepEqual(again.applied, [3]);
    await closePools();
    const repeat = await migrate({ databaseUrl: pgUrl }, { quiet: true });
    assert.deepEqual(repeat.applied, []);

    const filled = await client.query(`SELECT doc FROM zkv_rows WHERE ns = 'store' AND collection = 'users'`);
    const creds = filled.rows[0].doc.credentials;
    assert.equal(creds.find((c) => c.id === 'missing').coseAlg, -7);
    assert.equal(creds.find((c) => c.id === 'missing').coseAlgBackfilled, true);
    assert.equal(creds.find((c) => c.id === 'kept').coseAlg, -49);
    assert.equal(creds.find((c) => c.id === 'kept').coseAlgBackfilled, undefined);

    const corrected = creds.find((c) => c.id === 'missing');
    stampCredentialAlg(corrected);
    assert.equal(corrected.coseAlg, -8);
    assert.equal(corrected.coseAlgBackfilled, true);

    const rolled = await rollbackMigration({ databaseUrl: pgUrl }, 3, { quiet: true });
    assert.equal(rolled.rolledBack, true);
    const twice = await rollbackMigration({ databaseUrl: pgUrl }, 3, { quiet: true });
    assert.equal(twice.rolledBack, false);
    const after = await client.query(`SELECT doc FROM zkv_rows WHERE ns = 'store' AND collection = 'users'`);
    const afterCreds = after.rows[0].doc.credentials;
    assert.equal(afterCreds.find((c) => c.id === 'missing').coseAlg, undefined);
    assert.equal(afterCreds.find((c) => c.id === 'missing').coseAlgBackfilled, undefined);
    assert.equal(afterCreds.find((c) => c.id === 'kept').coseAlg, -49);

    const restored = await migrate({ databaseUrl: pgUrl }, { quiet: true });
    assert.deepEqual(restored.applied, [3]);
    const finalDoc = await client.query(`SELECT doc FROM zkv_rows WHERE ns = 'store' AND collection = 'users'`);
    assert.equal(finalDoc.rows[0].doc.credentials.find((c) => c.id === 'missing').coseAlg, -7);
    assert.equal(finalDoc.rows[0].doc.credentials.find((c) => c.id === 'kept').coseAlg, -49);
    } finally {
      await client.end();
    }
  });
});

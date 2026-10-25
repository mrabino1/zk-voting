// NOT FOR PROFIT — civic public good, not a commercial product.
// Postgres backend for app state. Runs only when TEST_DATABASE_URL points at a
// scratch database (its zkv_* tables are dropped and recreated).

import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

import pg from 'pg';

import { createApp } from '../src/server.mjs';
import { MIGRATIONS, closePools, migrate } from '../src/db.mjs';

const url = process.env.TEST_DATABASE_URL || '';

function listen(application) {
  return new Promise((resolve, reject) => {
    const s = application.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
}

async function boot(dataDir, extra = {}) {
  const created = await createApp({
    dataDir,
    allowDevLogin: true,
    adminHandle: 'admin',
    quiet: true,
    port: 0,
    disclosureIntervalSeconds: 0,
    publicBaseUrl: 'http://vote.test',
    ...extra,
  });
  const server = await listen(created.app);
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = async () => {
    await new Promise((resolve) => server.close(() => resolve()));
    try {
      created.writer?.release();
    } catch {
      /* already released */
    }
  };
  return { ...created, server, base, close };
}

async function devLogin(base, handle, role = 'voter') {
  const res = await fetch(`${base}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle, role }),
  });
  assert.equal(res.status, 200, `dev-login ${handle}`);
  const cookie = (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  return cookie;
}

describe('postgres app state', { skip: url ? false : 'TEST_DATABASE_URL unset' }, () => {
  const tmps = [];
  const client = url ? new pg.Pool({ connectionString: url }) : null;

  async function tmp() {
    const d = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-pg-'));
    tmps.push(d);
    return d;
  }

  after(async () => {
    await closePools();
    await client?.end();
    for (const d of tmps) await rm(d, { recursive: true, force: true });
  });

  test('migrations are idempotent', async () => {
    await client.query(
      'DROP TABLE IF EXISTS zkv_schema_migrations, zkv_collections, zkv_rows, zkv_writer, zkv_secrets, zkv_imports',
    );
    await closePools();
    const first = await migrate({ databaseUrl: url }, { quiet: true });
    assert.deepEqual(first.applied, MIGRATIONS.map((m) => m.version));
    await closePools();
    const second = await migrate({ databaseUrl: url }, { quiet: true });
    assert.deepEqual(second.applied, []);
    const { rows } = await client.query("SELECT tablename FROM pg_tables WHERE tablename LIKE 'zkv_%' ORDER BY 1");
    assert.deepEqual(
      rows.map((r) => r.tablename),
      ['zkv_collections', 'zkv_imports', 'zkv_rows', 'zkv_schema_migrations', 'zkv_secrets', 'zkv_writer'],
    );
  });

  let legacyDir;
  let legacySecret;
  let legacyNodeId;

  test('existing DATA_DIR JSON is imported once when the tables are empty', async () => {
    legacyDir = await tmp();
    // A JSON-era node writes zk-voting.json, l2-chain.json and receipt-pdf.secret.
    const legacy = await boot(legacyDir, { databaseUrl: '' });
    assert.equal(legacy.store.backend, 'json');
    await devLogin(legacy.base, 'legacy-ada');
    legacySecret = legacy.config.receiptPdfSecret;
    legacyNodeId = legacy.store.data.meta.nodeId;
    await legacy.store.persist();
    await legacy.close();
    const files = await readdir(legacyDir);
    assert.ok(files.includes('zk-voting.json'));
    assert.ok(files.includes('receipt-pdf.secret'));

    const node = await boot(legacyDir, { databaseUrl: url });
    assert.equal(node.store.backend, 'postgres');
    assert.ok(node.store.getUserByHandle('legacy-ada'), 'imported user');
    assert.equal(node.store.data.meta.nodeId, legacyNodeId);
    assert.equal(node.config.receiptPdfSecret, legacySecret, 'receipt secret imported');
    const imports = await client.query('SELECT source FROM zkv_imports ORDER BY source');
    assert.ok(imports.rows.some((r) => r.source.endsWith('zk-voting.json')));
    const health = await fetch(`${node.base}/health`);
    assert.equal(health.status, 200);
    const body = await health.json();
    assert.equal(body.ok, true);
    assert.equal(body.db.backend, 'postgres');
    assert.equal(body.db.ok, true);
    await node.close();
  });

  test('state survives a restart with an empty DATA_DIR (no volume)', async () => {
    const dirA = await tmp();
    const a = await boot(dirA, { databaseUrl: url });
    const cookie = await devLogin(a.base, 'pg-bob');
    const key = await fetch(`${a.base}/api/me/api-keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'persist-check', level: 'read' }),
    });
    assert.equal(key.status, 201);
    const sessions = a.store.data.sessions.length;
    const heightBefore = a.explorer.chain.blocks.length;
    await a.close();

    // Fresh container: new empty DATA_DIR, same database.
    const dirB = await tmp();
    const b = await boot(dirB, { databaseUrl: url });
    assert.ok(b.store.getUserByHandle('legacy-ada'));
    assert.ok(b.store.getUserByHandle('pg-bob'));
    assert.equal(b.store.data.sessions.length, sessions);
    assert.ok(b.store.data.apiKeys.some((k) => k.name === 'persist-check'));
    assert.equal(b.explorer.chain.blocks.length, heightBefore);
    assert.equal(b.config.receiptPdfSecret, legacySecret);
    // The session cookie issued by the old container still works.
    const me = await fetch(`${b.base}/api/me`, { headers: { cookie } });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).user?.handle, 'pg-bob');
    assert.deepEqual(await readdir(dirB).then((f) => f.filter((n) => n.endsWith('.json'))), []);
    // Import is not repeated once the tables hold data.
    const imports = await client.query("SELECT count(*)::int AS n FROM zkv_imports WHERE source LIKE '%zk-voting.json'");
    assert.equal(imports.rows[0].n, 1);
    await b.close();
  });

  test('an older writer is fenced off after a newer one opens', async () => {
    const a = await boot(await tmp(), { databaseUrl: url });
    const b = await boot(await tmp(), { databaseUrl: url });
    a.store.data.meta.fenceProbe = 'from-a';
    await assert.rejects(() => a.store.persist(), (err) => err.status === 503 && err.extra?.code === 'STALE_FENCE');
    b.store.data.meta.fenceProbe = 'from-b';
    await b.store.persist();
    await a.close();
    await b.close();
    const c = await boot(await tmp(), { databaseUrl: url });
    assert.equal(c.store.data.meta.fenceProbe, 'from-b');
    await c.close();
  });
});

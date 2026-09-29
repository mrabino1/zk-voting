// NOT FOR PROFIT — civic public good, not a commercial product.
// Two Node processes on one data directory: the standby answers health and
// refuses mutations until the active writer releases the lease.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

import { createApp } from '../src/server.mjs';

function listen(application) {
  return new Promise((resolve, reject) => {
    const server = application.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

async function close(server) {
  if (!server) return;
  await new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe('node rolling handover', () => {
  const temps = [];
  const servers = [];

  after(async () => {
    for (const server of servers) await close(server);
    for (const dir of temps) await rm(dir, { recursive: true, force: true });
  });

  test('standby health is ready, mutations return 503, then promotion writes once', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'republic-node-lease-'));
    temps.push(tmp);
    const first = await createApp({
      dataDir: tmp,
      allowDevLogin: true,
      quiet: true,
      port: 0,
      disclosureIntervalSeconds: 0,
      leaseOwnerId: 'node-active',
    });
    const second = await createApp({
      dataDir: tmp,
      allowDevLogin: true,
      quiet: true,
      port: 0,
      disclosureIntervalSeconds: 0,
      leaseOwnerId: 'node-standby',
    });
    const active = await listen(first.app);
    const standby = await listen(second.app);
    servers.push(active, standby);
    const activeBase = `http://127.0.0.1:${active.address().port}`;
    const standbyBase = `http://127.0.0.1:${standby.address().port}`;

    const activeHealth = await fetch(activeBase + '/health');
    const activeBody = await activeHealth.json();
    assert.equal(activeHealth.status, 200);
    assert.equal(activeBody.ok, true);
    assert.equal(activeBody.mode, 'active');
    assert.equal(activeBody.acceptingWrites, true);

    const standbyHealth = await fetch(standbyBase + '/health');
    const standbyBody = await standbyHealth.json();
    assert.equal(standbyHealth.status, 200);
    assert.equal(standbyBody.ok, true);
    assert.equal(standbyBody.ready, true);
    assert.equal(standbyBody.mode, 'standby');
    assert.equal(standbyHealth.headers.get('x-republic-mode'), 'standby');

    const denied = await fetch(standbyBase + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const deniedBody = await denied.json();
    assert.equal(denied.status, 503);
    assert.equal(denied.headers.get('retry-after'), '2');
    assert.equal(deniedBody.error, 'maintenance handover');
    assert.equal(deniedBody.code, 'STANDBY');

    const block = {
      hash: '0x' + 'ab'.repeat(32),
      number: 1,
      timestamp: 10,
      transactions: [
        {
          hash: '0x' + 'cd'.repeat(32),
          civicType: 'register',
          civic: { type: 'register', electionId: '1', identityCommitment: '0xabc' },
        },
      ],
    };
    const imported = await first.explorer.ingest({ block, source: 'republic-l2' }, 10, 0);
    assert.equal(imported.duplicate, false);
    const again = await first.explorer.ingest({ block, source: 'republic-l2' }, 10, 0);
    assert.equal(again.duplicate, true);
    assert.equal(again.imported, 0);
    await assert.rejects(
      () => second.explorer.ingest({ block, source: 'republic-l2' }, 10, 0),
      /maintenance handover/,
    );

    first.writer.release();
    assert.equal(second.writer.tryPromote(), true);
    await second.store.reloadFromDisk();
    second.store.writerActive = true;
    await second.explorer.refresh();
    second.explorer.writerActive = true;
    const promoted = await fetch(standbyBase + '/health');
    const promotedBody = await promoted.json();
    assert.equal(promoted.status, 200);
    assert.equal(promotedBody.mode, 'active');
    const allowed = await fetch(standbyBase + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.notEqual(allowed.status, 503);
  });
});

// NOT FOR PROFIT — civic public good, not a commercial product.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

import { getConfig, resolveSuperAdminEmail } from '../src/config.mjs';
import { createApp } from '../src/server.mjs';
import { Store } from '../src/store.mjs';

function superAdmin(store) {
  const users = store.listUsers().filter((user) => user.role === 'platform_super_admin');
  assert.equal(users.length, 1);
  return users[0];
}

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), 'republic-super-email-'));
}

describe('SUPER_ADMIN_EMAIL', () => {
  const dirs = [];

  after(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  test('seed sets contactEmail from the env', async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const store = await Store.open({
      dataDir: dir,
      adminHandle: 'admin',
      superAdminEmail: 'Operator@Example.Gov',
      quiet: true,
    });
    const user = superAdmin(store);
    assert.equal(user.handle, 'admin');
    assert.equal(user.contactEmail, 'operator@example.gov');
    assert.equal(store.listUsers().length, 1);
  });

  test('second boot is idempotent', async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const first = await Store.open({
      dataDir: dir,
      adminHandle: 'admin',
      superAdminEmail: 'ops@example.gov',
      quiet: true,
    });
    const id = superAdmin(first).id;
    const second = await Store.open({
      dataDir: dir,
      adminHandle: 'admin',
      superAdminEmail: 'ops@example.gov',
      quiet: true,
    });
    const user = superAdmin(second);
    assert.equal(user.id, id);
    assert.equal(user.contactEmail, 'ops@example.gov');
    assert.equal(second.listUsers().length, 1);
  });

  test('a changed env updates contactEmail on the same user', async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const first = await Store.open({
      dataDir: dir,
      adminHandle: 'admin',
      superAdminEmail: 'first@example.gov',
      quiet: true,
    });
    const id = superAdmin(first).id;
    const second = await Store.open({
      dataDir: dir,
      adminHandle: 'admin',
      superAdminEmail: 'Second@Example.Gov',
      quiet: true,
    });
    const user = superAdmin(second);
    assert.equal(user.id, id);
    assert.equal(user.contactEmail, 'second@example.gov');
    assert.equal(second.listUsers().length, 1);
  });

  test('does not create a second user when a super admin already exists', async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const first = await Store.open({ dataDir: dir, adminHandle: 'clerk', quiet: true });
    const id = superAdmin(first).id;
    const second = await Store.open({
      dataDir: dir,
      adminHandle: 'admin',
      superAdminEmail: 'ops@example.gov',
      quiet: true,
    });
    const user = superAdmin(second);
    assert.equal(user.id, id);
    assert.equal(user.handle, 'clerk');
    assert.equal(user.contactEmail, 'ops@example.gov');
    assert.equal(second.listUsers().length, 1);
  });

  test('empty env leaves an existing contactEmail alone', async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const first = await Store.open({ dataDir: dir, adminHandle: 'admin', quiet: true });
    const user = superAdmin(first);
    user.contactEmail = 'kept@example.gov';
    await first.persist();
    const cleared = await Store.open({
      dataDir: dir,
      adminHandle: 'admin',
      superAdminEmail: '',
      quiet: true,
    });
    assert.equal(superAdmin(cleared).contactEmail, 'kept@example.gov');
    const omitted = await Store.open({ dataDir: dir, adminHandle: 'admin', quiet: true });
    assert.equal(superAdmin(omitted).contactEmail, 'kept@example.gov');
    const blank = await Store.open({
      dataDir: dir,
      adminHandle: 'admin',
      superAdminEmail: '   ',
      quiet: true,
    });
    assert.equal(superAdmin(blank).contactEmail, 'kept@example.gov');
    assert.equal(blank.listUsers().length, 1);
  });

  test('invalid env fails closed and does not log the address', async () => {
    const bad = 'secret.admin@example.gov extra';
    assert.throws(
      () => resolveSuperAdminEmail(bad),
      (err) => {
        assert.match(err.message, /SUPER_ADMIN_EMAIL/);
        assert.match(err.message, /Refusing to start/);
        assert.equal(err.message.includes(bad), false);
        assert.equal(err.message.includes('secret.admin@example.gov'), false);
        return true;
      },
    );
    assert.throws(() => getConfig({ superAdminEmail: 'not-an-email' }), /SUPER_ADMIN_EMAIL/);
    assert.equal(resolveSuperAdminEmail(''), '');
    assert.equal(resolveSuperAdminEmail('   '), '');
    assert.equal(getConfig({ superAdminEmail: '' }).superAdminEmail, '');

    const dir = await tempDir();
    dirs.push(dir);
    await assert.rejects(() => Store.open({ dataDir: dir, superAdminEmail: bad, quiet: true }), /SUPER_ADMIN_EMAIL/);
    await assert.rejects(readFile(path.join(dir, 'republic.json'), 'utf8'), (err) => err.code === 'ENOENT');

    const seeded = await Store.open({
      dataDir: dir,
      superAdminEmail: 'kept@example.gov',
      quiet: true,
    });
    assert.equal(superAdmin(seeded).contactEmail, 'kept@example.gov');
    await assert.rejects(
      () => Store.open({ dataDir: dir, superAdminEmail: 'not-an-email', quiet: true }),
      /Refusing to start/,
    );
    const still = await Store.open({ dataDir: dir, quiet: true });
    assert.equal(superAdmin(still).contactEmail, 'kept@example.gov');

    const appDir = await tempDir();
    dirs.push(appDir);
    await assert.rejects(
      () =>
        createApp({
          dataDir: appDir,
          superAdminEmail: bad,
          port: 0,
          quiet: true,
          writerLease: false,
        }),
      (err) => {
        assert.match(err.message, /SUPER_ADMIN_EMAIL/);
        assert.equal(err.message.includes(bad), false);
        return true;
      },
    );
  });

  test('info log masks the address', async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const lines = [];
    const orig = console.info;
    console.info = (...args) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      await Store.open({
        dataDir: dir,
        superAdminEmail: 'Operator@Example.Gov',
        quiet: false,
      });
    } finally {
      console.info = orig;
    }
    const blob = lines.join('\n');
    assert.match(blob, /o\*\*\*@example\.gov/);
    assert.equal(blob.includes('operator@example.gov'), false);
    assert.equal(blob.includes('Operator@Example.Gov'), false);
  });

  test('standby does not mutate; the new writer applies the env', async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const first = await createApp({
      dataDir: dir,
      adminHandle: 'admin',
      superAdminEmail: 'writer@example.gov',
      quiet: true,
      port: 0,
      leaseOwnerId: 'node-active',
    });
    try {
      assert.equal(first.writer.mode(), 'active');
      assert.equal(superAdmin(first.store).contactEmail, 'writer@example.gov');
      const before = await readFile(path.join(dir, 'republic.json'), 'utf8');

      const second = await createApp({
        dataDir: dir,
        adminHandle: 'admin',
        superAdminEmail: 'standby@example.gov',
        quiet: true,
        port: 0,
        leaseOwnerId: 'node-standby',
      });
      try {
        assert.equal(second.writer.mode(), 'standby');
        assert.equal(second.store.writerActive, false);
        assert.equal(superAdmin(second.store).contactEmail, 'writer@example.gov');
        assert.equal(second.store.listUsers().length, 1);
        const after = await readFile(path.join(dir, 'republic.json'), 'utf8');
        assert.equal(after, before);

        const refused = await second.store.adoptSuperAdminEmail(second.config);
        assert.equal(refused, false);
        assert.equal(superAdmin(second.store).contactEmail, 'writer@example.gov');
        assert.equal(await readFile(path.join(dir, 'republic.json'), 'utf8'), before);

        first.writer.release();
        assert.equal(second.writer.tryPromote(), true);
        await second.store.reloadFromDisk();
        second.store.writerActive = true;
        second.config.writerActive = true;
        const changed = await second.store.adoptSuperAdminEmail(second.config);
        assert.equal(changed, true);
        assert.equal(superAdmin(second.store).contactEmail, 'standby@example.gov');
        assert.equal(second.store.listUsers().length, 1);
        const disk = JSON.parse(await readFile(path.join(dir, 'republic.json'), 'utf8'));
        const stored = disk.users.filter((user) => user.role === 'platform_super_admin');
        assert.equal(stored.length, 1);
        assert.equal(stored[0].contactEmail, 'standby@example.gov');
        assert.equal(stored[0].id, superAdmin(first.store).id);
      } finally {
        second.writer?.release();
      }
    } finally {
      first.writer?.release();
    }
  });
});

describe('SUPER_ADMIN_EMAIL env', { concurrency: false }, () => {
  test('getConfig reads the process environment and an override wins', () => {
    const prev = process.env.SUPER_ADMIN_EMAIL;
    try {
      process.env.SUPER_ADMIN_EMAIL = 'Env.Admin@Example.Gov';
      assert.equal(getConfig().superAdminEmail, 'env.admin@example.gov');
      assert.equal(getConfig({ superAdminEmail: 'other@example.gov' }).superAdminEmail, 'other@example.gov');
      assert.equal(getConfig({ superAdminEmail: '' }).superAdminEmail, '');
      process.env.SUPER_ADMIN_EMAIL = '   ';
      assert.equal(getConfig().superAdminEmail, '');
      process.env.SUPER_ADMIN_EMAIL = 'not-an-email';
      assert.throws(
        () => getConfig(),
        (err) => {
          assert.match(err.message, /SUPER_ADMIN_EMAIL/);
          assert.equal(err.message.includes('not-an-email'), false);
          return true;
        },
      );
    } finally {
      if (prev === undefined) delete process.env.SUPER_ADMIN_EMAIL;
      else process.env.SUPER_ADMIN_EMAIL = prev;
    }
  });
});

// NOT FOR PROFIT — civic public good, not a commercial product.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import { getConfig, normalizeVoteFqdn } from '../src/config.mjs';
import { createApp } from '../src/server.mjs';

describe('VOTE_FQDN', () => {
  test('accepts a bare voting hostname and rejects URLs, ports, and addresses', () => {
    assert.equal(normalizeVoteFqdn(' vote.domain.tld. '), 'vote.domain.tld');
    assert.equal(normalizeVoteFqdn('Vote.Example.GOV'), 'vote.example.gov');
    assert.equal(normalizeVoteFqdn(''), '');
    assert.equal(normalizeVoteFqdn('   '), '');
    for (const bad of [
      'https://vote.domain.tld',
      'vote.domain.tld:443',
      'vote.domain.tld/path',
      'localhost',
      '1.2.3.4',
      'not a host',
    ]) {
      assert.throws(() => normalizeVoteFqdn(bad), /VOTE_FQDN/);
    }
  });

  test('the FQDN is the voting authority when RP id is still localhost', () => {
    const cfg = getConfig({
      voteFqdn: 'vote.domain.tld',
      rpID: 'localhost',
      origins: ['http://localhost:3000', 'http://127.0.0.1:3000'],
      publicBaseUrl: '',
    });
    assert.equal(cfg.voteFqdn, 'vote.domain.tld');
    assert.equal(cfg.rpID, 'vote.domain.tld');
    assert.equal(cfg.origins[0], 'https://vote.domain.tld');
    assert.ok(cfg.origins.includes('http://localhost:3000'));
    assert.equal(cfg.publicBaseUrl, 'https://vote.domain.tld');
  });

  test('an explicit public RP id and base URL are kept', () => {
    const cfg = getConfig({
      voteFqdn: 'vote.domain.tld',
      rpID: 'domain.tld',
      origins: ['https://vote.domain.tld'],
      publicBaseUrl: 'https://vote.domain.tld',
    });
    assert.equal(cfg.rpID, 'domain.tld');
    assert.deepEqual(cfg.origins, ['https://vote.domain.tld']);
    assert.equal(cfg.publicBaseUrl, 'https://vote.domain.tld');
  });

  test('an empty FQDN leaves the localhost demo alone', () => {
    const cfg = getConfig({
      voteFqdn: '',
      rpID: 'localhost',
      origins: ['http://localhost:3000'],
      publicBaseUrl: '',
    });
    assert.equal(cfg.voteFqdn, '');
    assert.equal(cfg.rpID, 'localhost');
    assert.deepEqual(cfg.origins, ['http://localhost:3000']);
    assert.equal(cfg.publicBaseUrl, '');
  });

  test('reads VOTE_FQDN from the environment', () => {
    const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { getConfig } from './src/config.mjs';
         const cfg = getConfig();
         if (cfg.voteFqdn !== 'vote.example.gov') process.exit(2);
         if (cfg.rpID !== 'vote.example.gov') process.exit(3);
         if (cfg.publicBaseUrl !== 'https://vote.example.gov') process.exit(4);
         if (cfg.origins[0] !== 'https://vote.example.gov') process.exit(5);`,
      ],
      {
        cwd: appRoot,
        env: {
          ...process.env,
          VOTE_FQDN: 'vote.example.gov',
          RP_ID: 'localhost',
          PUBLIC_BASE_URL: '',
          WEBAUTHN_ORIGINS: 'http://localhost:3000',
          NODE_ENV: 'test',
        },
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });

  test('GET /api/config and /health publish the voting hostname', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'republic-vote-fqdn-'));
    const created = await createApp({
      dataDir: tmp,
      voteFqdn: 'vote.domain.tld',
      rpID: 'localhost',
      publicBaseUrl: '',
      allowDevLogin: true,
      quiet: true,
      port: 0,
    });
    const server = await new Promise((resolve, reject) => {
      const listening = created.app.listen(0, '127.0.0.1', () => resolve(listening));
      listening.on('error', reject);
    });
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const health = await fetch(`${base}/health`).then((res) => res.json());
      assert.equal(health.voteFqdn, 'vote.domain.tld');
      const config = await fetch(`${base}/api/config`).then((res) => res.json());
      assert.equal(config.vote.fqdn, 'vote.domain.tld');
      assert.equal(config.vote.origin, 'https://vote.domain.tld');
      assert.equal(config.rpID, 'vote.domain.tld');
      assert.equal(config.origins[0], 'https://vote.domain.tld');
    } finally {
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

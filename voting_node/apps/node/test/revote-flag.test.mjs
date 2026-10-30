// NOT FOR PROFIT — civic public good, not a commercial product.
// ALLOW_REVOTE stays off until the inbox can store a replacement. A published
// block keeps the first ballot hash.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import { ALLOW_REVOTE_CHAIN_CONFIGURED, getConfig } from '../src/config.mjs';
import { createApp } from '../src/server.mjs';

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

function listen(application) {
  return new Promise((resolve, reject) => {
    const s = application.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
}

describe('ALLOW_REVOTE', () => {
  test('defaults off and is refused while a chain is configured', async () => {
    assert.equal(getConfig({ allowRevote: false }).allowRevote, false);
    assert.equal(getConfig({}).allowRevote, false);
    assert.equal(getConfig({ allowRevote: true }).allowRevote, true);
    assert.throws(
      () => getConfig({ allowRevote: true, chainRpc: 'http://127.0.0.1:8545' }),
      new RegExp(ALLOW_REVOTE_CHAIN_CONFIGURED.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-revote-chain-'));
    try {
      await assert.rejects(
        () =>
          createApp({
            dataDir: tmp,
            quiet: true,
            port: 0,
            allowRevote: true,
            chain: { isConfigured: () => true, isReady: () => false },
          }),
        /ALLOW_REVOTE cannot be on while a chain is configured/,
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('a replacement keeps the published block and the public ballot hash', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-revote-'));
    const adminJar = {};
    const created = await createApp({
      dataDir: tmp,
      allowDevLogin: true,
      adminHandle: 'admin',
      quiet: true,
      port: 0,
      allowRevote: true,
      disclosureIntervalSeconds: 0,
    });
    const server = await listen(created.app);
    const base = `http://127.0.0.1:${server.address().port}`;
    const api = async (method, url, { body, jar } = {}) => {
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
    };
    try {
      const cfg = await api('GET', '/api/config');
      assert.equal(cfg.json.allowRevote, true);
      await api('POST', '/api/auth/dev-login', {
        body: { handle: 'admin', role: 'platform_admin' },
        jar: adminJar,
      });
      const now = Math.floor(Date.now() / 1000);
      const election = await api('POST', '/api/elections', {
        jar: adminJar,
        body: {
          title: 'Revote poll',
          electionType: 'poll',
          startTime: now - 10,
          cutoffTime: now + 3600,
          treeDepth: 16,
          questions: [
            {
              type: 'YES_NO',
              prompt: 'Sample?',
              options: [
                { id: 'yes', label: 'Yes' },
                { id: 'no', label: 'No' },
              ],
            },
          ],
        },
      });
      assert.equal(election.status, 201, election.text);
      const id = election.json.id;
      const reg = await api('POST', `/api/elections/${id}/register`, {
        jar: adminJar,
        body: { identityCommitment: '0xca11' },
      });
      assert.equal(reg.status, 201, reg.text);
      const freeze = await api('POST', `/api/elections/${id}/freeze`, { jar: adminJar });
      assert.equal(freeze.status, 200, freeze.text);

      const first = await api('POST', `/api/elections/${id}/vote`, {
        body: {
          proof: { accept: true },
          publicInputs: { nullifier: '0xabc', electionId: id },
          encryptedBallot: '0x01',
          identityCommitment: '0xca11',
        },
      });
      assert.equal(first.status, 201, first.text);
      const publishedHash = first.json.vote.ballotHash;
      const blocks = JSON.stringify(created.explorer.chain.blocks);
      const txs = JSON.stringify(created.explorer.chain.txs);

      const second = await api('POST', `/api/elections/${id}/vote`, {
        body: {
          proof: { accept: true },
          publicInputs: { nullifier: '0xabc', electionId: id },
          encryptedBallot: '0x02',
          identityCommitment: '0xca11',
        },
      });
      assert.equal(second.status, 201, second.text);
      assert.equal(second.json.vote.ballotHash, publishedHash);
      assert.notEqual(second.json.receipt.ballotHash, publishedHash);
      assert.equal(JSON.stringify(second.json.vote).includes(second.json.receipt.ballotHash), false);
      assert.equal(JSON.stringify(created.explorer.chain.blocks), blocks);
      assert.equal(JSON.stringify(created.explorer.chain.txs), txs);

      const row = created.store.findVote(id, '0xabc');
      assert.equal(row.ballotHash, publishedHash);
      assert.equal(row.publishedBallotHash, publishedHash);
      assert.equal(created.store.requireElection(id).acceptedBallots, 1);
      assert.equal(created.store.listVotes(id).length, 1);
      const envelopes = created.store.listEnvelopes(id);
      assert.equal(envelopes.length, 1);
      assert.equal(envelopes[0].encryptedBallot, '0x01');
      assert.equal(envelopes[0].tallyEncryptedBallot, '0x02');

      const listed = await api('GET', `/api/elections/${id}/ballots`);
      assert.equal(listed.status, 200, listed.text);
      assert.equal(listed.json.ballots.length, 1);
      assert.equal(listed.json.ballots[0].ballotHash, publishedHash);
      assert.equal(listed.text.includes(second.json.receipt.ballotHash), false);

      const checked = await api('POST', '/api/receipts/verify', {
        body: { ballotHash: second.json.receipt.ballotHash, electionId: id },
      });
      assert.equal(checked.status, 200, checked.text);
      assert.equal(checked.json.counted, true);
      assert.equal(checked.json.ballotHash, publishedHash);
    } finally {
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

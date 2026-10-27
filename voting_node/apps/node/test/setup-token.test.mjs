// NOT FOR PROFIT — civic public good, not a commercial product.
// A generated setup token is announced only on the process log, and that
// log redacts it. Quiet test processes do not print it.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getConfig, parseHostSuffixes, resolveRequestWebAuthn } from '../src/config.mjs';
import { announceGeneratedSetupToken, resolveSetupToken } from '../src/setupToken.mjs';
import { recordLog, resetLogBuffer, tailLogs, watchSecrets } from '../src/superAdmin/logs.mjs';

test('an empty setup token is replaced; a configured one is kept', () => {
  const minted = resolveSetupToken('');
  assert.equal(minted.setupTokenGenerated, true);
  assert.equal(typeof minted.setupToken, 'string');
  assert.ok(minted.setupToken.length >= 16);
  const kept = resolveSetupToken('  operator-token-value  ');
  assert.equal(kept.setupTokenGenerated, false);
  assert.equal(kept.setupToken, 'operator-token-value');
});

test('announce writes a generated token once, and quiet processes skip it', () => {
  const quiet = [];
  assert.equal(
    announceGeneratedSetupToken(
      { setupTokenGenerated: true, setupToken: 'quiet-token-value', quiet: true },
      (line) => quiet.push(line),
    ),
    false,
  );
  assert.equal(quiet.length, 0);

  const lines = [];
  const token = 'unit-token-value-0123456789';
  assert.equal(
    announceGeneratedSetupToken(
      { setupTokenGenerated: true, setupToken: token, quiet: false },
      (line) => lines.push(line),
    ),
    true,
  );
  const blob = lines.join('');
  assert.equal(blob.split(token).length - 1, 1);
  assert.equal(blob.includes('one-time setup token'), true);
  assert.equal(blob.includes('not available over HTTP'), true);
});

test('a watched setup token is redacted from the diagnostic log', () => {
  resetLogBuffer();
  const token = resolveSetupToken('').setupToken;
  watchSecrets([token]);
  recordLog('info', `leak ${token}`);
  const message = tailLogs().lines.map((line) => line.message).join('\n');
  assert.equal(message.includes(token), false);
});

test('host suffixes reject schemes, ports, addresses, and single labels', () => {
  assert.deepEqual(
    parseHostSuffixes('https://zk-voting.org, localhost, zk-voting.org:443, 1.2.3.4, com, *.zk-voting.org, .zk-voting.org'),
    ['zk-voting.org'],
  );
});

test('RP ID and origins follow an allowed host and ignore an unknown one', () => {
  const demo = getConfig({
    voteFqdn: 'demo.zk-voting.org',
    rpID: 'localhost',
    origins: ['http://localhost:3000'],
    webauthnHostSuffixes: 'zk-voting.org',
    setupToken: 'configured-for-this-test',
  });
  assert.equal(demo.rpID, 'demo.zk-voting.org');
  assert.equal(demo.origins[0], 'https://demo.zk-voting.org');

  const rotating = resolveRequestWebAuthn(demo, {
    headers: { host: 'pr-99.zk-voting.org' },
    protocol: 'https',
  });
  assert.equal(rotating.rpID, 'pr-99.zk-voting.org');
  assert.equal(rotating.origins[0], 'https://pr-99.zk-voting.org');

  const parent = getConfig({
    voteFqdn: 'demo.zk-voting.org',
    rpID: 'zk-voting.org',
    webauthnHostSuffixes: '',
    setupToken: 'configured-for-this-test',
  });
  assert.equal(parent.rpID, 'zk-voting.org');
  const child = resolveRequestWebAuthn(parent, {
    headers: { host: 'pr-99.zk-voting.org' },
    protocol: 'https',
  });
  assert.equal(child.rpID, 'zk-voting.org');
  assert.ok(child.origins.includes('https://pr-99.zk-voting.org'));

  const evil = resolveRequestWebAuthn(parent, {
    headers: { host: 'evil.com' },
    protocol: 'https',
  });
  assert.equal(evil.rpID, parent.rpID);
  assert.equal(evil.origins.includes('https://evil.com'), false);

  const httpHost = resolveRequestWebAuthn(parent, {
    headers: { host: 'pr-99.zk-voting.org' },
    protocol: 'http',
  });
  assert.equal(httpHost.rpID, parent.rpID);
  assert.equal(httpHost.origins.includes('http://pr-99.zk-voting.org'), false);

  const dev = resolveRequestWebAuthn(getConfig({ setupToken: 'configured-for-this-test' }), {
    headers: { host: '127.0.0.1:3999' },
    protocol: 'http',
  });
  assert.equal(dev.rpID, 'localhost');
  assert.ok(dev.origins.includes('http://127.0.0.1:3999'));
});

// NOT FOR PROFIT — civic public good, not a commercial product.
// The node and chain-client BallotInbox ABIs must match the compiled contract.
// They are always checked against a committed, pinned ABI fixture; when forge is
// available the fixture is checked against the fresh forge artifact. In CI
// (CI=true) a missing forge is a failure, not a skip.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { decodeFunctionData, encodeFunctionData, toFunctionSelector } from 'viem';

import { ballotInboxAbi } from '../src/chain.mjs';

const require = createRequire(import.meta.url);
const { INBOX_ABI } = require('@zk-voting/chain-client');

const here = path.dirname(fileURLToPath(import.meta.url));
const contracts = path.resolve(here, '../../../../smart-contracts');
const artifactPath = path.join(contracts, 'out/BallotInbox.sol/BallotInbox.json');

function forgeBin() {
  for (const p of [process.env.FORGE_BIN, path.join(os.homedir(), '.foundry/bin/forge'), 'forge']) {
    if (!p) continue;
    try {
      execFileSync(p, ['--version'], { stdio: 'ignore' });
      return p;
    } catch {}
  }
  return null;
}

function loadArtifact() {
  if (!existsSync(artifactPath)) {
    const forge = forgeBin();
    if (!forge) return null;
    execFileSync(forge, ['build', '--via-ir'], { cwd: contracts, stdio: 'ignore' });
  }
  return existsSync(artifactPath) ? JSON.parse(readFileSync(artifactPath, 'utf8')) : null;
}

const fixture = JSON.parse(readFileSync(path.join(here, 'fixtures/ballot-inbox-abi.json'), 'utf8'));
const artifact = loadArtifact();
const inCi = process.env.CI === 'true';
const skipForge = artifact ? false : inCi ? false : 'forge artifacts unavailable (no forge on PATH)';

function sig(item) {
  return `${item.name}(${item.inputs.map((i) => i.type).join(',')})`;
}

test('forge artifact is available in CI and matches the pinned fixture', { skip: skipForge }, () => {
  assert.ok(artifact, 'CI=true but no forge artifact: install Foundry for this job');
  assert.deepEqual(fixture.methodIdentifiers, artifact.methodIdentifiers, 'pinned selectors drifted: regenerate test/fixtures/ballot-inbox-abi.json');
  assert.deepEqual(fixture.abi, artifact.abi, 'pinned ABI drifted: regenerate test/fixtures/ballot-inbox-abi.json');
});

for (const [label, abi] of [
  ['node ballotInboxAbi', ballotInboxAbi],
  ['chain-client INBOX_ABI', INBOX_ABI],
]) {
  test(`${label}: every function selector matches the pinned BallotInbox`, () => {
    const ids = fixture.methodIdentifiers;
    const bySig = new Map(Object.entries(ids));
    const fns = abi.filter((x) => x.type === 'function');
    assert.ok(fns.some((f) => f.name === 'submitVoteBatchRanked'));
    for (const f of fns) {
      const id = bySig.get(sig(f));
      assert.ok(id, `${sig(f)} is not a BallotInbox method`);
      assert.equal(toFunctionSelector(sig(f)), `0x${id}`, sig(f));
    }
  });
}

test('submitVoteBatchRanked selector is the documented signature', () => {
  const want = toFunctionSelector(
    'submitVoteBatchRanked(uint256,uint256[2][],uint256[2][2][],uint256[2][],uint256[][],bytes[],bytes32[])',
  );
  for (const abi of [ballotInboxAbi, INBOX_ABI]) {
    const f = abi.find((x) => x.name === 'submitVoteBatchRanked');
    assert.equal(toFunctionSelector(sig(f)), want);
  }
});

test('a real ranked batch encoded with the node ABI decodes with the pinned ABI', () => {
  const n = 3;
  const args = [
    7n,
    Array.from({ length: n }, (_, i) => [BigInt(i + 1), 2n]),
    Array.from({ length: n }, () => [[3n, 4n], [5n, 6n]]),
    Array.from({ length: n }, () => [7n, 8n]),
    Array.from({ length: n }, (_, i) => [11n, 12n, 13n + BigInt(i), 14n, 15n]),
    Array.from({ length: n }, (_, i) => `0x${'ab'.repeat(32 + i)}`),
    ['0x' + '01'.repeat(32), '0x' + '02'.repeat(32), '0x' + 'ff'.repeat(32)],
  ];
  const data = encodeFunctionData({ abi: ballotInboxAbi, functionName: 'submitVoteBatchRanked', args });
  assert.equal(data.slice(0, 10), `0x${fixture.methodIdentifiers[
    'submitVoteBatchRanked(uint256,uint256[2][],uint256[2][2][],uint256[2][],uint256[][],bytes[],bytes32[])'
  ]}`);
  const dec = decodeFunctionData({ abi: fixture.abi, data });
  assert.equal(dec.functionName, 'submitVoteBatchRanked');
  assert.deepEqual(dec.args[4], args[4]);
  assert.deepEqual(dec.args[6], args[6]);
  const viaClient = encodeFunctionData({ abi: INBOX_ABI, functionName: 'submitVoteBatchRanked', args });
  assert.equal(viaClient, data);
});

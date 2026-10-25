// NOT FOR PROFIT — civic public good, not a commercial product.
// L1 addresses are deployed once. A filled env var or a deployment record
// refuses another run unless FORCE_REDEPLOY=1.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

import {
  assessDeploy,
  formatEnvLines,
  verifyDeployedCode,
  writeDeploymentRecord,
  readDeploymentRecord,
} from '../../tools/deploy/l1Guard.mjs';

describe('one-time L1 deploy guard', () => {
  const temps = [];

  after(async () => {
    for (const dir of temps) await rm(dir, { recursive: true, force: true });
  });

  test('refuses when an address env var is set', () => {
    const decision = assessDeploy({
      env: { SETTLEMENT_ADDRESS: '0x1111111111111111111111111111111111111111' },
    });
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, 'address env already set');
    assert.deepEqual(decision.setKeys, ['SETTLEMENT_ADDRESS']);
  });

  test('refuses when a deployment record exists', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'republic-deploy-'));
    temps.push(tmp);
    const file = path.join(tmp, '1.json');
    writeDeploymentRecord(file, {
      deployed: true,
      chainId: '1',
      addresses: { VERIFIER_ADDRESS: '0x2222222222222222222222222222222222222222' },
    });
    const decision = assessDeploy({ env: {}, record: readDeploymentRecord(file) });
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, 'deployment record exists');
  });

  test('FORCE_REDEPLOY overrides and warns', () => {
    const decision = assessDeploy({
      env: {
        FORCE_REDEPLOY: '1',
        L1_TALLY_MIRROR_ADDRESS: '0x3333333333333333333333333333333333333333',
      },
    });
    assert.equal(decision.ok, true);
    assert.equal(decision.forced, true);
    assert.match(decision.warning, /FORCE_REDEPLOY=1 overrides an existing L1 deployment/);
  });

  test('empty address values do not count as a deploy', () => {
    const decision = assessDeploy({
      env: { SETTLEMENT_ADDRESS: '  ', ELECTION_FACTORY_ADDRESS: '' },
      record: { deployed: false, addresses: {} },
    });
    assert.equal(decision.ok, true);
    assert.equal(decision.forced, false);
  });

  test('verifyDeployedCode rejects an empty account and prints env lines', async () => {
    await assert.rejects(
      verifyDeployedCode('http://l1', '0xabc', async () => ({
        json: async () => ({ result: '0x' }),
      })),
      /no code at 0xabc/,
    );
    const code = await verifyDeployedCode('http://l1', '0xabc', async () => ({
      json: async () => ({ result: '0x1234' }),
    }));
    assert.equal(code, '0x1234');
    assert.equal(
      formatEnvLines({
        SETTLEMENT_ADDRESS: '0x1111111111111111111111111111111111111111',
        IGNORED: '0x0',
      }),
      'SETTLEMENT_ADDRESS=0x1111111111111111111111111111111111111111',
    );
  });
});

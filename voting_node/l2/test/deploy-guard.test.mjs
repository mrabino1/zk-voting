// NOT FOR PROFIT — civic public good, not a commercial product.
// ZkVotingRollup deploys once. A set ROLLUP_ADDRESS, or a record naming a rollup with code,
// refuses another deploy unless FORCE_REDEPLOY=1.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assessDeploy,
  deploymentRecordPath,
  formatEnvLines,
  recordRollup,
  verifyDeployedCode,
} from '../../tools/deploy/l1Guard.mjs';

const ROLLUP = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0';

test('refuses when ROLLUP_ADDRESS is set', () => {
  const decision = assessDeploy({ env: { ROLLUP_ADDRESS: ROLLUP } });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'ROLLUP_ADDRESS already set');
});

test('refuses when the record names a rollup that has code, not when the chain was wiped', () => {
  const record = { chainId: 1, rollup: ROLLUP };
  assert.equal(assessDeploy({ record, recordHasCode: true }).ok, false);
  assert.equal(assessDeploy({ record, recordHasCode: true }).reason, 'deployment record names a live rollup');
  assert.equal(assessDeploy({ record, recordHasCode: false }).ok, true);
  assert.equal(recordRollup({ rollup: 'nope' }), null);
});

test('FORCE_REDEPLOY overrides and warns; blank values do not count', () => {
  const forced = assessDeploy({ env: { FORCE_REDEPLOY: '1', ROLLUP_ADDRESS: ROLLUP } });
  assert.equal(forced.ok, true);
  assert.equal(forced.forced, true);
  assert.match(forced.warning, /deploys a second rollup/);
  const blank = assessDeploy({ env: { ROLLUP_ADDRESS: '  ' }, record: { rollup: '' } });
  assert.equal(blank.ok, true);
  assert.equal(blank.forced, false);
});

test('record paths, code check and env lines', async () => {
  assert.match(deploymentRecordPath('/sc', 31337), /deployments\/local\.json$/);
  assert.match(deploymentRecordPath('/sc', 1), /deployments\/1\.json$/);
  await assert.rejects(
    verifyDeployedCode('http://l1', '0xabc', async () => ({ json: async () => ({ result: '0x' }) })),
    /no code at 0xabc/,
  );
  assert.equal(
    await verifyDeployedCode('http://l1', '0xabc', async () => ({ json: async () => ({ result: '0x1234' }) })),
    '0x1234',
  );
  assert.equal(formatEnvLines({ rollup: ROLLUP, chainId: 1 }), `L1_CHAIN_ID=1\nROLLUP_ADDRESS=${ROLLUP}`);
});

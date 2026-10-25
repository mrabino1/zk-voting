// NOT FOR PROFIT — auditor pack for token polls, offline and with the mock chain.

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';

import { verifyPollBundle } from '../../../tools/auditor/verifyPoll.mjs';
import { freshAccount, login, startPollNode } from './poll-fixture.mjs';

async function talliedPack() {
  const fx = await startPollNode();
  const a = freshAccount();
  fx.chain.mint(a.address, 100n);
  fx.chain.mine({ timestamp: 1_700_000_050n });
  const admin = await login(fx.api, 'admin');
  const created = await fx.api('POST', '/api/polls', {
    jar: admin.jar,
    body: {
      title: 'Audit me',
      pollType: 'plurality',
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      startTime: fx.clock.t - 10,
      cutoffTime: fx.clock.t + 400,
      jurisdictionId: 'demo',
    },
  });
  const poll = created.json.poll;
  await fx.api('POST', `/api/polls/${poll.id}/schedule`, { jar: admin.jar });
  const typed = await fx.api(
    'GET',
    `/api/polls/${poll.id}/typed-data?address=${a.address}&choices=0&issuedAt=${fx.clock.t}`,
  );
  const message = {
    ...typed.json.typedData.message,
    republicChainId: BigInt(typed.json.typedData.message.republicChainId),
    issuedAt: BigInt(typed.json.typedData.message.issuedAt),
  };
  const sig = await a.signTypedData({
    domain: typed.json.typedData.domain,
    types: typed.json.typedData.types,
    primaryType: 'TokenPollBallot',
    message,
  });
  const cast = await fx.api('POST', `/api/polls/${poll.id}/ballots`, {
    body: { voter: a.address, choices: [0], sig, issuedAt: fx.clock.t },
  });
  assert.equal(cast.status, 201, cast.text);
  fx.chain.mine({ timestamp: BigInt(fx.clock.t + 400) });
  const close = await fx.chain.blockBeforeTimestamp(fx.clock.t + 400);
  fx.chain.finalizeThrough(close.number);
  fx.clock.t += 400;
  const tallied = await fx.api('POST', `/api/polls/${poll.id}/tally`, { jar: admin.jar });
  assert.equal(tallied.status, 200, tallied.text);
  const pack = await fx.api('GET', `/api/polls/${poll.id}/artifacts`);
  return { fx, bundle: pack.json };
}

describe('token poll auditor', () => {
  const stops = [];
  after(async () => {
    for (const stop of stops) await stop();
  });

  test('offline and rpc verification pass, and tampers fail', async () => {
    const { fx, bundle } = await talliedPack();
    stops.push(() => fx.stop());
    const offline = await verifyPollBundle(bundle, { offline: true });
    assert.equal(offline.ok, true, offline.errors.join('; '));
    const rpc = await verifyPollBundle(bundle, { offline: false, source: fx.chain });
    assert.equal(rpc.ok, true, rpc.errors.join('; '));

    const weight = structuredClone(bundle);
    weight.ballots[0].finalWeight = '1';
    weight.result.resultHash = `0x${'11'.repeat(32)}`;
    const badWeight = await verifyPollBundle(weight, { offline: false, source: fx.chain });
    assert.equal(badWeight.ok, false);

    const touched = structuredClone(bundle);
    touched.ballots[0].touchedBlocks = [999];
    const badTouch = await verifyPollBundle(touched, { offline: false, source: fx.chain });
    assert.equal(badTouch.ok, false);

    const sig = structuredClone(bundle);
    sig.ballots[0].sig = `0x${'ab'.repeat(65)}`;
    const badSig = await verifyPollBundle(sig, { offline: true });
    assert.equal(badSig.ok, false);

    const choice = structuredClone(bundle);
    choice.ballots[0].choices = ['b'];
    const badChoice = await verifyPollBundle(choice, { offline: true });
    assert.equal(badChoice.ok, false);

    const hash = structuredClone(bundle);
    hash.result.resultHash = `0x${'22'.repeat(32)}`;
    const badHash = await verifyPollBundle(hash, { offline: true });
    assert.equal(badHash.ok, false);

    const dup = structuredClone(bundle);
    dup.ballots.push({ ...dup.ballots[0] });
    const badDup = await verifyPollBundle(dup, { offline: true });
    assert.equal(badDup.ok, false);

    const dir = await mkdtemp(path.join(os.tmpdir(), 'republic-poll-auditor-'));
    const file = path.join(dir, 'pack.json');
    await writeFile(file, JSON.stringify(bundle));
    const cli = spawnSync(process.execPath, ['tools/auditor/cli.mjs', 'verify', '--file', file, '--offline'], {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)),
      encoding: 'utf8',
    });
    assert.equal(cli.status, 0, cli.stdout + cli.stderr);
    await rm(dir, { recursive: true, force: true });
  });
});

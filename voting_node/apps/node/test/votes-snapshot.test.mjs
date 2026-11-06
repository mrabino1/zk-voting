// NOT FOR PROFIT — delegated snapshot polls. Weight is getPastVotes, not a later balance.

import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import { verifySnapshotProof } from '../src/snapshotTree.mjs';
import { verifyPollBundle } from '../../../tools/auditor/verifyPoll.mjs';
import { freshAccount, login, startPollNode } from './poll-fixture.mjs';

const A_LABEL = { id: 'a', label: 'A' };
const B_LABEL = { id: 'b', label: 'B' };

describe('erc20_votes snapshot polls', () => {
  const stops = [];
  after(async () => {
    for (const stop of stops) await stop();
  });

  test('delegated power at the snapshot counts, and a later transfer does not', async () => {
    const fx = await startPollNode();
    stops.push(() => fx.stop());
    const holder = freshAccount();
    const delegate = freshAccount();
    const idle = freshAccount();
    fx.chain.mint(holder.address, 1000n);
    fx.chain.mint(idle.address, 50n);
    fx.chain.delegate(holder.address, delegate.address);
    const snap = fx.chain.mine({ timestamp: 1_700_000_050n });
    fx.chain.finalizeThrough(snap.number);

    const admin = await login(fx.api, 'admin');
    const created = await fx.api('POST', '/api/polls', {
      jar: admin.jar,
      body: {
        title: 'Delegated signal',
        pollType: 'plurality',
        weightSource: 'erc20_votes',
        options: [A_LABEL, B_LABEL],
        startTime: fx.clock.t - 10,
        cutoffTime: fx.clock.t + 400,
        jurisdictionId: 'demo',
      },
    });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.json.poll.weightSource, 'erc20_votes');
    assert.equal(created.json.poll.weightProof, 'poseidon_snapshot_v1');
    assert.equal(created.json.poll.snapshotRoot, null);
    const scheduled = await fx.api('POST', `/api/polls/${created.json.poll.id}/schedule`, { jar: admin.jar });
    assert.equal(scheduled.status, 200, scheduled.text);
    const poll = scheduled.json;
    assert.equal(poll.weightProof, 'poseidon_snapshot_v1');
    assert.equal(poll.snapshotBlock, Number(snap.number));
    assert.equal(poll.snapshotLeafCount, 1);
    assert.equal(fx.explorer.chain.txs && Object.values(fx.explorer.chain.txs).some((tx) => tx.type === 'poll_params' && tx.payload?.pollId === poll.id), false);

    const weight = await fx.api('GET', `/api/polls/${poll.id}/weight?address=${delegate.address}`);
    assert.equal(weight.json.votingPower, '1000');
    const holderWeight = await fx.api('GET', `/api/polls/${poll.id}/weight?address=${holder.address}`);
    assert.equal(holderWeight.json.votingPower, '0');
    const idleWeight = await fx.api('GET', `/api/polls/${poll.id}/weight?address=${idle.address}`);
    assert.equal(idleWeight.json.votingPower, '0');

    const no = await signAndCast(fx, poll, holder, [0]);
    assert.equal(no.status, 400, no.text);
    assert.equal(no.json.code, 'NO_POWER');
    const idleVote = await signAndCast(fx, poll, idle, [0]);
    assert.equal(idleVote.status, 400, idleVote.text);
    assert.equal(idleVote.json.code, 'NO_POWER');

    const yes = await signAndCast(fx, poll, delegate, [0]);
    assert.equal(yes.status, 201, yes.text);
    assert.equal(yes.json.receipt.provisionalWeight, '1000');

    fx.chain.transfer(holder.address, idle.address, 1000n);
    fx.chain.mine({ timestamp: 1_700_000_180n, finalized: true });
    const proof = await fx.api('GET', `/api/polls/${poll.id}/snapshot-proof?address=${delegate.address}`);
    assert.equal(proof.status, 200, proof.text);
    assert.equal(verifySnapshotProof(proof.json.proof), true);
    assert.equal(proof.json.proof.weight, '1000');

    const delegates = await fx.api('GET', `/api/polls/${poll.id}/delegates`);
    assert.equal(delegates.json.delegates.length, 1);
    assert.equal(delegates.json.delegates[0].delegators, 1);
    assert.equal(delegates.json.snapshotRoot, poll.snapshotRoot);

    fx.clock.t += 500;
    const close = fx.chain.mine({ timestamp: BigInt(fx.clock.t - 1), finalized: true });
    fx.chain.finalizeThrough(close.number);
    const tallyUser = await login(fx.api, 'tally1', 'tally_operator');
    const tallied = await fx.api('POST', `/api/polls/${poll.id}/tally`, { jar: tallyUser.jar });
    assert.equal(tallied.status, 200, tallied.text);
    assert.equal(tallied.json.participation, '1000');
    assert.equal(tallied.json.counts.a, '1000');
    assert.equal(tallied.json.snapshotRoot, poll.snapshotRoot);
    assert.equal(tallied.json.binding, false);
    const pack = await fx.api('GET', `/api/polls/${poll.id}/artifacts`);
    assert.equal(pack.json.snapshotLeaves.length, 1);
    assert.equal(pack.json.poll.weightSource, 'erc20_votes');
    assert.equal(JSON.stringify(pack.json).includes('userId'), false);
    const offline = await verifyPollBundle(pack.json, { offline: true });
    assert.equal(offline.ok, true, offline.errors.join('; '));
    const rpc = await verifyPollBundle(pack.json, { offline: false, source: fx.chain });
    assert.equal(rpc.ok, true, rpc.errors.join('; '));
  });

  test('a non-mainnet chain id is refused', async () => {
    const fx = await startPollNode({ votingTokenChainId: 10 });
    stops.push(() => fx.stop());
    const cfg = await fx.api('GET', '/api/config');
    assert.equal(cfg.json.pollsReady, false);
    assert.equal(cfg.json.votingToken.reason, 'not_ethereum_l1');
    assert.equal(cfg.json.votingToken.chainId, 1);
  });
});

async function signAndCast(fx, poll, account, choices) {
  const typed = await fx.api(
    'GET',
    `/api/polls/${poll.id}/typed-data?address=${account.address}&choices=${choices.join(',')}&issuedAt=${fx.clock.t}`,
  );
  assert.equal(typed.status, 200, typed.text);
  assert.equal(typed.json.typedData.message.snapshotRoot, poll.snapshotRoot);
  const message = {
    ...typed.json.typedData.message,
    zkVotingChainId: BigInt(typed.json.typedData.message.zkVotingChainId),
    issuedAt: BigInt(typed.json.typedData.message.issuedAt),
  };
  const signature = await account.signTypedData({
    domain: typed.json.typedData.domain,
    types: typed.json.typedData.types,
    primaryType: 'TokenPollBallot',
    message,
  });
  return fx.api('POST', `/api/polls/${poll.id}/ballots`, {
    body: { voter: account.address, choices, sig: signature, issuedAt: fx.clock.t },
  });
}

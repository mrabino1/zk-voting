// NOT FOR PROFIT — token poll API: auth, ballots, hold-through-close, disclosure.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, describe, test } from 'node:test';

import { canonicalPollParams, hashCanonical } from '../src/pollTypedData.mjs';
import { freshAccount, login, startPollNode } from './poll-fixture.mjs';

const A_LABEL = { id: 'a', label: 'A' };
const B_LABEL = { id: 'b', label: 'B' };

async function openPoll(fx, { pollType = 'plurality', quorum = null, passThresholdBps = null } = {}) {
  const admin = await login(fx.api, 'admin');
  assert.equal(admin.res.json.user.role, 'platform_super_admin');
  fx.chain.mint(fx.chain.token, 0n);
  const created = await fx.api('POST', '/api/polls', {
    jar: admin.jar,
    body: {
      title: 'Signal poll',
      pollType,
      options: [A_LABEL, B_LABEL],
      startTime: fx.clock.t - 10,
      cutoffTime: fx.clock.t + 400,
      jurisdictionId: 'demo',
      quorum,
      passThresholdBps,
    },
  });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.json.poll.binding, false);
  assert.equal(created.json.poll.privacyMode, 'public_weighted');
  assert.equal(created.json.poll.options.at(-1).id, 'abstain');
  assert.equal(created.json.poll.quorum, quorum);
  assert.ok(created.json.preflight.warnings.some((line) => /staking|liquidity/i.test(line)));
  const scheduled = await fx.api('POST', `/api/polls/${created.json.poll.id}/schedule`, { jar: admin.jar });
  assert.equal(scheduled.status, 200, scheduled.text);
  assert.ok(scheduled.json.pollParamsHash);
  return { admin, poll: scheduled.json };
}

async function signAndCast(fx, poll, account, choices) {
  const typed = await fx.api(
    'GET',
    `/api/polls/${poll.id}/typed-data?address=${account.address}&choices=${choices.join(',')}&issuedAt=${fx.clock.t}`,
  );
  assert.equal(typed.status, 200, typed.text);
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
    body: {
      voter: account.address,
      choices,
      sig: signature,
      issuedAt: fx.clock.t,
      userId: 'should-not-stick',
      nullifier: 'nope',
    },
  });
}

describe('token poll API', () => {
  const stops = [];
  after(async () => {
    for (const stop of stops) await stop();
  });

  test('non-super-admin create is rejected and the flag hides routes', async () => {
    const fx = await startPollNode();
    stops.push(() => fx.stop());
    const anon = await fx.api('POST', '/api/polls', { body: { title: 'x' } });
    assert.equal(anon.status, 401);
    const adminUser = await login(fx.api, 'padmin', 'platform_admin');
    const clerk = await login(fx.api, 'clerk1', 'clerk');
    const tally = await login(fx.api, 'tally1', 'tally_operator');
    for (const jar of [adminUser.jar, clerk.jar, tally.jar]) {
      const res = await fx.api('POST', '/api/polls', {
        jar,
        body: {
          title: 'Nope',
          pollType: 'plurality',
          options: [A_LABEL, B_LABEL],
          startTime: 10,
          cutoffTime: 20,
          jurisdictionId: 'demo',
        },
      });
      assert.equal(res.status, 403, res.text);
      assert.equal(res.json.required, 'platform_super_admin');
    }
    const off = await startPollNode({ pollsEnabled: false });
    stops.push(() => off.stop());
    const hidden = await off.api('POST', '/api/polls', { body: {} });
    assert.equal(hidden.status, 404);
    const cfg = await off.api('GET', '/api/config');
    assert.equal(cfg.json.pollsEnabled, false);
    const on = await fx.api('GET', '/api/config');
    assert.equal(on.json.pollsEnabled, true);
    assert.equal(on.json.pollsReady, true);
    assert.equal(on.json.votingToken.address, fx.chain.token);
    assert.equal(on.json.votingToken.chainId, fx.chain.chainId);
    assert.equal(on.json.votingToken.readOnly, true);
  });

  test('polls are disabled when VOTING_TOKEN_ADDRESS is unset or invalid', async () => {
    const unset = await startPollNode({ votingTokenAddress: '', votingTokenChainId: '' });
    stops.push(() => unset.stop());
    const cfg = await unset.api('GET', '/api/config');
    assert.equal(cfg.json.pollsEnabled, true);
    assert.equal(cfg.json.pollsReady, false);
    assert.equal(cfg.json.votingToken.configured, false);
    assert.equal(cfg.json.votingToken.address, null);
    assert.equal(cfg.json.votingToken.reason, 'unset');
    assert.equal(cfg.json.votingToken.chainId, 1);
    const hidden = await unset.api('POST', '/api/polls', { body: { title: 'x' } });
    assert.equal(hidden.status, 404);
    const listed = await unset.api('GET', '/api/polls');
    assert.equal(listed.status, 404);

    const invalid = await startPollNode({ votingTokenAddress: 'not-an-address', votingTokenChainId: '' });
    stops.push(() => invalid.stop());
    const badCfg = await invalid.api('GET', '/api/config');
    assert.equal(badCfg.json.pollsEnabled, true);
    assert.equal(badCfg.json.pollsReady, false);
    assert.equal(badCfg.json.votingToken.reason, 'invalid');
    assert.equal(badCfg.json.votingToken.address, null);
    const stillHidden = await invalid.api('GET', '/api/polls');
    assert.equal(stillHidden.status, 404);
  });

  test('a zero balance cannot vote, and a wallet with no account can', async () => {
    const fx = await startPollNode();
    stops.push(() => fx.stop());
    const holder = freshAccount();
    const empty = freshAccount();
    fx.chain.mint(holder.address, 1000n);
    const voteBlock = fx.chain.mine({ timestamp: 1_700_000_050n });
    const { poll } = await openPoll(fx);
    const no = await signAndCast(fx, poll, empty, [0]);
    assert.equal(no.status, 400, no.text);
    assert.equal(no.json.code, 'NO_BALANCE');
    const yes = await signAndCast(fx, poll, holder, [0]);
    assert.equal(yes.status, 201, yes.text);
    assert.equal(yes.json.receipt.provisionalWeight, '1000');
    assert.equal(yes.json.receipt.voteBlock, Number(voteBlock.number));
    assert.equal(yes.json.receipt.choices, undefined);
    assert.equal(yes.json.receipt.userId, undefined);
    assert.equal(JSON.stringify(yes.json).includes('userId'), false);
    assert.equal(JSON.stringify(yes.json).includes('nullifier'), false);
    const again = await signAndCast(fx, poll, holder, [1]);
    assert.equal(again.status, 409);
    assert.equal(again.json.code, 'ALREADY_VOTED');
    const src = readFileSync(new URL('../src/polls.mjs', import.meta.url), 'utf8');
    const route = readFileSync(new URL('../src/routes/polls.mjs', import.meta.url), 'utf8');
    const code = `${src}\n${route}`.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.equal(/voteGate|assertCanVote/.test(code), false);
  });

  test('moving tokens out reduces or zeroes the vote, and a second address counts once', async () => {
    const fx = await startPollNode();
    stops.push(() => fx.stop());
    const a = freshAccount();
    const b = freshAccount();
    fx.chain.mint(a.address, 1000n);
    fx.chain.mine({ timestamp: 1_700_000_050n });
    const { admin, poll } = await openPoll(fx);
    const first = await signAndCast(fx, poll, a, [0]);
    assert.equal(first.status, 201, first.text);
    fx.chain.transfer(a.address, b.address, 1000n);
    fx.chain.mine({ timestamp: 1_700_000_180n });
    const second = await signAndCast(fx, poll, b, [1]);
    assert.equal(second.status, 201, second.text);
    fx.chain.mine({ timestamp: 1_700_000_600n });
    const close = await fx.chain.blockBeforeTimestamp(fx.clock.t + 400);
    fx.chain.finalizeThrough(close.number);
    fx.clock.t += 400;
    const early = await fx.api('POST', `/api/polls/${poll.id}/tally`, { jar: admin.jar });
    assert.equal(early.status, 200, early.text);
    assert.equal(early.json.participation, '1000');
    assert.equal(early.json.binding, false);
    assert.equal(early.json.counts.a, '0');
    assert.equal(early.json.counts.b, '1000');
    const pack = await fx.api('GET', `/api/polls/${poll.id}/artifacts`);
    const rowA = pack.json.ballots.find((row) => row.voter.toLowerCase() === a.address.toLowerCase());
    assert.equal(rowA.status, 'withdrawn_by_transfer');
    assert.equal(rowA.finalWeight, '0');
    assert.equal(JSON.stringify(pack.json).includes('userId'), false);
  });

  test('a partial sale reduces weight and a flash loan adds nothing', async () => {
    const fx = await startPollNode();
    stops.push(() => fx.stop());
    const a = freshAccount();
    fx.chain.mint(a.address, 1000n);
    fx.chain.mine({ timestamp: 1_700_000_050n });
    const { admin, poll } = await openPoll(fx);
    assert.equal((await signAndCast(fx, poll, a, [0])).status, 201);
    fx.chain.transfer(a.address, freshAccount().address, 400n);
    fx.chain.flashLoan(a.address, 10n ** 24n);
    fx.chain.mine({ timestamp: 1_700_000_180n });
    fx.chain.mine({ timestamp: 1_700_000_600n });
    const close = await fx.chain.blockBeforeTimestamp(fx.clock.t + 400);
    fx.chain.finalizeThrough(close.number);
    fx.clock.t += 400;
    const tallied = await fx.api('POST', `/api/polls/${poll.id}/tally`, { jar: admin.jar });
    assert.equal(tallied.status, 200, tallied.text);
    assert.equal(tallied.json.counts.a, '600');
    assert.equal(tallied.json.participation, '600');
    const before = await fx.api('GET', `/api/polls/${poll.id}/results`);
    assert.equal(before.json.official, true);
    assert.equal(before.json.counts.a, '600');
  });

  test('tally waits for a finalized close block and results stay unofficial until then', async () => {
    const fx = await startPollNode();
    stops.push(() => fx.stop());
    const a = freshAccount();
    fx.chain.mint(a.address, 10n);
    fx.chain.mine({ timestamp: 1_700_000_050n });
    const { admin, poll } = await openPoll(fx);
    const openResults = await fx.api('GET', `/api/polls/${poll.id}/results`);
    assert.equal(openResults.json.official, false);
    assert.equal(openResults.json.counts, null);
    assert.equal((await signAndCast(fx, poll, a, [0])).status, 201);
    fx.clock.t += 400;
    fx.chain.mine({ timestamp: BigInt(fx.clock.t) });
    const tallyUser = await login(fx.api, 'tally2', 'tally_operator');
    const notFinal = await fx.api('POST', `/api/polls/${poll.id}/tally`, { jar: tallyUser.jar });
    assert.equal(notFinal.status, 409);
    assert.equal(notFinal.json.code, 'CLOSE_NOT_FINAL');
    const close = await fx.chain.blockBeforeTimestamp(fx.clock.t);
    fx.chain.finalizeThrough(close.number);
    const done = await fx.api('POST', `/api/polls/${poll.id}/tally`, { jar: tallyUser.jar });
    assert.equal(done.status, 200, done.text);
    assert.equal(done.json.l1Mirror, 'skipped');
    const stranger = await login(fx.api, 'voter9', 'voter');
    const denied = await fx.api('POST', `/api/polls/${poll.id}/tally`, { jar: stranger.jar });
    assert.equal(denied.status, 403);
  });

  test('ballots stay sealed until the disclosure hour closes', async () => {
    const fx = await startPollNode({ disclosureIntervalSeconds: 3600 });
    stops.push(() => fx.stop());
    const hour = fx.clock.t - (fx.clock.t % 3600);
    fx.clock.t = hour + 10;
    const a = freshAccount();
    fx.chain.mint(a.address, 5n);
    fx.chain.mine({ timestamp: BigInt(fx.clock.t) });
    const { poll } = await openPoll(fx);
    assert.equal((await signAndCast(fx, poll, a, [0])).status, 201);
    const sealed = await fx.api('GET', `/api/polls/${poll.id}/ballots.json`);
    assert.equal(sealed.json.ballots.length, 0);
    fx.clock.t = hour + 3600;
    const open = await fx.api('GET', `/api/polls/${poll.id}/ballots.json`);
    assert.equal(open.json.ballots.length, 1);
    assert.deepEqual(open.json.ballots[0].choices, ['a']);
  });

  test('bad signatures, wrong chain domain, and ERC-1271', async () => {
    const fx = await startPollNode();
    stops.push(() => fx.stop());
    const a = freshAccount();
    fx.chain.mint(a.address, 8n);
    const contract = '0x3333333333333333333333333333333333333333';
    fx.chain.mint(contract, 9n);
    const goodSig = `0x${'11'.repeat(65)}`;
    fx.chain.setContractWallet(contract, (_hash, sig) => sig === goodSig);
    fx.chain.mine({ timestamp: 1_700_000_050n });
    const { poll } = await openPoll(fx);
    const bad = await fx.api('POST', `/api/polls/${poll.id}/ballots`, {
      body: { voter: a.address, choices: [0], sig: `0x${'ab'.repeat(65)}`, issuedAt: fx.clock.t },
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.code, 'BAD_SIGNATURE');
    const wrong = await fx.api('POST', `/api/polls/${poll.id}/ballots`, {
      body: { voter: contract, choices: [0], sig: `0x${'22'.repeat(65)}`, issuedAt: fx.clock.t },
    });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.json.code, 'BAD_SIGNATURE');
    const ok = await fx.api('POST', `/api/polls/${poll.id}/ballots`, {
      body: { voter: contract, choices: [1], sig: goodSig, issuedAt: fx.clock.t },
    });
    assert.equal(ok.status, 201, ok.text);
    assert.equal(ok.json.receipt.provisionalWeight, '9');
  });

  test('creation ignores a client token and chain, and still checks options and window', async () => {
    const fx = await startPollNode();
    stops.push(() => fx.stop());
    const { jar } = await login(fx.api, 'admin');
    const base = {
      title: 'X',
      pollType: 'plurality',
      options: [A_LABEL, B_LABEL],
      startTime: 10,
      cutoffTime: 20,
      jurisdictionId: 'demo',
    };
    const created = await fx.api('POST', '/api/polls', {
      jar,
      body: {
        ...base,
        token: '0x2222222222222222222222222222222222222222',
        tokenChainId: 27427,
      },
    });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.json.poll.token, fx.chain.token);
    assert.equal(created.json.poll.tokenChainId, fx.chain.chainId);
    const scheduled = await fx.api('POST', `/api/polls/${created.json.poll.id}/schedule`, { jar });
    assert.equal(scheduled.status, 200, scheduled.text);
    const frozen = canonicalPollParams(scheduled.json);
    assert.equal(frozen.token, fx.chain.token);
    assert.equal(frozen.tokenChainId, fx.chain.chainId);
    assert.equal(hashCanonical(frozen), scheduled.json.pollParamsHash);
    assert.notEqual(hashCanonical({ ...frozen, token: '0x2222222222222222222222222222222222222222' }), scheduled.json.pollParamsHash);
    const few = await fx.api('POST', '/api/polls', { jar, body: { ...base, options: [A_LABEL] } });
    assert.equal(few.status, 400);
    const window = await fx.api('POST', '/api/polls', { jar, body: { ...base, startTime: 30, cutoffTime: 20 } });
    assert.equal(window.status, 400);
  });

  test('scheduled poll params carry a monotonic sequence and postedAt', async () => {
    const fx = await startPollNode();
    stops.push(() => fx.stop());
    const { poll } = await openPoll(fx);
    const rows = Object.values(fx.explorer.chain.txs).filter((tx) => tx.type === 'poll_params');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].payload.pollId, poll.id);
    assert.equal(rows[0].payload.sequence, 1);
    assert.equal(rows[0].payload.postedAt, fx.clock.t);
    assert.equal(fx.explorer.latestPollRecord('poll_params', poll.id).payload.sequence, 1);
  });
});

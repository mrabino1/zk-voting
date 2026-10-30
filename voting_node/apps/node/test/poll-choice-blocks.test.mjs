// NOT FOR PROFIT — civic public good, not a commercial product.
// Hourly poll choice sums, and one current ballot per nullifier.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

import { aggregateCiphertexts, encryptAggregateBallot } from '../src/aggregateBallot.mjs';
import { planChoiceBlocks, presentPollChoiceBlocks } from '../src/pollChoiceBlocks.mjs';
import { publicVoteRecord } from '../src/store.mjs';
import { P256_G, pointToRaw } from '../public/p256-math.js';
import { partialDecrypt } from '../src/guardians/threshold.mjs';
import { createSealedDeal, finalizeShare, initGuardian } from '../src/guardians/index.mjs';
import { getConfig } from '../src/config.mjs';
import { createApp } from '../src/server.mjs';

const H0 = 1_699_999_200;
const HOUR = 3600;
const DELAY = 1800;
const H1 = H0 + HOUR;
const H2 = H0 + 2 * HOUR;

function ballotsAt(ts, n, tag) {
  return Array.from({ length: n }, (_, i) => ({
    receivedAt: ts,
    electionId: 'e',
    nullifier: `${tag}-${ts}-${i}`,
  }));
}

function policy(over = {}) {
  return {
    now: H0,
    intervalSeconds: HOUR,
    delaySeconds: DELAY,
    minBlockVotes: 10,
    minVotes: 100,
    endTime: H0 + 10 * HOUR,
    electionType: 0,
    resultsSealed: false,
    ...over,
  };
}

describe('choice block planner', () => {
  test('the results gate stays shut until 100 ballots or the scheduled end', () => {
    const early = planChoiceBlocks(ballotsAt(H0 + 10, 99, 'g'), policy({ now: H1 + DELAY, submittedVotes: 99 }));
    assert.equal(early.gateOpen, false);
    assert.equal(early.publish.length, 0);

    const enough = planChoiceBlocks(
      ballotsAt(H0 + 10, 100, 'g'),
      policy({ now: H1 + DELAY, submittedVotes: 100, minVotes: 100, minBlockVotes: 10 }),
    );
    assert.equal(enough.gateOpen, true);
    assert.equal(enough.publish.length, 1);
    assert.equal(enough.publish[0].ballots, 100);

    const ended = planChoiceBlocks(
      ballotsAt(H0 + 10, 4, 'e'),
      policy({
        now: H1 + DELAY,
        endTime: H1,
        submittedVotes: 4,
        minVotes: 100,
        minBlockVotes: 1,
      }),
    );
    assert.equal(ended.gateOpen, true);
    assert.equal(ended.publish.length, 1);
    assert.equal(ended.publish[0].ballots, 4);
  });

  test('the 08:00 block publishes at 09:30 and not one second earlier', () => {
    const items = ballotsAt(H0 + 10, 10, 'd');
    const base = policy({ minVotes: 0, minBlockVotes: 10, submittedVotes: 100, endTime: H0 + 10 * HOUR });
    const early = planChoiceBlocks(items, { ...base, now: H1 + DELAY - 1 });
    assert.equal(early.publish.length, 0);
    const onTime = planChoiceBlocks(items, { ...base, now: H1 + DELAY });
    assert.equal(onTime.publish.length, 1);
    assert.equal(onTime.publish[0].id, `${H0}-${H1}`);
    assert.equal(onTime.publish[0].publishedAt, H1 + DELAY);
    assert.equal(onTime.frozen, false);
  });

  test('hours under the floor merge forward', () => {
    const items = [...ballotsAt(H0 + 10, 6, 'a'), ...ballotsAt(H1 + 10, 6, 'b')];
    const base = policy({ minVotes: 0, minBlockVotes: 10, submittedVotes: 12 });
    const half = planChoiceBlocks(items, { ...base, now: H1 + DELAY });
    assert.equal(half.publish.length, 0);
    const both = planChoiceBlocks(items, { ...base, now: H2 + DELAY });
    assert.equal(both.publish.length, 1);
    assert.equal(both.publish[0].ballots, 12);
    assert.equal(both.publish[0].hourStart, H0);
    assert.equal(both.publish[0].hourEnd, H2);
  });

  test('a large block publishes while the poll is still open', () => {
    const items = [...ballotsAt(H0 + 10, 12, 'a'), ...ballotsAt(H1 + 10, 3, 'b')];
    const open = planChoiceBlocks(
      items,
      policy({ now: H2 + DELAY, minVotes: 0, minBlockVotes: 10, submittedVotes: 15, endTime: H0 + 10 * HOUR }),
    );
    assert.equal(open.frozen, false);
    assert.equal(open.publish.length, 1);
    assert.equal(open.publish[0].ballots, 12);
  });

  test('at close a short tail folds into the previous block', () => {
    const items = [...ballotsAt(H0 + 10, 12, 'a'), ...ballotsAt(H1 + 10, 3, 'b')];
    const closed = planChoiceBlocks(
      items,
      policy({ now: H2 + DELAY, endTime: H2, minVotes: 0, minBlockVotes: 10, submittedVotes: 15 }),
    );
    assert.equal(closed.frozen, true);
    assert.equal(closed.publish.length, 1);
    assert.equal(closed.publish[0].ballots, 15);
    assert.equal(closed.trailingFolded, 3);
    assert.equal(closed.publish[0].hourStart, H0);
    assert.equal(closed.publish[0].hourEnd, H2);
    const later = planChoiceBlocks(
      items,
      policy({ now: H2 + DELAY + 5000, endTime: H2, minVotes: 0, minBlockVotes: 10, submittedVotes: 15 }),
    );
    assert.deepEqual(
      later.publish.map((row) => row.id),
      closed.publish.map((row) => row.id),
    );
  });

  test('a whole poll under the floor becomes one closing block', () => {
    const items = ballotsAt(H0 + 10, 4, 's');
    const closed = planChoiceBlocks(
      items,
      policy({ now: H1 + DELAY, endTime: H1, minVotes: 0, minBlockVotes: 10, submittedVotes: 4 }),
    );
    assert.equal(closed.publish.length, 1);
    assert.equal(closed.publish[0].ballots, 4);
    assert.equal(closed.publish[0].closingBlock, true);
  });

  test('a ballot at cutoff is excluded, and a vote publishes nothing', () => {
    const items = [
      { receivedAt: H0 + 10, electionId: 'e', nullifier: 'in' },
      { receivedAt: H1, electionId: 'e', nullifier: 'out' },
    ];
    const planned = planChoiceBlocks(
      items,
      policy({ now: H1 + DELAY, endTime: H1, minVotes: 0, minBlockVotes: 1, submittedVotes: 1 }),
    );
    assert.equal(planned.publish.length, 1);
    assert.equal(planned.publish[0].ballots, 1);
    assert.equal(planned.publish[0].items[0].nullifier, 'in');

    const vote = planChoiceBlocks(ballotsAt(H0 + 10, 20, 'v'), policy({ electionType: 1, now: H2, endTime: H1, minVotes: 0 }));
    assert.equal(vote.publish.length, 0);
    assert.equal(vote.reason, 'vote');
  });

  test('a ballot stays in its original hour', () => {
    const first = planChoiceBlocks(
      [{ receivedAt: H0 + 10, electionId: 'e', nullifier: 'n' }],
      policy({ now: H1 + DELAY, minVotes: 0, minBlockVotes: 1, submittedVotes: 1 }),
    );
    assert.equal(first.publish.length, 1);
    assert.equal(first.publish[0].hourStart, H0);
    const again = planChoiceBlocks(
      [{ receivedAt: H0 + 10, electionId: 'e', nullifier: 'n' }],
      policy({ now: H2 + DELAY, minVotes: 0, minBlockVotes: 1, submittedVotes: 1 }),
    );
    assert.equal(again.publish[0].hourStart, H0);
    assert.equal(again.publish[0].ballots, 1);
  });

  test('a single block under the floor at close is one closing block', () => {
    const items = [...ballotsAt(H0 + 10, 4, 'a'), ...ballotsAt(H1 + 10, 3, 'b')];
    const closed = planChoiceBlocks(
      items,
      policy({ now: H2 + DELAY, endTime: H2, minVotes: 0, minBlockVotes: 10, submittedVotes: 20 }),
    );
    assert.equal(closed.frozen, true);
    assert.equal(closed.publish.length, 1);
    assert.equal(closed.publish[0].ballots, 7);
    assert.equal(closed.publish[0].closingBlock, true);
    assert.equal(closed.publish[0].hourStart, H0);
    assert.equal(closed.publish[0].hourEnd, H2);
  });

  test('allowRevote is refused when a chain is configured', async () => {
    assert.throws(
      () => getConfig({ allowRevote: true, chainRpc: 'http://127.0.0.1:8545' }),
      /ALLOW_REVOTE cannot be on while a chain is configured/,
    );
    assert.equal(getConfig({ allowRevote: false, chainRpc: 'http://127.0.0.1:8545' }).allowRevote, false);
    assert.equal(getConfig({ allowRevote: true }).allowRevote, true);
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'poll-blocks-'));
    try {
      await assert.rejects(
        () => createApp({
          dataDir: tmp,
          allowDevLogin: true,
          quiet: true,
          port: 0,
          allowRevote: true,
          chain: { isConfigured() { return true; } },
        }),
        /ALLOW_REVOTE cannot be on while a chain is configured/,
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('publicVoteRecord returns the stored hash and nullifier', () => {
    const row = publicVoteRecord({
      nullifier: '0xabc',
      ballotHash: '0xsame',
      publishedBallotHash: '0xsame',
      electionId: 'e',
      relayer: 'node',
    });
    assert.equal(row.nullifier, '0xabc');
    assert.equal(row.ballotHash, '0xsame');
    assert.equal(row.publishedBallotHash, undefined);
  });

  test('a non-threshold decrypt error is decrypt_failed and the log has no ballot', async () => {
    const y = `0x${Buffer.from(pointToRaw(P256_G)).toString('hex')}`;
    const env = encryptAggregateBallot({
      jointPublicKey: y,
      choice: 0,
      choiceRandomness: 9n,
      nOptions: 2,
    });
    const lines = [];
    const prev = console.error;
    console.error = (...args) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      const view = presentPollChoiceBlocks({
        items: [{ receivedAt: H0 + 10, electionId: 'e', nullifier: 'n', ballotHash: 'h' }],
        envelopes: [{ nullifier: 'n', ballotHash: 'h', encryptedBallot: env.encryptedBallot }],
        policy: policy({ now: H1 + DELAY, minVotes: 0, minBlockVotes: 1, submittedVotes: 1 }),
        electionId: 'e',
        ceremony: { status: 'ready', publicKey: y, verificationKeys: {}, threshold: 1 },
        partialGroups: [
          {
            index: 1,
            partials: [
              {
                ballotHash: `block:${H0}-${H1}:aggregate:0`,
                point: '0x',
                proof: { A: '0x', B: '0x', z: '0x' },
              },
            ],
          },
        ],
      });
      assert.equal(view.blocks[0].decryption, 'decrypt_failed');
      assert.equal(view.blocks[0].counts, null);
      assert.equal(lines.length, 1);
      assert.match(lines[0], /decrypt failed/);
      assert.equal(lines[0].includes(env.encryptedBallot), false);
      assert.equal(lines[0].includes('nullifier'), false);
    } finally {
      console.error = prev;
    }
  });
});

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

const LINK_KEYS = [
  'superseded',
  'supersededBy',
  'supersededHashes',
  'previousBallot',
  'previousHash',
  'previous',
  'replaced',
  'generation',
  'voterId',
  'userId',
];

describe('poll choice sums and last ballot', () => {
  let app;
  const clock = { t: H0 + 120 };
  const adminJar = {};
  const voterJar = {};

  after(async () => {
    if (app) await app.stop();
  });

  async function start(extra = {}) {
    if (app) {
      await app.stop();
      app = null;
    }
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'poll-blocks-'));
    const created = await createApp({
      dataDir: tmp,
      allowDevLogin: true,
      adminHandle: 'admin',
      quiet: true,
      port: 0,
      disclosureIntervalSeconds: HOUR,
      disclosureDelaySeconds: DELAY,
      resultsMinVotes: 0,
      disclosureMinBlockVotes: 1,
      allowRevote: extra.allowRevote === true,
      nowFn: () => clock.t,
    });
    const server = await listen(created.app);
    const base = `http://127.0.0.1:${server.address().port}`;
    async function api(method, url, { body, jar } = {}) {
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
      return { json, text, status: res.status };
    }
    await api('POST', '/api/auth/dev-login', { body: { handle: 'admin', role: 'platform_admin' }, jar: adminJar });
    await api('POST', '/api/auth/dev-login', { body: { handle: 'voter', role: 'voter' }, jar: voterJar });
    app = {
      api,
      store: created.store,
      votePass: created.votePass,
      async stop() {
        await new Promise((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
        await rm(tmp, { recursive: true, force: true });
      },
    };
  }

  async function establishGuardians(electionId, { guardians = 3, threshold = 2 } = {}) {
    const secrets = [];
    for (let i = 1; i <= guardians; i++) {
      secrets.push(await initGuardian({ index: i, guardianId: `g${i}` }));
    }
    for (const secret of secrets) {
      const enrolled = await app.api('POST', `/api/elections/${electionId}/guardians`, {
        jar: adminJar,
        body: {
          guardianId: secret.guardianId,
          label: secret.guardianId,
          transportPublicKey: secret.transportPublicKey,
        },
      });
      assert.equal(enrolled.status, 201, enrolled.text);
    }
    const roster = secrets.map((secret) => ({
      index: secret.index,
      transportPublicKey: secret.transportPublicKey,
    }));
    const deals = [];
    for (const secret of secrets) {
      const deal = await createSealedDeal({ index: secret.index, threshold, roster });
      deals.push(deal);
      const posted = await app.api('POST', `/api/elections/${electionId}/guardians/deals`, {
        jar: adminJar,
        body: deal,
      });
      assert.equal(posted.status, 201, posted.text);
    }
    const shares = [];
    for (const secret of secrets) {
      shares.push(
        await finalizeShare({
          index: secret.index,
          privateJwk: secret.transportPrivateJwk,
          deals,
          threshold,
          guardianCount: guardians,
        }),
      );
    }
    return shares;
  }

  function blockPartialBody(share, electionId, blockId, envelopes) {
    const product = aggregateCiphertexts(envelopes.map((env) => env.encryptedBallot));
    return {
      index: share.index,
      blockId,
      partials: product.options.map((opt, j) =>
        partialDecrypt({
          shareScalar: share.shareScalar,
          index: share.index,
          electionId,
          ballotHash: `block:${blockId}:aggregate:${j}`,
          jointPublicKey: share.jointPublicKey,
          ephemeral: opt.c1Hex,
        }),
      ),
    };
  }

  function tallyPartialBody(share, electionId, envelopes) {
    const product = aggregateCiphertexts(envelopes.map((env) => env.tallyEncryptedBallot || env.encryptedBallot));
    return {
      index: share.index,
      partials: product.options.map((opt, j) =>
        partialDecrypt({
          shareScalar: share.shareScalar,
          index: share.index,
          electionId,
          ballotHash: `aggregate:${j}`,
          jointPublicKey: share.jointPublicKey,
          ephemeral: opt.c1Hex,
        }),
      ),
    };
  }

  async function cast(id, nullifier, choice, pub, votePass) {
    const env = encryptAggregateBallot({
      jointPublicKey: pub,
      choice,
      choiceRandomness: 5000n + BigInt(choice) + BigInt(nullifier),
      nOptions: 2,
    });
    const vote = await app.api('POST', `/api/elections/${id}/vote`, {
      body: {
        proof: { accept: true },
        publicInputs: { nullifier: String(nullifier), electionId: id },
        encryptedBallot: env.encryptedBallot,
        identityCommitment: '0xabc1',
        ...(votePass ? { votePass } : {}),
      },
    });
    return { vote, env };
  }

  test('a re-vote leaves published blocks unchanged and the tally counts the last ballot', async () => {
    await start({ allowRevote: true });
    const cfg = await app.api('GET', '/api/config');
    assert.equal(cfg.json.allowRevote, true);
    const created = await app.api('POST', '/api/elections', {
      jar: adminJar,
      body: {
        title: 'Hourly poll',
        startTime: clock.t - 60,
        cutoffTime: H0 + 10 * HOUR,
        treeDepth: 16,
        jurisdictionId: 'demo',
        electionType: 0,
        tallyScheme: 'opens_ballots',
        threshold: 2,
        guardianCount: 3,
        questions: [
          {
            type: 'YES_NO',
            prompt: 'Adopt?',
            options: [
              { id: 'yes', label: 'Yes' },
              { id: 'no', label: 'No' },
            ],
          },
        ],
      },
    });
    assert.equal(created.status, 201, created.text);
    const id = created.json.election.id;
    const shares = await establishGuardians(id);
    const pub = app.store.requireElection(id).tallyPubKey;
    const reg = await app.api('POST', `/api/elections/${id}/register`, {
      jar: adminJar,
      body: { identityCommitment: '0xabc1' },
    });
    assert.equal(reg.status, 201, reg.text);
    const freeze = await app.api('POST', `/api/elections/${id}/freeze`, { jar: adminJar });
    assert.equal(freeze.status, 200, freeze.text);
    const pass = await app.votePass.mintForTest(id);

    const first = await cast(id, 7, 0, pub, pass);
    assert.equal(first.vote.status, 201, first.vote.text);
    const firstHash = first.vote.json.vote.ballotHash;
    clock.t = H1 + DELAY;
    let results = await app.api('GET', `/api/elections/${id}/results`);
    assert.equal(results.status, 200, results.text);
    assert.equal(results.json.choiceBlocks.blocks.length, 1);
    assert.equal(results.json.choiceBlocks.blocks[0].ballots, 1);
    const blockId = results.json.choiceBlocks.blocks[0].id;
    assert.equal(blockId, `${H0}-${H1}`);
    for (const share of shares.slice(0, 2)) {
      const posted = await app.api('POST', `/api/elections/${id}/choice-blocks/partials`, {
        jar: adminJar,
        body: blockPartialBody(share, id, blockId, app.store.listEnvelopes(id)),
      });
      assert.equal(posted.status, 201, posted.text);
    }
    results = await app.api('GET', `/api/elections/${id}/results`);
    assert.deepEqual(results.json.choiceBlocks.blocks[0].counts, [1, 0]);
    assert.equal(results.json.choiceBlocks.certifiedMatch, undefined);

    const beforeBlocks = JSON.stringify(results.json.choiceBlocks);
    const beforeList = (await app.api('GET', `/api/elections/${id}/ballots`)).json;
    const beforeRows = JSON.stringify(beforeList.ballots);
    const acceptedAt = app.store.listVotes(id)[0].acceptedAt;

    clock.t = H1 + DELAY + 10;
    const second = await cast(id, 7, 1, pub, pass);
    assert.equal(second.vote.status, 201, second.vote.text);
    assert.equal(second.vote.json.replaced, undefined);
    assert.equal(second.vote.json.generation, undefined);
    assert.equal(second.vote.json.superseded, undefined);
    const secondHash = second.vote.json.receipt.ballotHash;
    assert.notEqual(secondHash, firstHash);
    assert.equal(second.vote.json.vote.ballotHash, firstHash);
    assert.notEqual(second.vote.json.receipt.token, first.vote.json.receipt.token);
    assert.equal(second.vote.json.vote.nullifier, first.vote.json.vote.nullifier);
    const receiptRows = (app.store.data.receipts || []).filter((row) => String(row.electionId) === String(id));
    assert.equal(receiptRows.length, 2);
    assert.ok(receiptRows.some((row) => row.ballotHash === firstHash));
    assert.ok(receiptRows.some((row) => row.ballotHash === secondHash && row.tokenHash));
    assert.equal(app.store.requireElection(id).acceptedBallots, 1);
    assert.equal(app.store.listEnvelopes(id).length, 1);
    assert.equal(app.store.listVotes(id).length, 1);
    assert.equal(app.store.listVotes(id)[0].acceptedAt, acceptedAt);
    assert.equal(app.store.listVotes(id)[0].ballotHash, firstHash);
    assert.equal(app.store.listEnvelopes(id)[0].encryptedBallot, first.env.encryptedBallot);
    assert.equal(app.store.listEnvelopes(id)[0].tallyEncryptedBallot, second.env.encryptedBallot);

    results = await app.api('GET', `/api/elections/${id}/results`);
    const afterList = (await app.api('GET', `/api/elections/${id}/ballots`)).json;
    const afterRows = JSON.stringify(afterList.ballots);
    assert.equal(JSON.stringify(results.json.choiceBlocks), beforeBlocks);
    assert.equal(afterRows, beforeRows);
    assert.equal(afterList.acceptedBallots, beforeList.acceptedBallots);
    assert.equal(afterRows.includes(second.env.encryptedBallot), false);
    assert.deepEqual(results.json.choiceBlocks.blocks[0].counts, [1, 0]);
    assert.doesNotMatch(JSON.stringify(results.json), /certifiedMatch|BLOCK_TALLY|must equal/);

    const election = app.store.requireElection(id);
    election.cutoffTime = clock.t;
    await app.store.persist();
    const closed = await cast(id, 7, 0, pub, pass);
    assert.equal(closed.vote.status, 400);
    assert.equal(closed.vote.json.code, 'CLOSED');

    for (const share of shares.slice(0, 2)) {
      const posted = await app.api('POST', `/api/elections/${id}/guardians/partials`, {
        jar: adminJar,
        body: tallyPartialBody(share, id, app.store.listEnvelopes(id)),
      });
      assert.equal(posted.status, 201, posted.text);
    }
    clock.t = election.cutoffTime + 1;
    const tally = await app.api('POST', `/api/elections/${id}/tally`, { jar: adminJar, body: {} });
    assert.equal(tally.status, 200, tally.text);
    assert.deepEqual(tally.json.election.tally.counts, [0, 1]);
    assert.equal(app.store.requireElection(id).acceptedBallots, 1);

    results = await app.api('GET', `/api/elections/${id}/results`);
    assert.equal(results.json.results.available, true);
    assert.deepEqual(results.json.results.questions[0].options.map((opt) => opt.count), [0, 1]);
    assert.deepEqual(results.json.choiceBlocks.blocks[0].counts, [1, 0]);
    assert.equal(results.json.choiceBlocks.blocks[0].hourStart, H0);
    assert.equal(results.json.choiceBlocks.certifiedMatch, undefined);

    const blockText = JSON.stringify(results.json.choiceBlocks);
    assert.equal(blockText.includes('nullifier'), false);
    assert.equal(blockText.includes('identityCommitment'), false);
    assert.equal(blockText.includes('voterId'), false);

    const surfaces = [];
    surfaces.push(results.json.choiceBlocks);
    surfaces.push((await app.api('GET', `/api/elections/${id}/ballots`)).json);
    const detail = await app.api('GET', `/api/elections/${id}`);
    assert.equal(Object.hasOwn(detail.json, 'choiceBlocks'), false);
    const blocks = await app.api('GET', '/api/explorer/blocks');
    for (const block of blocks.json?.blocks || []) {
      const one = await app.api('GET', `/api/explorer/blocks/${block.number}`);
      surfaces.push(one.json);
    }
    const publicText = JSON.stringify(surfaces);
    assert.equal(publicText.includes(second.env.encryptedBallot), false);
    for (const key of LINK_KEYS) {
      assert.equal(publicText.includes(`"${key}"`), false, key);
    }
    const ballots = surfaces[1];
    assert.equal(ballots.ballots.length, 1);
    assert.equal(ballots.ballots[0].ballotHash, firstHash);
    assert.equal(ballots.ballots[0].nullifier, first.vote.json.vote.nullifier);
    const voteTxs = [];
    for (const block of blocks.json.blocks) {
      const one = await app.api('GET', `/api/explorer/blocks/${block.number}`);
      for (const tx of one.json?.block?.txs || []) {
        if (String(tx.type).toLowerCase() === 'vote' && String(tx.electionId) === String(id)) voteTxs.push(tx);
      }
    }
    assert.equal(voteTxs.length, 1);
    assert.equal(voteTxs[0].payload.ballotHash, firstHash);
  });

  test('a vote exposes no choice blocks to any caller', async () => {
    await start();
    const cfg = await app.api('GET', '/api/config');
    assert.equal(cfg.json.allowRevote, false);
    clock.t = H0 + 200;
    const created = await app.api('POST', '/api/elections', {
      jar: adminJar,
      body: {
        title: 'Sealed vote',
        startTime: clock.t - 60,
        cutoffTime: clock.t + 8 * HOUR,
        treeDepth: 16,
        jurisdictionId: 'demo',
        electionType: 1,
        questions: [{ type: 'YES_NO', prompt: 'Adopt?' }],
      },
    });
    assert.equal(created.status, 201, created.text);
    const id = created.json.election.id;
    const reg = await app.api('POST', `/api/elections/${id}/register`, {
      jar: adminJar,
      body: { identityCommitment: '0xabc1' },
    });
    assert.equal(reg.status, 201, reg.text);
    const freeze = await app.api('POST', `/api/elections/${id}/freeze`, { jar: adminJar });
    assert.equal(freeze.status, 200, freeze.text);
    const first = await app.api('POST', `/api/elections/${id}/vote`, {
      body: {
        proof: { accept: true },
        publicInputs: { nullifier: '11', electionId: id },
        encryptedBallot: '0x11',
        identityCommitment: '0xabc1',
      },
    });
    assert.equal(first.status, 201, first.text);
    const second = await app.api('POST', `/api/elections/${id}/vote`, {
      body: {
        proof: { accept: true },
        publicInputs: { nullifier: '11', electionId: id },
        encryptedBallot: '0x22',
        identityCommitment: '0xabc1',
      },
    });
    assert.equal(second.status, 409, second.text);
    assert.equal(second.json.code, 'NULLIFIER_USED');
    assert.equal(app.store.requireElection(id).acceptedBallots, 1);
    assert.equal(app.store.listEnvelopes(id)[0].encryptedBallot, '0x11');

    for (const jar of [undefined, adminJar, voterJar]) {
      const results = await app.api('GET', `/api/elections/${id}/results`, { jar });
      assert.equal(results.status, 200, results.text);
      assert.equal(Object.hasOwn(results.json, 'choiceBlocks'), false, 'choice blocks on a vote');
      assert.equal(results.json.resultsSealed, true);
      const ballots = await app.api('GET', `/api/elections/${id}/ballots`, { jar });
      assert.equal(ballots.json.ballots.length, 0);
      assert.equal(Object.hasOwn(ballots.json, 'choiceBlocks'), false);
    }
    const denied = await app.api('POST', `/api/elections/${id}/choice-blocks/partials`, {
      jar: adminJar,
      body: { blockId: `${H0}-${H1}`, index: 1, partials: [] },
    });
    assert.equal(denied.status, 409);
    assert.equal(denied.json.code, 'VOTE_NO_CHOICE_BLOCKS');
    assert.equal(denied.json.counts, undefined);
    assert.equal(JSON.stringify(denied.json).includes('0x22'), false);

    const election = app.store.requireElection(id);
    election.cutoffTime = clock.t - 1;
    await app.store.persist();
    const after = await app.api('GET', `/api/elections/${id}/results`);
    assert.equal(Object.hasOwn(after.json, 'choiceBlocks'), false);
    assert.equal(after.json.results?.available, false);
  });
});

// NOT FOR PROFIT — civic public good, not a commercial product.
// Full-stack civic vote with real processes and no Docker: Anvil, scripts/deploy.sh --target
// local, the L2 operator (l2/rollup/main.mjs) and the node (apps/node/src/server.mjs), each as
// its own process, wired through env the way Docker Compose wires them. Guardians use the real
// CLI (npm run guardian:rollup); voters use the node's HTTP API as the browser does (vote pass,
// PIN, encrypted ballot without cookies). Then the auditor checks the vote from L1 alone, and
// the node's outcomes page runs the same audit.
//
//   npm run test:fullstack          (needs Foundry: anvil, forge, cast)

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { copyFileSync, createWriteStream, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, before, describe, test } from 'node:test';

import * as bc from '../../apps/node/public/ballot-crypto.js';
import { blindVotePass, unblindVotePass } from '../../apps/node/public/vote-pass.js';
import { encryptRollupBallot } from '../../apps/node/public/rollup-vote.js';
import {
  CLERK_ADDRESS,
  CLERK_KEY,
  CONTRACTS,
  foundryAvailable,
  OPERATOR_ADDRESS,
  OPERATOR_KEY,
} from '../../l2/rollup/test/helpers/anvil.mjs';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FOUNDRY = path.join(os.homedir(), '.foundry/bin');
const skip = foundryAvailable() ? false : process.env.CI === 'true' ? false : 'Foundry not installed';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function waitFor(what, fn, { timeoutMs = 60_000, everyMs = 250 } = {}) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
}

describe('full stack: one civic vote through real processes', { skip }, () => {
  const procs = [];
  let tmp;
  let rpcUrl;
  let nodeUrl;
  let deployment;
  let deploymentFile;
  let l2Url;

  const env = (extra) => ({
    PATH: `${FOUNDRY}:${process.env.PATH}`,
    HOME: process.env.HOME,
    // Nothing from a developer's own .env leaks into the run.
    ENV_FILE: path.join(tmp, 'empty.env'),
    ...extra,
  });

  function start(name, args, extra, cwd = ROOT) {
    const log = path.join(tmp, `${name}.log`);
    const out = createWriteStream(log);
    const child = spawn(args[0], args.slice(1), { cwd, env: env(extra), stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(out);
    child.stderr.pipe(out);
    child.on('exit', (code, signal) => {
      if (!child.stopping) out.write(`\n[${name} exited code=${code} signal=${signal}]\n`);
    });
    procs.push({ name, child, log });
    return child;
  }

  const rpc = async (method, params = []) => {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const body = await res.json();
    if (body.error) throw new Error(body.error.message);
    return body.result;
  };
  const l1Now = async () => Number(BigInt((await rpc('eth_getBlockByNumber', ['latest', false])).timestamp));
  // Jump L1 time, then wait for the operator to see it: it extrapolates L1 time between
  // syncs, which tracks a real chain but not an evm_increaseTime jump.
  const warp = async (seconds) => {
    await rpc('evm_increaseTime', [seconds]);
    await rpc('evm_mine');
    const target = await l1Now();
    await waitFor('the operator to see the new L1 time', async () => {
      const r = await fetch(`${l2Url}/v1/status`);
      return r.ok && Number((await r.json()).l1Time) >= target;
    });
  };

  /** Node API. `jar` is a cookie jar object, `key` an API key; neither means no credentials. */
  async function api(method, url, { body, jar, key } = {}) {
    const res = await fetch(nodeUrl + url, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(jar ? { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (jar) {
      for (const c of res.headers.getSetCookie?.() || []) {
        const pair = c.split(';')[0];
        const i = pair.indexOf('=');
        if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
      }
    }
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json, text };
  }
  const ok = (r, status = 200) => {
    assert.equal(r.status, status, r.text);
    return r.json;
  };

  async function guardianCli(cmd, me, extra = []) {
    try {
      const { stdout } = await run(process.execPath, ['apps/node/scripts/rollup-guardian.mjs', cmd, '--me', me, ...extra], {
        cwd: ROOT,
        env: env({}),
      });
      return stdout;
    } catch (err) {
      throw new Error(`guardian:rollup ${cmd} failed: ${err.stderr || err.stdout || err.message}`);
    }
  }

  before(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'zkv-fullstack-'));
    writeFileSync(path.join(tmp, 'empty.env'), '');
    const [anvilPort, l2Port, nodePort] = [await freePort(), await freePort(), await freePort()];
    rpcUrl = `http://127.0.0.1:${anvilPort}`;

    // 1. L1: Anvil on chain 31337.
    start('anvil', [path.join(FOUNDRY, 'anvil'), '--port', String(anvilPort)], {});
    await waitFor('anvil', () => rpc('eth_chainId'));

    // 2. Deploy with the script a self-hoster runs. Governor is Anvil 0, operator Anvil 1,
    //    node clerk Anvil 2 (the Docker Compose layout).
    try {
      await run('bash', ['scripts/deploy.sh', '--target', 'local', '--rpc-url', rpcUrl], {
        cwd: ROOT,
        env: env({ OPERATOR: OPERATOR_ADDRESS, CLERK: CLERK_ADDRESS }),
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (err) {
      throw new Error(`deploy.sh failed:\n${err.stdout}\n${err.stderr}`);
    }
    deploymentFile = path.join(tmp, 'deployment.json');
    copyFileSync(path.join(CONTRACTS, 'deployments/local.json'), deploymentFile);
    deployment = JSON.parse(readFileSync(deploymentFile, 'utf8'));
    const deployBlock = Number(BigInt(await rpc('eth_blockNumber')));

    // 3. The L2 operator.
    const ballotToken = 'fullstack-ballot-token';
    start('operator', [process.execPath, 'l2/rollup/main.mjs'], {
      L1_RPC: rpcUrl,
      ROLLUP_DEPLOYMENT_FILE: deploymentFile,
      OPERATOR_PRIVATE_KEY: OPERATOR_KEY,
      ZK_VOTING_ALLOW_MOCK_PROOFS: '1',
      L2_DATA_DIR: path.join(tmp, 'l2'),
      L2_RPC_HOST: '127.0.0.1',
      L2_RPC_PORT: String(l2Port),
      L2_BALLOT_TOKEN: ballotToken,
      L2_BATCH_SECONDS: '1',
    });
    l2Url = `http://127.0.0.1:${l2Port}`;
    await waitFor('the L2 operator', async () => (await fetch(`${l2Url}/v1/status`)).ok);

    // 4. The node.
    nodeUrl = `http://127.0.0.1:${nodePort}`;
    start('node', [process.execPath, 'apps/node/src/server.mjs'], {
      NODE_ENV: 'development',
      ALLOW_DEV_LOGIN: '1',
      HOST: '127.0.0.1',
      PORT: String(nodePort),
      DATA_DIR: path.join(tmp, 'node'),
      FIRST_RUN_REDIRECT: '0',
      L1_RPC: rpcUrl,
      ROLLUP_DEPLOYMENT_FILE: deploymentFile,
      ROLLUP_PRIVATE_KEY: CLERK_KEY,
      ROLLUP_DEPLOY_BLOCK: String(Math.max(0, deployBlock - 20)),
      L2_URL: l2Url,
      L2_BALLOT_TOKEN: ballotToken,
      ROLLUP_TICK_SECONDS: '5',
    });
    await waitFor('the node', async () => (await fetch(`${nodeUrl}/health`)).ok);
  });

  after(async () => {
    const failed = process.exitCode || test.failed;
    for (const p of procs.reverse()) {
      p.child.stopping = true;
      p.child.kill('SIGTERM');
    }
    await sleep(300);
    if (process.env.FULLSTACK_KEEP || failed) {
      console.error(`full-stack logs kept in ${tmp}`);
      for (const p of procs) console.error(`--- ${p.name} (last 40 lines)\n${readFileSync(p.log, 'utf8').split('\n').slice(-40).join('\n')}`);
    } else {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('publish → key ceremony → roll → passes and ballots → close → decrypt → finalize → L1 audit', { timeout: 600_000 }, async () => {
    // --- The clerk drafts a civic vote and an officer API key for the guardian CLI.
    const admin = {};
    ok(await api('POST', '/api/auth/dev-login', { jar: admin, body: { handle: 'clerk', role: 'platform_admin' } }));
    const key = ok(await api('POST', '/api/me/api-keys', { jar: admin, body: { name: 'guardians', level: 'officer', expiresIn: '7d' } }), 201).secret;

    const now = await l1Now();
    const draft = ok(await api('POST', '/api/elections', {
      jar: admin,
      body: {
        title: 'Which park gets the new playground?',
        electionType: 'vote',
        startTime: now + 2 * 3600,
        cutoffTime: now + 3 * 3600,
        treeDepth: 16,
        questions: [{ type: 'SINGLE_CHOICE', prompt: 'Pick one', options: [{ label: 'North' }, { label: 'South' }, { label: 'East' }] }],
      },
    }), 201);
    const id = draft.id;
    const roll = (p = '') => `/api/elections/${id}/rollup${p}`;

    ok(await api('POST', roll('/prepare'), { jar: admin, body: { threshold: 2, minBallots: 3 } }));

    // --- Three guardians, each with their own key file.
    const guardians = [];
    for (const index of [1, 2, 3]) {
      const me = path.join(tmp, `guardian-${index}.json`);
      const { identityKey } = JSON.parse(await guardianCli('init', me));
      ok(await api('POST', roll('/guardians'), { jar: admin, body: { label: `Guardian ${index}`, identityKey } }), 201);
      guardians.push({ index, me });
    }
    const published = ok(await api('POST', roll('/publish'), { jar: admin, body: {} }), 201);
    assert.equal(published.l1.status, 'keygen');
    assert.equal(published.l1.rollup.toLowerCase(), deployment.rollup.toLowerCase());
    const electionId = published.l1.electionId;
    const cli = (g) => ['--node', nodeUrl, '--election', id, '--index', String(g.index), '--api-key', key];

    for (const g of guardians) await guardianCli('commit', g.me, cli(g));
    for (const g of guardians) await guardianCli('receive', g.me, cli(g));

    // --- Four voters register on the node and set a vote PIN.
    const voters = [];
    for (const i of [1, 2, 3, 4]) {
      const jar = {};
      ok(await api('POST', '/api/auth/dev-login', { jar, body: { handle: `voter-${i}`, role: 'voter' } }));
      const session = ok(await api('GET', '/api/auth/session', { jar }));
      const secret = 7000n + BigInt(i);
      const commitment = bc.poseidon2(6000n + BigInt(i), secret);
      ok(await api('POST', `/api/elections/${id}/register`, {
        jar: admin,
        body: { identityCommitment: commitment.toString(), userId: session.user.id },
      }), 201);
      ok(await api('POST', '/api/me/pin', { jar, body: { pin: '258046', confirmPin: '258046' } }));
      voters.push({ i, jar, secret, nullifier: bc.nullifierOf(secret, BigInt(electionId)) });
    }

    // --- Key ceremony ends; the roll goes to L1; the operator applies it.
    await warp(3601);
    const finalized = ok(await api('POST', roll('/finalize-key'), { jar: admin }));
    assert.equal(finalized.l1.status, 'scheduled');
    ok(await api('POST', roll('/roll/sync'), { jar: admin }));
    assert.equal(ok(await api('GET', roll(''))).rollSynced, 4);
    await waitFor('the operator to apply the roll', async () => {
      const r = await fetch(`${l2Url}/v1/elections/${electionId}`);
      return r.ok && (await r.json()).rollSize === 4;
    });

    // --- Voting opens (L1 time).
    await warp(3601);
    const context = ok(await api('GET', roll('/ballot-context')));
    assert.deepEqual(context.options.map((o) => o.label), ['North', 'South', 'East']);
    const choices = [2, 0, 2, 2];
    const passKey = ok(await api('GET', `/api/elections/${id}/vote-pass`));
    for (const [n, v] of voters.entries()) {
      const pin = ok(await api('POST', '/api/me/pin/verify', { jar: v.jar, body: { pin: '258046', purpose: 'vote' } }));
      const pending = await blindVotePass(passKey, id);
      const issued = ok(await api('POST', `/api/elections/${id}/vote-pass`, {
        jar: v.jar,
        body: { blinded: pending.blinded, pinToken: pin.pinToken },
      }), 201);
      v.pass = await unblindVotePass(passKey, id, pending, issued.blindSignature);
      const ballot = encryptRollupBallot({ context, choice: choices[n], nullifier: v.nullifier });
      // No cookie: the ballot request carries only the unlinkable pass.
      const cast = ok(await api('POST', `/api/elections/${id}/vote`, {
        body: { ...ballot, votePass: { token: v.pass.token, signature: v.pass.signature } },
      }), 201);
      assert.equal(cast.rollup, true);
    }

    // One pass per voter; one ballot per nullifier; a spent pass is refused.
    {
      const v = voters[0];
      const pin = ok(await api('POST', '/api/me/pin/verify', { jar: v.jar, body: { pin: '258046', purpose: 'vote' } }));
      const again = await api('POST', `/api/elections/${id}/vote-pass`, {
        jar: v.jar,
        body: { blinded: (await blindVotePass(passKey, id)).blinded, pinToken: pin.pinToken },
      });
      assert.equal(again.status, 409, again.text);
      const replay = await api('POST', `/api/elections/${id}/vote`, {
        body: { ...encryptRollupBallot({ context, choice: 1, nullifier: v.nullifier }), votePass: { token: v.pass.token, signature: v.pass.signature } },
      });
      assert.equal(replay.status, 409, replay.text);
    }

    for (const v of voters) {
      await waitFor(`voter ${v.i}'s receipt to settle`, async () => {
        const r = await api('GET', roll(`/receipts/${v.nullifier}`));
        return r.status === 200 && ['executed', 'settled'].includes(r.json.status);
      });
    }

    // --- Cutoff; anyone signed in may close. Guardians 1 and 2 decrypt the final sum.
    await warp(3601);
    ok(await api('POST', roll('/close'), { jar: voters[3].jar }));
    await waitFor('the final sum on L1', async () => (await api('GET', roll(''))).json?.accumulator);
    for (const g of guardians.slice(0, 2)) await guardianCli('decrypt', g.me, cli(g));
    // The node's tick may finalize first; then the explicit call is told so.
    const fin = await api('POST', roll('/finalize'), { jar: voters[3].jar });
    assert.ok(fin.status === 200 || (fin.status === 409 && /finalized/.test(fin.json?.error)), fin.text);

    const view = ok(await api('GET', roll('')));
    assert.equal(view.l1.status, 'finalized');
    assert.deepEqual(view.result.counts.map(String), ['1', '0', '3']);

    // --- Independent audit from L1 alone, then the node's outcomes page running the same audit.
    let audit;
    try {
      const { stdout } = await run(process.execPath, [
        'tools/auditor/cli.mjs', 'verify-rollup', '--rpc', rpcUrl, '--rollup', deployment.rollup, '--election', String(electionId),
      ], { cwd: ROOT, env: env({}) });
      audit = JSON.parse(stdout);
    } catch (err) {
      throw new Error(`verify-rollup failed: ${err.stdout || ''}${err.stderr || err.message}`);
    }
    assert.equal(audit.ok, true, JSON.stringify(audit.errors));
    assert.equal(audit.summary.status, 'finalized');
    assert.equal(Number(audit.summary.ballotCount), 4);
    assert.equal(Number(audit.summary.ballotsInPubdata), 4, 'every ballot is in executed batch pubdata');
    assert.deepEqual(audit.summary.counts, ['1', '0', '3']);
    assert.ok(audit.checks.length > 0);

    const outcome = ok(await api('GET', `/api/outcomes/${id}`));
    assert.equal(outcome.verification.l1?.ok, true, JSON.stringify(outcome.verification));
  });
});

#!/usr/bin/env node
// NOT FOR PROFIT — civic public good, not a commercial product.
// Run the L2 operator: follow ZkVotingRollup on L1, accept ballots, settle batches.
//
// Two opt-in flags, both off by default. They do not combine.
//   L2_ALLOW_DEGRADED=1            listen first, then retry init. /health is
//                                  "degraded" until the rollup is usable. This
//                                  path owns the process when the flag is on,
//                                  including safety failures that the standby
//                                  path would exit on.
//   L2_STANDBY_WHEN_UNCONFIGURED   only when L2_ALLOW_DEGRADED is off. Stay up
//                                  with /health status "standby" and do not
//                                  retry. Restart l2 after the rollup is fixed.
//                                  Safety refusals still exit.
// With both flags off, startup checks still exit the process.
//
// Environment:
//   L1_RPC                     L1 JSON-RPC (Anvil locally)
//   L1_RPC_AUTH_TOKEN          optional bearer token; empty sends no Authorization header
//   L1_CHAIN_ID                defaults to the RPC's chain id
//   ROLLUP_ADDRESS             ZkVotingRollup
//   ROLLUP_DEPLOYMENT_FILE     deployment record (DeployLocal output); fills ROLLUP_ADDRESS
//                              and L1_CHAIN_ID when they are unset
//   OPERATOR_PRIVATE_KEY       an operator registered with setOperator
//   L2_DATA_DIR                private operator state (default ./data)
//   L2_RPC_HOST / L2_RPC_PORT  API bind (default 127.0.0.1:8546)
//   L2_BATCH_SECONDS           how often the operator checks for work (default 10)
//   L2_BATCH_MAX_WAIT_SECONDS  how long ballots may wait for a fuller batch (default 0 on
//                              chain 31337, 600 elsewhere); each batch costs L1 gas
//   L2_BALLOT_TOKEN            bearer token the node uses to submit ballots
//   L2_ALLOW_DEGRADED          empty/false: this path is off. 1: stay up and retry
//   ZK_VOTING_ALLOW_MOCK_PROOFS=1  accept ballots without an eligibility proof (local only)
//   L2_STANDBY_WHEN_UNCONFIGURED=true  opt-in, and only when L2_ALLOW_DEGRADED is off

import { createRequire } from 'node:module';
import { allowDegraded, startOperator, redactOperatorLog } from './boot.mjs';
import { redactL1RpcAuth } from '../l1RpcAuth.js';
import { createApi, createStandbyApi } from './server.mjs';

// First line before loading l1.mjs (viem): names only, never RPC/key/token values.
{
  const has = (name) => (String(process.env[name] || '').trim() ? 'set' : 'unset');
  const names = ['L1_RPC', 'L1_RPC_AUTH_TOKEN', 'L1_CHAIN_ID', 'ROLLUP_ADDRESS', 'ROLLUP_DEPLOYMENT_FILE', 'OPERATOR_PRIVATE_KEY'];
  console.log(
    `zk-voting l2 starting: node ${process.version}, degraded mode ${allowDegraded(process.env) ? 'on' : 'off'},`,
    `standby flag ${has('L2_STANDBY_WHEN_UNCONFIGURED')},`,
    names.map((n) => `${n} ${has(n)}`).join(', '),
  );
}

if (allowDegraded(process.env)) {
  try {
    await startOperator({ env: process.env });
  } catch (err) {
    console.error('L2 operator failed to listen:', redactOperatorLog(err?.message || 'unknown error'));
    process.exit(2);
  }
} else {
  const env = process.env;
  const host = env.L2_RPC_HOST || '127.0.0.1';
  const port = Number(env.L2_RPC_PORT || 8546);
  const standbyAllowed = /^(1|true|yes|on)$/i.test(String(env.L2_STANDBY_WHEN_UNCONFIGURED || '').trim());
  const log = (...a) => console.log(new Date().toISOString(), ...a);

  /** A safety refusal: always exits, standby or not. */
  const refuse = (message) => {
    console.error(message);
    process.exit(2);
  };

  /** The rollup is not usable. Exit as before, or (opt-in) stay up in standby. */
  class Unusable extends Error {}
  const need = (name) => {
    if (!env[name]) throw new Unusable(`${name} is required`);
    return env[name];
  };

  const { assertKeyAllowedOnChain, readDeployment } = createRequire(import.meta.url)('../../packages/chain-client/index.js');
  const allowMockProofs = env.ZK_VOTING_ALLOW_MOCK_PROOFS === '1';
  let chainId = env.L1_CHAIN_ID ? Number(env.L1_CHAIN_ID) : null;

  async function start() {
    const { createL1, readL1ChainId } = await import('./l1.mjs');
    const { Operator } = await import('./operator.mjs');
    let deployment;
    try {
      deployment = readDeployment(env.ROLLUP_DEPLOYMENT_FILE);
    } catch (err) {
      throw new Unusable(err.message);
    }
    if (env.ROLLUP_DEPLOYMENT_FILE && !deployment) {
      throw new Unusable(`ROLLUP_DEPLOYMENT_FILE ${env.ROLLUP_DEPLOYMENT_FILE} does not exist yet`);
    }
    if (!env.ROLLUP_ADDRESS && deployment) env.ROLLUP_ADDRESS = deployment.rollup;

    const rpcUrl = need('L1_RPC');
    if (chainId == null) {
      try {
        chainId = Number(await readL1ChainId(rpcUrl, env));
      } catch (err) {
        throw new Unusable(`L1 chain id unavailable: ${err.shortMessage || err.message}`);
      }
    }
    try {
      assertKeyAllowedOnChain(env.OPERATOR_PRIVATE_KEY, chainId, 'OPERATOR_PRIVATE_KEY');
    } catch (err) {
      refuse(err.message);
    }
    if (allowMockProofs && chainId !== 31337) refuse('ZK_VOTING_ALLOW_MOCK_PROOFS is for chain 31337 only');

    const l1 = createL1({ rpcUrl, chainId, rollup: need('ROLLUP_ADDRESS'), privateKey: need('OPERATOR_PRIVATE_KEY') });
    let operator;
    try {
      operator = await new Operator({
        l1,
        chainId,
        dataDir: env.L2_DATA_DIR || './data',
        allowMockProofs,
        batchMaxWaitSeconds:
          env.L2_BATCH_MAX_WAIT_SECONDS != null && env.L2_BATCH_MAX_WAIT_SECONDS !== ''
            ? Number(env.L2_BATCH_MAX_WAIT_SECONDS)
            : chainId === 31337
              ? 0
              : 600,
        log,
      }).init();
    } catch (err) {
      if (!standbyAllowed) throw err;
      throw new Unusable(`rollup at ${l1.address} is not usable: ${err.shortMessage || err.message}`);
    }

    let mock;
    try {
      mock = await l1.isMockVerifier();
    } catch (err) {
      if (!standbyAllowed) throw err;
      throw new Unusable(`cannot read the rollup's batch verifier: ${err.shortMessage || err.message}`);
    }
    if (!mock) throw new Unusable('This operator has no batch prover yet; it can only settle against MockBatchVerifier.');
    return { l1, operator };
  }

  let started;
  try {
    started = await start();
  } catch (err) {
    if (!(err instanceof Unusable)) {
      console.error('L2 startup failed:', redactOperatorLog(err?.message || 'unknown error', env));
      throw err;
    }
    const reason = redactL1RpcAuth(err.message, env);
    if (!standbyAllowed) refuse(reason);
    // Standby: liveness only. No Operator, no batch loop, no L1 writes.
    console.error(`L2 STANDBY (not ready): ${reason}`);
    console.error('L2 STANDBY: no ballots are accepted and nothing is sent to L1. Fix the rollup settings and restart l2.');
    createStandbyApi({ reason, chainId: Number.isFinite(chainId) ? chainId : null, rollup: env.ROLLUP_ADDRESS || null }).listen(
      port,
      host,
      () => log(`L2 operator in STANDBY on http://${host}:${port} (/health answers status "standby")`),
    );
  }

  if (started) {
    const { l1, operator } = started;
    createApi(operator, { ballotToken: env.L2_BALLOT_TOKEN }).listen(port, host, () => {
      console.log(`L2 operator for ${l1.address} on http://${host}:${port}`);
    });

    const interval = Math.max(1, Number(env.L2_BATCH_SECONDS || 10)) * 1000;
    setInterval(() => {
      operator.tick().catch((err) => console.error('batch failed:', redactL1RpcAuth(err.shortMessage || err.message, env)));
    }, interval);
  }
}

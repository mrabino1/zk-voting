#!/usr/bin/env node
// NOT FOR PROFIT — civic public good, not a commercial product.
// Run the L2 operator: follow ZkVotingRollup on L1, accept ballots, settle batches.
//
// Environment:
//   L1_RPC                     L1 JSON-RPC (Anvil locally)
//   L1_CHAIN_ID                defaults to the RPC's chain id
//   ROLLUP_ADDRESS             ZkVotingRollup
//   OPERATOR_PRIVATE_KEY       an operator registered with setOperator
//   L2_DATA_DIR                private operator state (default ./data)
//   L2_RPC_HOST / L2_RPC_PORT  API bind (default 127.0.0.1:8546)
//   L2_BATCH_SECONDS           batch interval (default 10)
//   L2_BALLOT_TOKEN            bearer token the node uses to submit ballots
//   ZK_VOTING_ALLOW_MOCK_PROOFS=1  accept ballots without an eligibility proof (local only)

import { createPublicClient, http } from 'viem';

import { createL1 } from './l1.mjs';
import { Operator } from './operator.mjs';
import { createApi } from './server.mjs';

const env = process.env;
const need = (name) => {
  if (!env[name]) {
    console.error(`${name} is required`);
    process.exit(2);
  }
  return env[name];
};

const rpcUrl = need('L1_RPC');
const chainId = Number(env.L1_CHAIN_ID || (await createPublicClient({ transport: http(rpcUrl) }).getChainId()));
const allowMockProofs = env.ZK_VOTING_ALLOW_MOCK_PROOFS === '1';
if (allowMockProofs && chainId !== 31337) {
  console.error('ZK_VOTING_ALLOW_MOCK_PROOFS is for chain 31337 only');
  process.exit(2);
}

const l1 = createL1({ rpcUrl, chainId, rollup: need('ROLLUP_ADDRESS'), privateKey: need('OPERATOR_PRIVATE_KEY') });
const operator = await new Operator({
  l1,
  chainId,
  dataDir: env.L2_DATA_DIR || './data',
  allowMockProofs,
  log: (...a) => console.log(new Date().toISOString(), ...a),
}).init();

if (!(await l1.isMockVerifier())) {
  console.error('This operator has no batch prover yet; it can only settle against MockBatchVerifier.');
  process.exit(2);
}

const host = env.L2_RPC_HOST || '127.0.0.1';
const port = Number(env.L2_RPC_PORT || 8546);
createApi(operator, { ballotToken: env.L2_BALLOT_TOKEN }).listen(port, host, () => {
  console.log(`L2 operator for ${l1.address} on http://${host}:${port}`);
});

const interval = Math.max(1, Number(env.L2_BATCH_SECONDS || 10)) * 1000;
setInterval(() => {
  operator.tick().catch((err) => console.error('batch failed:', err.shortMessage || err.message));
}, interval);

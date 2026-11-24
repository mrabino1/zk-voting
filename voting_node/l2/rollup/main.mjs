#!/usr/bin/env node
// NOT FOR PROFIT — civic public good, not a commercial product.
// Run the L2 operator: follow ZkVotingRollup on L1, accept ballots, settle batches.
//
// The HTTP server listens before Operator.init and before any L1 read. Startup
// checks (missing or unusable ROLLUP_ADDRESS / OPERATOR_PRIVATE_KEY, L1 chain
// id, rollup genesis, batch prover) still stop the process unless
// L2_ALLOW_DEGRADED is 1, true, yes, or on. That flag is off by default:
// empty or false keeps this fail-fast exit. When it is on, /health stays
// HTTP 200 with status "degraded" and init is retried. Nothing is batched,
// proved, or submitted to L1 until init succeeds.
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
//   L2_ALLOW_DEGRADED          empty/false: exit if startup checks fail. 1: stay up and retry
//   ZK_VOTING_ALLOW_MOCK_PROOFS=1  accept ballots without an eligibility proof (local only)

import { startOperator } from './boot.mjs';

try {
  await startOperator({ env: process.env });
} catch (err) {
  console.error(err?.message || 'L2 operator failed to listen');
  process.exit(2);
}

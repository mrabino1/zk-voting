#!/usr/bin/env node
// NOT FOR PROFIT — civic public good, not a commercial sequencer.
// ZK-Voting L2 sequencer: civic mempool, blocks on demand plus an hourly heartbeat.
import { loadConfig, ChainState } from './state.mjs';
import { createRpcServer } from '../rpc/server.mjs';

const config = loadConfig();
const state = ChainState.open(config);
const rpc = createRpcServer(state);

const { host, port } = await rpc.listen();
state.armProducer();

console.log(
  `ZK-Voting L2 sequencer  chainId=${config.chainId}  rpc=http://${host}:${port}  head=${state.latestNumber}  skipEmpty=${config.skipEmptyBlocks}  heartbeat=${config.heartbeatSeconds}s`,
);
console.log('NOT FOR PROFIT — our L2, our prover. Voters are gasless. No token.');

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  console.log('sequencer stopping');
  try {
    await state.stop();
    await rpc.close();
  } catch (err) {
    console.warn('sequencer shutdown:', err.message || err);
  }
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

#!/usr/bin/env node
// NOT FOR PROFIT — civic public good, not a commercial sequencer.
// ZK-Voting L2 sequencer: civic mempool, blocks on demand plus an hourly heartbeat.
import { loadConfig, ChainState } from './state.mjs';
import { createRpcServer } from '../rpc/server.mjs';
import { resolveIdentityAsync } from '../identity.mjs';

const config = loadConfig();
config.identity = await resolveIdentityAsync(process.env);
const state = ChainState.open(config);
const rpc = createRpcServer(state);

const { host, port } = await rpc.listen();
state.armProducer();

console.log(
  `ZK-Voting L2 sequencer  chainId=${config.chainId}  rpc=http://${host}:${port}  head=${state.latestNumber}  skipEmpty=${config.skipEmptyBlocks}  heartbeat=${config.heartbeatSeconds}s`,
);
console.log('NOT FOR PROFIT — our L2, our prover. Voters are gasless. No token.');
console.log(
  `L2 identity  uuid=${config.identity.l2Uuid || '(unset)'}  l2Id=${config.identity.l2Id || '(unset)'}  admission=${config.admission}  adminWrites=${Boolean(config.adminSecret)}`,
);
if (config.admission !== 'strict') {
  console.warn('L2_ADMISSION=open: any caller can open elections and submit civic txs. Use strict for a real election.');
} else if (!config.adminSecret) {
  console.warn('L2_ADMISSION=strict but L2_ADMIN_SECRET is empty: every admin write will be rejected.');
}

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

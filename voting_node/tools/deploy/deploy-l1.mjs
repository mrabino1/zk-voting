#!/usr/bin/env node
// NOT FOR PROFIT — civic public good, not a commercial product.
// Check or verify the one ZkVotingRollup deployment. It never broadcasts: deploy with
// scripts/deploy.sh (or Docker Compose's l1-deploy on a local chain).
//
//   npm run deploy:l1 -- --check    refuse (exit 2) when a rollup is already deployed
//   npm run deploy:l1 -- --verify   ROLLUP_ADDRESS (or the record) has code; print the .env lines
//
// Reads L1_RPC, ROLLUP_ADDRESS, FORCE_REDEPLOY and DEPLOYMENTS_FILE from the env or voting_node/.env.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assessDeploy,
  chainIdOf,
  deploymentRecordPath,
  formatEnvLines,
  hasCode,
  readDeploymentRecord,
  recordRollup,
  verifyDeployedCode,
} from './l1Guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CONTRACTS = path.resolve(ROOT, '../smart-contracts');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] != null && process.env[key] !== '') continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadDotEnv(path.join(ROOT, '.env'));

const mode = process.argv.includes('--verify') ? 'verify' : process.argv.includes('--check') ? 'check' : null;
if (!mode) {
  console.error('usage: deploy-l1.mjs --check | --verify');
  process.exit(2);
}
const rpcUrl = String(process.env.L1_RPC || process.env.L1_RPC_URL || '').trim();
if (!rpcUrl) {
  console.error('L1_RPC is required (from the host, the RPC of the L1 you deploy to)');
  process.exit(2);
}

const chainId = await chainIdOf(rpcUrl);
const recordFile = process.env.DEPLOYMENTS_FILE || deploymentRecordPath(CONTRACTS, chainId);
const record = readDeploymentRecord(recordFile);
const recorded = recordRollup(record);

if (mode === 'check') {
  const decision = assessDeploy({
    env: process.env,
    record,
    recordHasCode: recorded ? await hasCode(rpcUrl, recorded) : false,
  });
  if (!decision.ok) {
    console.error(`refusing to deploy: ${decision.reason} (${decision.pinned || decision.recorded})`);
    console.error(`record: ${recordFile}`);
    console.error('Set FORCE_REDEPLOY=1 only when you intend to replace the chain of record.');
    process.exit(2);
  }
  if (decision.warning) console.error(`WARNING: ${decision.warning}`);
  console.log(`ready to deploy on chain ${chainId}: ./scripts/deploy.sh --target ${chainId === 31337 ? 'local' : 'public'}`);
  process.exit(0);
}

const rollup = String(process.env.ROLLUP_ADDRESS || '').trim() || recorded;
if (!rollup) {
  console.error(`no ROLLUP_ADDRESS and no record at ${recordFile}`);
  process.exit(2);
}
await verifyDeployedCode(rpcUrl, rollup);
console.log(formatEnvLines({ rollup, chainId }));

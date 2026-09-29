#!/usr/bin/env node
// NOT FOR PROFIT — civic public good, not a commercial product.
// One-time L1 deploy entrypoint. Do not run this from the node, sequencer,
// prover, or archive containers. Those processes only read the addresses.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assessDeploy,
  deploymentRecordPath,
  formatEnvLines,
  readDeploymentRecord,
  verifyAddressSet,
  writeDeploymentRecord,
} from './l1Guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

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
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadDotEnv(path.join(ROOT, '.env'));

const chainId = String(process.env.L1_CHAIN_ID || process.env.CHAIN_ID || '1');
const recordFile =
  process.env.DEPLOYMENTS_FILE ||
  (process.env.DATA_DIR
    ? path.join(process.env.DATA_DIR, 'deployments', `${chainId}.json`)
    : deploymentRecordPath(ROOT, chainId));
const record = readDeploymentRecord(recordFile);
const decision = assessDeploy({ env: process.env, record });

if (!decision.ok) {
  console.error(`refusing L1 deploy: ${decision.reason}`);
  if (decision.setKeys.length) {
    console.error(`already set: ${decision.setKeys.join(', ')}`);
  }
  if (decision.recordDeployed) console.error(`record: ${recordFile}`);
  console.error('Set FORCE_REDEPLOY=1 only when you intend to replace the chain of record.');
  process.exit(2);
}

if (decision.warning) {
  console.error('WARNING');
  console.error(decision.warning);
}

if (process.argv.includes('--check')) {
  console.log('deploy check passed');
  process.exit(0);
}

console.error(
  'This entrypoint refuses a second deploy. Broadcast with forge only after this check passes:',
);
console.error(
  `  DEPLOYMENTS_FILE=${recordFile} forge script smart-contracts/script/DeployL1.s.sol --rpc-url "$L1_RPC" --broadcast --private-key "$L1_PUBLISHER_PRIVATE_KEY"`,
);
console.error('Containers must not run that script. Paste the resulting addresses into .env.');
console.error('After broadcast, re-run with --verify and the address env vars set.');

if (process.argv.includes('--verify')) {
  const rpc = process.env.L1_RPC || process.env.L1_RPC_URL || '';
  if (!rpc) {
    console.error('L1_RPC is required for --verify');
    process.exit(2);
  }
  const addresses = {};
  for (const key of [
    'SETTLEMENT_ADDRESS',
    'VERIFIER_ADDRESS',
    'L1_TALLY_MIRROR_ADDRESS',
    'L1_SETTLEMENT_ADDRESS',
    'ELECTION_FACTORY_ADDRESS',
    'BALLOT_INBOX_ADDRESS',
  ]) {
    if (String(process.env[key] || '').trim()) addresses[key] = process.env[key].trim();
  }
  if (!Object.keys(addresses).length) {
    console.error('no addresses to verify');
    process.exit(2);
  }
  const checked = await verifyAddressSet(rpc, addresses);
  const saved = {
    deployed: true,
    chainId,
    addresses,
    codeBytes: Object.fromEntries(Object.entries(checked).map(([key, code]) => [key, (code.length - 2) / 2])),
    verifiedAt: new Date().toISOString(),
  };
  writeDeploymentRecord(recordFile, saved);
  console.log(formatEnvLines(addresses));
  console.error(`recorded ${recordFile}`);
  process.exit(0);
}

console.log('ready: no pinned address and no deployment record');
process.exit(0);

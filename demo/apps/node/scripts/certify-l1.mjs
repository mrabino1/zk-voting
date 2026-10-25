#!/usr/bin/env node
// NOT FOR PROFIT — civic public good, not a commercial product.
//
// Post a tally hash to L1TallyMirror after the Node has tallied.
// Graceful exit 0 when L1 env is unset (no mainnet keys required).
//
// Usage:
//   node apps/node/scripts/certify-l1.mjs --election-id 1 --counts 2,0
//   node apps/node/scripts/certify-l1.mjs --election-id 1 --from-store
//
// Env: L1_RPC, L1_TALLY_MIRROR_ADDRESS, L1_PUBLISHER_PRIVATE_KEY
// Optional: L1_SETTLEMENT_ADDRESS, L1_CHAIN_ID, DATA_DIR, TOTAL_BALLOTS, L2_STATE_ROOT

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { electionMatchesRef, l1IdentityOf } from '../src/electionIds.mjs';

const require = createRequire(import.meta.url);
const {
  computeTallyHash,
  l1SkipReason,
  postTallyHash,
  publicCertification,
  readL1Env,
  alreadyPostedError,
} = require('@zk-voting/chain-client');

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return null;
  return process.argv[i + 1] ?? '';
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function parseCounts(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (trimmed.startsWith('[')) return JSON.parse(trimmed);
  return trimmed.split(',').map((s) => {
    const n = Number(s.trim());
    if (!Number.isInteger(n) || n < 0) throw new Error(`bad count: ${s}`);
    return n;
  });
}

async function loadFromStore(electionId) {
  const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dataDir = process.env.DATA_DIR || path.join(pkgRoot, 'data');
  const file = path.join(dataDir, 'republic.json');
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  const election = (raw.elections || []).find(
    (e) => String(e.id) === String(electionId) || electionMatchesRef(e, electionId),
  );
  if (!election) throw new Error(`election ${electionId} not in ${file}`);
  if (!election.tally?.counts) throw new Error(`election ${electionId} has no Node tally yet`);
  return election;
}

async function main() {
  if (hasFlag('--help') || hasFlag('-h')) {
    console.log(`Republic L1 tally certification (NOT FOR PROFIT)

After POST /api/elections/:id/tally, copy keccak256(abi.encodePacked(counts))
to L1TallyMirror.postResult when L1 env is set. Unset env → no-op (exit 0).

  node apps/node/scripts/certify-l1.mjs --election-id ID --counts 2,0
  node apps/node/scripts/certify-l1.mjs --election-id ID --from-store

Env: L1_RPC  L1_TALLY_MIRROR_ADDRESS  L1_PUBLISHER_PRIVATE_KEY
Optional: L1_SETTLEMENT_ADDRESS  L1_CHAIN_ID  TOTAL_BALLOTS  L2_STATE_ROOT  DATA_DIR`);
    return;
  }

  const skip = l1SkipReason();
  const electionId = argValue('--election-id') || argValue('-e') || process.env.ELECTION_ID;
  let counts = parseCounts(argValue('--counts') || process.env.COUNTS || '');
  let totalBallots = process.env.TOTAL_BALLOTS ? Number(process.env.TOTAL_BALLOTS) : null;
  let resultHash = argValue('--result-hash') || process.env.RESULT_HASH || null;
  const l2StateRoot = argValue('--l2-state-root') || process.env.L2_STATE_ROOT || null;

  let storedElection = null;
  if (hasFlag('--from-store') || hasFlag('--from-node-store')) {
    if (!electionId) {
      console.error('certify-l1: --election-id required with --from-store');
      process.exit(1);
    }
    storedElection = await loadFromStore(electionId);
    counts = counts || storedElection.tally.counts;
    totalBallots = totalBallots ?? storedElection.acceptedBallots;
    resultHash = resultHash || storedElection.tally.countsHash || computeTallyHash(counts);
  }

  if (skip) {
    const preview = counts ? computeTallyHash(counts) : resultHash;
    console.log(
      JSON.stringify(
        {
          nfp: true,
          skipped: true,
          posted: false,
          status: 'skipped',
          reason: skip,
          electionId: electionId || null,
          resultHash: preview || null,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (!electionId) {
    console.error('certify-l1: --election-id required when L1 env is set');
    process.exit(1);
  }
  if (!counts && !resultHash) {
    console.error('certify-l1: --counts, --result-hash, or --from-store required when L1 env is set');
    process.exit(1);
  }

  const env = readL1Env();
  const identity = storedElection
    ? l1IdentityOf(storedElection, {
        electionFactoryAddress: process.env.ELECTION_FACTORY_ADDRESS || process.env.FACTORY,
      })
    : {};
  const result = await postTallyHash({
    electionId: identity.electionId || electionId,
    counts,
    resultHash,
    totalBallots: totalBallots ?? (counts ? counts.reduce((a, b) => a + Number(b), 0) : 0),
    l2StateRoot,
    rpcUrl: env.rpcUrl,
    mirrorAddress: env.mirrorAddress,
    privateKey: env.privateKey,
    settlementAddress: env.settlementAddress,
    chainId: env.chainId,
    factory: identity.factory || process.env.ELECTION_FACTORY_ADDRESS || process.env.FACTORY,
    jurisdictionId: identity.jurisdictionId || process.env.JURISDICTION_ID,
    publicId: identity.publicId,
    publicIdHash: identity.publicIdHash,
    electionAddress: identity.electionAddress,
    ballotSpecHash: identity.ballotSpecHash,
  });
  console.log(JSON.stringify({ nfp: true, ...publicCertification(result), result }, null, 2));
  if (result.status === 'failed') process.exit(1);
}

main().catch((err) => {
  if (alreadyPostedError(err)) {
    console.log(
      JSON.stringify(
        {
          nfp: true,
          ...publicCertification({
            status: 'already_posted',
            alreadyPosted: true,
            reason: 'AlreadyPosted',
          }),
        },
        null,
        2,
      ),
    );
    return;
  }
  console.error(err);
  process.exit(1);
});

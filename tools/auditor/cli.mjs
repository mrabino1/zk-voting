#!/usr/bin/env node
// NOT FOR PROFIT — civic public good, not a commercial product.
// Independent auditor CLI. Export public artifacts and verify invariants
// without the Node private DB (apps/node/data/republic.json).

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { exportFromChain, exportFromNode } from './export.mjs';
import { verifyAuditorBundle, AUDITOR_SCHEMA } from './verify.mjs';

function usage() {
  return `Republic auditor (NOT FOR PROFIT)

Verify a public election without the Node private database.

Usage:
  node tools/auditor/cli.mjs verify --file bundle.json
  node tools/auditor/cli.mjs export-node --base http://127.0.0.1:3000 --election 1 [--out bundle.json]
  node tools/auditor/cli.mjs export-chain --rpc http://127.0.0.1:8545 --factory 0x… --election 1 [--out bundle.json]
  node tools/auditor/cli.mjs verify-node --base http://127.0.0.1:3000 --election 1
  node tools/auditor/cli.mjs fixture

Schema: ${AUDITOR_SCHEMA}
`;
}

function arg(flag, argv, fallback) {
  const i = argv.indexOf(flag);
  if (i === -1 || i === argv.length - 1) return fallback;
  return argv[i + 1];
}

function printResult(result, bundle) {
  const payload = {
    ok: result.ok,
    nfp: true,
    schema: AUDITOR_SCHEMA,
    errors: result.errors,
    checks: result.checks,
    summary: result.summary,
    electionId: bundle?.electionId,
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  return result.ok ? 0 : 2;
}

async function readJson(filePath) {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

function sampleBundle() {
  return {
    schema: AUDITOR_SCHEMA,
    nfp: true,
    product: 'Republic',
    chainId: 27427,
    electionId: '1',
    contracts: {
      factory: '0x1111111111111111111111111111111111111111',
      ballotInbox: '0x2222222222222222222222222222222222222222',
      verifier: '0x3333333333333333333333333333333333333333',
    },
    roots: {
      eligibleRoot: `0x${'11'.repeat(32)}`,
      disqualificationRoot: `0x${'00'.repeat(32)}`,
      ballotSpecHash: `0x${'ab'.repeat(32)}`,
    },
    window: { startTime: 1_700_000_000, cutoffTime: 1_700_086_400 },
    rollFrozen: true,
    publicAcceptedBallots: 2,
    acceptedBallots: 2,
    disclosedBallots: [
      {
        nullifier: `0x${'01'.repeat(32)}`,
        ballotHash: `0x${'aa'.repeat(32)}`,
        electionId: '1',
        relayer: 'node',
        generation: 2,
        supersededHashes: [`0x${'99'.repeat(32)}`],
      },
      {
        nullifier: `0x${'02'.repeat(32)}`,
        ballotHash: `0x${'bb'.repeat(32)}`,
        electionId: '1',
        relayer: 'node',
        generation: 1,
        supersededHashes: [],
      },
    ],
    tally: { counts: [1, 1], postedAt: '2026-09-14T00:00:00.000Z' },
    coercion: {
      policy: 'last-ballot-counts',
      receiptsProveChoice: false,
    },
  };
}

async function main(argv) {
  const cmd = argv[0] || 'help';
  if (cmd === 'help' || cmd === '-h' || cmd === '--help') {
    process.stdout.write(usage());
    return 0;
  }

  if (cmd === 'fixture') {
    const out = arg('--out', argv);
    const bundle = sampleBundle();
    const text = `${JSON.stringify(bundle, null, 2)}\n`;
    if (out) await writeFile(out, text);
    else process.stdout.write(text);
    return 0;
  }

  if (cmd === 'verify') {
    const file = arg('--file', argv) || arg('-f', argv);
    if (!file) {
      process.stderr.write('verify requires --file bundle.json\n');
      return 1;
    }
    const bundle = await readJson(path.resolve(file));
    return printResult(verifyAuditorBundle(bundle), bundle);
  }

  if (cmd === 'export-node' || cmd === 'verify-node') {
    const base = arg('--base', argv) || arg('--node', argv) || 'http://127.0.0.1:3000';
    const election = arg('--election', argv) || arg('--id', argv);
    if (!election) {
      process.stderr.write('export-node requires --election <id>\n');
      return 1;
    }
    const bundle = await exportFromNode(base, election);
    if (cmd === 'export-node') {
      const out = arg('--out', argv);
      const text = `${JSON.stringify(bundle, null, 2)}\n`;
      if (out) await writeFile(out, text);
      else process.stdout.write(text);
      if (out) {
        const result = verifyAuditorBundle(bundle);
        process.stderr.write(`wrote ${out} ok=${result.ok}\n`);
      }
      return 0;
    }
    return printResult(verifyAuditorBundle(bundle), bundle);
  }

  if (cmd === 'export-chain') {
    const rpcUrl = arg('--rpc', argv) || process.env.REPUBLIC_RPC_URL || 'http://127.0.0.1:8545';
    const factory = arg('--factory', argv) || process.env.ELECTION_FACTORY_ADDRESS;
    const election = arg('--election', argv) || arg('--id', argv);
    if (!factory || !election) {
      process.stderr.write('export-chain requires --factory 0x… and --election <id>\n');
      return 1;
    }
    const bundle = await exportFromChain({ rpcUrl, factory, electionId: election });
    const out = arg('--out', argv);
    const text = `${JSON.stringify(bundle, null, 2)}\n`;
    if (out) await writeFile(out, text);
    else process.stdout.write(text);
    return 0;
  }

  process.stderr.write(usage());
  return 1;
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('cli.mjs');
if (isMain) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`${err.stack || err.message || err}\n`);
      process.exit(1);
    });
}

export { main, sampleBundle };

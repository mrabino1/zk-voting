#!/usr/bin/env node
// NOT FOR PROFIT — civic public good, not a commercial product.
// Guardian CLI for Feldman distributed key generation and threshold decryption.
// Secret files stay on the guardian machine. Deals and partials are what an
// admin posts to the Node.

import { readFile, writeFile } from 'node:fs/promises';

import {
  createSealedDeal,
  finalizeShare,
  initGuardian,
  partialDecrypt,
} from '../src/guardians/index.mjs';
import { ephemeralFromEnvelope, verifyPartial } from '../src/guardians/threshold.mjs';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function usage() {
  return `ZK-Voting guardian CLI (NOT FOR PROFIT, NON-PRODUCTION)

  init --index N --out guardian.json [--id name] [--label text]
  deal --secret guardian.json --threshold T --roster roster.json --out deal.json
  finalize --secret guardian.json --deals a.json,b.json --threshold T --guardians N --out share.json
  partial --share share.json --election ID --envelopes envelopes.json --out partials.json
  verify --partial partials.json --ceremony ceremony.json --envelope 0x... --ballot-hash 0x... --election ID --index N

  enroll --base URL --election ID --secret guardian.json [--cookie "a=b"]
  post-deal --base URL --election ID --deal deal.json [--cookie "a=b"]
  post-partials --base URL --election ID --partials partials.json [--cookie "a=b"]

roster.json is [{ "index": 1, "transportPublicKey": "0x04..." }, ...]
envelopes.json is { "envelopes": [{ "ballotHash", "encryptedBallot" }] }
ceremony.json is the public tally-key ceremony (verificationKeys, publicKey).
Share files contain the guardian secret. Do not upload them.
`;
}

async function postJson(args, path, body) {
  const base = String(args.base || '').replace(/\/$/, '');
  if (!base || !args.election) throw new Error('--base and --election are required');
  const res = await fetch(`${base}/api/elections/${encodeURIComponent(args.election)}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(args.cookie ? { cookie: String(args.cookie) } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text}`);
  process.stdout.write(`${text}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || args.help) {
    process.stdout.write(usage());
    process.exit(cmd ? 0 : 1);
  }

  if (cmd === 'init') {
    const index = Number(args.index);
    if (!args.out || !Number.isInteger(index) || index < 1) throw new Error('init requires --index and --out');
    const secret = await initGuardian({ index, guardianId: args.id, label: args.label });
    await writeJson(args.out, secret);
    process.stdout.write(
      `wrote ${args.out} index=${index} transport=${secret.transportPublicKey}\nprivate file; do not upload\n`,
    );
    return;
  }

  if (cmd === 'deal') {
    if (!args.secret || !args.roster || !args.out) throw new Error('deal requires --secret, --roster, and --out');
    const secret = await readJson(args.secret);
    const roster = await readJson(args.roster);
    const threshold = Number(args.threshold);
    const deal = await createSealedDeal({
      index: secret.index,
      threshold,
      roster,
    });
    await writeJson(args.out, deal);
    process.stdout.write(`wrote ${args.out} (commitments and encrypted shares only)\n`);
    return;
  }

  if (cmd === 'finalize') {
    if (!args.secret || !args.deals || !args.out) {
      throw new Error('finalize requires --secret, --deals, and --out');
    }
    const secret = await readJson(args.secret);
    const deals = [];
    for (const file of String(args.deals).split(',')) {
      const deal = await readJson(file.trim());
      deals.push(deal);
    }
    const share = await finalizeShare({
      index: secret.index,
      privateJwk: secret.transportPrivateJwk,
      deals,
      threshold: Number(args.threshold),
      guardianCount: Number(args.guardians || deals.length),
    });
    await writeJson(args.out, { ...share, guardianId: secret.guardianId });
    process.stdout.write(`wrote ${args.out} joint=${share.jointPublicKey}\nshare file; do not upload\n`);
    return;
  }

  if (cmd === 'partial') {
    if (!args.share || !args.envelopes || !args.out || !args.election) {
      throw new Error('partial requires --share, --election, --envelopes, and --out');
    }
    const share = await readJson(args.share);
    const doc = await readJson(args.envelopes);
    const envelopes = Array.isArray(doc) ? doc : doc.envelopes;
    const partials = [];
    for (const env of envelopes) {
      const row = partialDecrypt({
        shareScalar: share.shareScalar,
        index: share.index,
        electionId: args.election,
        ballotHash: env.ballotHash,
        jointPublicKey: share.jointPublicKey,
        ephemeral: ephemeralFromEnvelope(env.encryptedBallot),
      });
      partials.push(row);
    }
    await writeJson(args.out, { index: share.index, partials });
    process.stdout.write(`wrote ${args.out} partials=${partials.length}\n`);
    return;
  }

  if (cmd === 'verify') {
    if (!args.partial || !args.ceremony || !args.envelope || !args['ballot-hash'] || !args.election) {
      throw new Error('verify requires --partial, --ceremony, --envelope, --ballot-hash, and --election');
    }
    const submitted = await readJson(args.partial);
    const ceremony = await readJson(args.ceremony);
    const index = Number(args.index || submitted.index);
    const row = (submitted.partials || [submitted]).find(
      (item) => String(item.ballotHash) === String(args['ballot-hash']),
    );
    if (!row) throw new Error('partial for that ballot hash was not in the file');
    const keys = ceremony.verificationKeys || ceremony.ceremony?.verificationKeys;
    const joint = ceremony.publicKey || ceremony.ceremony?.publicKey;
    const ok = verifyPartial({
      partial: row,
      electionId: args.election,
      index,
      jointPublicKey: joint,
      expectedY: keys[String(index)],
      ephemeral: ephemeralFromEnvelope(args.envelope),
    });
    process.stdout.write(ok ? 'partial ok\n' : 'partial rejected\n');
    process.exit(ok ? 0 : 2);
  }

  if (cmd === 'enroll') {
    const secret = await readJson(args.secret);
    await postJson(args, '/guardians', {
      guardianId: secret.guardianId,
      label: secret.label,
      transportPublicKey: secret.transportPublicKey,
    });
    return;
  }

  if (cmd === 'post-deal') {
    const deal = await readJson(args.deal);
    await postJson(args, '/guardians/deals', deal);
    return;
  }

  if (cmd === 'post-partials') {
    const partials = await readJson(args.partials);
    await postJson(args, '/guardians/partials', partials);
    return;
  }

  throw new Error(`unknown command ${cmd}`);
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});

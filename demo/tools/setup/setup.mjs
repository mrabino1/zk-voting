#!/usr/bin/env node
// NOT FOR PROFIT — civic public good, not a commercial product.
// Guided clone-and-launch setup: ./setup.sh (repo root or demo/) or `npm run setup`.
//
// Asks, in order:
//   1. Super admin: handle, contact email, setup token (the credential /setup asks for)
//   2. Chain id
//   3. Is there a public entropy ceremony? If so, its host
//   4. Is it closed? Then paste its validated output. Otherwise generate local
//      entropy now, or skip
//   5. Public hostname, port, proxy, database, product name
//   6. L2 identity and L1 settlement: L1_RPC, the L1 submitter key, L2_UUID,
//      L2_SALT, L2_ADMIN_SECRET (minted like `npm run l2:identity -- init`),
//      then L2_OPERATOR_ADDRESS and L2_ID (as `show`) and a balance check
//      (as `check-funding`) with a low-balance warning. Then how you run it.
// Writes demo/.env (created from .env.example on the first run). Re-running it
// keeps your answers as defaults and changes nothing you do not change.
// Secrets (setup token, database URL, entropy, generated keys) are read with
// echo off and are never printed. It ends with the exact launch command.

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

import { normalizeCeremonyUrl, parseEntropyString } from '../../apps/node/src/entropy.mjs';
import { ADMIN_HANDLE_RE, CHAIN_ID_PRESETS, DEFAULT_CHAIN_ID, parseChainId } from '../../apps/node/src/setup.mjs';
import { EntropyPool } from '../../apps/node/public/vendor/zk-entropy.js';
import { isUuid, mintAdminSecret, mintSalt, mintUuid, resolveIdentity, resolveOperatorAddress } from '../../l2/identity.mjs';
import { checkSubmitterFunding } from '../../l2/prover/funding.mjs';
import { parseEnvText, updateEnvText } from './envfile.mjs';

const DEMO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Keys whose values are never printed. */
export const SECRET_KEYS = Object.freeze([
  'SETUP_TOKEN',
  'DATABASE_URL',
  'ZK_ENTROPY',
  'EXPLORER_INGEST_SECRET',
  'RECEIPT_PDF_SECRET',
  'L1_SUBMITTER_PRIVATE_KEY',
  'L2_SALT',
  'L2_ADMIN_SECRET',
]);

/** Keys this script manages, in the order they are asked. */
export const MANAGED_KEYS = Object.freeze([
  'ADMIN_HANDLE',
  'SUPER_ADMIN_EMAIL',
  'SETUP_TOKEN',
  'CHAIN_ID',
  'ENTROPY_CEREMONY_URL',
  'ZK_ENTROPY',
  'VOTE_FQDN',
  'ZK_VOTING_PORT',
  'TRUST_PROXY',
  'DATABASE_URL',
  'BRAND_NAME',
  'EXPLORER_INGEST_SECRET',
  'RECEIPT_PDF_SECRET',
  'L1_RPC',
  'L1_SUBMITTER_PRIVATE_KEY',
  'L2_UUID',
  'L2_SALT',
  'L2_ADMIN_SECRET',
  'L2_OPERATOR_ADDRESS',
  'L2_ID',
]);

const HELP = `Guided setup for a zk-voting install. Writes demo/.env.

Usage: ./setup.sh [options]          (or: cd demo && npm run setup -- [options])

  -y, --defaults        accept every default (keeps current values, generates
                        missing secrets, skips entropy) without asking
      --deploy MODE     compose | coolify | node  (how you will run it)
      --file PATH       write this file instead of demo/.env
  -h, --help            this text

Secrets are read with echo off and never printed. Re-run any time; your
current answers are the defaults.
`;

const FQDN_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const BRAND_BAD = /[<>{}"`\\]/;

export function normalizeFqdn(raw) {
  const host = String(raw ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!host) return '';
  if (!FQDN_RE.test(host) || /^\d+(\.\d+){3}$/.test(host) || !/[a-z]/.test(host.slice(host.lastIndexOf('.') + 1))) return null;
  return host;
}

export function newSecretHex(bytes = 32) {
  return randomBytes(bytes).toString('hex');
}

export function newSetupToken() {
  return randomBytes(24).toString('base64url');
}

/* ------------------------------------------------------------------ prompts */

export class Prompter {
  constructor(input, output) {
    this.input = input;
    this.output = output;
    this.tty = Boolean(input.isTTY && output.isTTY);
    this.muted = false;
    const echo = new Writable({
      write: (chunk, enc, cb) => {
        if (!this.muted) output.write(chunk, enc);
        cb();
      },
    });
    this.rl = readline.createInterface({ input, output: echo, terminal: this.tty });
    this.queue = [];
    this.waiters = [];
    this.closed = false;
    this.rl.on('line', (line) => {
      const w = this.waiters.shift();
      if (w) w(line);
      else this.queue.push(line);
    });
    this.rl.on('close', () => {
      this.closed = true;
      for (const w of this.waiters.splice(0)) w(null);
    });
  }

  say(text = '') {
    this.output.write(`${text}\n`);
  }

  nextLine() {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** One line. `secret` turns echo off on a terminal. */
  async ask(prompt, { secret = false, onKey = null } = {}) {
    this.output.write(prompt);
    const keyListener = onKey && this.tty ? (_s, key) => onKey(key) : null;
    if (secret && this.tty) this.muted = true;
    if (keyListener) this.input.on('keypress', keyListener);
    let line;
    try {
      line = await this.nextLine();
    } finally {
      if (keyListener) this.input.off('keypress', keyListener);
      if (this.muted) {
        this.muted = false;
        this.output.write('\n');
      } else if (!this.tty) this.output.write('\n');
    }
    if (line === null) throw new SetupAbort('input ended before setup finished; nothing was written');
    return line.trim();
  }

  close() {
    this.rl.close();
  }
}

export class SetupAbort extends Error {}

/* ------------------------------------------------------------------- flow */

function parseArgs(argv) {
  const out = { defaults: false, deploy: null, envFile: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (a.includes('=')) return a.slice(a.indexOf('=') + 1);
      const v = argv[++i];
      if (v === undefined) throw new SetupAbort(`${a} needs a value`);
      return v;
    };
    if (a === '-y' || a === '--defaults' || a === '--yes') out.defaults = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else if (a.startsWith('--deploy')) out.deploy = val();
    else if (a.startsWith('--file')) out.envFile = val();
    else throw new SetupAbort(`unknown option ${a} (try --help)`);
  }
  if (out.deploy && !['compose', 'coolify', 'node'].includes(out.deploy)) {
    throw new SetupAbort('--deploy must be compose, coolify, or node');
  }
  return out;
}

/**
 * Run the guided setup.
 * @param {{ argv?: string[], input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream,
 *   demoDir?: string, collectKeystrokes?: boolean }} opts
 * @returns {Promise<{ code: number, envFile?: string, changed?: string[], deploy?: string }>}
 */
export async function runSetup(opts = {}) {
  const output = opts.output || process.stdout;
  const args = parseArgs(opts.argv || []);
  if (args.help) {
    output.write(HELP);
    return { code: 0 };
  }
  const demoDir = opts.demoDir || DEMO_DIR;
  const envFile = path.resolve(args.envFile || path.join(demoDir, '.env'));
  const example = path.join(demoDir, '.env.example');
  const existed = existsSync(envFile);
  const baseText = existed ? readFileSync(envFile, 'utf8') : existsSync(example) ? readFileSync(example, 'utf8') : '';
  const cur = parseEnvText(baseText);
  const get = (k) => cur.get(k) ?? '';
  const next = {};
  const notes = [];

  const p = new Prompter(opts.input || process.stdin, output);
  const D = args.defaults;

  async function ask(question, def, { secret = false, validate = null, onKey = null } = {}) {
    for (let tries = 0; ; tries++) {
      const shown = secret ? (def ? ' [keep]' : '') : def !== '' && def != null ? ` [${def}]` : '';
      const raw = D ? '' : await p.ask(`${question}${shown}: `, { secret, onKey });
      const v = raw === '' ? def ?? '' : raw;
      if (!validate) return v;
      const res = validate(v);
      if (res.ok) return res.value;
      if (D || tries >= 4) throw new SetupAbort(`${res.error}; nothing was written`);
      p.say(`  ${res.error}`);
    }
  }

  async function choose(question, options, def) {
    const keys = options.map((o) => o.key);
    const label = options.map((o) => `${o.key === def ? o.key.toUpperCase() : o.key}=${o.label}`).join(', ');
    return ask(`${question} (${label})`, def, {
      validate: (v) => {
        const k = String(v).toLowerCase().slice(0, 1);
        return keys.includes(k) ? { ok: true, value: k } : { ok: false, error: `answer one of: ${keys.join(', ')}` };
      },
    });
  }

  const yesNo = (question, def) =>
    choose(question, [{ key: 'y', label: 'yes' }, { key: 'n', label: 'no' }], def ? 'y' : 'n').then((k) => k === 'y');

  try {
    p.say('zk-voting guided setup — NOT FOR PROFIT civic software.');
    p.say(`Writing ${path.relative(process.cwd(), envFile) || envFile}${existed ? ' (your current values are the defaults)' : ' (new, from .env.example)'}.`);
    p.say('Press Enter to accept a default. Secrets are read with echo off and never shown.');

    /* 1. Super admin ------------------------------------------------------ */
    p.say('\n1/6  Super admin');
    p.say('  The first passkey created on /setup becomes the platform super admin.');
    next.ADMIN_HANDLE = await ask('  Handle', get('ADMIN_HANDLE') || 'admin', {
      validate: (v) => (ADMIN_HANDLE_RE.test(v) ? { ok: true, value: v } : { ok: false, error: 'handle: 2-32 letters, digits, dot, dash or underscore' }),
    });
    next.SUPER_ADMIN_EMAIL = await ask('  Contact email (optional, "-" to clear)', get('SUPER_ADMIN_EMAIL'), {
      validate: (v) => (v === '-' || v === '' ? { ok: true, value: '' } : EMAIL_RE.test(v) ? { ok: true, value: v } : { ok: false, error: 'not an email address' }),
    });
    p.say('  The setup token is the credential /setup asks for before it creates the super admin.');
    const hasToken = Boolean(get('SETUP_TOKEN'));
    const tokenChoice = await choose(
      '  Setup token',
      hasToken
        ? [{ key: 'k', label: 'keep' }, { key: 'g', label: 'generate new' }, { key: 'e', label: 'enter my own' }, { key: 'r', label: 'remove' }]
        : [{ key: 'g', label: 'generate' }, { key: 'e', label: 'enter my own' }, { key: 'n', label: 'none' }],
      hasToken ? 'k' : 'g',
    );
    if (tokenChoice === 'k') next.SETUP_TOKEN = get('SETUP_TOKEN');
    else if (tokenChoice === 'g') next.SETUP_TOKEN = newSetupToken();
    else if (tokenChoice === 'e') {
      next.SETUP_TOKEN = await ask('  Setup token (16+ characters, hidden)', '', {
        secret: true,
        validate: (v) => (v.length >= 16 && !/\s/.test(v) ? { ok: true, value: v } : { ok: false, error: 'use at least 16 characters and no spaces' }),
      });
    } else next.SETUP_TOKEN = '';
    if (next.SETUP_TOKEN && next.SETUP_TOKEN !== get('SETUP_TOKEN')) notes.push('setup-token');

    /* 2. Chain id --------------------------------------------------------- */
    p.say('\n2/6  Chain id');
    p.say(`  ${CHAIN_ID_PRESETS.map((c) => `${c.chainId} ${c.label}`).join(' · ')}`);
    p.say('  Type "web" to leave it empty and choose it on the /setup page instead.');
    next.CHAIN_ID = await ask('  Chain id', cur.has('CHAIN_ID') ? get('CHAIN_ID') || 'web' : String(DEFAULT_CHAIN_ID), {
      validate: (v) => {
        if (v.toLowerCase() === 'web') return { ok: true, value: '' };
        const n = parseChainId(v);
        return n === null ? { ok: false, error: 'chain id must be a positive integer (or "web")' } : { ok: true, value: String(n) };
      },
    });

    /* 3. Ceremony --------------------------------------------------------- */
    p.say('\n3/6  Entropy ceremony');
    p.say('  A public ceremony (zk-entropy/ceremony) lets many people add randomness before the trusted setup.');
    const curCeremony = get('ENTROPY_CEREMONY_URL');
    const ceremony = await yesNo('  Is there a public entropy ceremony?', Boolean(curCeremony));
    if (ceremony) {
      next.ENTROPY_CEREMONY_URL = await ask('  Ceremony host or URL (for example ceremony.example.org)', curCeremony.replace(/^https:\/\//, ''), {
        validate: (v) => {
          const url = normalizeCeremonyUrl(v);
          return url ? { ok: true, value: url } : { ok: false, error: 'enter an https host such as ceremony.example.org' };
        },
      });
    } else next.ENTROPY_CEREMONY_URL = '';

    /* 4. Entropy ---------------------------------------------------------- */
    p.say('\n4/6  Setup entropy');
    const curEntropy = parseEntropyString(get('ZK_ENTROPY'));
    if (get('ZK_ENTROPY') && !curEntropy.ok) p.say(`  The current ZK_ENTROPY is not valid (${curEntropy.error}); it will be replaced.`);
    const keepLabel = curEntropy.ok ? `keep current ${curEntropy.source} string` : null;
    let closed = false;
    if (ceremony) closed = await yesNo('  Is the ceremony closed (final output published)?', curEntropy.ok && curEntropy.source === 'ceremony');
    if (closed) {
      const keep = curEntropy.ok && curEntropy.source === 'ceremony' && (await yesNo(`  ${keepLabel}?`, true));
      if (keep) next.ZK_ENTROPY = curEntropy.value;
      else {
        p.say(`  Copy the zke1:ceremony:… string from ${next.ENTROPY_CEREMONY_URL}/final.`);
        next.ZK_ENTROPY = await ask('  Paste it (hidden)', '', {
          secret: true,
          validate: (v) => {
            const r = parseEntropyString(v);
            if (!r.ok) return { ok: false, error: `not accepted: ${r.error}` };
            if (r.source !== 'ceremony') return { ok: false, error: `that is a ${r.source} string, not the ceremony output` };
            return { ok: true, value: r.value };
          },
        });
        p.say(`  Valid ceremony string (transcript ${parseEntropyString(next.ZK_ENTROPY).transcriptHash.slice(0, 12)}…).`);
      }
    } else {
      if (ceremony) p.say('  Until it closes you can use local entropy now, or skip and paste the output later (re-run ./setup.sh or use /setup).');
      const options = [];
      if (keepLabel) options.push({ key: 'k', label: keepLabel });
      options.push({ key: 'l', label: 'generate local entropy now' }, { key: 's', label: 'skip for now' });
      const pick = await choose('  Entropy', options, keepLabel ? 'k' : 's');
      if (pick === 'k') next.ZK_ENTROPY = curEntropy.value;
      else if (pick === 's') next.ZK_ENTROPY = '';
      else next.ZK_ENTROPY = await generateLocal(p, opts);
    }

    /* 5. Environment ------------------------------------------------------ */
    p.say('\n5/6  Site and environment');
    next.VOTE_FQDN = await ask('  Public hostname, bare (vote.example.org; empty = local demo on localhost, "-" to clear)', get('VOTE_FQDN'), {
      validate: (v) => {
        if (v === '-' || v === '') return { ok: true, value: '' };
        const h = normalizeFqdn(v);
        return h ? { ok: true, value: h } : { ok: false, error: 'a bare hostname such as vote.example.org (no scheme, port, or path)' };
      },
    });
    next.ZK_VOTING_PORT = await ask('  Host port', get('ZK_VOTING_PORT') || '3000', {
      validate: (v) => (/^\d{2,5}$/.test(v) && Number(v) > 0 && Number(v) < 65536 ? { ok: true, value: v } : { ok: false, error: 'a port number' }),
    });
    if (next.VOTE_FQDN) {
      const proxied = await yesNo('  Behind a reverse proxy (Coolify, Caddy, nginx, Cloudflare)?', get('TRUST_PROXY') !== '' || !get('VOTE_FQDN'));
      next.TRUST_PROXY = proxied ? get('TRUST_PROXY') || '1' : '';
    } else next.TRUST_PROXY = get('TRUST_PROXY');
    const hasDb = Boolean(get('DATABASE_URL'));
    const dbPick = await choose(
      '  Database',
      hasDb
        ? [{ key: 'k', label: 'keep current Postgres URL' }, { key: 'c', label: 'change' }, { key: 'j', label: 'JSON files in the data volume' }]
        : [{ key: 'j', label: 'JSON files in the data volume' }, { key: 'p', label: 'Postgres' }],
      hasDb ? 'k' : 'j',
    );
    if (dbPick === 'k') next.DATABASE_URL = get('DATABASE_URL');
    else if (dbPick === 'j') next.DATABASE_URL = '';
    else {
      next.DATABASE_URL = await ask('  Postgres URL, postgres://user:pass@host:5432/db (hidden)', '', {
        secret: true,
        validate: (v) => (/^postgres(ql)?:\/\/[^\s]+$/.test(v) ? { ok: true, value: v } : { ok: false, error: 'must start with postgres:// or postgresql://' }),
      });
    }
    next.BRAND_NAME = await ask('  Product name (optional; Site admin can change it later, "-" to clear)', get('BRAND_NAME'), {
      validate: (v) => (v === '-' || v === '' ? { ok: true, value: '' } : v.length <= 64 && !BRAND_BAD.test(v) ? { ok: true, value: v } : { ok: false, error: 'up to 64 characters, no < > { } " ` \\' }),
    });
    for (const k of ['EXPLORER_INGEST_SECRET', 'RECEIPT_PDF_SECRET']) {
      next[k] = get(k) || newSecretHex(32);
      if (!get(k)) notes.push(k);
    }
    /* 6. L2 identity and L1 settlement ------------------------------------ */
    p.say('\n6/6  L2 identity and L1 settlement');
    p.say('  Voters never pay. The operator key pays L1 gas for vote batches: keep a little ETH on it, not a lot.');
    next.L1_RPC = await ask('  L1 RPC URL (https://…; empty = no L1 settlement yet, "-" to clear)', get('L1_RPC') ? 'keep' : '', {
      validate: (v) => {
        if (v === 'keep') return { ok: true, value: get('L1_RPC') };
        if (v === '-' || v === '') return { ok: true, value: '' };
        return /^https?:\/\/[^\s]+$/.test(v) ? { ok: true, value: v } : { ok: false, error: 'an http(s) URL' };
      },
    });
    const hasKey = Boolean(get('L1_SUBMITTER_PRIVATE_KEY'));
    const keyPick = await choose(
      '  L1 submitter private key',
      hasKey
        ? [{ key: 'k', label: 'keep' }, { key: 'e', label: 'enter a different key' }, { key: 'r', label: 'remove' }]
        : [{ key: 'n', label: 'not now' }, { key: 'e', label: 'enter it (hidden)' }],
      hasKey ? 'k' : 'n',
    );
    if (keyPick === 'k') next.L1_SUBMITTER_PRIVATE_KEY = get('L1_SUBMITTER_PRIVATE_KEY');
    else if (keyPick === 'e') {
      next.L1_SUBMITTER_PRIVATE_KEY = await ask('  Private key, 0x + 64 hex (hidden)', '', {
        secret: true,
        validate: (v) => (/^(0x)?[0-9a-fA-F]{64}$/.test(v) ? { ok: true, value: v.startsWith('0x') ? v : `0x${v}` } : { ok: false, error: 'must be 32 bytes of hex (0x + 64 hex)' }),
      });
    } else next.L1_SUBMITTER_PRIVATE_KEY = '';
    // Same values as `npm run l2:identity -- init`, written straight into .env
    // instead of printed. Existing values are kept: changing them changes l2Id.
    next.L2_UUID = isUuid(get('L2_UUID')) ? get('L2_UUID').toLowerCase() : mintUuid();
    next.L2_SALT = /^0x[0-9a-fA-F]{64}$/.test(get('L2_SALT')) ? get('L2_SALT') : mintSalt();
    next.L2_ADMIN_SECRET = get('L2_ADMIN_SECRET') || mintAdminSecret();
    for (const k of ['L2_UUID', 'L2_SALT', 'L2_ADMIN_SECRET']) if (next[k] !== get(k)) notes.push(k);
    // Operator address: derived from the key (as `show` does); else keep or ask.
    let operator = next.L1_SUBMITTER_PRIVATE_KEY
      ? await resolveOperatorAddress({ L1_SUBMITTER_PRIVATE_KEY: next.L1_SUBMITTER_PRIVATE_KEY })
      : '';
    if (next.L1_SUBMITTER_PRIVATE_KEY && !operator) p.say('  Could not derive an address from that key (is viem installed? run npm install in demo/).');
    if (!operator) {
      operator = await ask('  Operator L1 address (0x…, optional when the key is set later)', get('L2_OPERATOR_ADDRESS'), {
        validate: (v) => (v === '' || v === '-' ? { ok: true, value: '' } : /^0x[0-9a-fA-F]{40}$/.test(v) ? { ok: true, value: v.toLowerCase() } : { ok: false, error: 'an 0x address (40 hex)' }),
      });
    }
    next.L2_OPERATOR_ADDRESS = operator;
    const pinned = get('L2_ID');
    const derived = resolveIdentity({ L2_UUID: next.L2_UUID, L2_SALT: next.L2_SALT }, { operator });
    const l2Id = operator ? derived.l2Id : '';
    if (pinned && l2Id && pinned.toLowerCase() !== l2Id) {
      p.say('  The pinned L2_ID does not match this operator, L2_UUID and L2_SALT; it is replaced by the derived id.');
    }
    next.L2_ID = l2Id || (operator ? '' : pinned);
    p.say(`  L2_UUID ${next.L2_UUID}`);
    p.say(`  Operator ${operator || '(not set yet)'}`);
    p.say(`  L2_ID ${next.L2_ID || '(derived once the operator key or address is set)'}`);
    if (!derived.saltSet) p.say('  L2_SALT is missing.');
    if (next.L1_RPC && operator) {
      const f = await checkSubmitterFunding({
        l1Rpc: next.L1_RPC,
        address: operator,
        fetchImpl: opts.fetchImpl || fetch,
        gasPerBatch: BigInt(get('L1_SUBMITTER_GAS_PER_BATCH') || 250000),
        minBatches: BigInt(get('L1_SUBMITTER_MIN_BATCHES') || 20),
      });
      const msg = safeFundingMessage(f);
      if (f.level === 'ok') p.say(`  Funding: ${msg}`);
      else p.say(`  WARNING (${f.level}): ${msg}`);
      if (f.level === 'low' || f.level === 'empty') p.say(`  Top up ${operator} on L1. The prover holds batches (nothing is lost) while it cannot pay for one.`);
    } else p.say('  Funding not checked (needs L1_RPC and the submitter key or address). Later: npm run l2:identity -- check-funding');

    const deploy =
      args.deploy ||
      ({ c: 'compose', o: 'coolify', n: 'node' }[
        await choose(
          '  How will you run it?',
          [{ key: 'c', label: 'docker compose here' }, { key: 'o', label: 'Coolify' }, { key: 'n', label: 'Node only (npm run dev)' }],
          'c',
        )
      ]);

    /* write ---------------------------------------------------------------- */
    const changed = MANAGED_KEYS.filter((k) => (cur.get(k) ?? null) !== next[k] && !(next[k] === '' && !cur.has(k)));
    const updates = Object.fromEntries(MANAGED_KEYS.filter((k) => changed.includes(k)).map((k) => [k, next[k]]));
    const outText = updateEnvText(baseText, updates);
    const wrote = !existed || outText !== baseText;
    if (wrote) {
      const tmp = `${envFile}.tmp-${process.pid}`;
      writeFileSync(tmp, outText, { mode: 0o600 });
      renameSync(tmp, envFile);
    }
    try {
      chmodSync(envFile, 0o600);
    } catch {
      /* not fatal on filesystems without modes */
    }

    p.say('');
    if (!wrote) p.say(`No changes. ${envFile} already matches these answers.`);
    else {
      p.say(`Saved ${envFile} (mode 600).`);
      for (const k of changed) p.say(`  ${k}: ${describeValue(k, next[k])}`);
    }
    if (notes.some((n) => n.startsWith('L2_'))) p.say('  New L2 identity written (L2_UUID, L2_SALT, L2_ADMIN_SECRET). Back up demo/.env: losing L2_SALT or the key loses this l2Id.');
    if (notes.includes('setup-token')) p.say('  A setup token is in .env as SETUP_TOKEN. You type it on /setup; read it yourself from the file.');
    p.say('');
    printLaunch(p, { deploy, next, envFile, demoDir });
    return { code: 0, envFile, changed, deploy };
  } finally {
    p.close();
  }
}

/** Funding message without the RPC URL (it often carries a provider API key). */
export function safeFundingMessage(f) {
  if (f.level === 'unreachable') return 'the L1 RPC did not answer (check L1_RPC)';
  return String(f.message || f.level);
}

async function generateLocal(p, opts) {
  const pool = new EntropyPool();
  let keys = 0;
  if (p.tty && opts.collectKeystrokes !== false) {
    p.say('  Mash the keyboard (not shown, not stored; only key timing is mixed in), then press Enter.');
    await p.ask('  Keys: ', {
      secret: true,
      onKey: (key) => {
        keys += 1;
        pool.addKeyboardEvent({ time: performance.now(), code: key?.sequence?.charCodeAt(0) || 0 });
      },
    });
  }
  pool.addJitter(512);
  const res = await pool.finalize({ source: 'local' });
  p.say(`  Local entropy generated (${keys ? `${keys} key timings, ` : ''}OS randomness and timing jitter; transcript ${res.transcriptHash.slice(0, 12)}…).`);
  return res.entropyString;
}

export function describeValue(key, value) {
  if (value === '') return 'cleared';
  if (SECRET_KEYS.includes(key)) return 'set (secret, not shown)';
  if (key === 'L1_RPC') {
    try {
      return `set (${new URL(value).host}; full URL not shown)`;
    } catch {
      return 'set';
    }
  }
  return value;
}

export function launchPlan({ deploy, next }) {
  const port = next.ZK_VOTING_PORT || '3000';
  const site = next.VOTE_FQDN ? `https://${next.VOTE_FQDN}` : `http://localhost:${port}`;
  if (deploy === 'node') {
    return {
      commands: ['cd demo', 'npm install', 'set -a; . ./.env; set +a; CHAIN_RPC= npm run dev'],
      open: `http://localhost:${port}/setup`,
    };
  }
  if (deploy === 'coolify') {
    const plain = ['ADMIN_HANDLE', 'SUPER_ADMIN_EMAIL', 'CHAIN_ID', 'ENTROPY_CEREMONY_URL', 'VOTE_FQDN', 'TRUST_PROXY', 'BRAND_NAME', 'L2_UUID', 'L2_ID', 'L2_OPERATOR_ADDRESS'];
    return {
      coolify: [
        'New resource → Public (or Private) Repository → this repository, branch test/unstable (staging) or master (production)',
        'Build pack: Docker Compose',
        'Base Directory: /demo',
        'Docker Compose Location: /docker-compose.yml',
        `Service "node" → Domains: ${next.VOTE_FQDN ? `https://${next.VOTE_FQDN}:3000` : 'https://<your hostname>:3000'}`,
        'Health check (if you add one): path /health, port 3000, HTTP 200',
      ],
      envPlain: plain.filter((k) => next[k] !== undefined && next[k] !== '').map((k) => `${k}=${next[k]}`),
      // L1_RPC is listed by name only: provider URLs often embed an API key.
      envSecret: [...SECRET_KEYS, 'L1_RPC'].filter((k) => next[k]),
      open: `${site}/setup`,
    };
  }
  return {
    commands: ['cd demo', 'docker compose up -d --build', `curl -fsS http://127.0.0.1:${port}/health`],
    open: next.VOTE_FQDN ? `${site}/setup (once DNS and TLS for ${next.VOTE_FQDN} point at this host)` : `${site}/setup`,
  };
}

function printLaunch(p, { deploy, next }) {
  const plan = launchPlan({ deploy, next });
  if (plan.coolify) {
    p.say('Launch on Coolify:');
    for (const line of plan.coolify) p.say(`  - ${line}`);
    p.say('  - Environment Variables (plain):');
    for (const line of plan.envPlain) p.say(`      ${line}`);
    if (plan.envSecret.length) {
      p.say('  - Environment Variables (secret: tick "Is secret"/locked; copy each value from demo/.env, not shown here):');
      for (const k of plan.envSecret) p.say(`      ${k}`);
    }
    p.say('  - Deploy, then open:');
    p.say(`      ${plan.open}`);
    return;
  }
  p.say('Launch:');
  p.say('');
  p.say(`  ${plan.commands.join(' && ')}`);
  p.say('');
  if (deploy === 'node') p.say('  (Node only runs without the bundled L2 chain; use docker compose for the full stack.)');
  p.say(`Then open ${plan.open} and finish the remaining steps in the browser.`);
}

let isMain = false;
try {
  isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
} catch {
  isMain = false;
}
if (isMain) {
  runSetup({ argv: process.argv.slice(2) }).then(
    (r) => process.exit(r.code),
    (e) => {
      process.stderr.write(`setup: ${e instanceof SetupAbort ? e.message : e?.message || e}\n`);
      process.exit(1);
    },
  );
}

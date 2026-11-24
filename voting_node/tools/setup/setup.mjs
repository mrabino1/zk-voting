#!/usr/bin/env node
// NOT FOR PROFIT — civic public good, not a commercial product.
// Guided clone-and-launch setup: ./setup.sh (repo root or voting_node/) or `npm run setup`.
//
// Asks, in order:
//   1. Super admin: handle, contact email, setup token (the credential /setup asks for)
//   2. Chain id
//   3. Is there a public entropy ceremony? If so, its host
//   4. Is it closed? Then paste its validated output. Otherwise generate local
//      entropy now, or skip
//   5. Public hostname, port, proxy, database, product name
//   6. Rollup: a local L1 (Anvil + one-shot deploy in Docker Compose, public
//      dev keys) or an existing ZkVotingRollup deployment (L1_RPC,
//      ROLLUP_ADDRESS, ROLLUP_JURISDICTION_ID, the node key and the operator
//      key), with an L1 balance check of both accounts. L2_BALLOT_TOKEN is
//      minted. Then how you run it.
// Writes voting_node/.env (created from .env.example on the first run). Re-running it
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
import { createRequire } from 'node:module';

import { parseIsDemo } from '../../apps/node/src/config.mjs';
import { normalizeCeremonyUrl, parseEntropyString } from '../../apps/node/src/entropy.mjs';
import { ADMIN_HANDLE_RE, CHAIN_ID_PRESETS, DEFAULT_CHAIN_ID, parseChainId } from '../../apps/node/src/setup.mjs';
import { EntropyPool } from '../../apps/node/public/vendor/zk-entropy.js';
import { rollupFundingLevel } from '../../apps/node/src/routes/setup.mjs';
import { parseEnvText, updateEnvText } from './envfile.mjs';

const DEMO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Keys whose values are never printed. */
export const SECRET_KEYS = Object.freeze([
  'SETUP_TOKEN',
  'DATABASE_URL',
  'POSTGRES_PASSWORD',
  'ZK_ENTROPY',
  'RECEIPT_PDF_SECRET',
  'ROLLUP_PRIVATE_KEY',
  'OPERATOR_PRIVATE_KEY',
  'L2_BALLOT_TOKEN',
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
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
  'POSTGRES_DB',
  'BRAND_NAME',
  'RECEIPT_PDF_SECRET',
  'COMPOSE_PROFILES',
  'L1_RPC',
  'L1_CHAIN_ID',
  'ROLLUP_ADDRESS',
  'ROLLUP_DEPLOYMENT_FILE',
  'ROLLUP_JURISDICTION_ID',
  'ROLLUP_PRIVATE_KEY',
  'OPERATOR_PRIVATE_KEY',
  'L2_BALLOT_TOKEN',
  'ZK_VOTING_ALLOW_MOCK_PROOFS',
]);

const require = createRequire(import.meta.url);
const { ANVIL_DEV_KEYS, isAnvilDevKey } = require('../../packages/chain-client/index.js');

/** Docker Compose's local stack: Anvil accounts 2 (node clerk) and 1 (operator). Public keys. */
export const LOCAL_ROLLUP = Object.freeze({
  COMPOSE_PROFILES: 'local-l1',
  L1_RPC: 'http://l1:8545',
  L1_CHAIN_ID: '',
  ROLLUP_ADDRESS: '',
  ROLLUP_DEPLOYMENT_FILE: '/deployments/local.json',
  ROLLUP_JURISDICTION_ID: '',
  ROLLUP_PRIVATE_KEY: ANVIL_DEV_KEYS[2],
  OPERATOR_PRIVATE_KEY: ANVIL_DEV_KEYS[1],
  ZK_VOTING_ALLOW_MOCK_PROOFS: '1',
});

const KEY_RE = /^(0x)?[0-9a-fA-F]{64}$/;

const HELP = `Guided setup for a zk-voting install. Writes voting_node/.env.

Usage: ./setup.sh [options]          (or: cd voting_node && npm run setup -- [options])

  -y, --defaults        accept every default (keeps current values, generates
                        missing secrets, skips entropy) without asking
      --deploy MODE     compose | coolify | node  (how you will run it)
      --file PATH       write this file instead of voting_node/.env
  -h, --help            this text

Secrets are read with echo off and never printed. Re-run any time; your
current answers are the defaults.

IS_DEMO is not asked and is not added. Omit it (the default) so this
install is a real election. Set IS_DEMO=true only on the disposable public
demo. If the key is already in the file, true/1 stays true and anything
else is rewritten to false.
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
    p.say('  Choosing "none" leaves SETUP_TOKEN empty. The server then prints a one-time token at boot. Type that on /setup. It is not written to .env and it is not served over HTTP.');
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
    next.POSTGRES_USER = get('POSTGRES_USER');
    next.POSTGRES_PASSWORD = get('POSTGRES_PASSWORD');
    next.POSTGRES_DB = get('POSTGRES_DB');
    const dbPick = await choose(
      '  Database',
      hasDb
        ? [{ key: 'k', label: 'keep current Postgres URL' }, { key: 'c', label: 'change' }, { key: 'j', label: 'JSON files in the data volume' }]
        : [
            { key: 'b', label: 'the Postgres bundled with Docker Compose (a password is generated)' },
            { key: 'p', label: 'my own Postgres' },
            { key: 'j', label: 'JSON files in the data volume (no Docker Compose)' },
          ],
      // A re-run keeps an earlier JSON choice; a first run defaults to the bundled Postgres.
      hasDb ? 'k' : existed || args.deploy === 'node' ? 'j' : 'b',
    );
    if (dbPick === 'k') next.DATABASE_URL = get('DATABASE_URL');
    else if (dbPick === 'j') next.DATABASE_URL = '';
    else if (dbPick === 'b') {
      // The db service in docker-compose.yml. Hex keeps the password URL-safe.
      next.POSTGRES_USER = get('POSTGRES_USER') || 'zkvote';
      next.POSTGRES_DB = get('POSTGRES_DB') || 'zkvote';
      next.POSTGRES_PASSWORD = get('POSTGRES_PASSWORD') || newSecretHex(24);
      next.DATABASE_URL = `postgres://${next.POSTGRES_USER}:${next.POSTGRES_PASSWORD}@db:5432/${next.POSTGRES_DB}`;
      if (!get('POSTGRES_PASSWORD')) notes.push('POSTGRES_PASSWORD');
    } else {
      next.DATABASE_URL = await ask('  Postgres URL, postgres://user:pass@host:5432/db (hidden)', '', {
        secret: true,
        validate: (v) => (/^postgres(ql)?:\/\/[^\s]+$/.test(v) ? { ok: true, value: v } : { ok: false, error: 'must start with postgres:// or postgresql://' }),
      });
    }
    next.BRAND_NAME = await ask('  Product name (optional; Site admin can change it later, "-" to clear)', get('BRAND_NAME'), {
      validate: (v) => (v === '-' || v === '' ? { ok: true, value: '' } : v.length <= 64 && !BRAND_BAD.test(v) ? { ok: true, value: v } : { ok: false, error: 'up to 64 characters, no < > { } " ` \\' }),
    });
    for (const k of ['RECEIPT_PDF_SECRET']) {
      next[k] = get(k) || newSecretHex(32);
      if (!get(k)) notes.push(k);
    }
    /* 6. Rollup ----------------------------------------------------------- */
    p.say('\n6/6  Rollup (ZkVotingRollup on L1, and the L2 operator)');
    p.say('  Civic votes settle on the one L1 contract; polls stay on this node. Voters never pay.');
    const wasLocal = String(get('COMPOSE_PROFILES')).split(',').map((x) => x.trim()).includes('local-l1');
    const mode = await choose(
      '  Which L1?',
      [{ key: 'l', label: 'local chain in Docker Compose (Anvil, test keys)' }, { key: 'e', label: 'an existing deployment' }],
      wasLocal || !get('ROLLUP_ADDRESS') ? 'l' : 'e',
    );
    if (mode === 'l') {
      Object.assign(next, LOCAL_ROLLUP);
      p.say('  Local: Compose starts Anvil (chain 31337) and deploys the rollup once. The node and');
      p.say('  operator use Anvil\'s PUBLIC dev keys, which are refused on any other chain.');
    } else {
      const keep = (k) => (get(k) && !(k.endsWith('_PRIVATE_KEY') && isAnvilDevKey(get(k))) ? get(k) : '');
      next.COMPOSE_PROFILES = '';
      next.ROLLUP_DEPLOYMENT_FILE = '';
      next.ZK_VOTING_ALLOW_MOCK_PROOFS = '';
      const rpcDefault = get('L1_RPC') && get('L1_RPC') !== LOCAL_ROLLUP.L1_RPC ? 'keep' : '';
      next.L1_RPC = await ask('  L1 RPC URL (https://…)', rpcDefault, {
        validate: (v) => {
          if (v === 'keep') return { ok: true, value: get('L1_RPC') };
          return /^https?:\/\/[^\s]+$/.test(v) ? { ok: true, value: v } : { ok: false, error: 'an http(s) URL' };
        },
      });
      next.ROLLUP_ADDRESS = await ask('  ZkVotingRollup address (0x…; ./scripts/deploy.sh prints it)', get('ROLLUP_ADDRESS'), {
        validate: (v) => (/^0x[0-9a-fA-F]{40}$/.test(v) ? { ok: true, value: v } : { ok: false, error: 'an 0x address (40 hex)' }),
      });
      next.ROLLUP_JURISDICTION_ID = await ask('  Jurisdiction id on the rollup (0x + 64 hex)', get('ROLLUP_JURISDICTION_ID'), {
        validate: (v) => (/^0x[0-9a-fA-F]{64}$/.test(v) ? { ok: true, value: v.toLowerCase() } : { ok: false, error: 'a bytes32 (0x + 64 hex)' }),
      });
      for (const [k, label] of [
        ['ROLLUP_PRIVATE_KEY', 'Node key (the jurisdiction clerk on L1)'],
        ['OPERATOR_PRIVATE_KEY', 'L2 operator key (registered with setOperator)'],
      ]) {
        const current = keep(k);
        const pick = await choose(
          `  ${label}`,
          current ? [{ key: 'k', label: 'keep' }, { key: 'e', label: 'enter a different key' }] : [{ key: 'e', label: 'enter it (hidden)' }, { key: 'n', label: 'not now' }],
          current ? 'k' : 'e',
        );
        if (pick === 'k') next[k] = current;
        else if (pick === 'n') next[k] = '';
        else {
          next[k] = await ask('  Private key, 0x + 64 hex (hidden)', '', {
            secret: true,
            validate: (v) => {
              if (!KEY_RE.test(v)) return { ok: false, error: 'must be 32 bytes of hex (0x + 64 hex)' };
              const key = v.startsWith('0x') ? v : `0x${v}`;
              if (isAnvilDevKey(key)) return { ok: false, error: 'that is a public Anvil test key; use it only with the local chain' };
              return { ok: true, value: key };
            },
          });
        }
      }
      const checked = await checkRollupAccounts(next, opts.fetchImpl || fetch);
      next.L1_CHAIN_ID = checked.chainId ? String(checked.chainId) : get('L1_CHAIN_ID');
      for (const line of checked.lines) p.say(`  ${line}`);
    }
    next.L2_BALLOT_TOKEN = get('L2_BALLOT_TOKEN') || newSecretHex(32);
    if (!get('L2_BALLOT_TOKEN')) notes.push('L2_BALLOT_TOKEN');

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
    // Absence of IS_DEMO means a real election. Never invent the key.
    // An existing value is normalised to true or false.
    const demoUpdate = {};
    if (cur.has('IS_DEMO')) {
      const parsed = parseIsDemo(cur.get('IS_DEMO'), {
        warn(message) {
          p.say(message);
        },
      });
      const normalized = parsed ? 'true' : 'false';
      if (String(cur.get('IS_DEMO')) !== normalized) demoUpdate.IS_DEMO = normalized;
    }
    const changed = MANAGED_KEYS.filter((k) => (cur.get(k) ?? null) !== next[k] && !(next[k] === '' && !cur.has(k)));
    if (demoUpdate.IS_DEMO !== undefined) changed.push('IS_DEMO');
    const updates = {
      ...Object.fromEntries(MANAGED_KEYS.filter((k) => changed.includes(k)).map((k) => [k, next[k]])),
      ...demoUpdate,
    };
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
    if (notes.includes('setup-token')) p.say('  A setup token is in .env as SETUP_TOKEN. You type it on /setup; read it yourself from the file.');
    if (!next.SETUP_TOKEN) p.say('  SETUP_TOKEN is empty. On boot the server prints a one-time setup token. Type it on /setup. Restarting before the super admin is created replaces it.');
    p.say('');
    printLaunch(p, { deploy, next, envFile, demoDir });
    return { code: 0, envFile, changed, deploy };
  } finally {
    p.close();
  }
}

async function rpcCall(url, method, params, fetchImpl) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(8000),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message || method);
  return body.result;
}

/**
 * L1 chain id and the balance of the node and operator accounts. Lines never contain the RPC
 * URL (providers embed API keys in it) or a key.
 */
export async function checkRollupAccounts(next, fetchImpl = fetch) {
  const { privateKeyToAccount } = await import('viem/accounts');
  const lines = [];
  let chainId = null;
  try {
    chainId = Number(BigInt(await rpcCall(next.L1_RPC, 'eth_chainId', [], fetchImpl)));
    lines.push(`L1 chain id ${chainId}.`);
    const code = await rpcCall(next.L1_RPC, 'eth_getCode', [next.ROLLUP_ADDRESS, 'latest'], fetchImpl);
    if (!code || code === '0x') lines.push(`WARNING: no contract at ${next.ROLLUP_ADDRESS} on this chain.`);
    const gasPriceWei = BigInt(await rpcCall(next.L1_RPC, 'eth_gasPrice', [], fetchImpl));
    for (const [k, who] of [['ROLLUP_PRIVATE_KEY', 'Node account'], ['OPERATOR_PRIVATE_KEY', 'Operator account']]) {
      if (!next[k]) {
        lines.push(`${who}: no key yet; balance not checked.`);
        continue;
      }
      const address = privateKeyToAccount(next[k]).address;
      const balanceWei = BigInt(await rpcCall(next.L1_RPC, 'eth_getBalance', [address, 'latest'], fetchImpl));
      const f = rollupFundingLevel({ balanceWei, gasPriceWei });
      const eth = `${balanceWei / 10n ** 18n}.${(balanceWei % 10n ** 18n).toString().padStart(18, '0').slice(0, 6)} ETH`;
      if (f.level === 'ok') lines.push(`${who} ${address}: ${eth} (about ${f.callsLeft} L1 calls).`);
      else lines.push(`WARNING (${f.level}): ${who} ${address} has ${eth}, about ${f.callsLeft} L1 calls. Top it up on L1.`);
    }
  } catch {
    lines.push('The L1 RPC did not answer (check L1_RPC); chain id and balances not checked.');
  }
  return { chainId, lines };
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
      commands: ['cd voting_node', 'npm install', 'set -a; . ./.env; set +a; L1_RPC= npm run dev'],
      open: `http://localhost:${port}/setup`,
    };
  }
  if (deploy === 'coolify') {
    const plain = ['ADMIN_HANDLE', 'SUPER_ADMIN_EMAIL', 'CHAIN_ID', 'ENTROPY_CEREMONY_URL', 'VOTE_FQDN', 'TRUST_PROXY', 'BRAND_NAME',
      'COMPOSE_PROFILES', 'L1_CHAIN_ID', 'ROLLUP_ADDRESS', 'ROLLUP_DEPLOYMENT_FILE', 'ROLLUP_JURISDICTION_ID', 'ZK_VOTING_ALLOW_MOCK_PROOFS'];
    return {
      coolify: [
        'New resource → Public (or Private) Repository → this repository, branch test/unstable (staging) or master (production)',
        'Build pack: Docker Compose',
        'Base Directory: /voting_node',
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
    commands: ['cd voting_node', 'docker compose up -d --build', `curl -fsS http://127.0.0.1:${port}/health`],
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
      p.say('  - Environment Variables (secret: tick "Is secret"/locked; copy each value from voting_node/.env, not shown here):');
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
  if (deploy !== 'node' && !next.DATABASE_URL) {
    p.say('  Compose will not start until POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB, and DATABASE_URL are set.');
    p.say('  Run ./setup.sh again and pick the bundled Postgres to have them generated.');
    p.say('');
  }
  if (deploy === 'node' && /@db:5432\//.test(next.DATABASE_URL || '')) {
    p.say('  DATABASE_URL points at the Compose db service, which only resolves inside Docker Compose.');
    p.say('');
  }
  if (deploy === 'node') p.say('  (Node only runs without the rollup: polls work, civic votes need docker compose or an L1.)');
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

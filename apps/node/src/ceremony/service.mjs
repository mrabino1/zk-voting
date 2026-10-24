// NOT FOR PROFIT — civic public good, not a commercial product.
// Phase-2 Groth16 trusted-setup ceremony, run from the Node UI.
//
// One ceremony per circuit. Phase 1 is a public powers-of-tau file with a
// pinned hash (see ptau.mjs). Participants contribute one at a time, in the
// browser, from the current tip. The server checks every upload with
// `snarkjs zkey verify` (verifyFromR1cs) against the circuit and ptau and
// accepts it only if it adds exactly one contribution on top of the accepted
// chain. A precommitted public beacon closes the chain. The coordinator then
// exports the final zkey, verification key, and Solidity verifier for a
// human to review. Nothing here deploys or edits contracts.
//
// Storage follows the Store pattern: metadata lives in zk-voting.json
// (`ceremonies`, written through store.persist, which honours the writer lease
// and standby guard). Binary files live under CEREMONY_DIR
// (default DATA_DIR/ceremonies/<id>/), using the same file names as
// circuits/scripts/ceremony.mjs: circuit.r1cs, phase2.ptau, zkey_0000.zkey…,
// zkey_final.zkey, transcript.json, export/.
//
// Entropy never reaches this server. The browser mixes it into the
// contribution; the server only ever sees the resulting zkey.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

import * as snarkjs from 'snarkjs';

import { HttpError } from '../http.mjs';
import { canonicalJson } from '../superAdmin/audit.mjs';
import {
  BEACON_SOURCE,
  DEFAULT_BEACON_ITERATIONS,
  DEFAULT_MIN_BLOCKS_AHEAD,
  beaconName,
  parseBeaconValue,
  parsePrecommit,
} from './beacon.mjs';
import { EthRpcError, createEthRpc } from './eth.mjs';
import { hashAlgorithmFor, hashFile, ptauPreset } from './ptau.mjs';
import {
  assertBeaconParams,
  assertParticipantName,
  captureLogger,
  parseCircuitHash,
  parseVerifiedContributions,
} from './snarkjsLog.mjs';

export const CEREMONY_SCHEMA = 'zk-voting.groth16.phase2.ceremony.v1';
export const WEB_TRANSCRIPT_SCHEMA = 'zk-voting.groth16.phase2.web-transcript.v1';
export const RECEIPT_SCHEMA = 'zk-voting.groth16.phase2.receipt.v1';
export const EXPORT_SCHEMA = 'zk-voting.groth16.phase2.export.v1';
export const CHAIN_GENESIS = '0'.repeat(64);

/** Default minimum is 3 contributions; the CLI floor is 2. */
export const DEFAULT_MIN_CONTRIBUTIONS = 3;
export const MIN_CONTRIBUTIONS_FLOOR = 2;
export const DEFAULT_TURN_MINUTES = 30;
export const MAX_ATTESTATION_CHARS = 4000;
export const MAX_ALLOWLIST = 500;
export const MAX_INVITES = 2000;
export const DEFAULT_INVITE_DAYS = 14;
export const MAX_INVITE_DAYS = 90;
/** Invite-only is the only participation mode (decision 2026-10-24). */
export const PARTICIPATION_MODE = 'invite';
/** A contribution adds a few hundred bytes. Anything bigger is not one. */
export const MAX_CONTRIBUTION_GROWTH = 64 * 1024;

const CIRCUIT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const INPUT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.(r1cs|ptau)$/;
const HANDLE_RE = /^[^\s,<>"'`]{1,64}$/;
const EMAIL_RE = /^[^\s@<>"'`,;]{1,64}@[^\s@<>"'`,;]{1,190}\.[^\s@<>"'`,;]{2,63}$/;
const INVITE_ID_RE = /^inv_[0-9a-f]{12}$/;
const STATUSES = ['initializing', 'draft', 'open', 'closed', 'finalizing', 'finalized', 'error'];

const require = createRequire(import.meta.url);

function snarkjsTemplatesDir() {
  // package.json "exports" hides subpaths; build/main.cjs sits next to templates/.
  return path.join(path.dirname(require.resolve('snarkjs')), '..', 'templates');
}

export function zkeyFileName(index) {
  return `zkey_${String(index).padStart(4, '0')}.zkey`;
}

function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function chainHash(prevHash, body) {
  return sha256Hex(`${prevHash}\n${canonicalJson(body)}`);
}

/** Verify a hash-chained list ({...body, prevHash, hash}). */
export function verifyHashChain(entries, bodyOf) {
  let prev = CHAIN_GENESIS;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.prevHash !== prev) return { ok: false, at: i, reason: 'prev_mismatch' };
    if (chainHash(prev, bodyOf(entry)) !== entry.hash) return { ok: false, at: i, reason: 'hash_mismatch' };
    prev = entry.hash;
  }
  return { ok: true, entries: entries.length, headHash: prev };
}

function auditBody(entry) {
  return {
    seq: entry.seq,
    at: entry.at,
    action: entry.action,
    actor: entry.actor || null,
    details: entry.details ?? null,
  };
}

export function contributionBody(entry) {
  return {
    index: entry.index,
    name: entry.name,
    contributionHash: entry.contributionHash,
    zkey: entry.zkey,
    zkeySha256: entry.zkeySha256,
    zkeyBytes: entry.zkeyBytes,
    prevZkeySha256: entry.prevZkeySha256,
    attestation: entry.attestation || null,
    acceptedAt: entry.acceptedAt,
    verifiedWith: entry.verifiedWith,
  };
}

function actorOf(user) {
  if (!user) return null;
  return { userId: user.id, handle: user.handle };
}

function normalizeHandle(raw) {
  return String(raw || '')
    .trim()
    .replace(/^@/, '')
    .toLowerCase();
}

function badRequest(message, code = 'CEREMONY_INVALID') {
  return new HttpError(400, message, { code });
}

function conflict(message, code = 'CEREMONY_STATE') {
  return new HttpError(409, message, { code });
}

/** Stream a request body to `dest`, refusing more than `maxBytes`. */
export async function streamToFile(req, dest, maxBytes) {
  const declared = Number(req.headers?.['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(413, `upload is larger than ${maxBytes} bytes`, { code: 'PAYLOAD_TOO_LARGE' });
  }
  let bytes = 0;
  const hash = createHash('sha256');
  const limiter = new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        cb(new HttpError(413, `upload is larger than ${maxBytes} bytes`, { code: 'PAYLOAD_TOO_LARGE' }));
        return;
      }
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(req, limiter, fs.createWriteStream(dest, { flags: 'wx', mode: 0o640 }));
  } catch (err) {
    await fsp.rm(dest, { force: true });
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, 'upload failed', { code: 'UPLOAD_FAILED' });
  }
  if (bytes === 0) {
    await fsp.rm(dest, { force: true });
    throw badRequest('upload is empty', 'UPLOAD_EMPTY');
  }
  return { bytes, sha256: hash.digest('hex') };
}

/** Invite fields the coordinator may see. Never the token hash. */
function inviteAdminRow(inv) {
  return {
    id: inv.id,
    kind: inv.kind,
    status: inv.status,
    handle: inv.handle || null,
    email: inv.email || null,
    createdAt: inv.createdAt,
    expiresAt: inv.expiresAt || null,
    acceptedAt: inv.acceptedAt || null,
    revokedAt: inv.revokedAt || null,
  };
}

function rpcHttpError(err) {
  if (err instanceof EthRpcError) {
    const status = err.code === 'CEREMONY_ETH_RPC_UNSET' ? 503 : err.code === 'CEREMONY_BEACON_FUTURE' ? 409 : 502;
    return new HttpError(status, err.message, { code: err.code });
  }
  return err;
}

export function createCeremonyService({ config, store, now = () => Date.now(), ethRpc = null, lookupUser = null }) {
  const rootDir = path.resolve(config.ceremonyDir || path.join(config.dataDir, 'ceremonies'));
  const inputDir = path.resolve(config.ceremonyInputDir || path.join(config.dataDir, 'ceremony-inputs'));
  const maxZkeyBytes = Number(config.ceremonyMaxZkeyBytes) || 1024 * 1024 * 1024;
  const maxInputBytes = Number(config.ceremonyMaxInputBytes) || 2 * 1024 * 1024 * 1024;
  const jobs = new Map();
  const queues = new Map();
  const eth = ethRpc || config.ceremonyEthRpc || createEthRpc({ urls: config.ceremonyEthRpcUrls || [] });
  const minBlocksAhead = Math.max(1, Number(config.ceremonyBeaconMinBlocksAhead) || DEFAULT_MIN_BLOCKS_AHEAD);
  const userByHandle = lookupUser || ((h) => (typeof store.getUserByHandle === 'function' ? store.getUserByHandle(h) : null));

  async function readEth(fn) {
    try {
      return await fn();
    } catch (err) {
      throw rpcHttpError(err);
    }
  }

  if (!Array.isArray(store.data.ceremonies)) store.data.ceremonies = [];

  const iso = () => new Date(now()).toISOString();

  function all() {
    if (!Array.isArray(store.data.ceremonies)) store.data.ceremonies = [];
    return store.data.ceremonies;
  }

  function find(id) {
    const c = all().find((row) => row.id === String(id));
    if (!c) throw new HttpError(404, 'ceremony not found', { code: 'CEREMONY_NOT_FOUND' });
    return c;
  }

  function dirFor(c) {
    const dir = path.join(rootDir, c.id);
    if (!dir.startsWith(rootDir + path.sep)) throw new Error('bad ceremony path');
    return dir;
  }

  function audit(c, action, actor, details = null) {
    c.audit = Array.isArray(c.audit) ? c.audit : [];
    const prev = c.audit[c.audit.length - 1];
    const body = auditBody({ seq: prev ? prev.seq + 1 : 1, at: iso(), action, actor, details });
    const prevHash = prev?.hash || CHAIN_GENESIS;
    c.audit.push({ ...body, prevHash, hash: chainHash(prevHash, body) });
  }

  /** Run `fn` after every earlier job for the same ceremony. */
  function enqueue(ceremonyId, kind, fn) {
    const job = {
      id: `job_${randomBytes(8).toString('hex')}`,
      ceremonyId,
      kind,
      status: 'running',
      error: null,
      result: null,
      startedAt: iso(),
      finishedAt: null,
    };
    jobs.set(job.id, job);
    const prev = queues.get(ceremonyId) || Promise.resolve();
    const run = prev
      .catch(() => {})
      .then(fn)
      .then(
        (result) => {
          job.status = 'done';
          job.result = result ?? null;
        },
        (err) => {
          job.status = 'failed';
          job.error = String(err?.message || err).slice(0, 500);
        },
      )
      .finally(() => {
        job.finishedAt = iso();
      });
    queues.set(ceremonyId, run);
    // Bound memory: keep the last 200 jobs.
    if (jobs.size > 200) jobs.delete(jobs.keys().next().value);
    return job;
  }

  function getJob(jobId) {
    const job = jobs.get(String(jobId));
    if (!job) throw new HttpError(404, 'job not found', { code: 'CEREMONY_JOB_NOT_FOUND' });
    return job;
  }

  async function whenIdle(ceremonyId) {
    await (queues.get(ceremonyId) || Promise.resolve()).catch(() => {});
  }

  async function persist() {
    await store.persist();
  }

  function tipIndex(c) {
    return c.contributions.length;
  }

  function tipFile(c) {
    return path.join(dirFor(c), zkeyFileName(tipIndex(c)));
  }

  function turnMs(c) {
    return Math.max(1, Number(c.participation.turnMinutes) || DEFAULT_TURN_MINUTES) * 60 * 1000;
  }

  /** Start the head's turn and drop heads whose turn ran out. */
  function advanceQueue(c) {
    let changed = false;
    if (c.status !== 'open') return changed;
    for (;;) {
      const head = c.queue[0];
      if (!head) break;
      if (!head.turnStartedAt) {
        head.turnStartedAt = iso();
        changed = true;
        break;
      }
      if (head.uploading) break;
      if (now() - Date.parse(head.turnStartedAt) <= turnMs(c)) break;
      c.queue.shift();
      audit(c, 'turn_expired', null, { position: 1 });
      changed = true;
    }
    return changed;
  }

  /** Expire stale turns on read. A standby node never writes. */
  async function tick(c) {
    if (store.writerActive === false) return;
    if (advanceQueue(c)) await persist();
  }

  function recover() {
    let changed = false;
    for (const c of all()) {
      if (c.status === 'initializing' || c.status === 'finalizing') {
        c.status = c.status === 'initializing' ? 'error' : 'closed';
        c.error = 'interrupted by a restart';
        changed = true;
      }
      for (const entry of c.queue || []) {
        if (entry.uploading) {
          delete entry.uploading;
          changed = true;
        }
      }
    }
    return changed;
  }
  recover();

  async function listInputs() {
    await fsp.mkdir(inputDir, { recursive: true });
    const names = await fsp.readdir(inputDir);
    const rows = [];
    for (const name of names.sort()) {
      if (!INPUT_NAME_RE.test(name)) continue;
      const st = await fsp.stat(path.join(inputDir, name));
      if (!st.isFile()) continue;
      rows.push({ name, kind: name.endsWith('.r1cs') ? 'r1cs' : 'ptau', bytes: st.size });
    }
    return rows;
  }

  async function saveInput(name, req, actor) {
    store.refuseIfStandby();
    const clean = String(name || '');
    if (!INPUT_NAME_RE.test(clean)) {
      throw badRequest('file name must end in .r1cs or .ptau and use letters, digits, dot, underscore, or hyphen');
    }
    await fsp.mkdir(inputDir, { recursive: true });
    const dest = path.join(inputDir, clean);
    if (fs.existsSync(dest)) throw conflict('an input with that name already exists', 'CEREMONY_INPUT_EXISTS');
    const tmp = path.join(inputDir, `.upload-${randomUUID()}`);
    const { bytes, sha256 } = await streamToFile(req, tmp, maxInputBytes);
    await fsp.rename(tmp, dest);
    return { name: clean, kind: clean.endsWith('.r1cs') ? 'r1cs' : 'ptau', bytes, sha256, uploadedBy: actor?.handle || null };
  }

  function inputPath(name) {
    const clean = String(name || '');
    if (!INPUT_NAME_RE.test(clean)) throw badRequest(`unknown input ${clean || '(empty)'}`);
    const file = path.join(inputDir, clean);
    if (!fs.existsSync(file)) throw badRequest(`input ${clean} is not in the ceremony input directory`, 'CEREMONY_INPUT_MISSING');
    return file;
  }

  /** Only the turn length is configurable; contribution is always invite-only. */
  function parseParticipation(body, fallback = {}) {
    if (body?.mode !== undefined && body.mode !== PARTICIPATION_MODE) {
      throw badRequest('ceremony contribution is invite-only; manage the invite list instead', 'CEREMONY_INVITE_ONLY_MODE');
    }
    const turnMinutes =
      body?.turnMinutes !== undefined ? Number(body.turnMinutes) : fallback.turnMinutes ?? DEFAULT_TURN_MINUTES;
    if (!Number.isInteger(turnMinutes) || turnMinutes < 1 || turnMinutes > 24 * 60) {
      throw badRequest('turn length must be 1 to 1440 minutes');
    }
    return { mode: PARTICIPATION_MODE, turnMinutes };
  }

  function splitHandles(raw) {
    const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\s,]+/) : [];
    const handles = [...new Set(list.map(normalizeHandle).filter(Boolean))];
    if (handles.length > MAX_ALLOWLIST) throw badRequest(`at most ${MAX_ALLOWLIST} handles at once`);
    for (const h of handles) if (!HANDLE_RE.test(h)) throw badRequest(`not a handle: ${h}`);
    return handles;
  }

  function invitesOf(c) {
    if (!Array.isArray(c.invites)) c.invites = [];
    return c.invites;
  }

  /** The server-side gate for join and upload. */
  function isInvited(c, user) {
    if (!user) return false;
    return invitesOf(c).some((inv) => inv.status === 'active' && inv.userId === user.id);
  }

  function inviteOnly() {
    return new HttpError(
      403,
      'This ceremony is invite only. Ask the ceremony coordinator for an invite.',
      { code: 'CEREMONY_INVITE_ONLY' },
    );
  }

  function newInviteId(c) {
    for (;;) {
      const id = `inv_${randomBytes(6).toString('hex')}`;
      if (!invitesOf(c).some((i) => i.id === id)) return id;
    }
  }

  function addAccountInvite(c, handle, actor) {
    const account = userByHandle(handle);
    if (!account) throw new HttpError(404, `no account with the handle ${handle}`, { code: 'CEREMONY_INVITE_NO_USER' });
    if (invitesOf(c).some((i) => i.status === 'active' && i.userId === account.id)) {
      throw conflict(`${handle} is already invited`, 'CEREMONY_INVITE_EXISTS');
    }
    if (invitesOf(c).length >= MAX_INVITES) throw conflict(`at most ${MAX_INVITES} invites per ceremony`);
    const inv = {
      id: newInviteId(c),
      kind: 'account',
      status: 'active',
      userId: account.id,
      handle: normalizeHandle(account.handle),
      createdAt: iso(),
      createdBy: actor?.userId || null,
    };
    invitesOf(c).push(inv);
    audit(c, 'invite_added', actor, { inviteId: inv.id, kind: inv.kind });
    return inv;
  }

  function addEmailInvite(c, rawEmail, days, actor) {
    const email = String(rawEmail || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 254) throw badRequest('not an email address');
    const now0 = now();
    if (
      invitesOf(c).some(
        (i) => i.kind === 'email' && i.email === email && i.status === 'pending' && Date.parse(i.expiresAt) > now0,
      )
    ) {
      throw conflict('that address already has an unused invite. Revoke it to issue a new one.', 'CEREMONY_INVITE_EXISTS');
    }
    if (invitesOf(c).length >= MAX_INVITES) throw conflict(`at most ${MAX_INVITES} invites per ceremony`);
    const life = days === undefined || days === '' || days === null ? DEFAULT_INVITE_DAYS : Number(days);
    if (!Number.isInteger(life) || life < 1 || life > MAX_INVITE_DAYS) {
      throw badRequest(`invite lifetime must be 1 to ${MAX_INVITE_DAYS} days`);
    }
    const token = randomBytes(32).toString('base64url');
    const inv = {
      id: newInviteId(c),
      kind: 'email',
      status: 'pending',
      email,
      tokenSha256: sha256Hex(token),
      createdAt: iso(),
      expiresAt: new Date(now0 + life * 24 * 60 * 60 * 1000).toISOString(),
      createdBy: actor?.userId || null,
    };
    invitesOf(c).push(inv);
    audit(c, 'invite_added', actor, { inviteId: inv.id, kind: inv.kind, expiresAt: inv.expiresAt });
    return { inv, token };
  }

  async function create(body, user) {
    store.refuseIfStandby();
    const circuitName = String(body?.circuitName || '').trim();
    if (!CIRCUIT_NAME_RE.test(circuitName)) {
      throw badRequest('circuit name must be 1-48 lowercase letters, digits, underscore, or hyphen');
    }
    const label = String(body?.label || circuitName).trim().slice(0, 120);
    const minContributions =
      body?.minContributions === undefined || body?.minContributions === ''
        ? DEFAULT_MIN_CONTRIBUTIONS
        : Number(body.minContributions);
    if (!Number.isInteger(minContributions) || minContributions < MIN_CONTRIBUTIONS_FLOOR || minContributions > 1000) {
      throw badRequest(`minimum contributions must be an integer from ${MIN_CONTRIBUTIONS_FLOOR} to 1000`);
    }
    const r1csSrc = inputPath(body?.r1cs);
    if (!r1csSrc.endsWith('.r1cs')) throw badRequest('r1cs input must be a .r1cs file');
    const ptauSrc = inputPath(body?.ptau);
    if (!ptauSrc.endsWith('.ptau')) throw badRequest('ptau input must be a .ptau file');
    const preset = body?.ptauPower !== undefined && body?.ptauPower !== '' ? ptauPreset(body.ptauPower) : null;
    if (body?.ptauPower !== undefined && body?.ptauPower !== '' && !preset) {
      throw badRequest('unknown Hermez ptau power');
    }
    const pinned = String(body?.ptauHash || preset?.blake2b || '')
      .trim()
      .toLowerCase();
    const algorithm = hashAlgorithmFor(pinned);
    if (!algorithm) {
      throw badRequest('pin the ptau hash: 64 hex (sha256) or 128 hex (blake2b-512, as published in the snarkjs README)');
    }
    const participation = parseParticipation(body?.participation || {});
    const initialHandles = splitHandles(body?.participation?.handles ?? body?.invite?.handles);
    for (const h of initialHandles) {
      if (!userByHandle(h)) throw new HttpError(404, `no account with the handle ${h}`, { code: 'CEREMONY_INVITE_NO_USER' });
    }

    const gotPtau = await hashFile(ptauSrc, algorithm);
    if (gotPtau !== pinned) {
      throw badRequest(`ptau ${algorithm} does not match the pinned hash (got ${gotPtau})`, 'CEREMONY_PTAU_HASH');
    }
    const r1csPin = String(body?.r1csSha256 || '').trim().toLowerCase();
    const r1csSha256 = await hashFile(r1csSrc, 'sha256');
    if (r1csPin && r1csPin !== r1csSha256) {
      throw badRequest(`r1cs sha256 does not match the pinned hash (got ${r1csSha256})`, 'CEREMONY_R1CS_HASH');
    }

    const id = `cer_${randomBytes(6).toString('hex')}`;
    const c = {
      schema: CEREMONY_SCHEMA,
      id,
      circuitName,
      label,
      status: 'initializing',
      error: null,
      createdAt: iso(),
      createdBy: actorOf(user),
      openedAt: null,
      closedAt: null,
      finalizedAt: null,
      minContributions,
      participation,
      circuit: {
        file: 'circuit.r1cs',
        sha256: r1csSha256,
        bytes: (await fsp.stat(r1csSrc)).size,
        source: path.basename(r1csSrc),
      },
      ptau: {
        file: 'phase2.ptau',
        source: path.basename(ptauSrc),
        bytes: (await fsp.stat(ptauSrc)).size,
        pinnedHash: pinned,
        pinnedAlgorithm: algorithm,
        sha256: algorithm === 'sha256' ? gotPtau : await hashFile(ptauSrc, 'sha256'),
        preset: preset ? { power: preset.power, file: preset.file, url: preset.url } : null,
      },
      initial: null,
      contributions: [],
      queue: [],
      contributors: [],
      invites: [],
      beacon: { precommit: null, history: [], applied: null },
      final: null,
      exported: null,
      audit: [],
    };
    const dir = dirFor(c);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.copyFile(r1csSrc, path.join(dir, 'circuit.r1cs'), fs.constants.COPYFILE_EXCL);
    await fsp.copyFile(ptauSrc, path.join(dir, 'phase2.ptau'), fs.constants.COPYFILE_EXCL);
    all().push(c);
    audit(c, 'created', actorOf(user), {
      circuitName,
      r1csSha256,
      ptauPinned: pinned,
      ptauAlgorithm: algorithm,
      minContributions,
      participation: { mode: participation.mode, turnMinutes: participation.turnMinutes },
    });
    for (const h of initialHandles) addAccountInvite(c, h, actorOf(user));
    await persist();

    const job = enqueue(id, 'initialize', async () => {
      try {
        const cap = captureLogger();
        const info = await snarkjs.r1cs.info(path.join(dir, 'circuit.r1cs'), cap.logger);
        const out = path.join(dir, zkeyFileName(0));
        const circuitHashBytes = await snarkjs.zKey.newZKey(
          path.join(dir, 'circuit.r1cs'),
          path.join(dir, 'phase2.ptau'),
          out,
          cap.logger,
        );
        if (!fs.existsSync(out)) throw new Error(`snarkjs groth16 setup failed: ${cap.text().slice(-400)}`);
        const st = await fsp.stat(out);
        c.circuit.constraints = Number(info?.nConstraints ?? 0) || null;
        c.circuit.publicInputs = Number(info?.nPubInputs ?? 0) + Number(info?.nOutputs ?? 0);
        c.initial = {
          zkey: zkeyFileName(0),
          zkeySha256: await hashFile(out, 'sha256'),
          zkeyBytes: st.size,
          circuitHash: circuitHashBytes
            ? Buffer.from(circuitHashBytes).toString('hex')
            : parseCircuitHash(cap.text()),
        };
        c.status = 'draft';
        audit(c, 'initialized', null, { zkeySha256: c.initial.zkeySha256, circuitHash: c.initial.circuitHash });
        await persist();
        await writeTranscriptFile(c);
        return { status: c.status };
      } catch (err) {
        c.status = 'error';
        c.error = String(err?.message || err).slice(0, 500);
        audit(c, 'initialize_failed', null, { error: c.error });
        await persist().catch(() => {});
        throw err;
      }
    });
    return { ceremony: c, job };
  }

  async function open(id, user) {
    store.refuseIfStandby();
    const c = find(id);
    if (c.status !== 'draft' && c.status !== 'closed') throw conflict(`cannot open a ${c.status} ceremony`);
    if (c.beacon.applied) throw conflict('the beacon was already applied');
    c.status = 'open';
    c.openedAt = c.openedAt || iso();
    c.closedAt = null;
    audit(c, 'opened', actorOf(user), null);
    advanceQueue(c);
    await persist();
    return c;
  }

  async function close(id, user) {
    store.refuseIfStandby();
    const c = find(id);
    if (c.status !== 'open') throw conflict(`cannot close a ${c.status} ceremony`);
    if (c.queue.some((q) => q.uploading)) throw conflict('a contribution is being verified. Try again shortly.');
    if (c.contributions.length < c.minContributions) {
      throw conflict(
        `need at least ${c.minContributions} accepted contributions before closing (have ${c.contributions.length})`,
        'CEREMONY_TOO_FEW',
      );
    }
    const pre = c.beacon.precommit;
    if (!pre) throw conflict('commit to a future beacon before closing the window', 'CEREMONY_NO_BEACON');
    if (pre.source !== BEACON_SOURCE) {
      throw conflict('commit to a future Ethereum mainnet block before closing', 'CEREMONY_BEACON_UNSUPPORTED');
    }
    const headBlock = await readEth(() => eth.headBlock());
    if (headBlock >= pre.blockNumber) {
      throw conflict(
        `the committed block ${pre.blockNumber} already exists (head ${headBlock}), so its hash is public. Commit to a later block, then close.`,
        'CEREMONY_BEACON_PAST',
      );
    }
    // The RPC read awaited; re-check state before changing it.
    if (c.status !== 'open') throw conflict(`cannot close a ${c.status} ceremony`);
    if (c.queue.some((q) => q.uploading)) throw conflict('a contribution is being verified. Try again shortly.');
    if (c.beacon.precommit !== pre) throw conflict('the beacon commitment changed. Try again.');
    c.status = 'closed';
    c.closedAt = iso();
    c.queue = [];
    audit(c, 'closed', actorOf(user), { contributions: c.contributions.length, headBlock });
    await persist();
    return c;
  }

  async function setParticipation(id, body, user) {
    store.refuseIfStandby();
    const c = find(id);
    if (['finalizing', 'finalized'].includes(c.status)) throw conflict(`ceremony is ${c.status}`);
    const next = parseParticipation(body, c.participation);
    c.participation = next;
    audit(c, 'participation_set', actorOf(user), { mode: next.mode, turnMinutes: next.turnMinutes });
    advanceQueue(c);
    await persist();
    return c;
  }

  async function precommitBeacon(id, body, user) {
    store.refuseIfStandby();
    const c = find(id);
    if (!['draft', 'open'].includes(c.status)) {
      throw conflict('the beacon can only be committed while the ceremony is draft or open');
    }
    const headBlock = await readEth(() => eth.headBlock());
    let pre;
    try {
      pre = parsePrecommit(body, { headBlock, minBlocksAhead });
    } catch (err) {
      throw badRequest(err.message, 'CEREMONY_BEACON_INVALID');
    }
    pre.committedAt = iso();
    if (c.beacon.precommit) c.beacon.history.push(c.beacon.precommit);
    c.beacon.precommit = pre;
    audit(c, 'beacon_committed', actorOf(user), pre);
    await persist();
    return c;
  }

  async function addInvites(id, body, user) {
    store.refuseIfStandby();
    const c = find(id);
    if (['finalizing', 'finalized', 'error'].includes(c.status)) throw conflict(`ceremony is ${c.status}`);
    const actor = actorOf(user);
    const hasEmail = body?.email !== undefined && body?.email !== '';
    const handles = splitHandles(body?.handles ?? body?.handle);
    if (hasEmail && handles.length) throw badRequest('invite by handle or by email, not both');
    if (hasEmail) {
      const { inv, token } = addEmailInvite(c, body.email, body.expiresInDays, actor);
      await persist();
      return {
        ceremony: c,
        invites: [inv],
        token,
        // A URL fragment never reaches the server, proxies, or Referer headers.
        invitePath: `/ceremony/${encodeURIComponent(c.id)}#invite=${token}`,
      };
    }
    if (!handles.length) throw badRequest('give an account handle or an email address');
    for (const h of handles) {
      if (!userByHandle(h)) throw new HttpError(404, `no account with the handle ${h}`, { code: 'CEREMONY_INVITE_NO_USER' });
    }
    const added = handles.map((h) => addAccountInvite(c, h, actor));
    await persist();
    return { ceremony: c, invites: added };
  }

  async function removeInvite(id, inviteId, user) {
    store.refuseIfStandby();
    const c = find(id);
    const clean = String(inviteId || '');
    if (!INVITE_ID_RE.test(clean)) throw badRequest('not an invite id');
    const inv = invitesOf(c).find((i) => i.id === clean);
    if (!inv) throw new HttpError(404, 'invite not found', { code: 'CEREMONY_INVITE_NOT_FOUND' });
    if (inv.status === 'revoked') throw conflict('that invite is already revoked', 'CEREMONY_INVITE_REVOKED');
    const wasStatus = inv.status;
    inv.status = 'revoked';
    inv.revokedAt = iso();
    delete inv.tokenSha256;
    let droppedFromQueue = false;
    if (inv.userId) {
      const i = c.queue.findIndex((q) => q.userId === inv.userId && !q.uploading);
      if (i !== -1) {
        c.queue.splice(i, 1);
        droppedFromQueue = true;
      }
    }
    audit(c, 'invite_removed', actorOf(user), { inviteId: inv.id, kind: inv.kind, was: wasStatus, droppedFromQueue });
    advanceQueue(c);
    await persist();
    return c;
  }

  /** Redeem a single-use email invite token for the signed-in account. */
  async function acceptInvite(id, token, user) {
    store.refuseIfStandby();
    const c = find(id);
    const raw = String(token || '');
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(raw)) {
      throw new HttpError(403, 'that invite link is not valid', { code: 'CEREMONY_INVITE_INVALID' });
    }
    if (['finalizing', 'finalized', 'error'].includes(c.status)) throw conflict(`ceremony is ${c.status}`);
    const digest = sha256Hex(raw);
    const inv = invitesOf(c).find((i) => i.kind === 'email' && i.tokenSha256 === digest);
    if (!inv || inv.status !== 'pending') {
      throw new HttpError(403, 'that invite link is not valid, was revoked, or was already used', {
        code: 'CEREMONY_INVITE_INVALID',
      });
    }
    if (Date.parse(inv.expiresAt) <= now()) {
      throw new HttpError(403, 'that invite link has expired. Ask the coordinator for a new one.', {
        code: 'CEREMONY_INVITE_EXPIRED',
      });
    }
    if (isInvited(c, user)) throw conflict('your account is already invited to this ceremony', 'CEREMONY_INVITE_EXISTS');
    inv.status = 'active';
    inv.userId = user.id;
    inv.handle = normalizeHandle(user.handle);
    inv.acceptedAt = iso();
    delete inv.tokenSha256;
    audit(c, 'invite_accepted', actorOf(user), { inviteId: inv.id });
    await persist();
    return c;
  }

  async function join(id, user) {
    store.refuseIfStandby();
    const c = find(id);
    if (c.status !== 'open') throw conflict('the contribution window is not open', 'CEREMONY_NOT_OPEN');
    const handle = normalizeHandle(user.handle);
    if (!isInvited(c, user)) throw inviteOnly();
    if (c.contributors.includes(user.id)) {
      throw conflict('you already contributed to this ceremony', 'CEREMONY_ALREADY_CONTRIBUTED');
    }
    if (c.queue.some((q) => q.userId === user.id)) throw conflict('you are already in the queue', 'CEREMONY_QUEUED');
    c.queue.push({ userId: user.id, handle, joinedAt: iso(), turnStartedAt: null });
    audit(c, 'joined', actorOf(user), { position: c.queue.length });
    advanceQueue(c);
    await persist();
    return c;
  }

  async function leave(id, user) {
    store.refuseIfStandby();
    const c = find(id);
    const i = c.queue.findIndex((q) => q.userId === user.id);
    if (i === -1) throw conflict('you are not in the queue', 'CEREMONY_NOT_QUEUED');
    if (c.queue[i].uploading) throw conflict('your contribution is being verified');
    c.queue.splice(i, 1);
    audit(c, 'left', actorOf(user), { position: i + 1 });
    advanceQueue(c);
    await persist();
    return c;
  }

  async function removeFromQueue(id, position, user) {
    store.refuseIfStandby();
    const c = find(id);
    const i = Number(position) - 1;
    if (!Number.isInteger(i) || i < 0 || i >= c.queue.length) throw badRequest('no one at that queue position');
    if (c.queue[i].uploading) throw conflict('that contribution is being verified');
    const [gone] = c.queue.splice(i, 1);
    audit(c, 'removed_from_queue', actorOf(user), { position: i + 1, handle: gone.handle });
    advanceQueue(c);
    await persist();
    return c;
  }

  /**
   * Accept a contributed zkey from the head of the queue. The body is
   * streamed to disk (size-limited); verification runs as a job.
   */
  async function submitContribution(id, user, { name, parentIndex, attestation }, req) {
    store.refuseIfStandby();
    const c = find(id);
    advanceQueue(c);
    if (!isInvited(c, user)) throw inviteOnly();
    if (c.status !== 'open') throw conflict('the contribution window is not open', 'CEREMONY_NOT_OPEN');
    const head = c.queue[0];
    if (!head || head.userId !== user.id) {
      throw conflict('it is not your turn. Join the queue and wait for your turn.', 'CEREMONY_NOT_YOUR_TURN');
    }
    if (head.uploading) throw conflict('your previous upload is still being verified', 'CEREMONY_BUSY');
    if (Number(parentIndex) !== tipIndex(c)) {
      throw conflict(
        `stale parent: you built on #${parentIndex}, the tip is #${tipIndex(c)}. Download the tip again.`,
        'CEREMONY_STALE_PARENT',
      );
    }
    let cleanName;
    try {
      cleanName = assertParticipantName(String(name || ''));
    } catch (err) {
      throw badRequest(err.message, 'CEREMONY_NAME_INVALID');
    }
    const note = attestation == null ? '' : String(attestation);
    if (note.length > MAX_ATTESTATION_CHARS) {
      throw badRequest(`attestation must be at most ${MAX_ATTESTATION_CHARS} characters`);
    }
    const prev = tipFile(c);
    const prevStat = await fsp.stat(prev);
    const limit = Math.min(maxZkeyBytes, prevStat.size + MAX_CONTRIBUTION_GROWTH);
    const incoming = path.join(dirFor(c), `incoming-${randomUUID()}.zkey`);
    const uploaded = await streamToFile(req, incoming, limit);
    if (uploaded.bytes <= prevStat.size) {
      await fsp.rm(incoming, { force: true });
      throw badRequest('upload is not larger than the tip zkey, so it cannot add a contribution', 'CEREMONY_NOT_A_CONTRIBUTION');
    }
    head.uploading = true;
    const expectedIndex = tipIndex(c) + 1;
    const job = enqueue(c.id, 'verify-contribution', async () => {
      try {
        const entry = await verifyAndAppend(c, user, {
          incoming,
          name: cleanName,
          attestation: note.trim() || null,
          expectedIndex,
          uploaded,
        });
        return { accepted: true, receipt: receiptFor(c, entry) };
      } catch (err) {
        await fsp.rm(incoming, { force: true });
        const h = c.queue.find((q) => q.userId === user.id);
        if (h) delete h.uploading;
        audit(c, 'contribution_rejected', actorOf(user), { reason: String(err?.message || err).slice(0, 300) });
        await persist().catch(() => {});
        throw err;
      }
    });
    await persist();
    return job;
  }

  async function verifyChain(c, zkeyPath) {
    const dir = dirFor(c);
    const cap = captureLogger();
    const ok = await snarkjs.zKey.verifyFromR1cs(
      path.join(dir, 'circuit.r1cs'),
      path.join(dir, 'phase2.ptau'),
      zkeyPath,
      cap.logger,
    );
    if (ok !== true) throw new Error('snarkjs zkey verify rejected the file');
    return { contributions: parseVerifiedContributions(cap.text()), circuitHash: parseCircuitHash(cap.text()) };
  }

  async function verifyAndAppend(c, user, { incoming, name, attestation, expectedIndex, uploaded }) {
    if (c.status !== 'open') throw new Error('the window closed before verification finished');
    if (!isInvited(c, user)) throw new Error('the invite was revoked before verification finished');
    if (tipIndex(c) + 1 !== expectedIndex) throw new Error('the chain moved during verification');
    const { contributions: found, circuitHash } = await verifyChain(c, incoming);
    if (c.initial?.circuitHash && circuitHash && circuitHash !== c.initial.circuitHash) {
      throw new Error('circuit hash does not match this ceremony');
    }
    if (found.length !== expectedIndex) {
      throw new Error(`expected exactly one new contribution (#${expectedIndex}); the file has ${found.length}`);
    }
    for (let i = 0; i < c.contributions.length; i++) {
      if (found[i].hash !== c.contributions[i].contributionHash) {
        throw new Error(`contribution #${i + 1} does not match the accepted chain`);
      }
    }
    const last = found[found.length - 1];
    if (last.beacon) throw new Error('a beacon is not a participant contribution');
    if (last.name !== name) throw new Error(`the zkey names its contributor "${last.name}", not "${name}"`);

    const dest = path.join(dirFor(c), zkeyFileName(expectedIndex));
    if (fs.existsSync(dest)) throw new Error(`${path.basename(dest)} already exists`);
    await fsp.rename(incoming, dest);
    const prevEntry = c.contributions[c.contributions.length - 1];
    const body = contributionBody({
      index: expectedIndex,
      name,
      contributionHash: last.hash,
      zkey: zkeyFileName(expectedIndex),
      zkeySha256: uploaded.sha256,
      zkeyBytes: uploaded.bytes,
      prevZkeySha256: prevEntry ? prevEntry.zkeySha256 : c.initial.zkeySha256,
      attestation,
      acceptedAt: iso(),
      verifiedWith: 'snarkjs zKey.verifyFromR1cs (circuit.r1cs, phase2.ptau)',
    });
    const prevHash = prevEntry?.hash || CHAIN_GENESIS;
    const entry = { ...body, prevHash, hash: chainHash(prevHash, body) };
    c.contributions.push(entry);
    c.contributors.push(user.id);
    const i = c.queue.findIndex((q) => q.userId === user.id);
    if (i !== -1) c.queue.splice(i, 1);
    audit(c, 'contribution_accepted', actorOf(user), {
      index: entry.index,
      contributionHash: entry.contributionHash,
      zkeySha256: entry.zkeySha256,
    });
    advanceQueue(c);
    await persist();
    await writeTranscriptFile(c);
    return entry;
  }

  function receiptFor(c, entry) {
    return {
      schema: RECEIPT_SCHEMA,
      product: 'zk-voting',
      ceremonyId: c.id,
      circuit: c.circuitName,
      index: entry.index,
      name: entry.name,
      contributionHash: entry.contributionHash,
      zkeySha256: entry.zkeySha256,
      prevZkeySha256: entry.prevZkeySha256,
      transcriptEntryHash: entry.hash,
      acceptedAt: entry.acceptedAt,
      verify: `snarkjs zkey verify circuit.r1cs phase2.ptau ${entry.zkey}`,
    };
  }

  async function finalize(id, body, user) {
    store.refuseIfStandby();
    const c = find(id);
    if (c.status !== 'closed') throw conflict('close the contribution window before finalizing');
    const pre = c.beacon.precommit;
    if (!pre) throw conflict('no beacon was committed', 'CEREMONY_NO_BEACON');
    if (pre.source !== BEACON_SOURCE) throw conflict('the committed beacon is not an Ethereum block', 'CEREMONY_BEACON_UNSUPPORTED');
    if (c.contributions.length < c.minContributions) throw conflict('too few contributions', 'CEREMONY_TOO_FEW');
    // Fail closed: no RPC, an unreached block, or an unfinalized block all refuse.
    const headBlock = await readEth(() => eth.headBlock());
    if (headBlock < pre.blockNumber) {
      throw conflict(
        `block ${pre.blockNumber} is not mined yet (head ${headBlock}). Finalize after it is finalized, about 13 minutes later.`,
        'CEREMONY_BEACON_FUTURE',
      );
    }
    const finalizedBlock = await readEth(() => eth.finalizedBlock());
    if (finalizedBlock < pre.blockNumber) {
      throw conflict(
        `block ${pre.blockNumber} is mined but not finalized yet (finalized ${finalizedBlock}). Try again shortly.`,
        'CEREMONY_BEACON_NOT_FINALIZED',
      );
    }
    const block = await readEth(() => eth.block(pre.blockNumber));
    let value;
    let params;
    try {
      value = parseBeaconValue(block.hash);
      if (body?.beaconValue !== undefined && body.beaconValue !== '' && parseBeaconValue(body.beaconValue) !== value) {
        throw new Error(`the pasted value does not match the hash of block ${pre.blockNumber} read from the RPC`);
      }
      params = assertBeaconParams(
        value,
        body?.iterations === undefined || body?.iterations === '' ? DEFAULT_BEACON_ITERATIONS : body.iterations,
      );
    } catch (err) {
      throw badRequest(err.message, 'CEREMONY_BEACON_INVALID');
    }
    if (c.status !== 'closed') throw conflict('the ceremony is already being finalized');
    c.status = 'finalizing';
    audit(c, 'finalize_started', actorOf(user), {
      blockNumber: pre.blockNumber,
      blockHash: block.hash,
      finalizedBlock,
      iterations: params.iterations,
    });
    await persist();
    const job = enqueue(c.id, 'finalize', async () => {
      try {
        const dir = dirFor(c);
        const dest = path.join(dir, 'zkey_final.zkey');
        await fsp.rm(dest, { force: true });
        const cap = captureLogger();
        const name = beaconName(pre);
        await snarkjs.zKey.beacon(tipFile(c), dest, name, params.hash, params.iterations, cap.logger);
        if (!fs.existsSync(dest)) throw new Error('snarkjs zkey beacon did not write zkey_final.zkey');
        const { contributions: found } = await verifyChain(c, dest);
        if (found.length !== c.contributions.length + 1) throw new Error('final zkey must add exactly the beacon');
        for (let i = 0; i < c.contributions.length; i++) {
          if (found[i].hash !== c.contributions[i].contributionHash) {
            throw new Error(`final zkey contribution #${i + 1} does not match the transcript`);
          }
        }
        const b = found[found.length - 1];
        if (!b.beacon || b.beacon.hash !== params.hash || b.beacon.iterations !== params.iterations) {
          throw new Error('final zkey beacon does not match the committed value');
        }
        c.beacon.applied = {
          source: BEACON_SOURCE,
          network: pre.network,
          chainId: pre.chainId,
          blockNumber: pre.blockNumber,
          blockHash: block.hash,
          parentHash: block.parentHash,
          blockTimestamp: block.timestamp,
          finalizedBlockAtRead: finalizedBlock,
          rpcEndpoints: eth.endpointCount ?? null,
          value: params.hash,
          iterations: params.iterations,
          name,
          contributionHash: b.hash,
          appliedAt: iso(),
          lookupUrl: pre.lookupUrl,
          precommit: pre,
        };
        c.final = {
          zkey: 'zkey_final.zkey',
          zkeySha256: await hashFile(dest, 'sha256'),
          zkeyBytes: (await fsp.stat(dest)).size,
        };
        c.exported = await exportArtifacts(c);
        c.status = 'finalized';
        c.finalizedAt = iso();
        audit(c, 'finalized', actorOf(user), { finalZkeySha256: c.final.zkeySha256, exported: c.exported.files });
        await persist();
        await writeTranscriptFile(c);
        return { status: c.status, exported: c.exported };
      } catch (err) {
        c.status = 'closed';
        c.error = String(err?.message || err).slice(0, 500);
        audit(c, 'finalize_failed', actorOf(user), { error: c.error });
        await persist().catch(() => {});
        throw err;
      }
    });
    return job;
  }

  function solidityBanner(c) {
    return [
      '// SPDX-License-Identifier: GPL-3.0',
      '// ---------------------------------------------------------------------------',
      `// zk-voting phase-2 ceremony output — circuit "${c.circuitName}", ceremony ${c.id}.`,
      '// REVIEW BEFORE USE. Exported by the coordinator UI for a human to check.',
      '// Not deployed and not copied into smart-contracts/ by any tool.',
      '// Verify the transcript first: docs/ceremony-web.md#how-to-verify.',
      '// ---------------------------------------------------------------------------',
      '',
    ].join('\n');
  }

  async function exportArtifacts(c) {
    const dir = dirFor(c);
    const out = path.join(dir, 'export');
    await fsp.mkdir(out, { recursive: true });
    const zkey = path.join(dir, 'zkey_final.zkey');
    const vkey = await snarkjs.zKey.exportVerificationKey(zkey);
    const vkeyName = `${c.circuitName}_verification_key.json`;
    await fsp.writeFile(path.join(out, vkeyName), `${JSON.stringify(vkey, null, 2)}\n`);
    const template = await fsp.readFile(path.join(snarkjsTemplatesDir(), 'verifier_groth16.sol.ejs'), 'utf8');
    const sol = await snarkjs.zKey.exportSolidityVerifier(zkey, { groth16: template });
    const solName = `${c.circuitName}_Groth16Verifier.sol`;
    await fsp.writeFile(path.join(out, solName), solidityBanner(c) + sol.replace(/^\/\/ SPDX-License-Identifier:[^\n]*\n/, ''));
    const zkeyName = `${c.circuitName}_final.zkey`;
    await fsp.copyFile(zkey, path.join(out, zkeyName));
    const files = {};
    for (const name of [zkeyName, vkeyName, solName]) {
      files[name] = await hashFile(path.join(out, name), 'sha256');
    }
    const manifest = {
      schema: EXPORT_SCHEMA,
      product: 'zk-voting',
      ceremonyId: c.id,
      circuit: c.circuitName,
      exportedAt: iso(),
      trusted: false,
      review: 'pending-human-review',
      note: 'Artifacts for a human to review. No tool deploys them or writes them into smart-contracts/.',
      files,
    };
    await fsp.writeFile(path.join(out, 'export.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    files['export.json'] = await hashFile(path.join(out, 'export.json'), 'sha256');
    return { dir: 'export', files, exportedAt: manifest.exportedAt };
  }

  function transcriptDoc(c) {
    const chain = verifyHashChain(c.contributions, contributionBody);
    const auditChain = verifyHashChain(c.audit || [], auditBody);
    return {
      schema: WEB_TRANSCRIPT_SCHEMA,
      product: 'zk-voting',
      nfp: true,
      ceremonyId: c.id,
      circuit: { name: c.circuitName, label: c.label, ...c.circuit },
      ptau: c.ptau,
      status: c.status,
      trusted: false,
      review: c.status === 'finalized' ? 'pending-human-review' : 'in-progress',
      minContributions: c.minContributions,
      participation: {
        mode: 'invite-only',
        // Pseudonymous invite ids only: no handles, emails, or account ids.
        invitees: invitesOf(c)
          .filter((i) => i.status !== 'pending' || Date.parse(i.expiresAt) > now())
          .map((i) => ({ id: i.id, status: i.status })),
      },
      createdAt: c.createdAt,
      openedAt: c.openedAt,
      closedAt: c.closedAt,
      finalizedAt: c.finalizedAt,
      initial: c.initial,
      contributions: c.contributions,
      chainHead: chain.ok ? chain.headHash : null,
      chainOk: chain.ok,
      beacon: {
        precommit: c.beacon.precommit,
        history: c.beacon.history,
        applied: c.beacon.applied,
      },
      final: c.final,
      exported: c.exported,
      auditHead: auditChain.ok ? auditChain.headHash : null,
      auditEntries: (c.audit || []).length,
      security:
        'Secure if at least one participant was honest and destroyed their entropy (toxic waste). ' +
        'The beacon only rules out a last-contributor bias; it adds no secrecy.',
      beaconCheck:
        'beacon.applied.blockHash must equal the hash of Ethereum mainnet block beacon.applied.blockNumber ' +
        '(any explorer or node: eth_getBlockByNumber). beacon.applied.value is that hash without 0x.',
    };
  }

  async function writeTranscriptFile(c) {
    const file = path.join(dirFor(c), 'transcript.json');
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, `${JSON.stringify(transcriptDoc(c), null, 2)}\n`);
    await fsp.rename(tmp, file);
  }

  /** Public view. No user ids or handles; queue shows positions only. */
  function publicView(c, user = null) {
    const me = user ? c.queue.findIndex((q) => q.userId === user.id) : -1;
    const head = c.queue[0];
    return {
      id: c.id,
      circuitName: c.circuitName,
      label: c.label,
      status: c.status,
      error: c.status === 'error' ? c.error : null,
      createdAt: c.createdAt,
      openedAt: c.openedAt,
      closedAt: c.closedAt,
      finalizedAt: c.finalizedAt,
      minContributions: c.minContributions,
      participationMode: PARTICIPATION_MODE,
      invitedCount: invitesOf(c).filter((i) => i.status === 'active').length,
      turnMinutes: c.participation.turnMinutes,
      circuit: c.circuit,
      ptau: c.ptau,
      initial: c.initial,
      tipIndex: tipIndex(c),
      tipZkey: c.initial ? zkeyFileName(tipIndex(c)) : null,
      contributions: c.contributions,
      queueLength: c.queue.length,
      beacon: c.beacon,
      final: c.final,
      exported: c.exported,
      me: user
        ? {
            queued: me !== -1,
            position: me === -1 ? null : me + 1,
            yourTurn: me === 0 && c.status === 'open',
            turnStartedAt: me === 0 ? head.turnStartedAt : null,
            turnEndsAt:
              me === 0 && head.turnStartedAt ? new Date(Date.parse(head.turnStartedAt) + turnMs(c)).toISOString() : null,
            verifying: me !== -1 && Boolean(c.queue[me].uploading),
            contributed: c.contributors.includes(user.id),
            invited: isInvited(c, user),
          }
        : null,
    };
  }

  function adminView(c) {
    return {
      ...publicView(c),
      error: c.error,
      createdBy: c.createdBy,
      participation: c.participation,
      invites: invitesOf(c).map(inviteAdminRow),
      queue: c.queue.map((q, i) => ({
        position: i + 1,
        handle: q.handle,
        joinedAt: q.joinedAt,
        turnStartedAt: q.turnStartedAt,
        uploading: Boolean(q.uploading),
      })),
      audit: c.audit,
      auditChain: verifyHashChain(c.audit || [], auditBody),
    };
  }

  const PUBLIC_FILE_RE = /^(circuit\.r1cs|phase2\.ptau|zkey_\d{4}\.zkey|zkey_final\.zkey|transcript\.json)$/;
  const EXPORT_FILE_RE = /^[a-z0-9_-]+_(final\.zkey|verification_key\.json|Groth16Verifier\.sol)$|^export\.json$/;

  function publicFile(c, name, { exported = false } = {}) {
    const clean = String(name || '');
    if (exported) {
      if (!c.exported || !EXPORT_FILE_RE.test(clean) || !c.exported.files[clean]) return null;
      return path.join(dirFor(c), 'export', clean);
    }
    if (!PUBLIC_FILE_RE.test(clean)) return null;
    const file = path.join(dirFor(c), clean);
    return fs.existsSync(file) ? file : null;
  }

  return {
    rootDir,
    inputDir,
    maxZkeyBytes,
    maxInputBytes,
    list: () => all(),
    find,
    tick,
    listInputs,
    saveInput,
    create,
    open,
    close,
    setParticipation,
    addInvites,
    removeInvite,
    acceptInvite,
    isInvited,
    precommitBeacon,
    join,
    leave,
    removeFromQueue,
    submitContribution,
    finalize,
    getJob,
    whenIdle,
    transcriptDoc,
    publicView,
    adminView,
    publicFile,
    verifyChain,
    eth,
    minBlocksAhead,
    statuses: STATUSES,
  };
}

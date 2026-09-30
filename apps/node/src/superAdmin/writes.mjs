// NOT FOR PROFIT — civic public good, not a commercial product.
// Safe write operations for the platform super-admin API.
// dryRun computes the after-summary and does not persist.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { electionState, STATE_NAMES } from '../electionState.mjs';
import { emailHint } from '../identity.mjs';
import { isRole } from '../roles.mjs';
import { HttpError } from '../http.mjs';
import { resolveFeedbackRateWindow } from '../config.mjs';
import { LOG_LEVELS, setLogLevel, getLogLevel } from './logs.mjs';
import { loadArchiveConfig } from '../../../../l2/archive/config.mjs';
import { runArchiveJob } from '../../../../l2/archive/job.mjs';

const CONFIG_ALLOW = new Set(['feedbackRateWindowSeconds', 'logLevel', 'archiveEnabled']);

export function dryRunRequested(req) {
  const query = String(req.query?.dryRun || '');
  if (query === '1' || query === 'true') return true;
  const body = req.body;
  return Boolean(body && (body.dryRun === true || body.dryRun === 1 || body.dryRun === '1'));
}

export function rejectUnknownConfig(body) {
  const extra = Object.keys(body || {}).filter((key) => key !== 'dryRun' && !CONFIG_ALLOW.has(key));
  if (extra.length) {
    throw new HttpError(400, 'config field is not tunable', {
      code: 'CONFIG_REJECTED',
      fields: extra.sort(),
    });
  }
}

function windowSummary(config) {
  return {
    feedbackRateWindowSeconds: config.feedbackRateWindowSeconds,
    logLevel: config.logLevel || getLogLevel(),
    archiveEnabled: config.archiveEnabled !== false,
  };
}

export async function writeConfig(deps, body, { dryRun }) {
  rejectUnknownConfig(body || {});
  const config = deps.config;
  const before = windowSummary(config);
  const next = { ...before };
  if (body.feedbackRateWindowSeconds != null) {
    const requested = Number(body.feedbackRateWindowSeconds);
    if (!Number.isFinite(requested) || requested < 3600) {
      throw new HttpError(400, 'feedbackRateWindowSeconds must be at least 3600', {
        code: 'CONFIG_REJECTED',
      });
    }
    next.feedbackRateWindowSeconds = resolveFeedbackRateWindow(requested);
  }
  if (body.logLevel != null) {
    const name = String(body.logLevel).trim().toLowerCase();
    if (!LOG_LEVELS.includes(name)) {
      throw new HttpError(400, 'logLevel must be error, warn, info, or debug', { code: 'LOG_LEVEL' });
    }
    next.logLevel = name;
  }
  if (body.archiveEnabled != null) {
    if (typeof body.archiveEnabled !== 'boolean') {
      throw new HttpError(400, 'archiveEnabled must be a boolean', { code: 'CONFIG_REJECTED' });
    }
    next.archiveEnabled = body.archiveEnabled;
  }
  if (!dryRun) {
    config.feedbackRateWindowSeconds = next.feedbackRateWindowSeconds;
    config.logLevel = next.logLevel;
    config.archiveEnabled = next.archiveEnabled;
    setLogLevel(next.logLevel);
    deps.store.data.runtime = deps.store.data.runtime || {};
    Object.assign(deps.store.data.runtime, next);
    await deps.store.persist();
  }
  return {
    status: 200,
    body: { ok: true, nfp: true, dryRun, applied: !dryRun, config: next },
    before,
    after: next,
  };
}

function superAdminContact(store) {
  const user = (store.data.users || []).find((row) => row && row.role === 'platform_super_admin');
  if (!user) return null;
  const to = String(user.contactEmail || user.email || '').trim();
  return { user, to };
}

export async function writeMailTest(deps, body, { dryRun }) {
  const extra = Object.keys(body || {}).filter((key) => key !== 'dryRun');
  if (extra.length) {
    throw new HttpError(400, 'test mail does not accept a recipient or body', { code: 'MAIL_REJECTED' });
  }
  const contact = superAdminContact(deps.store);
  const before = {
    sendCount: Number(deps.mailer?.sendCount || 0),
    contactSet: Boolean(contact?.to),
  };
  if (!contact?.to) {
    throw new HttpError(409, 'super admin contact email is not set', { code: 'NO_CONTACT_EMAIL' });
  }
  if (!dryRun) {
    await deps.mailer.send({
      to: contact.to,
      subject: 'Republic platform check',
      text: 'Platform super-admin mail path check.\n\nNOT FOR PROFIT — civic public good.\n',
      html: '<p>Platform super-admin mail path check.</p><p>NOT FOR PROFIT</p>',
      meta: { purpose: 'super-admin-test' },
    });
  }
  const after = {
    sendCount: Number(deps.mailer?.sendCount || 0),
    toHint: emailHint(contact.to),
    purpose: 'super-admin-test',
  };
  return {
    status: 200,
    body: { ok: true, nfp: true, dryRun, applied: !dryRun, ...after },
    before,
    after,
  };
}

export async function writeResendTerms(deps, body, { dryRun }) {
  const handle = String(body?.handle || '').trim();
  if (!handle) throw new HttpError(400, 'handle required', { code: 'HANDLE' });
  const extra = Object.keys(body || {}).filter((key) => key !== 'dryRun' && key !== 'handle');
  if (extra.length) throw new HttpError(400, 'unexpected field', { code: 'MAIL_REJECTED', fields: extra });
  const user = deps.store.getUserByHandle(handle);
  if (!user) throw new HttpError(404, 'not found', { code: 'NO_USER' });
  const before = { handle: user.handle, termsNoticeSet: Boolean(user.termsNotifiedHash) };
  const changed = Boolean(user.termsNotifiedHash || user.termsNotifiedAt);
  if (!dryRun && changed) {
    user.termsNotifiedHash = null;
    user.termsNotifiedAt = null;
    await deps.store.persist();
  }
  const after = { handle: user.handle, termsNoticeSet: false, wouldClear: changed };
  return {
    status: 200,
    body: {
      ok: true,
      nfp: true,
      dryRun,
      applied: !dryRun,
      changed,
      handle: user.handle,
      termsNoticeSet: false,
    },
    before,
    after,
  };
}

function userSummary(user) {
  return {
    handle: user.handle,
    role: user.role,
    status: user.suspendedAt ? 'suspended' : 'active',
  };
}

function assertMutableUser(user) {
  if (!user) throw new HttpError(404, 'not found', { code: 'NO_USER' });
  if (user.role === 'platform_super_admin') {
    throw new HttpError(400, 'cannot change a platform super admin', { code: 'ROLE_LOCKED' });
  }
}

export async function writeUserStatus(deps, handle, suspended, { dryRun }) {
  const user = deps.store.getUserByHandle(handle);
  assertMutableUser(user);
  const before = userSummary(user);
  const already = Boolean(user.suspendedAt) === suspended;
  if (!dryRun && !already) {
    user.suspendedAt = suspended ? new Date().toISOString() : null;
    if (suspended) {
      deps.store.data.sessions = (deps.store.data.sessions || []).filter((row) => row.userId !== user.id);
    }
    await deps.store.persist();
  }
  const after = {
    handle: user.handle,
    role: user.role,
    status: dryRun ? (suspended ? 'suspended' : 'active') : user.suspendedAt ? 'suspended' : 'active',
  };
  return {
    status: 200,
    body: { ok: true, nfp: true, dryRun, applied: !dryRun, changed: !already, user: after },
    before,
    after,
  };
}

export async function writeUserRole(deps, handle, role, { dryRun }) {
  const user = deps.store.getUserByHandle(handle);
  assertMutableUser(user);
  const next = String(role || '').trim();
  if (!isRole(next) || next === 'platform_super_admin') {
    throw new HttpError(400, 'role is not assignable', { code: 'ROLE' });
  }
  const before = userSummary(user);
  const changed = user.role !== next;
  if (!dryRun && changed) {
    user.role = next;
    await deps.store.persist();
  }
  const after = { handle: user.handle, role: dryRun ? next : user.role, status: before.status };
  return {
    status: 200,
    body: { ok: true, nfp: true, dryRun, applied: !dryRun, changed, user: after },
    before,
    after,
  };
}

export async function writeRevokeSessions(deps, handle, { dryRun }) {
  const user = deps.store.getUserByHandle(handle);
  if (!user) throw new HttpError(404, 'not found', { code: 'NO_USER' });
  const matching = (deps.store.data.sessions || []).filter((row) => row.userId === user.id);
  const before = { handle: user.handle, sessionCount: matching.length };
  if (!dryRun && matching.length) {
    deps.store.data.sessions = deps.store.data.sessions.filter((row) => row.userId !== user.id);
    await deps.store.persist();
  }
  const after = { handle: user.handle, sessionCount: dryRun ? 0 : matching.length === 0 ? 0 : 0 };
  return {
    status: 200,
    body: {
      ok: true,
      nfp: true,
      dryRun,
      applied: !dryRun,
      handle: user.handle,
      revokedSessions: matching.length,
    },
    before,
    after: { handle: user.handle, revokedSessions: matching.length },
  };
}

function electionSummary(election, now) {
  const state = electionState(election, now);
  return {
    id: String(election.id),
    status: STATE_NAMES[state] || 'Created',
    cutoffTime: election.cutoffTime,
    votingPaused: Boolean(election.votingPaused),
    tallied: Boolean(election.tally),
  };
}

export async function writeElectionLifecycle(deps, id, body, { dryRun }) {
  const action = String(body?.action || '').trim().toLowerCase();
  if (!['pause', 'resume', 'close', 'extend'].includes(action)) {
    throw new HttpError(400, 'action must be pause, resume, close, or extend', { code: 'ELECTION_ACTION' });
  }
  const election = deps.store.getElection(id);
  if (!election) throw new HttpError(404, 'not found', { code: 'NO_ELECTION' });
  if (election.tally) throw new HttpError(409, 'election already tallied', { code: 'TALLIED' });
  const now = Number(deps.config.nowFn());
  const before = electionSummary(election, now);
  let changed = false;
  if (action === 'pause') {
    changed = !election.votingPaused;
    if (!dryRun && changed) election.votingPaused = true;
  } else if (action === 'resume') {
    changed = Boolean(election.votingPaused);
    if (!dryRun && changed) election.votingPaused = false;
  } else if (action === 'close') {
    if (!(election.startTime < now)) {
      throw new HttpError(400, 'startTime must be before cutoffTime', { code: 'WINDOW' });
    }
    changed = election.cutoffTime > now;
    if (!dryRun && changed) election.cutoffTime = now;
  } else if (action === 'extend') {
    const cutoff = Number(body.cutoffTime);
    if (!Number.isInteger(cutoff)) throw new HttpError(400, 'cutoffTime must be unix seconds', { code: 'WINDOW' });
    if (!(cutoff > election.cutoffTime)) {
      throw new HttpError(400, 'cutoffTime must be later than the current deadline', { code: 'WINDOW' });
    }
    if (!(election.startTime < cutoff)) {
      throw new HttpError(400, 'startTime must be before cutoffTime', { code: 'WINDOW' });
    }
    changed = true;
    if (!dryRun) election.cutoffTime = cutoff;
  }
  if (!dryRun && changed) await deps.store.persist();
  const preview = {
    ...before,
    votingPaused: action === 'pause' ? true : action === 'resume' ? false : before.votingPaused,
    cutoffTime:
      action === 'close'
        ? Math.min(before.cutoffTime, now)
        : action === 'extend'
          ? Number(body.cutoffTime)
          : before.cutoffTime,
  };
  const after = dryRun ? preview : electionSummary(election, now);
  return {
    status: 200,
    body: { ok: true, nfp: true, dryRun, applied: !dryRun, action, changed, election: after },
    before,
    after,
  };
}

function blockDigests(dataDir) {
  const dir = path.join(dataDir, 'blocks');
  if (!fs.existsSync(dir)) return {};
  const out = {};
  for (const name of fs.readdirSync(dir)) {
    if (!/^\d+\.json$/.test(name)) continue;
    const buf = fs.readFileSync(path.join(dir, name));
    out[name] = createHash('sha256').update(buf).digest('hex');
  }
  return out;
}

export async function writeL2(deps, action, { dryRun }) {
  const name = String(action || '').trim().toLowerCase();
  if (!['archive', 'verify', 'heartbeat'].includes(name)) {
    throw new HttpError(400, 'action must be archive, verify, or heartbeat', { code: 'L2_ACTION' });
  }
  const before = {
    archiveEnabled: deps.config.archiveEnabled !== false,
    mode: deps.writer?.mode?.() || 'active',
    hashCheck: deps.store.data.runtime?.lastArchiveHashCheck?.status || 'not-run',
  };
  if (name === 'heartbeat') {
    let renewed = false;
    if (!dryRun && deps.writer?.lease && deps.writer.acceptingWrites()) {
      deps.writer.lease.heartbeat();
      renewed = true;
    }
    const after = { renewed: dryRun ? false : renewed, chainSealed: false, dryRun };
    return {
      status: 200,
      body: {
        ok: true,
        nfp: true,
        dryRun,
        applied: !dryRun,
        action: 'heartbeat',
        renewed: after.renewed,
        chainSealed: false,
        reason: renewed || dryRun ? null : 'lease_disabled',
      },
      before,
      after,
    };
  }
  if (name === 'verify') {
    const current = blockDigests(deps.config.dataDir);
    const prior = deps.store.data.runtime?.l2BlockHashes || null;
    const names = Object.keys(current);
    let matched = 0;
    let mismatched = 0;
    if (prior) {
      const keys = new Set([...Object.keys(prior), ...names]);
      for (const key of keys) {
        if (prior[key] && current[key] && prior[key] === current[key]) matched += 1;
        else mismatched += 1;
      }
    }
    const status = !prior ? 'baseline' : mismatched ? 'mismatch' : 'ok';
    const summary = { status, checked: names.length, matched: prior ? matched : names.length, mismatched };
    if (!dryRun) {
      deps.store.data.runtime = deps.store.data.runtime || {};
      deps.store.data.runtime.l2BlockHashes = current;
      deps.store.data.runtime.lastArchiveHashCheck = { at: new Date().toISOString(), ...summary };
      await deps.store.persist();
    }
    return {
      status: 200,
      body: { ok: true, nfp: true, dryRun, applied: !dryRun, action: 'verify', ...summary },
      before,
      after: summary,
    };
  }
  const env = {
    ARCHIVE_ENABLED: deps.config.archiveEnabled === false ? '0' : '1',
    ARCHIVE_S3_BUCKET: '',
    ARCHIVE_S3_ENDPOINT: '',
    ARCHIVE_S3_ACCESS_KEY_ID: '',
    ARCHIVE_S3_SECRET_ACCESS_KEY: '',
    ARCHIVE_EXPLORER_SNAPSHOT: '0',
  };
  if (dryRun) {
    const after = { action: 'archive', wouldRun: env.ARCHIVE_ENABLED === '1', chainSealed: false };
    return {
      status: 200,
      body: { ok: true, nfp: true, dryRun: true, applied: false, ...after },
      before,
      after,
    };
  }
  let result;
  try {
    result = await runArchiveJob({
      env,
      l2Config: {
        dataDir: deps.config.dataDir,
        chainId: deps.config.chainId,
        disclosureIntervalSeconds: deps.config.disclosureIntervalSeconds,
      },
      skipWriterLease: false,
    });
  } catch {
    throw new HttpError(502, 'archive job failed', { code: 'ARCHIVE_FAILED' });
  }
  const after = {
    action: 'archive',
    ok: Boolean(result?.ok),
    skipped: Boolean(result?.skipped),
    reason: result?.reason ? String(result.reason).slice(0, 180) : null,
    hourCount: Array.isArray(result?.hours) ? result.hours.length : 0,
    chainSealed: false,
  };
  return {
    status: 200,
    body: { ok: true, nfp: true, dryRun: false, applied: true, ...after },
    before,
    after,
  };
}

export async function writeLogLevel(deps, body, { dryRun }) {
  const extra = Object.keys(body || {}).filter((key) => key !== 'dryRun' && key !== 'level' && key !== 'logLevel');
  if (extra.length) throw new HttpError(400, 'unexpected field', { code: 'LOG_LEVEL', fields: extra });
  const name = String(body?.level ?? body?.logLevel ?? '').trim().toLowerCase();
  if (!LOG_LEVELS.includes(name)) {
    throw new HttpError(400, 'level must be error, warn, info, or debug', { code: 'LOG_LEVEL' });
  }
  const before = { logLevel: deps.config.logLevel || getLogLevel() };
  if (!dryRun) {
    setLogLevel(name);
    deps.config.logLevel = name;
    deps.store.data.runtime = deps.store.data.runtime || {};
    deps.store.data.runtime.logLevel = name;
    await deps.store.persist();
  }
  const after = { logLevel: name };
  return {
    status: 200,
    body: { ok: true, nfp: true, dryRun, applied: !dryRun, ...after },
    before,
    after,
  };
}

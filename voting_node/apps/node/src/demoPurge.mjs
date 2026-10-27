// NOT FOR PROFIT — civic public good, not a commercial product.
//
// Monthly soft-delete for the disposable public demo (IS_DEMO=true only).
// This file is the only place that marks those rows. It is not a generic
// delete, and nothing here is safe to point at a real election. Call it only
// from registerDemoPurgeSchedule. The job body checks IS_DEMO again and
// no-ops when the flag is not strictly true.
//
// Missing IS_DEMO, a blank value, false, 0, and any unrecognised value are
// not a demo. Only true/1 (any case) after parseIsDemo is a demo.
//
// Abusive / nefarious login — exact rule, using signals this process already
// records. A login is abusive when it is not the platform super admin and at
// least one of the following is already stored:
//
//   1. user.suspendedAt is set. That timestamp is the operator suspension
//      flag written by the super-admin user-status update.
//   2. user.demoAbuseSignals has an entry. Those entries are written only
//      while IS_DEMO is true, and only when an existing detector fires for a
//      known user:
//        RATE_LIMITED — ceremony sliding-window limiter, or the feedback
//          limiter, when the request has a signed-in user.
//        PIN_LOCKED — vote-PIN lockout at PIN_MAX_ATTEMPTS.
//        OTP_LOCKED — email MFA attempts past MAX_ATTEMPTS.
//        PASSKEY_VERIFY_FAILED — WebAuthn login verification throws or
//          returns verified=false, and the credential id already resolves
//          to a user.
//        HONEYPOT — feedback honeypot rejection on a signed-in user.
//   3. A non-revoked disqualification whose reason code is DUPLICATE_IDENTITY
//      (4), COURT_ORDER (9), FRAUD_HOLD (11), or SANCTION_OR_PROHIBITION (13),
//      joined through an identityLinks row that already stores that userId
//      and identityCommitment.
//
// Not abuse: eligibility disqualification codes (age, residence, citizenship,
// deceased, moved, district, ineligible status, expired or suspended, other),
// ALREADY_VOTED, anonymous rate-limit hits with no user id, and super-admin
// API-key buckets. PROOF_INVALID is not used: a civic ballot request carries
// no login, a failed proof is not stored, and the vote row has no user id
// (see the header of store.mjs). Inventing that join would break ballot
// unlinkability, so the targeted month does not soft-delete civic votes or
// envelopes.
//
// Targeted month (even UTC month index: January=0, March, …): soft-delete
// sessions whose userId is an abusive login, and poll ballots whose voter
// address equals an Ethereum address already stored on that login. Polls
// record the address on the ballot (public_weighted). Election shells and
// their question/option lists are not touched.
//
// Full month (odd UTC month index: February=1, April, …): soft-delete the
// user-data rows listed in fullSoftDelete. The phase is the calendar month,
// not a toggle, so a missed month does not flip it. meta.demoPurge.lastMonth
// (YYYY-MM) skips a second run in the same month.
//
// Both modes set is_deleted and deleted_at. They never splice a row out and
// never issue a SQL DELETE. Reads filter is_deleted separately.

const ABUSE_REASON_CODES = new Set([4, 9, 11, 13]);

const ABUSE_SIGNAL_CODES = new Set([
  'RATE_LIMITED',
  'PIN_LOCKED',
  'OTP_LOCKED',
  'PASSKEY_VERIFY_FAILED',
  'HONEYPOT',
]);

/** Row collections the full month marks. Election shells are not in this list. */
const FULL_ROW_COLLECTIONS = Object.freeze([
  'sessions',
  'votes',
  'envelopes',
  'receipts',
  'pollBallots',
  'pollResults',
  'notifications',
  'termsAcceptances',
  'outcomeSubscriptions',
  'outcomeReportDeliveries',
  'mailOutbox',
  'apiKeys',
  'registrationRequests',
  'identityLinks',
]);

function defaultLog(line) {
  console.info(line);
}

function asDate(now) {
  if (now instanceof Date) return now;
  const date = new Date(now);
  if (Number.isNaN(date.getTime())) return new Date();
  return date;
}

/** Even UTC month index → targeted. Odd → full. January is 0 (targeted). */
export function demoPurgeMode(now = new Date()) {
  const date = asDate(now);
  return date.getUTCMonth() % 2 === 0 ? 'targeted' : 'full';
}

export function demoPurgeMonthKey(now = new Date()) {
  const date = asDate(now);
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${date.getUTCFullYear()}-${month}`;
}

function live(row) {
  return row && typeof row === 'object' && row.is_deleted !== true;
}

function markDeleted(row, atIso) {
  if (!live(row)) return false;
  row.is_deleted = true;
  row.deleted_at = atIso;
  return true;
}

function addressesOf(user) {
  const out = new Set();
  const add = (value) => {
    const text = String(value || '').trim().toLowerCase();
    if (text) out.add(text);
  };
  add(user.activeEthAddress);
  for (const account of user.ethAccounts || []) {
    add(account && typeof account === 'object' ? account.address : account);
  }
  for (const method of user.authMethods || []) {
    if (method?.address) add(method.address);
  }
  return out;
}

function abusiveUserIds(data) {
  const users = (data.users || []).filter((user) => live(user) && user.role !== 'platform_super_admin');
  const commitmentsByUser = new Map();
  for (const link of data.identityLinks || []) {
    if (!live(link) || !link.userId || !link.identityCommitment) continue;
    if (!commitmentsByUser.has(link.userId)) commitmentsByUser.set(link.userId, new Set());
    commitmentsByUser.get(link.userId).add(String(link.identityCommitment).toLowerCase());
  }
  const flagged = new Set();
  for (const row of data.disqualifications || []) {
    if (!live(row) || row.revokedAt) continue;
    if (!ABUSE_REASON_CODES.has(Number(row.reasonCode))) continue;
    if (row.identityCommitment) flagged.add(String(row.identityCommitment).toLowerCase());
  }
  const ids = new Set();
  for (const user of users) {
    const signals = Array.isArray(user.demoAbuseSignals) ? user.demoAbuseSignals : [];
    const known = signals.some((entry) => ABUSE_SIGNAL_CODES.has(String(entry?.code || '')));
    let fraud = false;
    for (const commitment of commitmentsByUser.get(user.id) || []) {
      if (flagged.has(commitment)) fraud = true;
    }
    if (user.suspendedAt || known || fraud) ids.add(user.id);
  }
  return { ids, users };
}

function targetedSoftDelete(data, atIso) {
  const { ids, users } = abusiveUserIds(data);
  const addresses = new Set();
  for (const user of users) {
    if (!ids.has(user.id)) continue;
    for (const address of addressesOf(user)) addresses.add(address);
  }
  let marked = 0;
  for (const session of data.sessions || []) {
    if (ids.has(session.userId) && markDeleted(session, atIso)) marked += 1;
  }
  for (const ballot of data.pollBallots || []) {
    const voter = String(ballot?.voter || '').trim().toLowerCase();
    if (voter && addresses.has(voter) && markDeleted(ballot, atIso)) marked += 1;
  }
  return { marked, abusiveLogins: ids.size };
}

function fullSoftDelete(data, atIso) {
  let marked = 0;
  for (const name of FULL_ROW_COLLECTIONS) {
    for (const row of data[name] || []) {
      if (markDeleted(row, atIso)) marked += 1;
    }
  }
  for (const user of data.users || []) {
    if (!user || user.role === 'platform_super_admin') continue;
    if (markDeleted(user, atIso)) marked += 1;
  }
  return { marked, abusiveLogins: null };
}

/**
 * Record a detector this process already raised. No-op unless IS_DEMO was
 * parsed to true, so a real election never stores these marks. Does not
 * touch the platform super admin.
 */
export function noteDemoAbuse(store, config, userId, code) {
  if (config?.isDemo !== true) return false;
  if (!ABUSE_SIGNAL_CODES.has(code) || !store?.data?.users || !userId) return false;
  const user = store.data.users.find((row) => row && row.id === userId && row.is_deleted !== true);
  if (!user || user.role === 'platform_super_admin') return false;
  if (!Array.isArray(user.demoAbuseSignals)) user.demoAbuseSignals = [];
  user.demoAbuseSignals.push({ code, at: new Date().toISOString() });
  if (user.demoAbuseSignals.length > 20) {
    user.demoAbuseSignals.splice(0, user.demoAbuseSignals.length - 20);
  }
  const pending = typeof store.persist === 'function' ? store.persist() : null;
  if (pending && typeof pending.then === 'function') pending.catch(() => {});
  return true;
}

/**
 * One monthly pass. Re-checks IS_DEMO and refuses to run when it is not true.
 * @returns {Promise<{ ran: boolean, reason?: string, mode?: string, monthKey?: string, marked?: number }>}
 */
export async function runDemoMonthlyPurge({ config, store, now = new Date(), log = defaultLog } = {}) {
  if (config?.isDemo !== true) {
    log('[zk-voting] demo purge skipped: IS_DEMO is not true');
    return { ran: false, reason: 'not_demo', marked: 0 };
  }
  if (!store?.data) {
    log('[zk-voting] demo purge skipped: no store');
    return { ran: false, reason: 'no_store', marked: 0 };
  }
  if (store.writerActive === false) {
    log('[zk-voting] demo purge skipped: standby writer');
    return { ran: false, reason: 'standby', marked: 0 };
  }
  const date = asDate(now);
  const monthKey = demoPurgeMonthKey(date);
  const mode = demoPurgeMode(date);
  store.data.meta = store.data.meta || {};
  const state = store.data.meta.demoPurge && typeof store.data.meta.demoPurge === 'object'
    ? store.data.meta.demoPurge
    : {};
  if (state.lastMonth === monthKey) {
    log(`[zk-voting] demo purge skipped: already ran for ${monthKey}`);
    return { ran: false, reason: 'already_ran', mode, monthKey, marked: 0 };
  }
  const atIso = date.toISOString();
  const result = mode === 'full' ? fullSoftDelete(store.data, atIso) : targetedSoftDelete(store.data, atIso);
  store.data.meta.demoPurge = {
    lastMonth: monthKey,
    lastMode: mode,
    lastRunAt: atIso,
  };
  if (typeof store.persist === 'function') await store.persist();
  log(`[zk-voting] demo purge ${mode} for ${monthKey} soft-deleted ${result.marked} rows`);
  return { ran: true, mode, monthKey, marked: result.marked, abusiveLogins: result.abusiveLogins };
}

/**
 * Register the monthly check only when IS_DEMO is strictly true.
 * The timer calls runDemoMonthlyPurge, which checks the flag again.
 */
export function registerDemoPurgeSchedule({
  config,
  store,
  log = defaultLog,
  now = () => new Date(),
  setIntervalFn = setInterval,
  setTimeoutFn = setTimeout,
  intervalMs = 24 * 60 * 60 * 1000,
  kickMs = 15_000,
} = {}) {
  if (config?.isDemo !== true) {
    return { registered: false, stop() {} };
  }
  const tick = () => {
    Promise.resolve(runDemoMonthlyPurge({ config, store, now: now(), log })).catch((err) => {
      log(`[zk-voting] demo purge failed: ${err?.message || err}`);
    });
  };
  const interval = setIntervalFn(tick, intervalMs);
  if (interval && typeof interval.unref === 'function') interval.unref();
  const kick = setTimeoutFn(tick, kickMs);
  if (kick && typeof kick.unref === 'function') kick.unref();
  return {
    registered: true,
    stop() {
      clearInterval(interval);
      clearTimeout(kick);
    },
  };
}

// NOT FOR PROFIT — civic public good, not a commercial product.
// Hourly public disclosure so a person leaving a polling place cannot be
// matched to a live jurisdiction tick. Votes are accepted immediately (nullifier
// uniqueness). A block stays sealed until the hour has closed and
// DISCLOSURE_DELAY_SECONDS has elapsed, and the block has enough ballots.
// Turnout follows that clock from the first ballot. Poll per-choice counts
// wait for the results gate. An earlier note that promised publication at
// the hour boundary is replaced by this delay.

import { sealedResultsMessage } from './electionType.mjs';

export const DEFAULT_DISCLOSURE_INTERVAL_SECONDS = 3600;
export const DEFAULT_DISCLOSURE_DELAY_SECONDS = 1800;
export const DEFAULT_RESULTS_MIN_VOTES = 100;
export const DEFAULT_DISCLOSURE_MIN_BLOCK_VOTES = 10;

/** Types whose public appearance is delayed (polling-place correlation). */
export const DELAYED_PUBLIC_TYPES = Object.freeze(['vote']);

export function resolveDisclosureIntervalSeconds(raw, { isTest = false } = {}) {
  if (raw != null && raw !== '') {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return isTest ? 0 : DEFAULT_DISCLOSURE_INTERVAL_SECONDS;
    return Math.floor(n);
  }
  return isTest ? 0 : DEFAULT_DISCLOSURE_INTERVAL_SECONDS;
}

function resolveDefaultInt(raw, { isTest = false, testDefault = 0, prodDefault = 0 } = {}) {
  if (raw != null && raw !== '') {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return isTest ? testDefault : prodDefault;
    return Math.floor(n);
  }
  return isTest ? testDefault : prodDefault;
}

/** Extra wait after the hour closes. Tests default to 0 so hour-close fixtures stay put. */
export function resolveDisclosureDelaySeconds(raw, { isTest = false } = {}) {
  return resolveDefaultInt(raw, {
    isTest,
    testDefault: 0,
    prodDefault: DEFAULT_DISCLOSURE_DELAY_SECONDS,
  });
}

/** Poll per-choice counts wait until the gate opens once this many voters have cast their first ballot, or until the scheduled end. Turnout does not. Tests default to 0 (gate open). */
export function resolveResultsMinVotes(raw, { isTest = false } = {}) {
  return resolveDefaultInt(raw, {
    isTest,
    testDefault: 0,
    prodDefault: DEFAULT_RESULTS_MIN_VOTES,
  });
}

/** A disclosure block smaller than this merges forward. Tests default to 1. */
export function resolveDisclosureMinBlockVotes(raw, { isTest = false } = {}) {
  return resolveDefaultInt(raw, {
    isTest,
    testDefault: 1,
    prodDefault: DEFAULT_DISCLOSURE_MIN_BLOCK_VOTES,
  });
}

export function disclosureSettings(config = {}) {
  return {
    intervalSeconds: Number(config.disclosureIntervalSeconds) || 0,
    delaySeconds: Number(config.disclosureDelaySeconds) || 0,
    minBlockVotes:
      config.disclosureMinBlockVotes == null ? 1 : Number(config.disclosureMinBlockVotes),
    minVotes: Number(config.resultsMinVotes) || 0,
  };
}

export function publishedThrough(now, intervalSeconds, delaySeconds = 0) {
  const ts = Number(now);
  const interval = Number(intervalSeconds);
  const delay = Math.max(0, Math.floor(Number(delaySeconds) || 0));
  if (!Number.isFinite(ts)) return 0;
  if (!interval || interval <= 0) return ts + 1;
  const shifted = ts - delay;
  if (shifted < 0) return 0;
  return shifted - (shifted % interval);
}

export function nextPublishAt(now, intervalSeconds, delaySeconds = 0) {
  const ts = Number(now);
  const interval = Number(intervalSeconds);
  const delay = Math.max(0, Math.floor(Number(delaySeconds) || 0));
  if (!interval || interval <= 0) return ts;
  return publishedThrough(ts, interval, delay) + interval + delay;
}

export function lastClosedHourAt(now, intervalSeconds, delaySeconds = 0) {
  const ts = Number(now);
  const interval = Number(intervalSeconds);
  if (!Number.isFinite(ts)) return 0;
  if (!interval || interval <= 0) return ts;
  return publishedThrough(ts, interval, delaySeconds);
}

export function lastClosedHourStart(now, intervalSeconds, delaySeconds = 0) {
  const interval = Number(intervalSeconds);
  const last = lastClosedHourAt(now, intervalSeconds, delaySeconds);
  if (!interval || interval <= 0) return last;
  return last - interval;
}

export function secondsUntilNext(now, intervalSeconds, delaySeconds = 0) {
  const ts = Number(now);
  const interval = Number(intervalSeconds);
  if (!Number.isFinite(ts)) return 0;
  if (!interval || interval <= 0) return 0;
  return Math.max(0, nextPublishAt(ts, interval, delaySeconds) - ts);
}

export function formatCountdown(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(sec).padStart(2, '0')}s`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

export function isDisclosed(eventTs, now, intervalSeconds, delaySeconds = 0) {
  if (eventTs == null || eventTs === '') return true;
  const interval = Number(intervalSeconds);
  if (!interval || interval <= 0) return true;
  return Number(eventTs) < publishedThrough(now, intervalSeconds, delaySeconds);
}

/**
 * Poll per-choice counts wait until the gate opens once 100 voters have cast their first ballot, or until the scheduled
 * end has passed. minVotes <= 0 leaves the gate open.
 * TODO(#116): resultsGateOpen has no production caller yet and must be wired
 * into hourly per-choice blocks.
 */
export function resultsGateOpen({
  submittedVotes = 0,
  now,
  endTime = null,
  minVotes = 0,
  tallied = false,
} = {}) {
  const min = Number(minVotes) || 0;
  if (min <= 0) return true;
  if (tallied) return true;
  if (Number(submittedVotes) >= min) return true;
  if (endTime != null && endTime !== '' && Number.isFinite(Number(endTime)) && Number(now) >= Number(endTime)) {
    return true;
  }
  return false;
}

/**
 * Split sealed ballots into blocks that are safe to publish and rows that stay sealed.
 * Small hours merge forward. A trailing block under the minimum stays sealed until a
 * later hour fills it. At the deadline the still-open hour is the final block when
 * the election met the block floor. An election that never reached the block floor
 * stays sealed until a final tally. Turnout uses this clock from the first ballot.
 * The results gate is not applied here.
 */
export function planPublicBlocks(items, policy = {}) {
  const now = policy.now;
  const interval = Number(policy.intervalSeconds) || 0;
  const delay = Math.max(0, Math.floor(Number(policy.delaySeconds) || 0));
  const minRaw = Number(policy.minBlockVotes);
  const floor = Number.isFinite(minRaw) && minRaw > 1 ? Math.floor(minRaw) : 1;
  const electionContext = typeof policy.electionContext === 'function' ? policy.electionContext : () => ({});
  const byElection = new Map();
  for (const item of items || []) {
    const id = String(item.electionId ?? '');
    if (!byElection.has(id)) byElection.set(id, []);
    byElection.get(id).push(item);
  }
  const publish = [];
  const hold = [];
  for (const [electionId, group] of byElection) {
    const ctx = electionContext(electionId) || {};
    // Ballot rows are turnout. They publish on the hourly clock from the first
    // ballot. Per-choice counts stay with the callers that serve tallies.
    const submitted = ctx.submittedVotes ?? group.length;
    const tallied = Boolean(ctx.tallied);
    const endTime = ctx.endTime ?? null;
    const ended =
      endTime != null &&
      endTime !== '' &&
      Number.isFinite(Number(endTime)) &&
      Number(now) >= Number(endTime);
    const buckets = new Map();
    let waitingOnClock = 0;
    for (const item of group) {
      const ts = Number(item.receivedAt ?? item.acceptedAt);
      // Before the deadline the open hour stays sealed. At the deadline it is
      // the final block, for a poll and for a vote.
      if (!ended && interval > 0 && !isDisclosed(ts, now, interval, delay)) {
        waitingOnClock += 1;
        hold.push(item);
        continue;
      }
      const bucket = interval > 0 ? hourBucket(ts, interval) : 0;
      if (!buckets.has(bucket)) buckets.set(bucket, []);
      buckets.get(bucket).push(item);
    }
    const keys = [...buckets.keys()].sort((a, b) => a - b);
    let carry = [];
    let carryLast = null;
    const emit = (chunk, lastBucket) => {
      if (!chunk.length) return;
      const scheduled = interval > 0 ? lastBucket + interval + delay : Number(now);
      // A deadline release of the still-open hour is stamped now, not in the future.
      const timestamp = ended && scheduled > Number(now) ? Number(now) : scheduled;
      publish.push({ electionId, items: chunk, timestamp });
    };
    for (const key of keys) {
      carry = carry.concat(buckets.get(key));
      carryLast = key;
      if (carry.length >= floor) {
        emit(carry, carryLast);
        carry = [];
        carryLast = null;
      }
    }
    if (carry.length && (tallied || (ended && waitingOnClock === 0 && submitted >= floor))) {
      emit(carry, carryLast);
    } else if (carry.length) hold.push(...carry);
  }
  return { publish, hold };
}

/** Ballots from one election that the public may see. */
export function selectPublicVotes(votes, policy = {}) {
  const list = Array.isArray(votes) ? votes : [];
  const wrapped = list.map((vote) => ({
    vote,
    receivedAt: vote.acceptedAt ?? vote.receivedAt,
    electionId: String(vote.electionId ?? ''),
  }));
  const { publish } = planPublicBlocks(wrapped, {
    now: policy.now,
    intervalSeconds: policy.intervalSeconds,
    delaySeconds: policy.delaySeconds,
    minBlockVotes: policy.minBlockVotes,
    minVotes: policy.minVotes,
    electionContext: () => ({
      submittedVotes: policy.submittedVotes ?? list.length,
      endTime: policy.endTime ?? null,
      tallied: Boolean(policy.tallied),
      resultsSealed: Boolean(policy.resultsSealed),
      minVotes: policy.minVotes,
    }),
  });
  const out = [];
  for (const block of publish) {
    for (const item of block.items) out.push(item.vote);
  }
  return out;
}

export function isDelayedPublicType(type) {
  return DELAYED_PUBLIC_TYPES.includes(String(type || '').toLowerCase());
}

export function hourBucket(eventTs, intervalSeconds) {
  const interval = Number(intervalSeconds);
  const ts = Number(eventTs);
  if (!interval || interval <= 0) return ts;
  return ts - (ts % interval);
}

/**
 * Public metadata only. Never include a pending-per-election count.
 * `acceptedBallotsDisclosed` is the last closed-hour snapshot (already public).
 */
export function publicDisclosureView(now, intervalSeconds, extras = {}) {
  const interval = Number(intervalSeconds) || 0;
  const delay = Math.max(0, Math.floor(Number(extras.delaySeconds) || 0));
  const ts = Number(now);
  const last = interval > 0 ? publishedThrough(ts, interval, delay) : ts;
  const view = {
    nfp: true,
    policy: 'hourly-polling-place-unlinkability',
    intervalSeconds: interval,
    delaySeconds: delay,
    lastPublishedAt: last,
    lastClosedHourAt: last,
    lastClosedHourStart: interval > 0 ? last - interval : last,
    nextPublishAt: nextPublishAt(ts, interval, delay),
    secondsUntilNext: secondsUntilNext(ts, interval, delay),
    note:
      'Vote proofs and turnout publish after the hour closes and the disclosure delay has elapsed, from the first ballot. Per-choice counts publish with the posted tally; hourly per-choice blocks after the gate are planned. A block smaller than the minimum merges into a later hour. A person leaving a voting office cannot be matched to the publish.',
  };
  if (typeof extras.resultsMinVotes === 'number') view.resultsMinVotes = extras.resultsMinVotes;
  if (typeof extras.minBlockVotes === 'number') view.minBlockVotes = extras.minBlockVotes;
  if (typeof extras.acceptedBallotsDisclosed === 'number') {
    view.acceptedBallotsDisclosed = extras.acceptedBallotsDisclosed;
  }
  return view;
}

export function withDisclosedCount(view, acceptedBallotsDisclosed) {
  const base = view && typeof view === 'object' ? view : {};
  return {
    ...base,
    acceptedBallotsDisclosed: Number(acceptedBallotsDisclosed) || 0,
  };
}

/** Mark a disclosure view as waiting on choice results. The disclosed ballot count stays. */
export function sealDisclosureView(view, election) {
  const base = view && typeof view === 'object' ? { ...view } : {};
  base.resultsSealed = true;
  base.sealedUntil = Number.isFinite(Number(election?.cutoffTime)) ? Number(election.cutoffTime) : null;
  base.note = sealedResultsMessage(election);
  return base;
}

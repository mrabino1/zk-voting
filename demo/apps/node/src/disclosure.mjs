// NOT FOR PROFIT — civic public good, not a commercial product.
// Hourly public disclosure so a person leaving a polling place cannot be
// matched to a live jurisdiction tick. Votes are accepted immediately (nullifier
// uniqueness). Proofs and counts become public only after the hour that
// contained them has closed.

export const DEFAULT_DISCLOSURE_INTERVAL_SECONDS = 3600;

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

export function publishedThrough(now, intervalSeconds) {
  const ts = Number(now);
  const interval = Number(intervalSeconds);
  if (!Number.isFinite(ts)) return 0;
  if (!interval || interval <= 0) return ts + 1;
  return ts - (ts % interval);
}

export function nextPublishAt(now, intervalSeconds) {
  const ts = Number(now);
  const interval = Number(intervalSeconds);
  if (!interval || interval <= 0) return ts;
  return publishedThrough(ts, interval) + interval;
}

export function lastClosedHourAt(now, intervalSeconds) {
  const ts = Number(now);
  const interval = Number(intervalSeconds);
  if (!Number.isFinite(ts)) return 0;
  if (!interval || interval <= 0) return ts;
  return publishedThrough(ts, interval);
}

export function lastClosedHourStart(now, intervalSeconds) {
  const interval = Number(intervalSeconds);
  const last = lastClosedHourAt(now, intervalSeconds);
  if (!interval || interval <= 0) return last;
  return last - interval;
}

export function secondsUntilNext(now, intervalSeconds) {
  const ts = Number(now);
  const interval = Number(intervalSeconds);
  if (!Number.isFinite(ts)) return 0;
  if (!interval || interval <= 0) return 0;
  return Math.max(0, nextPublishAt(ts, interval) - ts);
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

export function isDisclosed(eventTs, now, intervalSeconds) {
  if (eventTs == null || eventTs === '') return true;
  const interval = Number(intervalSeconds);
  if (!interval || interval <= 0) return true;
  return Number(eventTs) < publishedThrough(now, intervalSeconds);
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
  const ts = Number(now);
  const last = interval > 0 ? publishedThrough(ts, interval) : ts;
  const view = {
    nfp: true,
    policy: 'hourly-polling-place-unlinkability',
    intervalSeconds: interval,
    lastPublishedAt: last,
    lastClosedHourAt: last,
    lastClosedHourStart: interval > 0 ? last - interval : last,
    nextPublishAt: nextPublishAt(ts, interval),
    secondsUntilNext: secondsUntilNext(ts, interval),
    note:
      'Vote proofs and jurisdiction ballot counts are published once an hour, after that hour closes. A person leaving a voting office cannot be matched to a live increase.',
  };
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

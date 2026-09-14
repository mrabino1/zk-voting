// NOT FOR PROFIT — civic public good, not a commercial product.
// Hourly public disclosure: vote txs stay sealed until the hour closes.

export const DEFAULT_DISCLOSURE_INTERVAL_SECONDS = 3600;

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

export function isDisclosed(eventTs, now, intervalSeconds) {
  if (eventTs == null || eventTs === '') return true;
  const interval = Number(intervalSeconds);
  if (!interval || interval <= 0) return true;
  return Number(eventTs) < publishedThrough(now, intervalSeconds);
}

export function isHeldVoteType(type) {
  return String(type || '').toLowerCase() === 'vote';
}

export function disclosurePublicView(now, intervalSeconds) {
  const interval = Number(intervalSeconds) || 0;
  const ts = Number(now);
  return {
    nfp: true,
    policy: 'hourly-polling-place-unlinkability',
    intervalSeconds: interval,
    lastPublishedAt: interval > 0 ? publishedThrough(ts, interval) : ts,
    nextPublishAt: nextPublishAt(ts, interval),
    note:
      'Vote proofs are published once an hour, after that hour closes. A person leaving a voting office cannot be matched to a live increase.',
  };
}

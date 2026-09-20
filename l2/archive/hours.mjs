// NOT FOR PROFIT — civic public good, not a commercial product.
// UTC hour buckets for L2 attic offload. Aligns with disclosure hour boundaries.

export const DEFAULT_INTERVAL_SECONDS = 3600;
export const DEFAULT_HOT_WINDOW_HOURS = 2;

export function archiveIntervalSeconds(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_INTERVAL_SECONDS;
  return Math.floor(n);
}

export function hourStart(ts, intervalSeconds) {
  const iv = archiveIntervalSeconds(intervalSeconds);
  const t = Math.floor(Number(ts) || 0);
  return t - (t % iv);
}

export function hourEnd(ts, intervalSeconds) {
  return hourStart(ts, intervalSeconds) + archiveIntervalSeconds(intervalSeconds);
}

/** UTC prefix segment: YYYY/MM/DD/HH */
export function hourPath(hourStartSec) {
  const d = new Date(Math.floor(Number(hourStartSec) || 0) * 1000);
  const yyyy = String(d.getUTCFullYear());
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  return `${yyyy}/${mm}/${dd}/${hh}`;
}

export function objectPrefix(chainId, hourStartSec) {
  return `l2/${Number(chainId)}/${hourPath(hourStartSec)}`;
}

/**
 * Oldest hour-start that stays on the VPS.
 * At 15:30 with a 2-hour window keep 14:00 and 15:00; archive 13:00 and earlier.
 */
export function hotCutoffHourStart(now, intervalSeconds, hotWindowHours) {
  const iv = archiveIntervalSeconds(intervalSeconds);
  const hours = Math.max(1, Math.floor(Number(hotWindowHours) || DEFAULT_HOT_WINDOW_HOURS));
  const current = hourStart(now, iv);
  return current - (hours - 1) * iv;
}

export function isHourArchivable(hourStartSec, now, intervalSeconds, hotWindowHours) {
  const iv = archiveIntervalSeconds(intervalSeconds);
  const start = hourStart(hourStartSec, iv);
  if (start + iv > Number(now)) return false;
  return start < hotCutoffHourStart(now, iv, hotWindowHours);
}

export function parseHourPath(raw) {
  const s = String(raw || '')
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  const m = s.match(/(?:^|\/)(\d{4})\/(\d{2})\/(\d{2})\/(\d{2})$/);
  if (!m) return null;
  const hourStartSec = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4])) / 1000;
  return { hour: `${m[1]}/${m[2]}/${m[3]}/${m[4]}`, hourStart: hourStartSec };
}

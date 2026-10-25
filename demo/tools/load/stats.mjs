// NOT FOR PROFIT — civic public good, not a commercial product.
// Pure helpers for the local load harness. No I/O.

/** Nearest-rank percentile. `sorted` must be ascending. p is 0–100. */
export function percentile(sorted, p) {
  if (!Array.isArray(sorted) || sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  const i = Math.min(sorted.length - 1, Math.max(0, rank));
  return sorted[i];
}

function meanOf(samples) {
  if (!samples.length) return null;
  return samples.reduce((sum, sample) => sum + sample.ms, 0) / samples.length;
}

/**
 * @param {Array<{ ok: boolean, ms: number, status?: number, code?: string, error?: string }>} samples
 * Samples must be in request order (not sorted by latency) so quartile means
 * describe the start of the phase versus the end.
 */
export function summarize(samples, wallMs, cpuUsage) {
  const list = Array.isArray(samples) ? samples : [];
  const ok = list.filter((sample) => sample.ok);
  const bad = list.filter((sample) => !sample.ok);
  const ms = ok.map((sample) => sample.ms).sort((a, b) => a - b);
  const quarter = Math.max(1, Math.floor(ok.length / 4));
  const statuses = {};
  for (const sample of list) {
    const key = String(sample.status ?? 'error');
    statuses[key] = (statuses[key] || 0) + 1;
  }
  const errorSamples = [];
  for (const sample of bad) {
    const msg = sample.code || sample.error || `HTTP ${sample.status ?? '?'}`;
    if (!errorSamples.includes(msg) && errorSamples.length < 8) errorSamples.push(String(msg));
  }
  const cpuMs =
    cpuUsage && Number.isFinite(cpuUsage.user) && Number.isFinite(cpuUsage.system)
      ? (cpuUsage.user + cpuUsage.system) / 1000
      : null;
  const wall = Number(wallMs);
  return {
    count: list.length,
    ok: ok.length,
    errors: bad.length,
    errorSamples,
    statuses,
    wallMs: Number.isFinite(wall) ? wall : null,
    throughputPerSec: Number.isFinite(wall) && wall > 0 ? (ok.length * 1000) / wall : null,
    cpuMs,
    cpuOverWall: cpuMs != null && Number.isFinite(wall) && wall > 0 ? cpuMs / wall : null,
    latencyMs: {
      min: ms.length ? ms[0] : null,
      mean: ms.length ? ms.reduce((sum, value) => sum + value, 0) / ms.length : null,
      p50: percentile(ms, 50),
      p95: percentile(ms, 95),
      p99: percentile(ms, 99),
      max: ms.length ? ms[ms.length - 1] : null,
      firstQuartileMean: ok.length ? meanOf(ok.slice(0, quarter)) : null,
      lastQuartileMean: ok.length ? meanOf(ok.slice(-quarter)) : null,
    },
  };
}

/**
 * Largest measured scale whose named phases all have zero errors and p95
 * strictly under `p95LimitMs`. Single-sample phases use that sample as p95.
 */
export function recommendedScale(scales, phaseNames, p95LimitMs) {
  const considered = [];
  const passing = [];
  for (const scale of scales || []) {
    if (!scale || scale.skipped || scale.fatal) continue;
    considered.push(scale.n);
    let pass = true;
    for (const name of phaseNames) {
      const phase = scale.phases?.[name];
      const p95 = phase?.latencyMs?.p95;
      if (!phase || phase.errors > 0 || p95 == null || !(p95 < p95LimitMs)) {
        pass = false;
        break;
      }
    }
    if (pass) passing.push(scale.n);
  }
  return {
    p95LimitMs,
    phases: [...phaseNames],
    considered,
    passing,
    limit: passing.length ? Math.max(...passing) : null,
    everyConsideredScalePassed: considered.length > 0 && passing.length === considered.length,
  };
}

/** Self-hit samples from a V8 CPU profile, heaviest first. */
export function profileHits(profile, limit = 15) {
  const nodes = profile?.nodes || [];
  const rows = [];
  let total = 0;
  for (const node of nodes) {
    const hits = Number(node.hitCount) || 0;
    if (hits <= 0) continue;
    total += hits;
    const frame = node.callFrame || {};
    rows.push({
      functionName: frame.functionName || '(anonymous)',
      url: frame.url || '',
      lineNumber: Number.isInteger(frame.lineNumber) ? frame.lineNumber + 1 : null,
      hits,
    });
  }
  rows.sort((a, b) => b.hits - a.hits);
  return {
    sampleHits: total,
    top: rows.slice(0, limit).map((row) => ({
      ...row,
      selfPercent: total > 0 ? (100 * row.hits) / total : 0,
    })),
  };
}

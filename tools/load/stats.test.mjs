// NOT FOR PROFIT — civic public good, not a commercial product.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { percentile, profileHits, recommendedScale, summarize } from './stats.mjs';

describe('load harness stats', () => {
  test('nearest-rank percentile', () => {
    const sorted = [10, 20, 30, 40];
    assert.equal(percentile(sorted, 50), 20);
    assert.equal(percentile(sorted, 95), 40);
    assert.equal(percentile([], 50), null);
  });

  test('summarize keeps request order for quartile means', () => {
    const samples = [
      { ok: true, ms: 10, status: 201 },
      { ok: true, ms: 20, status: 201 },
      { ok: true, ms: 30, status: 201 },
      { ok: true, ms: 40, status: 201 },
      { ok: false, ms: 5, status: 409, code: 'DUPLICATE_COMMITMENT' },
    ];
    const summary = summarize(samples, 1000, { user: 400_000, system: 100_000 });
    assert.equal(summary.ok, 4);
    assert.equal(summary.errors, 1);
    assert.equal(summary.throughputPerSec, 4);
    assert.equal(summary.latencyMs.min, 10);
    assert.equal(summary.latencyMs.max, 40);
    assert.equal(summary.latencyMs.p50, 20);
    assert.equal(summary.latencyMs.firstQuartileMean, 10);
    assert.equal(summary.latencyMs.lastQuartileMean, 40);
    assert.equal(summary.cpuMs, 500);
    assert.equal(summary.cpuOverWall, 0.5);
    assert.deepEqual(summary.errorSamples, ['DUPLICATE_COMMITMENT']);
  });

  test('recommended scale is the largest measured population under the p95 cap', () => {
    const scales = [
      { n: 10, phases: { vote: { errors: 0, latencyMs: { p95: 100 } } } },
      { n: 20, phases: { vote: { errors: 0, latencyMs: { p95: 900 } } } },
      { n: 40, phases: { vote: { errors: 0, latencyMs: { p95: 1500 } } } },
      { n: 80, skipped: true },
    ];
    const rec = recommendedScale(scales, ['vote'], 1000);
    assert.equal(rec.limit, 20);
    assert.equal(rec.everyConsideredScalePassed, false);
    assert.deepEqual(rec.considered, [10, 20, 40]);
    const all = recommendedScale(scales.slice(0, 2), ['vote'], 1000);
    assert.equal(all.limit, 20);
    assert.equal(all.everyConsideredScalePassed, true);
  });

  test('profile hits sort by self samples', () => {
    const summary = profileHits({
      nodes: [
        { hitCount: 1, callFrame: { functionName: 'small', url: 'file:///a.mjs', lineNumber: 0 } },
        { hitCount: 4, callFrame: { functionName: 'hot', url: 'file:///b.mjs', lineNumber: 9 } },
      ],
    });
    assert.equal(summary.sampleHits, 5);
    assert.equal(summary.top[0].functionName, 'hot');
    assert.equal(summary.top[0].lineNumber, 10);
    assert.equal(summary.top[0].selfPercent, 80);
  });
});

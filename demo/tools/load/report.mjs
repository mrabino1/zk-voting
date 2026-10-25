// NOT FOR PROFIT — civic public good, not a commercial product.
// Renders a load-test report from harness JSON. Every figure is copied from
// that JSON (display rounded to 0.1 ms or 0.01 ops/s). Missing fields stay blank.

import { recommendedScale } from './stats.mjs';

const INTERACTIVE_PHASES = [
  'registration_request',
  'registration_approve',
  'vote',
  'disclosure_publish',
  'tally',
];

const PHASE_ORDER = [
  'provision',
  'registration_request',
  'registration_approve',
  'freeze',
  'vote',
  'disclosure_sealed_read',
  'disclosure_publish',
  'disclosure_ballots',
  'disclosure_reread',
  'disclosure_explorer',
  'tally',
];

const PHASE_LABEL = {
  provision: 'Dev-login (person provision)',
  registration_request: 'Registration request',
  registration_approve: 'Registration approve',
  freeze: 'Freeze roll',
  vote: 'Vote submission',
  disclosure_sealed_read: 'Disclosure read (hour still open)',
  disclosure_publish: 'Hourly disclosure publish',
  disclosure_ballots: 'Disclosed ballot list',
  disclosure_reread: 'Disclosure read after publish',
  disclosure_explorer: 'Explorer block list',
  tally: 'Tally',
};

function n(value, digits) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  const factor = 10 ** digits;
  return (Math.round(Number(value) * factor) / factor).toFixed(digits);
}

function num(value) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  return String(value);
}

function phaseCell(phase, field) {
  if (!phase) return '—';
  if (field === 'p50') return n(phase.latencyMs?.p50, 1);
  if (field === 'p95') return n(phase.latencyMs?.p95, 1);
  if (field === 'max') return n(phase.latencyMs?.max, 1);
  if (field === 'mean') return n(phase.latencyMs?.mean, 1);
  if (field === 'ops') return n(phase.throughputPerSec, 2);
  if (field === 'wall') return n(phase.wallMs, 1);
  if (field === 'cpu') return n(phase.cpuOverWall, 2);
  if (field === 'grow') {
    const a = phase.latencyMs?.firstQuartileMean;
    const b = phase.latencyMs?.lastQuartileMean;
    if (a == null || b == null || a === 0) return '—';
    return n(b / a, 2);
  }
  return '—';
}

function completedScales(run) {
  return (run.scales || []).filter((scale) => !scale.skipped && !scale.fatal);
}

function halfRateNote(run, phase) {
  const rows = completedScales(run)
    .map((scale) => ({ n: scale.n, ops: scale.phases?.[phase]?.throughputPerSec }))
    .filter((row) => row.ops != null && row.ops > 0);
  if (rows.length < 2) return '';
  const base = rows[0];
  const half = base.ops / 2;
  const still = rows.filter((row) => row.ops >= half);
  const limit = still.length ? still[still.length - 1].n : null;
  const dropped = rows.find((row) => row.ops < half);
  const dropText = dropped
    ? ` Population ${dropped.n} measured ${n(dropped.ops, 2)} ops/s, which is under that half-rate.`
    : ' Every completed population stayed at or above that half-rate.';
  return `Half-rate rule for \`${phase}\`: throughput at the smallest completed population (${base.n}) was ${n(base.ops, 2)} ops/s. Largest completed population still at or above half of that (${n(half, 2)} ops/s) was **${limit == null ? 'none' : limit}**.${dropText}`;
}

function fmtLimit(rec) {
  if (!rec.considered.length) return 'No scale completed, so no limit was computed.';
  if (rec.limit == null) {
    return `No completed scale stayed under p95 ${rec.p95LimitMs} ms on ${rec.phases.join(', ')}. Smallest completed population was ${rec.considered[0]}.`;
  }
  if (rec.everyConsideredScalePassed) {
    return `Every completed scale passed p95 < ${rec.p95LimitMs} ms with zero errors on ${rec.phases.join(', ')}. The largest population measured was **${rec.limit}**. Larger populations were not measured.`;
  }
  const failing = rec.considered.filter((scale) => !rec.passing.includes(scale));
  return `Largest completed population with p95 < ${rec.p95LimitMs} ms and zero errors on ${rec.phases.join(', ')} was **${rec.limit}**. Completed populations over that cap: ${failing.join(', ')}.`;
}

function growthNotes(run) {
  const lines = [];
  for (const scale of completedScales(run)) {
    for (const name of ['registration_approve', 'vote', 'registration_request', 'provision']) {
      const phase = scale.phases?.[name];
      const a = phase?.latencyMs?.firstQuartileMean;
      const b = phase?.latencyMs?.lastQuartileMean;
      if (a == null || b == null || a <= 0 || phase.count < 8) continue;
      const ratio = b / a;
      if (ratio < 1.5 && ratio > 0.67) continue;
      lines.push(
        `- At population ${scale.n}, \`${name}\` last-quartile mean latency was ${n(b, 1)} ms versus ${n(a, 1)} ms in the first quartile (ratio ${n(ratio, 2)}).`,
      );
    }
  }
  return lines;
}

function cpuNotes(run) {
  const lines = [];
  for (const scale of completedScales(run)) {
    for (const name of PHASE_ORDER) {
      const phase = scale.phases?.[name];
      if (!phase || phase.cpuOverWall == null || phase.wallMs == null || phase.wallMs < 50) continue;
      if (phase.cpuOverWall >= 0.8) {
        lines.push(
          `- At population ${scale.n}, \`${name}\` spent CPU/wall ${n(phase.cpuOverWall, 2)} over ${n(phase.wallMs, 1)} ms wall (${n(phase.cpuMs, 1)} ms CPU). The phase was CPU-bound in this shared process.`,
        );
      } else if (phase.cpuOverWall < 0.4 && phase.ok > 1) {
        lines.push(
          `- At population ${scale.n}, \`${name}\` spent CPU/wall ${n(phase.cpuOverWall, 2)} over ${n(phase.wallMs, 1)} ms wall (${n(phase.cpuMs, 1)} ms CPU). Wall time was not explained by CPU in this process.`,
        );
      }
    }
  }
  return lines;
}

function fileNotes(run) {
  const lines = [];
  for (const scale of completedScales(run)) {
    const files = scale.files || {};
    lines.push(
      `- Population ${scale.n}: \`zk-voting.json\` ${num(files.zkVotingJsonBytes)} bytes, \`l2-chain.json\` ${num(files.l2ChainJsonBytes)} bytes.`,
    );
    const bench = scale.snapshotMicrobench;
    if (bench) {
      lines.push(
        `  One snapshot of that \`zk-voting.json\`: pretty stringify ${n(bench.prettyStringifyMs, 1)} ms (${num(bench.prettyBytes)} bytes), compact stringify ${n(bench.compactStringifyMs, 1)} ms (${num(bench.compactBytes)} bytes), pretty write ${n(bench.prettyWriteMs, 1)} ms.`,
      );
    }
  }
  return lines;
}

function disclosureNotes(run) {
  const lines = [];
  for (const scale of completedScales(run)) {
    const d = scale.disclosure || {};
    lines.push(
      `- Population ${scale.n}: disclosed ballots before the hour closed ${num(d.beforeCount)}; after the harness advanced the Node clock, publish reported ${num(d.afterCount)} and the ballot list returned ${num(d.ballotListCount)}. Votes accepted in this scale: ${num(d.votesOk)}.`,
    );
  }
  return lines;
}

function tallyNotes(run) {
  const lines = [];
  for (const scale of completedScales(run)) {
    const t = scale.tally || {};
    lines.push(
      `- Population ${scale.n}: tally HTTP ${num(t.status)}, acceptedBallots on the store ${num(t.acceptedBallots)}, counts ${JSON.stringify(t.counts)} , L1 status ${t.l1Status == null ? '—' : t.l1Status}, outcome subscribers ${num(t.subscribers)}.`,
    );
  }
  return lines;
}

function profileSection(run) {
  const top = run.profile?.top;
  if (!Array.isArray(top) || top.length === 0) return '_No CPU profile was captured for this run._\n';
  const lines = [
    run.profile.note ? `${run.profile.note}` : '',
    `Inspector self-samples: ${num(run.profile.sampleHits)}. Sampling interval is the V8 profiler default. Percents are this run's share of self-hits.`,
    '',
  ].filter((line) => line !== '');
  lines.push(
    '| Self % | Hits | Function | Location |',
    '| ---: | ---: | --- | --- |',
  );
  for (const row of top) {
    const where = `${row.url || '—'}${row.lineNumber != null ? `:${row.lineNumber}` : ''}`;
    lines.push(
      `| ${n(row.selfPercent, 1)} | ${num(row.hits)} | \`${row.functionName}\` | ${where} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function resultsTable(run) {
  const scales = run.scales || [];
  const header = ['Phase', ...scales.map((scale) => (scale.skipped ? `${scale.n} (skipped)` : String(scale.n)))];
  const align = ['---', ...scales.map(() => '---:')];
  const metrics = [
    ['ok / errors', (phase) => (phase ? `${phase.ok}/${phase.errors}` : '—')],
    ['throughput (ops/s)', (phase) => phaseCell(phase, 'ops')],
    ['mean ms', (phase) => phaseCell(phase, 'mean')],
    ['p50 ms', (phase) => phaseCell(phase, 'p50')],
    ['p95 ms', (phase) => phaseCell(phase, 'p95')],
    ['max ms', (phase) => phaseCell(phase, 'max')],
    ['wall ms', (phase) => phaseCell(phase, 'wall')],
    ['CPU/wall', (phase) => phaseCell(phase, 'cpu')],
    ['last/first quartile mean', (phase) => phaseCell(phase, 'grow')],
  ];
  const lines = [];
  for (const name of PHASE_ORDER) {
    lines.push(`### ${PHASE_LABEL[name]} (\`${name}\`)`);
    lines.push('');
    lines.push(`| ${header.join(' | ')} |`);
    lines.push(`| ${align.join(' | ')} |`);
    for (const [label, pick] of metrics) {
      const cells = scales.map((scale) => {
        if (scale.skipped) return 'skipped';
        if (scale.fatal && !scale.phases?.[name]) return 'fatal';
        return pick(scale.phases?.[name]);
      });
      lines.push(`| ${label} | ${cells.join(' | ')} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function errorSection(run) {
  const lines = [];
  for (const scale of run.scales || []) {
    if (scale.skipped) {
      lines.push(`- Population ${scale.n} skipped: ${scale.skipReason || 'not run'}.`);
      continue;
    }
    if (scale.fatal) lines.push(`- Population ${scale.n} fatal: ${scale.fatal}`);
    for (const name of PHASE_ORDER) {
      const phase = scale.phases?.[name];
      if (!phase || phase.errors === 0) continue;
      lines.push(
        `- Population ${scale.n} \`${name}\`: ${phase.errors} error(s). Samples: ${phase.errorSamples.join('; ') || '—'}.`,
      );
    }
  }
  return lines.length ? lines.join('\n') : '_No phase reported an HTTP or client error._';
}

function compareRuns(runs) {
  const before = runs.find((run) => run.label === 'before');
  const after = runs.find((run) => run.label === 'after');
  if (!before || !after) return '';
  const lines = [
    '## Before and after',
    '',
    'The after run is the same harness and the same populations. Between the runs: a registration appends one eligible Merkle leaf when the in-memory tree already matches that set (disqualification still rebuilds); zero-subtree hashes are cached per depth; approving a request writes the leaf and the approved row in one store file; a vote writes the receipt PDF fingerprint in the same store file as the ballot.',
    '',
    '| Population | Phase | Before mean ms | After mean ms | Before ops/s | After ops/s | Before wall ms | After wall ms |',
    '| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  const phases = ['registration_approve', 'freeze', 'vote', 'disclosure_publish', 'tally'];
  for (const scale of completedScales(before)) {
    const other = completedScales(after).find((row) => row.n === scale.n);
    if (!other) continue;
    for (const name of phases) {
      const a = scale.phases?.[name];
      const b = other.phases?.[name];
      if (!a || !b) continue;
      lines.push(
        `| ${scale.n} | \`${name}\` | ${n(a.latencyMs?.mean, 1)} | ${n(b.latencyMs?.mean, 1)} | ${n(a.throughputPerSec, 2)} | ${n(b.throughputPerSec, 2)} | ${n(a.wallMs, 1)} | ${n(b.wallMs, 1)} |`,
      );
    }
  }
  lines.push('');
  return lines.join('\n');
}

export function renderReport(runs) {
  const list = Array.isArray(runs) ? runs : [runs];
  const first = list[0] || {};
  const cfg = first.config || {};
  const parts = [];
  parts.push(`# ZK-Voting local load test

**NOT FOR PROFIT** — civic public good. Not a commercial product.

This report lists figures produced by \`tools/load/harness.mjs\` against a ZK-Voting Node listening on \`127.0.0.1\`. Displayed latencies are rounded to 0.1 ms and throughputs to 0.01 ops/s. The JSON next to this file keeps the unrounded summaries. Nothing in the tables was filled in by hand.

## What ran

Each population is a new Node process state: its own data directory, one YES/NO election, tree depth ${num(cfg.treeDepth)}, disclosure interval ${num(cfg.disclosureIntervalSeconds)} seconds (the production default is 3600; this run set that value). Client concurrency was ${num(cfg.concurrency)} in-flight request(s).

The harness drove HTTP:

1. \`POST /api/auth/dev-login\` once per voter (\`ALLOW_DEV_LOGIN\`, role \`voter\`) and once for a \`platform_admin\` clerk.
2. \`POST /api/elections\` (clerk).
3. \`POST /api/elections/:id/register\` (voter) — pending civil review.
4. \`POST /api/elections/:id/registration-requests/:requestId/approve\` (clerk).
5. \`POST /api/elections/:id/freeze\` (clerk).
6. \`POST /api/elections/:id/vote\` with a unique nullifier and \`{ proof: { accept: true } }\`. No session cookie, so the relay path does not attach the voter to the ballot. \`CHAIN_RPC\` was unset, so votes stayed on the JSON demo path.
7. \`GET /api/elections/:id/summary\` while the disclosure hour was still open.
8. The harness then advanced that Node's \`nowFn\` by the disclosure interval plus 5 seconds (same clock the vote and disclosure routes use) and called \`GET /api/elections/:id/summary\`, \`GET /api/elections/:id/ballots\`, summary again, and \`GET /api/explorer/blocks\` with no \`limit\` query (the route default is 50 blocks). That is the hourly disclosure publish path without waiting 3600 seconds of wall clock.
9. The harness set \`cutoffTime\` on the live store to one second before wall-clock now (the tally route compares cutoff to \`Date.now()\`, which \`nowFn\` does not move) and \`POST /api/elections/:id/tally\` with counts \`[acceptedBallots, 0]\`.

Latency is time waiting on \`fetch\` for that request (nearest-rank p50/p95/p99). Throughput is successful responses divided by the phase's wall clock. CPU/wall is process CPU time (user + system) divided by wall time. The client and the server share this Node process, so CPU includes both. "Last/first quartile mean" splits successful requests in send order into the first and last quarter of the phase.

A phase stops the ladder when its wall time exceeds ${num(cfg.maxPhaseMs)} ms. Later populations are skipped.
`);

  for (const run of list) {
    const env = run.environment || {};
    const largest = completedScales(run).at(-1);
    let slowest = '';
    if (largest) {
      const ranked = PHASE_ORDER.map((name) => ({
        name,
        wall: largest.phases?.[name]?.wallMs,
      }))
        .filter((row) => row.wall != null)
        .sort((a, b) => b.wall - a.wall);
      if (ranked[0]) {
        slowest = `At the largest completed population (${largest.n}), the slowest phase by wall clock was \`${ranked[0].name}\` at ${n(ranked[0].wall, 1)} ms.`;
      }
    }
    parts.push(`## Run: ${run.label || 'unlabeled'}

Started ${run.startedAt || '—'}, finished ${run.finishedAt || '—'}. ${slowest}

| Fact | Value |
| --- | --- |
| Node | ${env.node || '—'} |
| Platform | ${env.platform || '—'} / ${env.arch || '—'} |
| CPUs | ${num(env.cpus)} × ${env.cpuModel || '—'} |
| Memory | ${num(env.totalMemMb)} MB |
| Load average at start | ${(env.loadAvg || []).map((v) => n(v, 2)).join(', ') || '—'} |
| Data directory parent | ${env.dataDirParent || '—'} |

${resultsTable(run)}
### Errors

${errorSection(run)}

### Disclosure counts

${disclosureNotes(run).join('\n') || '_No disclosure counts recorded._'}

### Tally outcomes

${tallyNotes(run).join('\n') || '_No tally metadata recorded._'}

### Latency growth inside a phase

${growthNotes(run).join('\n') || '_No phase with at least 8 successes had a last/first quartile mean ratio outside 0.67–1.50._'}

### CPU versus wall

${cpuNotes(run).join('\n') || '_No phase of at least 50 ms wall was clearly CPU-bound (CPU/wall ≥ 0.80) or clearly waiting (CPU/wall < 0.40 with more than one success)._'}

### Store files

${fileNotes(run).join('\n') || '_No file sizes recorded._'}

### CPU profile

${profileSection(run)}
`);
    const rec = recommendedScale(run.scales || [], INTERACTIVE_PHASES, 1000);
    const profileNote = run.config?.profile
      ? '\n\nThis run had the V8 CPU profiler enabled, so its timings include sampling overhead. Use the hit table to name functions. Capacity numbers are the unprofiled runs.\n'
      : '';
    parts.push(`### Recommended limit for this run

Rule: largest completed population where registration request, registration approve, vote, hourly disclosure publish, and tally each had **zero errors** and **p95 under 1000 ms**.

${fmtLimit(rec)}

${halfRateNote(run, 'registration_approve')}

${halfRateNote(run, 'vote')}${profileNote}
`);
  }

  const comparison = compareRuns(list);
  if (comparison) parts.push(comparison);

  parts.push(`## How to reproduce

From the repository root, with dependencies installed (\`npm install\`):

\`\`\`bash
node tools/load/harness.mjs --scales ${cfg.scales?.join(',') || '50,100,200,400'} --concurrency ${num(cfg.concurrency)} --disclosure-seconds ${num(cfg.disclosureIntervalSeconds)} --tree-depth ${num(cfg.treeDepth)} --json docs/load-test-results.json
node tools/load/harness.mjs --render docs/load-test-results.json --out docs/LOAD_TEST.md
\`\`\`

The harness does not print a throughput or latency figure it did not just measure. Stats unit tests: \`node --test tools/load/stats.test.mjs\`.
`);
  return parts.join('\n');
}

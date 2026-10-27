// NOT FOR PROFIT — civic public good, not a commercial product.
// Local load harness for the ZK-Voting Node. Starts a Node on 127.0.0.1,
// drives registration, vote, hourly disclosure, and tally, and writes only
// figures this process measured.

import { Session } from 'node:inspector';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { monitorEventLoopDelay } from 'node:perf_hooks';

import { startServer } from '../../apps/node/src/server.mjs';
import { profileHits, summarize } from './stats.mjs';
import { renderReport } from './report.mjs';

const CHAIN_ENV = [
  'CHAIN_RPC',
  'L1_RPC',
  'L1_RPC_URL',
  'BALLOT_INBOX_ADDRESS',
  'RELAYER_PRIVATE_KEY',
  'ELECTION_FACTORY_ADDRESS',
  'FACTORY',
  'VERIFIER_ADDRESS',
  'VERIFIER',
];

function parseArgs(argv) {
  const out = {
    scales: [50, 100, 200, 400],
    concurrency: 1,
    disclosureSeconds: 3600,
    treeDepth: 20,
    maxPhaseMs: 180_000,
    json: '',
    out: '',
    render: '',
    label: 'measured',
    profile: false,
    profileScale: 0,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--scales' && next) {
      out.scales = next.split(',').map((part) => Number(part.trim())).filter((n) => Number.isInteger(n) && n > 0);
      i += 1;
    } else if (arg === '--concurrency' && next) {
      out.concurrency = Math.max(1, Number(next) || 1);
      i += 1;
    } else if (arg === '--disclosure-seconds' && next) {
      out.disclosureSeconds = Math.max(0, Number(next) || 0);
      i += 1;
    } else if (arg === '--tree-depth' && next) {
      out.treeDepth = Number(next) || 20;
      i += 1;
    } else if (arg === '--max-phase-ms' && next) {
      out.maxPhaseMs = Math.max(1000, Number(next) || 180_000);
      i += 1;
    } else if (arg === '--json' && next) {
      out.json = next;
      i += 1;
    } else if (arg === '--out' && next) {
      out.out = next;
      i += 1;
    } else if (arg === '--render' && next) {
      out.render = next;
      i += 1;
    } else if (arg === '--label' && next) {
      out.label = next;
      i += 1;
    } else if (arg === '--profile') {
      out.profile = true;
    } else if (arg === '--profile-scale' && next) {
      out.profileScale = Number(next) || 0;
      i += 1;
    } else if (arg === '--help') {
      out.help = true;
    }
  }
  return out;
}

function cookieHeader(jar) {
  return Object.entries(jar)
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');
}

function applyCookies(res, jar) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const cookie of list) {
    const pair = cookie.split(';')[0];
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
}

async function request(base, method, urlPath, { body, jar } = {}) {
  const started = performance.now();
  let res;
  try {
    res = await fetch(base + urlPath, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(jar ? { cookie: cookieHeader(jar) } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      ms: performance.now() - started,
      json: null,
      error: err.name === 'TimeoutError' ? 'timeout' : err.message,
    };
  }
  if (jar) applyCookies(res, jar);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  const ok = res.status >= 200 && res.status < 300;
  return {
    ok,
    status: res.status,
    ms: performance.now() - started,
    json,
    error: ok ? undefined : json?.error || text.slice(0, 180) || `HTTP ${res.status}`,
    code: json?.code || undefined,
  };
}

async function pool(count, concurrency, worker) {
  const samples = new Array(count);
  let cursor = 0;
  const cpuStart = process.cpuUsage();
  const wallStart = performance.now();
  async function run() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= count) return;
      samples[index] = await worker(index);
    }
  }
  const workers = Math.max(1, Math.min(concurrency, count));
  await Promise.all(Array.from({ length: workers }, () => run()));
  const wallMs = performance.now() - wallStart;
  const cpu = process.cpuUsage(cpuStart);
  return { samples, wallMs, cpu, summary: summarize(samples, wallMs, cpu) };
}

async function one(base, method, urlPath, opts) {
  const cpuStart = process.cpuUsage();
  const wallStart = performance.now();
  const sample = await request(base, method, urlPath, opts);
  const wallMs = performance.now() - wallStart;
  const cpu = process.cpuUsage(cpuStart);
  return { sample, summary: summarize([sample], wallMs, cpu) };
}

function logPhase(scale, name, summary) {
  const mean = summary.latencyMs?.mean;
  console.error(
    `[load] n=${scale} ${name} ok=${summary.ok}/${summary.count} errors=${summary.errors} wall=${summary.wallMs?.toFixed(1)}ms mean=${mean == null ? 'n/a' : mean.toFixed(1)}ms p95=${summary.latencyMs?.p95 == null ? 'n/a' : summary.latencyMs.p95.toFixed(1)}ms ops=${summary.throughputPerSec?.toFixed(2) ?? 'n/a'}`,
  );
}

async function fileSize(file) {
  try {
    return (await stat(file)).size;
  } catch {
    return null;
  }
}

async function snapshotMicrobench(file) {
  const raw = await readFile(file);
  const data = JSON.parse(raw.toString('utf8'));
  const t0 = performance.now();
  const pretty = JSON.stringify(data, null, 2);
  const t1 = performance.now();
  const compact = JSON.stringify(data);
  const t2 = performance.now();
  const tmp = `${file}.bench.tmp`;
  await writeFile(tmp, pretty);
  const t3 = performance.now();
  await rm(tmp, { force: true });
  return {
    prettyStringifyMs: t1 - t0,
    compactStringifyMs: t2 - t1,
    prettyWriteMs: t3 - t2,
    prettyBytes: Buffer.byteLength(pretty),
    compactBytes: Buffer.byteLength(compact),
  };
}

function withoutChainEnv(fn) {
  const saved = new Map();
  for (const key of CHAIN_ENV) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

async function closeServer(server) {
  await new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

function startProfile() {
  const session = new Session();
  session.connect();
  return new Promise((resolve, reject) => {
    session.post('Profiler.enable', (err) => {
      if (err) return reject(err);
      session.post('Profiler.start', (err2) => (err2 ? reject(err2) : resolve(session)));
    });
  });
}

function stopProfile(session) {
  return new Promise((resolve, reject) => {
    session.post('Profiler.stop', (err, params) => {
      session.disconnect();
      if (err) reject(err);
      else resolve(params.profile);
    });
  });
}

async function runScale(n, opts) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), `zk-voting-load-${n}-`));
  const clock = { offsetSec: 0 };
  const nowFn = () => Math.floor(Date.now() / 1000) + clock.offsetSec;
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  let started;
  const result = {
    n,
    phases: {},
    disclosure: {},
    tally: {},
    files: {},
    notes: [],
  };
  try {
    started = await withoutChainEnv(() =>
      startServer({
        port: 0,
        host: '127.0.0.1',
        allowDevLogin: true,
        quiet: true,
        dataDir,
        disclosureIntervalSeconds: opts.disclosureSeconds,
        nowFn,
      }),
    );
    const base = `http://127.0.0.1:${started.port}`;
    result.port = started.port;
    const health = await request(base, 'GET', '/health');
    if (!health.ok) {
      result.fatal = `health ${health.status} ${health.error || ''}`;
      return result;
    }
    loop.reset();

    const clerk = {};
    const clerkLogin = await request(base, 'POST', '/api/auth/dev-login', {
      jar: clerk,
      body: { handle: 'load-clerk', role: 'platform_admin' },
    });
    if (!clerkLogin.ok) {
      result.fatal = `clerk login ${clerkLogin.status} ${clerkLogin.error || ''}`;
      return result;
    }

    const now = Math.floor(Date.now() / 1000);
    const created = await request(base, 'POST', '/api/elections', {
      jar: clerk,
      body: {
        title: `Load ${n}`,
        startTime: now - 60,
        cutoffTime: now + 86_400,
        maxParticipants: 0,
        treeDepth: opts.treeDepth,
        jurisdictionId: 'demo',
        questions: [{ type: 'YES_NO', prompt: 'Adopt the load-test measure?' }],
      },
    });
    if (!created.ok) {
      result.fatal = `create election ${created.status} ${created.error || ''}`;
      return result;
    }
    const electionId = created.json?.election?.id || created.json?.id;
    result.electionId = electionId;

    const voters = Array.from({ length: n }, () => ({}));
    const provision = await pool(n, opts.concurrency, async (index) =>
      request(base, 'POST', '/api/auth/dev-login', {
        jar: voters[index],
        body: { handle: `load-v-${index}`, role: 'voter' },
      }),
    );
    result.phases.provision = provision.summary;
    logPhase(n, 'provision', provision.summary);

    const requests = await pool(n, opts.concurrency, async (index) =>
      request(base, 'POST', `/api/elections/${electionId}/register`, {
        jar: voters[index],
        body: { identityCommitment: String(index + 1) },
      }),
    );
    for (const sample of requests.samples) {
      const pending = sample.status === 202 && sample.json?.request?.id;
      if (!pending) {
        sample.ok = false;
        sample.code = sample.code || `expected 202 pending, got ${sample.status}`;
      }
    }
    const requestSummary = summarize(requests.samples, requests.wallMs, requests.cpu);
    result.phases.registration_request = requestSummary;
    logPhase(n, 'registration_request', requestSummary);
    if (requestSummary.wallMs > opts.maxPhaseMs) {
      result.notes.push('registration_request exceeded max phase wall');
      result.stopLadder = true;
    }

    const approvals = await pool(n, opts.concurrency, async (index) => {
      const requestId = requests.samples[index]?.json?.request?.id;
      if (!requestId) {
        return { ok: false, status: 0, ms: 0, error: 'no registration request id', code: 'NO_REQUEST' };
      }
      return request(base, 'POST', `/api/elections/${electionId}/registration-requests/${requestId}/approve`, {
        jar: clerk,
        body: {},
      });
    });
    result.phases.registration_approve = approvals.summary;
    logPhase(n, 'registration_approve', approvals.summary);
    if (approvals.summary.wallMs > opts.maxPhaseMs) result.stopLadder = true;

    const freeze = await one(base, 'POST', `/api/elections/${electionId}/freeze`, { jar: clerk });
    result.phases.freeze = freeze.summary;
    logPhase(n, 'freeze', freeze.summary);
    if (!freeze.sample.ok) {
      result.notes.push(`freeze failed: ${freeze.sample.code || freeze.sample.error}`);
      result.fatal = 'freeze failed';
      return result;
    }

    const votes = await pool(n, opts.concurrency, async (index) =>
      request(base, 'POST', `/api/elections/${electionId}/vote`, {
        body: {
          proof: { accept: true },
          publicInputs: { nullifier: String(1_000_000 + index + 1), electionId },
          encryptedBallot: `0x${(index + 1).toString(16).padStart(2, '0')}`,
        },
      }),
    );
    result.phases.vote = votes.summary;
    logPhase(n, 'vote', votes.summary);
    result.disclosure.votesOk = votes.summary.ok;
    if (votes.summary.wallMs > opts.maxPhaseMs) result.stopLadder = true;

    const sealed = await one(base, 'GET', `/api/elections/${electionId}/summary`);
    result.phases.disclosure_sealed_read = sealed.summary;
    logPhase(n, 'disclosure_sealed_read', sealed.summary);
    result.disclosure.beforeCount = sealed.sample.json?.disclosure?.acceptedBallotsDisclosed ?? null;

    clock.offsetSec = opts.disclosureSeconds + 5;
    const published = await one(base, 'GET', `/api/elections/${electionId}/summary`);
    result.phases.disclosure_publish = published.summary;
    logPhase(n, 'disclosure_publish', published.summary);
    result.disclosure.afterCount = published.sample.json?.disclosure?.acceptedBallotsDisclosed ?? null;

    const ballots = await one(base, 'GET', `/api/elections/${electionId}/ballots`);
    result.phases.disclosure_ballots = ballots.summary;
    logPhase(n, 'disclosure_ballots', ballots.summary);
    result.disclosure.ballotListCount = Array.isArray(ballots.sample.json?.ballots)
      ? ballots.sample.json.ballots.length
      : null;

    const reread = await one(base, 'GET', `/api/elections/${electionId}/summary`);
    result.phases.disclosure_reread = reread.summary;
    logPhase(n, 'disclosure_reread', reread.summary);

    const explorer = await one(base, 'GET', '/api/explorer/blocks');
    result.phases.disclosure_explorer = explorer.summary;
    logPhase(n, 'disclosure_explorer', explorer.summary);
    result.disclosure.explorerBlocks = Array.isArray(explorer.sample.json?.blocks)
      ? explorer.sample.json.blocks.length
      : null;

    const election = started.store.requireElection(electionId);
    const accepted = Number(election.acceptedBallots) || 0;
    election.cutoffTime = Math.floor(Date.now() / 1000) - 1;
    await started.store.persist();
    const tally = await one(base, 'POST', `/api/elections/${electionId}/tally`, {
      jar: clerk,
      body: { counts: [accepted, 0] },
    });
    result.phases.tally = tally.summary;
    logPhase(n, 'tally', tally.summary);
    result.tally = {
      status: tally.sample.status,
      acceptedBallots: accepted,
      counts: tally.sample.json?.election?.tally?.counts ?? tally.sample.json?.tally?.counts ?? null,
      l1Status: tally.sample.json?.l1Certification?.status ?? null,
      subscribers: tally.sample.json?.election?.tally ? null : null,
      error: tally.sample.ok ? null : tally.sample.code || tally.sample.error || null,
    };
    const issued = started.store.listActiveOutcomeSubscribers?.(electionId);
    result.tally.subscribers = Array.isArray(issued) ? issued.length : null;

    const zkVotingFile = path.join(dataDir, 'zk-voting.json');
    const chainFile = started.config.l2ChainFile || path.join(dataDir, 'l2-chain.json');
    result.files = {
      zkVotingJsonBytes: await fileSize(zkVotingFile),
      l2ChainJsonBytes: await fileSize(chainFile),
    };
    try {
      result.snapshotMicrobench = await snapshotMicrobench(zkVotingFile);
    } catch (err) {
      result.notes.push(`snapshot microbench failed: ${err.message}`);
    }
    const mem = process.memoryUsage();
    result.memory = {
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      eventLoopDelayP99Ms: loop.percentile(99) / 1e6,
      eventLoopDelayMaxMs: loop.max / 1e6,
    };
    return result;
  } catch (err) {
    result.fatal = err.stack || err.message;
    console.error(`[load] n=${n} fatal ${err.stack || err.message}`);
    return result;
  } finally {
    loop.disable();
    if (started?.server) await closeServer(started.server);
    await rm(dataDir, { recursive: true, force: true });
  }
}

function environment(opts) {
  const cpus = os.cpus();
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpus: cpus.length,
    cpuModel: cpus[0]?.model || '',
    totalMemMb: Math.round(os.totalmem() / (1024 * 1024)),
    loadAvg: os.loadavg(),
    dataDirParent: os.tmpdir(),
  };
}

async function run(opts) {
  const runRecord = {
    label: opts.label,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    environment: environment(opts),
    config: {
      scales: opts.scales,
      concurrency: opts.concurrency,
      disclosureIntervalSeconds: opts.disclosureSeconds,
      treeDepth: opts.treeDepth,
      maxPhaseMs: opts.maxPhaseMs,
      profile: Boolean(opts.profile),
    },
    scales: [],
    profile: null,
  };
  let stopReason = '';
  let session = null;
  if (opts.profile) session = await startProfile();
  try {
    for (const n of opts.scales) {
      if (stopReason) {
        runRecord.scales.push({ n, skipped: true, skipReason: stopReason });
        console.error(`[load] n=${n} skipped (${stopReason})`);
        continue;
      }
      console.error(`[load] starting population ${n}`);
      const scale = await runScale(n, opts);
      runRecord.scales.push(scale);
      if (scale.stopLadder) {
        const slow = Object.entries(scale.phases).find(([, phase]) => phase?.wallMs > opts.maxPhaseMs);
        stopReason = slow
          ? `population ${n} phase ${slow[0]} wall ${Math.round(slow[1].wallMs)} ms exceeded ${opts.maxPhaseMs} ms`
          : `population ${n} stopped the ladder`;
      }
      if (scale.fatal && !scale.phases?.vote) {
        stopReason = `population ${n} failed: ${scale.fatal}`;
      }
    }
  } finally {
    if (session) {
      const profile = await stopProfile(session);
      runRecord.profile = profileHits(profile, 20);
    }
  }
  runRecord.finishedAt = new Date().toISOString();
  return runRecord;
}

function printHelp() {
  console.log(`Usage: node tools/load/harness.mjs [options]

Starts a local ZK-Voting Node and measures registration, vote submission,
hourly disclosure, and tally at each population in --scales.

  --scales 50,100,200,400     Populations (fresh data dir each)
  --concurrency 1             In-flight HTTP requests
  --disclosure-seconds 3600   DISCLOSURE_INTERVAL_SECONDS
  --tree-depth 20             Election Merkle depth
  --max-phase-ms 180000       Stop larger populations after a phase this slow
  --label measured            Name stored in the JSON
  --json path                 Write the run JSON
  --profile                   Capture a V8 CPU profile for the whole ladder
  --render path.json          Render a report from one JSON file, or several
  --out path.md               Report destination (with --render, or after a run)
`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }
  if (opts.render) {
    const jsonPaths = [];
    const renderIndex = process.argv.indexOf('--render');
    for (let i = renderIndex + 1; i < process.argv.length; i += 1) {
      const value = process.argv[i];
      if (value.startsWith('--')) break;
      jsonPaths.push(value);
    }
    const runs = [];
    for (const file of jsonPaths) {
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      if (Array.isArray(parsed)) runs.push(...parsed);
      else runs.push(parsed);
    }
    const markdown = renderReport(runs);
    if (opts.out) await writeFile(opts.out, markdown);
    else process.stdout.write(markdown);
    return;
  }
  const record = await run(opts);
  const json = `${JSON.stringify(record, null, 2)}\n`;
  if (opts.json) await writeFile(opts.json, json);
  else process.stdout.write(json);
  if (opts.out) await writeFile(opts.out, renderReport(record));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

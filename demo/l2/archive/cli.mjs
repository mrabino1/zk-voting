#!/usr/bin/env node
// NOT FOR PROFIT — civic public good, not a commercial product.
// Cron-friendly L2 attic: archive sealed hours to S3/R2, or restore one hour.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WriterLease } from '../lease/lease.mjs';
import { loadArchiveConfig } from './config.mjs';
import { restoreHour, runArchiveJob } from './job.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1);
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null || process.env[key] === '') process.env[key] = value;
  }
}

loadDotEnv(path.join(ROOT, '.env'));

function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const next = process.argv[i + 1];
  if (next == null || next.startsWith('--')) return true;
  return next;
}

function usage() {
  return `Republic L2 hourly archive (attic). Sequencer hot path stays local.

Usage:
  node l2/archive/cli.mjs archive
  node l2/archive/cli.mjs restore --hour YYYY/MM/DD/HH [--out DIR]
  node l2/archive/cli.mjs daemon

Env: ARCHIVE_ENABLED=1 (default; set 0 to turn the job off).
     With an empty ARCHIVE_S3_BUCKET and no file:// sink the job warns and
     does not delete local files.
     ARCHIVE_COMPRESS=1 (default) gzips each block and proof. The stored
     sha256 is over those exact bytes; the manifest also lists the raw hash.
     ARCHIVE_S3_BUCKET, ARCHIVE_S3_ENDPOINT
     (empty = AWS; set for R2; file:///path for a local sink), ARCHIVE_HOT_WINDOW_HOURS=2
`;
}

async function cmdArchive() {
  const result = await runArchiveJob();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

async function cmdRestore() {
  const hour = flag('hour');
  const prefix = flag('prefix');
  const out = flag('out');
  if (!hour && !prefix) {
    console.error(usage());
    process.exit(2);
  }
  const result = await restoreHour({ hour, prefix, out });
  console.log(JSON.stringify(result, null, 2));
}

function sleepInterruptible(ms, shouldStop) {
  const step = 200;
  let left = ms;
  return new Promise((resolve) => {
    const tick = () => {
      if (shouldStop() || left <= 0) {
        resolve();
        return;
      }
      const slice = Math.min(step, left);
      left -= slice;
      setTimeout(tick, slice);
    };
    tick();
  });
}

async function cmdDaemon() {
  const cfg = loadArchiveConfig();
  const intervalMs = cfg.intervalSeconds * 1000;
  const lease = new WriterLease({ dataDir: cfg.dataDir, role: 'archive' });
  let stop = false;
  const requestStop = () => {
    stop = true;
  };
  process.on('SIGTERM', requestStop);
  process.on('SIGINT', requestStop);
  console.log(
    `Republic L2 archive daemon  enabled=${cfg.enabled}  interval=${cfg.intervalSeconds}s  dataDir=${cfg.dataDir}`,
  );
  while (!stop) {
    try {
      if (!lease.holds()) {
        const got = lease.tryAcquire();
        if (!got.acquired) {
          console.log('archive standby; another container holds the writer lease');
          await sleepInterruptible(lease.pollMs, () => stop);
          continue;
        }
        lease.startHeartbeat();
        console.log(`archive active epoch=${got.epoch}`);
      }
      const result = await runArchiveJob({ config: loadArchiveConfig(), writerLease: lease });
      if (result.skipped) {
        console.log(`archive skipped: ${result.reason}`);
      } else {
        console.log(
          `archive hours=${result.hours.length} ok=${result.ok} archivedThrough=${result.archivedThrough}`,
        );
        for (const h of result.hours) {
          if (!h.ok) console.warn(`  hour ${h.hour} failed: ${h.error}`);
          else console.log(`  hour ${h.hour} uploaded=${h.uploaded} pruned=${h.pruned}`);
        }
      }
    } catch (err) {
      console.error('archive daemon tick failed:', err.message || err);
    }
    if (!stop) await sleepInterruptible(intervalMs, () => stop);
  }
  lease.release();
  console.log('archive stopped');
  process.exit(0);
}

const cmd = process.argv[2] || 'archive';
if (cmd === 'help' || cmd === '-h' || cmd === '--help') {
  console.log(usage());
} else if (cmd === 'archive' || cmd === 'run') {
  await cmdArchive();
} else if (cmd === 'restore') {
  await cmdRestore();
} else if (cmd === 'daemon') {
  await cmdDaemon();
} else {
  console.error(`unknown command: ${cmd}`);
  console.error(usage());
  process.exit(2);
}

// NOT FOR PROFIT — civic public good, not a commercial product.
// Exclusive lock so a second hourly run skips instead of double-pruning.
import fs from 'node:fs';
import path from 'node:path';

export const ARCHIVE_LOCK_REL = path.join('archive', 'archive.lock');

function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

function readLock(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

function isStale(payload, lockPath, { staleMs, now, isAlive }) {
  if (!payload) {
    try {
      const age = now - fs.statSync(lockPath).mtimeMs;
      return age > staleMs;
    } catch {
      return true;
    }
  }
  if (payload.startedAt && now - Number(payload.startedAt) > staleMs) return true;
  if (payload.pid && isAlive(payload.pid)) return false;
  return true;
}

export function acquireArchiveLock(dataDir, opts = {}) {
  const staleMs = Number(opts.staleMs) > 0 ? Number(opts.staleMs) : 2 * 60 * 60 * 1000;
  const now = opts.now != null ? Number(opts.now) : Date.now();
  const isAlive = typeof opts.isAlive === 'function' ? opts.isAlive : pidAlive;
  const lockPath = path.join(dataDir, ARCHIVE_LOCK_REL);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  const tryCreate = () => {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ pid: opts.pid || process.pid, startedAt: now }) + '\n');
    return fd;
  };

  let fd;
  try {
    fd = tryCreate();
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const payload = readLock(lockPath);
    if (!isStale(payload, lockPath, { staleMs, now, isAlive })) {
      return {
        acquired: false,
        lockPath,
        reason: 'ARCHIVE_LOCK_HELD',
        holder: payload,
      };
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      return { acquired: false, lockPath, reason: 'ARCHIVE_LOCK_HELD', holder: payload };
    }
    try {
      fd = tryCreate();
    } catch {
      return { acquired: false, lockPath, reason: 'ARCHIVE_LOCK_HELD' };
    }
  }

  return {
    acquired: true,
    lockPath,
    release() {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // raced
      }
    },
  };
}

export function lockBusyResult(lock, now) {
  return {
    ok: false,
    skipped: true,
    locked: true,
    reason: 'ARCHIVE_LOCK_HELD',
    error: 'another archive run holds the lock; local copies left intact',
    code: 'ARCHIVE_LOCK_HELD',
    hours: [],
    now,
  };
}

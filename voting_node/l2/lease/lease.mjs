// NOT FOR PROFIT — civic public good, not a commercial product.
// Single-writer lease for a Docker volume shared by the old and new
// container during a rolling update. mkdir is the atomic acquire.
// A fencing epoch is stored beside the data; a stale owner cannot write
// after a takeover. This is a local-filesystem lock: it works when both
// containers mount the same volume on one host. It does not coordinate
// two hosts.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_TTL_MS = 8_000;
export const DEFAULT_HEARTBEAT_MS = 2_000;
export const DEFAULT_POLL_MS = 1_000;

export class StaleFenceError extends Error {
  constructor(message = 'stale writer fence') {
    super(message);
    this.name = 'StaleFenceError';
    this.code = 'STALE_FENCE';
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export class WriterLease {
  /**
   * @param {{ dataDir: string, role: string, ownerId?: string, ttlMs?: number,
   *   heartbeatMs?: number, pollMs?: number, nowFn?: () => number }} opts
   */
  constructor(opts) {
    if (!opts?.dataDir) throw new Error('WriterLease requires dataDir');
    if (!opts?.role) throw new Error('WriterLease requires role');
    this.dataDir = opts.dataDir;
    this.role = String(opts.role);
    this.ownerId =
      opts.ownerId ||
      `${this.role}-${os.hostname()}-${process.pid}-${randomBytes(4).toString('hex')}`;
    this.ttlMs = Number(opts.ttlMs) > 0 ? Number(opts.ttlMs) : DEFAULT_TTL_MS;
    this.heartbeatMs = Number(opts.heartbeatMs) > 0 ? Number(opts.heartbeatMs) : DEFAULT_HEARTBEAT_MS;
    this.pollMs = Number(opts.pollMs) > 0 ? Number(opts.pollMs) : DEFAULT_POLL_MS;
    this.nowFn = typeof opts.nowFn === 'function' ? opts.nowFn : Date.now;
    this.epoch = 0;
    this.held = false;
    this.draining = false;
    this._timer = null;
  }

  leasesDir() {
    return path.join(this.dataDir, 'leases');
  }

  lockDir() {
    return path.join(this.leasesDir(), `${this.role}.lock`);
  }

  epochPath() {
    return path.join(this.leasesDir(), `${this.role}.epoch`);
  }

  ownerPath() {
    return path.join(this.lockDir(), 'owner.json');
  }

  _ensureDir() {
    fs.mkdirSync(this.leasesDir(), { recursive: true });
  }

  _readEpoch() {
    try {
      const n = Number(String(fs.readFileSync(this.epochPath(), 'utf8')).trim());
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    } catch {
      return 0;
    }
  }

  _writeEpoch(epoch) {
    this._ensureDir();
    const tmp = path.join(this.leasesDir(), `${this.role}.epoch.${this.ownerId}.tmp`);
    fs.writeFileSync(tmp, `${epoch}\n`);
    fs.renameSync(tmp, this.epochPath());
  }

  _readOwner() {
    return readJson(this.ownerPath());
  }

  _writeOwner(epoch) {
    const payload = {
      ownerId: this.ownerId,
      role: this.role,
      epoch,
      pid: process.pid,
      heartbeat: this.nowFn(),
      ttlMs: this.ttlMs,
    };
    const tmp = path.join(this.lockDir(), `owner.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(payload) + '\n');
    fs.renameSync(tmp, this.ownerPath());
  }

  _expired(meta) {
    const now = this.nowFn();
    if (meta && Number.isFinite(Number(meta.heartbeat))) {
      return now - Number(meta.heartbeat) > this.ttlMs;
    }
    try {
      return now - fs.statSync(this.lockDir()).mtimeMs > this.ttlMs;
    } catch {
      return true;
    }
  }

  _mkdirLock() {
    try {
      fs.mkdirSync(this.lockDir());
      return true;
    } catch (err) {
      if (err && err.code === 'EEXIST') return false;
      throw err;
    }
  }

  _epochForNewHolder(bump) {
    const current = this._readEpoch();
    const next = bump ? current + 1 : current > 0 ? current : 1;
    if (next !== current) this._writeEpoch(next);
    else if (current === 0) this._writeEpoch(1);
    return next === 0 ? 1 : next;
  }

  /**
   * One attempt. Does not block. Standby callers poll.
   * @returns {{ acquired: boolean, epoch: number, ownerId: string|null, mode: 'active'|'standby' }}
   */
  tryAcquire() {
    if (this.draining) {
      return { acquired: false, epoch: this.epoch, ownerId: this.ownerId, mode: 'standby' };
    }
    this._ensureDir();
    if (this.held && this._ownerMatches()) {
      this.heartbeat();
      return { acquired: true, epoch: this.epoch, ownerId: this.ownerId, mode: 'active' };
    }

    if (this._mkdirLock()) {
      // Graceful release removes the directory and leaves the epoch.
      // Reuse it. A crash that still holds the directory is handled by steal.
      const epoch = this._epochForNewHolder(false);
      this._writeOwner(epoch);
      this.epoch = epoch;
      this.held = true;
      return { acquired: true, epoch, ownerId: this.ownerId, mode: 'active' };
    }

    const meta = this._readOwner();
    if (meta && meta.ownerId === this.ownerId && !this._expired(meta)) {
      this.epoch = Number(meta.epoch) || this._readEpoch() || 1;
      this.held = true;
      this.heartbeat();
      return { acquired: true, epoch: this.epoch, ownerId: this.ownerId, mode: 'active' };
    }
    if (meta && !this._expired(meta)) {
      this.held = false;
      return {
        acquired: false,
        epoch: Number(meta.epoch) || 0,
        ownerId: meta.ownerId || null,
        mode: 'standby',
      };
    }
    if (!meta && !this._expired(null)) {
      // Winner created the directory and has not written owner.json yet.
      this.held = false;
      return { acquired: false, epoch: this._readEpoch(), ownerId: null, mode: 'standby' };
    }
    return this._steal();
  }

  _steal() {
    const stale = `${this.lockDir()}.stale.${this.ownerId}.${this.nowFn()}`;
    try {
      fs.renameSync(this.lockDir(), stale);
    } catch {
      this.held = false;
      return { acquired: false, epoch: this._readEpoch(), ownerId: null, mode: 'standby' };
    }
    const epoch = this._epochForNewHolder(true);
    try {
      fs.mkdirSync(this.lockDir());
    } catch {
      this.held = false;
      try {
        fs.rmSync(stale, { recursive: true, force: true });
      } catch {
        // the previous holder directory is already renamed aside
      }
      return { acquired: false, epoch, ownerId: null, mode: 'standby' };
    }
    this._writeOwner(epoch);
    this.epoch = epoch;
    this.held = true;
    try {
      fs.rmSync(stale, { recursive: true, force: true });
    } catch {
      // leftover stale directory is not the live lock
    }
    return { acquired: true, epoch, ownerId: this.ownerId, mode: 'active' };
  }

  _ownerMatches() {
    const meta = this._readOwner();
    if (!meta || meta.ownerId !== this.ownerId) return false;
    if (Number(meta.epoch) !== Number(this.epoch)) return false;
    return true;
  }

  /** True while this process still owns the lock. A stale heartbeat is still ours until stolen. */
  holds() {
    if (this.draining || !this.held) return false;
    if (!this._ownerMatches()) {
      this.held = false;
      return false;
    }
    return true;
  }

  heartbeat() {
    if (this.draining || !this.held) return false;
    if (!this._ownerMatches()) {
      this.held = false;
      return false;
    }
    this._writeOwner(this.epoch);
    return true;
  }

  assertFence() {
    if (this.draining) throw new StaleFenceError('writer is draining');
    if (!this.holds()) throw new StaleFenceError('writer lost the lease');
    this.heartbeat();
    if (!this._ownerMatches()) {
      this.held = false;
      throw new StaleFenceError('writer lost the lease during fence check');
    }
  }

  startHeartbeat() {
    if (this._timer) return;
    this._timer = setInterval(() => {
      try {
        this.heartbeat();
      } catch {
        // a lost lease is observed on the next holds() / assertFence()
      }
    }, this.heartbeatMs);
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }

  stopHeartbeat() {
    if (!this._timer) return;
    clearInterval(this._timer);
    this._timer = null;
  }

  /** Drop the lock so a standby can take over without waiting for expiry. */
  release() {
    this.draining = true;
    this.stopHeartbeat();
    if (this.held && this._ownerMatches()) {
      try {
        fs.rmSync(this.lockDir(), { recursive: true, force: true });
      } catch {
        // already gone
      }
    }
    this.held = false;
  }
}

/**
 * @param {{ dataDir: string, role: string, existing?: WriterLease|null, ttlMs?: number }} opts
 */
export function claimRoleLease(opts) {
  if (opts.existing) {
    const lease = opts.existing;
    if (lease.holds()) {
      lease.heartbeat();
      return { acquired: true, lease, release() {} };
    }
    const got = lease.tryAcquire();
    if (!got.acquired) return { acquired: false, lease, release() {} };
    return { acquired: true, lease, release() {} };
  }
  const lease = new WriterLease({
    dataDir: opts.dataDir,
    role: opts.role,
    ttlMs: opts.ttlMs,
  });
  const got = lease.tryAcquire();
  if (!got.acquired) return { acquired: false, lease, release() {} };
  return {
    acquired: true,
    lease,
    release() {
      lease.release();
    },
  };
}

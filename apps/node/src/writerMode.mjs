// NOT FOR PROFIT — civic public good, not a commercial product.
// Node writer lease. Standby serves reads and answers /health, and refuses
// mutations with 503 until the previous container releases the volume.

import { WriterLease } from '../../../l2/lease/lease.mjs';

export function openNodeWriter(config) {
  if (config.writerLease === false) {
    return {
      enabled: false,
      active: true,
      lease: null,
      acceptingWrites() {
        return true;
      },
      mode() {
        return 'active';
      },
      epoch() {
        return 0;
      },
      release() {},
      beginDrain() {},
      tryPromote() {
        return false;
      },
    };
  }
  const lease = new WriterLease({
    dataDir: config.dataDir,
    role: 'node',
    ttlMs: config.leaseTtlMs,
    ownerId: config.leaseOwnerId,
  });
  const got = lease.tryAcquire();
  const writer = {
    enabled: true,
    lease,
    active: got.acquired,
    draining: false,
    acceptingWrites() {
      return this.active && !this.draining && lease.holds();
    },
    mode() {
      if (this.draining) return 'standby';
      return this.acceptingWrites() ? 'active' : 'standby';
    },
    epoch() {
      return this.active ? lease.epoch : lease.epoch;
    },
    release() {
      this.draining = true;
      this.active = false;
      lease.release();
    },
    beginDrain() {
      this.draining = true;
    },
    tryPromote() {
      if (this.draining) return false;
      if (this.active && lease.holds()) return false;
      const next = lease.tryAcquire();
      if (!next.acquired) return false;
      this.active = true;
      this.draining = false;
      lease.startHeartbeat();
      return true;
    },
  };
  if (got.acquired) lease.startHeartbeat();
  return writer;
}

export function standbyGuard(writer) {
  return function standbyGuardMiddleware(req, res, next) {
    if (!writer || !writer.enabled || writer.acceptingWrites()) {
      next();
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      next();
      return;
    }
    res.set('Retry-After', '2');
    res.set('x-republic-mode', 'standby');
    res.status(503).json({
      ok: false,
      error: 'maintenance handover',
      mode: 'standby',
      retryAfter: 2,
      code: 'STANDBY',
      nfp: true,
    });
  };
}

// NOT FOR PROFIT — civic public good, not a commercial product.
// Phase-2 trusted-setup ceremony API. See docs/ceremony-web.md.
//
//   /api/ceremonies/...        public read; invited participants join and upload
//   /api/ceremony-admin/...    coordinator (platform super admin only)
//
// API keys never reach these routes: enforceApiKeyAccess only lets keys call
// catalogued operations, and requireSuperAdmin refuses keys outright.

import express from 'express';

import { requireAuth, requireSuperAdmin } from '../auth.mjs';
import { HttpError, asyncHandler } from '../http.mjs';
import { HERMEZ_PTAU } from '../ceremony/ptau.mjs';
import { BEACON_NETWORK, BEACON_SOURCE, DEFAULT_BEACON_ITERATIONS } from '../ceremony/beacon.mjs';
import { MAX_ATTESTATION_CHARS } from '../ceremony/service.mjs';
import { normalizeIp } from '../superAdmin/net.mjs';

/** Sliding-window limiter keyed by user and IP. In memory, per process. */
export function createSlidingLimiter({ limit, windowMs, now = () => Date.now() }) {
  const hits = new Map();
  return {
    take(key) {
      const t = now();
      const list = (hits.get(key) || []).filter((at) => t - at < windowMs);
      if (list.length >= limit) {
        hits.set(key, list);
        return Math.max(1, Math.ceil((windowMs - (t - list[0])) / 1000));
      }
      list.push(t);
      hits.set(key, list);
      if (hits.size > 5000) hits.delete(hits.keys().next().value);
      return 0;
    },
  };
}

function limited(limiter, label) {
  return function rateLimitMiddleware(req, res, next) {
    const ip = normalizeIp(req.ip || req.socket?.remoteAddress || '');
    const keys = [`ip:${ip}`];
    if (req.user) keys.push(`user:${req.user.id}`);
    for (const key of keys) {
      const retry = limiter.take(`${label}:${key}`);
      if (retry) {
        res.setHeader('Retry-After', String(retry));
        next(new HttpError(429, 'too many requests, try again shortly', { code: 'RATE_LIMITED', retryAfter: retry }));
        return;
      }
    }
    next();
  };
}

function requireOctetStream(req, _res, next) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/octet-stream') {
    next(new HttpError(415, 'send the file as application/octet-stream', { code: 'UNSUPPORTED_MEDIA_TYPE' }));
    return;
  }
  next();
}

function decodeAttestation(raw) {
  if (!raw) return null;
  const text = String(raw);
  if (text.length > Math.ceil((MAX_ATTESTATION_CHARS * 4 * 4) / 3) + 4) {
    throw new HttpError(400, 'attestation is too long', { code: 'CEREMONY_INVALID' });
  }
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(text)) {
    throw new HttpError(400, 'attestation header must be base64url', { code: 'CEREMONY_INVALID' });
  }
  return Buffer.from(text, 'base64url').toString('utf8');
}

function sendCeremonyFile(res, file, downloadName, immutable) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-store');
  const type = downloadName.endsWith('.json')
    ? 'application/json; charset=utf-8'
    : downloadName.endsWith('.sol')
      ? 'text/plain; charset=utf-8'
      : 'application/octet-stream';
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
  res.sendFile(file);
}

export function ceremonyPublicRouter({ ceremonies, limits = {} }) {
  const router = express.Router();
  const joinLimiter = createSlidingLimiter({ limit: limits.join ?? 20, windowMs: 10 * 60 * 1000 });
  const uploadLimiter = createSlidingLimiter({ limit: limits.upload ?? 10, windowMs: 10 * 60 * 1000 });

  router.get('/', (req, res) => {
    const rows = ceremonies.list().map((c) => {
      const v = ceremonies.publicView(c, req.user || null);
      return {
        id: v.id,
        circuitName: v.circuitName,
        label: v.label,
        status: v.status,
        contributions: v.contributions.length,
        minContributions: v.minContributions,
        queueLength: v.queueLength,
        participationMode: v.participationMode,
        createdAt: v.createdAt,
        finalizedAt: v.finalizedAt,
      };
    });
    res.json({ ceremonies: rows, nfp: true });
  });

  router.get(
    '/jobs/:jobId',
    requireAuth,
    (req, res) => {
      const job = ceremonies.getJob(req.params.jobId);
      res.json({ job, nfp: true });
    },
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const c = ceremonies.find(req.params.id);
      await ceremonies.tick(c);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ceremony: ceremonies.publicView(c, req.user || null), nfp: true });
    }),
  );

  router.get('/:id/transcript.json', (req, res) => {
    const c = ceremonies.find(req.params.id);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', `inline; filename="${c.circuitName}-transcript.json"`);
    res.json(ceremonies.transcriptDoc(c));
  });

  router.get('/:id/files/:name', (req, res) => {
    const c = ceremonies.find(req.params.id);
    const file = ceremonies.publicFile(c, req.params.name);
    if (!file) throw new HttpError(404, 'file not found', { code: 'CEREMONY_FILE_NOT_FOUND' });
    const immutable = /^zkey_\d{4}\.zkey$|^circuit\.r1cs$|^phase2\.ptau$/.test(req.params.name);
    sendCeremonyFile(res, file, req.params.name, immutable);
  });

  router.get('/:id/export/:name', (req, res) => {
    const c = ceremonies.find(req.params.id);
    const file = ceremonies.publicFile(c, req.params.name, { exported: true });
    if (!file) throw new HttpError(404, 'file not found', { code: 'CEREMONY_FILE_NOT_FOUND' });
    sendCeremonyFile(res, file, req.params.name, false);
  });

  router.post(
    '/:id/queue',
    requireAuth,
    limited(joinLimiter, 'join'),
    asyncHandler(async (req, res) => {
      const c = await ceremonies.join(req.params.id, req.user);
      res.json({ ceremony: ceremonies.publicView(c, req.user), nfp: true });
    }),
  );

  // Redeem a single-use email invite for the signed-in account.
  router.post(
    '/:id/invites/accept',
    requireAuth,
    limited(joinLimiter, 'join'),
    asyncHandler(async (req, res) => {
      const c = await ceremonies.acceptInvite(req.params.id, req.body?.token, req.user);
      res.json({ ceremony: ceremonies.publicView(c, req.user), nfp: true });
    }),
  );

  router.delete(
    '/:id/queue',
    requireAuth,
    asyncHandler(async (req, res) => {
      const c = await ceremonies.leave(req.params.id, req.user);
      res.json({ ceremony: ceremonies.publicView(c, req.user), nfp: true });
    }),
  );

  router.post(
    '/:id/contributions',
    requireAuth,
    limited(uploadLimiter, 'upload'),
    requireOctetStream,
    asyncHandler(async (req, res) => {
      const job = await ceremonies.submitContribution(
        req.params.id,
        req.user,
        {
          name: req.query.name,
          parentIndex: Number(req.query.parent),
          attestation: decodeAttestation(req.headers['x-ceremony-attestation']),
        },
        req,
      );
      res.status(202).json({ job, nfp: true });
    }),
  );

  return router;
}

export function ceremonyAdminRouter({ ceremonies }) {
  const router = express.Router();
  // TODO(manage_ceremony): gate on a `manage_ceremony` capability once the
  // capability model lands. Until then only the platform super admin may run a ceremony.
  router.use(requireSuperAdmin);

  router.get(
    '/options',
    asyncHandler(async (_req, res) => {
      res.json({
        inputs: await ceremonies.listInputs(),
        inputDir: ceremonies.inputDir,
        maxInputBytes: ceremonies.maxInputBytes,
        maxZkeyBytes: ceremonies.maxZkeyBytes,
        ptauPresets: HERMEZ_PTAU,
        beacon: {
          source: BEACON_SOURCE,
          network: BEACON_NETWORK,
          minBlocksAhead: ceremonies.minBlocksAhead,
          rpcConfigured: Boolean(ceremonies.eth?.configured),
        },
        defaultBeaconIterations: DEFAULT_BEACON_ITERATIONS,
        nfp: true,
      });
    }),
  );

  // Current Ethereum head and finalized block, read from CEREMONY_ETH_RPC_URL.
  router.get(
    '/beacon/chain',
    asyncHandler(async (_req, res) => {
      const eth = ceremonies.eth;
      if (!eth?.configured) {
        throw new HttpError(503, 'no Ethereum RPC is configured. Set CEREMONY_ETH_RPC_URL.', {
          code: 'CEREMONY_ETH_RPC_UNSET',
        });
      }
      try {
        const [headBlock, finalizedBlock] = await Promise.all([eth.headBlock(), eth.finalizedBlock()]);
        res.setHeader('Cache-Control', 'no-store');
        res.json({
          network: BEACON_NETWORK,
          headBlock,
          finalizedBlock,
          minBlocksAhead: ceremonies.minBlocksAhead,
          earliestCommit: headBlock + ceremonies.minBlocksAhead,
          nfp: true,
        });
      } catch (err) {
        throw new HttpError(502, err.message, { code: err.code || 'CEREMONY_ETH_RPC' });
      }
    }),
  );

  router.post(
    '/inputs',
    requireOctetStream,
    asyncHandler(async (req, res) => {
      const saved = await ceremonies.saveInput(req.query.name, req, req.user);
      res.status(201).json({ input: saved, nfp: true });
    }),
  );

  router.get('/ceremonies', (_req, res) => {
    res.json({ ceremonies: ceremonies.list().map((c) => ceremonies.adminView(c)), nfp: true });
  });

  router.post(
    '/ceremonies',
    asyncHandler(async (req, res) => {
      const { ceremony, job } = await ceremonies.create(req.body || {}, req.user);
      res.status(202).json({ ceremony: ceremonies.adminView(ceremony), job, nfp: true });
    }),
  );

  router.get(
    '/ceremonies/:id',
    asyncHandler(async (req, res) => {
      const c = ceremonies.find(req.params.id);
      await ceremonies.tick(c);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ceremony: ceremonies.adminView(c), nfp: true });
    }),
  );

  const action = (fn) =>
    asyncHandler(async (req, res) => {
      const c = await fn(req);
      res.json({ ceremony: ceremonies.adminView(c), nfp: true });
    });

  router.post('/ceremonies/:id/open', action((req) => ceremonies.open(req.params.id, req.user)));
  router.post('/ceremonies/:id/close', action((req) => ceremonies.close(req.params.id, req.user)));
  router.post(
    '/ceremonies/:id/participants',
    action((req) => ceremonies.setParticipation(req.params.id, req.body || {}, req.user)),
  );
  // Invite list: { handle | handles } invites existing accounts; { email } issues
  // a single-use link whose token is returned once and stored only as a hash.
  router.post(
    '/ceremonies/:id/invites',
    asyncHandler(async (req, res) => {
      const out = await ceremonies.addInvites(req.params.id, req.body || {}, req.user);
      const view = ceremonies.adminView(out.ceremony);
      res.setHeader('Cache-Control', 'no-store');
      res.status(201).json({
        ceremony: view,
        invites: out.invites.map((i) => view.invites.find((v) => v.id === i.id)),
        ...(out.token ? { token: out.token, invitePath: out.invitePath } : {}),
        nfp: true,
      });
    }),
  );
  router.delete(
    '/ceremonies/:id/invites/:inviteId',
    action((req) => ceremonies.removeInvite(req.params.id, req.params.inviteId, req.user)),
  );
  router.post(
    '/ceremonies/:id/queue/remove',
    action((req) => ceremonies.removeFromQueue(req.params.id, req.body?.position, req.user)),
  );
  router.post(
    '/ceremonies/:id/beacon/precommit',
    action((req) => ceremonies.precommitBeacon(req.params.id, req.body || {}, req.user)),
  );
  router.post(
    '/ceremonies/:id/finalize',
    asyncHandler(async (req, res) => {
      const job = await ceremonies.finalize(req.params.id, req.body || {}, req.user);
      res.status(202).json({ job, nfp: true });
    }),
  );

  return router;
}

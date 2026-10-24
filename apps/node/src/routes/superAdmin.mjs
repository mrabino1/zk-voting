// NOT FOR PROFIT — civic public good, not a commercial product.
// HTTP surface for /api/_sa/v1. Auth failures are a generic 404.
// The real reason is written to the audit log and is not returned.

import { randomUUID } from 'node:crypto';

import { Router } from 'express';

import { secretsEqual } from '../secureCompare.mjs';

import { isSuperAdmin } from '../roles.mjs';
import { HttpError, asyncHandler } from '../http.mjs';
import { filterAuditEntries, verifyAuditChain } from '../superAdmin/audit.mjs';
import {
  electionDiag,
  electionsDiag,
  configDiag,
  healthDiag,
  l1Diag,
  l2Diag,
  mailDiag,
  storeDiag,
  userDiag,
  usersDiag,
} from '../superAdmin/diagnostics.mjs';
import { normalizeKeyName, parseSuperAdminToken, resolveKeyExpiry, SuperAdminKeyError } from '../superAdmin/keys.mjs';
import { tailLogs } from '../superAdmin/logs.mjs';
import { consumeRateLimit, ipAllowed, normalizeAllowlist, normalizeIp, normalizeRateLimit } from '../superAdmin/net.mjs';
import {
  appendSuperAdminAudit,
  authenticateSuperAdminKey,
  createSuperAdminKey,
  getPublicSuperAdminKey,
  listSuperAdminKeys,
  markSessionStepUp,
  persistedAudit,
  revokeSuperAdminKey,
  rotateSuperAdminKey,
  sessionStepUpFresh,
  touchSuperAdminKey,
} from '../superAdmin/persist.mjs';
import { assertSafeSaPayload, forbiddenFieldPaths } from '../superAdmin/redact.mjs';
import { actorHasScope, normalizeScopeList, sessionScopes } from '../superAdmin/scopes.mjs';
import {
  dryRunRequested,
  writeConfig,
  writeElectionLifecycle,
  writeL2,
  writeLogLevel,
  writeMailTest,
  writeResendTerms,
  writeRevokeSessions,
  writeUserRole,
  writeUserStatus,
} from '../superAdmin/writes.mjs';

function clientIp(req) {
  return normalizeIp(req.ip || req.socket?.remoteAddress || '');
}

function userAgent(req) {
  return String(req.get('user-agent') || '').slice(0, 200);
}

function notFound(res) {
  res.status(404).json({ error: 'not found', nfp: true });
}

function secretContext(deps) {
  return {
    superAdminEmail: deps.config.superAdminEmail || '',
    pepper: deps.config.superAdminApiPepper || '',
  };
}

function bearerToken(req) {
  const header = String(req.get('authorization') || '');
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1] : '';
}

function tokensEqual(a, b) {
  return secretsEqual(a, b);
}

function csrfOk(req) {
  const session = req.session;
  if (!session?.csrfToken) return false;
  const header = req.get('x-csrf-token') || '';
  if (!tokensEqual(session.csrfToken, header)) return false;
  const origin = req.get('origin');
  if (origin) {
    const allowed = new Set((req.app?.locals?.saOrigins || []).map(String));
    if (allowed.size && !allowed.has(origin)) return false;
  }
  const site = String(req.get('sec-fetch-site') || '').toLowerCase();
  if (site === 'cross-site') return false;
  return true;
}

async function audit(deps, req, fields) {
  try {
    await appendSuperAdminAudit(deps.store, {
      timestamp: new Date().toISOString(),
      method: req.method,
      path: req.path.startsWith('/api/') ? req.path : `${req.baseUrl}${req.path}`,
      ip: clientIp(req),
      userAgent: userAgent(req),
      requestId: req.saRequestId,
      ...fields,
    });
  } catch (err) {
    if (!deps.config.quiet) console.error('[republic] sa audit failed', err?.code || err?.message || 'error');
  }
}

function sendJson(res, deps, status, body, { allowToken = false } = {}) {
  const safe = assertSafeSaPayload(body, secretContext(deps), { allowToken });
  res.status(status).json(safe);
}

async function deny(deps, req, res, { reason, scope, keyId, sessionUser, status = 404 }) {
  await audit(deps, req, {
    keyId: keyId || null,
    sessionUser: sessionUser || null,
    scope: scope || null,
    result: status,
    reason,
  });
  if (status === 429) {
    res.status(429).json({ error: 'rate limited', code: 'RATE_LIMIT', nfp: true });
    return;
  }
  notFound(res);
}

function sessionActor(req) {
  if (!req.session || !req.user || req.apiKey) return null;
  if (!isSuperAdmin(req.user)) return null;
  if (req.user.suspendedAt) return null;
  return {
    kind: 'session',
    scopes: sessionScopes(),
    sessionUser: req.user.handle,
    keyId: null,
  };
}

async function keyActor(deps, req) {
  const token = bearerToken(req);
  if (!token) return null;
  const parsed = parseSuperAdminToken(token);
  if (!parsed) return { ok: false, reason: 'invalid' };
  const found = authenticateSuperAdminKey(
    deps.store,
    parsed,
    deps.config.superAdminApiPepper || '',
    Date.now(),
  );
  if (!found.ok) return found;
  const ip = clientIp(req);
  if (!ipAllowed(ip, found.key.ipAllowlist)) {
    return { ok: false, reason: 'ip_allowlist', keyId: found.key.id };
  }
  const limited = consumeRateLimit(found.key.id, found.key.rateLimit, Date.now());
  if (!limited.ok) return { ok: false, reason: 'rate_limit', keyId: found.key.id, status: 429 };
  return {
    ok: true,
    kind: 'key',
    scopes: found.key.scopes || [],
    keyId: found.key.id,
    sessionUser: null,
  };
}

function rejectForbiddenBody(body) {
  const paths = forbiddenFieldPaths(body);
  if (paths.length) {
    throw new HttpError(400, 'forbidden field', { code: 'FORBIDDEN_FIELD' });
  }
}

function recent(req, deps) {
  const windowMs = Number(deps.config.superAdminStepUpMs) || 15 * 60 * 1000;
  return sessionStepUpFresh(req.session, windowMs, Date.now());
}

async function requireKeyManager(deps, req, res, { write = true } = {}) {
  if (bearerToken(req) || req.get('x-api-key')) {
    await deny(deps, req, res, { reason: 'key_cannot_manage_keys', sessionUser: req.user?.handle || null });
    return null;
  }
  const actor = sessionActor(req);
  if (!actor) {
    await deny(deps, req, res, {
      reason: req.user ? 'not_super_admin' : 'no_session',
      sessionUser: req.user?.handle || null,
    });
    return null;
  }
  if (!csrfOk(req)) {
    await deny(deps, req, res, { reason: 'csrf', sessionUser: actor.sessionUser });
    return null;
  }
  if (!recent(req, deps)) {
    await deny(deps, req, res, { reason: 'step_up', sessionUser: actor.sessionUser });
    return null;
  }
  if (write && !deps.writer?.acceptingWrites?.() && deps.writer?.enabled) {
    await audit(deps, req, {
      sessionUser: actor.sessionUser,
      scope: 'apikeys',
      result: 503,
      reason: 'standby',
    });
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
    return null;
  }
  return actor;
}

async function requireActor(deps, req, res, scope, { write = false } = {}) {
  const presented = bearerToken(req) || req.get('x-api-key');
  let actor;
  if (presented) {
    if (req.get('x-api-key') && !bearerToken(req)) {
      await deny(deps, req, res, { reason: 'invalid' });
      return null;
    }
    const keyed = await keyActor(deps, req);
    if (!keyed?.ok) {
      await deny(deps, req, res, {
        reason: keyed?.reason || 'invalid',
        keyId: keyed?.keyId || null,
        scope,
        status: keyed?.status || 404,
      });
      return null;
    }
    actor = keyed;
  } else {
    actor = sessionActor(req);
    if (!actor) {
      await deny(deps, req, res, {
        reason: req.user ? 'not_super_admin' : 'no_session',
        sessionUser: req.user?.handle || null,
        scope,
      });
      return null;
    }
    if (write && !csrfOk(req)) {
      await deny(deps, req, res, { reason: 'csrf', sessionUser: actor.sessionUser, scope });
      return null;
    }
    if (write && !recent(req, deps)) {
      await deny(deps, req, res, { reason: 'step_up', sessionUser: actor.sessionUser, scope });
      return null;
    }
  }
  if (actor.kind === 'key') {
    try {
      await touchSuperAdminKey(deps.store, actor.keyId, clientIp(req));
    } catch {
      /* standby and fence failures must not turn a read into a write */
    }
  }
  if (!actorHasScope(actor.scopes, scope)) {
    await deny(deps, req, res, {
      reason: 'scope',
      scope,
      keyId: actor.keyId,
      sessionUser: actor.sessionUser,
    });
    return null;
  }
  if (write && deps.writer?.enabled && !deps.writer.acceptingWrites()) {
    await audit(deps, req, {
      keyId: actor.keyId,
      sessionUser: actor.sessionUser,
      scope,
      result: 503,
      reason: 'standby',
    });
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
    return null;
  }
  return actor;
}

function keyError(err) {
  if (err instanceof SuperAdminKeyError) {
    return new HttpError(err.status, err.message, { code: err.code });
  }
  return err;
}

export function superAdminRouter(deps) {
  const router = Router();
  const origins = Array.isArray(deps.config.origins) ? deps.config.origins : [];
  router.use((req, res, next) => {
    req.saRequestId = String(req.get('x-request-id') || randomUUID());
    res.set('x-request-id', req.saRequestId);
    res.set('Cache-Control', 'no-store');
    req.app.locals.saOrigins = origins;
    next();
  });

  router.get(
    '/session',
    asyncHandler(async (req, res) => {
      if (bearerToken(req)) {
        await deny(deps, req, res, { reason: 'key_cannot_manage_keys' });
        return;
      }
      const actor = sessionActor(req);
      if (!actor) {
        await deny(deps, req, res, { reason: req.user ? 'not_super_admin' : 'no_session' });
        return;
      }
      const windowMs = Number(deps.config.superAdminStepUpMs) || 15 * 60 * 1000;
      const fresh = sessionStepUpFresh(req.session, windowMs);
      await audit(deps, req, {
        sessionUser: actor.sessionUser,
        scope: null,
        result: 200,
        reason: 'ok',
      });
      sendJson(res, deps, 200, {
        ok: true,
        nfp: true,
        csrfToken: req.session.csrfToken,
        recentAuth: fresh,
        stepUpWindowMs: windowMs,
      });
    }),
  );

  router.post(
    '/step-up',
    asyncHandler(async (req, res) => {
      if (bearerToken(req)) {
        await deny(deps, req, res, { reason: 'key_cannot_manage_keys' });
        return;
      }
      const actor = sessionActor(req);
      if (!actor) {
        await deny(deps, req, res, { reason: req.user ? 'not_super_admin' : 'no_session' });
        return;
      }
      if (!csrfOk(req)) {
        await deny(deps, req, res, { reason: 'csrf', sessionUser: actor.sessionUser });
        return;
      }
      if (deps.writer?.enabled && !deps.writer.acceptingWrites()) {
        await audit(deps, req, { sessionUser: actor.sessionUser, result: 503, reason: 'standby' });
        res.set('Retry-After', '2');
        res.status(503).json({
          ok: false,
          error: 'maintenance handover',
          mode: 'standby',
          retryAfter: 2,
          code: 'STANDBY',
          nfp: true,
        });
        return;
      }
      await markSessionStepUp(deps.store, req.session.id || req.sessionId);
      await audit(deps, req, { sessionUser: actor.sessionUser, result: 200, reason: 'step_up' });
      sendJson(res, deps, 200, { ok: true, nfp: true, recentAuth: true });
    }),
  );

  router.post(
    '/keys',
    asyncHandler(async (req, res) => {
      const actor = await requireKeyManager(deps, req, res);
      if (!actor) return;
      try {
        rejectForbiddenBody(req.body);
        const name = normalizeKeyName(req.body?.name);
        const scopes = normalizeScopeList(req.body?.scopes);
        if (!scopes.length) throw new SuperAdminKeyError('SCOPE', 'at least one scope is required');
        const expiry = resolveKeyExpiry({
          expiresIn: req.body?.expiresIn,
          expiresAt: req.body?.expiresAt,
          allowNeverExpires: req.body?.allowNeverExpires,
        });
        const ipAllowlist = normalizeAllowlist(req.body?.ipAllowlist);
        const rateLimit = normalizeRateLimit(req.body?.rateLimit);
        const created = await createSuperAdminKey(
          deps.store,
          {
            name,
            scopes,
            ipAllowlist,
            rateLimit,
            expiresIn: expiry.expiresIn,
            expiresAt: expiry.expiresAt,
            nowMs: Date.now(),
            createdBy: req.user?.handle || null,
          },
          deps.config.superAdminApiPepper || '',
        );
        await audit(deps, req, {
          sessionUser: actor.sessionUser,
          keyId: created.id,
          scope: 'apikeys',
          result: 201,
          reason: 'created',
          before: null,
          after: { id: created.id, scopes, expiresAt: created.key.expiresAt },
        });
        sendJson(
          res,
          deps,
          201,
          { ok: true, nfp: true, shownOnce: true, token: created.token, key: created.key },
          { allowToken: true },
        );
      } catch (err) {
        if (err?.code === 'SCOPE' || err?.code === 'SCOPE_WILDCARD' || err?.code === 'SCOPE_RESERVED') {
          throw new HttpError(400, err.message, { code: err.code });
        }
        throw keyError(err);
      }
    }),
  );

  router.get(
    '/keys',
    asyncHandler(async (req, res) => {
      const actor = await requireKeyManager(deps, req, res, { write: false });
      if (!actor) return;
      const body = { ok: true, nfp: true, keys: listSuperAdminKeys(deps.store) };
      await audit(deps, req, { sessionUser: actor.sessionUser, scope: 'apikeys', result: 200, reason: 'ok' });
      sendJson(res, deps, 200, body);
    }),
  );

  router.get(
    '/keys/:id',
    asyncHandler(async (req, res) => {
      const actor = await requireKeyManager(deps, req, res, { write: false });
      if (!actor) return;
      const key = getPublicSuperAdminKey(deps.store, req.params.id);
      if (!key) {
        await audit(deps, req, {
          sessionUser: actor.sessionUser,
          keyId: req.params.id,
          scope: 'apikeys',
          result: 404,
          reason: 'no_key',
        });
        res.status(404).json({ error: 'not found', code: 'NO_KEY', nfp: true });
        return;
      }
      await audit(deps, req, {
        sessionUser: actor.sessionUser,
        keyId: key.id,
        scope: 'apikeys',
        result: 200,
        reason: 'ok',
      });
      sendJson(res, deps, 200, { ok: true, nfp: true, key });
    }),
  );

  router.post(
    '/keys/:id/revoke',
    asyncHandler(async (req, res) => {
      const actor = await requireKeyManager(deps, req, res);
      if (!actor) return;
      const revoked = await revokeSuperAdminKey(deps.store, req.params.id);
      if (!revoked) {
        await audit(deps, req, {
          sessionUser: actor.sessionUser,
          keyId: req.params.id,
          scope: 'apikeys',
          result: 404,
          reason: 'no_key',
        });
        res.status(404).json({ error: 'not found', code: 'NO_KEY', nfp: true });
        return;
      }
      await audit(deps, req, {
        sessionUser: actor.sessionUser,
        keyId: req.params.id,
        scope: 'apikeys',
        result: 200,
        reason: 'revoked',
        before: { status: revoked.before },
        after: { status: revoked.key.status },
      });
      sendJson(res, deps, 200, { ok: true, nfp: true, key: revoked.key });
    }),
  );

  router.post(
    '/keys/:id/rotate',
    asyncHandler(async (req, res) => {
      const actor = await requireKeyManager(deps, req, res);
      if (!actor) return;
      const rotated = await rotateSuperAdminKey(deps.store, req.params.id, deps.config.superAdminApiPepper || '');
      if (rotated?.conflict) {
        await audit(deps, req, {
          sessionUser: actor.sessionUser,
          keyId: req.params.id,
          scope: 'apikeys',
          result: 409,
          reason: 'revoked',
        });
        res.status(409).json({ error: 'key revoked', code: 'REVOKED', nfp: true });
        return;
      }
      if (!rotated) {
        await audit(deps, req, {
          sessionUser: actor.sessionUser,
          keyId: req.params.id,
          scope: 'apikeys',
          result: 404,
          reason: 'no_key',
        });
        res.status(404).json({ error: 'not found', code: 'NO_KEY', nfp: true });
        return;
      }
      await audit(deps, req, {
        sessionUser: actor.sessionUser,
        keyId: rotated.key.id,
        scope: 'apikeys',
        result: 200,
        reason: 'rotated',
        before: { id: rotated.revokedId, status: 'active' },
        after: { id: rotated.key.id, revokedId: rotated.revokedId, status: 'active' },
      });
      sendJson(
        res,
        deps,
        200,
        {
          ok: true,
          nfp: true,
          shownOnce: true,
          token: rotated.token,
          key: rotated.key,
          revokedId: rotated.revokedId,
        },
        { allowToken: true },
      );
    }),
  );

  function readRoute(path, scope, build) {
    router.get(
      path,
      asyncHandler(async (req, res) => {
        const actor = await requireActor(deps, req, res, scope);
        if (!actor) return;
        const body = await build(req);
        if (!body) {
          await audit(deps, req, {
            keyId: actor.keyId,
            sessionUser: actor.sessionUser,
            scope,
            result: 404,
            reason: 'no_record',
          });
          res.status(404).json({ error: 'not found', code: 'NO_RECORD', nfp: true });
          return;
        }
        await audit(deps, req, {
          keyId: actor.keyId,
          sessionUser: actor.sessionUser,
          scope,
          result: 200,
          reason: 'ok',
        });
        sendJson(res, deps, 200, body);
      }),
    );
  }

  readRoute('/health', 'read:health', () => healthDiag(deps));
  readRoute('/config', 'read:config', () => configDiag(deps));
  readRoute('/store', 'read:store', () => storeDiag(deps.store));
  readRoute('/elections', 'read:elections', () => electionsDiag(deps.store, deps.config.nowFn()));
  readRoute('/elections/:id', 'read:elections', (req) => electionDiag(deps.store, req.params.id, deps.config.nowFn()));
  readRoute('/users', 'read:users', () => usersDiag(deps.store));
  readRoute('/users/:handle', 'read:users', (req) => userDiag(deps.store, req.params.handle));
  readRoute('/l2', 'read:l2', () => l2Diag(deps));
  readRoute('/l1', 'read:l1', () => l1Diag(deps));
  readRoute('/mail', 'read:mail', () => mailDiag(deps));
  readRoute('/logs', 'read:logs', (req) => ({ nfp: true, ...tailLogs(req.query.limit) }));

  router.get(
    '/audit',
    asyncHandler(async (req, res) => {
      const actor = await requireActor(deps, req, res, 'read:audit');
      if (!actor) return;
      const chain = persistedAudit(deps.store);
      const page = filterAuditEntries(chain, req.query || {});
      await audit(deps, req, {
        keyId: actor.keyId,
        sessionUser: actor.sessionUser,
        scope: 'read:audit',
        result: 200,
        reason: 'ok',
      });
      sendJson(res, deps, 200, {
        ok: true,
        nfp: true,
        persisted: deps.store.writerActive !== false,
        standbyLocalCount: Array.isArray(deps.store.standbyAudit) ? deps.store.standbyAudit.length : 0,
        ...page,
      });
    }),
  );

  router.get(
    '/audit/verify',
    asyncHandler(async (req, res) => {
      const actor = await requireActor(deps, req, res, 'read:audit');
      if (!actor) return;
      const chain = persistedAudit(deps.store);
      const verdict = verifyAuditChain(chain);
      await audit(deps, req, {
        keyId: actor.keyId,
        sessionUser: actor.sessionUser,
        scope: 'read:audit',
        result: 200,
        reason: verdict.ok ? 'chain_ok' : 'chain_bad',
      });
      sendJson(res, deps, 200, { nfp: true, ...verdict });
    }),
  );

  async function writeRoute(path, scope, run) {
    router.post(
      path,
      asyncHandler(async (req, res) => {
        const actor = await requireActor(deps, req, res, scope, { write: true });
        if (!actor) return;
        try {
          rejectForbiddenBody(req.body);
        } catch {
          await audit(deps, req, {
            keyId: actor.keyId,
            sessionUser: actor.sessionUser,
            scope,
            result: 400,
            reason: 'forbidden_field',
          });
          res.status(400).json({ error: 'forbidden field', code: 'FORBIDDEN_FIELD', nfp: true });
          return;
        }
        const dryRun = dryRunRequested(req);
        const result = await run(req, dryRun);
        await audit(deps, req, {
          keyId: actor.keyId,
          sessionUser: actor.sessionUser,
          scope,
          result: result.status,
          reason: dryRun ? 'dry_run' : 'ok',
          dryRun,
          before: result.before ?? null,
          after: result.after ?? null,
        });
        sendJson(res, deps, result.status, result.body);
      }),
    );
  }

  writeRoute('/config', 'write:config', (req, dryRun) => writeConfig(deps, req.body || {}, { dryRun }));
  writeRoute('/mail/test', 'write:mail', (req, dryRun) => writeMailTest(deps, req.body || {}, { dryRun }));
  writeRoute('/mail/resend-terms', 'write:mail', (req, dryRun) => writeResendTerms(deps, req.body || {}, { dryRun }));
  writeRoute('/users/:handle/suspend', 'write:users', (req, dryRun) =>
    writeUserStatus(deps, req.params.handle, true, { dryRun }),
  );
  writeRoute('/users/:handle/unsuspend', 'write:users', (req, dryRun) =>
    writeUserStatus(deps, req.params.handle, false, { dryRun }),
  );
  writeRoute('/users/:handle/role', 'write:users', (req, dryRun) =>
    writeUserRole(deps, req.params.handle, req.body?.role, { dryRun }),
  );
  writeRoute('/users/:handle/sessions/revoke', 'write:users', (req, dryRun) =>
    writeRevokeSessions(deps, req.params.handle, { dryRun }),
  );
  writeRoute('/elections/:id/lifecycle', 'write:elections', (req, dryRun) =>
    writeElectionLifecycle(deps, req.params.id, req.body || {}, { dryRun }),
  );
  writeRoute('/l2/archive', 'write:l2', (_req, dryRun) => writeL2(deps, 'archive', { dryRun }));
  writeRoute('/l2/verify', 'write:l2', (_req, dryRun) => writeL2(deps, 'verify', { dryRun }));
  writeRoute('/l2/heartbeat', 'write:l2', (_req, dryRun) => writeL2(deps, 'heartbeat', { dryRun }));
  writeRoute('/logs/level', 'write:logs', (req, dryRun) => writeLogLevel(deps, req.body || {}, { dryRun }));

  router.use(
    asyncHandler(async (req, res) => {
      const actor = sessionActor(req);
      await audit(deps, req, {
        keyId: null,
        sessionUser: actor?.sessionUser || req.user?.handle || null,
        scope: null,
        result: 404,
        reason: 'no_route',
      });
      notFound(res);
    }),
  );

  return router;
}

// NOT FOR PROFIT — civic public good, not a commercial product.

import { Router } from 'express';

import { deliverApiKeyCreatedNotice } from '../apiKeyMail.mjs';
import { requireAuth } from '../auth.mjs';
import { asyncHandler } from '../http.mjs';
import { uuidParam } from '../recordIds.mjs';

export function apiKeysRouter(deps) {
  const { store } = deps;
  const router = Router();
  router.param('id', uuidParam('id'));

  router.get(
    '/me/api-keys',
    requireAuth,
    asyncHandler(async (req, res) => {
      res.json({
        nfp: true,
        apiKeys: store.listApiKeys(req.user.id),
        levels: ['read', 'voter', 'officer'],
        expirations: ['7d', '30d', '90d', '180d', '365d', 'never'],
        defaultExpiration: '30d',
        defaultLevel: 'read',
      });
    }),
  );

  router.post(
    '/me/api-keys',
    requireAuth,
    asyncHandler(async (req, res) => {
      const created = await store.createApiKey(req.user.id, {
        name: req.body?.name,
        level: req.body?.level,
        expiresIn: req.body?.expiresIn,
      });
      const mail = await deliverApiKeyCreatedNotice(deps, {
        user: req.user,
        apiKey: created.record,
      });
      res.status(201).json({
        ok: true,
        nfp: true,
        secretShownOnce: true,
        apiKey: created.record,
        secret: created.secret,
        mail,
      });
    }),
  );

  router.delete(
    '/me/api-keys/:id',
    requireAuth,
    asyncHandler(async (req, res) => {
      const apiKey = await store.revokeApiKey(req.user.id, req.params.id);
      res.json({ ok: true, nfp: true, apiKey });
    }),
  );

  return router;
}

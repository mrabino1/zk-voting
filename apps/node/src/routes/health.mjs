// NOT FOR PROFIT — civic public good, not a commercial product.

import { Router } from 'express';

import { asyncHandler } from '../http.mjs';

export function healthRouter(deps) {
  const router = Router();
  router.get(['/health', '/api/health'], (req, res) => {
    res.json({
      ok: true,
      app: 'zk-voting',
      nfp: true,
      notForProfit: true,
      chainId: deps.config.chainId,
      product: 'Republic',
    });
  });
  return router;
}

export function configRouter(deps) {
  const router = Router();
  router.get(
    '/config',
    asyncHandler(async (_req, res) => {
      res.json({
        nfp: true,
        app: 'zk-voting',
        product: 'Republic',
        rpName: deps.config.rpName,
        rpID: deps.config.rpID,
        chainId: deps.config.chainId,
        origins: deps.config.origins,
        chainConfigured: deps.chain.isConfigured(),
      });
    }),
  );
  return router;
}

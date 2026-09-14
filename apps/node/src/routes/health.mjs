// NOT FOR PROFIT — civic public good, not a commercial product.

import { Router } from 'express';

import { asyncHandler } from '../http.mjs';
import { disclosurePublicView } from '../disclosure.mjs';

export function healthRouter(deps) {
  const router = Router();
  router.get(['/health', '/api/health'], (req, res) => {
    const now = deps.config.nowFn();
    res.json({
      ok: true,
      app: 'zk-voting',
      nfp: true,
      notForProfit: true,
      chainId: deps.config.chainId,
      product: 'Republic',
      disclosure: disclosurePublicView(now, deps.config.disclosureIntervalSeconds),
    });
  });
  return router;
}

export function configRouter(deps) {
  const router = Router();
  router.get(
    '/config',
    asyncHandler(async (_req, res) => {
      const now = deps.config.nowFn();
      res.json({
        nfp: true,
        app: 'zk-voting',
        product: 'Republic',
        rpName: deps.config.rpName,
        rpID: deps.config.rpID,
        chainId: deps.config.chainId,
        origins: deps.config.origins,
        chainConfigured: deps.chain.isConfigured(),
        disclosure: disclosurePublicView(now, deps.config.disclosureIntervalSeconds),
      });
    }),
  );
  return router;
}

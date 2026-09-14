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
      electionFactoryAddress: deps.config.electionFactoryAddress || '',
      chainConfigured: deps.chain.isConfigured(),
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
      const chainConfigured = deps.chain.isConfigured();
      const factoryReady =
        typeof deps.chain.isFactoryReady === 'function' ? deps.chain.isFactoryReady() : false;
      res.json({
        nfp: true,
        app: 'zk-voting',
        product: 'Republic',
        rpName: deps.config.rpName,
        rpID: deps.config.rpID,
        chainId: deps.config.chainId,
        origins: deps.config.origins,
        chainConfigured,
        electionFactoryAddress: deps.config.electionFactoryAddress || '',
        factoryReady,
        chain: {
          configured: chainConfigured,
          factoryAddress: deps.config.electionFactoryAddress || '',
          factoryReady,
          voteReady: deps.chain.isReady(),
          note: chainConfigured
            ? 'POST /api/elections calls ElectionFactory.createElection. JSON-only demo is disabled while CHAIN_RPC is set. Factory failures return 502/503 to the clerk.'
            : 'CHAIN_RPC unset. POST /api/elections writes republic.json only (demo).',
        },
        disclosure: disclosurePublicView(now, deps.config.disclosureIntervalSeconds),
        identity: {
          methods: ['passkey', 'web3', 'smart_card'],
          oneActiveEthAddress: true,
          note: 'A person may verify passkey, Web3 wallet, and smart-card digital ID. Only one Ethereum address is active.',
        },
      });
    }),
  );
  return router;
}

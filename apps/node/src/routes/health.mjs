// NOT FOR PROFIT — civic public good, not a commercial product.

import { Router } from 'express';

import { asyncHandler } from '../http.mjs';
import { disclosurePublicView } from '../disclosure.mjs';
import { SHARED_DEPLOYMENT_NOTE, mergePublicContracts } from '../cms.mjs';

export function healthRouter(deps) {
  const router = Router();
  router.get(['/health', '/api/health'], (req, res) => {
    const now = deps.config.nowFn();
    const interval = deps.config.disclosureIntervalSeconds;
    const acceptedBallotsDisclosed = deps.store?.publishedAcceptedBallotsAll
      ? deps.store.publishedAcceptedBallotsAll(now, interval)
      : undefined;
    const contracts = mergePublicContracts(deps.config, deps.store?.getSite?.());
    res.json({
      ok: true,
      app: 'zk-voting',
      nfp: true,
      notForProfit: true,
      chainId: deps.config.chainId,
      product: 'Republic',
      sharedDeployment: true,
      electionFactoryAddress: contracts.factory || '',
      chainConfigured: deps.chain.isConfigured(),
      l1CertificationConfigured: Boolean(deps.l1?.isConfigured?.()),
      disclosure: disclosurePublicView(now, interval, { acceptedBallotsDisclosed }),
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
      const contracts = mergePublicContracts(deps.config, deps.store?.getSite?.());
      res.json({
        nfp: true,
        app: 'zk-voting',
        product: 'Republic',
        rpName: deps.config.rpName,
        rpID: deps.config.rpID,
        chainId: deps.config.chainId,
        origins: deps.config.origins,
        chainConfigured,
        sharedDeployment: true,
        sharedDeploymentNote: SHARED_DEPLOYMENT_NOTE,
        electionFactoryAddress: contracts.factory || '',
        factoryReady,
        chain: {
          configured: chainConfigured,
          factoryAddress: contracts.factory || '',
          factoryReady,
          voteReady: deps.chain.isReady(),
          note: chainConfigured
            ? 'POST /api/elections calls the one shared ElectionFactory. Fork the Node UI; do not deploy a new factory per jurisdiction. JSON-only demo is disabled while CHAIN_RPC is set. Factory failures return 502/503 to the clerk.'
            : 'CHAIN_RPC unset. POST /api/elections writes republic.json only (demo). Pin the shared factory on /office/site when you connect a chain.',
        },
        addresses: {
          factory: contracts.factory || null,
          ballotInbox: contracts.ballotInbox || null,
          verifier: contracts.verifier || null,
        },
        contracts,
        coercion: {
          policy: 'one-ballot-per-nullifier',
          receiptsProveChoice: false,
        },
        l1CertificationConfigured: Boolean(deps.l1?.isConfigured?.()),
        l1CertificationSkipReason: deps.l1?.isConfigured?.() ? null : deps.l1?.skipReason?.() || 'L1 env unset',
        disclosure: disclosurePublicView(now, deps.config.disclosureIntervalSeconds, {
          acceptedBallotsDisclosed: deps.store?.publishedAcceptedBallotsAll
            ? deps.store.publishedAcceptedBallotsAll(now, deps.config.disclosureIntervalSeconds)
            : undefined,
        }),
        identity: {
          methods: ['passkey', 'web3', 'smart_card'],
          oneActiveEthAddress: true,
          note: 'A person may verify passkey, Web3 wallet, and smart-card digital ID. Only one Ethereum address is active.',
        },
        tally: {
          schemes: ['sum_only', 'opens_ballots'],
          defaultScheme: 'sum_only',
          demoEncryption: 'p256-ecies-aesgcm-v1',
          production: false,
          note: 'opens_ballots uses a threshold-1 operator key (NON-PRODUCTION). sum_only still accepts any counts that sum to acceptedBallots. Circuit public signals (tally.circom) are versioned separately from Tally.sol mock inputs.',
        },
        proving: {
          path: 'in-progress',
          ceremony: 'not-done',
          mockVerifierDefault: deps.config.useMockVerifier !== false,
          provingPath: Boolean(deps.config.provingPath),
          hashScheme: deps.config.hashScheme || 'republic.hash.keccak-dev-v1',
          poseidonWired: false,
        },
        ballot: {
          methods: ['plurality', 'ranked_choice'],
          defaultMethod: 'plurality',
          questionTypes: ['YES_NO', 'SINGLE_CHOICE', 'MULTI_CHOICE', 'RANKED', 'MEASURE', 'ARTICLE'],
          note: 'ranked_choice is instant-runoff (IRV). On-chain v1 may keep the method inside ballotSpecHash; ElectionParams has no method enum.',
        },
        auth: {
          allowDevLogin: Boolean(deps.config.allowDevLogin),
          passkeyLogin: true,
          web3Login: true,
          note: 'Sign in with a registered passkey or a bound Ethereum wallet. Dev login is a local/test fallback only.',
        },
      });
    }),
  );
  return router;
}

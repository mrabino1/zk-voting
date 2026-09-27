// NOT FOR PROFIT — civic public good, not a commercial product.

import { Router } from 'express';

import { asyncHandler } from '../http.mjs';
import { disclosurePublicView } from '../disclosure.mjs';
import { AUTH_METHOD_TYPES, identityCaps } from '../identity.mjs';
import { PIN_MAX_LEN, PIN_MIN_LEN } from '../pin.mjs';
import { credentialProviderPublic } from '../credentials.mjs';
import { SHARED_DEPLOYMENT_NOTE, mergePublicContracts } from '../cms.mjs';
import { listAggregators } from '../guardians/aggregate.mjs';

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
        pollsEnabled: Boolean(deps.config.pollsEnabled),
        pollsReady: Boolean(deps.config.pollsReady),
        votingToken: {
          configured: Boolean(deps.config.votingToken?.configured),
          chainId: deps.config.votingToken?.chainId || 1,
          address: deps.config.votingToken?.configured ? deps.config.votingToken.address : null,
          reason: deps.config.pollsEnabled && !deps.config.votingToken?.configured
            ? deps.config.votingToken?.reason || 'unset'
            : null,
          readOnly: true,
        },
        mail: {
          webhookConfigured: Boolean(deps.config.mailWebhookUrl),
          note: 'Role-promotion mail is queued on the Node and is never written to civic L2 transactions.',
        },
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
        receipts: {
          schema: 'republic.receipt.v1',
          proveChoice: false,
          email: true,
          emailVendor: 'ses',
          verifyPath: '/receipt',
          pdfProtected: true,
          pdfModify: false,
          pdfEncryption: 'standard-r3-rc4-128',
          hashAlgo: 'sha256',
          hashOf: 'pdf-bytes',
          note: 'After a ballot is accepted, the voter may email a hash-only receipt (body + locked PDF). The PDF uses Standard Security so it cannot be edited. Paste the proof or drop the PDF at /receipt to confirm it counted and was not modified. Never lists a candidate or option. Public turnout is an hourly snapshot.',
        },
        outcomes: {
          schema: 'republic.outcomes.v1',
          portal: '/outcomes',
          verifyPath: '/outcomes',
          phases: ['before', 'during', 'after'],
          proveChoice: false,
          unofficialCounts: false,
          officialReport: {
            schema: 'republic.outcome-report.v1',
            pdfProtected: true,
            pdfModify: false,
            pdfEncryption: 'standard-r3-rc4-128',
            hashAlgo: 'sha256',
            hashOf: 'pdf-bytes',
            qr: true,
            integrity: 'hmac-sha256',
            verifyPath: '/outcomes/verify',
            defaultSubscribeOnVote: true,
            unsubscribeByException: true,
            issuedAfter: 'cutoff-expired-and-tallied',
            note: 'After voting time expires and a tally is posted, subscribers receive a locked official PDF (counts, start, end). Voters are subscribed by default when they vote. QR and hash seals cannot be removed from the admin template.',
          },
          note: 'Public monitor of every election, grouped before / during / after voting from chain and election state. Runs the auditor pack plus freeze-root and L1 checks. Certified option counts appear only after a tally. Separate from /receipt and from unofficial horse-race totals.',
        },
        l1CertificationConfigured: Boolean(deps.l1?.isConfigured?.()),
        l1CertificationSkipReason: deps.l1?.isConfigured?.() ? null : deps.l1?.skipReason?.() || 'L1 env unset',
        disclosure: disclosurePublicView(now, deps.config.disclosureIntervalSeconds, {
          acceptedBallotsDisclosed: deps.store?.publishedAcceptedBallotsAll
            ? deps.store.publishedAcceptedBallotsAll(now, deps.config.disclosureIntervalSeconds)
            : undefined,
        }),
        identity: {
          methods: [...AUTH_METHOD_TYPES],
          oneActiveEthAddress: true,
          onePrimaryEmail: true,
          maxPasskeys: identityCaps().passkeys,
          maxEmails: identityCaps().emails,
          maxSmartCards: identityCaps().smartCards,
          maxCivicIds: identityCaps().civicIds,
          civicIdKinds: ['drivers_license', 'passport'],
          credentialProvider: credentialProviderPublic(deps.config),
          registrationApproval: 'civil_officer',
          votePin: {
            required: true,
            minLength: PIN_MIN_LEN,
            maxLength: PIN_MAX_LEN,
            keypad: 'phone-3x3-zero',
            scrambleOnVote: true,
            keyboardEntry: false,
          },
          note: 'A person may verify email, Web3 wallet, smart-card reader, driver’s license or passport, and passkey. Up to 5 passkeys, 5 emails, 5 smart cards, and 5 licenses/passports; exactly one email is primary. Extra Ethereum addresses must be signature-verified. Only one Ethereum address is active. Profile setup includes a 4–8 digit vote PIN, entered on a scrambled phone keypad at ballot submit (no keyboard). A voter requests election registration; a registrar or clerk of that election’s jurisdiction approves. Civil officers may revoke an expired card or license. Document images and full ID numbers are not stored.',
        },
        tally: {
          schemes: ['sum_only', 'opens_ballots'],
          defaultScheme: 'sum_only',
          demoEncryption: 'p256-ecies-aesgcm-v1',
          guardians: 'p256-feldman-dkg-v1',
          aggregation: 'undecided',
          aggregators: listAggregators(),
          production: false,
          note: 'opens_ballots encrypts to a Feldman t-of-n guardian public key (NON-PRODUCTION). Decrypting takes t verified partials; the Node does not hold a tally private key. Homomorphic aggregation and a mixnet are an open product decision and neither is selected. sum_only still accepts any counts that sum to acceptedBallots. Circuit public signals (tally.circom) are versioned separately from Tally.sol mock inputs.',
        },
        proving: {
          path: 'in-progress',
          ceremony: 'not-done',
          mockVerifierDefault: deps.config.useMockVerifier !== false,
          provingPath: Boolean(deps.config.provingPath),
          hashScheme: deps.config.hashScheme || 'republic.hash.keccak-dev-v1',
          circuitHashScheme: 'republic.hash.poseidon-bn254-x5-t3-v1',
          poseidonWired: true,
          groth16: 'untrusted-local-fixture-or-missing-keys',
          note: 'Poseidon(2) matches the vote circuit, proof-helpers, and PoseidonHasher. Unit tests still use MockVerifier. The committed Groth16 check is an untrusted local setup, not a ceremony. Demo passkey commitments stay keccak-dev-v1.',
        },
        ballot: {
          methods: ['plurality', 'ranked_choice'],
          defaultMethod: 'plurality',
          questionTypes: ['YES_NO', 'SINGLE_CHOICE', 'MULTI_CHOICE', 'RANKED', 'MEASURE', 'ARTICLE'],
          note: 'ranked_choice is instant-runoff (IRV). On-chain v1 may keep the method inside ballotSpecHash; ElectionParams has no method enum.',
        },
        mail: {
          webhookConfigured: Boolean(deps.config.mailWebhookUrl),
          note: 'Role-promotion mail is queued on the Node. It is never written to civic L2 transactions.',
        },
        auth: {
          allowDevLogin: Boolean(deps.config.allowDevLogin),
          passkeyLogin: true,
          web3Login: true,
          emailLogin: true,
          smartCardLogin: true,
          civicIdLogin: true,
          requireEmailMfa: Boolean(deps.config.requireEmailMfa),
          emailMfaVendor: 'ses',
          sesConfigured: Boolean(deps.config.sesFromAddress && deps.config.awsRegion),
          allowSmartCardMock: Boolean(deps.config.allowSmartCardMock),
          allowCivicIdMock: Boolean(deps.config.allowCivicIdMock),
          terms: {
            path: '/terms',
            pdfPath: '/terms.pdf',
            hashAlgo: 'sha256',
            hashOf: 'pdf-bytes',
            note: 'Acceptance records SHA-256 of the exact Terms PDF bytes (the SES attachment). Markdown SHA-256 is published too.',
          },
          note: 'Sign in with email, a bound Ethereum wallet (signature), a smart-card reader, or a hashed driver’s license/passport. Every path completes with an email one-time code via AWS SES when MFA is on. A vote PIN is set on the profile and entered on a scrambled keypad at ballot submit. Dev login is a local/test fallback only.',
        },
      });
    }),
  );
  return router;
}

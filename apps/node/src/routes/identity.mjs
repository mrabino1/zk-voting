// NOT FOR PROFIT — civic public good, not a commercial product.
// Bind email / web3 wallet / smart-card / civic ID / passkey to one person.
// Many internally verified ETH addresses; exactly one active.

import { Router } from 'express';
import { keccak256, stringToHex } from 'viem';

import { asyncHandler, HttpError } from '../http.mjs';
import { requireAuth, requireAnyJurisdictionRole, publicUser } from '../auth.mjs';
import {
  AUTH_METHOD_CATALOG,
  civicIdHash,
  civicIdLabel,
  createIdentityChallenges,
  fingerprintFromCertificate,
  isAuthMethodType,
  isCivicIdKind,
  normalizeEmail,
  normalizeEthAddress,
  normalizeFingerprint,
  normalizeIssuer,
  publicIdentity,
  resolveBoundPerson,
  verifyWeb3Bind,
} from '../identity.mjs';

export function identityRouter(deps) {
  const { store, config, mfa } = deps;
  const challenges = createIdentityChallenges();
  const router = Router();

  function originOf(req) {
    const origin = req.headers.origin;
    if (origin) return String(origin);
    return config.origins?.[0] || `http://localhost:${config.port}`;
  }

  router.get('/identity/methods', (_req, res) => {
    res.json({
      nfp: true,
      methods: AUTH_METHOD_CATALOG,
      mfa: {
        email: true,
        vendor: 'ses',
        required: Boolean(config.requireEmailMfa),
      },
      note: 'A person may verify every method. Only one Ethereum address is active. Sign-in completes with email MFA when SES is configured.',
    });
  });

  router.get(
    '/me/identity',
    requireAuth,
    asyncHandler(async (req, res) => {
      res.json({ nfp: true, identity: publicIdentity(req.user), user: publicUser(req.user) });
    }),
  );

  router.post(
    '/identity/email/start',
    asyncHandler(async (req, res) => {
      const email = normalizeEmail(req.body?.email);
      const handle = String(req.body?.handle || '').trim() || null;
      const owner = store.findUserByEmail(email);
      if (req.user) {
        if (owner && owner.id !== req.user.id) {
          throw new HttpError(409, 'email already bound to another person', { code: 'METHOD_OWNED' });
        }
        const payload = await mfa.startMfa(res, {
          user: req.user,
          factor: 'email',
          email,
          bindEmail: true,
          purpose: 'mfa',
        });
        res.json(payload);
        return;
      }
      if (owner) {
        throw new HttpError(409, 'email already bound to another person', { code: 'METHOD_OWNED' });
      }
      const payload = await mfa.startMfa(res, {
        user: null,
        factor: 'email',
        email,
        handle,
        purpose: 'register',
        bindEmail: true,
      });
      res.json(payload);
    }),
  );

  router.post(
    '/identity/web3/challenge',
    asyncHandler(async (req, res) => {
      const address = normalizeEthAddress(req.body?.address);
      const issued = challenges.issueWeb3({
        address,
        chainId: config.chainId,
        origin: originOf(req),
      });
      res.json({ nfp: true, ...issued });
    }),
  );

  router.post(
    '/identity/web3/verify',
    asyncHandler(async (req, res) => {
      const address = normalizeEthAddress(req.body?.address);
      const signature = req.body?.signature;
      if (!signature) throw new HttpError(400, 'signature required');
      const pending =
        challenges.take(`web3:${address.toLowerCase()}`) || challenges.take(req.body?.nonce);
      if (!pending || pending.type !== 'web3') {
        throw new HttpError(400, 'no web3 challenge');
      }
      if (normalizeEthAddress(pending.address) !== address) {
        throw new HttpError(400, 'address mismatch');
      }
      await verifyWeb3Bind({ address, message: pending.message, signature });

      const foundMethod = store.findUserByAuthMethod({ type: 'web3', address });
      const addressOwner = store.findUserByEthAddress(address);
      if (foundMethod && req.user && foundMethod.user.id !== req.user.id) {
        throw new HttpError(409, 'wallet already bound to another person', {
          code: 'METHOD_OWNED',
        });
      }
      if (addressOwner && req.user && addressOwner.id !== req.user.id) {
        throw new HttpError(409, 'Ethereum address already bound to another person', {
          code: 'ADDRESS_OWNED',
        });
      }
      if (
        addressOwner &&
        !req.user &&
        (!foundMethod || foundMethod.user.id !== addressOwner.id)
      ) {
        throw new HttpError(409, 'Ethereum address already bound to another person', {
          code: 'ADDRESS_OWNED',
        });
      }
      let user = resolveBoundPerson({
        sessionUser: req.user || null,
        methodOwner: foundMethod?.user || null,
        addressOwner: null,
      });
      if (!user) {
        const handle =
          String(req.body?.handle || '').trim() || `eth-${address.slice(2).toLowerCase()}`;
        if (store.getUserByHandle(handle)) throw new HttpError(409, 'handle taken');
        user = store.createUser({ handle, role: 'voter' });
      }
      const { method } = await store.addAuthMethod(user.id, {
        type: 'web3',
        address,
        label: 'Web3 wallet',
        verifiedBy: 'self',
      });
      await store.addEthAccount(user.id, { address, source: 'web3', methodId: method.id });
      const payload = await mfa.completeFactor(res, {
        user: store.getUser(user.id),
        factor: 'web3',
        email: req.body?.email,
      });
      res.json(payload);
    }),
  );

  router.post(
    '/identity/smart-card/challenge',
    asyncHandler(async (req, res) => {
      const fingerprint = req.body?.fingerprint
        ? normalizeFingerprint(req.body.fingerprint)
        : req.body?.certificate
          ? fingerprintFromCertificate(req.body.certificate)
          : null;
      const issued = challenges.issueSmartCard({ fingerprint });
      res.json({ nfp: true, ...issued });
    }),
  );

  router.post(
    '/identity/smart-card/verify',
    asyncHandler(async (req, res) => {
      const nonce = req.body?.nonce;
      const pending = challenges.take(nonce) || (req.body?.fingerprint
        ? challenges.take(`card:${normalizeFingerprint(req.body.fingerprint)}`)
        : null);
      if (!pending || pending.type !== 'smart_card') {
        throw new HttpError(400, 'no smart-card challenge');
      }
      const fingerprint = req.body?.certificate
        ? fingerprintFromCertificate(req.body.certificate)
        : normalizeFingerprint(req.body?.fingerprint || pending.fingerprint);
      if (pending.fingerprint && pending.fingerprint !== fingerprint) {
        throw new HttpError(400, 'fingerprint mismatch');
      }
      const mockOk = Boolean(req.body?.mock) && Boolean(config.allowSmartCardMock);
      if (!mockOk) {
        throw new HttpError(
          400,
          'live X.509 card verification is clerk-attested in this Node build; use registrar attest or ALLOW_SMART_CARD_MOCK=1',
        );
      }

      const found = store.findUserByAuthMethod({ type: 'smart_card', fingerprint });
      let user = resolveBoundPerson({
        sessionUser: req.user || null,
        methodOwner: found?.user || null,
        addressOwner: null,
      });
      if (!user) {
        const handle =
          String(req.body?.handle || '').trim() || `card-${fingerprint.slice(2, 18)}`;
        if (store.getUserByHandle(handle)) throw new HttpError(409, 'handle taken');
        user = store.createUser({ handle, role: 'voter' });
      }
      await store.addAuthMethod(user.id, {
        type: 'smart_card',
        fingerprint,
        subject: req.body?.subject || null,
        issuer: req.body?.issuer || null,
        label: req.body?.label || 'Smart card digital ID',
        verifiedBy: 'self',
      });
      const payload = await mfa.completeFactor(res, {
        user: store.getUser(user.id),
        factor: 'smart_card',
        email: req.body?.email,
      });
      res.json(payload);
    }),
  );

  router.post(
    '/identity/civic-id/verify',
    asyncHandler(async (req, res) => {
      const kind = req.body?.kind;
      if (!isCivicIdKind(kind)) throw new HttpError(400, 'invalid civic id kind');
      const issuer = normalizeIssuer(req.body?.issuer);
      const hash = req.body?.civicIdHash
        ? String(req.body.civicIdHash).toLowerCase()
        : civicIdHash({ kind, issuer, documentNumber: req.body?.documentNumber });
      const mockOk = Boolean(req.body?.mock) && Boolean(config.allowCivicIdMock);
      if (!mockOk) {
        throw new HttpError(
          400,
          'license/passport self-service is clerk-attested in this Node build; use registrar attest or ALLOW_CIVIC_ID_MOCK=1',
        );
      }
      const found = store.findUserByAuthMethod({
        type: 'civic_id',
        fingerprint: hash,
        civicIdHash: hash,
      });
      let user = resolveBoundPerson({
        sessionUser: req.user || null,
        methodOwner: found?.user || null,
        addressOwner: null,
      });
      if (!user) {
        const handle =
          String(req.body?.handle || '').trim() ||
          `id-${kind === 'passport' ? 'pp' : 'dl'}-${hash.slice(2, 12)}`;
        if (store.getUserByHandle(handle)) throw new HttpError(409, 'handle taken');
        user = store.createUser({ handle, role: 'voter' });
      }
      await store.addAuthMethod(user.id, {
        type: 'civic_id',
        fingerprint: hash,
        civicIdHash: hash,
        kind,
        issuer,
        label: civicIdLabel(kind),
        verifiedBy: mockOk ? 'self' : 'registrar',
      });
      const payload = await mfa.completeFactor(res, {
        user: store.getUser(user.id),
        factor: 'civic_id',
        email: req.body?.email,
      });
      res.json(payload);
    }),
  );

  router.post(
    '/me/eth-accounts',
    requireAuth,
    asyncHandler(async (req, res) => {
      const address = normalizeEthAddress(req.body?.address);
      const source = String(req.body?.source || 'passkey');
      const { user } = await store.addEthAccount(req.user.id, {
        address,
        source,
        methodId: req.body?.methodId || null,
      });
      res.status(201).json({ nfp: true, identity: publicIdentity(user) });
    }),
  );

  router.post(
    '/me/eth-accounts/active',
    requireAuth,
    asyncHandler(async (req, res) => {
      const user = await store.setActiveEthAddress(req.user.id, req.body?.address);
      res.json({ nfp: true, identity: publicIdentity(user), activeEthAddress: user.activeEthAddress });
    }),
  );

  router.post(
    '/persons/:id/person-key',
    requireAuth,
    requireAnyJurisdictionRole(store, 'registrar'),
    asyncHandler(async (req, res) => {
      let hash = req.body?.personKeyHash;
      if (!hash && req.body?.personKey) {
        hash = keccak256(stringToHex(String(req.body.personKey)));
      }
      const user = await store.setPersonKeyHash(req.params.id, hash);
      res.json({ nfp: true, user: publicUser(user), identity: publicIdentity(user) });
    }),
  );

  router.post(
    '/persons/:id/methods',
    requireAuth,
    requireAnyJurisdictionRole(store, 'registrar'),
    asyncHandler(async (req, res) => {
      const type = req.body?.type;
      if (!isAuthMethodType(type)) throw new HttpError(400, 'invalid auth method type');
      const fields = {
        type,
        verifiedBy: 'registrar',
        label: req.body?.label || AUTH_METHOD_CATALOG.find((m) => m.type === type)?.label,
        credentialId: req.body?.credentialId,
        address: req.body?.address ? normalizeEthAddress(req.body.address) : null,
        fingerprint: req.body?.fingerprint
          ? normalizeFingerprint(req.body.fingerprint)
          : req.body?.certificate
            ? fingerprintFromCertificate(req.body.certificate)
            : null,
        subject: req.body?.subject || null,
        issuer: req.body?.issuer || null,
        email: req.body?.email ? normalizeEmail(req.body.email) : null,
        kind: req.body?.kind || null,
        civicIdHash: req.body?.civicIdHash || null,
      };
      if (type === 'civic_id') {
        if (!isCivicIdKind(fields.kind)) throw new HttpError(400, 'invalid civic id kind');
        fields.issuer = normalizeIssuer(req.body?.issuer);
        const hash = fields.civicIdHash
          ? String(fields.civicIdHash).toLowerCase()
          : civicIdHash({
              kind: fields.kind,
              issuer: fields.issuer,
              documentNumber: req.body?.documentNumber,
            });
        fields.fingerprint = hash;
        fields.civicIdHash = hash;
        fields.label = fields.label || civicIdLabel(fields.kind);
      }
      if (type === 'email' && !fields.email) throw new HttpError(400, 'email required');
      const { user, method } = await store.addAuthMethod(req.params.id, fields);
      if (type === 'web3' && fields.address) {
        await store.addEthAccount(user.id, { address: fields.address, source: 'web3', methodId: method.id });
      }
      res.status(201).json({
        nfp: true,
        identity: publicIdentity(store.getUser(user.id)),
        method: publicIdentity(store.getUser(user.id)).authMethods.find((m) => m.id === method.id) || {
          id: method.id,
          type: method.type,
          verified: true,
        },
      });
    }),
  );

  router.post(
    '/persons/:id/eth-accounts',
    requireAuth,
    requireAnyJurisdictionRole(store, 'registrar'),
    asyncHandler(async (req, res) => {
      const { user } = await store.addEthAccount(req.params.id, {
        address: req.body?.address,
        source: req.body?.source || 'registrar',
      });
      res.status(201).json({ nfp: true, identity: publicIdentity(user) });
    }),
  );

  router.post(
    '/persons/:id/eth-accounts/active',
    requireAuth,
    requireAnyJurisdictionRole(store, 'registrar'),
    asyncHandler(async (req, res) => {
      const user = await store.setActiveEthAddress(req.params.id, req.body?.address);
      res.json({ nfp: true, identity: publicIdentity(user), activeEthAddress: user.activeEthAddress });
    }),
  );

  return router;
}

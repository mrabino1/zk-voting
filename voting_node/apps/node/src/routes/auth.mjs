// NOT FOR PROFIT — civic public good, not a commercial product.

import { Router } from 'express';

import { resolveRequestWebAuthn } from '../config.mjs';
import { asyncHandler, HttpError } from '../http.mjs';
import { destroySession, publicUser, requireAuth } from '../auth.mjs';
import {
  createIdentityChallenges,
  fingerprintFromCertificate,
  isClaimedPerson,
  normalizeEmail,
  normalizeEthAddress,
  normalizeFingerprint,
  publicIdentity,
  resolveCivicIdLoginPerson,
  resolveEmailLoginPerson,
  resolveSmartCardLoginPerson,
  resolveWeb3LoginPerson,
  verifyWeb3Bind,
} from '../identity.mjs';
import { isRole } from '../roles.mjs';
import { requireAcceptedTerms } from '../terms.mjs';

export function authRouter(deps) {
  const { store, config, passkeys, mfa } = deps;
  const router = Router();
  const web3Challenges = createIdentityChallenges();
  const cardChallenges = createIdentityChallenges();

  function originOf(req) {
    const origin = req.headers.origin;
    if (origin) return String(origin);
    return config.origins?.[0] || `http://localhost:${config.port}`;
  }

  router.post(
    '/passkey/register/begin',
    asyncHandler(async (req, res) => {
      const handle = req.body?.handle || req.body?.displayName || req.user?.handle;
      const existing = handle ? store.getUserByHandle(handle) : null;
      if (existing && isClaimedPerson(existing)) {
        if (!req.user) {
          throw new HttpError(401, 'authentication required to add a passkey', {
            code: 'AUTH_REQUIRED',
          });
        }
        if (req.user.id !== existing.id) {
          throw new HttpError(403, 'passkey registration is for a different account', {
            code: 'HANDLE_MISMATCH',
          });
        }
      } else if (existing && req.user && req.user.id !== existing.id) {
        throw new HttpError(403, 'passkey registration is for a different account', {
          code: 'HANDLE_MISMATCH',
        });
      } else if (!req.user && !existing) {
        requireAcceptedTerms(req.body || {});
      }
      if (
        !req.user &&
        existing &&
        existing.role === 'platform_super_admin' &&
        !isClaimedPerson(existing) &&
        config.setupToken
      ) {
        throw new HttpError(403, 'use the first-run setup screen to create the super admin', {
          code: 'SETUP_TOKEN_REQUIRED',
        });
      }
      // Unclaimed seed (e.g. ADMIN_HANDLE): first claim keeps prior terms rules.
      // Claimed → session user only. Unclaimed seed → that row. Else → new handle.
      const targetUser = req.user
        ? req.user
        : existing && !isClaimedPerson(existing)
          ? existing
          : null;
      const options = await passkeys.beginRegister({
        user: targetUser,
        handle: targetUser?.handle || handle,
        acceptedTerms: req.body?.acceptedTerms,
        webauthn: resolveRequestWebAuthn(config, req),
      });
      res.json({ ...options, publicKey: options, rpName: config.rpName, nfp: true });
    }),
  );

  router.post(
    '/passkey/register/finish',
    asyncHandler(async (req, res) => {
      const result = await passkeys.finishRegister({
        body: req.body,
        user: req.user,
        handle: req.body?.handle,
      });
      const payload = await mfa.completeFactor(res, {
        user: result.user,
        factor: 'passkey',
        email: req.body?.email,
        bindEmail: Boolean(req.body?.email),
        acceptedTerms: result.acceptedTerms || req.body?.acceptedTerms,
      });
      res.json(payload);
    }),
  );

  router.post(
    '/passkey/login/begin',
    asyncHandler(async (req, res) => {
      const handle = req.body?.handle;
      const options = await passkeys.beginLogin({
        user: handle ? store.getUserByHandle(handle) : null,
        handle,
        webauthn: resolveRequestWebAuthn(config, req),
      });
      res.json({ ...options, publicKey: options, rpName: config.rpName, nfp: true });
    }),
  );

  router.post(
    '/passkey/login/finish',
    asyncHandler(async (req, res) => {
      const result = await passkeys.finishLogin({ body: req.body });
      const payload = await mfa.completeFactor(res, { user: result.user, factor: 'passkey' });
      res.json(payload);
    }),
  );

  router.post(
    '/web3/challenge',
    asyncHandler(async (req, res) => {
      const address = normalizeEthAddress(req.body?.address);
      const issued = web3Challenges.issueWeb3Login({
        address,
        chainId: config.chainId,
        origin: originOf(req),
      });
      res.json({ nfp: true, ...issued });
    }),
  );

  router.post(
    '/web3/login',
    asyncHandler(async (req, res) => {
      const address = normalizeEthAddress(req.body?.address);
      const signature = req.body?.signature;
      if (!signature) throw new HttpError(400, 'signature required');
      const pending =
        web3Challenges.take(`web3-login:${address.toLowerCase()}`) ||
        web3Challenges.take(req.body?.nonce);
      if (!pending || pending.type !== 'web3_login') {
        throw new HttpError(400, 'no web3 login challenge');
      }
      if (normalizeEthAddress(pending.address) !== address) {
        throw new HttpError(400, 'address mismatch');
      }
      await verifyWeb3Bind({ address, message: pending.message, signature });
      const user = resolveWeb3LoginPerson(store, address);
      if (!user) {
        throw new HttpError(404, 'unknown credential', { code: 'UNKNOWN_CREDENTIAL' });
      }
      const payload = await mfa.completeFactor(res, {
        user,
        factor: 'web3',
        email: req.body?.email,
      });
      res.json(payload);
    }),
  );

  router.post(
    '/email/start',
    asyncHandler(async (req, res) => {
      const email = normalizeEmail(req.body?.email);
      const user = resolveEmailLoginPerson(store, email);
      if (!user) {
        throw new HttpError(404, 'unknown credential', { code: 'UNKNOWN_CREDENTIAL' });
      }
      const payload = await mfa.completeFactor(res, { user, factor: 'email', email });
      res.json(payload);
    }),
  );

  router.post(
    '/smart-card/challenge',
    asyncHandler(async (req, res) => {
      const fingerprint = req.body?.fingerprint
        ? normalizeFingerprint(req.body.fingerprint)
        : req.body?.certificate
          ? fingerprintFromCertificate(req.body.certificate)
          : null;
      const issued = cardChallenges.issueSmartCardLogin({ fingerprint });
      res.json({ nfp: true, ...issued });
    }),
  );

  router.post(
    '/smart-card/login',
    asyncHandler(async (req, res) => {
      const nonce = req.body?.nonce;
      const pending =
        cardChallenges.take(nonce) ||
        (req.body?.fingerprint
          ? cardChallenges.take(`card-login:${normalizeFingerprint(req.body.fingerprint)}`)
          : null);
      if (!pending || pending.type !== 'smart_card_login') {
        throw new HttpError(400, 'no smart-card login challenge');
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
      const user = resolveSmartCardLoginPerson(store, fingerprint);
      if (!user) {
        throw new HttpError(404, 'unknown credential', { code: 'UNKNOWN_CREDENTIAL' });
      }
      const payload = await mfa.completeFactor(res, {
        user,
        factor: 'smart_card',
        email: req.body?.email,
      });
      res.json(payload);
    }),
  );

  router.post(
    '/civic-id/login',
    asyncHandler(async (req, res) => {
      const kind = req.body?.kind;
      const issuer = req.body?.issuer;
      const documentNumber = req.body?.documentNumber;
      const user = resolveCivicIdLoginPerson(store, { kind, issuer, documentNumber });
      if (!user) {
        throw new HttpError(404, 'unknown credential', { code: 'UNKNOWN_CREDENTIAL' });
      }
      const payload = await mfa.completeFactor(res, {
        user,
        factor: 'civic_id',
        email: req.body?.email,
      });
      res.json(payload);
    }),
  );

  router.post(
    '/mfa/email',
    asyncHandler(async (req, res) => {
      const payload = await mfa.provideEmail(req, res, req.body?.email);
      res.json(payload);
    }),
  );

  router.post(
    '/mfa/resend',
    asyncHandler(async (req, res) => {
      const payload = await mfa.resend(req, res);
      res.json(payload);
    }),
  );

  router.post(
    '/mfa/verify',
    asyncHandler(async (req, res) => {
      const payload = await mfa.verify(req, res, req.body?.code || req.body?.otp);
      res.json(payload);
    }),
  );

  router.get('/mfa/status', (req, res) => {
    res.json(mfa.status(req));
  });

  router.post(
    '/logout',
    asyncHandler(async (req, res) => {
      await destroySession(req, res, store, config);
      res.json({ ok: true, nfp: true });
    }),
  );

  router.post(
    '/dev-login',
    asyncHandler(async (req, res) => {
      if (!config.allowDevLogin || process.env.NODE_ENV === 'production') {
        throw new HttpError(404, 'not found');
      }
      const handle = String(req.body?.handle || '').trim();
      if (!handle) throw new HttpError(400, 'handle required');
      let user = store.getUserByHandle(handle);
      if (!user) {
        const role = isRole(req.body?.role) ? req.body.role : 'voter';
        user = store.createUser({ handle, role });
        await store.persist();
      }
      const payload = await mfa.completeFactor(res, { user, factor: 'dev' });
      res.json({ ...payload, nfp: true, dev: true });
    }),
  );

  router.get('/session', requireAuth, (req, res) => {
    res.json({ ok: true, user: publicUser(req.user), identity: publicIdentity(req.user), nfp: true });
  });

  return router;
}

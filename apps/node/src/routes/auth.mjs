// NOT FOR PROFIT — civic public good, not a commercial product.

import { Router } from 'express';

import { asyncHandler, HttpError } from '../http.mjs';
import { establishSession, destroySession, requireAuth, publicUser } from '../auth.mjs';
import {
  createIdentityChallenges,
  normalizeEthAddress,
  publicIdentity,
  resolveWeb3LoginPerson,
  verifyWeb3Bind,
} from '../identity.mjs';
import { isRole } from '../roles.mjs';

export function authRouter(deps) {
  const { store, config, passkeys } = deps;
  const router = Router();
  const web3Challenges = createIdentityChallenges();

  function originOf(req) {
    const origin = req.headers.origin;
    if (origin) return String(origin);
    return config.origins?.[0] || `http://localhost:${config.port}`;
  }

  function sessionPayload(user) {
    return {
      ok: true,
      verified: true,
      user: publicUser(user),
      identity: publicIdentity(user),
      nfp: true,
    };
  }

  router.post(
    '/passkey/register/begin',
    asyncHandler(async (req, res) => {
      const handle = req.body?.handle || req.body?.displayName || req.user?.handle;
      const options = await passkeys.beginRegister({
        user: req.user || (handle ? store.getUserByHandle(handle) : null),
        handle,
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
      await establishSession(res, store, config, result.user);
      res.json({ ...sessionPayload(result.user) });
    }),
  );

  router.post(
    '/passkey/login/begin',
    asyncHandler(async (req, res) => {
      const handle = req.body?.handle;
      const options = await passkeys.beginLogin({
        user: handle ? store.getUserByHandle(handle) : null,
        handle,
      });
      res.json({ ...options, publicKey: options, rpName: config.rpName, nfp: true });
    }),
  );

  router.post(
    '/passkey/login/finish',
    asyncHandler(async (req, res) => {
      const result = await passkeys.finishLogin({ body: req.body });
      await establishSession(res, store, config, result.user);
      res.json({ ...sessionPayload(result.user) });
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
      await establishSession(res, store, config, user);
      res.json({ ...sessionPayload(store.getUser(user.id)) });
    }),
  );

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
      if (!config.allowDevLogin) {
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
      await establishSession(res, store, config, user);
      res.json({ ok: true, user: publicUser(user), identity: publicIdentity(user), nfp: true, dev: true });
    }),
  );

  router.get('/session', requireAuth, (req, res) => {
    res.json({ ok: true, user: req.publicUser, identity: publicIdentity(req.user), nfp: true });
  });

  return router;
}

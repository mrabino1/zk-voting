// NOT FOR PROFIT — civic public good, not a commercial product.

import { Router } from 'express';

import { asyncHandler, HttpError } from '../http.mjs';
import { establishSession, destroySession, requireAuth, publicUser } from '../auth.mjs';
import { isRole } from '../roles.mjs';

export function authRouter(deps) {
  const { store, config, passkeys } = deps;
  const router = Router();

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
      res.json({ ok: true, verified: true, user: publicUser(result.user), nfp: true });
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
      res.json({ ok: true, verified: true, user: publicUser(result.user), nfp: true });
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
      res.json({ ok: true, user: publicUser(user), nfp: true, dev: true });
    }),
  );

  router.get('/session', requireAuth, (req, res) => {
    res.json({ ok: true, user: req.publicUser, nfp: true });
  });

  return router;
}

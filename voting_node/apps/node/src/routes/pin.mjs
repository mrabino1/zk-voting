// NOT FOR PROFIT — civic public good, not a commercial product.
// Vote PIN setup, change, forgot (email MFA), and ballot verify token.

import { Router } from 'express';

import { requireAuth, publicUser } from '../auth.mjs';
import { asyncHandler, HttpError } from '../http.mjs';
import { normalizeEmail, publicIdentity, resolveEmailLoginPerson, userEmail } from '../identity.mjs';

export function pinRouter(deps) {
  const { store, mfa, pin } = deps;
  const router = Router();

  function identityPayload(user) {
    return {
      nfp: true,
      ok: true,
      user: publicUser(user),
      identity: publicIdentity(user),
    };
  }

  router.post(
    '/me/pin/keypad',
    requireAuth,
    asyncHandler(async (req, res) => {
      const purpose = String(req.body?.purpose || 'setup');
      const issued = pin.issueKeypad({ userId: req.user.id, purpose });
      res.json({ nfp: true, ...issued });
    }),
  );

  router.post(
    '/me/pin',
    requireAuth,
    asyncHandler(async (req, res) => {
      const user = await pin.setPersonPin(req.user, {
        pin: req.body?.pin,
        currentPin: req.body?.currentPin,
        confirmPin: req.body?.confirmPin,
      });
      res.json(identityPayload(store.getUser(user.id)));
    }),
  );

  router.post(
    '/me/pin/verify',
    requireAuth,
    asyncHandler(async (req, res) => {
      const purpose = String(req.body?.purpose || 'vote');
      const result = await pin.verifyPersonPin(req.user, {
        pin: req.body?.pin,
        purpose,
      });
      res.json({
        nfp: true,
        ok: true,
        ...result,
        identity: publicIdentity(store.getUser(req.user.id)),
      });
    }),
  );

  router.post(
    '/me/pin/forgot',
    requireAuth,
    asyncHandler(async (req, res) => {
      const email = userEmail(req.user);
      if (!email) {
        throw new HttpError(400, 'bind an email before resetting a vote PIN', {
          code: 'EMAIL_REQUIRED',
        });
      }
      const payload = await mfa.startMfa(res, {
        user: req.user,
        factor: 'email',
        email,
        purpose: 'pin-reset',
      });
      res.json({ ...payload, pinReset: true });
    }),
  );

  router.post(
    '/pin/forgot',
    asyncHandler(async (req, res) => {
      const email = normalizeEmail(req.body?.email);
      const user = resolveEmailLoginPerson(store, email);
      if (!user) {
        throw new HttpError(404, 'unknown credential', { code: 'UNKNOWN_CREDENTIAL' });
      }
      const payload = await mfa.startMfa(res, {
        user,
        factor: 'email',
        email,
        purpose: 'pin-reset',
      });
      res.json({ ...payload, pinReset: true });
    }),
  );

  return router;
}

// NOT FOR PROFIT — civic public good, not a commercial product.
// Public pages + clerk CMS. Fork the Node; settle on the one shared rollup contract.

import { Router } from 'express';

import { requireAuth, requireAnyJurisdictionRole } from '../auth.mjs';
import {
  SHARED_DEPLOYMENT_NOTE,
  canEditSiteIdentity,
  canManagePages,
  navItemsFromPages,
  pageSummary,
  publicPage,
  publicSiteView,
} from '../cms.mjs';
import { asyncHandler, HttpError } from '../http.mjs';
import { uuidParam } from '../recordIds.mjs';
import { isPlatformOperator } from '../roles.mjs';

function clerkJurisdictions(store, user) {
  const all = store.listJurisdictions();
  if (!user) return [];
  if (isPlatformOperator(user)) return all;
  const ids = new Set(
    store
      .listJurisdictionRolesForUser(user)
      .filter((g) => g.role === 'clerk')
      .map((g) => g.jurisdictionId),
  );
  return all.filter((j) => ids.has(j.id));
}

function assertCanManage(store, user, page) {
  if (!canManagePages(store, user, page)) {
    throw new HttpError(403, 'forbidden', { role: user?.role || null });
  }
}

export function pagesRouter(deps) {
  const { store, config } = deps;
  const router = Router();
  router.param('id', uuidParam('id'));

  function publicBundle() {
    const site = store.getSite();
    const published = store.listPages({ publishedOnly: true }).map(publicPage);
    return {
      nfp: true,
      sharedDeployment: true,
      note: SHARED_DEPLOYMENT_NOTE,
      site: publicSiteView(site, config),
      pages: published,
      nav: navItemsFromPages(published),
      overlays: {
        home: publicPage(store.overlayPage('home')),
        about: publicPage(store.overlayPage('about')),
        faq: publicPage(store.overlayPage('faq')),
      },
    };
  }

  router.get(
    '/pages',
    asyncHandler(async (_req, res) => {
      res.json(publicBundle());
    }),
  );

  router.get(
    '/pages/:slug',
    asyncHandler(async (req, res) => {
      const page = store.getPage(req.params.slug);
      if (!page || page.status !== 'published') throw new HttpError(404, 'page not found');
      res.json({ nfp: true, page: publicPage(page) });
    }),
  );

  router.get(
    '/site',
    asyncHandler(async (_req, res) => {
      res.json(publicSiteView(store.getSite(), config));
    }),
  );

  router.get(
    '/office/site',
    requireAuth,
    requireAnyJurisdictionRole(store, 'clerk'),
    asyncHandler(async (req, res) => {
      const site = store.getSite();
      res.json({
        nfp: true,
        site: publicSiteView(site, config),
        raw: site,
        canEditSite: canEditSiteIdentity(req.user),
        note: SHARED_DEPLOYMENT_NOTE,
      });
    }),
  );

  router.patch(
    '/office/site',
    requireAuth,
    requireAnyJurisdictionRole(store, 'clerk'),
    asyncHandler(async (req, res) => {
      const patch = { ...req.body };
      if (!canEditSiteIdentity(req.user)) {
        throw new HttpError(403, 'only a platform admin or platform super admin can change the site title and tagline');
      }
      if (patch.contracts != null) {
        throw new HttpError(400, 'contract addresses are not set here: the rollup address comes from ROLLUP_ADDRESS on the host', {
          code: 'CONTRACTS_FROM_ENV',
        });
      }
      const site = await store.updateSite(
        {
          title: patch.title,
          tagline: patch.tagline,
        },
        req.user,
      );
      res.json({
        nfp: true,
        ok: true,
        site: publicSiteView(site, config),
        canEditSite: canEditSiteIdentity(req.user),
        note: SHARED_DEPLOYMENT_NOTE,
      });
    }),
  );

  router.get(
    '/office/pages',
    requireAuth,
    requireAnyJurisdictionRole(store, 'clerk'),
    asyncHandler(async (req, res) => {
      const pages = store
        .listPages()
        .filter((p) => canManagePages(store, req.user, p))
        .map(pageSummary);
      res.json({
        nfp: true,
        pages,
        jurisdictions: clerkJurisdictions(store, req.user).map((j) => ({
          id: j.id,
          name: j.name,
        })),
        canEditSite: canEditSiteIdentity(req.user),
        note: SHARED_DEPLOYMENT_NOTE,
      });
    }),
  );

  router.post(
    '/office/pages',
    requireAuth,
    requireAnyJurisdictionRole(store, 'clerk'),
    asyncHandler(async (req, res) => {
      const intended = {
        jurisdictionId: req.body?.jurisdictionId ? String(req.body.jurisdictionId) : null,
      };
      assertCanManage(store, req.user, intended);
      const page = await store.createPage(req.body || {}, req.user);
      res.status(201).json({ nfp: true, ok: true, page });
    }),
  );

  router.get(
    '/office/pages/:id',
    requireAuth,
    requireAnyJurisdictionRole(store, 'clerk'),
    asyncHandler(async (req, res) => {
      const page = store.getPage(req.params.id);
      if (!page) throw new HttpError(404, 'page not found');
      assertCanManage(store, req.user, page);
      res.json({ nfp: true, page });
    }),
  );

  router.patch(
    '/office/pages/:id',
    requireAuth,
    requireAnyJurisdictionRole(store, 'clerk'),
    asyncHandler(async (req, res) => {
      const page = store.getPage(req.params.id);
      if (!page) throw new HttpError(404, 'page not found');
      assertCanManage(store, req.user, page);
      if (req.body?.jurisdictionId !== undefined) {
        const next = {
          jurisdictionId: req.body.jurisdictionId ? String(req.body.jurisdictionId) : null,
        };
        assertCanManage(store, req.user, next);
      }
      const updated = await store.updatePage(req.params.id, req.body || {}, req.user);
      res.json({ nfp: true, ok: true, page: updated });
    }),
  );

  router.delete(
    '/office/pages/:id',
    requireAuth,
    requireAnyJurisdictionRole(store, 'clerk'),
    asyncHandler(async (req, res) => {
      const page = store.getPage(req.params.id);
      if (!page) throw new HttpError(404, 'page not found');
      assertCanManage(store, req.user, page);
      await store.deletePage(page.id);
      res.json({ nfp: true, ok: true, id: page.id });
    }),
  );

  return router;
}

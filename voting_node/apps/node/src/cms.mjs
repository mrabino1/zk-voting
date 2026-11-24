// NOT FOR PROFIT — civic public good, not a commercial product.
// Jurisdiction CMS: fork the Node UI; every Node settles on the one shared rollup contract.

import { LEGACY_DEFAULT_NAMES, brandName } from './branding.mjs';
import { isPlatformOperator } from './roles.mjs';

export const SHARED_DEPLOYMENT_NOTE =
  'Fork this Node for a clerk desk. Every jurisdiction settles civic votes on the one ZkVotingRollup contract on L1. Its address comes from ROLLUP_ADDRESS on the host, not from this page; officers update pages here.';

export const PAGE_KINDS = ['home', 'about', 'faq', 'custom'];
export const PAGE_STATUSES = ['draft', 'published'];
export const BLOCK_TYPES = ['heading', 'paragraph', 'faq', 'cta', 'note'];

export const RESERVED_SLUGS = new Set([
  'admin',
  'about',
  'api',
  'app',
  'back-office',
  'e',
  'elections',
  'explorer',
  'faq',
  'feedback',
  'health',
  'home',
  'index',
  'me',
  'monitor',
  'o',
  'office',
  'outcomes',
  'p',
  'pages',
  'proof',
  'public',
  'receipt',
  'register',
  'signin',
  'site',
  'terms',
  'v',
  'vote',
]);

export function defaultSite() {
  return {
    nfp: true,
    sharedDeployment: true,
    // Empty = follow the product name from site admin (Branding).
    title: '',
    tagline: '',
  };
}

export function normalizeSlug(value, { allowReserved = false } = {}) {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  if (!slug) return '';
  if (!allowReserved && RESERVED_SLUGS.has(slug)) return '';
  return slug;
}

export function sanitizeText(value, max = 20000) {
  return String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .trim()
    .slice(0, max);
}

export function sanitizeHref(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  if (s.startsWith('/') && !s.startsWith('//') && !s.includes('\\')) return s.slice(0, 300);
  if (/^https:\/\//i.test(s)) return s.slice(0, 500);
  return '';
}

export function sanitizeBlock(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = BLOCK_TYPES.includes(raw.type) ? raw.type : 'paragraph';
  if (type === 'heading') {
    const text = sanitizeText(raw.text, 200);
    return text ? { type, text } : null;
  }
  if (type === 'paragraph' || type === 'note') {
    const text = sanitizeText(raw.text, 20000);
    return text ? { type, text } : null;
  }
  if (type === 'faq') {
    const q = sanitizeText(raw.q || raw.question, 400);
    const a = sanitizeText(raw.a || raw.answer, 20000);
    return q && a ? { type, q, a } : null;
  }
  if (type === 'cta') {
    const label = sanitizeText(raw.label || raw.text, 80);
    const href = sanitizeHref(raw.href);
    return label && href ? { type, label, href } : null;
  }
  return null;
}

export function sanitizeBlocks(list) {
  if (!Array.isArray(list)) return [];
  return list.map(sanitizeBlock).filter(Boolean).slice(0, 80);
}

export function normalizeKind(value) {
  return PAGE_KINDS.includes(value) ? value : 'custom';
}

export function normalizeStatus(value) {
  return PAGE_STATUSES.includes(value) ? value : 'draft';
}

export function pageSlugForKind(kind, slug) {
  if (kind === 'home') return 'home';
  if (kind === 'about') return 'about';
  if (kind === 'faq') return 'faq';
  return normalizeSlug(slug);
}

export function publicPathForPage(page) {
  if (!page) return '/';
  if (page.kind === 'home' || page.slug === 'home') return '/';
  if (page.kind === 'about' || page.slug === 'about') return '/about';
  if (page.kind === 'faq' || page.slug === 'faq') return '/faq';
  return `/p/${page.slug}`;
}

export function publicPage(page) {
  if (!page) return null;
  return {
    id: page.id,
    slug: page.slug,
    kind: page.kind,
    title: page.title,
    status: page.status,
    navLabel: page.navLabel || page.title,
    showInNav: Boolean(page.showInNav),
    replaceBuiltin: Boolean(page.replaceBuiltin),
    jurisdictionId: page.jurisdictionId || null,
    blocks: Array.isArray(page.blocks) ? page.blocks : [],
    updatedAt: page.updatedAt || null,
    path: publicPathForPage(page),
  };
}

export function pageSummary(page) {
  if (!page) return null;
  return {
    id: page.id,
    slug: page.slug,
    kind: page.kind,
    title: page.title,
    status: page.status,
    navLabel: page.navLabel || page.title,
    showInNav: Boolean(page.showInNav),
    jurisdictionId: page.jurisdictionId || null,
    updatedAt: page.updatedAt || null,
    path: publicPathForPage(page),
  };
}

export function canManagePages(store, user, page) {
  if (!user) return false;
  if (isPlatformOperator(user)) return true;
  if (page?.jurisdictionId) {
    return store.userHasJurisdictionRole(user, ['clerk'], page.jurisdictionId);
  }
  // Unscoped About / FAQ / home overlays are host copy. A clerk of one
  // body on a shared Node must not rewrite the public record for every body.
  return false;
}

/** The one L1 contract this Node settles on. Read-only: it comes from the host env. */
export function publicRollupView(config) {
  const rollup = config?.rollup || null;
  return {
    sharedDeployment: true,
    configured: Boolean(rollup?.address && rollup?.l1Rpc),
    address: rollup?.address || null,
    chainId: rollup?.chainId ?? null,
    jurisdictionId: rollup?.jurisdictionId || null,
    note: SHARED_DEPLOYMENT_NOTE,
  };
}

export function publicSiteView(site, config) {
  const row = site || defaultSite();
  return {
    nfp: true,
    title: (row.title && !LEGACY_DEFAULT_NAMES.includes(row.title) && row.title) || brandName(),
    tagline: row.tagline || '',
    sharedDeployment: true,
    rollup: publicRollupView(config),
    note: SHARED_DEPLOYMENT_NOTE,
    updatedAt: row.updatedAt || null,
  };
}

/** Site title and tagline are host copy shared by every body on this Node. */
export function canEditSiteIdentity(user) {
  return isPlatformOperator(user);
}

export function navItemsFromPages(pages) {
  return (pages || [])
    .filter((p) => p && p.showInNav && p.kind === 'custom' && p.status === 'published' && p.slug)
    .map((p) => ({
      href: publicPathForPage(p),
      label: p.navLabel || p.title || p.slug,
    }));
}

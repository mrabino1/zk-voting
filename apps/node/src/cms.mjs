// NOT FOR PROFIT — civic public good, not a commercial product.
// Jurisdiction CMS: fork the Node UI; pin one shared contract deployment.

export const SHARED_DEPLOYMENT_NOTE =
  'Fork this Node for a clerk desk. Do not deploy a new ElectionFactory for each jurisdiction. Pin the one shared factory, inbox, and verifier; officers update pages here like a WordPress site.';

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
    title: 'Republic',
    tagline: '',
    contracts: {
      factory: '',
      ballotInbox: '',
      verifier: '',
    },
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
  if (user.role === 'platform_admin') return true;
  if (page?.jurisdictionId) {
    return store.userHasJurisdictionRole(user, ['clerk'], page.jurisdictionId);
  }
  return store.userHasAnyJurisdictionRole(user, ['clerk']);
}

export function envContractsOf(config) {
  if (config?.envContracts) return config.envContracts;
  return {
    factory: config?.electionFactoryAddress || '',
    ballotInbox: config?.ballotInboxAddress || '',
    verifier: config?.verifierAddress || '',
  };
}

/** Snapshot env addresses, then fill blanks from the site pin (forked Node, one factory). */
export function applySiteContractPins(config, site) {
  if (!config.envContracts) {
    config.envContracts = {
      factory: config.electionFactoryAddress || '',
      ballotInbox: config.ballotInboxAddress || '',
      verifier: config.verifierAddress || '',
    };
  }
  const env = config.envContracts;
  const stored = site?.contracts || {};
  config.electionFactoryAddress = env.factory || stored.factory || '';
  config.ballotInboxAddress = env.ballotInbox || stored.ballotInbox || '';
  config.verifierAddress = env.verifier || stored.verifier || '';
  return config;
}

export function mergePublicContracts(config, site) {
  const env = envContractsOf(config);
  const stored = site?.contracts || {};
  const factory = env.factory || stored.factory || '';
  const ballotInbox = env.ballotInbox || stored.ballotInbox || '';
  const verifier = env.verifier || stored.verifier || '';
  return {
    sharedDeployment: true,
    chainId: config.chainId,
    factory,
    ballotInbox,
    verifier,
    source: env.factory ? 'env' : stored.factory ? 'site' : 'unset',
    pinnedByEnv: {
      factory: Boolean(env.factory),
      ballotInbox: Boolean(env.ballotInbox),
      verifier: Boolean(env.verifier),
    },
    note: SHARED_DEPLOYMENT_NOTE,
  };
}

export function publicSiteView(site, config) {
  const row = site || defaultSite();
  return {
    nfp: true,
    title: row.title || 'Republic',
    tagline: row.tagline || '',
    sharedDeployment: true,
    contracts: mergePublicContracts(config, row),
    note: SHARED_DEPLOYMENT_NOTE,
    updatedAt: row.updatedAt || null,
  };
}

export function canPinContracts(user) {
  return Boolean(user && user.role === 'platform_admin');
}

export function sanitizeAddress(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  if (!/^0x[a-fA-F0-9]{40}$/.test(s)) return null;
  return s;
}

export function navItemsFromPages(pages) {
  return (pages || [])
    .filter((p) => p && p.showInNav && p.kind === 'custom' && p.status === 'published' && p.slug)
    .map((p) => ({
      href: publicPathForPage(p),
      label: p.navLabel || p.title || p.slug,
    }));
}

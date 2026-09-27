/**
 * NOT FOR PROFIT — Republic is a civic public good. Not a commercial product.
 * Session-aware audience: public (logged-out), registered voter, voting admin.
 */

import { t } from "./i18n.js";

export const OFFICER_ROLES = [
  "clerk",
  "registrar",
  "disqualification_officer",
  "tally_operator",
];

export function normalizeRole(role) {
  return String(role || "").toLowerCase();
}

export function isOfficerRoleName(role) {
  return OFFICER_ROLES.includes(normalizeRole(role));
}

export function meUser(me) {
  if (!me) return null;
  return me.user || (me.id && me.handle ? me : null);
}

export function isOfficer(me) {
  if (me?.officer === true) return true;
  const user = meUser(me);
  if (!user) return false;
  const role = normalizeRole(user.role);
  if (role === "platform_admin" || role === "platform_super_admin") return true;
  if (OFFICER_ROLES.includes(role)) return true;
  const grants = me?.jurisdictionRoles || me?.me?.jurisdictionRoles || user.jurisdictionRoles || [];
  if (grants.some((g) => isOfficerRoleName(g?.role))) return true;
  const roles = me?.roles || user.roles || [];
  return roles.some((r) => {
    const n = normalizeRole(r);
    return n === "platform_admin" || n === "platform_super_admin" || OFFICER_ROLES.includes(n);
  });
}

export function audienceOf(me) {
  if (me?.audience === "public" || me?.audience === "registered" || me?.audience === "officer") {
    return me.audience;
  }
  const user = meUser(me);
  if (!user) return "public";
  return isOfficer(me) ? "officer" : "registered";
}

export function homeDestination(audience) {
  return audience === "public" ? "/" : "/me";
}

export function brandHref(audience) {
  return homeDestination(audience);
}

export function canonicalPublicPath(pathname) {
  let raw = String(pathname || "");
  let search = "";
  let hash = "";
  const hashAt = raw.indexOf("#");
  if (hashAt !== -1) {
    hash = raw.slice(hashAt);
    raw = raw.slice(0, hashAt);
  }
  const qAt = raw.indexOf("?");
  if (qAt !== -1) {
    search = raw.slice(qAt);
    raw = raw.slice(0, qAt);
  }
  raw = raw.replace(/\.html$/i, "");
  if (!raw || raw === "/index") raw = "/";
  else raw = raw.replace(/\/+$/, "") || "/";
  return `${raw}${search}${hash}`;
}

export function safeNextPath(value) {
  if (value == null || value === "") return null;
  let path = String(value);
  try {
    path = decodeURIComponent(path);
  } catch {
    /* keep raw */
  }
  if (!path.startsWith("/") || path.startsWith("//") || /[a-z]+:/i.test(path)) return null;
  if (path.includes("\\")) return null;
  return canonicalPublicPath(path);
}

export function postLoginPath(me, next) {
  const safe = safeNextPath(next);
  if (!safe) return "/me";
  if (isOfficePath(safe) && !isOfficer(me)) return "/me";
  return safe;
}

export function signInHref(next) {
  const safe = safeNextPath(next);
  if (!safe) return "/signin";
  return `/signin?next=${encodeURIComponent(safe)}`;
}

export function mainNav(audience, extraNav = [], options = {}) {
  const extra = Array.isArray(extraNav) ? extraNav.filter((i) => i && i.href && i.label) : [];
  const polls = options && options.pollsEnabled ? [{ href: "/polls", label: t("polls.nav") }] : [];
  if (audience === "public") {
    return [
      { href: "/about", label: t("chrome.navAbout") },
      { href: "/faq", label: t("chrome.navFaq") },
      { href: "/receipt", label: t("chrome.navReceipt") },
      { href: "/outcomes", label: t("chrome.navOutcomes") },
      ...polls,
      { href: "/terms", label: t("chrome.navTerms") },
      ...extra,
      { href: "/signin", label: t("chrome.navSignIn") },
      { href: "/register", label: t("chrome.navRegister") },
    ];
  }
  const items = [
    { href: "/me", label: t("chrome.navDesk") },
    { href: "/register", label: t("chrome.navRegister") },
    { href: "/elections", label: t("chrome.navResults") },
    ...polls,
    { href: "/receipt", label: t("chrome.navReceipt") },
    { href: "/outcomes", label: t("chrome.navOutcomes") },
    { href: "/terms", label: t("chrome.navTerms") },
  ];
  if (audience === "officer") {
    items.push({ href: "/office", label: t("chrome.navAdmin") });
  }
  return items;
}

function currentPathOf(currentPath) {
  return String(currentPath || "/").replace(/\/+$/, "") || "/";
}

export function navItemIsCurrent(item, currentPath, routeName) {
  const path = currentPathOf(currentPath);
  const href = String(item.href || "").split("?")[0];
  if (href === path) return true;
  if (href === "/me" && (routeName === "desk" || routeName === "app")) return true;
  if (href === "/office" && String(routeName || "").startsWith("office")) return true;
  if (href === "/about" && routeName === "about") return true;
  if (href === "/faq" && routeName === "faq") return true;
  if (href === "/terms" && routeName === "terms") return true;
  if (href === "/receipt" && routeName === "receipt") return true;
  if (href === "/outcomes" && (routeName === "outcomes" || routeName === "outcome" || routeName === "outcomeVerify")) return true;
  if (href.startsWith("/p/") && path === href) return true;
  if (href === "/signin" && routeName === "signin") return true;
  if (href === "/register" && routeName === "register") return true;
  if (href === "/elections" && (routeName === "results" || routeName === "resultsIndex")) return true;
  if (href === "/polls" && (path === "/polls" || path.startsWith("/polls/"))) return true;
  return false;
}

export function paintMainNav(nav, { audience, currentPath, routeName, spa = true, extraNav = [], pollsEnabled = false } = {}) {
  if (!nav) return;
  const items = mainNav(audience || "public", extraNav, { pollsEnabled });
  const existing = [...nav.querySelectorAll(":scope > ul > li > a")];
  const unchanged =
    existing.length === items.length &&
    items.every((item, i) => {
      const a = existing[i];
      const current = navItemIsCurrent(item, currentPath, routeName);
      return (
        a.getAttribute("href") === item.href &&
        a.textContent === item.label &&
        (a.getAttribute("aria-current") === "page") === current &&
        a.hasAttribute("data-nav") === spa
      );
    });
  if (unchanged) return;
  const ul = document.createElement("ul");
  for (const item of items) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = item.href;
    a.textContent = item.label;
    if (spa) a.setAttribute("data-nav", "");
    if (navItemIsCurrent(item, currentPath, routeName)) a.setAttribute("aria-current", "page");
    li.append(a);
    ul.append(li);
  }
  nav.replaceChildren(ul);
}

export function paintBrand(brand, audience) {
  if (!brand) return;
  brand.setAttribute("href", brandHref(audience));
}

export function applyAudienceChrome(root, options) {
  const doc = root?.ownerDocument || (typeof document !== "undefined" ? document : null);
  if (!doc) return;
  paintMainNav(doc.querySelector(".nav-main"), options);
  paintBrand(doc.querySelector("a.brand"), options.audience);
}

export const OFFICE_PATHS = ["/admin", "/back-office", "/office"];

export function isOfficePath(pathname) {
  const path = canonicalPublicPath(currentPathOf(pathname));
  return OFFICE_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
}

/** Multi-page HTML (not the voter SPA). Use a full load, not history.pushState. */
export function isStandaloneHtmlPath(pathname) {
  const path = canonicalPublicPath(currentPathOf(pathname));
  return (
    path === "/admin" ||
    path.startsWith("/admin/") ||
    path === "/back-office" ||
    path.startsWith("/back-office/") ||
    path === "/explorer" ||
    path.startsWith("/explorer/")
  );
}

/**
 * NOT FOR PROFIT — Republic is a civic public good. Not a commercial product.
 * Session-aware header nav for multi-page HTML (admin, back-office, explorer).
 */

import { applyAudienceChrome, audienceOf } from "./audience.js";
import { LOCALE_EVENT } from "./i18n.js";
import { SESSION_EVENT, loadAuthState } from "./signin.js";

async function extraNav() {
  try {
    const res = await fetch("/api/pages", { credentials: "same-origin", headers: { Accept: "application/json" } });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.nav) ? data.nav : [];
  } catch {
    return [];
  }
}

async function pollsEnabled() {
  try {
    const res = await fetch("/api/config", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return false;
    const data = await res.json();
    return Boolean(data && data.pollsEnabled);
  } catch {
    return false;
  }
}

async function refresh() {
  const [state, nav, polls] = await Promise.all([loadAuthState(), extraNav(), pollsEnabled()]);
  const audience = state.audience || audienceOf(state.me || { user: state.user, jurisdictionRoles: state.jurisdictionRoles });
  applyAudienceChrome(document, {
    audience,
    currentPath: window.location.pathname.replace(/\.html$/i, "") || "/",
    spa: false,
    extraNav: nav,
    pollsEnabled: polls,
  });
}

if (typeof document !== "undefined") {
  window.addEventListener(SESSION_EVENT, refresh);
  window.addEventListener(LOCALE_EVENT, refresh);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", refresh);
  } else {
    refresh();
  }
}

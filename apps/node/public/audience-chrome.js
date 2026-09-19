/**
 * NOT FOR PROFIT — Republic is a civic public good. Not a commercial product.
 * Session-aware header nav for multi-page HTML (admin, back-office, explorer).
 */

import { applyAudienceChrome, audienceOf } from "./audience.js";
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

async function refresh() {
  const [state, nav] = await Promise.all([loadAuthState(), extraNav()]);
  const audience = state.audience || audienceOf(state.me || { user: state.user, jurisdictionRoles: state.jurisdictionRoles });
  applyAudienceChrome(document, {
    audience,
    currentPath: window.location.pathname.replace(/\.html$/i, "") || "/",
    spa: false,
    extraNav: nav,
  });
}

if (typeof document !== "undefined") {
  window.addEventListener(SESSION_EVENT, refresh);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", refresh);
  } else {
    refresh();
  }
}

/**
 * NOT FOR PROFIT — Republic is a civic public good. Not a commercial product.
 * Session-aware header nav for multi-page HTML (admin, back-office, explorer).
 */

import { applyAudienceChrome, audienceOf } from "./audience.js";
import { SESSION_EVENT, loadAuthState } from "./signin.js";

async function refresh() {
  const state = await loadAuthState();
  const audience = state.audience || audienceOf(state.me || { user: state.user, jurisdictionRoles: state.jurisdictionRoles });
  applyAudienceChrome(document, {
    audience,
    currentPath: window.location.pathname,
    spa: false,
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

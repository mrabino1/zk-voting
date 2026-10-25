/**
 * NOT FOR PROFIT — ZK-Voting is a civic public good. Not a commercial product.
 * Gate /admin and /back-office: unauthenticated visitors are redirected by the
 * Node; signed-in non-officers see a lock screen instead of the workbench.
 */

import { applyAudienceChrome, isOfficer, signInHref } from "./audience.js";
import { LOCALE_EVENT } from "./i18n.js";
import { SESSION_EVENT, loadAuthState, logout } from "./signin.js";

function show(el, on) {
  if (!el) return;
  el.hidden = !on;
}

async function refresh() {
  const state = await loadAuthState();
  const me = state.me || { user: state.user, jurisdictionRoles: state.jurisdictionRoles };
  const audience = state.audience || (state.user ? (isOfficer(me) ? "officer" : "registered") : "public");
  applyAudienceChrome(document, {
    audience,
    currentPath: window.location.pathname.replace(/\.html$/i, "") || "/",
    spa: false,
  });

  const gate = document.getElementById("officer-gate");
  const work = document.getElementById("office-work");
  const copy = document.getElementById("officer-gate-copy");

  if (!state.user) {
    window.location.replace(signInHref(`${window.location.pathname}${window.location.hash || ""}`));
    return;
  }

  if (!isOfficer(me)) {
    if (copy) {
      copy.textContent = `Signed in as ${state.user.handle} (${state.user.role}). Voting admin is for clerks, registrars, disqualification officers, tally operators, and the platform host.`;
    }
    show(gate, true);
    show(work, false);
    return;
  }

  show(gate, false);
  show(work, true);
}

function wireGateActions() {
  const signOut = document.getElementById("officer-gate-signout");
  if (signOut) {
    signOut.addEventListener("click", async () => {
      signOut.disabled = true;
      try {
        await logout();
      } catch {
        signOut.disabled = false;
      }
    });
  }
}

export function bootOfficeGate() {
  wireGateActions();
  window.addEventListener(SESSION_EVENT, refresh);
  window.addEventListener(LOCALE_EVENT, refresh);
  refresh();
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootOfficeGate);
  } else {
    bootOfficeGate();
  }
}

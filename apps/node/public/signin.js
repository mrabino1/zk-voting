/**
 * NOT FOR PROFIT — Republic is a civic public good. Not a commercial product.
 * Shared Sign in chrome: passkey (DFC-style discoverable WebAuthn) and
 * Sign in with Ethereum. Dev login is a gated local fallback only.
 */

import { loginPasskey, hasWebAuthn, webAuthnUnavailableMessage } from "./passkey-wallet.js";
import { loginWeb3Wallet } from "./identity-methods.js";
import { t, LOCALE_EVENT } from "./i18n.js";

export const SESSION_EVENT = "republic:session";

export async function fetchJson(path, options = {}) {
  const headers = {
    Accept: "application/json",
    ...(options.body != null ? { "Content-Type": "application/json" } : {}),
    ...(options.headers || {}),
  };
  const res = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers,
    body:
      options.body == null || typeof options.body === "string"
        ? options.body
        : JSON.stringify(options.body),
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!res.ok) {
    const err = new Error(data?.error || data?.message || res.statusText || t("common.requestFailed"));
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export async function loadAuthState() {
  const [me, config] = await Promise.all([
    fetchJson("/api/me").catch(() => ({ user: null, identity: null })),
    fetchJson("/api/config").catch(() => ({ auth: {} })),
  ]);
  return {
    user: me?.user || null,
    identity: me?.identity || null,
    allowDevLogin: Boolean(config?.auth?.allowDevLogin),
    config,
  };
}

export function notifySession(detail) {
  window.dispatchEvent(new CustomEvent(SESSION_EVENT, { detail: detail || {} }));
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === "class" || key === "className") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "dataset") Object.assign(node.dataset, value);
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function panelOptions(root) {
  const headingKey = root.getAttribute("data-heading-key");
  const ledeKey = root.getAttribute("data-lede-key");
  return {
    heading: headingKey ? t(headingKey) : root.getAttribute("data-heading") || t("signin.heading"),
    lede: ledeKey ? t(ledeKey) : root.getAttribute("data-lede") || t("signin.ledeDefault"),
    devHandle: root.getAttribute("data-dev-handle") || "",
    devRole: root.getAttribute("data-dev-role") || "",
    compact: root.getAttribute("data-compact") === "true",
  };
}

function setStatus(node, kind, message) {
  if (!node) return;
  node.hidden = !message;
  node.className = "flash show " + (kind || "");
  node.textContent = message || "";
  if (!message) node.className = "flash";
}

export async function logout() {
  await fetchJson("/api/auth/logout", { method: "POST", body: {} });
  notifySession({ user: null });
}

export async function signInWithPasskey(handle) {
  const result = await loginPasskey({ api: fetchJson, handle });
  notifySession({ user: result.user, identity: result.identity, method: "passkey" });
  return result;
}

export async function signInWithEthereum() {
  const result = await loginWeb3Wallet(fetchJson);
  notifySession({ user: result.user, identity: result.identity, method: "web3" });
  return result;
}

export async function signInDev({ handle, role }) {
  const result = await fetchJson("/api/auth/dev-login", {
    method: "POST",
    body: { handle, ...(role ? { role } : {}) },
  });
  notifySession({ user: result.user, identity: result.identity, method: "dev" });
  return result;
}

function renderSignedIn(state) {
  const user = state.user;
  return el(
    "div",
    { class: "sign-in-signed" },
    el("p", {
      class: "session-line",
      text: `${user.handle} · ${user.role}${
        user.activeEthAddress ? ` · ${user.activeEthAddress.slice(0, 10)}…` : ""
      }`,
    }),
    el(
      "div",
      { class: "sign-in-actions" },
      el("button", {
        class: "btn btn-secondary",
        type: "button",
        text: t("signin.signOut"),
        onClick: async (event) => {
          const btn = event.currentTarget;
          btn.disabled = true;
          try {
            await logout();
          } catch (err) {
            btn.disabled = false;
            throw err;
          }
        },
      })
    )
  );
}

function renderForm(state, opts, statusEl) {
  const webauthn = hasWebAuthn();
  const busy = Boolean(state.busy);
  return el(
    "div",
    { class: "sign-in-form" },
    el("p", {
      class: "field-hint",
      text: opts.lede,
    }),
    !webauthn ? el("p", { class: "field-hint", text: webAuthnUnavailableMessage() }) : null,
    el(
      "div",
      { class: "sign-in-actions" },
      el("button", {
        class: "btn",
        type: "button",
        "data-signin": "passkey",
        disabled: busy || !webauthn,
        "aria-busy": busy && state.busy === "passkey" ? "true" : "false",
        text: state.busy === "passkey" ? t("signin.waitingPasskey") : t("signin.passkey"),
        onClick: () => runAction(state, statusEl, "passkey", () => signInWithPasskey(state.handle)),
      }),
      el("button", {
        class: "btn",
        type: "button",
        "data-signin": "wallet",
        disabled: busy,
        "aria-busy": busy && state.busy === "wallet" ? "true" : "false",
        text: state.busy === "wallet" ? t("signin.waitingWallet") : t("signin.ethereum"),
        onClick: () => runAction(state, statusEl, "wallet", () => signInWithEthereum()),
      })
    ),
    el(
      "details",
      { class: "sign-in-handle" },
      el("summary", { text: t("signin.handleOptional") }),
      el("p", {
        class: "field-hint",
        text: t("signin.handleHelp"),
      }),
      el("label", { class: "field-label", for: "signin-handle", text: t("signin.handle") }),
      el("input", {
        id: "signin-handle",
        name: "handle",
        type: "text",
        autocomplete: "username webauthn",
        value: state.handle || "",
        onInput: (event) => {
          state.handle = event.target.value;
        },
      })
    ),
    state.allowDevLogin
      ? el(
          "details",
          { class: "sign-in-dev" },
          el("summary", { text: t("signin.devSummary") }),
          el("p", {
            class: "field-hint",
            text: t("signin.devHelp"),
          }),
          el(
            "form",
            {
              class: "form-grid",
              onSubmit: (event) => {
                event.preventDefault();
                const handle = event.target.handle?.value?.trim();
                runAction(state, statusEl, "dev", () =>
                  signInDev({ handle, role: opts.devRole || undefined })
                );
              },
            },
            el(
              "div",
              { class: "field" },
              el("label", { class: "field-label", for: "signin-dev-handle", text: t("signin.handle") }),
              el("input", {
                id: "signin-dev-handle",
                name: "handle",
                value: opts.devHandle || "",
                autocomplete: "username",
              })
            ),
            el(
              "div",
              { class: "actions" },
              el("button", { class: "btn btn-secondary", type: "submit", text: t("signin.devSubmit") })
            )
          )
        )
      : null
  );
}

async function runAction(state, statusEl, kind, fn) {
  if (state.busy) return;
  state.busy = kind;
  setStatus(statusEl, "", "");
  state.repaint();
  try {
    const result = await fn();
    const who = result?.user?.handle || t("signin.signIn");
    setStatus(statusEl, "ok", t("signin.signedInAs", { handle: who }));
  } catch (err) {
    const cancelled = /cancel|not allowed|abort/i.test(err.message || "");
    setStatus(
      statusEl,
      "err",
      cancelled ? t("signin.cancelled") : err.message || t("signin.failed")
    );
  } finally {
    state.busy = false;
    await state.reload();
  }
}

let currentPanel = null;

export function mountSignInPanel(root, extra = {}) {
  if (!root) return null;
  if (currentPanel?.destroy) currentPanel.destroy();
  const optsState = { ...panelOptions(root), ...extra };
  const state = {
    user: extra.user || null,
    identity: extra.identity || null,
    allowDevLogin: Boolean(extra.allowDevLogin),
    handle: "",
    busy: false,
    repaint() {},
    async reload() {},
  };

  const headingId = root.id ? `${root.id}-heading` : "signin-heading";
  const statusEl = el("div", { class: "flash", role: "status" });
  const body = el("div", { class: "sign-in-body" });
  const headingEl = el("h2", { id: headingId, text: optsState.heading });
  const section = el(
    "section",
    { class: "panel sign-in-panel", "aria-labelledby": headingId },
    el("header", {}, headingEl),
    body,
    statusEl
  );
  root.replaceChildren(section);

  function paint() {
    Object.assign(optsState, panelOptions(root), extra);
    headingEl.textContent = optsState.heading;
    body.replaceChildren(state.user ? renderSignedIn(state) : renderForm(state, optsState, statusEl));
  }
  state.repaint = paint;

  state.reload = async () => {
    const next = await loadAuthState();
    state.user = next.user;
    state.identity = next.identity;
    state.allowDevLogin = next.allowDevLogin;
    if (!next.user) setStatus(statusEl, "", "");
    paint();
    return next;
  };

  const onSession = () => {
    state.reload();
  };
  const onLocale = () => {
    paint();
  };
  window.addEventListener(SESSION_EVENT, onSession);
  window.addEventListener(LOCALE_EVENT, onLocale);

  state.reload();
  currentPanel = {
    state,
    reload: state.reload,
    destroy: () => {
      window.removeEventListener(SESSION_EVENT, onSession);
      window.removeEventListener(LOCALE_EVENT, onLocale);
    },
  };
  return currentPanel;
}

export function mountSessionChrome(root) {
  if (!root) return null;
  const state = { user: null, busy: false };

  function paint() {
    const user = state.user;
    if (user) {
      root.replaceChildren(
        el("span", { class: "session-chip", text: `${user.handle} · ${user.role}` }),
        el("button", {
          class: "btn btn-secondary session-chrome-btn",
          type: "button",
          text: t("signin.signOut"),
          onClick: async (event) => {
            event.currentTarget.disabled = true;
            try {
              await logout();
            } catch {
              event.currentTarget.disabled = false;
            }
          },
        })
      );
      return;
    }
    const panel = document.getElementById("sign-in-root");
    const href = panel ? `#${panel.id}` : "/#sign-in";
    root.replaceChildren(
      el("a", {
        class: "btn btn-secondary session-chrome-btn",
        href,
        text: t("signin.signIn"),
      })
    );
  }

  async function reload() {
    const next = await loadAuthState();
    state.user = next.user;
    paint();
    return next;
  }

  window.addEventListener(SESSION_EVENT, reload);
  window.addEventListener(LOCALE_EVENT, () => {
    paint();
  });
  reload();
  return { reload };
}

export async function bootSignIn() {
  const header = document.getElementById("session-chrome");
  if (header) mountSessionChrome(header);
  const panel = document.getElementById("sign-in-root");
  if (panel) mountSignInPanel(panel);
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootSignIn);
  } else {
    bootSignIn();
  }
}

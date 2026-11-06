/**
 * NOT FOR PROFIT — ZK-Voting is a civic public good. Not a commercial product.
 * Sign in: email, Ethereum (signature), smart-card reader, driver’s license /
 * passport, passkey. Every path completes with email MFA (AWS SES).
 */

import "./i18n.js";
import { fetchWithStandbyRetry } from "./standby-retry.js";
import {
  loginPasskey,
  hasWebAuthn,
  prepareAssertionCeremony,
  webAuthnErrorMessage,
  webAuthnUnavailableMessage,
} from "./passkey-wallet.js";
import { navigate } from "./router.js";
import {
  isMfaChallenge,
  loginCivicId,
  loginSmartCard,
  loginWeb3Wallet,
  presentSmartCard,
  provideMfaEmail,
  resendMfaCode,
  startEmailLogin,
  verifyMfaCode,
  forgotVotePin,
} from "./identity-methods.js";

export const SESSION_EVENT = "zk-voting:session";

export async function fetchJson(path, options = {}) {
  const headers = {
    Accept: "application/json",
    ...(options.body != null ? { "Content-Type": "application/json" } : {}),
    ...(options.headers || {}),
  };
  const res = await fetchWithStandbyRetry(path, {
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
    const err = new Error(data?.error || data?.message || res.statusText || "Request failed");
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export async function loadAuthState() {
  const [me, config] = await Promise.all([
    fetchJson("/api/me").catch(() => ({ user: null, identity: null, audience: "public", officer: false })),
    fetchJson("/api/config").catch(() => ({ auth: {} })),
  ]);
  return {
    user: me?.user || null,
    identity: me?.identity || null,
    allowDevLogin: Boolean(config?.auth?.allowDevLogin),
    requireEmailMfa: Boolean(config?.auth?.requireEmailMfa),
    allowSmartCardMock: Boolean(config?.auth?.allowSmartCardMock),
    allowCivicIdMock: Boolean(config?.auth?.allowCivicIdMock),
    config,
    me,
    audience: me?.audience || (me?.user ? "registered" : "public"),
    officer: Boolean(me?.officer),
    jurisdictionRoles: me?.jurisdictionRoles || [],
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
  return {
    heading: root.getAttribute("data-heading") || "Sign in",
    lede:
      root.getAttribute("data-lede") ||
      "Sign in with any bound email or passkey, a bound Ethereum wallet, a smart-card reader, or a driver’s license / passport. MFA codes go to your primary email by default (AWS SES). Signing in with a specific email sends the code to that inbox.",
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

function finishOrMfa(state, result, method) {
  if (isMfaChallenge(result)) {
    state.mfa = result;
    return result;
  }
  notifySession({ user: result.user, identity: result.identity, method });
  if (result?.pinResetGranted) navigate("/register");
  return result;
}

export async function signInWithPasskey(handle, state, prepared) {
  const result = await loginPasskey({ api: fetchJson, handle, prepared });
  return finishOrMfa(state, result, "passkey");
}

const loginPrep = {
  key: null,
  prepared: null,
  failedKey: null,
  inflight: null,
  error: "",
};

function loginPrepKey(handle) {
  return String(handle || "").trim();
}

/** The sign-in button stays disabled until the assertion ceremony is prepared. */
export function passkeyLoginControl({
  busy = false,
  webAuthn = true,
  ready = false,
  preparing = false,
  failed = false,
} = {}) {
  if (busy) return { disabled: true, label: "Waiting for passkey…" };
  if (!webAuthn || (!ready && !failed)) {
    return { disabled: true, label: preparing ? "Preparing passkey…" : "Sign in with passkey" };
  }
  return { disabled: false, label: "Sign in with passkey" };
}

function syncPasskeyLoginButton(state) {
  const button = document.querySelector("[data-signin='passkey']");
  if (!button) return;
  const key = loginPrepKey(state.handle);
  const control = passkeyLoginControl({
    busy: state.busy === "passkey",
    webAuthn: hasWebAuthn(),
    ready: Boolean(loginPrep.prepared && loginPrep.key === key),
    preparing: loginPrep.inflight === key,
    failed: Boolean(loginPrep.error && loginPrep.failedKey === key),
  });
  button.disabled = control.disabled;
  button.textContent = control.label;
}

async function prefetchPasskeyLogin(state, { force = false, statusEl } = {}) {
  if (!hasWebAuthn() || state.busy || state.user || state.mfa) return;
  if (state.tab && state.tab !== "passkey") return;
  const key = loginPrepKey(state.handle);
  if (force) {
    loginPrep.failedKey = null;
    loginPrep.error = "";
  }
  if (loginPrep.prepared && loginPrep.key === key) {
    syncPasskeyLoginButton(state);
    return;
  }
  // An empty handle is a real discoverable login, so the idle sentinels
  // cannot be "" — that used to look like a failed prefetch and skip begin.
  if (!force && (loginPrep.failedKey === key || loginPrep.inflight === key)) {
    syncPasskeyLoginButton(state);
    return;
  }
  loginPrep.inflight = key;
  syncPasskeyLoginButton(state);
  let failed = false;
  try {
    const server = await fetchJson("/api/auth/passkey/login/begin", {
      method: "POST",
      body: key ? { handle: key } : {},
    });
    const prepared = await prepareAssertionCeremony(server);
    if (loginPrepKey(state.handle) !== key || (state.tab && state.tab !== "passkey")) return;
    loginPrep.prepared = prepared;
    loginPrep.key = key;
    loginPrep.failedKey = null;
    loginPrep.error = "";
    if (statusEl) setStatus(statusEl, "", "");
  } catch (err) {
    if (loginPrepKey(state.handle) !== key) return;
    loginPrep.prepared = null;
    loginPrep.key = null;
    loginPrep.failedKey = key;
    loginPrep.error = webAuthnErrorMessage(err);
    failed = true;
    if (statusEl) setStatus(statusEl, "err", loginPrep.error);
  } finally {
    if (loginPrep.inflight === key) loginPrep.inflight = null;
  }
  if (failed && statusEl && !loginPrep.error) setStatus(statusEl, "err", "That did not work.");
  syncPasskeyLoginButton(state);
}

export async function signInWithEthereum(state) {
  const result = await loginWeb3Wallet(fetchJson);
  return finishOrMfa(state, result, "web3");
}

export async function signInWithEmail(email, state) {
  const result = await startEmailLogin(fetchJson, email);
  return finishOrMfa(state, result, "email");
}

export async function signInWithSmartCard({ fingerprint, certificate }, state) {
  const result = await loginSmartCard(fetchJson, { fingerprint, certificate });
  return finishOrMfa(state, result, "smart_card");
}

export async function signInWithCivicId({ kind, issuer, documentNumber }, state) {
  const result = await loginCivicId(fetchJson, { kind, issuer, documentNumber });
  return finishOrMfa(state, result, "civic_id");
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
        text: "Sign out",
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

function renderMfa(state, statusEl) {
  const mfa = state.mfa || {};
  const needsEmail = Boolean(mfa.needsEmail);
  return el(
    "div",
    { class: "sign-in-mfa" },
    el("p", {
      class: "field-hint",
      text: needsEmail
        ? mfa.pinReset
          ? "Enter the email that will receive your vote PIN reset code (AWS SES)."
          : "This person has no email on file yet. Enter the address that will receive the sign-in code (AWS SES)."
        : mfa.pinReset
          ? `Enter the 6-digit code sent to ${mfa.emailHint || "your email"} to set a new vote PIN.`
          : `Enter the 6-digit code sent to ${mfa.emailHint || "your email"} (primary unless you signed in with a specific address).`,
    }),
    needsEmail
      ? el(
          "form",
          {
            class: "form-grid",
            onSubmit: (event) => {
              event.preventDefault();
              const email = event.target.email?.value?.trim();
              runAction(state, statusEl, "mfa-email", async () => {
                const result = await provideMfaEmail(fetchJson, email);
                state.mfa = result;
                return result;
              });
            },
          },
          el(
            "div",
            { class: "field" },
            el("label", { class: "field-label", for: "signin-mfa-email", text: "Email" }),
            el("input", {
              id: "signin-mfa-email",
              name: "email",
              type: "email",
              autocomplete: "email",
              required: true,
            })
          ),
          el(
            "div",
            { class: "actions" },
            el("button", { class: "btn", type: "submit", text: "Send code" })
          )
        )
      : el(
          "form",
          {
            class: "form-grid",
            onSubmit: (event) => {
              event.preventDefault();
              const code = event.target.code?.value?.trim();
              runAction(state, statusEl, "mfa", async () => {
                const result = await verifyMfaCode(fetchJson, code);
                state.mfa = null;
                notifySession({ user: result.user, identity: result.identity, method: mfa.factor || "mfa" });
                if (result.pinResetGranted) navigate("/register");
                return result;
              });
            },
          },
          el(
            "div",
            { class: "field" },
            el("label", { class: "field-label", for: "signin-otp", text: "One-time code" }),
            el("input", {
              id: "signin-otp",
              name: "code",
              class: "otp-input",
              inputmode: "numeric",
              autocomplete: "one-time-code",
              maxlength: "6",
              pattern: "[0-9]{6}",
              required: true,
            })
          ),
          el(
            "div",
            { class: "sign-in-actions" },
            el("button", { class: "btn", type: "submit", text: "Verify code" }),
            el("button", {
              class: "btn btn-secondary",
              type: "button",
              text: "Resend code",
              onClick: () =>
                runAction(state, statusEl, "mfa-resend", async () => {
                  const result = await resendMfaCode(fetchJson);
                  state.mfa = result;
                  return result;
                }),
            }),
            el("button", {
              class: "btn btn-secondary",
              type: "button",
              text: "Start over",
              onClick: () => {
                state.mfa = null;
                state.repaint();
              },
            })
          )
        )
  );
}

function renderForm(state, opts, statusEl) {
  const webauthn = hasWebAuthn();
  const busy = Boolean(state.busy);
  const tab = state.tab || "email";
  if (tab === "passkey" && webauthn && !busy) prefetchPasskeyLogin(state, { statusEl });
  const prepKey = loginPrepKey(state.handle);
  const passkeyControl = passkeyLoginControl({
    busy: state.busy === "passkey",
    webAuthn: webauthn,
    ready: Boolean(loginPrep.prepared && loginPrep.key === prepKey),
    preparing: loginPrep.inflight === prepKey,
    failed: Boolean(loginPrep.error && loginPrep.failedKey === prepKey),
  });
  const tabs = [
    { id: "email", label: "Email" },
    { id: "web3", label: "Ethereum" },
    { id: "smart_card", label: "Smart card" },
    { id: "civic_id", label: "License / passport" },
    { id: "passkey", label: "Passkey" },
  ];
  return el(
    "div",
    { class: "sign-in-form" },
    el("p", {
      class: "field-hint",
      text: opts.lede,
    }),
    el(
      "div",
      { class: "method-tabs", role: "tablist", "aria-label": "How you sign in" },
      ...tabs.map((item) =>
        el("button", {
          type: "button",
          role: "tab",
          "aria-selected": tab === item.id ? "true" : "false",
          text: item.label,
          onClick: () => {
            state.tab = item.id;
            state.repaint();
          },
        })
      )
    ),
    tab === "email"
      ? el(
          "div",
          {},
          el(
            "form",
            {
              class: "form-grid",
              onSubmit: (event) => {
                event.preventDefault();
                const email = event.target.email?.value?.trim();
                runAction(state, statusEl, "email", () => signInWithEmail(email, state));
              },
            },
            el(
              "div",
              { class: "field" },
              el("label", { class: "field-label", for: "signin-email", text: "Email (any bound address)" }),
              el("input", {
                id: "signin-email",
                name: "email",
                type: "email",
                autocomplete: "email",
                required: true,
              })
            ),
            el(
              "div",
              { class: "actions" },
              el("button", {
                class: "btn",
                type: "submit",
                "data-signin": "email",
                disabled: busy,
                text: state.busy === "email" ? "Sending code…" : "Email me a sign-in code",
              })
            )
          ),
          el(
            "details",
            { class: "sign-in-handle" },
            el("summary", { text: "Forgot vote PIN" }),
            el("p", {
              class: "field-hint",
              text: "Same process as a password reset: we email a one-time code, then you set a new PIN on the phone keypad. Keyboard typing of the PIN is disabled.",
            }),
            el(
              "form",
              {
                class: "form-grid",
                onSubmit: (event) => {
                  event.preventDefault();
                  const email = event.target.email?.value?.trim();
                  runAction(state, statusEl, "pin-forgot", () =>
                    forgotVotePin(fetchJson, { email }).then((result) => finishOrMfa(state, result, "pin-reset"))
                  );
                },
              },
              el(
                "div",
                { class: "field" },
                el("label", { class: "field-label", for: "signin-forgot-pin-email", text: "Email" }),
                el("input", {
                  id: "signin-forgot-pin-email",
                  name: "email",
                  type: "email",
                  autocomplete: "email",
                  required: true,
                })
              ),
              el(
                "div",
                { class: "actions" },
                el("button", {
                  class: "btn btn-secondary",
                  type: "submit",
                  disabled: busy,
                  text: state.busy === "pin-forgot" ? "Sending code…" : "Email me a PIN reset code",
                })
              )
            )
          )
        )
      : null,
    tab === "web3"
      ? el(
          "div",
          { class: "sign-in-actions" },
          el("button", {
            class: "btn",
            type: "button",
            "data-signin": "wallet",
            disabled: busy,
            text: state.busy === "wallet" ? "Waiting for wallet…" : "Sign in with Ethereum",
            onClick: () => runAction(state, statusEl, "wallet", () => signInWithEthereum(state)),
          })
        )
      : null,
    tab === "smart_card"
      ? el(
          "form",
          {
            class: "form-grid",
            onSubmit: (event) => {
              event.preventDefault();
              const raw = event.target.fingerprint?.value?.trim();
              const looksPem = raw?.includes("-----BEGIN");
              runAction(state, statusEl, "card", () =>
                signInWithSmartCard(looksPem ? { certificate: raw } : { fingerprint: raw }, state)
              );
            },
          },
          el("p", {
            class: "field-hint",
            text: "Present a PIV, CAC, or national eID at the reader. This Node hashes a certificate fingerprint; live X.509 path verification is clerk-attested.",
          }),
          el(
            "div",
            { class: "field" },
            el("label", {
              class: "field-label",
              for: "signin-card-fp",
              text: "Certificate fingerprint or PEM",
            }),
            el("input", {
              id: "signin-card-fp",
              name: "fingerprint",
              type: "text",
              spellcheck: "false",
              required: true,
              placeholder: "0x… or paste PEM",
            })
          ),
          el(
            "div",
            { class: "sign-in-actions" },
            el("button", {
              class: "btn",
              type: "submit",
              "data-signin": "smart-card",
              disabled: busy,
              text: "Read card and sign in",
            }),
            el("button", {
              class: "btn btn-secondary",
              type: "button",
              text: "Detect reader",
              onClick: () =>
                runAction(state, statusEl, "card-detect", async () => {
                  const info = await presentSmartCard();
                  setStatus(statusEl, info.available ? "ok" : "", info.note);
                  return { mfaRequired: true, needsEmail: false, skip: true, message: info.note };
                }),
            })
          )
        )
      : null,
    tab === "civic_id"
      ? el(
          "form",
          {
            class: "form-grid",
            onSubmit: (event) => {
              event.preventDefault();
              runAction(state, statusEl, "civic", () =>
                signInWithCivicId(
                  {
                    kind: event.target.kind?.value,
                    issuer: event.target.issuer?.value?.trim(),
                    documentNumber: event.target.documentNumber?.value,
                  },
                  state
                )
              );
              event.target.documentNumber.value = "";
            },
          },
          el("p", {
            class: "field-hint",
            text: "Use the driver’s license or passport already bound to your person. The Node hashes the number and does not store it. This is not court-ready commercial IDV.",
          }),
          el(
            "div",
            { class: "field" },
            el("label", { class: "field-label", for: "signin-civic-kind", text: "Document" }),
            el(
              "select",
              { id: "signin-civic-kind", name: "kind", required: true },
              el("option", { value: "drivers_license", text: "Driver’s license" }),
              el("option", { value: "passport", text: "Passport" })
            )
          ),
          el(
            "div",
            { class: "field" },
            el("label", {
              class: "field-label",
              for: "signin-civic-issuer",
              text: "Issuing jurisdiction (for example US-CA or US)",
            }),
            el("input", {
              id: "signin-civic-issuer",
              name: "issuer",
              type: "text",
              autocomplete: "off",
              required: true,
            })
          ),
          el(
            "div",
            { class: "field" },
            el("label", {
              class: "field-label",
              for: "signin-civic-number",
              text: "Document number",
            }),
            el("input", {
              id: "signin-civic-number",
              name: "documentNumber",
              type: "password",
              autocomplete: "off",
              required: true,
            })
          ),
          el(
            "div",
            { class: "actions" },
            el("button", {
              class: "btn",
              type: "submit",
              "data-signin": "civic-id",
              disabled: busy,
              text: "Continue to email code",
            })
          )
        )
      : null,
    tab === "passkey"
      ? el(
          "div",
          {},
          !webauthn ? el("p", { class: "field-hint", text: webAuthnUnavailableMessage() }) : null,
          el(
            "div",
            { class: "sign-in-actions" },
            el("button", {
              class: "btn",
              type: "button",
              "data-signin": "passkey",
              disabled: passkeyControl.disabled,
              text: passkeyControl.label,
              onClick: (event) => {
                const key = loginPrepKey(state.handle);
                if (!(loginPrep.prepared && loginPrep.key === key)) {
                  if (loginPrep.failedKey === key && loginPrep.error) {
                    setStatus(statusEl, "err", loginPrep.error);
                    prefetchPasskeyLogin(state, { force: true, statusEl });
                  }
                  return;
                }
                const prepared = loginPrep.prepared;
                let pending;
                try {
                  pending = loginPasskey({
                    api: fetchJson,
                    handle: state.handle,
                    prepared,
                    trigger: event.currentTarget,
                  });
                } catch (err) {
                  if (err?.code !== "PASSKEY_NOT_FOCUSED") {
                    loginPrep.prepared = null;
                    loginPrep.key = null;
                  }
                  setStatus(statusEl, "err", webAuthnErrorMessage(err));
                  syncPasskeyLoginButton(state);
                  return;
                }
                loginPrep.prepared = null;
                loginPrep.key = null;
                runAction(state, statusEl, "passkey", () =>
                  pending.then((result) => finishOrMfa(state, result, "passkey"))
                );
              },
            })
          ),
          el(
            "details",
            { class: "sign-in-handle" },
            el("summary", { text: "Use a handle (optional)" }),
            el("p", {
              class: "field-hint",
              text: "Username-less passkey login is the default. Enter a handle only if your authenticator cannot discover the passkey on its own.",
            }),
            el("label", { class: "field-label", for: "signin-handle", text: "Handle" }),
            el("input", {
              id: "signin-handle",
              name: "handle",
              type: "text",
              autocomplete: "username webauthn",
              value: state.handle || "",
              onInput: (event) => {
                const previous = loginPrepKey(state.handle);
                state.handle = event.target.value;
                if (loginPrepKey(state.handle) === previous) return;
                loginPrep.prepared = null;
                loginPrep.key = null;
                loginPrep.failedKey = null;
                loginPrep.error = "";
                setStatus(statusEl, "", "");
                prefetchPasskeyLogin(state, { statusEl });
                syncPasskeyLoginButton(state);
              },
            })
          )
        )
      : null,
    state.allowDevLogin
      ? el(
          "details",
          { class: "sign-in-dev" },
          el("summary", { text: "Dev sign-in (local / tests only)" }),
          el("p", {
            class: "field-hint",
            text: "ALLOW_DEV_LOGIN is on for this host. It skips email MFA. Do not use this as the primary path on a live desk.",
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
              el("label", { class: "field-label", for: "signin-dev-handle", text: "Handle" }),
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
              el("button", { class: "btn btn-secondary", type: "submit", text: "Dev sign-in" })
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
  if (kind !== "passkey") state.repaint();
  try {
    const result = await fn();
    if (result?.skip) return;
    if (isMfaChallenge(result)) {
      setStatus(
        statusEl,
        "ok",
        result.message ||
          (result.needsEmail
            ? "Enter the email that will receive your sign-in code."
            : result.pinReset
              ? `Check ${result.emailHint || "your email"} for a vote PIN reset code.`
              : `Check ${result.emailHint || "your email"} for a 6-digit code.`)
      );
      return;
    }
    const who = result?.user?.handle || "signed in";
    setStatus(
      statusEl,
      "ok",
      result?.pinResetGranted ? `Signed in as ${who}. Set a new vote PIN on Identify yourself.` : `Signed in as ${who}.`
    );
  } catch (err) {
    const message =
      kind === "passkey" ? webAuthnErrorMessage(err) : /cancel|not allowed|abort/i.test(err.message || "")
        ? "Sign-in was cancelled."
        : err.message || "Sign-in failed.";
    setStatus(statusEl, "err", message);
  } finally {
    state.busy = false;
    await state.reload();
  }
}

let currentPanel = null;

export function mountSignInPanel(root, extra = {}) {
  if (!root) return null;
  if (currentPanel?.destroy) currentPanel.destroy();
  const opts = { ...panelOptions(root), ...extra };
  const state = {
    user: extra.user || null,
    identity: extra.identity || null,
    allowDevLogin: Boolean(extra.allowDevLogin),
    handle: "",
    tab: "email",
    mfa: extra.mfa || null,
    busy: false,
    repaint() {},
    async reload() {},
  };

  const headingId = root.id ? `${root.id}-heading` : "signin-heading";
  const statusEl = el("div", { class: "flash", role: "status" });
  const body = el("div", { class: "sign-in-body" });
  const section = el(
    "section",
    { class: "panel sign-in-panel", "aria-labelledby": headingId },
    el("header", {}, el("h2", { id: headingId, text: opts.heading })),
    body,
    statusEl
  );
  root.replaceChildren(section);

  function paint() {
    if (state.user) body.replaceChildren(renderSignedIn(state));
    else if (state.mfa) body.replaceChildren(renderMfa(state, statusEl));
    else body.replaceChildren(renderForm(state, opts, statusEl));
  }
  state.repaint = paint;

  state.reload = async () => {
    const next = await loadAuthState();
    state.user = next.user;
    state.identity = next.identity;
    state.allowDevLogin = next.allowDevLogin;
    if (next.user) state.mfa = null;
    if (!next.user && !state.mfa) setStatus(statusEl, "", "");
    paint();
    return next;
  };

  const onSession = () => {
    state.reload();
  };
  window.addEventListener(SESSION_EVENT, onSession);

  state.reload();
  currentPanel = { state, reload: state.reload, destroy: () => window.removeEventListener(SESSION_EVENT, onSession) };
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
          text: "Sign out",
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
    root.replaceChildren(
      el("a", {
        class: "btn btn-secondary session-chrome-btn",
        href: "/signin",
        "data-nav": "",
        text: "Sign in",
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

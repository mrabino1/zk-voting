/**
 * NOT FOR PROFIT — ZK-Voting is a civic public good. Not a commercial product.
 *
 * First-run setup (/setup). Shown only while the install has no platform super
 * admin, then to that super admin until they press "Finish setup". Once a
 * super admin exists the server refuses the admin steps (409) and this page
 * only shows a "setup is closed" note.
 *
 * Steps: 1. super admin passkey  2. chain id  3–4. entropy ceremony and
 * setup entropy (setup-entropy.js), site and environment, L2 identity and L1
 * funding (setup-site.js), all via ctx.setupExtraSteps  Finish.
 */

import { isMfaChallenge, provideMfaEmail, verifyMfaCode } from "./identity-methods.js";
import { notifySession } from "./signin.js";

export async function loadSetupStatus(api) {
  try {
    return await api("/api/setup");
  } catch {
    return null;
  }
}

/** Where the SPA should send the visitor, or null. */
export function setupRedirectFor(status, routeName) {
  if (!status || !status.redirect) return null;
  if (routeName === "setup" || routeName === "terms") return null;
  return "/setup";
}

/**
 * The create button stays disabled until the ceremony is prepared, so a click
 * can open the passkey prompt in that same turn. A failed prepare leaves the
 * button enabled so the operator can retry, and the banner shows that failure.
 */
export function setupPasskeyControl({
  busy = false,
  webAuthn = true,
  ready = false,
  preparing = false,
  failed = false,
} = {}) {
  if (busy) return { disabled: true, label: "Waiting for passkey…" };
  if (!webAuthn || (!ready && !failed)) {
    return {
      disabled: true,
      label: preparing ? "Preparing passkey…" : "Create super admin passkey",
    };
  }
  return { disabled: false, label: "Create super admin passkey" };
}

export async function renderSetup(main, ctx) {
  const { h, api, fill, navigate, announce, wallet } = ctx;
  const state = {
    status: await loadSetupStatus(api),
    me: ctx.me || null,
    busy: false,
    error: "",
    info: "",
    handle: "",
    setupToken: "",
    acceptedTerms: false,
    prepared: null,
    preparedKey: "",
    prepFailedKey: "",
    prepError: "",
    errorFromPrep: false,
    preparingKey: "",
    mfa: null,
    chainChoice: null,
    chainCustom: "",
  };
  const root = h("div", { class: "setup-page" });
  main.replaceChildren(root);

  const isSuper = () => state.me?.user?.role === "platform_super_admin";

  async function refresh() {
    state.status = await loadSetupStatus(api);
    try {
      const me = await api("/api/me");
      state.me = { ...me, user: me?.me || me?.user || null };
    } catch {
      state.me = null;
    }
    paint();
  }

  async function run(fn) {
    if (state.busy) return;
    state.busy = true;
    state.error = "";
    state.errorFromPrep = false;
    state.info = "";
    paint();
    try {
      await fn();
    } catch (err) {
      state.error = wallet.webAuthnErrorMessage(err);
      if (err?.data?.code === "SETUP_ADMIN_EXISTS") await refresh();
    } finally {
      state.busy = false;
      paint();
      if (state.error) announce?.(state.error);
    }
  }

  function afterSession(result) {
    if (isMfaChallenge(result)) {
      state.mfa = result;
      state.info = result.message || "";
      return false;
    }
    state.mfa = null;
    notifySession({ user: result.user, identity: result.identity, method: "passkey" });
    return true;
  }

  function adminHandle() {
    return (state.handle || state.status?.suggestedHandle || "admin").trim();
  }

  function ceremonyKey() {
    const token = state.status?.setupTokenRequired ? String(state.setupToken || "") : "";
    return JSON.stringify({
      handle: adminHandle(),
      token,
      terms: state.acceptedTerms,
      needs: Boolean(state.status?.needsAdmin),
    });
  }

  function formReady() {
    if (!state.status?.needsAdmin || state.mfa) return false;
    if (!state.acceptedTerms) return false;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,31}$/.test(adminHandle())) return false;
    if (state.status?.setupTokenRequired && !String(state.setupToken || "").trim()) return false;
    return true;
  }

  function passkeyReady() {
    return Boolean(state.prepared && state.preparedKey === ceremonyKey());
  }

  function passkeyFailed() {
    return Boolean(state.prepError && state.prepFailedKey === ceremonyKey());
  }

  function passkeyControl() {
    return setupPasskeyControl({
      busy: state.busy,
      webAuthn: wallet.hasWebAuthn(),
      ready: passkeyReady(),
      preparing: Boolean(state.preparingKey) && formReady() && !passkeyReady(),
      failed: passkeyFailed(),
    });
  }

  function syncPasskeyButton() {
    const button = document.getElementById("setup-passkey-btn");
    if (!button) return;
    const control = passkeyControl();
    button.disabled = control.disabled;
    button.textContent = control.label;
  }

  function clearPrepNotice() {
    if (!state.errorFromPrep) return;
    state.error = "";
    state.errorFromPrep = false;
    root.querySelector(".notice-error")?.remove();
  }

  async function prefetchCeremony({ force = false } = {}) {
    if (!wallet.hasWebAuthn() || !formReady()) {
      syncPasskeyButton();
      return;
    }
    const key = ceremonyKey();
    if (force) {
      state.prepFailedKey = "";
      state.prepError = "";
    }
    if (state.prepared && state.preparedKey === key) {
      syncPasskeyButton();
      return;
    }
    if (!force && (state.prepFailedKey === key || state.preparingKey === key)) {
      syncPasskeyButton();
      return;
    }
    state.preparingKey = key;
    syncPasskeyButton();
    const handle = adminHandle();
    const extraBody = state.status?.setupTokenRequired ? { setupToken: state.setupToken } : {};
    let failed = false;
    let stale = false;
    try {
      const server = await api("/api/setup/admin/begin", {
        method: "POST",
        body: { displayName: handle, handle, acceptedTerms: true, ...(extraBody || {}) },
      });
      const options = server?.publicKey ? server : server?.options ? server.options : server || {};
      options.displayName = handle;
      const prepared = await wallet.prepareRegistrationCeremony(options);
      if (ceremonyKey() !== key) {
        stale = true;
      } else {
        state.prepared = prepared;
        state.preparedKey = key;
        state.prepFailedKey = "";
        state.prepError = "";
        clearPrepNotice();
      }
    } catch (err) {
      if (ceremonyKey() !== key) {
        stale = true;
      } else {
        state.prepared = null;
        state.preparedKey = "";
        state.prepFailedKey = key;
        state.prepError = wallet.webAuthnErrorMessage(err);
        state.error = state.prepError;
        state.errorFromPrep = true;
        failed = true;
      }
    } finally {
      if (state.preparingKey === key) state.preparingKey = "";
    }
    if (stale) {
      syncPasskeyButton();
      return;
    }
    if (failed) {
      paint();
      announce?.(state.error);
      return;
    }
    syncPasskeyButton();
  }

  function readLiveFields(form) {
    if (!form || typeof form.querySelector !== "function") return;
    const handleInput = form.querySelector("#setup-handle");
    const tokenInput = form.querySelector("#setup-token");
    const termsInput = form.querySelector("#setup-terms");
    if (handleInput) state.handle = handleInput.value;
    if (tokenInput) state.setupToken = tokenInput.value;
    if (termsInput) state.acceptedTerms = Boolean(termsInput.checked);
  }

  async function createAdmin(event) {
    event.preventDefault();
    if (state.busy) return;
    const form = event.target?.form || (event.target?.tagName === "FORM" ? event.target : null);
    readLiveFields(form || event.target);
    if (!state.acceptedTerms) {
      state.error = "Accept the Terms of Use to continue.";
      state.errorFromPrep = false;
      paint();
      announce?.(state.error);
      return;
    }
    if (!passkeyReady()) {
      if (passkeyFailed()) {
        state.error = state.prepError;
        state.errorFromPrep = true;
        prefetchCeremony({ force: true });
        paint();
        announce?.(state.error);
      } else {
        prefetchCeremony();
      }
      return;
    }
    const handle = adminHandle();
    const extraBody = state.status?.setupTokenRequired ? { setupToken: state.setupToken } : {};
    const prepared = state.prepared;
    const preparedKey = state.preparedKey;
    const trigger =
      event.submitter ||
      (event.currentTarget?.id === "setup-passkey-btn" ? event.currentTarget : null) ||
      document.getElementById("setup-passkey-btn");
    let pending;
    try {
      pending = wallet.registerPasskey({
        api,
        displayName: handle,
        acceptedTerms: true,
        beginPath: "/api/setup/admin/begin",
        finishPath: "/api/setup/admin/finish",
        extraBody,
        strict: true,
        prepared,
        trigger,
      });
    } catch (err) {
      // The browser refused before the prompt. Keep the prepared ceremony so
      // the next click can open it, instead of disabling the button.
      if (err?.code === "PASSKEY_NOT_FOCUSED") {
        state.prepared = prepared;
        state.preparedKey = preparedKey;
      } else {
        state.prepared = null;
        state.preparedKey = "";
      }
      state.error = wallet.webAuthnErrorMessage(err);
      state.errorFromPrep = false;
      paint();
      announce?.(state.error);
      return;
    }
    state.prepared = null;
    state.preparedKey = "";
    // Leave the form alone until the prompt finishes. Rebuilding it, or
    // disabling the button that was just clicked, takes focus and WebKit
    // rejects the passkey that was just approved.
    state.busy = true;
    state.error = "";
    state.errorFromPrep = false;
    try {
      const record = await pending;
      if (afterSession(record.finishResult || {})) {
        state.info = `Super admin ${handle} created. Next: choose the chain id.`;
      }
      await refresh();
    } catch (err) {
      state.error = wallet.webAuthnErrorMessage(err);
      if (err?.data?.code === "SETUP_ADMIN_EXISTS") await refresh();
    } finally {
      state.busy = false;
      paint();
      if (state.error && state.status?.needsAdmin && !state.mfa && !state.prepared) prefetchCeremony({ force: true });
      if (state.error) announce?.(state.error);
    }
  }

  async function onMfaEmail(event) {
    event.preventDefault();
    const email = new FormData(event.target).get("email");
    await run(async () => {
      afterSession(await provideMfaEmail(api, String(email || "")));
    });
  }

  async function onMfaCode(event) {
    event.preventDefault();
    const code = new FormData(event.target).get("code");
    await run(async () => {
      if (afterSession(await verifyMfaCode(api, String(code || "")))) {
        state.info = "Signed in. Next: choose the chain id.";
      }
      await refresh();
    });
  }

  async function saveChain(event) {
    event.preventDefault();
    await run(async () => {
      const raw = state.chainChoice === "custom" ? state.chainCustom : state.chainChoice;
      if (!/^[1-9][0-9]{0,15}$/.test(String(raw || "").trim())) {
        throw new Error("Chain id must be a positive whole number.");
      }
      state.status = await api("/api/setup/chain-id", { method: "PUT", body: { chainId: Number(raw) } });
      state.info = `Chain id ${state.status.chainId.value} saved.`;
    });
  }

  async function finish() {
    await run(async () => {
      state.status = await api("/api/setup/complete", { method: "POST", body: {} });
      state.info = "Setup finished.";
      navigate("/office", { replace: true });
    });
  }

  function onAdminField(event) {
    const el = event.target;
    const previous = ceremonyKey();
    if (el?.id === "setup-handle") state.handle = el.value;
    if (el?.id === "setup-token") state.setupToken = el.value;
    if (el?.id === "setup-terms") state.acceptedTerms = Boolean(el.checked);
    if (ceremonyKey() === previous) {
      syncPasskeyButton();
      return;
    }
    state.prepared = null;
    state.preparedKey = "";
    state.prepFailedKey = "";
    state.prepError = "";
    clearPrepNotice();
    prefetchCeremony();
  }

  function stepBadge(n, done) {
    return h("span", { class: `setup-step-num${done ? " is-done" : ""}`, "aria-hidden": "true", text: done ? "✓" : String(n) });
  }

  function adminStep() {
    const s = state.status;
    if (!s?.needsAdmin) {
      return h(
        "section",
        { class: "panel setup-step is-done", "aria-labelledby": "setup-admin-h" },
        h("h2", { id: "setup-admin-h" }, stepBadge(1, true), " Super admin"),
        h("p", { text: isSuper() ? `Signed in as ${state.me.user.handle}, the platform super admin.` : "A platform super admin exists." })
      );
    }
    if (state.mfa) return mfaStep();
    return h(
      "section",
      { class: "panel setup-step", "aria-labelledby": "setup-admin-h" },
      h("h2", { id: "setup-admin-h" }, stepBadge(1, false), " Create the super admin"),
      h("p", {
        text: "This install has no platform super admin yet. The first passkey created here becomes the super admin. After that this step closes for good.",
      }),
      !wallet.hasWebAuthn()
        ? h("div", { class: "notice notice-error", role: "alert" }, h("p", { text: wallet.webAuthnUnavailableMessage() }))
        : null,
      h(
        "form",
        { class: "stack", onSubmit: createAdmin },
        h(
          "label",
          { class: "field", for: "setup-handle" },
          h("span", { class: "field-label", text: "Admin handle" }),
          h("input", {
            id: "setup-handle",
            name: "handle",
            autocomplete: "username",
            value: state.handle || s.suggestedHandle || "admin",
            pattern: "[A-Za-z0-9][A-Za-z0-9._\\-]{1,31}",
            required: true,
            onInput: onAdminField,
            onChange: onAdminField,
          }),
          h("span", { class: "field-hint", text: "2–32 letters, digits, dot, dash or underscore. Default comes from ADMIN_HANDLE." })
        ),
        s.setupTokenRequired
          ? h(
              "label",
              { class: "field", for: "setup-token" },
              h("span", { class: "field-label", text: "Setup token" }),
              h("input", {
                id: "setup-token",
                name: "setupToken",
                type: "password",
                autocomplete: "off",
                required: true,
                value: state.setupToken || "",
                onInput: onAdminField,
                onChange: onAdminField,
              }),
              h("span", {
                class: "field-hint",
                text:
                  s.setupTokenSource === "generated"
                    ? "Printed once in the server log for this process. It is not shown here. A restart before you finish this step replaces it."
                    : "The SETUP_TOKEN value from the server environment.",
              })
            )
          : null,
        h(
          "label",
          { class: "check-row", for: "setup-terms" },
          h("input", {
            id: "setup-terms",
            type: "checkbox",
            checked: state.acceptedTerms,
            onChange: onAdminField,
          }),
          h("span", {}, "I agree to the ", h("a", { href: "/terms", "data-nav": "", text: "Terms of Use" }), ".")
        ),
        h(
          "div",
          { class: "actions" },
          h("button", {
            id: "setup-passkey-btn",
            class: "btn",
            type: "submit",
            disabled: passkeyControl().disabled,
            text: passkeyControl().label,
            onClick: (event) => {
              event.preventDefault();
              createAdmin(event);
            },
          })
        )
      )
    );
  }

  function mfaStep() {
    const m = state.mfa;
    return h(
      "section",
      { class: "panel setup-step", "aria-labelledby": "setup-mfa-h" },
      h("h2", { id: "setup-mfa-h" }, stepBadge(1, false), " Email code"),
      h("p", { text: m.needsEmail ? "Enter the super admin email. A sign-in code goes there." : `Enter the 6-digit code sent to ${m.emailHint || "your email"}.` }),
      m.needsEmail
        ? h(
            "form",
            { class: "stack", onSubmit: onMfaEmail },
            h("label", { class: "field", for: "setup-mfa-email" }, h("span", { class: "field-label", text: "Email" }), h("input", { id: "setup-mfa-email", name: "email", type: "email", autocomplete: "email", required: true })),
            h("div", { class: "actions" }, h("button", { class: "btn", type: "submit", disabled: state.busy, text: "Send code" }))
          )
        : h(
            "form",
            { class: "stack", onSubmit: onMfaCode },
            h("label", { class: "field", for: "setup-mfa-code" }, h("span", { class: "field-label", text: "Code" }), h("input", { id: "setup-mfa-code", name: "code", inputmode: "numeric", autocomplete: "one-time-code", pattern: "[0-9]{6}", required: true })),
            h("div", { class: "actions" }, h("button", { class: "btn", type: "submit", disabled: state.busy, text: "Verify" }))
          )
    );
  }

  function chainStep() {
    const s = state.status;
    const c = s?.chainId || { value: 27427, source: "default", fixed: false };
    const locked = !isSuper() || s.setupComplete;
    if (c.fixed) {
      return h(
        "section",
        { class: "panel setup-step is-done", "aria-labelledby": "setup-chain-h" },
        h("h2", { id: "setup-chain-h" }, stepBadge(2, true), " Chain id"),
        h("p", {}, "Chain id ", h("strong", { class: "mono", text: String(c.value) }), " is fixed by the environment (", h("code", { text: "CHAIN_ID" }), "). Change it there and restart to use another chain.")
      );
    }
    const presets = s?.chainIdPresets || [];
    if (state.chainChoice == null) {
      state.chainChoice = presets.some((p) => p.chainId === c.value) ? String(c.value) : "custom";
      if (state.chainChoice === "custom") state.chainCustom = String(c.value);
    }
    return h(
      "section",
      { class: `panel setup-step${c.source === "setup" ? " is-done" : ""}`, "aria-labelledby": "setup-chain-h" },
      h("h2", { id: "setup-chain-h" }, stepBadge(2, c.source === "setup"), " Chain id"),
      h("p", {
        text: `Current: ${c.value}${c.source === "setup" ? " (saved here)" : " (default)"}. CHAIN_ID is not set in the environment, so choose it here. Setting CHAIN_ID later overrides this choice.`,
      }),
      locked
        ? h("p", { class: "field-hint", text: s?.setupComplete ? "Setup is finished. Set CHAIN_ID in the environment to change it." : "Create the super admin first." })
        : h(
            "form",
            { class: "stack", onSubmit: saveChain },
            h(
              "fieldset",
              { class: "choice-list" },
              h("legend", { class: "field-label", text: "Network" }),
              ...presets.map((p) =>
                h(
                  "label",
                  { class: "choice", for: `setup-chain-${p.chainId}` },
                  h("input", {
                    id: `setup-chain-${p.chainId}`,
                    type: "radio",
                    name: "chainId",
                    value: String(p.chainId),
                    checked: state.chainChoice === String(p.chainId),
                    onChange: () => {
                      state.chainChoice = String(p.chainId);
                      paint();
                    },
                  }),
                  h("span", {}, p.label, " ", h("span", { class: "mono muted", text: String(p.chainId) }))
                )
              ),
              h(
                "label",
                { class: "choice", for: "setup-chain-custom" },
                h("input", {
                  id: "setup-chain-custom",
                  type: "radio",
                  name: "chainId",
                  value: "custom",
                  checked: state.chainChoice === "custom",
                  onChange: () => {
                    state.chainChoice = "custom";
                    paint();
                  },
                }),
                h("span", { text: "Custom" })
              )
            ),
            state.chainChoice === "custom"
              ? h(
                  "label",
                  { class: "field", for: "setup-chain-custom-value" },
                  h("span", { class: "field-label", text: "Custom chain id" }),
                  h("input", {
                    id: "setup-chain-custom-value",
                    inputmode: "numeric",
                    pattern: "[1-9][0-9]{0,15}",
                    value: state.chainCustom,
                    required: true,
                    onInput: (e) => {
                      state.chainCustom = e.target.value;
                    },
                  })
                )
              : null,
            h("div", { class: "actions" }, h("button", { class: "btn", type: "submit", disabled: state.busy, text: "Save chain id" }))
          )
    );
  }

  function extraSteps() {
    return (ctx.setupExtraSteps || []).map((fn) => fn({ h, state, isSuper, run, api, paint, refresh, stepBadge }));
  }

  function finishStep() {
    const s = state.status;
    return h(
      "section",
      { class: "panel setup-step", "aria-labelledby": "setup-finish-h" },
      h("h2", { id: "setup-finish-h" }, stepBadge(3 + (ctx.setupExtraSteps || []).length, Boolean(s?.setupComplete)), " Finish"),
      s?.setupComplete
        ? h("p", { text: "Setup is finished. This screen will not show again." })
        : h(
            "div",
            { class: "stack" },
            h("p", { text: "Finishing pins the chain id and entropy choices above for this install and stops sending you to this screen." }),
            h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onClick: finish, disabled: state.busy || !isSuper(), text: "Finish setup" }))
          )
    );
  }

  function paint() {
    const s = state.status;
    if (!s) {
      fill(root, h("div", { class: "notice notice-error", role: "alert" }, h("p", { text: "Could not reach the setup API." })));
      return;
    }
    const closed = !s.needsAdmin && !isSuper();
    fill(
      root,
      h(
        "div",
        { class: "page-head" },
        h("p", { class: "kicker", text: "First run" }),
        h("h1", { text: "Set up this install" }),
        h("p", { class: "lede", text: "Create the platform super admin, choose the chain, set up entropy, check the site settings and the L2 identity, then finish. ./setup.sh fills in most of this before the first launch. Each step can be re-run until you press Finish." })
      ),
      state.error ? h("div", { class: "notice notice-error", role: "alert" }, h("p", { text: state.error })) : null,
      state.info ? h("div", { class: "notice notice-ok", role: "status" }, h("p", { text: state.info })) : null,
      closed
        ? h(
            "section",
            { class: "panel setup-step" },
            h("h2", { text: "Setup is closed" }),
            h("p", { text: "This install already has a platform super admin." }),
            h("div", { class: "actions" }, h("a", { class: "btn", href: "/signin", "data-nav": "", text: "Sign in" }))
          )
        : h("div", { class: "setup-steps stack" }, adminStep(), chainStep(), ...extraSteps(), finishStep())
    );
  }

  paint();
}

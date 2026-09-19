/**
 * NOT FOR PROFIT — Republic is a civic public good. Not a commercial product.
 * Phone keypad (3×3 + 0). Digits only via the pad — keyboard typing is blocked
 * while a pad is on screen so a watcher cannot read a typed pattern.
 */

export const STANDARD_PAD = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];
export const PIN_MIN_LEN = 4;
export const PIN_MAX_LEN = 8;

let pinGuardInstalled = false;

function pinKeyGuard(event) {
  if (typeof document === "undefined") return;
  if (!document.querySelector("[data-pin-pad]")) return;
  if (/^\d$/.test(event.key) || event.key === "Backspace" || event.key === "Delete") {
    event.preventDefault();
    event.stopPropagation();
  }
}

function pinPasteGuard(event) {
  if (typeof document === "undefined") return;
  if (!document.querySelector("[data-pin-pad]")) return;
  event.preventDefault();
  event.stopPropagation();
}

function ensurePinGuard() {
  if (pinGuardInstalled || typeof window === "undefined") return;
  pinGuardInstalled = true;
  window.addEventListener("keydown", pinKeyGuard, true);
  window.addEventListener("paste", pinPasteGuard, true);
}

function dots(value, max = PIN_MAX_LEN) {
  const n = String(value || "").length;
  return `${"●".repeat(n)}${"○".repeat(Math.max(0, PIN_MIN_LEN - n))}`.slice(0, Math.max(n, PIN_MIN_LEN));
}

export function renderPinPad(h, {
  layout = STANDARD_PAD,
  scramble = false,
  value = "",
  minLength = PIN_MIN_LEN,
  maxLength = PIN_MAX_LEN,
  disabled = false,
  labelledBy = "pin-pad-label",
  onChange,
  onConfirm,
  confirmText = "Confirm PIN",
} = {}) {
  ensurePinGuard();
  const digits = [...(layout || STANDARD_PAD)];
  while (digits.length < 10) digits.push(String(digits.length % 10));
  const current = String(value || "").replace(/\D/g, "").slice(0, maxLength);

  function pushDigit(d) {
    if (disabled) return;
    if (current.length >= maxLength) return;
    onChange && onChange(current + String(d));
  }

  function backspace() {
    if (disabled) return;
    onChange && onChange(current.slice(0, -1));
  }

  function key(label, opts = {}) {
    return h("button", {
      type: "button",
      class: opts.class || "pin-key",
      "data-digit": opts.digit != null ? String(opts.digit) : undefined,
      disabled: Boolean(disabled || opts.disabled),
      "aria-label": opts.aria || String(label),
      text: String(label),
      onClick: opts.onClick,
    });
  }

  const rows = [
    digits.slice(0, 3),
    digits.slice(3, 6),
    digits.slice(6, 9),
  ];

  return h(
    "div",
    {
      class: "pin-pad",
      "data-pin-pad": "",
      "data-scramble": scramble ? "true" : "false",
      role: "group",
      "aria-labelledby": labelledBy,
    },
    h("p", {
      class: "pin-dots",
      "aria-live": "polite",
      text: current ? dots(current) : "○".repeat(minLength),
    }),
    h("p", {
      class: "visually-hidden",
      text: current ? `${current.length} digits entered` : "No digits entered",
    }),
    ...rows.map((row) =>
      h(
        "div",
        { class: "pin-row" },
        ...row.map((d) =>
          key(d, {
            digit: d,
            aria: `Digit ${d}`,
            onClick: () => pushDigit(d),
          })
        )
      )
    ),
    h(
      "div",
      { class: "pin-row pin-row-zero" },
      h("span", { class: "pin-key pin-key-spacer", "aria-hidden": "true" }),
      key(digits[9], {
        digit: digits[9],
        aria: `Digit ${digits[9]}`,
        onClick: () => pushDigit(digits[9]),
      }),
      key("⌫", {
        class: "pin-key pin-key-back",
        aria: "Delete last digit",
        onClick: backspace,
      })
    ),
    h(
      "div",
      { class: "toolbar pin-pad-actions" },
      h("button", {
        type: "button",
        class: "btn",
        disabled: Boolean(disabled || current.length < minLength),
        text: confirmText,
        onClick: () => {
          if (current.length < minLength || current.length > maxLength) return;
          onConfirm && onConfirm(current);
        },
      }),
      h("button", {
        type: "button",
        class: "btn btn-secondary",
        disabled: Boolean(disabled || !current),
        text: "Clear",
        onClick: () => onChange && onChange(""),
      })
    ),
    scramble
      ? h("p", {
          class: "field-hint",
          text: "Keys are in phone layout. The numbers on them are shuffled for you on this visit so a watcher cannot copy a tap pattern.",
        })
      : h("p", {
          class: "field-hint",
          text: "Tap the keypad. Keyboard typing is disabled so the PIN cannot be entered as a visible keystroke pattern.",
        })
  );
}

export function renderPinManager(h, {
  api,
  identity,
  ui,
  announce,
  onUpdated,
  busy,
} = {}) {
  const pinUi = ui.pin || (ui.pin = {
    digits: "",
    confirmDigits: "",
    currentDigits: "",
    keypad: null,
    currentKeypad: null,
    loadingSetup: false,
    loadingCurrent: false,
    error: "",
    info: "",
    mfa: null,
    forgotEmail: "",
    busy: false,
  });
  const bound = Boolean(identity?.pinBound);
  const resetGranted = Boolean(identity?.pinResetGranted);
  const locked = Boolean(busy || pinUi.busy);

  async function run(fn) {
    pinUi.error = "";
    pinUi.info = "";
    pinUi.busy = true;
    try {
      await fn();
    } catch (err) {
      pinUi.error = err.message || "PIN request failed.";
      announce && announce(pinUi.error);
    } finally {
      pinUi.busy = false;
      onUpdated && (await onUpdated());
    }
  }

  async function loadKeypad(purpose, field) {
    try {
      pinUi[field] = await api("/api/me/pin/keypad", { method: "POST", body: { purpose } });
    } catch {
      pinUi[field] = { layout: STANDARD_PAD, scramble: purpose === "vote" || purpose === "verify" };
    }
    onUpdated && (await onUpdated());
  }

  if (bound && !resetGranted && !pinUi.currentKeypad && !pinUi.loadingCurrent) {
    pinUi.loadingCurrent = true;
    loadKeypad("verify", "currentKeypad").finally(() => {
      pinUi.loadingCurrent = false;
    });
  }
  if (!pinUi.keypad && !pinUi.loadingSetup) {
    pinUi.loadingSetup = true;
    loadKeypad("setup", "keypad").finally(() => {
      pinUi.loadingSetup = false;
    });
  }

  const setupPad = renderPinPad(h, {
    layout: pinUi.keypad?.layout || STANDARD_PAD,
    scramble: false,
    value: pinUi.digits,
    disabled: locked,
    labelledBy: "vote-pin-heading",
    confirmText: pinUi.confirmDigits ? "Save PIN" : "Continue",
    onChange: (next) => {
      pinUi.digits = next;
      onUpdated && onUpdated();
    },
    onConfirm: (pin) => {
      if (!pinUi.confirmDigits) {
        pinUi.confirmDigits = pin;
        pinUi.digits = "";
        pinUi.info = "Enter the same PIN again to confirm.";
        onUpdated && onUpdated();
        return;
      }
      if (pin !== pinUi.confirmDigits) {
        pinUi.error = "PIN confirmation does not match. Try again.";
        pinUi.digits = "";
        pinUi.confirmDigits = "";
        onUpdated && onUpdated();
        return;
      }
      run(async () => {
        await api("/api/me/pin", {
          method: "POST",
          body: {
            pin,
            confirmPin: pinUi.confirmDigits,
            currentPin: resetGranted ? undefined : pinUi.currentDigits || undefined,
          },
        });
        pinUi.digits = "";
        pinUi.confirmDigits = "";
        pinUi.currentDigits = "";
        pinUi.info = "Vote PIN saved. You will enter it on a scrambled keypad when you vote.";
        announce && announce(pinUi.info);
      });
    },
  });

  const changeCurrent = bound && !resetGranted
    ? renderPinPad(h, {
        layout: pinUi.currentKeypad?.layout || STANDARD_PAD,
        scramble: Boolean(pinUi.currentKeypad?.scramble),
        value: pinUi.currentDigits,
        disabled: locked,
        labelledBy: "vote-pin-current-label",
        confirmText: "Use this current PIN",
        onChange: (next) => {
          pinUi.currentDigits = next;
          onUpdated && onUpdated();
        },
        onConfirm: (pin) => {
          pinUi.currentDigits = pin;
          pinUi.info = "Current PIN captured. Enter a new PIN below.";
          onUpdated && onUpdated();
        },
      })
    : null;

  return h(
    "section",
    { class: "panel pin-panel", "aria-labelledby": "vote-pin-heading" },
    h("h2", { id: "vote-pin-heading", text: "Vote PIN" }),
    h("p", {
      text: bound
        ? "Your vote PIN is set. Change it anytime, or use forgot PIN (email MFA) the same way as a password reset. At the ballot the keypad numbers are shuffled for you."
        : "Set a 4–8 digit PIN now. You will tap it on a scrambled phone keypad when you finalize a ballot. The Node stores a hash, never the digits.",
    }),
    pinUi.error ? h("div", { class: "notice notice-error", role: "alert" }, h("p", { text: pinUi.error })) : null,
    pinUi.info ? h("p", { class: "field-hint", text: pinUi.info }) : null,
    pinUi.mfa
      ? h(
          "form",
          {
            class: "stack",
            onSubmit: (event) => {
              event.preventDefault();
              const code = event.target.code?.value?.trim();
              run(async () => {
                const result = await api("/api/auth/mfa/verify", { method: "POST", body: { code } });
                pinUi.mfa = null;
                pinUi.info = result.pinResetGranted
                  ? "Email confirmed. Enter a new vote PIN on the keypad."
                  : "Signed in.";
              });
            },
          },
          h("p", { text: pinUi.mfa.message || `Enter the 6-digit code sent to ${pinUi.mfa.emailHint || "your email"}.` }),
          h(
            "label",
            { class: "field", for: "pin-reset-otp" },
            "One-time code",
            h("input", {
              id: "pin-reset-otp",
              name: "code",
              class: "otp-input",
              inputmode: "numeric",
              maxlength: "6",
              required: true,
            })
          ),
          h("div", { class: "toolbar" }, h("button", { class: "btn", type: "submit", text: "Verify code" }))
        )
      : null,
    !pinUi.mfa && bound && !resetGranted
      ? [
          h("h3", { id: "vote-pin-current-label", text: "Current PIN" }),
          changeCurrent,
          h("h3", { text: "New PIN" }),
        ]
      : null,
    !pinUi.mfa ? setupPad : null,
    !pinUi.mfa
      ? h(
          "div",
          { class: "toolbar" },
          h("button", {
            type: "button",
            class: "btn btn-secondary",
            disabled: locked,
            text: "Forgot PIN — email me a code",
            onClick: () =>
              run(async () => {
                const result = identity?.personId || identity?.pinBound
                  ? await api("/api/me/pin/forgot", { method: "POST", body: {} })
                  : await api("/api/pin/forgot", { method: "POST", body: { email: pinUi.forgotEmail } });
                pinUi.mfa = result;
                pinUi.info = result.message || "Check your email for a PIN reset code.";
              }),
          })
        )
      : null,
    identity?.pinSetAt
      ? h("p", { class: "field-hint", text: `PIN last set ${String(identity.pinSetAt).slice(0, 10)}.` })
      : null
  );
}

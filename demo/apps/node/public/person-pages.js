/**
 * NOT FOR PROFIT — Republic is a civic public good. Not a commercial product.
 * /profile lists addresses with verification color. /verify is where the code is entered.
 */

import { mountSignInPanel } from "./signin.js";
import {
  provideMfaEmail,
  resendMfaCode,
  setPrimaryEmail,
  startEmailRegister,
  verifyMfaCode,
  removeBoundEmail,
} from "./identity-methods.js";
import { emailVerificationStatus } from "./email-verify-status.js";

function formatWhen(ms) {
  if (!ms) return "";
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return "";
  }
}

function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

async function loadEmailChallenge(api) {
  try {
    return await api("/api/auth/mfa/status");
  } catch {
    return { mfaRequired: false };
  }
}

function statusBadge(h, kind) {
  if (kind === "verified") {
    return h("span", { class: "pill-status status-verified", text: "Verified" });
  }
  if (kind === "sent") {
    return h("span", { class: "pill-status status-code-sent", text: "Code sent" });
  }
  return h("span", { class: "pill-status status-unverified", text: "Unverified" });
}

function renderProgress(h, view) {
  return h(
    "div",
    { class: "verify-progress-block" },
    h(
      "div",
      { class: "verify-progress-meta" },
      h("span", { "aria-live": "polite", text: `${view.done} of ${view.total} verified` }),
      h("span", {
        class: `verify-pct ${view.complete ? "is-complete" : "is-incomplete"}`,
        text: `${view.pct}%`,
      })
    ),
    h(
      "div",
      {
        class: "verify-progress",
        role: "progressbar",
        "aria-valuenow": String(view.pct),
        "aria-valuemin": "0",
        "aria-valuemax": "100",
        "aria-label": "Email verification progress",
      },
      h("span", { style: { width: `${view.pct}%` } })
    )
  );
}

function renderHub(h, view, { ctaHref, ctaLabel } = {}) {
  const complete = view.complete;
  return h(
    "section",
    {
      class: `panel verify-hub ${complete ? "is-complete" : "is-incomplete"}`,
      "aria-labelledby": "verify-hub-title",
    },
    h(
      "div",
      { class: "verify-hub-row" },
      h("div", {
        class: `verify-hub-mark ${complete ? "is-complete" : "is-incomplete"}`,
        "aria-hidden": "true",
        text: complete ? "✓" : "!",
      }),
      h(
        "div",
        { class: "verify-hub-copy" },
        h("h2", {
          id: "verify-hub-title",
          text: complete ? "Email verified" : "Verification required",
        }),
        h("p", {
          text: complete
            ? "Every address on this person is verified. Sign-in codes and notices use the primary address."
            : "A verified address is green. An address still waiting on a code is red. Sending the code does not verify it.",
        })
      ),
      !complete && ctaHref
        ? h("a", { class: "btn", href: ctaHref, "data-nav": "", text: ctaLabel || "Go to verification" })
        : null
    ),
    renderProgress(h, view)
  );
}

function renderSentNotice(h, view) {
  const pending = view.pending;
  const label = pending?.label || view.openOnBound;
  if (!view.outstanding || !label) return null;
  const sent = pending ? pending.codeSent : true;
  if (!sent && pending?.needsEmail) return null;
  return h(
    "div",
    { class: "notice notice-sent", role: "status" },
    h("p", {}, h("strong", { text: label }), " Code sent — enter it on the verification page. The address stays unverified until that code is accepted."),
    h(
      "p",
      { class: "toolbar" },
      h("a", { class: "btn", href: "/verify", "data-nav": "", text: "Go to verification" })
    )
  );
}

function gateSignedOut(main, h, { title, lede }) {
  main.replaceChildren(
    h(
      "div",
      { class: "page-head" },
      h("p", { class: "kicker", text: "Registered person" }),
      h("h1", { text: title }),
      h("p", { class: "lede", text: lede })
    ),
    h("div", { id: "sign-in-root" })
  );
  mountSignInPanel(document.getElementById("sign-in-root"));
}

export async function renderProfilePage(main, { h, api, me, onRefresh }) {
  if (!me?.user) {
    gateSignedOut(main, h, {
      title: "Profile",
      lede: "Sign in to see which email addresses are verified.",
    });
    return;
  }

  const challenge = await loadEmailChallenge(api);
  const view = emailVerificationStatus(me.identity, challenge);
  const ui = { error: "", busy: false, showAdd: false, draft: "" };

  function paint() {
    const rows = view.emails.map((row) => {
      const waiting = view.openOnBound && row.email && row.email.toLowerCase() === view.openOnBound.toLowerCase();
      return h(
        "li",
        { class: waiting ? "email-row is-waiting" : "email-row" },
        h("span", { class: "identity-list-main", text: row.email }),
        row.primary ? h("span", { class: "pill-primary", text: "Primary" }) : null,
        statusBadge(h, row.verified ? "verified" : "unverified"),
        waiting ? statusBadge(h, "sent") : null,
        !row.primary && row.verified
          ? h("button", {
              class: "btn btn-secondary",
              type: "button",
              disabled: ui.busy,
              text: "Make primary",
              onClick: () => run(() => setPrimaryEmail(api, { id: row.id })),
            })
          : null,
        h("button", {
          class: "btn btn-secondary",
          type: "button",
          disabled: ui.busy || Boolean(row.primary),
          title: row.primary ? "Set another verified address as primary before removing this one" : "Remove this email",
          text: "Remove",
          onClick: () => run(() => removeBoundEmail(api, row.id)),
        })
      );
    });

    if (view.pending) {
      rows.push(
        h(
          "li",
          { class: "email-row is-waiting" },
          h("span", { class: "identity-list-main", text: view.pending.label }),
          statusBadge(h, "unverified"),
          view.pending.codeSent ? statusBadge(h, "sent") : null,
          h("a", { class: "btn", href: "/verify", "data-nav": "", text: "Enter code" })
        )
      );
    }

    main.replaceChildren(
      h(
        "div",
        { class: "page-head" },
        h("p", { class: "kicker", text: "Registered person" }),
        h("h1", { text: "Profile" }),
        h("p", {
          class: "lede",
          text: "Email addresses for this person. Green is verified. Red is not. A blue note means a code is waiting on the verification page.",
        })
      ),
      renderHub(h, view, { ctaHref: "/verify", ctaLabel: "Go to verification" }),
      h(
        "section",
        { class: "panel", "aria-labelledby": "profile-email-title" },
        h(
          "div",
          { class: "verify-section-head" },
          h("h2", { id: "profile-email-title", text: "Emails" }),
          h("span", { class: "pill-count", text: `${view.count}/${view.cap}` })
        ),
        h("p", {
          class: "field-hint",
          text: "Login, MFA, and the Terms PDF use the primary address. You may bind up to 5. Exactly one is primary.",
        }),
        renderSentNotice(h, view),
        rows.length
          ? h("ul", { class: "identity-list", "aria-label": "Email addresses" }, ...rows)
          : h("p", { class: "field-hint", text: "No email bound yet. Add one and confirm the code on the verification page." }),
        view.atCap
          ? h("p", {
              class: "notice notice-warn",
              text: `Email cap reached (${view.cap}). Remove one before adding another.`,
            })
          : view.outstanding
            ? h("p", {
                class: "field-hint",
                text: "Finish the code that was just sent before adding another address.",
              })
            : ui.showAdd
              ? h(
                  "form",
                  {
                    class: "stack",
                    onSubmit: (event) => {
                      event.preventDefault();
                      const email = event.target.email?.value?.trim();
                      run(async () => {
                        await startEmailRegister(api, { email });
                        ui.showAdd = false;
                        ui.draft = "";
                      });
                    },
                  },
                  h("label", { class: "field", for: "profile-add-email" }, "Add an email", h("input", {
                    id: "profile-add-email",
                    name: "email",
                    type: "email",
                    autocomplete: "email",
                    required: true,
                    value: ui.draft,
                    onInput: (event) => {
                      ui.draft = event.target.value;
                    },
                  })),
                  h(
                    "div",
                    { class: "toolbar" },
                    h("button", {
                      class: "btn",
                      type: "submit",
                      disabled: ui.busy,
                      text: ui.busy ? "Sending…" : "Send verify code",
                    }),
                    h("button", {
                      class: "btn btn-secondary",
                      type: "button",
                      disabled: ui.busy,
                      text: "Cancel",
                      onClick: () => {
                        ui.showAdd = false;
                        ui.draft = "";
                        paint();
                      },
                    })
                  )
                )
              : h("button", {
                  class: "btn btn-secondary",
                  type: "button",
                  text: "Add an email",
                  onClick: () => {
                    ui.showAdd = true;
                    paint();
                  },
                }),
        ui.error ? h("p", { class: "error-inline", role: "alert", text: ui.error }) : null
      )
    );
  }

  async function run(fn) {
    ui.error = "";
    ui.busy = true;
    paint();
    try {
      await fn();
      if (onRefresh) await onRefresh();
    } catch (err) {
      ui.busy = false;
      ui.error = err.message || "Request failed.";
      paint();
    }
  }

  paint();
}

function renderOpenCard(h, { title, address, badge, body }) {
  return h(
    "section",
    { class: "panel verify-open" },
    h(
      "div",
      { class: "verify-section-head" },
      h("h2", { text: title }),
      badge
    ),
    address ? h("p", { class: "verify-address", text: address }) : null,
    body
  );
}

export async function renderEmailVerifyPage(main, { h, api, me, onRefresh }) {
  if (!me?.user) {
    gateSignedOut(main, h, {
      title: "Verify email",
      lede: "Sign in, then enter the code sent to an unverified address.",
    });
    return;
  }

  const challenge = await loadEmailChallenge(api);
  const view = emailVerificationStatus(me.identity, challenge);
  const ui = { error: "", busy: false, info: "" };

  function codeForm(address) {
    const sentAt = view.pending?.sentAt || challenge.sentAt;
    const expiresAt = view.pending?.expiresAt || challenge.expiresAt;
    return h(
      "div",
      { class: "stack" },
      h(
        "div",
        { class: "notice notice-sent" },
        h("p", {}, h("strong", { text: address || "Your email" }), " — we emailed a 6-digit code."),
        h("p", {
          text: expiresAt
            ? `Enter it below. This code expires ${formatWhen(expiresAt)}.`
            : "Enter it below. Codes expire after 10 minutes.",
        }),
        sentAt ? h("p", { class: "field-hint", text: `Sent ${formatWhen(sentAt)}.` }) : null
      ),
      h(
        "form",
        {
          class: "stack",
          onSubmit: (event) => {
            event.preventDefault();
            const code = event.target.code?.value?.trim();
            run(async () => {
              await verifyMfaCode(api, code);
              ui.info = "Email verified.";
            });
          },
        },
        h("label", { class: "field", for: "verify-otp" }, "One-time code", h("input", {
          id: "verify-otp",
          name: "code",
          class: "otp-input",
          inputmode: "numeric",
          maxlength: "6",
          autocomplete: "one-time-code",
          required: true,
          autofocus: true,
        })),
        h(
          "div",
          { class: "toolbar" },
          h("button", { class: "btn", type: "submit", disabled: ui.busy, text: ui.busy ? "Checking…" : "Verify" }),
          h("button", {
            class: "btn btn-secondary",
            type: "button",
            disabled: ui.busy,
            text: "Resend code",
            onClick: () =>
              run(async () => {
                await resendMfaCode(api);
                ui.info = "A new code was sent. The previous code no longer works.";
              }),
          })
        )
      )
    );
  }

  function sendForm({ label, existing }) {
    return h(
      "form",
      {
        class: "stack",
        onSubmit: (event) => {
          event.preventDefault();
          const email = existing || event.target.email?.value?.trim();
          if (!looksLikeEmail(email)) {
            ui.error = "Enter a valid email address.";
            paint();
            return;
          }
          run(() => startEmailRegister(api, { email }));
        },
      },
      existing
        ? h("p", { text: "This address is saved but not verified. Send a code, then enter it here." })
        : h("label", { class: "field", for: "verify-email" }, "Email", h("input", {
            id: "verify-email",
            name: "email",
            type: "email",
            autocomplete: "email",
            required: true,
          })),
      h("div", { class: "toolbar" }, h("button", {
        class: "btn",
        type: "submit",
        disabled: ui.busy,
        text: ui.busy ? "Sending…" : label,
      }))
    );
  }

  function paint() {
    const tiles = [];
    for (const row of view.emails) {
      const waiting = view.openOnBound && row.email && row.email.toLowerCase() === view.openOnBound.toLowerCase();
      if (waiting) {
        tiles.push(
          renderOpenCard(h, {
            title: "Confirm this address",
            address: row.email,
            badge: statusBadge(h, "unverified"),
            body: codeForm(row.email),
          })
        );
      } else if (row.verified) {
        tiles.push(
          h(
            "section",
            { class: "panel verify-done" },
            h(
              "div",
              { class: "verify-section-head" },
              h("h2", { text: row.primary ? "Primary email" : "Email" }),
              statusBadge(h, "verified")
            ),
            h("p", { class: "verify-address", text: row.email }),
            h("p", { class: "field-hint", text: "Verified. This inbox can receive sign-in codes." })
          )
        );
      } else {
        tiles.push(
          renderOpenCard(h, {
            title: "Unverified email",
            address: row.email,
            badge: statusBadge(h, "unverified"),
            body: sendForm({ label: "Send verify code", existing: row.email }),
          })
        );
      }
    }

    if (view.pending) {
      tiles.push(
        renderOpenCard(h, {
          title: view.pending.needsEmail ? "Email needed" : "Confirm this address",
          address: view.pending.needsEmail ? "" : view.pending.label,
          badge: statusBadge(h, view.pending.codeSent ? "unverified" : "unverified"),
          body: view.pending.needsEmail
            ? h(
                "form",
                {
                  class: "stack",
                  onSubmit: (event) => {
                    event.preventDefault();
                    const email = event.target.email?.value?.trim();
                    run(() => provideMfaEmail(api, email));
                  },
                },
                h("label", { class: "field", for: "verify-need-email" }, "Email", h("input", {
                  id: "verify-need-email",
                  name: "email",
                  type: "email",
                  autocomplete: "email",
                  required: true,
                })),
                h("button", { class: "btn", type: "submit", disabled: ui.busy, text: "Send code" })
              )
            : view.pending.codeSent
              ? codeForm(view.pending.label)
              : sendForm({ label: "Send verify code", existing: view.pending.email || "" })
        })
      );
    } else if (!view.emails.length) {
      tiles.push(
        renderOpenCard(h, {
          title: "Verify an email",
          address: "",
          badge: statusBadge(h, "unverified"),
          body: sendForm({ label: "Send verify code" }),
        })
      );
    }

    const parts = [
      h(
        "div",
        { class: "page-head" },
        h("p", { class: "kicker", text: "Registered person" }),
        h("h1", { text: "Verify email" }),
        h("p", {
          class: "lede",
          text: "Gold means this step is still open. Blue means the code is in the inbox. Green means the address is verified.",
        }),
        h(
          "p",
          { class: "toolbar" },
          h("a", { class: "btn btn-secondary", href: "/profile", "data-nav": "", text: "Profile" })
        )
      ),
      renderHub(h, view),
      view.complete
        ? h(
            "section",
            { class: "panel verify-done" },
            h("h2", { text: "Verification complete" }),
            h("p", { text: "There is no code waiting. Add another address from Profile if you need one." }),
            h("a", { class: "btn btn-secondary", href: "/profile", "data-nav": "", text: "Manage emails" })
          )
        : null,
      ...tiles,
      ui.info ? h("p", { class: "notice notice-ok", role: "status", text: ui.info }) : null,
      ui.error ? h("p", { class: "error-inline", role: "alert", text: ui.error }) : null,
    ].filter((node) => node != null && node !== false);
    main.replaceChildren(...parts);
  }

  async function run(fn) {
    ui.error = "";
    ui.busy = true;
    paint();
    try {
      await fn();
      if (onRefresh) await onRefresh();
    } catch (err) {
      ui.busy = false;
      ui.error = err.message || "Request failed.";
      paint();
    }
  }

  paint();
}

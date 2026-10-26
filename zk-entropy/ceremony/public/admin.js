/* NOT FOR PROFIT — civic public good, not a commercial product.
 * Ceremony admin: first-run passphrase setup (or ADMIN_TOKEN), settings,
 * open, close, and the published output. */
import { api, h, fill, pill, head, notice, fmtTime, finalPanel } from "/common.js";

const main = document.getElementById("main");
let flash = null;

function field(id, label, input, hint) {
  return h("div", { class: "field" }, h("label", { class: "field-label", for: id }, label), input, hint ? h("span", { class: "field-hint", id: `${id}-hint` }, hint) : null);
}

function errorBox() {
  return h("p", { class: "field-error", role: "alert" });
}

function toLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function setupPanel(info) {
  const pw = h("input", { id: "admin-pass", type: "password", autocomplete: "new-password", minlength: "12", required: true });
  const pw2 = h("input", { id: "admin-pass2", type: "password", autocomplete: "new-password", required: true });
  const tok = info.setupTokenRequired ? h("input", { id: "setup-token", type: "password", autocomplete: "off", required: true }) : null;
  const err = errorBox();
  return h(
    "section",
    { class: "panel", "aria-labelledby": "setup-h" },
    h("h2", { id: "setup-h" }, "First run: create the ceremony admin"),
    h("p", { class: "muted" }, "No admin exists yet. The first passphrase saved here becomes the admin credential; after that this form closes for good. Set ADMIN_TOKEN instead to skip this step."),
    h("form", { novalidate: true, onSubmit: async (e) => {
        e.preventDefault();
        err.textContent = "";
        if (pw.value.length < 12) return (err.textContent = "Use a passphrase of at least 12 characters.");
        if (pw.value !== pw2.value) return (err.textContent = "The two passphrases do not match.");
        try {
          await api("/api/admin/setup", { method: "POST", json: { password: pw.value, setupToken: tok ? tok.value : undefined } });
          pw.value = pw2.value = "";
          flash = "Admin created. You are signed in.";
          await render();
        } catch (ex) {
          err.textContent = ex.message;
          if (ex.status === 409) await render();
        }
      } },
      field("admin-pass", "Admin passphrase", pw, "12 to 256 characters. Stored only as a scrypt hash."),
      field("admin-pass2", "Repeat passphrase", pw2),
      tok ? field("setup-token", "Setup token", tok, "Required because SETUP_TOKEN is set on this server.") : null,
      err,
      h("div", { class: "actions" }, h("button", { class: "btn", type: "submit" }, "Create admin"))
    )
  );
}

function loginPanel(info) {
  const pw = h("input", { id: "login-pass", type: "password", autocomplete: "current-password", required: true });
  const err = errorBox();
  return h(
    "section",
    { class: "panel", "aria-labelledby": "login-h" },
    h("h2", { id: "login-h" }, "Admin sign in"),
    h("form", { novalidate: true, onSubmit: async (e) => {
        e.preventDefault();
        try {
          await api("/api/admin/login", { method: "POST", json: { password: pw.value } });
          pw.value = "";
          await render();
        } catch (ex) {
          err.textContent = ex.message;
        }
      } },
      field("login-pass", info.adminFromEnv ? "Admin token" : "Admin passphrase", pw, info.adminFromEnv ? "The value of ADMIN_TOKEN on this server." : null),
      err,
      h("div", { class: "actions" }, h("button", { class: "btn", type: "submit" }, "Sign in"))
    )
  );
}

function settingsPanel(info) {
  const s = info.settings;
  const closed = info.ceremony.status === "closed";
  const title = h("input", { id: "set-title", type: "text", maxlength: "120", value: s.title, disabled: closed });
  const min = h("input", { id: "set-min", type: "number", min: "1", step: "1", value: String(s.minContributions), disabled: closed });
  const deadline = h("input", { id: "set-deadline", type: "datetime-local", value: toLocalInput(s.closeAt), disabled: closed });
  const after = h("input", { id: "set-after", type: "number", min: "0", step: "1", value: s.closeAfterCount ? String(s.closeAfterCount) : "", disabled: closed });
  const err = errorBox();
  return h(
    "section",
    { class: "panel", "aria-labelledby": "settings-h" },
    h("h2", { id: "settings-h" }, "Settings"),
    h("form", { novalidate: true, onSubmit: async (e) => {
        e.preventDefault();
        try {
          await api("/api/admin/settings", { method: "PUT", json: {
            title: title.value,
            minContributions: Number(min.value),
            closeAt: deadline.value ? new Date(deadline.value).toISOString() : null,
            closeAfterCount: after.value ? Number(after.value) : null,
          } });
          flash = "Settings saved.";
          await render();
        } catch (ex) {
          err.textContent = ex.message;
        }
      } },
      field("set-title", "Title", title),
      field("set-min", "Minimum contributions", min, "Manual close and deadline close both wait for this many (manual close can force)."),
      field("set-deadline", "Deadline (your local time, optional)", deadline, "At the deadline the ceremony closes by itself once the minimum is met."),
      field("set-after", "Close after this many contributions (optional)", after, "Closes by itself when the count is reached. Empty or 0 turns it off."),
      err,
      closed ? null : h("div", { class: "actions" }, h("button", { class: "btn btn-secondary", type: "submit" }, "Save settings"))
    )
  );
}

function controlPanel(info) {
  const c = info.ceremony;
  const err = errorBox();
  const force = h("input", { id: "close-force", type: "checkbox" });
  const act = (path, body, ok) => async () => {
    err.textContent = "";
    try {
      await api(path, { method: "POST", json: body() });
      flash = ok;
      await render();
    } catch (ex) {
      err.textContent = ex.message;
    }
  };
  const below = c.count < c.minContributions;
  return h(
    "section",
    { class: "panel", "aria-labelledby": "ctl-h" },
    h("h2", { id: "ctl-h" }, "Ceremony"),
    h("dl", { class: "facts" },
      h("dt", {}, "Status"), h("dd", {}, pill(c.status)),
      h("dt", {}, "Contributions"), h("dd", { id: "admin-count" }, `${c.count} (minimum ${c.minContributions})`),
      h("dt", {}, "Opened"), h("dd", {}, fmtTime(c.openedAt)),
      h("dt", {}, "Closed"), h("dd", {}, c.closedAt ? `${fmtTime(c.closedAt)} (${c.closeReason})` : "—"),
      h("dt", {}, "Storage"), h("dd", {}, info.store)
    ),
    c.status === "draft" ? h("div", { class: "actions" }, h("button", { class: "btn", type: "button", id: "open-btn", onClick: act("/api/admin/open", () => ({}), "The ceremony is open.") }, "Open for contributions")) : null,
    c.status === "open"
      ? h("div", {},
          h("p", { class: "muted" }, "Closing computes the final output, reveals the raw contributions in the transcript, and stops new contributions. It cannot be undone."),
          below ? h("div", { class: "check-row" }, force, h("label", { for: "close-force" }, `Close below the minimum (${c.count} of ${c.minContributions})`)) : null,
          h("div", { class: "actions" }, h("button", { class: "btn btn-danger", type: "button", id: "close-btn", onClick: act("/api/admin/close", () => ({ force: force.checked }), "Closed. The final output is published.") }, "Close and publish")))
      : null,
    err
  );
}

async function render() {
  const info = await api("/api/admin");
  const parts = [head("Admin", "Ceremony admin", "Open the ceremony, set the closing rules, and publish the final output.")];
  if (flash) {
    parts.push(notice("ok", h("p", {}, flash)));
    flash = null;
  }
  if (!info.adminExists) parts.push(setupPanel(info));
  else if (!info.signedIn) parts.push(loginPanel(info));
  else {
    if (info.ceremony.final) parts.push(finalPanel(info.ceremony.final));
    parts.push(controlPanel(info), settingsPanel(info));
    parts.push(h("div", { class: "actions" }, h("button", { class: "btn btn-secondary", type: "button", onClick: async () => {
      await api("/api/admin/logout", { method: "POST", json: {} });
      await render();
    } }, "Sign out")));
  }
  fill(main, ...parts);
}

render().catch((err) => fill(main, notice("error", h("p", {}, `Could not load: ${err.message}`))));

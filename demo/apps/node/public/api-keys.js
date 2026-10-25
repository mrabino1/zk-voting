/**
 * NOT FOR PROFIT — Republic is a civic public good. Not a commercial product.
 * Profile controls for personal API keys. The secret stays in memory only
 * until the person leaves this view. It is never written to storage.
 */

const EXPIRATIONS = [
  ["7d", "7 days"],
  ["30d", "30 days"],
  ["90d", "90 days"],
  ["180d", "180 days"],
  ["365d", "365 days"],
  ["never", "Never"],
];

const LEVELS = [
  ["read", "Read-only"],
  ["voter", "Voter"],
  ["officer", "Officer"],
];

let revealed = null;

function svgEl(name, attrs) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

function copyIcon() {
  const svg = svgEl("svg", {
    viewBox: "0 0 24 24",
    width: "22",
    height: "22",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.8",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  });
  svg.append(
    svgEl("rect", { x: "9", y: "9", width: "11", height: "11", rx: "2" }),
    svgEl("path", { d: "M5 15V5a2 2 0 0 1 2-2h8" })
  );
  return svg;
}

function checkIcon() {
  const svg = svgEl("svg", {
    viewBox: "0 0 24 24",
    width: "22",
    height: "22",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.8",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  });
  svg.append(svgEl("path", { d: "M5 12.5 9.2 17 19 7" }));
  return svg;
}

async function copyText(value) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* fall through to the selection copy */
  }
  const field = document.createElement("textarea");
  field.value = value;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.left = "-9999px";
  document.body.append(field);
  field.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  field.remove();
  return ok;
}

function statusLabel(row) {
  if (row.revokedAt) return "Revoked";
  if (row.expired || (row.expiresAt && Date.parse(row.expiresAt) <= Date.now())) return "Expired";
  return "Active";
}

function whenLabel(row) {
  if (row.expiresIn === "never" || !row.expiresAt) return "Never";
  return `${row.expiresIn} · ${row.expiresAt.slice(0, 10)}`;
}

export function renderApiKeysSection(h, { api, keys, onRefresh }) {
  const rows = Array.isArray(keys?.apiKeys) ? keys.apiKeys : [];
  const ui = { busy: false, error: "", copied: false };

  const errorNode = h("p", { class: "field-error", role: "alert" });
  const copyStatus = h("p", { class: "field-hint", role: "status" });
  const formError = () => {
    errorNode.textContent = ui.error;
  };

  async function onCopy() {
    if (!revealed?.secret) return;
    const ok = await copyText(revealed.secret);
    ui.copied = ok;
    copyStatus.textContent = ok ? "Copied" : "Select the key and copy it manually.";
    const button = document.getElementById("api-key-copy");
    if (button) {
      button.replaceChildren(ok ? checkIcon() : copyIcon());
      button.setAttribute("aria-label", ok ? "API key copied" : "Copy API key");
    }
  }

  const reveal =
    revealed?.secret
      ? h(
          "div",
          { class: "notice notice-warn", role: "status" },
          h("p", { text: "This API key is shown once. It cannot be displayed again. Copy it now." }),
          h(
            "div",
            { class: "secret-row" },
            h("label", { class: "visually-hidden", for: "api-key-secret", text: "API key" }),
            h("input", {
              id: "api-key-secret",
              type: "text",
              readonly: "readonly",
              spellcheck: "false",
              autocomplete: "off",
              value: revealed.secret,
            }),
            h(
              "button",
              {
                id: "api-key-copy",
                class: "btn btn-secondary icon-btn",
                type: "button",
                title: "Copy API key",
                "aria-label": "Copy API key",
                onClick: () => {
                  onCopy();
                },
              },
              copyIcon()
            )
          ),
          copyStatus,
          h(
            "button",
            {
              class: "btn btn-secondary",
              type: "button",
              text: "I have saved this key",
              onClick: () => {
                revealed = null;
                onRefresh();
              },
            }
          )
        )
      : null;

  async function onCreate(event) {
    event.preventDefault();
    if (ui.busy) return;
    ui.busy = true;
    ui.error = "";
    formError();
    const form = event.currentTarget;
    const body = {
      name: form.name.value,
      level: form.level.value,
      expiresIn: form.expiresIn.value,
    };
    try {
      const created = await api("/api/me/api-keys", { method: "POST", body });
      revealed = created?.secret ? { secret: created.secret, id: created.apiKey?.id } : null;
      form.name.value = "";
      await onRefresh();
    } catch (err) {
      ui.error = err.message || "Could not create the API key.";
      formError();
    } finally {
      ui.busy = false;
    }
  }

  async function onRevoke(row) {
    if (ui.busy) return;
    if (!window.confirm(`Revoke “${row.name}”? This cannot be undone.`)) return;
    ui.busy = true;
    ui.error = "";
    formError();
    try {
      await api(`/api/me/api-keys/${encodeURIComponent(row.id)}`, { method: "DELETE" });
      await onRefresh();
    } catch (err) {
      ui.error = err.message || "Could not revoke the API key.";
      formError();
    } finally {
      ui.busy = false;
    }
  }

  return h(
    "section",
    { "aria-labelledby": "api-keys-heading" },
    h("h2", { id: "api-keys-heading", text: "API keys" }),
    h("p", {
      text: "Create a key for an external bot. Read-only, voter, and officer keys can exist together. Each key expires in 7, 30, 90, 180, or 365 days, or never. The default is 30 days. Creating a key emails you. If you did not create it, contact support as soon as possible.",
    }),
    h("p", {
      class: "field-hint",
      text: "The full key is shown once here and is not included in the email. After you leave this notice, it cannot be shown again. Revoke a key you do not recognize.",
    }),
    h("p", {}, h("a", { href: "/api", text: "Bot API documentation" })),
    reveal,
    errorNode,
    h(
      "form",
      { class: "stack", onSubmit: onCreate },
      h(
        "label",
        { class: "field", for: "api-key-name" },
        "Name",
        h("input", { id: "api-key-name", name: "name", type: "text", maxlength: "80", required: "required", autocomplete: "off" })
      ),
      h(
        "label",
        { class: "field", for: "api-key-level" },
        "Authorization",
        h(
          "select",
          { id: "api-key-level", name: "level" },
          ...LEVELS.map(([value, label]) => h("option", { value, text: label }))
        )
      ),
      h(
        "label",
        { class: "field", for: "api-key-expiry" },
        "Expiration",
        h(
          "select",
          { id: "api-key-expiry", name: "expiresIn" },
          ...EXPIRATIONS.map(([value, label]) =>
            h("option", { value, text: label, ...(value === "30d" ? { selected: "selected" } : {}) })
          )
        )
      ),
      h("button", { class: "btn", type: "submit", text: "Create API key" })
    ),
    rows.length
      ? h(
          "div",
          { class: "table-wrap" },
          h(
            "table",
            {},
            h(
              "thead",
              {},
              h(
                "tr",
                {},
                h("th", { scope: "col", text: "Name" }),
                h("th", { scope: "col", text: "Prefix" }),
                h("th", { scope: "col", text: "Authorization" }),
                h("th", { scope: "col", text: "Expiration" }),
                h("th", { scope: "col", text: "Status" }),
                h("th", { scope: "col", text: "Revoke" })
              )
            ),
            h(
              "tbody",
              {},
              ...rows.map((row) =>
                h(
                  "tr",
                  {},
                  h("td", { text: row.name }),
                  h("td", {}, h("code", { text: row.prefix })),
                  h("td", { text: row.levelLabel || row.level }),
                  h("td", { text: whenLabel(row) }),
                  h("td", { text: statusLabel(row) }),
                  h(
                    "td",
                    {},
                    row.revokedAt
                      ? "Revoked"
                      : h("button", {
                          class: "btn btn-danger",
                          type: "button",
                          text: "Revoke",
                          onClick: () => onRevoke(row),
                        })
                  )
                )
              )
            )
          )
        )
      : h("p", { class: "field-hint", text: "No API keys yet." })
  );
}

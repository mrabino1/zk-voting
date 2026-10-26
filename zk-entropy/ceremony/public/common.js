/* NOT FOR PROFIT — civic public good, not a commercial product. */
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "class") el.className = v;
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

export function fill(target, ...nodes) {
  target.replaceChildren(...nodes.flat().filter(Boolean));
}

export async function api(path, { method = "GET", json } = {}) {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: json === undefined ? {} : { "content-type": "application/json" },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message || `HTTP ${res.status}`), { status: res.status, data });
  return data;
}

export function pill(status) {
  const label = { open: "Open", closed: "Closed", draft: "Not open yet" }[status] || status;
  return h("span", { class: `pill pill-${status}` }, label);
}

export function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function head(kicker, title, lede) {
  return h("div", { class: "page-head" }, h("span", { class: "kicker" }, kicker), h("h1", {}, title), lede ? h("p", { class: "lede" }, lede) : null);
}

export function notice(kind, ...kids) {
  return h("div", { class: `notice notice-${kind}`, role: kind === "error" ? "alert" : "status" }, ...kids);
}

export function copyBox(id, label, value) {
  const area = h("textarea", { id, class: "output", readonly: true, rows: "3", "aria-label": label }, value);
  const btn = h("button", { class: "btn", type: "button", onClick: async () => {
    try {
      await navigator.clipboard.writeText(value);
      btn.textContent = "Copied";
    } catch {
      area.select();
      btn.textContent = "Press Ctrl+C to copy";
    }
    setTimeout(() => (btn.textContent = "Copy"), 2500);
  } }, "Copy");
  return h("div", {}, area, h("div", { class: "actions" }, btn));
}

export function finalPanel(final) {
  return h(
    "section",
    { class: "panel", "aria-labelledby": "final-h" },
    h("h2", { id: "final-h" }, "Final ceremony output"),
    h("p", {}, "Paste this string into the zk-voting first-run setup or the trusted-setup contribution page. It carries its own checksum and the hash of the public transcript."),
    copyBox("final-string", "Final entropy string", final.entropyString),
    h("dl", { class: "facts spaced" },
      h("dt", {}, "Output (hex)"), h("dd", { class: "mono" }, final.output),
      h("dt", {}, "Transcript hash"), h("dd", { class: "mono" }, final.transcriptHash)
    ),
    h("p", { class: "field-hint" }, "Verify it yourself from a clone of zk-voting: node zk-entropy/bin/zk-entropy.js verify-transcript ", h("code", {}, `${location.origin}/api/transcript`))
  );
}

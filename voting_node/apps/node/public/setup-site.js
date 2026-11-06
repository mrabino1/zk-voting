/**
 * NOT FOR PROFIT — ZK-Voting is a civic public good. Not a commercial product.
 *
 * First-run setup steps 5 and 6 (plugged into setup.js via ctx.setupExtraSteps):
 *   5. Site and environment: what ./setup.sh (voting_node/.env) set for this
 *      deployment, read-only, plus the product name (saved in the app).
 *   6. L2 identity and L1 funding: GET /api/l2/identity?funding=1, with a
 *      warning when the L1 submitter balance is low or empty.
 * Secrets (setup token, database URL, L2_SALT, L2_ADMIN_SECRET,
 * L1_SUBMITTER_PRIVATE_KEY) never reach this page; they live in env only.
 */

const RERUN = "./setup.sh";

function row(h, label, value) {
  return [h("dt", { text: label }), h("dd", {}, value == null || value === "" ? h("span", { class: "muted", text: "not set" }) : value)];
}

function siteStep(ctx) {
  const { h, state, isSuper, run, api, stepBadge } = ctx;
  const s = state.status;
  const site = s?.site;
  const locked = !isSuper() || s?.setupComplete;
  const head = h("h2", { id: "setup-site-h" }, stepBadge(5, Boolean(site?.productNameSaved || s?.setupComplete)), " Site and environment");
  if (!site) {
    return h(
      "section",
      { class: "panel setup-step", "aria-labelledby": "setup-site-h" },
      head,
      h("p", { class: "field-hint", text: s?.setupComplete ? "Setup is finished." : "Create the super admin first." })
    );
  }
  if (state.productName == null) state.productName = site.productName;
  const save = (event) => {
    event.preventDefault();
    run(async () => {
      state.status = await api("/api/setup/site", { method: "PUT", body: { productName: state.productName } });
      state.productName = state.status.site.productName;
      state.info = `Product name ${state.productName} saved.`;
    });
  };
  return h(
    "section",
    { class: `panel setup-step${site.productNameSaved ? " is-done" : ""}`, "aria-labelledby": "setup-site-h" },
    head,
    h("p", {}, "These come from the environment. Change them with ", h("code", { text: RERUN }), " (it rewrites ", h("code", { text: "voting_node/.env" }), "), then restart the app."),
    h(
      "dl",
      { class: "status-dl", id: "setup-site-env" },
      ...row(h, "Public hostname", site.voteFqdn ? h("code", { text: site.voteFqdn }) : null),
      ...row(h, "Public URL", site.publicOrigin ? h("code", { text: site.publicOrigin }) : null),
      ...row(h, "Passkey RP ID", site.rpId ? h("code", { text: site.rpId }) : null),
      ...row(h, "Behind a proxy", site.trustProxy ? `yes (TRUST_PROXY=${site.trustProxy})` : "no"),
      ...row(h, "App port (in the container)", String(site.port ?? "")),
      ...row(h, "Database", site.database === "postgres" ? "Postgres (DATABASE_URL set, not shown)" : "JSON files in the data volume"),
      ...row(h, "Setup token", site.setupTokenSet ? "set (not shown)" : "not set")
    ),
    locked
      ? h("p", {}, "Product name: ", h("strong", { text: site.productName }))
      : h(
          "form",
          { class: "stack", onSubmit: save },
          h(
            "label",
            { class: "field", for: "setup-product-name" },
            h("span", { class: "field-label", text: "Product name" }),
            h("input", {
              id: "setup-product-name",
              maxlength: "60",
              value: state.productName,
              placeholder: site.productNameDefault,
              onInput: (e) => {
                state.productName = e.target.value;
              },
            }),
            h("span", { class: "field-hint", text: `Shown in the header, emails and receipts. Empty = ${site.productNameDefault} (BRAND_NAME or the default). The header logo stays the built-in mark until Site admin > Layout & appearance > Branding sets another. Site admin can change the name later too.` })
          ),
          h("div", { class: "actions" }, h("button", { class: "btn", type: "submit", disabled: state.busy, text: "Save product name" }))
        )
  );
}

function fundingNotice(h, f) {
  if (!f) return null;
  const cls = f.level === "ok" ? "notice notice-ok" : f.level === "low" || f.level === "empty" ? "notice notice-warn" : "notice";
  const title = f.level === "low" || f.level === "empty" ? `Warning: L1 balance ${f.level}. ` : "";
  return h("div", { class: cls, role: f.level === "low" || f.level === "empty" ? "alert" : "status", id: "setup-l2-funding" }, h("p", {}, title ? h("strong", { text: title }) : null, f.message || f.level));
}

function l2Step(ctx) {
  const { h, state, isSuper, paint, stepBadge } = ctx;
  const s = state.status;
  const id = state.l2;
  const head = h("h2", { id: "setup-l2-h" }, stepBadge(6, Boolean(id?.configured && id?.funding?.level === "ok")), " L2 identity and L1 funding");
  const load = async (funding) => {
    state.l2Busy = true;
    paint();
    try {
      const res = await fetch(`/api/l2/identity${funding ? "?funding=1" : ""}`, { headers: { accept: "application/json" }, credentials: "same-origin" });
      state.l2 = await res.json();
      state.l2Error = res.ok ? "" : state.l2?.error || `HTTP ${res.status}`;
    } catch (err) {
      state.l2Error = err?.message || "Could not reach /api/l2/identity.";
    } finally {
      state.l2Busy = false;
      paint();
    }
  };
  if (isSuper() && state.l2 === undefined && !state.l2Busy) {
    state.l2 = null;
    queueMicrotask(() => load(true));
  }
  if (!isSuper()) {
    return h("section", { class: "panel setup-step", "aria-labelledby": "setup-l2-h" }, head, h("p", { class: "field-hint", text: s?.setupComplete ? "Setup is finished." : "Create the super admin first." }));
  }
  return h(
    "section",
    { class: `panel setup-step${id?.configured ? " is-done" : ""}`, "aria-labelledby": "setup-l2-h" },
    head,
    h(
      "p",
      {},
      "Voters never pay. The operator key (",
      h("code", { text: "L1_SUBMITTER_PRIVATE_KEY" }),
      ") pays L1 gas for vote batches, so keep a little ETH on it. ",
      h("code", { text: RERUN }),
      " mints L2_UUID, L2_SALT and L2_ADMIN_SECRET and derives L2_ID; they stay in the environment and are never shown here."
    ),
    state.l2Error ? h("div", { class: "notice notice-error", role: "alert" }, h("p", { text: state.l2Error })) : null,
    !id
      ? h("p", { class: "muted", text: "Loading…" })
      : h(
          "div",
          { class: "stack" },
          h(
            "dl",
            { class: "status-dl", id: "setup-l2-identity" },
            ...row(h, "L2_ID", id.l2Id ? h("code", { text: id.l2Id }) : null),
            ...row(h, "L2_UUID", id.l2Uuid ? h("code", { text: id.l2Uuid }) : null),
            ...row(h, "Operator", id.operator ? h("code", { text: id.operator }) : null),
            ...row(h, "Submitter key", id.submitterKeySet ? "set (not shown)" : "not set"),
            ...row(h, "Operator admin writes", id.adminWritesEnabled ? "enabled (L2_ADMIN_SECRET set)" : "off (L2_ADMIN_SECRET not set)"),
            ...row(h, "L1 status", id.l1Status === "configured" ? "configured" : "L1 addresses not published yet")
          ),
          id.problems?.length
            ? h("div", { class: "notice notice-warn", role: "status" }, h("p", { text: "Identity not complete: " }), h("ul", {}, ...id.problems.map((p) => h("li", { text: p }))))
            : null,
          fundingNotice(h, id.funding),
          h(
            "p",
            { class: "field-hint" },
            "Re-check from a shell with ",
            h("code", { text: "npm run l2:identity -- show" }),
            " and ",
            h("code", { text: "npm run l2:identity -- check-funding" }),
            "."
          ),
          h("div", { class: "actions" }, h("button", { class: "btn btn-secondary", type: "button", disabled: state.l2Busy, onClick: () => load(true), text: state.l2Busy ? "Checking…" : "Check funding" }))
        )
  );
}

export const siteSetupSteps = [siteStep, l2Step];

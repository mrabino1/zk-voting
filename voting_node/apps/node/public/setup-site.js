/**
 * NOT FOR PROFIT — ZK-Voting is a civic public good. Not a commercial product.
 *
 * First-run setup steps 5 and 6 (plugged into setup.js via ctx.setupExtraSteps):
 *   5. Site and environment: what ./setup.sh (voting_node/.env) set for this
 *      deployment, read-only, plus the product name (saved in the app).
 *   6. Rollup connection: GET /api/setup/rollup. ZkVotingRollup address, L1
 *      chain, the node account and its L1 balance (warning when low or empty),
 *      and whether the L2 operator answers.
 * Secrets (setup token, database URL, ROLLUP_PRIVATE_KEY, L2_BALLOT_TOKEN)
 * never reach this page; they live in env only.
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

function formatEth(wei) {
  const w = BigInt(wei || 0);
  const whole = w / 10n ** 18n;
  const frac = (w % 10n ** 18n).toString().padStart(18, "0").slice(0, 6);
  return `${whole}.${frac} ETH`;
}

function fundingNotice(h, f) {
  if (!f) return null;
  const warn = f.level === "low" || f.level === "empty";
  const text =
    f.level === "ok"
      ? `Node account funded: ${formatEth(f.balanceWei)} (about ${f.callsLeft} L1 calls).`
      : f.level === "low"
        ? `Node account balance is low: ${formatEth(f.balanceWei)} covers about ${f.callsLeft} L1 calls. Top it up before publishing votes.`
        : `Node account cannot pay for an L1 call: ${formatEth(f.balanceWei)}. Publishing and finalizing votes will fail until it is funded.`;
  return h(
    "div",
    { class: warn ? "notice notice-warn" : "notice notice-ok", role: warn ? "alert" : "status", id: "setup-rollup-funding" },
    h("p", {}, warn ? h("strong", { text: `Warning: L1 balance ${f.level}. ` }) : null, text)
  );
}

function rollupStep(ctx) {
  const { h, state, isSuper, paint, stepBadge } = ctx;
  const s = state.status;
  const r = state.rollup;
  const done = Boolean(r?.configured && r?.l2Reachable && r?.funding?.level === "ok");
  const head = h("h2", { id: "setup-rollup-h" }, stepBadge(6, done), " Rollup connection");
  const load = async () => {
    state.rollupBusy = true;
    paint();
    try {
      const res = await fetch("/api/setup/rollup", { headers: { accept: "application/json" }, credentials: "same-origin" });
      state.rollup = await res.json();
      state.rollupError = res.ok ? "" : state.rollup?.error || `HTTP ${res.status}`;
    } catch (err) {
      state.rollupError = err?.message || "Could not reach /api/setup/rollup.";
    } finally {
      state.rollupBusy = false;
      paint();
    }
  };
  if (isSuper() && state.rollup === undefined && !state.rollupBusy) {
    state.rollup = null;
    queueMicrotask(load);
  }
  if (!isSuper()) {
    return h("section", { class: "panel setup-step", "aria-labelledby": "setup-rollup-h" }, head, h("p", { class: "field-hint", text: s?.setupComplete ? "Setup is finished." : "Create the super admin first." }));
  }
  const yesNo = (v) => (v == null ? null : v ? "yes" : "no");
  return h(
    "section",
    { class: `panel setup-step${done ? " is-done" : ""}`, "aria-labelledby": "setup-rollup-h" },
    head,
    h(
      "p",
      {},
      "Civic votes settle on ZkVotingRollup, the one L1 contract every jurisdiction shares. Polls stay on this node. Voters never pay: this node's account (",
      h("code", { text: "ROLLUP_PRIVATE_KEY" }),
      ") pays L1 gas to publish, close and finalize votes, and the L2 operator pays for vote batches. ",
      h("code", { text: RERUN }),
      " writes these settings to the environment; keys are never shown here."
    ),
    state.rollupError ? h("div", { class: "notice notice-error", role: "alert" }, h("p", { text: state.rollupError })) : null,
    !r
      ? h("p", { class: "muted", text: "Loading…" })
      : h(
          "div",
          { class: "stack" },
          h(
            "dl",
            { class: "status-dl", id: "setup-rollup-status" },
            ...row(h, "Rollup contract", r.address ? h("code", { text: r.address }) : null),
            ...row(h, "L1 chain id", r.chainId != null ? String(r.chainId) : null),
            ...row(h, "Jurisdiction id", r.jurisdictionId ? h("code", { text: r.jurisdictionId }) : null),
            ...row(h, "Node account", r.nodeAccount ? h("code", { text: r.nodeAccount }) : null),
            ...row(h, "Node key", r.keySet ? "set (not shown)" : null),
            ...row(h, "L2 operator", r.l2Url ? h("code", { text: r.l2Url }) : null),
            ...row(h, "L2 reachable", yesNo(r.l2Reachable))
          ),
          r.problems?.length
            ? h("div", { class: "notice notice-warn", role: "status" }, h("p", { text: "Not connected yet:" }), h("ul", {}, ...r.problems.map((p) => h("li", { text: p }))))
            : null,
          fundingNotice(h, r.funding),
          h("div", { class: "actions" }, h("button", { class: "btn btn-secondary", type: "button", disabled: state.rollupBusy, onClick: load, text: state.rollupBusy ? "Checking…" : "Check again" }))
        )
  );
}

export const siteSetupSteps = [siteStep, rollupStep];

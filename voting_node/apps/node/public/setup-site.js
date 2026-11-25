/**
 * NOT FOR PROFIT — ZK-Voting is a civic public good. Not a commercial product.
 *
 * First-run setup steps 5 and 6 (plugged into setup.js via ctx.setupExtraSteps):
 *   5. Website address: the host name, public URL and database this deployment
 *      runs with, and where each came from (the hosting platform, e.g. Coolify's
 *      domain, or an environment variable), plus the product name (saved in the app).
 *   6. How civic votes are counted: GET/PUT /api/setup/voting. Polls only, the
 *      built-in test chain, or the shared ZkVotingRollup on a public network from
 *      packages/chain-client/networks.json. Then GET /api/setup/rollup: the
 *      contract, the node account and its L1 balance, and whether the L2 answers.
 * Secrets (setup token, database URL, private keys, L2_BALLOT_TOKEN) never reach
 * this page. Generated keys stay on the server; only their public addresses show.
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
  const head = h("h2", { id: "setup-site-h" }, stepBadge(5, Boolean(site?.productNameSaved || s?.setupComplete)), " Website address");
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
    site.insecureHttp
      ? h(
          "div",
          { class: "notice notice-warn", role: "alert", id: "setup-site-http" },
          h("p", {}, h("strong", { text: "This site is on plain http. " }), "Passkeys (how voters and officials sign in) only work over https. In Coolify, open the node service, set ", h("strong", { text: "Domains" }), " to your own address with https, for example ", h("code", { text: "https://vote.example.org" }), ", and redeploy. Do this before anyone registers: passkeys are tied to the address.")
        )
      : null,
    h("p", {}, addressHelp(h, site)),
    h(
      "dl",
      { class: "status-dl", id: "setup-site-env" },
      ...row(h, "Public hostname", site.voteFqdn ? [h("code", { text: site.voteFqdn }), sourceTag(h, site.sources?.voteFqdn)] : null),
      ...row(h, "Public URL", site.publicOrigin ? h("code", { text: site.publicOrigin }) : null),
      ...row(h, "Passkey RP ID", site.rpId ? h("code", { text: site.rpId }) : null),
      ...row(h, "Behind a proxy", site.trustProxy ? [`yes (TRUST_PROXY=${site.trustProxy})`, sourceTag(h, site.sources?.trustProxy)] : "no"),
      ...row(h, "App port (in the container)", String(site.port ?? "")),
      ...row(h, "Database", site.database === "postgres" ? ["Postgres (connection not shown)", sourceTag(h, site.sources?.database)] : "JSON files in the data volume"),
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
        ),
    identityForm(h, ctx)
  );
}

const SOURCE_TEXT = {
  platform: "from your hosting platform",
  environment: "set as an environment variable",
  setup: "chosen on this page",
};

function sourceTag(h, source) {
  const text = SOURCE_TEXT[source];
  return text ? h("span", { class: "muted", text: ` (${text})` }) : null;
}

/** Where to change the address, in the words of how this deployment is run. */
function addressHelp(h, site) {
  const fromPlatform = site.sources?.voteFqdn === "platform";
  if (fromPlatform) {
    return [
      "These follow the domain your hosting platform gives the site. To change the address, change the node service's domain in Coolify and redeploy; nothing else to edit. To pin a different one, set ",
      h("code", { text: "VOTE_FQDN" }),
      " in Coolify's Environment Variables.",
    ];
  }
  return [
    "These come from environment variables. In Coolify, edit them under Environment Variables and redeploy. On your own server, run ",
    h("code", { text: RERUN }),
    " (it rewrites ",
    h("code", { text: "voting_node/.env" }),
    ") and restart.",
  ];
}

/**
 * "Who runs this site": the footer contact and the source / project / forum links.
 * This repository is forked; a fork's footer must not send visitors to the upstream
 * project's inbox. Editable after setup finishes (PUT /api/setup/identity).
 */
function identityForm(h, { state, run, api, isSuper }) {
  const site = state.status?.site;
  const id = site?.identity;
  if (!id || !isSuper()) return null;
  if (!state.identity) {
    state.identity = {
      contactEmail: id.contactEmail || "",
      contractingCta: Boolean(id.contractingCta),
      sourceUrl: id.sourceUrl || "",
      projectUrl: id.projectUrl || "",
      forumUrl: id.forumUrl || "",
    };
  }
  const f = state.identity;
  const fixedNote = (field) =>
    id.sources?.[field] === "environment" ? h("span", { class: "field-hint", text: "Currently set by an environment variable; saving here overrides it." }) : null;
  const input = (field, label, hint, type = "url") =>
    h(
      "label",
      { class: "field", for: `setup-identity-${field}` },
      h("span", { class: "field-label", text: label }),
      h("input", {
        id: `setup-identity-${field}`,
        type,
        autocomplete: "off",
        spellcheck: "false",
        value: f[field],
        onInput: (e) => {
          f[field] = e.target.value;
        },
      }),
      h("span", { class: "field-hint", text: hint }),
      fixedNote(field)
    );
  const save = (event) => {
    event.preventDefault();
    run(async () => {
      state.status = await api("/api/setup/identity", {
        method: "PUT",
        body: {
          contactEmail: f.contactEmail,
          contractingCta: f.contractingCta,
          sourceUrl: f.sourceUrl,
          projectUrl: f.projectUrl || "none",
          forumUrl: f.forumUrl || "none",
        },
      });
      state.identity = null;
      state.info = "Saved. Every page's footer now shows these.";
    });
  };
  return h(
    "form",
    { class: "stack", onSubmit: save, id: "setup-identity" },
    h("h3", { text: "Who runs this site" }),
    h("p", { class: "field-hint", text: "Shown in every page's footer. Leave the contact empty to show none; the upstream project's address is never used on your site." }),
    input("contactEmail", "Public contact email", "Where visitors can reach the people who run this site.", "email"),
    h(
      "label",
      { class: "check-row", for: "setup-identity-contractingCta" },
      h("input", {
        id: "setup-identity-contractingCta",
        type: "checkbox",
        checked: f.contractingCta,
        onChange: (e) => {
          f.contractingCta = Boolean(e.target.checked);
        },
      }),
      h("span", { text: "Offer implementation help to other organisations in the footer (needs a contact email)." })
    ),
    input(
      "sourceUrl",
      "Source code of this site",
      "Your fork's repository, for example https://github.com/your-org/zk-voting. The AGPL licence requires a site running modified code to offer its own source."
    ),
    input("projectUrl", "About the project", "Where the About link points. Empty hides it."),
    input("forumUrl", "Community forum", "Your own Discourse, the project's forum, or empty to hide it."),
    h("div", { class: "actions" }, h("button", { class: "btn", type: "submit", disabled: state.busy, text: "Save site details" }))
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

const MODE_TEXT = {
  polls: {
    title: "Polls only",
    body: "Counted on this server. No blockchain, nothing to pay. Good for organisations, surveys and token polls. Civic votes stay switched off.",
  },
  "local-test": {
    title: "Built-in test chain",
    body: "Civic votes run on a private practice Ethereum chain inside this deployment. Free, nothing of value at stake. Use it to learn the system and run rehearsals; switch to a public network before a real election.",
  },
  shared: {
    title: "A public Ethereum network",
    body: "Civic votes settle on the one shared, audited ZkVotingRollup contract that every zk-voting site uses. This server gets its own accounts, and you fund them with ETH for gas. Voters never pay.",
  },
  environment: {
    title: "Set in the environment",
    body: "The rollup settings are fixed by environment variables, so this page shows them but leaves them alone.",
  },
};

function explorerLink(h, network, address) {
  if (!network?.explorer || !address) return h("code", { text: address || "" });
  return h("a", { href: `${network.explorer}/address/${address}`, target: "_blank", rel: "noopener noreferrer" }, h("code", { text: address }));
}

/** After a save the node and l2 restart. Wait until /health answers again, then reload state. */
async function waitForRestart(timeoutMs = 90_000) {
  const t0 = Date.now();
  let sawDown = false;
  await new Promise((r) => setTimeout(r, 1500));
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch("/health", { cache: "no-store" });
      if (res.ok && (sawDown || Date.now() - t0 > 8000)) return true;
      if (!res.ok) sawDown = true;
    } catch {
      sawDown = true;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

function rollupStep(ctx) {
  const { h, state, isSuper, run, api, paint, stepBadge } = ctx;
  const s = state.status;
  const v = state.voting;
  const r = state.rollup;
  const mode = v?.mode || null;
  const done = Boolean(mode && mode !== "environment" ? true : r?.configured && !r?.problems?.length);
  const head = h("h2", { id: "setup-rollup-h" }, stepBadge(6, done), " How civic votes are counted");

  const load = async () => {
    state.rollupBusy = true;
    paint();
    try {
      const [vr, rr] = await Promise.all([
        fetch("/api/setup/voting", { headers: { accept: "application/json" }, credentials: "same-origin" }),
        fetch("/api/setup/rollup", { headers: { accept: "application/json" }, credentials: "same-origin" }),
      ]);
      state.voting = vr.ok ? await vr.json() : null;
      state.rollup = await rr.json();
      state.rollupError = rr.ok ? "" : state.rollup?.error || `HTTP ${rr.status}`;
      if (state.votingChoice == null) state.votingChoice = state.voting?.mode && state.voting.mode !== "environment" ? state.voting.mode : "polls";
      if (state.votingNetwork == null) state.votingNetwork = state.voting?.network && state.voting.network !== "local-test" ? state.voting.network : "";
    } catch (err) {
      state.rollupError = err?.message || "Could not reach the setup API.";
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

  const networks = v?.networks || [];
  const publicNets = networks.filter((n) => !n.builtIn);
  const chosenNet = publicNets.find((n) => n.id === state.votingNetwork) || null;
  const locked = v?.lockedByEnvironment?.length > 0;
  const stranded = v?.published?.length > 0;

  const save = (event) => {
    event.preventDefault();
    const body = { mode: state.votingChoice };
    if (body.mode === "shared") {
      body.network = state.votingNetwork;
      body.l1Rpc = state.votingRpc || "";
    }
    run(async () => {
      const saved = await api("/api/setup/voting", { method: "PUT", body });
      state.voting = saved;
      if (saved.restarting) {
        state.info = "Saved. The site is restarting to apply it; this page reconnects by itself in about 20 seconds.";
        paint();
        const back = await waitForRestart();
        state.info = back ? `Saved: ${MODE_TEXT[saved.saved.mode].title}.` : "Saved, but the site has not come back yet. Reload this page in a minute.";
      } else {
        state.info = `Saved: ${MODE_TEXT[saved.saved.mode].title}. Restart the app (node and l2) to apply it.`;
      }
      state.rollup = undefined;
      state.voting = undefined;
    });
  };

  const choice = (id) => {
    const t = MODE_TEXT[id];
    return h(
      "label",
      { class: `choice choice-card${state.votingChoice === id ? " is-selected" : ""}`, for: `setup-voting-${id}` },
      h("input", {
        id: `setup-voting-${id}`,
        type: "radio",
        name: "votingMode",
        value: id,
        checked: state.votingChoice === id,
        disabled: locked || state.busy,
        onChange: () => {
          state.votingChoice = id;
          paint();
        },
      }),
      h("span", {}, h("strong", { text: t.title }), h("span", { class: "field-hint", text: t.body }))
    );
  };

  const sharedFields =
    state.votingChoice === "shared"
      ? h(
          "div",
          { class: "stack", id: "setup-voting-shared" },
          h(
            "label",
            { class: "field", for: "setup-voting-network" },
            h("span", { class: "field-label", text: "Network" }),
            h(
              "select",
              {
                id: "setup-voting-network",
                disabled: locked || state.busy,
                onChange: (e) => {
                  state.votingNetwork = e.target.value;
                  paint();
                },
              },
              h("option", { value: "", text: "Choose a network…", selected: !state.votingNetwork }),
              ...publicNets.map((n) =>
                h("option", { value: n.id, selected: state.votingNetwork === n.id, text: `${n.name}${n.available ? "" : " (not available yet)"}` })
              )
            ),
            chosenNet ? h("span", { class: "field-hint", text: `${chosenNet.summary} Chain id ${chosenNet.chainId}, filled in for you.` }) : null
          ),
          chosenNet && !chosenNet.available
            ? h("div", { class: "notice notice-warn", role: "status", id: "setup-voting-unavailable" }, h("p", { text: chosenNet.availabilityNote }))
            : null,
          chosenNet && chosenNet.available
            ? h(
                "label",
                { class: "field", for: "setup-voting-rpc" },
                h("span", { class: "field-label", text: `RPC address for ${chosenNet.name}` }),
                h("input", {
                  id: "setup-voting-rpc",
                  type: "url",
                  inputmode: "url",
                  autocomplete: "off",
                  spellcheck: "false",
                  placeholder: "https://…",
                  value: state.votingRpc || "",
                  required: true,
                  onInput: (e) => {
                    state.votingRpc = e.target.value;
                  },
                }),
                h(
                  "span",
                  { class: "field-hint" },
                  "How this server talks to Ethereum. We check it is really on ",
                  chosenNet.name,
                  " before saving. ",
                  ...(chosenNet.rpcHints || []).map((hint) => `${hint} `)
                )
              )
            : null
        )
      : null;

  const canSave =
    !locked &&
    !(stranded && state.votingChoice !== v?.mode) &&
    (state.votingChoice !== "shared" || (chosenNet && chosenNet.available));

  const keys = v?.keys || {};
  const fundNet = networks.find((n) => n.id === v?.network);
  const fundPanel =
    v?.mode === "shared" && (keys.nodeAddress || keys.operatorAddress)
      ? h(
          "div",
          { class: "notice", role: "status", id: "setup-voting-fund" },
          h("p", {}, h("strong", { text: "Fund this server's two accounts. " }), "They pay Ethereum gas; voters never pay. The private keys were generated on this server and are never shown here."),
          h(
            "dl",
            { class: "status-dl" },
            ...row(h, "Node account (publishes and finalizes votes)", explorerLink(h, fundNet, keys.nodeAddress)),
            ...row(h, "L2 operator account (submits vote batches)", explorerLink(h, fundNet, keys.operatorAddress))
          ),
          fundNet?.faucet ? h("p", {}, "Test ETH for this network is free: ", h("a", { href: fundNet.faucet, target: "_blank", rel: "noopener noreferrer", text: "faucet" }), ".") : null,
          fundNet?.joinPolicy === "governor-approval"
            ? h(
                "p",
                { class: "field-hint" },
                "Today the shared contract's governor must also approve the operator account and create a jurisdiction for this site before civic votes can be published. Send them the two addresses above. The planned per-L2 contract (docs/proposals/PER-L2-ROLLUP.md) removes this step: each site will register its own L2."
              )
            : null
        )
      : null;

  return h(
    "section",
    { class: `panel setup-step${done ? " is-done" : ""}`, "aria-labelledby": "setup-rollup-h" },
    head,
    h(
      "p",
      {},
      "Polls are always counted on this server. Civic votes, the strongest privacy this system offers, are counted on Ethereum: only the final total is ever decrypted, and Ethereum checks it. Choose where. You can change this later, until the first civic vote is published."
    ),
    state.rollupError ? h("div", { class: "notice notice-error", role: "alert" }, h("p", { text: state.rollupError })) : null,
    !v && !r
      ? h("p", { class: "muted", text: "Loading…" })
      : h(
          "div",
          { class: "stack" },
          v && !v.available
            ? h("div", { class: "notice", role: "status" }, h("p", { text: "This deployment has no shared settings volume, so the choice below cannot be saved from here. Use docker-compose.coolify.yml, or set the rollup variables in the environment (./setup.sh)." }))
            : null,
          locked
            ? h("div", { class: "notice", role: "status", id: "setup-voting-locked" }, h("p", {}, "Fixed by environment variables: ", h("code", { text: v.lockedByEnvironment.join(", ") }), ". Remove them in your hosting settings to choose here instead."))
            : null,
          stranded
            ? h("div", { class: "notice notice-warn", role: "status" }, h("p", { text: `Civic votes are already on the current chain (${v.published.map((e) => e.title).join(", ")}), so the choice is locked to keep them countable.` }))
            : null,
          v?.available
            ? h(
                "form",
                { class: "stack", onSubmit: save, id: "setup-voting-form" },
                h("fieldset", { class: "choice-list" }, h("legend", { class: "field-label", text: "Where civic votes are counted" }), choice("polls"), choice("local-test"), choice("shared")),
                sharedFields,
                h(
                  "div",
                  { class: "actions" },
                  h("button", { class: "btn", type: "submit", disabled: state.busy || !canSave, text: state.busy ? "Saving…" : "Save and apply" })
                )
              )
            : null,
          fundPanel,
          r
            ? h(
                "details",
                { class: "setup-connection", open: Boolean(r.problems?.length && mode && mode !== "polls") },
                h("summary", { text: "Connection check" }),
                h(
                  "dl",
                  { class: "status-dl", id: "setup-rollup-status" },
                  ...row(h, "Rollup contract", r.address ? h("code", { text: r.address }) : null),
                  ...row(h, "Ethereum chain id", r.chainId != null ? String(r.chainId) : null),
                  ...row(h, "Jurisdiction id", r.jurisdictionId ? h("code", { text: r.jurisdictionId }) : null),
                  ...row(h, "Node account", r.nodeAccount ? h("code", { text: r.nodeAccount }) : null),
                  ...row(h, "L2 operator", r.l2 ? r.l2.status : r.l2Reachable == null ? null : r.l2Reachable ? "ok" : "not reachable")
                ),
                mode === "polls"
                  ? h("p", { class: "field-hint", text: "Polls only: no Ethereum connection is needed." })
                  : r.problems?.length
                    ? h("div", { class: "notice notice-warn", role: "status" }, h("p", { text: "Not connected yet:" }), h("ul", {}, ...r.problems.map((p) => h("li", { text: p }))))
                    : null,
                fundingNotice(h, r.funding),
                h("div", { class: "actions" }, h("button", { class: "btn btn-secondary", type: "button", disabled: state.rollupBusy, onClick: load, text: state.rollupBusy ? "Checking…" : "Check again" }))
              )
            : null
        )
  );
}

export const siteSetupSteps = [siteStep, rollupStep];

/**
 * NOT FOR PROFIT — civic public good, not a commercial product.
 * zk-voting ceremony coordinator. Platform super admin only (the Node
 * enforces this on every /api/ceremony-admin route; this page only mirrors it).
 * TODO(manage_ceremony): when a delegable manage_ceremony capability exists,
 * gate on it here and in apps/node/src/routes/ceremony.mjs.
 */

import "./i18n.js";
import {
  fill,
  announce,
  api,
  el,
  errorText,
  fmtBytes,
  fmtTime,
  hashCode,
  statusPill,
  waitForJob,
} from "./ceremony-common.js";

const root = document.getElementById("admin-root");
const flash = document.getElementById("admin-flash");
const gate = document.getElementById("ceremony-gate");
let options = null;
let uid = 0;
const nextId = (p) => `${p}-${++uid}`;

function field(label, control, hint) {
  const id = control.id || nextId("f");
  control.id = id;
  const hintId = hint ? `${id}-hint` : null;
  if (hintId) control.setAttribute("aria-describedby", hintId);
  return el(
    "div",
    { class: "field" },
    el("label", { class: "field-label", for: id }, label),
    control,
    hint ? el("p", { class: "field-hint", id: hintId }, hint) : null
  );
}

function select(name, choices, value) {
  return el(
    "select",
    { name },
    ...choices.map(([v, label]) => el("option", { value: v, selected: String(v) === String(value) }, label))
  );
}

async function run(fn, ok) {
  try {
    const out = await fn();
    if (ok) announce(flash, ok, "ok");
    return out;
  } catch (err) {
    announce(flash, errorText(err), "error");
    return null;
  } finally {
    await render();
  }
}

// ---------- inputs ----------

function inputsPanel() {
  const file = el("input", { type: "file", name: "file", accept: ".r1cs,.ptau" });
  const status = el("p", { role: "status", "aria-live": "polite" });
  const form = el(
    "form",
    {
      class: "stack",
      onSubmit: async (e) => {
        e.preventDefault();
        const f = file.files?.[0];
        if (!f) {
          status.textContent = "Choose an .r1cs or .ptau file first.";
          return;
        }
        if (f.size > options.maxInputBytes) {
          status.textContent = `That file is ${fmtBytes(f.size)}. The upload limit is ${fmtBytes(options.maxInputBytes)}; copy it into the input directory on the server instead.`;
          return;
        }
        status.textContent = `Uploading ${f.name} (${fmtBytes(f.size)})…`;
        await run(
          () =>
            api(`/api/ceremony-admin/inputs?name=${encodeURIComponent(f.name)}`, {
              method: "POST",
              headers: { "content-type": "application/octet-stream" },
              body: f,
            }),
          `Uploaded ${f.name}.`
        );
      },
    },
    field("Circuit or phase-1 file", file, `.r1cs or .ptau, up to ${fmtBytes(options.maxInputBytes)}. Files are never overwritten.`),
    el("div", { class: "cta-row" }, el("button", { class: "btn btn-secondary", type: "submit" }, "Upload")),
    status
  );
  return el(
    "section",
    { class: "panel", "aria-labelledby": "inputs-h" },
    el("h2", { id: "inputs-h" }, "1. Inputs"),
    el(
      "p",
      {},
      "The server never downloads a ptau. Fetch it yourself (Hermez files are listed below with their published BLAKE2b hashes), then upload it here or copy it into ",
      el("code", { class: "mono" }, options.inputDir),
      "."
    ),
    options.inputs.length
      ? el(
          "div",
          { class: "table-wrap" },
          el(
            "table",
            { class: "data-table" },
            el("caption", { class: "sr-only" }, "Files in the ceremony input directory"),
            el("thead", {}, el("tr", {}, ...["File", "Kind", "Size"].map((h) => el("th", { scope: "col" }, h)))),
            el(
              "tbody",
              {},
              ...options.inputs.map((i) => el("tr", {}, el("th", { scope: "row" }, el("code", { class: "mono" }, i.name)), el("td", {}, i.kind), el("td", {}, fmtBytes(i.bytes))))
            )
          )
        )
      : el("p", { class: "empty" }, "No inputs yet."),
    form,
    el(
      "details",
      {},
      el("summary", {}, "Hermez phase-1 files (powers 10 to 20)"),
      el(
        "ul",
        { class: "ptau-list" },
        ...options.ptauPresets.map((p) =>
          el("li", {}, `Power ${p.power} (up to ${(2 ** p.power).toLocaleString()} constraints): `, el("code", { class: "mono" }, p.url), " ", hashCode(p.blake2b, "BLAKE2b-512"))
        )
      )
    )
  );
}

// ---------- create ----------

function createPanel() {
  const r1csFiles = options.inputs.filter((i) => i.kind === "r1cs").map((i) => [i.name, i.name]);
  const ptauFiles = options.inputs.filter((i) => i.kind === "ptau").map((i) => [i.name, i.name]);
  const name = el("input", { name: "circuitName", required: true, pattern: "[a-z0-9][a-z0-9_\\-]{0,47}", maxlength: "48", autocomplete: "off" });
  const label = el("input", { name: "label", maxlength: "120", autocomplete: "off" });
  const r1cs = select("r1cs", [["", "Choose…"], ...r1csFiles], "");
  const r1csPin = el("input", { name: "r1csSha256", class: "mono", maxlength: "64", autocomplete: "off", spellcheck: "false" });
  const ptau = select("ptau", [["", "Choose…"], ...ptauFiles], "");
  const preset = select("ptauPower", [["", "Not a Hermez file (pin a hash below)"], ...options.ptauPresets.map((p) => [p.power, `Hermez power ${p.power}`])], "");
  const pin = el("input", { name: "ptauHash", class: "mono", maxlength: "128", autocomplete: "off", spellcheck: "false" });
  const min = el("input", { name: "minContributions", type: "number", min: "2", max: "1000", value: "3", required: true });
  const turn = el("input", { name: "turnMinutes", type: "number", min: "1", max: "1440", value: "30", required: true });
  const mode = select("mode", [["open", "Any signed-in account"], ["list", "Only the handles listed below"]], "open");
  const handles = el("textarea", { name: "handles", rows: "3" });
  ptau.addEventListener("change", () => {
    const m = ptau.value.match(/_(\d{1,2})\.ptau$/);
    if (m && options.ptauPresets.some((p) => p.power === Number(m[1]))) preset.value = m[1];
  });
  const status = el("p", { role: "status", "aria-live": "polite" });
  const form = el(
    "form",
    {
      class: "stack",
      onSubmit: async (e) => {
        e.preventDefault();
        const body = {
          circuitName: name.value.trim(),
          label: label.value.trim(),
          r1cs: r1cs.value,
          r1csSha256: r1csPin.value.trim(),
          ptau: ptau.value,
          minContributions: Number(min.value),
          participation: { mode: mode.value, handles: handles.value, turnMinutes: Number(turn.value) },
        };
        if (preset.value) body.ptauPower = Number(preset.value);
        if (pin.value.trim()) body.ptauHash = pin.value.trim();
        status.textContent = "Checking hashes and creating the setup key. A large circuit takes minutes…";
        await run(async () => {
          const out = await api("/api/ceremony-admin/ceremonies", { method: "POST", json: body });
          const job = await waitForJob(out.job.id, { intervalMs: 2000 });
          if (job.status !== "done") throw new Error(job.error || "setup failed");
          return job;
        }, `Ceremony for ${body.circuitName} is ready as a draft.`);
      },
    },
    el(
      "div",
      { class: "form-grid" },
      field("Circuit name", name, "Lowercase, for example vote_d20 or tally_8_4. Used in export file names."),
      field("Public label", label, "For example: Vote(20) ballot proof."),
      field("Circuit (.r1cs)", r1cs),
      field("r1cs SHA-256 pin (optional)", r1csPin, "Paste the hash from the reviewed build to refuse any other file."),
      field("Phase-1 file (.ptau)", ptau),
      field("Hermez preset", preset, "Pins the published BLAKE2b-512 hash for that power."),
      field("Phase-1 hash pin", pin, "64 hex (SHA-256) or 128 hex (BLAKE2b-512). Required unless a preset is chosen."),
      field("Minimum contributions", min, "At least 2. Default 3."),
      field("Who can contribute", mode),
      field("Turn length (minutes)", turn, "A participant who does not upload in time loses their place."),
      field("Invited handles", handles, "Comma or space separated. Used only when the list option is chosen. Never shown publicly.")
    ),
    el("div", { class: "cta-row" }, el("button", { class: "btn", type: "submit", disabled: !r1csFiles.length || !ptauFiles.length }, "Create ceremony")),
    status
  );
  return el("section", { class: "panel", "aria-labelledby": "create-h" }, el("h2", { id: "create-h" }, "2. New ceremony"), form);
}

// ---------- ceremony card ----------

function drandRoundFor(chain, date) {
  const c = options.drandChains[chain];
  const t = Math.ceil(date.getTime() / 1000);
  return Math.max(1, Math.ceil((t - c.genesisTime) / c.period) + 1);
}

function beaconForm(c) {
  const source = select("source", [["drand", "drand (recommended)"], ["block-hash", "Block hash"]], "drand");
  const chain = select("chain", Object.keys(options.drandChains).map((k) => [k, k === "quicknet" ? "quicknet (3 s rounds)" : "default (30 s rounds)"]), "quicknet");
  const when = el("input", { type: "datetime-local", name: "when" });
  const round = el("input", { type: "number", name: "round", min: "1" });
  const network = select("network", options.blockNetworks.map((n) => [n, n]), options.blockNetworks[0]);
  const height = el("input", { type: "number", name: "height", min: "1" });
  const drandBox = el("div", { class: "form-grid" }, field("drand chain", chain), field("Not before", when, "Pick a time after you plan to close. The round is filled in."), field("Round", round));
  const blockBox = el("div", { class: "form-grid", hidden: true }, field("Network", network), field("Block height", height, "A future block. Its hash becomes the beacon."));
  const sync = () => {
    drandBox.hidden = source.value !== "drand";
    blockBox.hidden = source.value === "drand";
  };
  source.addEventListener("change", sync);
  const fillRound = () => {
    if (when.value) round.value = String(drandRoundFor(chain.value, new Date(when.value)));
  };
  when.addEventListener("change", fillRound);
  chain.addEventListener("change", fillRound);
  return el(
    "form",
    {
      class: "stack",
      onSubmit: async (e) => {
        e.preventDefault();
        const body = source.value === "drand" ? { source: "drand", chain: chain.value, round: Number(round.value) } : { source: "block-hash", network: network.value, height: Number(height.value) };
        await run(() => api(`/api/ceremony-admin/ceremonies/${c.id}/beacon/precommit`, { method: "POST", json: body }), "Beacon committed.");
      },
    },
    el("h4", {}, "Commit the beacon"),
    el("p", { class: "field-hint" }, "Fix the public randomness before closing, so no contributor can know or steer it. It can be changed until you close."),
    field("Source", source),
    drandBox,
    blockBox,
    el("div", { class: "cta-row" }, el("button", { class: "btn btn-secondary", type: "submit" }, c.beacon?.precommit ? "Replace beacon" : "Commit beacon"))
  );
}

function finalizeForm(c) {
  const pre = c.beacon.precommit;
  const value = el("input", { name: "beaconValue", class: "mono", required: true, maxlength: "66", autocomplete: "off", spellcheck: "false" });
  const iters = el("input", { name: "iterations", type: "number", min: "1", max: "63", value: String(options.defaultBeaconIterations) });
  const ready = !pre.roundTime || pre.roundTime * 1000 <= Date.now();
  return el(
    "form",
    {
      class: "stack",
      onSubmit: async (e) => {
        e.preventDefault();
        announce(flash, "Applying the beacon and exporting. This can take minutes…");
        await run(async () => {
          const out = await api(`/api/ceremony-admin/ceremonies/${c.id}/finalize`, { method: "POST", json: { beaconValue: value.value.trim(), iterations: Number(iters.value) } });
          const job = await waitForJob(out.job.id, { intervalMs: 2000 });
          if (job.status !== "done") throw new Error(job.error || "finalize failed");
        }, "Finalized. The exports are ready for review.");
      },
    },
    el("h4", {}, "Apply the beacon and export"),
    el(
      "p",
      {},
      ready ? "Look up the committed value: " : `The committed round is published at ${fmtTime(new Date(pre.roundTime * 1000).toISOString())}. Come back then: `,
      el("a", { href: pre.lookupUrl, rel: "noopener noreferrer" }, pre.lookupUrl)
    ),
    field("Beacon value", value, pre.source === "drand" ? "The round's randomness field (64 hex)." : "The block hash (64 hex)."),
    field("Iterations (2^n hashes)", iters),
    el("div", { class: "cta-row" }, el("button", { class: "btn", type: "submit", disabled: !ready }, "Finalize"))
  );
}

function ceremonyCard(c) {
  const actions = [];
  const btn = (text, path, ok, cls = "btn") =>
    el("button", { class: cls, type: "button", onClick: () => run(() => api(`/api/ceremony-admin/ceremonies/${c.id}/${path}`, { method: "POST", json: {} }), ok) }, text);
  if (c.status === "draft") actions.push(btn("Open for contributions", "open", "Ceremony opened."));
  if (c.status === "open") {
    const enough = c.contributions.length >= c.minContributions;
    actions.push(
      el(
        "button",
        {
          class: "btn",
          type: "button",
          disabled: !enough || !c.beacon?.precommit,
          onClick: () => run(() => api(`/api/ceremony-admin/ceremonies/${c.id}/close`, { method: "POST", json: {} }), "Contribution window closed."),
        },
        "Close window"
      )
    );
    if (!enough) actions.push(el("p", { class: "field-hint" }, `Close needs ${c.minContributions - c.contributions.length} more contribution(s).`));
    else if (!c.beacon?.precommit) actions.push(el("p", { class: "field-hint" }, "Commit a beacon before closing."));
  }
  const queue =
    c.status === "open" && c.queue.length
      ? el(
          "div",
          { class: "table-wrap" },
          el(
            "table",
            { class: "data-table" },
            el("caption", {}, "Queue"),
            el("thead", {}, el("tr", {}, ...["#", "Handle", "Joined", "Turn started", ""].map((h) => el("th", { scope: "col" }, h)))),
            el(
              "tbody",
              {},
              ...c.queue.map((q) =>
                el(
                  "tr",
                  {},
                  el("td", {}, String(q.position)),
                  el("th", { scope: "row" }, q.handle),
                  el("td", {}, fmtTime(q.joinedAt)),
                  el("td", {}, q.uploading ? "Verifying upload" : fmtTime(q.turnStartedAt)),
                  el(
                    "td",
                    {},
                    el(
                      "button",
                      {
                        class: "btn btn-secondary btn-inline",
                        type: "button",
                        disabled: q.uploading,
                        "aria-label": `Remove ${q.handle} from the queue`,
                        onClick: () => run(() => api(`/api/ceremony-admin/ceremonies/${c.id}/queue/remove`, { method: "POST", json: { position: q.position } }), `Removed ${q.handle}.`),
                      },
                      "Remove"
                    )
                  )
                )
              )
            )
          )
        )
      : null;
  const pre = c.beacon?.precommit;
  return el(
    "article",
    { class: "panel ceremony-card", "aria-labelledby": `c-${c.id}` },
    el("h3", { id: `c-${c.id}` }, c.label || c.circuitName, " ", el("code", { class: "mono" }, c.circuitName)),
    el("p", {}, statusPill(c.status), " ", el("a", { href: `/ceremony/${c.id}` }, "Public page"), " · ", el("a", { href: `/ceremony/${c.id}/transcript` }, "Transcript")),
    c.error ? el("p", { class: "notice notice-error" }, c.error) : null,
    el(
      "dl",
      { class: "meta-list" },
      el("dt", {}, "Constraints"),
      el("dd", {}, c.circuit?.constraints != null ? String(c.circuit.constraints) : "—"),
      el("dt", {}, "Contributions"),
      el("dd", {}, `${c.contributions.length} (minimum ${c.minContributions})`),
      el("dt", {}, "Participation"),
      el("dd", {}, c.participation.mode === "list" ? `List of ${c.participation.handles.length}` : "Any signed-in account", `, ${c.participation.turnMinutes}-minute turns`),
      el("dt", {}, "Beacon"),
      el("dd", {}, pre ? (pre.source === "drand" ? `drand ${pre.chain} round ${pre.round}` : `${pre.network} block ${pre.height}`) : "Not committed"),
      el("dt", {}, "Audit chain"),
      el("dd", {}, c.auditChain?.ok ? `Intact (${c.audit.length} entries)` : "BROKEN")
    ),
    actions.length ? el("div", { class: "cta-row" }, ...actions) : null,
    queue,
    c.status === "open" || c.status === "draft" ? beaconForm(c) : null,
    c.status === "closed" && pre ? finalizeForm(c) : null,
    c.exported
      ? el(
          "div",
          {},
          el("h4", {}, "Exports (pending human review)"),
          el("p", { class: "field-hint" }, "Stored in this Node's data directory. Not deployed and not copied into smart-contracts/."),
          el("ul", { class: "link-rows" }, ...Object.entries(c.exported.files).map(([f, sha]) => el("li", {}, el("a", { href: `/api/ceremonies/${c.id}/export/${encodeURIComponent(f)}`, download: f }, f), " ", hashCode(sha, "SHA-256"))))
        )
      : null,
    el(
      "details",
      {},
      el("summary", {}, `Audit log (${c.audit.length})`),
      el(
        "ol",
        { class: "audit-list mono" },
        ...c.audit
          .slice()
          .reverse()
          .map((a) => el("li", { value: String(a.seq) }, `${fmtTime(a.at)} · ${a.action}${a.actor ? ` · ${a.actor.handle}` : ""}`))
      )
    )
  );
}

async function render() {
  try {
    options = await api("/api/ceremony-admin/options");
  } catch (err) {
    if (err.status === 401) {
      window.location.replace(`/signin?next=${encodeURIComponent(window.location.pathname)}`);
      return;
    }
    if (err.status === 403) {
      gate.hidden = false;
      fill(root);
      return;
    }
    fill(root, el("p", { class: "notice notice-error" }, `Could not load: ${errorText(err)}`));
    return;
  }
  const { ceremonies } = await api("/api/ceremony-admin/ceremonies");
  const focusId = document.activeElement?.id;
  fill(root, 
    el(
      "section",
      { class: "panel", "aria-labelledby": "list-h" },
      el("h2", { id: "list-h" }, "3. Ceremonies"),
      ceremonies.length ? el("div", { class: "stack" }, ...ceremonies.map(ceremonyCard)) : el("p", { class: "empty" }, "No ceremonies yet. Add inputs, then create one per production circuit.")
    ),
    inputsPanel(),
    createPanel()
  );
  if (focusId) document.getElementById(focusId)?.focus();
}

render();

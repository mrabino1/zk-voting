/**
 * NOT FOR PROFIT — civic public good, not a commercial product.
 * zk-voting trusted-setup ceremony: public list and participant view.
 *
 * Privacy: the entropy you add (pointer and key timings plus
 * crypto.getRandomValues) stays in this tab. Only the new .zkey file, your
 * chosen public name, and an optional attestation are uploaded.
 *
 * Optional entropy string: paste a zk-entropy string (zke1:…, for example a
 * closed public ceremony's output, or one made with the zk-entropy CLI) or a
 * bare 64-hex value. It is validated here (checksum) and mixed into the
 * contribution together with the pad entropy and fresh OS randomness, so it
 * can only add to it. The super admin gets the value saved in first-run setup
 * prefilled. See docs/ceremony-web.md.
 */

import "./i18n.js";
import {
  fill,
  announce,
  api,
  download,
  el,
  errorText,
  fmtBytes,
  fmtTime,
  hashCode,
  runWorker,
  saveJson,
  sha256Hex,
  statusPill,
  waitForJob,
} from "./ceremony-common.js";
import { parseEntropyString } from "./vendor/zk-entropy.js";

const root = document.getElementById("ceremony-root");
const flash = document.getElementById("ceremony-flash");
const ENTROPY_TARGET = 256; // events to collect before the bar is full
let pollTimer = null;
let busy = false;

function ceremonyIdFromPath() {
  const m = window.location.pathname.match(/^\/ceremony\/([^/]+)\/?$/);
  return m ? decodeURIComponent(m[1]) : null;
}

async function loadMe() {
  try {
    const me = await api("/api/me");
    return me?.user || null;
  } catch {
    return null;
  }
}

// ---------- list ----------

async function renderList() {
  const { ceremonies } = await api("/api/ceremonies");
  const items = ceremonies.filter((c) => c.status !== "initializing" && c.status !== "draft");
  fill(root, 
    el(
      "section",
      { class: "panel", "aria-labelledby": "cer-list-h" },
      el("h2", { id: "cer-list-h" }, "Ceremonies"),
      items.length
        ? el(
            "div",
            { class: "table-wrap" },
            el(
              "table",
              { class: "data-table" },
              el("caption", { class: "sr-only" }, "Trusted-setup ceremonies on this Node"),
              el(
                "thead",
                {},
                el("tr", {}, ...["Circuit", "Status", "Contributions", "Waiting", ""].map((h) => el("th", { scope: "col" }, h)))
              ),
              el(
                "tbody",
                {},
                ...items.map((c) =>
                  el(
                    "tr",
                    {},
                    el("th", { scope: "row" }, el("a", { href: `/ceremony/${encodeURIComponent(c.id)}` }, c.label || c.circuitName)),
                    el("td", {}, statusPill(c.status)),
                    el("td", {}, `${c.contributions} of at least ${c.minContributions}`),
                    el("td", {}, String(c.queueLength)),
                    el("td", {}, el("a", { href: `/ceremony/${encodeURIComponent(c.id)}/transcript` }, "Transcript"))
                  )
                )
              )
            )
          )
        : el("p", { class: "empty" }, "No ceremony is open on this Node yet. The platform host starts one per circuit.")
    ),
    explainer()
  );
}

function explainer() {
  return el(
    "section",
    { class: "panel prose", "aria-labelledby": "cer-why-h" },
    el("h2", { id: "cer-why-h" }, "Why a ceremony?"),
    el(
      "p",
      {},
      "zk-voting proves ballots and tallies with Groth16 zero-knowledge proofs. Groth16 needs secret setup randomness for each circuit. ",
      "Whoever knew all of it could forge proofs. The ceremony splits that secret across many people: each adds fresh randomness and throws it away."
    ),
    el(
      "ul",
      {},
      el("li", {}, "Your contribution runs in this browser tab. Your randomness is never sent to the server."),
      el("li", {}, "The server checks each upload against the previous one before accepting it."),
      el("li", {}, "A public random beacon, fixed in advance, seals the result after the last contribution."),
      el("li", {}, "Anyone can re-verify the full chain from the transcript.")
    ),
    el("p", {}, el("a", { href: "/docs/ceremony" }, "How the ceremony works"), " (operator docs)")
  );
}

// ---------- detail ----------

function factList(rows) {
  return el(
    "dl",
    { class: "meta-list" },
    ...rows.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)])
  );
}

function contributionsTable(c) {
  if (!c.contributions.length) return el("p", { class: "empty" }, "No contributions yet.");
  return el(
    "div",
    { class: "table-wrap" },
    el(
      "table",
      { class: "data-table" },
      el("caption", { class: "sr-only" }, "Accepted contributions, oldest first"),
      el(
        "thead",
        {},
        el("tr", {}, ...["#", "Name", "Contribution hash", "Accepted"].map((h) => el("th", { scope: "col" }, h)))
      ),
      el(
        "tbody",
        {},
        ...c.contributions.map((x) =>
          el(
            "tr",
            {},
            el("td", {}, String(x.index)),
            el("th", { scope: "row" }, x.name),
            el("td", {}, hashCode(x.contributionHash, "Contribution hash")),
            el("td", {}, fmtTime(x.acceptedAt))
          )
        )
      )
    )
  );
}

function turnPanel(c, user) {
  const section = el("section", { class: "panel", id: "turn", "aria-labelledby": "turn-h" }, el("h2", { id: "turn-h" }, "Contribute"));
  const add = (...nodes) => section.append(...nodes);
  const me = c.me;

  if (c.status !== "open") {
    const why = {
      closed: "The contribution window is closed. The coordinator will apply the public beacon next.",
      finalizing: "The public beacon is being applied.",
      finalized: "This ceremony is finished. The final keys are listed below and in the transcript.",
      error: "This ceremony hit an error. The coordinator has been told.",
    };
    add(el("p", {}, why[c.status] || "This ceremony is not open for contributions yet."));
    return section;
  }
  if (!user) {
    const pending = pendingInvite(c.id);
    add(
      el(
        "p",
        {},
        pending
          ? "Sign in to accept your invite. It binds to the account you sign in with."
          : "This ceremony is invite only. If you were invited, sign in with that account to join the queue. Your account handle is never shown publicly; you pick a public name when it is your turn."
      ),
      el("p", {}, el("a", { class: "btn", href: `/signin?next=${encodeURIComponent(window.location.pathname)}` }, pending ? "Sign in to accept the invite" : "Sign in"))
    );
    return section;
  }
  if (me?.contributed) {
    add(el("p", { class: "notice notice-ok" }, "Thank you. Your contribution is in the chain."));
    const saved = readReceipt(c.id);
    if (saved) add(el("p", {}, el("button", { class: "btn btn-secondary", type: "button", onClick: () => saveJson(`zk-voting-receipt-${c.id}-${saved.index}.json`, saved) }, "Download your receipt again")));
    return section;
  }
  if (!me?.invited) {
    add(
      el(
        "div",
        { class: "notice notice-warn", id: "not-invited", role: "status" },
        el("p", {}, el("strong", {}, "Invite only. "), "Only accounts the coordinator invited can join the queue or upload, and this account is not invited."),
        el("p", {}, "If you received an invite link, open it while signed in to this account. Otherwise ask the ceremony coordinator for an invite. You can still follow along and verify the transcript.")
      )
    );
    return section;
  }
  if (!me.queued) {
    add(
      el("p", {}, `People waiting: ${c.queueLength}. Each person gets up to ${c.turnMinutes} minutes when their turn comes. Keep this tab open while you wait.`),
      el("p", {}, el("button", { class: "btn", type: "button", onClick: () => act(() => api(`/api/ceremonies/${c.id}/queue`, { method: "POST" }), "You joined the queue.") }, "Join the queue"))
    );
    return section;
  }
  if (me.verifying) {
    add(el("p", { class: "notice" }, "Your upload is being checked against the previous contribution. This page updates by itself."));
    return section;
  }
  if (!me.yourTurn) {
    add(
      el("p", {}, `You are number ${me.position} in the queue. This page checks every few seconds and tells you when it is your turn.`),
      el("p", {}, el("button", { class: "btn btn-secondary", type: "button", onClick: () => act(() => api(`/api/ceremonies/${c.id}/queue`, { method: "DELETE" }), "You left the queue.") }, "Leave the queue"))
    );
    return section;
  }
  add(...contributeFlow(c));
  return section;
}

function contributeFlow(c) {
  const ends = c.me.turnEndsAt ? ` Your turn ends at ${fmtTime(c.me.turnEndsAt)}.` : "";
  const pool = [];
  let count = 0;
  const progress = el("progress", { id: "entropy-progress", max: String(ENTROPY_TARGET), value: "0", "aria-describedby": "entropy-help" });
  const progressText = el("span", { id: "entropy-count", "aria-live": "off" }, "0%");
  const pad = el(
    "div",
    {
      class: "entropy-pad",
      id: "entropy-pad",
      tabindex: "0",
      role: "group",
      "aria-labelledby": "entropy-h",
      "aria-describedby": "entropy-help",
    },
    "Move your pointer or finger here, or focus this box and type anything."
  );
  const record = (a, b) => {
    const v = new Uint32Array(1);
    crypto.getRandomValues(v);
    pool.push((performance.now() * 1000) >>> 0, a >>> 0, b >>> 0, v[0]);
    if (count < ENTROPY_TARGET) {
      count += 1;
      progress.value = count;
      const pct = Math.round((count / ENTROPY_TARGET) * 100);
      progressText.textContent = `${pct}%`;
      if (count === ENTROPY_TARGET) announce(flash, "Enough randomness collected. You can contribute now.", "ok");
    }
  };
  pad.addEventListener("pointermove", (e) => record(e.clientX * 65536 + e.clientY, e.timeStamp * 1000));
  pad.addEventListener("keydown", (e) => {
    if (e.key === "Tab") return;
    record(e.key.codePointAt(0) || 0, e.timeStamp * 1000);
    e.preventDefault();
  });

  const pasteHint = el("p", { class: "field-hint", id: "contrib-entropy-hint", "aria-live": "polite" }, "Optional. A zk-entropy string (zke1:…), for example a closed public ceremony's output, or 64 hex characters. Mixed in with the randomness above; it never leaves this tab.");
  const pasteInput = el("textarea", { id: "contrib-entropy", name: "entropyString", rows: "2", spellcheck: "false", autocomplete: "off", "aria-describedby": "contrib-entropy-hint" });
  let pasteCheck = null;
  const checkPaste = async () => {
    const raw = pasteInput.value.trim();
    pasteCheck = raw ? await parseEntropyString(raw, { allowHex: true }) : null;
    if (!pasteCheck) {
      pasteInput.removeAttribute("aria-invalid");
      pasteHint.textContent = "Optional. Left empty, only the randomness above is used.";
    } else if (pasteCheck.ok) {
      pasteInput.setAttribute("aria-invalid", "false");
      pasteHint.textContent = pasteCheck.source === "hex" ? "64-hex value accepted (no checksum to verify)." : `Checksum OK (${pasteCheck.source} entropy, transcript ${pasteCheck.transcriptHash.slice(0, 12)}…).`;
    } else {
      pasteInput.setAttribute("aria-invalid", "true");
      pasteHint.textContent = `Not accepted: ${pasteCheck.error}.`;
    }
    return pasteCheck;
  };
  pasteInput.addEventListener("input", checkPaste);
  loadMe()
    .then((u) => (u && u.role === "platform_super_admin" ? api("/api/setup/entropy") : null))
    .then((r) => {
      if (r?.entropy?.value && !pasteInput.value) {
        pasteInput.value = r.entropy.value;
        checkPaste().then(() => (pasteHint.textContent += " Prefilled from first-run setup."));
      }
    })
    .catch(() => {});

  const nameInput = el("input", { id: "contrib-name", name: "name", class: "field-input", required: true, maxlength: "64", autocomplete: "off", "aria-describedby": "contrib-name-hint" });
  const attest = el("textarea", { id: "contrib-attest", name: "attestation", rows: "3", maxlength: "4000", "aria-describedby": "contrib-attest-hint" });
  const status = el("p", { id: "contrib-status", role: "status", "aria-live": "polite" });
  const steps = el("progress", { id: "contrib-progress", max: "100", value: "0", "aria-label": "Contribution progress", hidden: true });
  const button = el("button", { class: "btn", type: "submit" }, "Contribute");

  const form = el(
    "form",
    {
      class: "stack",
      novalidate: true,
      onSubmit: async (e) => {
        e.preventDefault();
        const name = nameInput.value.trim();
        if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(name) || name.includes("  ")) {
          nameInput.setAttribute("aria-invalid", "true");
          status.textContent = "Public name: 1 to 64 letters, digits, spaces, dots, underscores, or hyphens, starting with a letter or digit.";
          nameInput.focus();
          return;
        }
        nameInput.removeAttribute("aria-invalid");
        const pasted = await checkPaste();
        if (pasted && !pasted.ok) {
          status.textContent = `Entropy string: ${pasted.error}. Fix it or clear the field.`;
          pasteInput.focus();
          return;
        }
        button.disabled = true;
        busy = true;
        steps.hidden = false;
        try {
          await contribute(c, name, attest.value, pool, status, steps, pasted ? pasted.outputHex : "");
          pasteInput.value = "";
        } catch (err) {
          status.textContent = `Not accepted: ${errorText(err)}`;
          button.disabled = false;
        } finally {
          busy = false;
          pool.fill(0);
        }
      },
    },
    el(
      "div",
      { class: "field" },
      el("label", { class: "field-label", for: "contrib-name" }, "Public name"),
      nameInput,
      el("p", { class: "field-hint", id: "contrib-name-hint" }, "Shown in the public transcript. A pseudonym is fine.")
    ),
    el(
      "div",
      { class: "field" },
      el("label", { class: "field-label", for: "contrib-attest" }, "Attestation (optional)"),
      attest,
      el("p", { class: "field-hint", id: "contrib-attest-hint" }, "A short public note, for example how you ran your contribution. Up to 4000 characters.")
    ),
    el("div", { class: "cta-row" }, button),
    steps,
    status
  );

  return [
    el("p", { class: "notice notice-ok" }, `It is your turn.${ends}`),
    el(
      "div",
      { class: "stack" },
      el("h3", { id: "entropy-h" }, "1. Add your randomness"),
      el(
        "p",
        { id: "entropy-help" },
        "Your browser's secure random generator is always used. Movement and typing add more. None of it leaves this tab, and it is discarded when you are done."
      ),
      pad,
      el("p", { class: "entropy-meter" }, el("label", { for: "entropy-progress" }, "Collected "), progress, " ", progressText),
      el("div", { class: "field" }, el("label", { class: "field-label", for: "contrib-entropy" }, "Entropy string (optional)"), pasteInput, pasteHint)
    ),
    el("h3", {}, "2. Compute and upload"),
    el("p", {}, `Your browser downloads the latest key (${fmtBytes(c.contributions.at(-1)?.zkeyBytes ?? c.initial?.zkeyBytes)}), adds your randomness, and uploads the result. Keep this tab open.`),
    form,
  ];
}

async function contribute(c, name, attestation, pool, status, steps, pastedHex = "") {
  const parent = c.tipIndex;
  status.textContent = "Downloading the latest key…";
  const prev = await download(`/api/ceremonies/${c.id}/files/${c.tipZkey}`, (got, total) => {
    if (total) steps.value = Math.round((got / total) * 30);
  });
  const prevSha = await sha256Hex(prev);
  const expected = parent === 0 ? c.initial.zkeySha256 : c.contributions.at(-1).zkeySha256;
  if (prevSha !== expected) throw new Error("the downloaded key does not match the published hash");
  steps.value = 35;
  status.textContent = "Computing your contribution. This can take a while on a large circuit…";
  const entropy = new Uint32Array(pool.length + 16);
  entropy.set(pool);
  crypto.getRandomValues(entropy.subarray(pool.length));
  const result = await runWorker("contribute", { zkey: prev, name, entropy: entropy.buffer, pasted: pastedHex }, [prev, entropy.buffer]);
  steps.value = 70;
  status.textContent = "Uploading…";
  const headers = { "content-type": "application/octet-stream" };
  const note = attestation.trim();
  if (note) {
    const bytes = new TextEncoder().encode(note);
    let bin = "";
    bytes.forEach((b) => (bin += String.fromCharCode(b)));
    headers["x-ceremony-attestation"] = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  const up = await api(`/api/ceremonies/${c.id}/contributions?parent=${parent}&name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers,
    body: result.zkey,
  });
  steps.value = 80;
  status.textContent = "The server is checking your contribution against the previous one…";
  const job = await waitForJob(up.job.id);
  if (job.status !== "done") throw new Error(job.error || "verification failed");
  steps.value = 100;
  const receipt = { ...job.result.receipt, browserContributionHash: result.contributionHash };
  if (receipt.contributionHash !== result.contributionHash) {
    throw new Error("the server recorded a different contribution hash than your browser computed");
  }
  storeReceipt(c.id, receipt);
  status.textContent = `Accepted as contribution #${receipt.index}. Download your receipt and keep it.`;
  saveJson(`zk-voting-receipt-${c.id}-${receipt.index}.json`, receipt);
  announce(flash, `Accepted as contribution #${receipt.index}. Your receipt was downloaded.`, "ok");
  await refresh();
}

function storeReceipt(id, receipt) {
  try {
    localStorage.setItem(`zkv_ceremony_receipt_${id}`, JSON.stringify(receipt));
  } catch {
    /* storage off: the download is the receipt */
  }
}

function readReceipt(id) {
  try {
    return JSON.parse(localStorage.getItem(`zkv_ceremony_receipt_${id}`) || "null");
  } catch {
    return null;
  }
}

async function act(fn, ok) {
  try {
    await fn();
    announce(flash, ok, "ok");
  } catch (err) {
    announce(flash, errorText(err), "error");
  }
  await refresh();
}

let currentId = null;
let user = null;

async function renderDetail(id) {
  const { ceremony: c } = await api(`/api/ceremonies/${encodeURIComponent(id)}`);
  document.getElementById("ceremony-title").textContent = c.label || `Ceremony: ${c.circuitName}`;
  const hadFocus = document.activeElement && root.contains(document.activeElement) ? document.activeElement.id : null;
  const finals = c.exported
    ? el(
        "section",
        { class: "panel", "aria-labelledby": "final-h" },
        el("h2", { id: "final-h" }, "Final keys"),
        el("p", { class: "notice notice-warn" }, "Exported for human review. Nothing here is deployed or trusted until the platform host has reviewed it."),
        el(
          "ul",
          { class: "link-rows" },
          ...Object.keys(c.exported.files).map((f) =>
            el("li", {}, el("a", { href: `/api/ceremonies/${c.id}/export/${encodeURIComponent(f)}`, download: f }, f), " ", hashCode(c.exported.files[f], "SHA-256"))
          )
        )
      )
    : null;
  fill(root, 
    el(
      "section",
      { class: "panel", "aria-labelledby": "facts-h" },
      el("h2", { id: "facts-h", class: "sr-only" }, "About this ceremony"),
      el("p", {}, statusPill(c.status)),
      factList([
        ["Circuit", c.circuitName],
        ["Constraints", c.circuit?.constraints != null ? String(c.circuit.constraints) : "—"],
        ["Contributions", `${c.contributions.length} (at least ${c.minContributions} needed)`],
        ["In queue", String(c.queueLength)],
        ["Who can join", `Invited accounts only (${c.invitedCount ?? 0} invited)`],
        ["Beacon", beaconText(c.beacon)],
      ]),
      el("p", {}, el("a", { href: `/ceremony/${encodeURIComponent(c.id)}/transcript` }, "Open the full transcript and verify it"))
    ),
    turnPanel(c, user),
    el("section", { class: "panel", "aria-labelledby": "contribs-h" }, el("h2", { id: "contribs-h" }, "Contributions"), contributionsTable(c)),
    finals,
    explainer()
  );
  if (hadFocus) document.getElementById(hadFocus)?.focus();
  schedulePoll(c);
}

export function beaconText(beacon) {
  const p = beacon?.precommit;
  if (!p) return "Not committed yet. It must be fixed before the window closes.";
  const applied = beacon?.applied;
  if (applied) return `Ethereum mainnet block ${applied.blockNumber} hash ${applied.blockHash}`;
  return `Hash of Ethereum mainnet block ${p.blockNumber} (a future block when committed; applied once finalized)`;
}

function schedulePoll(c) {
  clearTimeout(pollTimer);
  const live = ["open", "closed", "finalizing", "initializing"].includes(c.status);
  if (!live) return;
  const fast = c.me?.queued || c.status === "finalizing";
  pollTimer = setTimeout(() => {
    if (busy || document.querySelector("#entropy-pad")) {
      // Do not repaint under someone who is mid-contribution.
      schedulePoll(c);
      return;
    }
    refresh();
  }, fast ? 5000 : 20000);
}

async function refresh() {
  try {
    if (currentId) await renderDetail(currentId);
    else await renderList();
  } catch (err) {
    if (err?.status === 404) {
      fill(root, el("p", { class: "notice notice-error" }, "No ceremony with that id on this Node."), el("p", {}, el("a", { href: "/ceremony" }, "All ceremonies")));
      return;
    }
    fill(root, el("p", { class: "notice notice-error" }, `Could not load: ${errorText(err)}`));
  }
}

// ---------- invite links ----------
// Links look like /ceremony/<id>#invite=<token>. The fragment never reaches the
// server or any Referer header; it is moved to sessionStorage (this tab only)
// so it survives a sign-in redirect, then sent once to the accept endpoint.

const inviteKey = (id) => `zk-ceremony-invite:${id}`;

function pendingInvite(id) {
  try {
    return sessionStorage.getItem(inviteKey(id));
  } catch {
    return null;
  }
}

function captureInviteFromHash(id) {
  const m = window.location.hash.match(/^#invite=([A-Za-z0-9_-]{20,100})$/);
  if (!m) return;
  try {
    sessionStorage.setItem(inviteKey(id), m[1]);
  } catch {
    /* private mode: keep it in memory only */
    memoryInvite = m[1];
  }
  history.replaceState(null, "", window.location.pathname + window.location.search);
}

let memoryInvite = null;

async function redeemInvite(id) {
  const token = pendingInvite(id) || memoryInvite;
  if (!token || !user) return;
  try {
    await api(`/api/ceremonies/${encodeURIComponent(id)}/invites/accept`, { method: "POST", json: { token } });
    announce(flash, "Invite accepted. You can join the queue.", "ok");
  } catch (err) {
    announce(flash, errorText(err), "error");
  } finally {
    memoryInvite = null;
    try {
      sessionStorage.removeItem(inviteKey(id));
    } catch {
      /* ignore */
    }
  }
}

async function boot() {
  currentId = ceremonyIdFromPath();
  if (currentId) captureInviteFromHash(currentId);
  user = await loadMe();
  if (currentId) await redeemInvite(currentId);
  await refresh();
}

boot();

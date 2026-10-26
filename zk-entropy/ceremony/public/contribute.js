/* NOT FOR PROFIT — civic public good, not a commercial product.
 * Contribute page. Entropy is collected and mixed in this tab with zk-entropy;
 * only the 32-byte result and the hash of your local transcript are sent. */
import { EntropyPool, attachCollectors } from "/lib/zk-entropy.js";
import { api, h, fill, pill, head, notice, fmtTime, finalPanel } from "/common.js";

const main = document.getElementById("main");
const TARGET = 160;
const RECEIPT_KEY = "zk-entropy-ceremony-receipts";

function receipts() {
  try {
    return JSON.parse(localStorage.getItem(RECEIPT_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveReceipt(r) {
  try {
    localStorage.setItem(RECEIPT_KEY, JSON.stringify([...receipts(), r].slice(-20)));
  } catch {
    /* storage off: the on-screen receipt is it */
  }
}

function stats(s) {
  return h(
    "div",
    { class: "grid" },
    h("div", { class: "stat" }, h("div", { class: "lbl" }, "Status"), h("div", { class: "val" }, pill(s.status))),
    h("div", { class: "stat" }, h("div", { class: "lbl" }, "Contributions"), h("div", { class: "val", id: "count" }, String(s.count))),
    h("div", { class: "stat" }, h("div", { class: "lbl" }, "Minimum"), h("div", { class: "val" }, String(s.minContributions))),
    h("div", { class: "stat" }, h("div", { class: "lbl" }, s.status === "closed" ? "Closed" : "Deadline"), h("div", { class: "val val-small" }, fmtTime(s.status === "closed" ? s.closedAt : s.closeAt)))
  );
}

function contributePanel(s) {
  const pool = new EntropyPool();
  const status = h("p", { id: "contrib-status", role: "status", "aria-live": "polite" });
  const progress = h("progress", { id: "entropy-progress", max: String(TARGET), value: "0" });
  const pct = h("span", { id: "entropy-pct" }, "0%");
  const pad = h("div", { class: "pad", id: "entropy-pad", tabindex: "0", role: "group", "aria-labelledby": "pad-h", "aria-describedby": "pad-help" }, "Move your pointer or finger here, or focus this box and type anything.");
  const text = h("textarea", { id: "contrib-text", rows: "2", maxlength: "2000", autocomplete: "off", "aria-describedby": "text-hint" });
  const button = h("button", { class: "btn", type: "submit", id: "contrib-btn" }, "Contribute");
  let n = 0;
  const detach = attachCollectors(pad, pool, {
    onEvent: (count) => {
      n = count;
      progress.value = Math.min(TARGET, count);
      pct.textContent = `${Math.min(100, Math.round((count / TARGET) * 100))}%`;
    },
  });
  const form = h(
    "form",
    {
      novalidate: true,
      onSubmit: async (e) => {
        e.preventDefault();
        if (n < TARGET / 4 && !confirm("You added little movement or typing. Your browser's secure random generator is still used. Contribute anyway?")) return;
        button.disabled = true;
        status.textContent = "Mixing your entropy…";
        try {
          detach();
          if (text.value) pool.addText(text.value);
          text.value = "";
          const res = await pool.finalize({ source: "local" });
          status.textContent = "Sending…";
          const { receipt } = await api("/api/contributions", { method: "POST", json: { contribution: res.outputHex, clientTranscriptHash: res.transcriptHash } });
          res.output.fill(0);
          saveReceipt({ ...receipt, clientTranscriptHash: res.transcriptHash });
          fill(main, ...(await page({ thanked: receipt.index })));
        } catch (err) {
          status.textContent = `Not accepted: ${err.message}`;
          button.disabled = false;
        }
      },
    },
    h("div", { class: "field" }, h("label", { class: "field-label", for: "contrib-text" }, "Extra text (optional)"), text, h("span", { class: "field-hint", id: "text-hint" }, "Anything you like. It is hashed into your contribution in this tab and never sent or stored.")),
    h("div", { class: "actions" }, button),
    status
  );
  return h(
    "section",
    { class: "panel", "aria-labelledby": "pad-h" },
    h("h2", { id: "pad-h" }, "1. Add your randomness"),
    h("p", { id: "pad-help", class: "muted" }, "Your browser's secure random generator and timing jitter are always mixed in. Pointer movement and key timing add more. Raw events never leave this tab."),
    pad,
    h("div", { class: "meter" }, h("label", { for: "entropy-progress" }, "Collected"), progress, pct),
    h("h3", {}, "2. Send your contribution"),
    h("p", { class: "muted" }, "Only a 32-byte digest of everything above and the hash of your local transcript are sent. The server chains it: state = H(previous state ‖ your contribution)."),
    form
  );
}

function myReceipts(s) {
  const mine = receipts();
  if (!mine.length) return null;
  return h(
    "section",
    { class: "panel", "aria-labelledby": "mine-h" },
    h("h2", { id: "mine-h" }, "Your contributions from this browser"),
    h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "#"), h("th", {}, "Contribution hash"), h("th", {}, "Accepted"))), h("tbody", {}, ...mine.map((r) => h("tr", {}, h("td", {}, String(r.index)), h("td", { class: "mono" }, r.contributionHash), h("td", {}, fmtTime(r.at))))))),
    h("p", { class: "field-hint" }, "Find your hash in the ", h("a", { href: "/transcript" }, "public transcript"), s.status === "closed" ? " to check it went into the final output." : ".")
  );
}

async function page({ thanked = null } = {}) {
  const s = await api("/api/state");
  document.title = `${s.title} · Contribute`;
  const parts = [head("Entropy ceremony", s.title, "Many people each add randomness. Each contribution is chained into the last, so the final output is unpredictable as long as one contributor was honest. No accounts and no personal data.")];
  if (thanked) parts.push(notice("ok", h("p", {}, `Thank you. Your contribution is #${thanked} in the chain. Its hash is listed below and in the public transcript.`)));
  parts.push(stats(s));
  if (s.status === "open") parts.push(contributePanel(s));
  else if (s.status === "draft") parts.push(notice("warn", h("p", {}, "This ceremony is not open for contributions yet. Check back soon.")));
  else if (s.final) parts.push(finalPanel(s.final));
  parts.push(myReceipts(s));
  return parts;
}

try {
  fill(main, ...(await page()));
} catch (err) {
  fill(main, notice("error", h("p", {}, `Could not load the ceremony: ${err.message}`)));
}

/**
 * NOT FOR PROFIT — ZK-Voting is a civic public good. Not a commercial product.
 * Public portal: paste a vote receipt to confirm it counted. Hourly turnout
 * metrics only — never a candidate or option.
 */

import { brandName } from "./brand.js";
import { resultsAreSealed, sealedUntilLabel } from "./election-type-ui.js";
import { t } from "./i18n.js";

function proofFromQuery(query) {
  const raw = query?.get?.("proof") || query?.get?.("receipt") || "";
  return String(raw || "").trim();
}

function storedProof() {
  try {
    return sessionStorage.getItem("zk-voting.receipt.proof") || "";
  } catch {
    return "";
  }
}

function rememberProof(text) {
  try {
    if (text) sessionStorage.setItem("zk-voting.receipt.proof", text);
  } catch {
    /* ignore quota */
  }
}

function fmtTime(ts) {
  if (ts == null || ts === "") return "—";
  const n = Number(ts);
  const d = Number.isFinite(n) ? new Date(n > 1e12 ? n : n * 1000) : new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

async function copyText(text, announce) {
  const value = String(text || "");
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    announce?.("Copied. This proof does not list your choices.");
  } catch {
    announce?.("Copy failed. Select the proof text and copy it yourself.");
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const raw = String(reader.result || "");
      const comma = raw.indexOf(",");
      resolve(comma >= 0 ? raw.slice(comma + 1) : raw);
    };
    reader.onerror = () => reject(new Error("Could not read that PDF."));
    reader.readAsDataURL(file);
  });
}

export async function renderReceiptPortal(main, ctx) {
  const { h, api, fill, announce, setTitle, formatTime } = ctx;
  setTitle("Check a vote receipt");
  const state = {
    busy: false,
    error: "",
    info: "",
    proof: storedProof() || proofFromQuery(ctx.route?.query) || "",
    pdfFile: null,
    result: null,
    metrics: null,
    electionId: "",
    elections: [],
  };

  try {
    const data = await api("/api/elections");
    state.elections = Array.isArray(data?.elections) ? data.elections : [];
  } catch {
    state.elections = [];
  }

  async function loadMetrics(electionId) {
    const q = electionId ? `?electionId=${encodeURIComponent(electionId)}` : "";
    try {
      state.metrics = await api(`/api/receipts/metrics${q}`);
    } catch (err) {
      state.metrics = null;
      if (electionId) state.error = err.message || "Could not load turnout metrics.";
    }
  }

  async function onVerify(event) {
    event.preventDefault();
    if (state.busy) return;
    state.busy = true;
    state.error = "";
    state.info = "";
    state.result = null;
    paint();
    const proof = String(event.target.proof?.value || state.proof || "").trim();
    state.proof = proof;
    rememberProof(proof);
    if (!proof && !state.pdfFile) {
      state.busy = false;
      state.error = "Paste a receipt or drop the emailed PDF.";
      paint();
      return;
    }
    const body = { proof };
    if (state.pdfFile) {
      try {
        body.pdf = await fileToBase64(state.pdfFile);
      } catch (err) {
        state.busy = false;
        state.error = err.message || "Could not read that PDF.";
        paint();
        return;
      }
    }
    try {
      const result = await api("/api/receipts/verify", { method: "POST", body });
      state.result = result;
      state.electionId = result.electionId || state.electionId;
      await loadMetrics(state.electionId);
      state.info = result.counted
        ? result.pdfUnmodified === false
          ? "This ballot counted, but that PDF does not match the locked file the Node issued."
          : result.published
          ? "This ballot is in the public record. The receipt still cannot prove how you voted."
          : "This ballot counted. Public explorer rows wait until this hour closes."
        : "This proof did not match an accepted ballot.";
      announce(state.info);
    } catch (err) {
      state.error = err.message || "Receipt not found.";
      announce(state.error);
    } finally {
      state.busy = false;
      paint();
    }
  }

  function metricsPanel() {
    const m = state.metrics;
    if (!m) {
      return h(
        "p",
        {
          class: "field-hint",
          text: "Choose an election or paste a receipt to see how many ballots have been disclosed, and when each hour closed. Counts are never by candidate or option.",
        }
      );
    }
    const hours = Array.isArray(m.hours) ? m.hours : [];
    return h(
      "div",
      { class: "stack" },
      h("p", { text: m.note || "Hourly snapshots of accepted ballots. Not a count by candidate or option." }),
      resultsAreSealed(m) ? h("p", { text: sealedUntilLabel(m, formatTime) }) : null,
      resultsAreSealed(m) ? h("p", { class: "field-hint", text: t("results.sealedBody") }) : null,
      h(
        "ul",
        { class: "meta-list" },
        m.electionTitle
          ? h("li", {}, h("span", { class: "lbl", text: "Election" }), h("span", { text: m.electionTitle }))
          : null,
        h(
          "li",
          {},
          h("span", { class: "lbl", text: "Ballots disclosed" }),
          h("span", { text: String(m.acceptedBallotsDisclosed ?? "—") })
        ),
        m.participantCount != null
          ? h("li", {}, h("span", { class: "lbl", text: "Registered on the roll" }), h("span", { text: String(m.participantCount) }))
          : null,
        m.disclosure?.lastClosedHourAt != null
          ? h(
              "li",
              {},
              h("span", { class: "lbl", text: "Last closed hour" }),
              h("span", { text: formatTime ? formatTime(m.disclosure.lastClosedHourAt) : fmtTime(m.disclosure.lastClosedHourAt) })
            )
          : null,
        m.disclosure?.nextPublishAt != null
          ? h(
              "li",
              {},
              h("span", { class: "lbl", text: "Next disclosure" }),
              h("span", { text: formatTime ? formatTime(m.disclosure.nextPublishAt) : fmtTime(m.disclosure.nextPublishAt) })
            )
          : null
      ),
      hours.length
        ? h(
            "table",
            { class: "receipt-hours" },
            h("caption", { text: "When ballots became public (hour closed, UTC). Original intra-hour times are not published." }),
            h(
              "thead",
              {},
              h("tr", {}, h("th", { text: "Hour closed" }), h("th", { text: "Ballots" }))
            ),
            h(
              "tbody",
              {},
              ...hours.map((row) =>
                h(
                  "tr",
                  {},
                  h("td", { text: row.hourClosedAtIso || fmtTime(row.hourClosedAt) }),
                  h("td", { class: "num", text: String(row.ballots) })
                )
              )
            )
          )
        : h("p", { class: "field-hint", text: "No ballots have been disclosed for this contest yet." })
    );
  }

  function resultPanel() {
    const r = state.result;
    if (!r) return null;
    return h(
      "section",
      { class: "receipt", "aria-labelledby": "verify-result-heading" },
      h("h2", { id: "verify-result-heading", text: r.counted ? "This ballot counted" : "Not found" }),
      h("p", {
        text: r.note || `A ${brandName()} receipt lists hashes only. It cannot prove which option was marked.`,
      }),
      h(
        "ul",
        { class: "meta-list" },
        h("li", {}, h("span", { class: "lbl", text: "Counted" }), h("span", { text: r.counted ? "Yes" : "No" })),
        h("li", {}, h("span", { class: "lbl", text: "Publicly disclosed" }), h("span", { text: r.published ? "Yes" : "Pending hour close" })),
        r.electionTitle
          ? h("li", {}, h("span", { class: "lbl", text: "Election" }), h("span", { text: r.electionTitle }))
          : null,
        h("li", {}, h("span", { class: "lbl", text: "Ballot hash" }), h("span", { class: "hex", text: r.ballotHash || "—" })),
        h("li", {}, h("span", { class: "lbl", text: "Nullifier" }), h("span", { class: "hex", text: r.nullifier || "—" })),
        r.acceptedAtIso
          ? h("li", {}, h("span", { class: "lbl", text: "Accepted (holder copy)" }), h("span", { text: r.acceptedAtIso }))
          : null,
        r.disclosureHourClosedAtIso
          ? h("li", {}, h("span", { class: "lbl", text: "Disclosure hour closed" }), h("span", { text: r.disclosureHourClosedAtIso }))
          : null,
        r.pdfProtected
          ? h("li", {}, h("span", { class: "lbl", text: "PDF" }), h("span", { text: "Locked against modification" }))
          : null,
        r.pdfUnmodified === true
          ? h("li", {}, h("span", { class: "lbl", text: "PDF bytes" }), h("span", { text: "Unmodified — matches the Node fingerprint" }))
          : r.pdfUnmodified === false
            ? h("li", {}, h("span", { class: "lbl", text: "PDF bytes" }), h("span", { text: "Changed — does not match the issued file" }))
            : null,
        r.pdfSha256
          ? h("li", {}, h("span", { class: "lbl", text: "PDF SHA-256" }), h("span", { class: "hex", text: r.pdfSha256 }))
          : null
      ),
      r.explorerUrl
        ? h("p", {}, h("a", { href: r.explorerUrl, text: "Open in the explorer" }))
        : null
    );
  }

  function paint() {
    fill(
      main,
      h(
        "div",
        { class: "page-head" },
        h("p", { class: "kicker", text: "Public record" }),
        h("h1", { text: "Check a vote receipt" }),
        h("p", {
          class: "lede",
          text: `Paste the proof from your emailed receipt or the ballot screen, or drop the locked PDF. ${brandName()} will tell you whether that ballot was accepted and whether the PDF still matches the issued bytes. This page never shows a candidate or an option.`,
        })
      ),
      state.error ? h("div", { class: "notice notice-error", role: "alert" }, h("p", { text: state.error })) : null,
      state.info ? h("div", { class: "notice notice-ok", role: "status" }, h("p", { text: state.info })) : null,
      h(
        "form",
        { class: "stack receipt-verify-form", onSubmit: onVerify },
        h(
          "label",
          { class: "field", for: "receipt-proof" },
          "Receipt proof",
          h("span", {
            class: "field-hint",
            text: "Copy the block that starts with BEGIN ZK-VOTING VOTE RECEIPT, or drop the emailed PDF. Do not paste a screenshot of your marked ballot.",
          })
        ),
        h("textarea", {
          id: "receipt-proof",
          name: "proof",
          class: "proof-paste",
          rows: 12,
          spellcheck: "false",
          autocomplete: "off",
          value: state.proof,
          onInput: (event) => {
            state.proof = event.target.value;
          },
        }),
        h(
          "label",
          { class: "field", for: "receipt-pdf-file" },
          "Locked PDF (optional)",
          h("span", {
            class: "field-hint",
            text: "Drop the emailed zk-voting-vote-receipt.pdf. The Node hashes the exact bytes. A modified file will not match.",
          }),
          h("input", {
            id: "receipt-pdf-file",
            name: "pdf",
            type: "file",
            class: "receipt-pdf-file",
            accept: "application/pdf,.pdf",
            onChange: (event) => {
              state.pdfFile = event.target.files && event.target.files[0] ? event.target.files[0] : null;
            },
          })
        ),
        h(
          "div",
          { class: "cluster" },
          h("button", { class: "btn", type: "submit", disabled: state.busy, text: state.busy ? "Checking…" : "Check this proof" }),
          h("button", {
            class: "btn btn-secondary",
            type: "button",
            text: "Copy from this box",
            onClick: () => copyText(state.proof, announce),
          })
        )
      ),
      resultPanel(),
      h(
        "section",
        { class: "panel", "aria-labelledby": "turnout-heading" },
        h("h2", { id: "turnout-heading", text: "When and how many people voted" }),
        h("p", {
          text: "Public turnout is published after each UTC hour closes. A person leaving a voting office cannot be matched to a live jurisdiction tick. These numbers are not a tally by candidate or option.",
        }),
        state.elections.length
          ? h(
              "label",
              { class: "field", for: "receipt-election" },
              "Election",
                  h(
                    "select",
                    {
                      id: "receipt-election",
                      onChange: async (event) => {
                        state.electionId = event.target.value;
                        state.error = "";
                        await loadMetrics(state.electionId);
                        paint();
                      },
                    },
                    h("option", { value: "", selected: !state.electionId, text: "All disclosed ballots on this Node" }),
                    ...state.elections.map((el) =>
                      h("option", {
                        value: String(el.id),
                        selected: String(el.id) === String(state.electionId),
                        text: el.title || String(el.id),
                      })
                    )
                  )
            )
          : null,
        metricsPanel()
      )
    );
  }

  await loadMetrics(state.electionId);
  if (state.proof) {
    try {
      state.result = await api("/api/receipts/verify", { method: "POST", body: { proof: state.proof } });
      state.electionId = state.result.electionId || state.electionId;
      await loadMetrics(state.electionId);
    } catch {
      /* wait for submit */
    }
  }
  paint();
}

export { copyText, rememberProof };

/**
 * NOT FOR PROFIT — Republic is a civic public good. Not a commercial product.
 * Public portal: drop an official outcome PDF (or paste its report id) to
 * confirm the locked file is authentic.
 */

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

function reportIdFromQuery(query) {
  return String(query?.get?.("id") || query?.get?.("report") || query?.get?.("r") || "").trim();
}

export async function renderOutcomeVerify(main, ctx) {
  const { h, api, fill, announce, setTitle, formatTime, route } = ctx;
  setTitle("Verify an official outcome PDF");
  const state = {
    busy: false,
    error: "",
    info: "",
    reportId: reportIdFromQuery(route?.query),
    pdfFile: null,
    result: null,
    meta: null,
  };

  async function loadMeta(id) {
    if (!id) {
      state.meta = null;
      return;
    }
    try {
      state.meta = await api(`/api/outcomes/reports/${encodeURIComponent(id)}`);
    } catch {
      state.meta = null;
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
    const reportId = String(event.target.reportId?.value || state.reportId || "").trim();
    state.reportId = reportId;
    if (!reportId && !state.pdfFile) {
      state.busy = false;
      state.error = "Drop the official PDF or paste the report id from the QR / email.";
      paint();
      return;
    }
    const body = { reportId };
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
      const result = await api("/api/outcomes/verify", { method: "POST", body });
      state.result = result;
      state.info =
        result.pdfUnmodified === false
          ? "This file is not authentic. The bytes do not match the official PDF."
          : result.authentic
            ? "This is the official outcome PDF. It is locked against modification."
            : "The Node could not confirm this file.";
      announce(state.info);
    } catch (err) {
      state.error = err.message || "Official outcome report not found.";
      announce(state.error);
    } finally {
      state.busy = false;
      paint();
    }
  }

  function resultPanel() {
    const r = state.result;
    if (!r) return null;
    return h(
      "section",
      { class: "receipt", "aria-labelledby": "outcome-verify-result" },
      h("h2", { id: "outcome-verify-result", text: r.authentic ? "Authentic official report" : "Not authentic" }),
      h("p", { text: r.note || "" }),
      h(
        "ul",
        { class: "meta-list" },
        h("li", {}, h("span", { class: "lbl", text: "Authentic" }), h("span", { text: r.authentic ? "Yes" : "No" })),
        r.electionTitle
          ? h("li", {}, h("span", { class: "lbl", text: "Election" }), h("span", { text: r.electionTitle }))
          : null,
        r.startTimeIso
          ? h("li", {}, h("span", { class: "lbl", text: "Started" }), h("span", { text: formatTime ? formatTime(r.startTime) : r.startTimeIso }))
          : null,
        r.cutoffTimeIso
          ? h("li", {}, h("span", { class: "lbl", text: "Ended" }), h("span", { text: formatTime ? formatTime(r.cutoffTime) : r.cutoffTimeIso }))
          : null,
        r.acceptedBallots != null
          ? h("li", {}, h("span", { class: "lbl", text: "Ballots accepted" }), h("span", { text: String(r.acceptedBallots) }))
          : null,
        h("li", {}, h("span", { class: "lbl", text: "PDF" }), h("span", { text: "Locked against modification" })),
        r.pdfUnmodified === true
          ? h("li", {}, h("span", { class: "lbl", text: "PDF bytes" }), h("span", { text: "Unmodified — matches the Node fingerprint" }))
          : r.pdfUnmodified === false
            ? h("li", {}, h("span", { class: "lbl", text: "PDF bytes" }), h("span", { text: "Changed — not authentic" }))
            : null,
        r.pdfSha256
          ? h("li", {}, h("span", { class: "lbl", text: "PDF SHA-256" }), h("span", { class: "hex", text: r.pdfSha256 }))
          : null,
        r.integrity
          ? h("li", {}, h("span", { class: "lbl", text: "Integrity HMAC" }), h("span", { class: "hex", text: r.integrity }))
          : null
      ),
      r.electionId
        ? h("p", {}, h("a", { href: `/outcomes/${encodeURIComponent(r.electionId)}`, "data-nav": "", text: "Open the outcomes monitor" }))
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
        h("h1", { text: "Verify an official outcome PDF" }),
        h("p", {
          class: "lede",
          text: "After voting time expires and a tally is posted, Republic emails a locked official PDF. Drop that file here, or paste the report id from the QR code, to confirm the bytes still match. The clerk template cannot remove this seal.",
        })
      ),
      state.error ? h("div", { class: "notice notice-error", role: "alert" }, h("p", { text: state.error })) : null,
      state.info ? h("div", { class: "notice notice-ok", role: "status" }, h("p", { text: state.info })) : null,
      h(
        "form",
        { class: "stack receipt-verify-form", onSubmit: onVerify },
        h(
          "label",
          { class: "field", for: "outcome-report-id" },
          "Report id (from QR or email)",
          h("input", {
            id: "outcome-report-id",
            name: "reportId",
            value: state.reportId,
            autocomplete: "off",
            spellcheck: "false",
            onInput: (event) => {
              state.reportId = event.target.value;
            },
          })
        ),
        h(
          "label",
          { class: "field", for: "outcome-pdf-file" },
          "Locked official PDF",
          h("span", {
            class: "field-hint",
            text: "Drop republic-official-outcome.pdf. The Node hashes the exact bytes. A modified file will not match.",
          }),
          h("input", {
            id: "outcome-pdf-file",
            name: "pdf",
            type: "file",
            class: "receipt-pdf-file",
            accept: "application/pdf,.pdf",
            onChange: (event) => {
              state.pdfFile = event.target.files && event.target.files[0] ? event.target.files[0] : null;
            },
          })
        ),
        h("button", { class: "btn", type: "submit", disabled: state.busy, text: state.busy ? "Checking…" : "Verify this report" })
      ),
      resultPanel(),
      state.meta
        ? h(
            "section",
            { class: "panel" },
            h("h2", { text: "Published fingerprint" }),
            h("p", { text: "Anyone can compare the SHA-256 of their copy to this published hash." }),
            h(
              "ul",
              { class: "meta-list" },
              h("li", {}, h("span", { class: "lbl", text: "Election" }), h("span", { text: state.meta.electionTitle || state.meta.electionId })),
              h("li", {}, h("span", { class: "lbl", text: "SHA-256" }), h("span", { class: "hex", text: state.meta.pdfSha256 || "—" })),
              state.meta.issuedAt
                ? h("li", {}, h("span", { class: "lbl", text: "Issued" }), h("span", { text: state.meta.issuedAt }))
                : null
            ),
            state.meta.electionId
              ? h("p", {}, h("a", { class: "btn btn-secondary", href: `/api/outcomes/reports/${encodeURIComponent(state.meta.electionId)}/pdf`, text: "Download the official PDF" }))
              : null
          )
        : null
    );
  }

  await loadMeta(state.reportId);
  if (state.reportId && !state.pdfFile) {
    try {
      state.result = await api("/api/outcomes/verify", { method: "POST", body: { reportId: state.reportId } });
    } catch {
      /* wait for submit / PDF */
    }
  }
  paint();
}

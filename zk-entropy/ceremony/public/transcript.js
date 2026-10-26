/* NOT FOR PROFIT — civic public good, not a commercial product. */
import { verifyCeremonyTranscript } from "/lib/zk-entropy.js";
import { api, h, fill, pill, head, notice, fmtTime, finalPanel } from "/common.js";

const main = document.getElementById("main");

async function render() {
  const { transcript: t } = await api("/api/transcript");
  const closed = t.status === "closed";
  const result = h("div", { id: "verify-result", "aria-live": "polite" });
  const verifyBtn = closed
    ? h("button", { class: "btn", type: "button", onClick: async () => {
        const v = await verifyCeremonyTranscript(t);
        fill(result, v.ok ? notice("ok", h("p", {}, `Verified in your browser: ${t.contributions.length} contributions chain to the published output.`)) : notice("error", h("p", {}, `Does not verify: ${v.error}`)));
      } }, "Verify the chain in this browser")
    : null;
  fill(
    main,
    head("Public transcript", t.title, closed ? "The ceremony is closed. Raw contributions are revealed so anyone can recompute every step." : "Contribution hashes and times only. Raw contributions and the chain state are revealed when the ceremony closes."),
    h("section", { class: "panel", "aria-labelledby": "facts-h" },
      h("h2", { id: "facts-h" }, "Chain"),
      h("dl", { class: "facts" },
        h("dt", {}, "Status"), h("dd", {}, pill(t.status)),
        h("dt", {}, "Salt"), h("dd", { class: "mono" }, t.salt),
        h("dt", {}, "Genesis"), h("dd", { class: "mono" }, t.genesis),
        h("dt", {}, "Opened"), h("dd", {}, fmtTime(t.openedAt)),
        closed ? [h("dt", {}, "Closed"), h("dd", {}, `${fmtTime(t.closedAt)} (${t.closeReason})`), h("dt", {}, "Final state"), h("dd", { class: "mono" }, t.finalState)] : null
      ),
      h("div", { class: "actions" }, verifyBtn, h("a", { class: "btn btn-secondary", href: "/api/transcript", download: "ceremony-transcript.json" }, "Download JSON")),
      result
    ),
    closed ? finalPanel(t) : null,
    h("section", { class: "panel", "aria-labelledby": "list-h" },
      h("h2", { id: "list-h" }, `Contributions (${t.contributions.length})`),
      t.contributions.length
        ? h("div", { class: "table-wrap" }, h("table", {},
            h("caption", { class: "sr-only" }, "Contributions, oldest first"),
            h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "#"), h("th", { scope: "col" }, "Contribution hash"), h("th", { scope: "col" }, "Time"), closed ? h("th", { scope: "col" }, "Contribution") : null)),
            h("tbody", {}, ...t.contributions.map((c) => h("tr", {}, h("td", {}, String(c.index)), h("td", { class: "mono" }, c.contributionHash), h("td", {}, fmtTime(c.at)), closed ? h("td", { class: "mono" }, c.contribution) : null)))))
        : h("p", { class: "muted" }, "No contributions yet.")
    )
  );
}

render().catch((err) => fill(main, notice("error", h("p", {}, `Could not load the transcript: ${err.message}`))));

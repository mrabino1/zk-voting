/**
 * NOT FOR PROFIT — ZK-Voting is a civic public good. Not a commercial product.
 *
 * Results of a civic vote on the rollup, read from GET /api/elections/:id/rollup (which reads
 * ZkVotingRollup on L1). There is no node tally: after the cutoff the guardians each post a
 * decryption share of the final encrypted sum, and L1 checks the totals in finalizeResult.
 * A vote below its anonymity floor (minBallots) is Withheld: no totals are ever published.
 */

/** Plain view model from the /rollup payload and the election's question. Pure; tested. */
export function rollupResultsModel(view, election) {
  const l1 = view?.l1 || null;
  const status = l1?.status || (view?.published ? "unknown" : "draft");
  const question = (election?.questions || [])[0] || {};
  const options = Array.isArray(question.options) ? question.options : [];
  const threshold = Number(l1?.threshold ?? view?.threshold ?? 0) || null;
  const guardians = Array.isArray(view?.guardians) ? view.guardians : [];
  const sharesPosted = guardians.filter((g) => g.sharesPosted).length;
  const closedOrLater = ["closed", "finalized", "withheld"].includes(status);
  const model = {
    status,
    prompt: question.prompt || question.text || "",
    l1ElectionId: l1?.electionId ?? null,
    rollup: l1?.rollup ?? null,
    chainId: l1?.chainId ?? null,
    threshold,
    guardianCount: guardians.length,
    sharesPosted,
    minBallots: Number(l1?.minBallots ?? view?.minBallots ?? 0) || null,
    // Turnout only once voting is over; never a live count.
    ballotCount: closedOrLater ? Number(l1?.ballotCount ?? 0) : null,
    rows: null,
    winners: [],
    resultHash: view?.result?.resultHash ?? null,
    headline: "",
    detail: "",
  };

  switch (status) {
    case "draft":
      model.headline = "Not on L1 yet";
      model.detail = "The election office has not published this vote to the rollup.";
      break;
    case "keygen":
      model.headline = "Guardians are making the election key";
      model.detail = `Each guardian commits to a share of the key on L1. ${model.guardianCount} guardians; any ${threshold ?? "k"} of them can decrypt the final sum, and no smaller group can.`;
      break;
    case "scheduled":
      model.headline = "Voting";
      model.detail = "Ballots are encrypted in voters' browsers and added to an encrypted sum on L1. Nothing is decrypted until the cutoff, and then only the total.";
      break;
    case "closing":
      model.headline = "Closing";
      model.detail = "The operator is settling the last batches on L1.";
      break;
    case "closed":
      model.headline = "Waiting for the guardians";
      model.detail = `${sharesPosted} of ${threshold ?? "?"} required guardians have posted their decryption share of the final sum.`;
      break;
    case "finalized": {
      const counts = (view?.result?.counts || []).map(Number);
      const total = counts.reduce((a, b) => a + b, 0);
      model.rows = counts.map((count, i) => ({
        id: options[i]?.id ?? String(i),
        label: options[i]?.label ?? options[i]?.text ?? `Option ${i + 1}`,
        count,
        share: total > 0 ? count / total : null,
      }));
      const top = Math.max(0, ...counts);
      model.winners = top > 0 ? model.rows.filter((r) => r.count === top).map((r) => r.label) : [];
      model.headline = model.winners.length > 1 ? `Tie: ${model.winners.join(", ")}` : model.winners[0] ? `${model.winners[0]} wins` : "No votes";
      model.detail = "Certified on L1: the guardians' shares open only the final sum, and the contract checked these totals against it.";
      break;
    }
    case "withheld":
      model.headline = "Withheld";
      model.detail = `Fewer than ${model.minBallots ?? "the minimum number of"} ballots were cast, so no totals are published. A total over so few ballots could reveal how individuals voted.`;
      break;
    case "halted":
      model.headline = "Halted";
      model.detail = "This vote was halted on L1 and will not produce a result.";
      break;
    default:
      model.headline = "Status unknown";
      model.detail = "The node could not read this vote from L1.";
  }
  return model;
}

function percent(share) {
  return share == null ? "—" : `${Math.round(share * 1000) / 10}%`;
}

export async function renderRollupResults(main, ctx, election) {
  const { h, api, formatTime, electionStateInfo } = ctx;
  let view = null;
  let error = "";
  try {
    view = await api(`/api/elections/${encodeURIComponent(election.id)}/rollup`);
  } catch (err) {
    error = err.message || "Could not read this vote from L1.";
  }
  const m = rollupResultsModel(view, election);
  const st = electionStateInfo(election.state);
  const row = (label, value, hex) =>
    value == null || value === "" ? null : h("li", {}, h("span", { class: "lbl", text: label }), h("span", { class: hex ? "hex" : "", text: String(value) }));

  main.replaceChildren(
    h(
      "div",
      { class: "page-head" },
      h("p", { class: "kicker", text: election.jurisdiction || election.jurisdictionId || "Election results" }),
      h("h1", { text: election.title || "Election results" }),
      h(
        "p",
        { class: "cluster" },
        h("span", { class: `status-pill ${st.className}`, text: st.label }),
        h("span", { class: "status-pill status-created", text: "Civic vote on L1" })
      ),
      m.prompt ? h("p", { class: "lede", text: m.prompt }) : null
    ),
    error ? h("div", { class: "notice notice-error", role: "alert" }, h("p", { text: error })) : null,
    h(
      "section",
      { class: `panel results-rollup results-${m.status}`, "aria-labelledby": "rollup-result-h" },
      h("h2", { id: "rollup-result-h", text: m.headline }),
      h("p", { text: m.detail }),
      m.rows
        ? h(
            "table",
            { class: "results-table" },
            h("thead", {}, h("tr", {}, h("th", { scope: "col", text: "Option" }), h("th", { scope: "col", text: "Votes" }), h("th", { scope: "col", text: "Share" }))),
            h(
              "tbody",
              {},
              ...m.rows.map((r) =>
                h(
                  "tr",
                  { class: m.winners.includes(r.label) ? "is-winner" : "" },
                  h("th", { scope: "row", text: r.label }),
                  h("td", { text: String(r.count) }),
                  h("td", { text: percent(r.share) })
                )
              )
            )
          )
        : null
    ),
    h(
      "section",
      { class: "panel", "aria-labelledby": "rollup-record-h" },
      h("h2", { id: "rollup-record-h", text: "Public record" }),
      h(
        "ul",
        { class: "meta-list" },
        row("Voting closes", election.cutoffTime ? formatTime(election.cutoffTime) : null),
        row("Ballots cast", m.ballotCount),
        row("Anonymity floor", m.minBallots != null ? `${m.minBallots} ballots` : null),
        row("Guardians", m.guardianCount ? `${m.guardianCount} (any ${m.threshold ?? "?"} decrypt the sum)` : null),
        row("L1 election", m.l1ElectionId),
        row("Rollup contract", m.rollup ? `${m.rollup} (chain ${m.chainId})` : null, true),
        row("Result hash", m.resultHash, true)
      )
    ),
    h(
      "div",
      { class: "toolbar" },
      h("a", { class: "btn btn-secondary", href: "/", "data-nav": "", text: "Elections" }),
      h("a", { class: "btn btn-secondary", href: `/vote/${encodeURIComponent(election.id)}`, "data-nav": "", text: "Ballot" })
    )
  );
}

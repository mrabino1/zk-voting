/**
 * NOT FOR PROFIT — Republic is a civic public good. Not a commercial product.
 * Certified election results: per-option counts after a tally, plurality
 * winners and ties. No unofficial choice totals while polls are open.
 */

function percent(share) {
  if (share == null || !Number.isFinite(Number(share))) return "—";
  return `${Math.round(Number(share) * 1000) / 10}%`;
}

function emptyCopy(status) {
  if (status === "open") {
    return {
      title: "Voting is open",
      body: "Certified option counts appear after a tally is posted. Public turnout is the last hourly snapshot, so a person leaving a voting office cannot be matched to a live jurisdiction tick.",
    };
  }
  if (status === "awaiting_tally" || status === "closed") {
    return {
      title: "Awaiting certified tally",
      body: "Polls are closed. Option counts and a declared winner are published when the tally operator posts a valid tally.",
    };
  }
  if (status === "roll_frozen") {
    return {
      title: "Roll frozen",
      body: "Voting has not opened. Certified results appear after the poll closes and a tally is posted.",
    };
  }
  return {
    title: "Results not posted",
    body: "This election has no certified tally yet. Option counts are not estimated from live ballots.",
  };
}

function outcomeBanner(question, h) {
  const outcome = question.outcome;
  if (!outcome) return null;
  if (outcome.status === "not_computed") {
    return h(
      "div",
      { class: "notice notice-warn", role: "status" },
      h("p", { text: outcome.note || "Ranked-choice winner is not computed on this page." })
    );
  }
  if (outcome.status === "tie") {
    return h(
      "div",
      { class: "notice notice-warn results-tie", role: "status" },
      h("p", { class: "results-kicker", text: "Tie" }),
      h("p", { text: outcome.note })
    );
  }
  if (outcome.status === "winner") {
    const names = (outcome.winners || []).map((w) => w.label).join(", ") || outcome.winner?.label;
    const irv = outcome.method === "irv" || question.method === "irv";
    return h(
      "div",
      { class: "notice notice-ok results-winner", role: "status" },
      h("p", { class: "results-kicker", text: irv ? "IRV winner" : outcome.winners?.length > 1 ? "Plurality winners" : "Plurality winner" }),
      h("p", { text: outcome.note || `${names} declared.` }),
      outcome.tieBroken
        ? h("p", { class: "field-hint", text: "First-place tie broken by lexicographic option id." })
        : null
    );
  }
  if (outcome.status === "no_votes") {
    return h(
      "div",
      { class: "notice", role: "status" },
      h("p", { text: outcome.note || "No votes were counted for any option." })
    );
  }
  return null;
}

function optionRow(opt, question, h) {
  const count = opt.count;
  const winnerIds = new Set((question.outcome?.winners || []).map((w) => String(w.id)));
  const tiedIds = new Set((question.outcome?.tied || []).map((w) => String(w.id)));
  const isWinner = winnerIds.has(String(opt.id));
  const isTie = tiedIds.has(String(opt.id));
  const width = opt.share != null ? Math.max(0, Math.min(100, Number(opt.share) * 100)) : 0;
  const cls = ["results-option", isWinner ? "is-winner" : null, isTie ? "is-tie" : null]
    .filter(Boolean)
    .join(" ");
  return h(
    "tr",
    { class: cls },
    h("th", { scope: "row", text: opt.label }),
    h("td", { class: "num", text: count == null ? "—" : String(count) }),
    h("td", { class: "num", text: percent(opt.share) }),
    h(
      "td",
      {},
      h(
        "div",
        { class: "tally-bar", "aria-hidden": "true" },
        h("span", { style: { width: `${width}%` } })
      )
    )
  );
}

function irvRoundsTable(question, h) {
  const rounds = question.rounds || question.outcome?.rounds;
  if (!Array.isArray(rounds) || !rounds.length) return null;
  return h(
    "div",
    { class: "table-wrap" },
    h(
      "table",
      { class: "irv-rounds" },
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          h("th", { text: "Round" }),
          h("th", { text: "Continuing" }),
          h("th", { text: "Exhausted" }),
          h("th", { text: "Eliminated" }),
          h("th", { text: "Counts" })
        )
      ),
      h(
        "tbody",
        {},
        ...rounds.map((round) =>
          h(
            "tr",
            {},
            h("td", { text: String(round.round) }),
            h("td", { text: String(round.continuing ?? "—") }),
            h("td", { text: String(round.exhausted ?? "—") }),
            h("td", { text: round.eliminated || "—" }),
            h("td", { text: round.counts ? JSON.stringify(round.counts) : "—" })
          )
        )
      )
    )
  );
}

function questionBlock(question, h) {
  const ranked = question.method === "ranked_choice_not_computed" || question.method === "irv";
  const irv = question.method === "irv";
  return h(
    "section",
    { class: "question results-question", "aria-labelledby": `results-q-${question.id}` },
    h("h2", { id: `results-q-${question.id}`, text: question.prompt || "Question" }),
    h(
      "p",
      {
        class: "field-hint",
        text: irv
          ? "Instant-runoff (ranked choice)."
          : ranked
            ? "Ranked-choice / IRV is not computed here."
            : question.seats > 1
              ? `Plurality, ${question.seats} seats.`
              : "Plurality (most votes).",
      }
    ),
    outcomeBanner(question, h),
    irvRoundsTable(question, h),
    h(
      "div",
      { class: "table-wrap" },
      h(
        "table",
        { class: "results-table" },
        h(
          "thead",
          {},
          h("tr", {}, h("th", { text: "Option" }), h("th", { text: "Count" }), h("th", { text: "Share" }), h("th", { class: "visually-hidden", text: "Share bar" }))
        ),
        h("tbody", {}, ...question.options.map((opt) => optionRow(opt, question, h)))
      )
    )
  );
}

export async function renderResults(main, ctx) {
  const {
    h,
    api,
    loadElection,
    formatTime,
    electionStateInfo,
    electionId,
    SAMPLE_QUESTIONS,
  } = ctx;

  let payload = null;
  let source = "api";
  try {
    payload = await api(`/api/elections/${encodeURIComponent(electionId)}/results`);
  } catch (err) {
    if (err.status && err.status !== 404) {
      throw err;
    }
    const loaded = await loadElection(electionId);
    if (!loaded.election) {
      main.replaceChildren(
        h("div", { class: "page-head" }, h("h1", { text: "Election not found" }), h("p", { text: `No election ${electionId} on this Node.` })),
        h("p", {}, h("a", { class: "btn", href: "/", "data-nav": "", text: "Back to elections" }))
      );
      return;
    }
    source = loaded.source;
    const election = loaded.election;
    const st = electionStateInfo(election.state);
    const status =
      election.state === 4 ? "tallied" : election.state === 3 ? "awaiting_tally" : election.state === 2 ? "open" : election.state === 1 ? "roll_frozen" : "created";
    payload = {
      ...election,
      electionId: election.id,
      results: {
        available: false,
        status,
        message:
          source === "sample"
            ? "This is the built-in sample roll. Certified counts load from the Node at GET /api/elections/:id/results."
            : emptyCopy(status).body,
        questions: (election.questions || SAMPLE_QUESTIONS).map((q) => ({
          id: q.id,
          type: q.type,
          prompt: q.prompt,
          seats: q.maxSelections || 1,
          method: "plurality",
          options: (q.options || []).map((o) => ({ ...o, count: null, share: null })),
          outcome: null,
        })),
      },
    };
  }

  const election = payload;
  const results = payload.results || {};
  const st = electionStateInfo(election.state);
  const available = Boolean(results.available);
  const empty = emptyCopy(results.status);

  const children = [
    h(
      "div",
      { class: "page-head" },
      h("p", { class: "kicker", text: election.jurisdiction || election.jurisdictionId || "Election results" }),
      h("h1", { text: election.title || `Election ${electionId}` }),
      h(
        "p",
        { class: "cluster" },
        h("span", { class: `status-pill ${st.className}`, text: st.label }),
        available
          ? h("span", { class: "status-pill status-tallied", text: "Certified tally" })
          : h("span", { class: "status-pill status-created", text: "No tally yet" }),
        source === "sample" ? h("span", { class: "status-pill status-created", text: "Sample" }) : null
      ),
      h(
        "ul",
        { class: "meta-list" },
        h("li", {}, h("span", { class: "lbl", text: "Election id" }), h("span", { text: String(election.id || election.electionId) })),
        h("li", {}, h("span", { class: "lbl", text: "Opens" }), h("span", { text: formatTime(election.startTime) })),
        h("li", {}, h("span", { class: "lbl", text: "Cutoff" }), h("span", { text: formatTime(election.cutoffTime) })),
        h(
          "li",
          {},
          h("span", { class: "lbl", text: "Published ballots" }),
          h("span", { text: String(election.acceptedBallots ?? results.publishedAcceptedBallots ?? "—") })
        ),
        available
          ? h(
              "li",
              {},
              h("span", { class: "lbl", text: "Tally posted" }),
              h("span", { text: formatTime(results.tallyPostedAt || election.tally?.postedAt) })
            )
          : null
      ),
      h(
        "p",
        {
          class: "field-hint",
          text: "Choice-level data is never shown here. Explorer vote proofs wait until the hour that contained them closes.",
        }
      )
    ),
  ];

  if (source === "sample") {
    children.push(
      h(
        "div",
        { class: "notice notice-warn", role: "status" },
        h("p", { text: results.message })
      )
    );
  } else if (!available) {
    children.push(
      h(
        "div",
        { class: "notice notice-warn empty-results", role: "status" },
        h("h2", { text: empty.title }),
        h("p", { text: results.message || empty.body })
      )
    );
  } else {
    children.push(h("p", { class: "lede", text: results.message }));
  }

  if (available && Array.isArray(results.questions)) {
    children.push(...results.questions.map((q) => questionBlock(questionWithDefaults(q), h)));
  } else if (Array.isArray(results.questions) && results.questions.length) {
    children.push(
      h("h2", { text: "Questions on this ballot" }),
      ...results.questions.map((q) =>
        h(
          "section",
          { class: "question" },
          h("h3", { text: q.prompt || q.id }),
          h(
            "ul",
            { class: "meta-list" },
            ...(q.options || []).map((o) => h("li", {}, h("span", { text: o.label || o.id })))
          )
        )
      )
    );
  }

  children.push(
    h(
      "div",
      { class: "toolbar" },
      h("a", { class: "btn btn-secondary", href: "/", "data-nav": "", text: "All elections" }),
      h(
        "a",
        {
          class: "btn btn-secondary",
          href: `/outcomes/${encodeURIComponent(election.id || electionId)}`,
          "data-nav": "",
          text: "Outcomes monitor",
        }
      ),
      h(
        "a",
        { class: "btn btn-secondary", href: `/vote/${encodeURIComponent(election.id || electionId)}`, "data-nav": "", text: "Ballot" }
      ),
      h(
        "a",
        {
          class: "btn btn-secondary",
          href: `/elections/${encodeURIComponent(election.id || electionId)}/info`,
          "data-nav": "",
          text: "Candidate / measure info",
        }
      ),
      h("a", { class: "btn btn-secondary", href: payload.explorerPath || `/explorer#/election/${encodeURIComponent(election.id || electionId)}`, text: "Explorer" })
    )
  );

  main.replaceChildren(...children);
}

function questionWithDefaults(q) {
  return {
    ...q,
    options: q.options || [],
    outcome: q.outcome || null,
  };
}

export async function renderResultsIndex(main, ctx) {
  const { h, loadElections, formatTime, electionStateInfo } = ctx;
  const { elections, source } = await loadElections();
  const list =
    elections.length === 0
      ? h("div", { class: "notice notice-warn" }, h("p", { text: "No elections are published on this Node yet." }))
      : h(
          "div",
          { class: "grid-cards", role: "list" },
          ...elections.map((election) => {
            const st = electionStateInfo(election.state);
            return h(
              "article",
              { class: "election-card", role: "listitem" },
              h("p", { class: "kicker", text: election.jurisdiction }),
              h("h2", { text: election.title }),
              h("p", { class: "cluster" }, h("span", { class: `status-pill ${st.className}`, text: st.label })),
              h(
                "ul",
                { class: "meta-list" },
                h("li", {}, h("span", { class: "lbl", text: "Cutoff" }), h("span", { text: formatTime(election.cutoffTime) }))
              ),
              h(
                "div",
                { class: "cluster" },
                h(
                  "a",
                  {
                    class: election.state >= 4 ? "btn" : "btn btn-secondary",
                    href: `/elections/${encodeURIComponent(election.id)}/results`,
                    "data-nav": "",
                    text: election.state >= 4 ? "Certified results" : "Results status",
                  }
                )
              )
            );
          })
        );

  main.replaceChildren(
    h(
      "div",
      { class: "page-head" },
      h("p", { class: "kicker", text: "Observers" }),
      h("h1", { text: "Election results" }),
      h(
        "p",
        {
          class: "lede",
          text: "Certified plurality totals after a tally. While a poll is open or awaiting a tally, this page does not show unofficial choice counts.",
        }
      ),
      source === "sample"
        ? h("div", { class: "notice notice-warn" }, h("p", { text: "Showing the built-in sample roll because /api/elections is not available." }))
        : null
    ),
    list
  );
}

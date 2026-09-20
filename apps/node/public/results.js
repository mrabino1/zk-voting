/**
 * NOT FOR PROFIT — Republic is a civic public good. Not a commercial product.
 * Certified election results: per-option counts after a tally, plurality
 * winners and ties. No unofficial choice totals while polls are open.
 */

import { t } from "./i18n.js";

function percent(share) {
  if (share == null || !Number.isFinite(Number(share))) return t("common.dash");
  return `${Math.round(Number(share) * 1000) / 10}%`;
}

function emptyCopy(status) {
  if (status === "open") {
    return {
      title: t("results.votingOpen"),
      body: t("results.emptyOpenBody"),
    };
  }
  if (status === "awaiting_tally" || status === "closed") {
    return {
      title: t("results.emptyClosedTitle"),
      body: t("results.emptyClosedBody"),
    };
  }
  if (status === "roll_frozen") {
    return {
      title: t("results.rollFrozen"),
      body: t("results.emptySoonBody"),
    };
  }
  return {
    title: t("results.notPosted"),
    body: t("results.emptyGeneric"),
  };
}

function outcomeBanner(question, h) {
  const outcome = question.outcome;
  if (!outcome) return null;
  if (outcome.status === "not_computed") {
    return h(
      "div",
      { class: "notice notice-warn", role: "status" },
      h("p", { text: outcome.note || t("results.irvNote") })
    );
  }
  if (outcome.status === "tie") {
    return h(
      "div",
      { class: "notice notice-warn results-tie", role: "status" },
      h("p", { class: "results-kicker", text: t("results.tie") }),
      h("p", { text: outcome.note })
    );
  }
  if (outcome.status === "winner") {
    const names = (outcome.winners || []).map((w) => w.label).join(", ") || outcome.winner?.label;
    const irv = outcome.method === "irv" || question.method === "irv";
    return h(
      "div",
      { class: "notice notice-ok results-winner", role: "status" },
      h("p", { class: "results-kicker", text: irv ? t("explorer.irvWinner") : outcome.winners?.length > 1 ? t("results.pluralityWinners") : t("results.pluralityWinner") }),
      h("p", { text: outcome.note || t("results.declared", { names }) }),
      outcome.tieBroken
        ? h("p", { class: "field-hint", text: t("results.lexTie") })
        : null
    );
  }
  if (outcome.status === "no_votes") {
    return h(
      "div",
      { class: "notice", role: "status" },
      h("p", { text: outcome.note || t("results.noVotes") })
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
    h("td", { class: "num", text: count == null ? t("common.dash") : String(count) }),
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
          h("th", { text: t("results.round") }),
          h("th", { text: t("results.continuing") }),
          h("th", { text: t("results.exhausted") }),
          h("th", { text: t("results.eliminated") }),
          h("th", { text: t("results.counts") })
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
            h("td", { text: String(round.continuing ?? t("common.dash")) }),
            h("td", { text: String(round.exhausted ?? t("common.dash")) }),
            h("td", { text: round.eliminated || t("common.dash") }),
            h("td", { text: round.counts ? JSON.stringify(round.counts) : t("common.dash") })
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
    h("h2", { id: `results-q-${question.id}`, text: question.prompt || t("results.questionFallback") }),
    h(
      "p",
      {
        class: "field-hint",
        text: irv
          ? t("results.irvMethod")
          : ranked
            ? t("results.irvMissing")
            : question.seats > 1
              ? t("results.pluralitySeats", { count: question.seats })
              : t("results.plurality"),
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
          h("tr", {}, h("th", { text: t("results.option") }), h("th", { text: t("results.count") }), h("th", { text: t("results.share") }), h("th", { class: "visually-hidden", text: t("results.shareBar") }))
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
    sampleQuestions,
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
        h("div", { class: "page-head" }, h("h1", { text: t("common.electionNotFound") }), h("p", { text: t("common.noElectionOnNode", { id: electionId }) })),
        h("p", {}, h("a", { class: "btn", href: "/", "data-nav": "", text: t("common.backToElections") }))
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
            ? t("results.sampleApi")
            : emptyCopy(status).body,
        questions: (election.questions || (sampleQuestions ? sampleQuestions() : [])).map((q) => ({
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
      h("p", { class: "kicker", text: election.jurisdiction || election.jurisdictionId || t("results.title") }),
      h("h1", { text: election.title || t("sample.electionFallback", { id: electionId }) }),
      h(
        "p",
        { class: "cluster" },
        h("span", { class: `status-pill ${st.className}`, text: st.label }),
        available
          ? h("span", { class: "status-pill status-tallied", text: t("results.certified") })
          : h("span", { class: "status-pill status-created", text: t("results.noTally") }),
        source === "sample" ? h("span", { class: "status-pill status-created", text: t("common.sample") }) : null
      ),
      h(
        "ul",
        { class: "meta-list" },
        h("li", {}, h("span", { class: "lbl", text: t("results.electionId") }), h("span", { text: String(election.id || election.electionId) })),
        h("li", {}, h("span", { class: "lbl", text: t("results.opens") }), h("span", { text: formatTime(election.startTime) })),
        h("li", {}, h("span", { class: "lbl", text: t("results.cutoff") }), h("span", { text: formatTime(election.cutoffTime) })),
        h(
          "li",
          {},
          h("span", { class: "lbl", text: t("results.publishedBallots") }),
          h("span", { text: String(election.acceptedBallots ?? results.publishedAcceptedBallots ?? t("common.dash")) })
        ),
        available
          ? h(
              "li",
              {},
              h("span", { class: "lbl", text: t("results.tallyPosted") }),
              h("span", { text: formatTime(results.tallyPostedAt || election.tally?.postedAt) })
            )
          : null
      ),
      h(
        "p",
        {
          class: "field-hint",
          text: t("results.privacy"),
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
      h("h2", { text: t("results.questions") }),
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
      h("a", { class: "btn btn-secondary", href: "/", "data-nav": "", text: t("common.allElections") }),
      h(
        "a",
        { class: "btn btn-secondary", href: `/vote/${encodeURIComponent(election.id || electionId)}`, "data-nav": "", text: t("results.ballot") }
      ),
      h(
        "a",
        {
          class: "btn btn-secondary",
          href: `/elections/${encodeURIComponent(election.id || electionId)}/info`,
          "data-nav": "",
          text: t("results.candidateInfo"),
        }
      ),
      h("a", { class: "btn btn-secondary", href: payload.explorerPath || `/explorer#/election/${encodeURIComponent(election.id || electionId)}`, text: t("results.explorer") })
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
      ? h("div", { class: "notice notice-warn" }, h("p", { text: t("home.noElections") }))
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
                h("li", {}, h("span", { class: "lbl", text: t("results.cutoff") }), h("span", { text: formatTime(election.cutoffTime) }))
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
                    text: election.state >= 4 ? t("results.certifiedResults") : t("results.resultsStatus"),
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
      h("p", { class: "kicker", text: t("results.observers") }),
      h("h1", { text: t("results.title") }),
      h(
        "p",
        {
          class: "lede",
          text: t("results.lede"),
        }
      ),
      source === "sample"
        ? h("div", { class: "notice notice-warn" }, h("p", { text: t("results.sampleNote") }))
        : null
    ),
    list
  );
}

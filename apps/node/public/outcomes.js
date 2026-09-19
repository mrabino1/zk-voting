/**
 * NOT FOR PROFIT — Republic is a civic public good. Not a commercial product.
 * Public monitor: every election, verified, in before / during / after columns
 * from chain and election state. Certified option counts only after a tally.
 * Never shows how a person voted.
 */

const PHASE_ORDER = ["before", "during", "after"];

const PHASE_COPY = {
  before: {
    title: "Before voting",
    body: "Created or roll-frozen. Polls have not opened. Roots and the on-chain mapping can already be checked.",
  },
  during: {
    title: "During voting",
    body: "The poll is open. Turnout is the last closed hour. Option counts wait for a certified tally.",
  },
  after: {
    title: "After voting",
    body: "Polls are closed. Certified option counts appear when a tally is posted. L1 may mirror the tally hash.",
  },
};

function hexShort(value) {
  const s = String(value || "");
  if (!s) return "—";
  if (s.length <= 18) return s;
  return `${s.slice(0, 10)}…${s.slice(-6)}`;
}

function checkEntries(verification) {
  const rows = [];
  const auditor = verification?.auditor?.checks || {};
  const chain = verification?.chain?.checks || {};
  for (const [name, ok] of Object.entries(auditor)) {
    rows.push({ group: "Auditor pack", name, ok: Boolean(ok) });
  }
  for (const [name, ok] of Object.entries(chain)) {
    rows.push({ group: "Chain status", name, ok: Boolean(ok) });
  }
  return rows;
}

function verifyPill(ok, h) {
  return h(
    "span",
    {
      class: `status-pill ${ok ? "status-open" : "status-error"}`,
      text: ok ? "Verified" : "Checks failed",
    }
  );
}

function chainPill(mode, h) {
  const onchain = mode === "onchain";
  return h(
    "span",
    {
      class: `status-pill ${onchain ? "status-tallied" : "status-created"}`,
      text: onchain ? "On chain" : "Demo chain",
    }
  );
}

function outcomeCard(row, ctx) {
  const { h, formatTime, electionStateInfo } = ctx;
  const st = electionStateInfo(row.state);
  return h(
    "article",
    { class: "election-card outcomes-card", role: "listitem" },
    h("p", { class: "kicker", text: row.jurisdictionId || "Election" }),
    h("h3", { text: row.title }),
    h(
      "p",
      { class: "cluster" },
      h("span", { class: `status-pill ${st.className}`, text: st.label }),
      chainPill(row.chainMode, h),
      verifyPill(row.verificationOk, h)
    ),
    h(
      "ul",
      { class: "meta-list" },
      h("li", {}, h("span", { class: "lbl", text: "Opens" }), h("span", { text: formatTime(row.startTime) })),
      h("li", {}, h("span", { class: "lbl", text: "Cutoff" }), h("span", { text: formatTime(row.cutoffTime) })),
      h(
        "li",
        {},
        h("span", { class: "lbl", text: "Disclosed ballots" }),
        h("span", { class: "num", text: String(row.acceptedBallots ?? 0) })
      )
    ),
    h(
      "div",
      { class: "cluster" },
      h("a", { class: "btn", href: row.href || `/outcomes/${encodeURIComponent(row.id)}`, "data-nav": "", text: "Verify outcome" })
    )
  );
}

function phaseColumn(phase, rows, ctx) {
  const { h } = ctx;
  const copy = PHASE_COPY[phase];
  return h(
    "section",
    { class: `outcomes-column phase-${phase}`, "aria-labelledby": `phase-${phase}-heading` },
    h("p", { class: "kicker", text: `${rows.length} contest${rows.length === 1 ? "" : "s"}` }),
    h("h2", { id: `phase-${phase}-heading`, text: copy.title }),
    h("p", { class: "field-hint", text: copy.body }),
    rows.length
      ? h("div", { class: "outcomes-stack", role: "list" }, ...rows.map((row) => outcomeCard(row, ctx)))
      : h("p", { class: "field-hint", text: "No elections in this phase on this Node." })
  );
}

export async function renderOutcomesIndex(main, ctx) {
  const { h, api, setTitle } = ctx;
  setTitle("Election outcomes");
  let payload = { phases: { before: [], during: [], after: [] }, counts: { total: 0 }, chain: {} };
  let error = "";
  try {
    payload = await api("/api/outcomes");
  } catch (err) {
    error = err.message || "Could not load outcomes.";
  }
  const phases = payload.phases || {};
  main.replaceChildren(
    h(
      "div",
      { class: "page-head" },
      h("p", { class: "kicker", text: "Public monitor" }),
      h("h1", { text: "Election outcomes" }),
      h("p", {
        class: "lede",
        text: "Every contest on this Node, grouped by chain status: before voting, during voting, and after voting. Each card runs the public auditor pack plus freeze-root and L1 checks. This is not the receipt portal and it is not unofficial horse-race totals.",
      }),
      h(
        "p",
        { class: "field-hint" },
        `Chain ${payload.chain?.configured ? "RPC configured" : "demo (JSON store)"}${
          payload.chain?.l1Configured ? " · L1 certification on" : " · L1 unset"
        }. ${payload.counts?.total || 0} election${payload.counts?.total === 1 ? "" : "s"}.`
      )
    ),
    error ? h("div", { class: "notice notice-error", role: "alert" }, h("p", { text: error })) : null,
    h(
      "div",
      { class: "outcomes-board", role: "region", "aria-label": "Elections by phase" },
      ...PHASE_ORDER.map((phase) => phaseColumn(phase, phases[phase] || [], ctx))
    ),
    h(
      "p",
      { class: "field-hint" },
      "Paste a personal vote receipt at ",
      h("a", { href: "/receipt", "data-nav": "", text: "/receipt" }),
      ". Certified plurality pages live at ",
      h("a", { href: "/elections", "data-nav": "", text: "/elections" }),
      "."
    )
  );
}

function checksTable(verification, h) {
  const rows = checkEntries(verification);
  if (!rows.length) {
    return h("p", { class: "field-hint", text: "No verification checks were returned." });
  }
  return h(
    "div",
    { class: "table-wrap" },
    h(
      "table",
      { class: "outcomes-checks" },
      h(
        "thead",
        {},
        h("tr", {}, h("th", { text: "Group" }), h("th", { text: "Check" }), h("th", { text: "Result" }))
      ),
      h(
        "tbody",
        {},
        ...rows.map((row) =>
          h(
            "tr",
            { class: row.ok ? "check-ok" : "check-fail" },
            h("td", { text: row.group }),
            h("td", { text: row.name }),
            h("td", { text: row.ok ? "Pass" : "Fail" })
          )
        )
      )
    )
  );
}

function certifiedBlock(detail, ctx) {
  const { h } = ctx;
  const certified = detail.certified;
  if (detail.phase !== "after") {
    return h(
      "div",
      { class: "notice", role: "status" },
      h("h2", { text: "Certified outcome not published yet" }),
      h("p", {
        text: "While this contest is before or during voting, this portal does not show option counts. Turnout below is the last disclosed hour.",
      })
    );
  }
  if (!certified || !certified.available) {
    return h(
      "div",
      { class: "notice notice-warn", role: "status" },
      h("h2", { text: "Awaiting certified tally" }),
      h("p", { text: certified?.message || "Polls are closed. A certified tally has not been posted yet." })
    );
  }
  return h(
    "section",
    { class: "outcomes-certified", "aria-labelledby": "certified-heading" },
    h("h2", { id: "certified-heading", text: "Certified outcome" }),
    h("p", { text: certified.message }),
    ...(certified.questions || []).map((q) =>
      h(
        "section",
        { class: "question" },
        h("h3", { text: q.prompt || q.id }),
        q.outcome?.note ? h("p", { class: "field-hint", text: q.outcome.note }) : null,
        h(
          "div",
          { class: "table-wrap" },
          h(
            "table",
            { class: "results-table" },
            h(
              "thead",
              {},
              h("tr", {}, h("th", { text: "Option" }), h("th", { class: "num", text: "Count" }))
            ),
            h(
              "tbody",
              {},
              ...(q.options || []).map((opt) =>
                h(
                  "tr",
                  {},
                  h("th", { scope: "row", text: opt.label || opt.id }),
                  h("td", { class: "num", text: opt.count == null ? "—" : String(opt.count) })
                )
              )
            )
          )
        )
      )
    )
  );
}

export async function renderOutcomesDetail(main, ctx) {
  const { h, api, setTitle, formatTime, electionStateInfo, electionId } = ctx;
  setTitle("Election outcome");
  let detail = null;
  let error = "";
  try {
    detail = await api(`/api/outcomes/${encodeURIComponent(electionId)}`);
  } catch (err) {
    error = err.message || "Election not found.";
  }

  if (!detail) {
    main.replaceChildren(
      h("div", { class: "page-head" }, h("h1", { text: "Outcome not found" })),
      h("div", { class: "notice notice-error", role: "alert" }, h("p", { text: error || "That election is not on this Node." })),
      h("p", {}, h("a", { class: "btn", href: "/outcomes", "data-nav": "", text: "All outcomes" }))
    );
    return;
  }

  setTitle(`${detail.title} — outcome`);
  const st = electionStateInfo(detail.state);
  const v = detail.verification || {};
  const chain = detail.chain || {};
  const freeze = detail.freeze || {};
  const roots = detail.roots || {};
  const turnout = detail.turnout || {};
  const errors = Array.isArray(v.errors) ? v.errors : [];

  main.replaceChildren(
    h(
      "div",
      { class: "page-head" },
      h("p", { class: "kicker", text: detail.phaseLabel || detail.phase }),
      h("h1", { text: detail.title }),
      h("p", { class: "lede", text: detail.phaseNote }),
      h(
        "p",
        { class: "cluster" },
        h("span", { class: `status-pill ${st.className}`, text: st.label }),
        chainPill(chain.mode, h),
        verifyPill(v.ok, h)
      )
    ),
    errors.length
      ? h(
          "div",
          { class: "notice notice-error", role: "alert" },
          h("p", { text: "Verification reported problems:" }),
          h(
            "ul",
            {},
            ...errors.map((msg) => h("li", { text: String(msg) }))
          )
        )
      : h(
          "div",
          { class: "notice notice-ok", role: "status" },
          h("p", {
            text: "Auditor pack and chain-status checks passed for the public artifacts on this Node.",
          })
        ),
    h(
      "section",
      { "aria-labelledby": "chain-heading" },
      h("h2", { id: "chain-heading", text: "Chain status" }),
      h(
        "ul",
        { class: "meta-list" },
        h("li", {}, h("span", { class: "lbl", text: "Mode" }), h("span", { text: chain.mode || "—" })),
        h("li", {}, h("span", { class: "lbl", text: "Chain id" }), h("span", { text: String(chain.chainId ?? "—") })),
        h(
          "li",
          {},
          h("span", { class: "lbl", text: "Factory" }),
          h("span", { class: "hex", title: chain.factoryAddress || "", text: hexShort(chain.factoryAddress) })
        ),
        h(
          "li",
          {},
          h("span", { class: "lbl", text: "Create tx" }),
          h("span", { class: "hex", title: chain.createTxHash || "", text: hexShort(chain.createTxHash) })
        ),
        h(
          "li",
          {},
          h("span", { class: "lbl", text: "Election contract" }),
          h("span", { class: "hex", title: chain.onChainElectionAddress || "", text: hexShort(chain.onChainElectionAddress) })
        ),
        h(
          "li",
          {},
          h("span", { class: "lbl", text: "On-chain id" }),
          h("span", { text: chain.onChainElectionId != null ? String(chain.onChainElectionId) : "—" })
        ),
        h("li", {}, h("span", { class: "lbl", text: "L1 status" }), h("span", { text: chain.l1Status || "n/a" })),
        h(
          "li",
          {},
          h("span", { class: "lbl", text: "L1 hash" }),
          h("span", { class: "hex", title: chain.l1ResultHash || "", text: hexShort(chain.l1ResultHash) })
        )
      )
    ),
    h(
      "section",
      { "aria-labelledby": "freeze-heading" },
      h("h2", { id: "freeze-heading", text: "Window and freeze" }),
      h(
        "ul",
        { class: "meta-list" },
        h("li", {}, h("span", { class: "lbl", text: "Opens" }), h("span", { text: formatTime(detail.window?.startTime) })),
        h("li", {}, h("span", { class: "lbl", text: "Cutoff" }), h("span", { text: formatTime(detail.window?.cutoffTime) })),
        h("li", {}, h("span", { class: "lbl", text: "Roll frozen" }), h("span", { text: freeze.rollFrozen ? "Yes" : "No" })),
        freeze.frozenAt
          ? h("li", {}, h("span", { class: "lbl", text: "Frozen at" }), h("span", { text: freeze.frozenAt }))
          : null,
        h(
          "li",
          {},
          h("span", { class: "lbl", text: "Eligible root" }),
          h("span", { class: "hex", title: roots.eligibleRoot || "", text: hexShort(roots.eligibleRoot) })
        ),
        h(
          "li",
          {},
          h("span", { class: "lbl", text: "Disqualification root" }),
          h("span", { class: "hex", title: roots.disqualificationRoot || "", text: hexShort(roots.disqualificationRoot) })
        ),
        h(
          "li",
          {},
          h("span", { class: "lbl", text: "Ballot spec" }),
          h("span", { class: "hex", title: roots.ballotSpecHash || "", text: hexShort(roots.ballotSpecHash) })
        )
      )
    ),
    h(
      "section",
      { "aria-labelledby": "turnout-heading" },
      h("h2", { id: "turnout-heading", text: "Disclosed turnout" }),
      h("p", {
        class: "field-hint",
        text: "Hourly snapshot of accepted ballots. Not a count by candidate or option, and not a live tick while the hour is still open.",
      }),
      h(
        "ul",
        { class: "meta-list" },
        h(
          "li",
          {},
          h("span", { class: "lbl", text: "Disclosed ballots" }),
          h("span", { class: "num", text: String(turnout.acceptedBallots ?? 0) })
        ),
        h(
          "li",
          {},
          h("span", { class: "lbl", text: "Eligible commitments" }),
          h("span", { class: "num", text: String(turnout.eligibleCount ?? turnout.participantCount ?? 0) })
        )
      )
    ),
    h(
      "section",
      { "aria-labelledby": "verify-heading" },
      h("h2", { id: "verify-heading", text: "Verification" }),
      h("p", {
        class: "field-hint",
        text: "The Node runs tools/auditor verify on the public artifacts pack, then freeze-root and L1 hash checks. Independent observers can download the same JSON from the artifacts link.",
      }),
      checksTable(v, h)
    ),
    certifiedBlock(detail, ctx),
    h(
      "div",
      { class: "toolbar" },
      h("a", { class: "btn", href: "/outcomes", "data-nav": "", text: "All outcomes" }),
      h("a", { class: "btn btn-secondary", href: detail.links?.artifacts || "#", text: "Auditor pack" }),
      detail.links?.results
        ? h("a", { class: "btn btn-secondary", href: detail.links.results, "data-nav": "", text: "Results page" })
        : null,
      h("a", { class: "btn btn-secondary", href: detail.links?.explorer || "/explorer", text: "Explorer" }),
      h("a", { class: "btn btn-secondary", href: "/receipt", "data-nav": "", text: "Check a receipt" })
    )
  );
}

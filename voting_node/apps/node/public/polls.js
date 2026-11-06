/**
 * NOT FOR PROFIT — civic public good, not a commercial product.
 * Token polls use the same contest layout as civic elections.
 * Holding or delegating the token is the credential. The choice is public
 * after the disclosure hour. A civic election is the secret ballot.
 */

import {
  contestCard,
  contestFacts,
  contestGrid,
  contestMeter,
  contestPanel,
  contestSplit,
  contestStats,
  contestTabs,
  contestTags,
  shortContestId,
  windowPercent,
} from "./contests.js";
import { t } from "./i18n.js";

function banner(h) {
  if (typeof document !== "undefined" && document.documentElement?.dataset?.clientHost === "1") return null;
  return h(
    "p",
    { class: "poll-signal", role: "note", "data-testid": "poll-signal" },
    h("strong", { text: t("polls.signal") }),
    " · ",
    t("polls.nfpFooter")
  );
}

function formatUnits(raw, decimals) {
  let n;
  try {
    n = BigInt(raw ?? "0");
  } catch {
    return String(raw ?? "0");
  }
  const d = Number(decimals || 0);
  if (!Number.isInteger(d) || d <= 0) return n.toString();
  const base = 10n ** BigInt(d);
  const whole = n / base;
  const frac = (n % base).toString().padStart(d, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

function weightLabel(raw, poll) {
  const shown = formatUnits(raw, poll?.decimals);
  const symbol = poll?.tokenSymbol ? ` ${poll.tokenSymbol}` : "";
  return `${shown}${symbol}`;
}

function weightWithUnits(raw, poll) {
  return `${weightLabel(raw, poll)} (${raw} ${t("polls.baseUnits")})`;
}

function countedLabel(raw, poll) {
  if ((poll?.weighting || "gross") === "quadratic") return String(raw ?? "0");
  return weightLabel(raw, poll);
}

function sharePercent(weight, total) {
  let w;
  let sum;
  try {
    w = BigInt(weight || "0");
    sum = BigInt(total || "0");
  } catch {
    return 0;
  }
  if (sum <= 0n) return 0;
  const bps = (w * 10000n) / sum;
  return Number(bps) / 100;
}

function optionLabel(poll, id) {
  const row = (poll?.options || []).find((o) => o.id === id);
  if (row) return row.id === "abstain" ? t("polls.abstain") : row.label;
  return id === "abstain" ? t("polls.abstain") : String(id);
}

function weightingLabel(poll) {
  return poll?.weighting === "quadratic" ? t("polls.weightQuadratic") : t("polls.weightGross");
}

function ruleLabel(poll) {
  if (poll?.pollType === "ranked_irv" || poll?.decisionRule === "ranked_irv") return t("polls.typeIrv");
  if (poll?.decisionRule === "plurality") return t("polls.ruleMost");
  return t("polls.ruleMajority");
}

function weightModeLabel(poll) {
  return poll?.weightSource === "erc20_votes" ? t("polls.weightVotes") : t("polls.weightHold");
}

function votesMode(poll) {
  return poll?.weightSource === "erc20_votes";
}

function hPage(h, children) {
  return h("div", { class: "poll-page contest-page" }, ...children);
}

async function connectWallet() {
  const eth = globalThis.ethereum;
  if (!eth || typeof eth.request !== "function") {
    const err = new Error(t("polls.noWallet"));
    err.code = "NO_WALLET";
    throw err;
  }
  const accounts = await eth.request({ method: "eth_requestAccounts" });
  const address = Array.isArray(accounts) ? accounts[0] : null;
  if (!address) throw new Error(t("polls.noWallet"));
  return address;
}

function rankList(h, poll, order, redraw) {
  function move(from, to) {
    if (to < 0 || to >= order.length || from === to) return;
    const [row] = order.splice(from, 1);
    order.splice(to, 0, row);
    redraw();
  }
  return h(
    "ol",
    { class: "rank-list" },
    ...order.map((id, index) =>
      h(
        "li",
        {
          class: "rank-row",
          draggable: "true",
          onDragstart: (ev) => {
            ev.dataTransfer.setData("text/plain", String(index));
            ev.dataTransfer.effectAllowed = "move";
          },
          onDragover: (ev) => ev.preventDefault(),
          onDrop: (ev) => {
            ev.preventDefault();
            const from = Number(ev.dataTransfer.getData("text/plain"));
            if (Number.isInteger(from)) move(from, index);
          },
        },
        h("span", { class: "rank-handle", "aria-hidden": "true", text: "⋮⋮" }),
        h("span", { class: "rank-label", text: `${index + 1}. ${optionLabel(poll, id)}` }),
        h(
          "span",
          { class: "rank-move" },
          h("button", {
            type: "button",
            class: "btn btn-secondary rank-btn",
            text: t("polls.up"),
            disabled: index === 0,
            onClick: () => move(index, index - 1),
          }),
          h("button", {
            type: "button",
            class: "btn btn-secondary rank-btn",
            text: t("polls.down"),
            disabled: index === order.length - 1,
            onClick: () => move(index, index + 1),
          })
        )
      )
    )
  );
}

function receiptView(h, receipt) {
  return h(
    "section",
    { class: "contest-panel", "data-testid": "poll-receipt" },
    h("h2", { text: t("polls.receiptTitle") }),
    h("p", { text: t("polls.receiptNote") }),
    contestFacts(h, [
      { label: t("polls.address"), value: receipt.voter || "—" },
      { label: t("polls.provisional"), value: String(receipt.provisionalWeight ?? "—") },
      { label: "voteBlock", value: String(receipt.voteBlock ?? "—") },
      { label: "digest", value: receipt.ballotDigest || "—" },
    ])
  );
}

function lookupPanel(h, ctx, poll) {
  const input = h("input", {
    id: "poll-lookup-address",
    name: "address",
    spellcheck: "false",
    autocomplete: "off",
    placeholder: "0x…",
  });
  const out = h("div", { "data-testid": "poll-lookup-result" });
  return h(
    "section",
    { class: "contest-panel" },
    h("h2", { text: t("polls.lookup") }),
    h(
      "form",
      {
        class: "form-grid",
        onSubmit: async (ev) => {
          ev.preventDefault();
          out.replaceChildren(h("p", { text: t("common.loading") }));
          try {
            const data = await ctx.api(
              `/api/polls/${encodeURIComponent(poll.id)}/weight?address=${encodeURIComponent(input.value.trim())}`
            );
            const lines = [data.voted ? t("polls.voted") : t("polls.notVoted")];
            if (data.currentBalance != null) lines.push(`${t("polls.yourWeight")}: ${weightWithUnits(data.currentBalance, poll)}`);
            if (data.countedWeight != null && data.weighting === "quadratic") {
              lines.push(`${t("polls.countedWeight")}: ${data.countedWeight}`);
            }
            if (data.provisionalWeight != null) lines.push(`${t("polls.provisional")}: ${weightWithUnits(data.provisionalWeight, poll)}`);
            if (data.finalWeight != null) lines.push(`${t("polls.finalWeight")}: ${weightWithUnits(data.finalWeight, poll)}`);
            if (data.reduced) lines.push(t("polls.reduced"));
            if (data.status === "withdrawn_by_transfer") lines.push(t("polls.withdrawnStatus"));
            if (data.voted && !data.disclosed) lines.push(t("polls.sealed"));
            if (data.choices) lines.push(data.choices.map((id) => optionLabel(poll, id)).join(" → "));
            out.replaceChildren(...lines.map((line) => h("p", { text: line })));
          } catch (err) {
            out.replaceChildren(h("p", { class: "notice notice-error", role: "alert", text: err.message }));
          }
        },
      },
      h("label", { class: "field-label", for: "poll-lookup-address", text: t("polls.address") }),
      input,
      h("button", { class: "btn", type: "submit", text: t("polls.lookupSubmit") })
    ),
    out
  );
}

function shortAddress(addr) {
  const text = String(addr || "");
  if (text.length < 16) return text;
  return `${text.slice(0, 6)}…${text.slice(-4)}`;
}

function pollFacts(ctx, poll) {
  const token = [poll.tokenSymbol, shortAddress(poll.token)].filter(Boolean).join(" ");
  return [
    { label: t("polls.opens"), value: ctx.formatTime(poll.startTime) },
    { label: t("polls.closes"), value: ctx.formatTime(poll.cutoffTime) },
    { label: t("polls.countLabel"), value: weightingLabel(poll) },
    { label: t("polls.winsBy"), value: ruleLabel(poll) },
    { label: t("polls.credential"), value: weightModeLabel(poll) },
    { label: t("polls.token"), value: token || "—" },
    { label: t("polls.chain"), value: String(poll.tokenChainId ?? "—") },
  ];
}

function pollTags(poll) {
  const seen = new Set();
  const tags = [
    { text: poll.state || "", accent: poll.state === "OPEN" || poll.state === "TALLIED" },
    { text: weightingLabel(poll), accent: true },
    { text: ruleLabel(poll) },
    poll.tokenSymbol ? { text: poll.tokenSymbol } : null,
    ...(poll.tags || []).map((tag) => ({ text: tag })),
  ];
  return tags.filter((tag) => {
    const key = String(tag?.text || "").trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function nonAbstainTotal(counts) {
  let total = 0n;
  for (const [id, weight] of Object.entries(counts || {})) {
    if (id === "abstain") continue;
    try {
      total += BigInt(weight || "0");
    } catch {
      /* display only */
    }
  }
  return total;
}

function resultFoot(poll, result) {
  if (!result) return poll.state || "";
  const winner = result.winner;
  if (result.outcome === "WINNER" && winner) {
    const quadratic = (result.weighting || poll.weighting) === "quadratic";
    const weight = quadratic
      ? `${countedLabel(result.counts?.[winner], { weighting: "quadratic" })} counted${
          result.grossCounts ? ` (${weightLabel(result.grossCounts[winner], poll)} gross)` : ""
        }`
      : weightLabel(result.counts?.[winner], poll);
    return t("polls.winningLine", { option: optionLabel(poll, winner), weight });
  }
  if (result.outcome === "NO_MAJORITY") {
    const lead = result.leader ? ` ${t("polls.leadingLine", { option: optionLabel(poll, result.leader) })}` : "";
    return `${t("polls.noMajorityLine")}${lead}`;
  }
  if (result.outcome === "TIE" || (result.flags || []).includes("TIE")) return t("polls.tieLine");
  if ((result.flags || []).includes("QUORUM_NOT_MET") || result.outcome === "QUORUM_NOT_MET") return t("polls.quorumMiss");
  return result.outcome || poll.state || "";
}

function matchesTab(poll, tab) {
  if (tab === "open") return poll.state === "OPEN";
  if (tab === "scheduled") return poll.state === "SCHEDULED" || poll.state === "DRAFT";
  if (tab === "closed") return poll.state === "CLOSED" || poll.state === "TALLYING";
  if (tab === "tallied") return poll.state === "TALLIED";
  return true;
}

export async function renderPollsIndex(main, ctx) {
  ctx.setTitle(t("polls.listTitle"));
  const data = await ctx.api("/api/polls");
  const polls = Array.isArray(data.polls) ? data.polls : [];
  let tab = "all";

  function paint() {
    const open = polls.filter((poll) => poll.state === "OPEN");
    const tallied = polls.filter((poll) => poll.state === "TALLIED");
    const next = open
      .map((poll) => Number(poll.cutoffTime))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b)[0];
    const shown = polls.filter((poll) => matchesTab(poll, tab));
    const cards = shown.map((poll) => {
      const pct = windowPercent(poll.startTime, poll.cutoffTime);
      return contestCard(ctx.h, {
        href: `/polls/${encodeURIComponent(poll.id)}`,
        kicker: t("polls.posted", { when: ctx.formatTime(poll.createdAt || poll.startTime) }),
        idLabel: t("polls.pollId", { id: shortContestId(poll.id) }),
        title: poll.title,
        summary: poll.summary || "",
        tags: pollTags(poll),
        facts: [
          { label: t("polls.opens"), value: ctx.formatTime(poll.startTime) },
          { label: t("polls.closes"), value: ctx.formatTime(poll.cutoffTime) },
          { label: t("polls.countLabel"), value: weightingLabel(poll) },
          { label: t("polls.winsBy"), value: ruleLabel(poll) },
        ],
        meter: pct == null ? null : { label: t("polls.windowMeter", { pct: String(pct) }), pct },
        foot: resultFoot(poll, poll.result),
      });
    });
    main.replaceChildren(
      hPage(ctx.h, [
        banner(ctx.h),
        ctx.h(
          "header",
          { class: "page-head" },
          ctx.h("h1", { text: t("polls.listTitle") }),
          ctx.h("p", { class: "lede", text: t("polls.listLede") }),
          ctx.h("p", {}, ctx.h("a", { href: "/elections", "data-nav": "", text: t("polls.civicLink") }))
        ),
        contestStats(ctx.h, [
          { label: t("polls.statOpen"), value: String(open.length), hint: open.length ? t("polls.voteLink") : t("polls.empty") },
          {
            label: t("polls.statNext"),
            value: next ? ctx.formatTime(next) : "—",
            hint: next ? t("polls.closes") : t("polls.statNone"),
          },
          { label: t("polls.statTallied"), value: String(tallied.length) },
        ]),
        contestTabs(ctx.h, {
          label: t("polls.listTitle"),
          current: tab,
          onChange: (id) => {
            tab = id;
            paint();
          },
          tabs: [
            { id: "all", label: t("polls.tabAll") },
            { id: "open", label: t("polls.tabOpen") },
            { id: "scheduled", label: t("polls.tabScheduled") },
            { id: "closed", label: t("polls.tabClosed") },
            { id: "tallied", label: t("polls.tabTallied") },
          ],
        }),
        shown.length
          ? contestGrid(ctx.h, cards, { "data-testid": "polls-list" })
          : ctx.h("p", { class: "notice", text: polls.length ? t("polls.emptyFilter") : t("polls.empty") }),
      ])
    );
  }
  paint();
}

function countCopy(poll) {
  if (poll.pollType === "ranked_irv") return `${poll.weighting === "quadratic" ? t("polls.countQuadraticBody") : t("polls.countGrossBody")} ${t("polls.countIrvBody")}`;
  return poll.weighting === "quadratic" ? t("polls.countQuadraticBody") : t("polls.countGrossBody");
}

function storyPanel(h, ctx, poll) {
  const paragraphs = String(poll.body || "")
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
  return contestPanel(
    h,
    t("polls.proposal"),
    poll.summary ? h("p", { class: "contest-summary is-open", text: poll.summary }) : null,
    ...paragraphs.map((block) => h("p", { class: "contest-copy", text: block })),
    h("h3", { text: t("polls.howToVote") }),
    h("p", { text: poll.pollType === "ranked_irv" ? t("polls.howRanked") : t("polls.howSingle") }),
    h("h3", { text: t("polls.countLabel") }),
    h("p", { text: countCopy(poll) }),
    h("h3", { text: t("polls.outcomeHeading") }),
    h("p", { text: poll.pollType === "ranked_irv" ? t("polls.outcomeIrvBody") : t("polls.outcomeBody") }),
    poll.discussionUrl
      ? h("p", {}, h("a", { href: poll.discussionUrl, target: "_blank", rel: "noopener noreferrer", text: t("polls.discussion") }))
      : null,
    h("p", { class: "notice", text: votesMode(poll) ? t("polls.snapshotInactive") : t("polls.hold") }),
    votesMode(poll) ? h("p", { class: "notice", "data-testid": "poll-zk", text: t("polls.zkNote") }) : null,
    h("p", { class: "notice", text: poll.custodyNote || t("polls.custody") }),
    h("p", { class: "notice", "data-testid": "poll-privacy", text: t("polls.privacy") })
  );
}

function stagePanel(h, ctx, poll) {
  const pct = windowPercent(poll.startTime, poll.cutoffTime);
  return contestPanel(
    h,
    t("polls.stage"),
    contestTags(h, pollTags(poll)),
    contestFacts(h, pollFacts(ctx, poll)),
    votesMode(poll) && poll.snapshotBlock != null
      ? h("p", { class: "field-hint", text: t("polls.snapshotLine", { block: String(poll.snapshotBlock) }) })
      : null,
    pct == null ? null : contestMeter(h, { label: t("polls.windowMeter", { pct: String(pct) }), pct })
  );
}

function flagBadges(h, result) {
  const flags = result.flags || [];
  const badges = [];
  if (flags.includes("QUORUM_NOT_MET")) badges.push(t("polls.quorumMiss"));
  if (flags.includes("THRESHOLD_NOT_MET")) badges.push(t("polls.thresholdMiss"));
  if (flags.includes("NO_MAJORITY") || result.outcome === "NO_MAJORITY") badges.push(t("polls.noMajorityLine"));
  if (flags.includes("TIE") || result.outcome === "TIE") badges.push(t("polls.tie"));
  if (result.outcome === "NO_BALLOTS") badges.push(t("polls.noBallots"));
  if (!badges.length && result.outcome) badges.push(result.outcome);
  return h(
    "p",
    { class: "cluster" },
    ...badges.map((text) => h("span", { class: "status-pill", text }))
  );
}

function countBars(h, poll, counts, grossCounts) {
  const entries = Object.entries(counts || {});
  const total = nonAbstainTotal(counts);
  return h(
    "ul",
    { class: "poll-bars", "data-testid": "poll-bars" },
    ...entries.map(([id, weight]) => {
      const pct = id === "abstain" ? sharePercent(weight, total + BigInt(weight || "0")) : sharePercent(weight, total);
      const quadratic = poll?.weighting === "quadratic" || (grossCounts && grossCounts[id] != null);
      const shown = quadratic ? countedLabel(weight, { weighting: "quadratic" }) : weightLabel(weight, poll);
      const gross = grossCounts && grossCounts[id] != null ? ` · ${t("polls.grossSupport")} ${weightLabel(grossCounts[id], poll)}` : "";
      return h(
        "li",
        {},
        h("span", { class: "poll-bar-label", text: `${optionLabel(poll, id)} · ${shown}${gross}` }),
        h("div", { class: "poll-bar contest-meter", role: "presentation" }, h("span", { style: { width: `${pct}%` } }))
      );
    })
  );
}

function resultPanel(h, ctx, poll, result) {
  if (!result || result.official === false) {
    return contestPanel(
      h,
      t("polls.resultsLink"),
      h("p", { class: "notice", "data-testid": "poll-unofficial", text: result?.note || t("polls.unofficial") }),
      h("p", {}, h("a", { href: `/polls/${encodeURIComponent(poll.id)}/results`, "data-nav": "", text: t("polls.resultsLink") }))
    );
  }
  const turnout = result.turnoutBps != null ? `${Number(result.turnoutBps) / 100}%` : "—";
  return contestPanel(
    h,
    t("polls.resultsLink"),
    flagBadges(h, result),
    h("p", { class: "contest-foot", text: resultFoot(poll, result) }),
    contestFacts(h, [
      { label: t("polls.outcome"), value: result.outcome || "—" },
      { label: t("polls.winner"), value: result.winner ? optionLabel(poll, result.winner) : "—" },
      { label: t("polls.participation"), value: weightWithUnits(result.participation, poll) },
      { label: t("polls.turnout"), value: turnout },
      { label: t("polls.countLabel"), value: weightingLabel(result.weighting ? result : poll) },
    ]),
    countBars(h, poll, result.counts, result.grossCounts),
    h(
      "p",
      {},
      h("a", { href: `/api/polls/${encodeURIComponent(poll.id)}/outcome.pdf`, text: "PDF" }),
      " · ",
      h("a", { href: `/api/polls/${encodeURIComponent(poll.id)}/artifacts`, text: "auditor" })
    )
  );
}

function votePanel(h, ctx, poll) {
  const order = (poll.options || []).map((o) => o.id);
  let selected = poll.pollType === "plurality" ? order.find((id) => id !== "abstain") || order[0] : null;
  let address = "";
  const status = h("div", { "data-testid": "poll-vote-status" });
  const ballotMount = h("div", { id: "poll-ballot" });
  const weightLine = h("p", { "data-testid": "poll-provisional", text: "" });

  function paintBallot() {
    if (poll.state !== "OPEN") {
      ballotMount.replaceChildren();
      return;
    }
    if (poll.pollType === "ranked_irv") {
      ballotMount.replaceChildren(h("p", { text: t("polls.rankHint") }), rankList(h, poll, order, paintBallot));
      return;
    }
    ballotMount.replaceChildren(
      h(
        "fieldset",
        { class: "poll-options" },
        h("legend", { class: "sr-only", text: poll.title }),
        ...(poll.options || []).map((opt) =>
          h(
            "label",
            { class: "poll-option" },
            h("input", {
              type: "radio",
              name: "poll-choice",
              value: opt.id,
              checked: selected === opt.id,
              onChange: () => {
                selected = opt.id;
              },
            }),
            h("span", { text: optionLabel(poll, opt.id) })
          )
        )
      )
    );
  }

  async function refreshWeight() {
    if (!address) {
      weightLine.textContent = "";
      return;
    }
    try {
      const data = await ctx.api(
        `/api/polls/${encodeURIComponent(poll.id)}/weight?address=${encodeURIComponent(address)}`
      );
      const gross = votesMode(poll) ? data.votingPower : data.currentBalance;
      const counted = data.countedWeight;
      const parts = [];
      if (gross != null) parts.push(`${t("polls.yourWeight")}: ${weightWithUnits(gross, poll)}`);
      if (counted != null && poll.weighting === "quadratic") {
        parts.push(`${t("polls.countedWeight")}: ${counted}`);
      }
      if (votesMode(poll) && gross === "0") parts.push(t("polls.noPower"));
      weightLine.textContent = parts.join(" · ");
    } catch (err) {
      weightLine.textContent = err.message;
    }
  }

  function choices() {
    if (poll.pollType === "ranked_irv") return [...order];
    return selected ? [selected] : [];
  }

  paintBallot();
  return contestPanel(
    h,
    t("polls.yourVote"),
    poll.state === "OPEN"
      ? h("p", {
          class: "notice",
          "data-testid": "poll-hold",
          text: votesMode(poll) ? t("polls.snapshotLine", { block: String(poll.snapshotBlock ?? "—") }) : t("polls.hold"),
        })
      : h("p", {
          class: "notice",
          "data-testid": "poll-hold",
          text: poll.state === "TALLIED" ? t("polls.closedVote") : t("polls.unofficial"),
        }),
    poll.state === "OPEN"
      ? h("p", { class: "notice", "data-testid": "poll-custody", text: poll.custodyNote || t("polls.custody") })
      : null,
    poll.state === "OPEN"
      ? h(
      "p",
      {},
      h("button", {
        type: "button",
        class: "btn",
        "data-testid": "poll-connect",
        text: t("polls.connect"),
        onClick: async () => {
          try {
            address = await connectWallet();
            status.replaceChildren(h("p", { text: t("polls.connected", { address }) }));
            await refreshWeight();
          } catch (err) {
            status.replaceChildren(h("p", { class: "notice notice-error", role: "alert", text: err.message }));
          }
        },
      })
    )
      : null,
    votesMode(poll) && Number(poll.tokenChainId) === 1
      ? h(
          "p",
          {},
          h("button", {
            type: "button",
            class: "btn btn-secondary",
            "data-testid": "poll-delegate",
            text: t("polls.delegateSelf"),
            onClick: async () => {
              try {
                if (!address) address = await connectWallet();
                const data = `0x5c19a95c${address.slice(2).toLowerCase().padStart(64, "0")}`;
                const hash = await globalThis.ethereum.request({
                  method: "eth_sendTransaction",
                  params: [{ from: address, to: poll.token, data }],
                });
                status.replaceChildren(h("p", { text: `${t("polls.delegateNote")} ${hash}` }));
              } catch (err) {
                status.replaceChildren(h("p", { class: "notice notice-error", role: "alert", text: err.message }));
              }
            },
          })
        )
      : null,
    status,
    poll.state === "OPEN" ? weightLine : null,
    ballotMount,
    poll.state === "OPEN"
      ? h("button", {
      type: "button",
      class: "btn",
      "data-testid": "poll-sign",
      text: t("polls.sign"),
      disabled: poll.state !== "OPEN",
      onClick: async () => {
        status.replaceChildren(h("p", { text: t("common.loading") }));
        try {
          if (!address) address = await connectWallet();
          const picked = choices();
          if (!picked.length) throw new Error(t("polls.sign"));
          const typed = await ctx.api(
            `/api/polls/${encodeURIComponent(poll.id)}/typed-data?address=${encodeURIComponent(address)}&choices=${encodeURIComponent(picked.join(","))}`
          );
          const eth = globalThis.ethereum;
          if (!eth) throw new Error(t("polls.noWallet"));
          const sig = await eth.request({
            method: "eth_signTypedData_v4",
            params: [address, JSON.stringify(typed.typedData)],
          });
          const cast = await ctx.api(`/api/polls/${encodeURIComponent(poll.id)}/ballots`, {
            method: "POST",
            body: { voter: address, choices: picked, sig, issuedAt: typed.issuedAt },
          });
          status.replaceChildren(receiptView(h, cast.receipt || {}));
        } catch (err) {
          status.replaceChildren(h("p", { class: "notice notice-error", role: "alert", text: err.message }));
        }
      },
    })
      : null
  );
}

function detailShell(h, ctx, poll, extra) {
  return hPage(h, [
    banner(h),
    h(
      "nav",
      { class: "crumbs", "aria-label": "Breadcrumb" },
      h("a", { href: "/polls", "data-nav": "", text: t("polls.back") }),
      h("span", { "aria-hidden": "true", text: " / " }),
      h("span", { text: poll.title })
    ),
    h(
      "header",
      { class: "page-head" },
      h("p", { class: "kicker", text: t("polls.posted", { when: ctx.formatTime(poll.createdAt || poll.startTime) }) }),
      h("h1", { text: poll.title }),
      h("p", { class: "contest-id", text: t("polls.pollId", { id: shortContestId(poll.id) }) }),
      contestTags(h, pollTags(poll)),
      poll.summary ? h("p", { class: "lede", text: poll.summary }) : h("p", { class: "lede", text: t("polls.listLede") })
    ),
    ...extra,
  ]);
}

export async function renderPollDetail(main, ctx) {
  const { h } = ctx;
  const poll = await ctx.api(`/api/polls/${encodeURIComponent(ctx.route.params.id)}`);
  ctx.setTitle(poll.title || t("polls.listTitle"));
  let result = poll.result || null;
  if (!result) {
    try {
      result = await ctx.api(`/api/polls/${encodeURIComponent(poll.id)}/results`);
    } catch {
      result = null;
    }
  }
  main.replaceChildren(
    detailShell(h, ctx, poll, [
      contestSplit(h, storyPanel(h, ctx, poll), stagePanel(h, ctx, poll)),
      contestSplit(h, votePanel(h, ctx, poll), resultPanel(h, ctx, poll, result)),
      lookupPanel(h, ctx, poll),
    ])
  );
}

export async function renderPollVote(main, ctx) {
  const { h } = ctx;
  const poll = await ctx.api(`/api/polls/${encodeURIComponent(ctx.route.params.id)}`);
  ctx.setTitle(poll.title || t("polls.voteLink"));
  main.replaceChildren(
    detailShell(h, ctx, poll, [
      contestSplit(h, votePanel(h, ctx, poll), stagePanel(h, ctx, poll)),
      lookupPanel(h, ctx, poll),
    ])
  );
}

export async function renderPollResults(main, ctx) {
  const { h } = ctx;
  const id = ctx.route.params.id;
  const [poll, result] = await Promise.all([
    ctx.api(`/api/polls/${encodeURIComponent(id)}`),
    ctx.api(`/api/polls/${encodeURIComponent(id)}/results`),
  ]);
  ctx.setTitle(poll.title || t("polls.resultsLink"));
  const rounds =
    result.official && result.irvRounds
      ? h(
          "section",
          { class: "contest-panel" },
          h("h2", { text: t("polls.rounds") }),
          ...result.irvRounds.map((round) =>
            h(
              "article",
              { class: "contest-round" },
              h("h3", { text: t("polls.round", { n: round.round }) }),
              round.eliminated ? h("p", { text: `${t("polls.eliminated")}: ${optionLabel(poll, round.eliminated)}` }) : null,
              countBars(h, poll, round.counts)
            )
          )
        )
      : null;
  main.replaceChildren(
    detailShell(h, ctx, poll, [contestSplit(h, resultPanel(h, ctx, poll, result), stagePanel(h, ctx, poll)), rounds])
  );
}

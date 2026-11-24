/**
 * NOT FOR PROFIT — civic public good, not a commercial product.
 * Shared contest chrome for civic elections and token polls.
 * The layout does not assume a token, a roll, or a wallet.
 */

import { electionTypeNameOf } from "./election-type-ui.js";

const POLL_PHASES = ["Registration", "Voting", "Counting", "Results"];

/**
 * Phase index (0 Registration … 3 Results) from a civic vote's L1 status, which is the record
 * once the vote is on the rollup: the node itself never tallies it. Null for a draft.
 */
export function l1PhaseIndex(l1, now = Math.floor(Date.now() / 1000)) {
  const status = l1?.status;
  if (!status || status === "draft") return null;
  if (status === "finalized" || status === "withheld") return 3;
  if (status === "closing" || status === "closed" || status === "halted") return 2;
  if (status === "scheduled") {
    if (now >= Number(l1.cutoffTime)) return 2;
    return now >= Number(l1.startTime) ? 1 : 0;
  }
  return 0; // keygen: the roll is still open
}

/**
 * The lifecycle as a phase strip: Draft (a civic vote not yet on L1), Registration, Voting,
 * Counting, Results. Node states: 0 created, 1 roll frozen, 2 open, 3 closed, 4 tallied.
 * Pass `l1` (the /rollup view's `l1`) to follow L1 instead of the node state.
 */
export function contestPhases(election, { l1 = null, now } = {}) {
  const civic = electionTypeNameOf(election) === "vote";
  const fromL1 = civic && l1 ? l1PhaseIndex(l1, now) : null;
  const onL1 = fromL1 != null || (election?.chainMode === "rollup" && election?.rollupElectionId != null);
  const state = Number(election?.state);
  const idx = fromL1 ?? (state >= 4 ? 3 : state === 3 ? 2 : state === 2 ? 1 : 0);
  if (civic && !onL1) {
    return [{ label: "Draft", state: "current" }, ...POLL_PHASES.map((label) => ({ label, state: "todo" }))];
  }
  const phases = POLL_PHASES.map((label, i) => ({ label, state: i < idx ? "done" : i === idx ? "current" : "todo" }));
  return civic ? [{ label: "Draft", state: "done" }, ...phases] : phases;
}

/** `tabs: true` draws the strip as a page-level tab row (ballot, results) instead of pills. */
export function contestPhaseStrip(h, election, { tabs = false, l1 = null } = {}) {
  return h(
    "ol",
    { class: tabs ? "phase-steps phase-tabs" : "phase-steps", "aria-label": "Stage" },
    ...contestPhases(election, { l1 }).map((p) =>
      h("li", { class: `phase-step is-${p.state}`, ...(p.state === "current" ? { "aria-current": "step" } : {}), text: p.label })
    )
  );
}

export function contestStats(h, stats) {
  return h(
    "div",
    { class: "contest-stats" },
    ...stats.map((stat) =>
      h(
        "article",
        { class: "contest-stat" },
        h("span", { class: "lbl", text: stat.label }),
        h("span", { class: "val", text: stat.value }),
        stat.hint ? h("span", { class: "hint", text: stat.hint }) : null
      )
    )
  );
}

export function contestTabs(h, { label, tabs, current, onChange }) {
  return h(
    "div",
    { class: "contest-tabs", role: "tablist", "aria-label": label },
    ...tabs.map((tab) =>
      h("button", {
        type: "button",
        role: "tab",
        id: `contest-tab-${tab.id}`,
        "aria-selected": current === tab.id ? "true" : "false",
        text: tab.label,
        onClick: () => onChange(tab.id),
      })
    )
  );
}

export function contestGrid(h, cards, attrs = {}) {
  const items = (cards || []).filter((card) => card != null && card !== false);
  const rest = { ...(attrs || {}) };
  delete rest.role;
  if (!items.length) return h("div", { class: "contest-grid", ...rest });
  for (const card of items) {
    if (card.nodeType === 1 && !card.getAttribute("role")) card.setAttribute("role", "listitem");
  }
  return h("div", { class: "contest-grid", role: "list", ...rest }, ...items);
}

export function contestFacts(h, rows) {
  const items = (rows || []).filter(Boolean);
  if (!items.length) return null;
  return h(
    "dl",
    { class: "contest-facts" },
    ...items.map((row) => h("div", {}, h("dt", { text: row.label }), h("dd", { text: row.value })))
  );
}

export function contestTags(h, tags) {
  const items = (tags || []).filter((tag) => tag && tag.text);
  if (!items.length) return null;
  return h(
    "ul",
    { class: "contest-tags" },
    ...items.map((tag) => h("li", { class: tag.accent ? "contest-tag is-accent" : "contest-tag", text: tag.text }))
  );
}

export function contestMeter(h, { label, pct }) {
  const width = Math.max(0, Math.min(100, Number(pct) || 0));
  return h(
    "div",
    { class: "contest-meter-block" },
    h("div", { class: "contest-meter", role: "meter", "aria-label": label, "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(width) }, h("span", { style: { width: `${width}%` } })),
    h("p", { class: "contest-meter-label", text: label })
  );
}

/**
 * @param {object} spec
 * @param {string} spec.href
 * @param {string} spec.title
 * @param {string} [spec.kicker]
 * @param {string} [spec.idLabel]
 * @param {string} [spec.summary]
 * @param {Array} [spec.tags]
 * @param {Array} [spec.facts]
 * @param {{label: string, pct: number}|null} [spec.meter]
 * @param {string} [spec.foot]
 * @param {Node[]} [spec.actions]
 */
export function contestCard(h, spec) {
  return h(
    "article",
    { class: "contest-card election-card", role: "listitem" },
    h(
      "p",
      { class: "contest-kicker" },
      h("span", { text: spec.kicker || "" }),
      spec.idLabel ? h("span", { text: spec.idLabel }) : null
    ),
    h("h2", {}, h("a", { href: spec.href, "data-nav": "", text: spec.title })),
    spec.phases || null,
    spec.summary ? h("p", { class: "contest-summary", text: spec.summary }) : null,
    contestTags(h, spec.tags),
    contestFacts(h, spec.facts),
    spec.meter ? contestMeter(h, spec.meter) : null,
    spec.foot ? h("p", { class: "contest-foot", text: spec.foot }) : null,
    spec.actions?.length ? h("div", { class: "cluster contest-actions" }, ...spec.actions) : null
  );
}

export function contestPanel(h, title, ...children) {
  return h("section", { class: "contest-panel" }, title ? h("h2", { text: title }) : null, ...children);
}

export function contestSplit(h, main, side) {
  return h(
    "div",
    { class: "contest-split" },
    h("div", { class: "contest-main" }, main),
    h("aside", { class: "contest-side" }, side)
  );
}

export function windowPercent(start, end, nowSeconds = Date.now() / 1000) {
  const open = Number(start);
  const close = Number(end);
  if (!Number.isFinite(open) || !Number.isFinite(close) || close <= open) return null;
  if (nowSeconds <= open) return 0;
  if (nowSeconds >= close) return 100;
  return Math.round(((nowSeconds - open) / (close - open)) * 100);
}

export function shortContestId(id) {
  const compact = String(id || "").replace(/-/g, "");
  return compact.slice(0, 8) || "—";
}

/** Civic elections and token polls share this card. Count copy stays with the caller. */
export function contestPlace(election) {
  const raw = String(election?.jurisdiction || "").trim();
  const id = String(election?.jurisdictionId || "").trim();
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;
  if (raw && !uuid.test(raw)) return raw;
  if (id && !uuid.test(id)) return id;
  return electionTypeNameOf(election) === "vote" ? "Civic vote" : "Poll";
}

export function civicContestCard(h, election, { formatTime, state, typeLabel, href, actions, foot, sealedText, roll }) {
  const pct = windowPercent(election.startTime, election.cutoffTime);
  return contestCard(h, {
    href,
    kicker: contestPlace(election),
    phases: contestPhaseStrip(h, election),
    idLabel: election.shortCode ? `/v/${election.shortCode}` : shortContestId(election.id),
    title: election.title,
    summary: election.description || "",
    tags: [
      state ? { text: state.label, accent: Number(election.state) === 2 } : null,
      typeLabel ? { text: typeLabel } : null,
      { text: "One person, one vote" },
    ].filter(Boolean),
    facts: [
      { label: "Opens", value: formatTime(election.startTime) },
      { label: "Closes", value: formatTime(election.cutoffTime) },
      sealedText ? { label: "Results", value: sealedText } : null,
      roll ? { label: "Roll", value: roll } : null,
      election.questionCount || election.questions?.length
        ? { label: "Questions", value: String(election.questionCount || election.questions.length) }
        : null,
    ],
    meter: pct == null ? null : { label: `${pct}% of the voting window`, pct },
    foot,
    actions,
  });
}

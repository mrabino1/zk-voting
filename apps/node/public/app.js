/**
 * NOT FOR PROFIT — Republic is a civic public good. Not a commercial product.
 * Voter home and application shell for the Republic Node SPA.
 */

import { startRouter, navigate, currentRoute } from "./router.js";
import * as wallet from "./passkey-wallet.js";
import { renderRegister } from "./register.js";
import { renderVote, sampleQuestions } from "./vote.js";
import { questionsOf, typeLabel } from "./ballot.js";
import { renderElectionInfo, renderOptionInfo } from "./info.js";
import { renderResults, renderResultsIndex } from "./results.js";
import { SESSION_EVENT, mountSignInPanel } from "./signin.js";
import { t, localeTag, LOCALE_EVENT } from "./i18n.js";

const VOTER_STORE_KEY = "republic.voter.v1";

const STATE_KEYS = {
  0: "created",
  1: "rollFrozen",
  2: "open",
  3: "closed",
  4: "tallied",
};

const STATE_CLASS = {
  0: "status-created",
  1: "status-rollfrozen",
  2: "status-open",
  3: "status-closed",
  4: "status-tallied",
};

const REASON_CODES = {
  1: "NOT_OF_AGE",
  2: "NOT_RESIDENT",
  3: "NOT_CITIZEN_OR_MEMBER",
  4: "DUPLICATE_IDENTITY",
  5: "DECEASED",
  6: "MOVED_OUT",
  7: "DISTRICT_MISMATCH",
  8: "ALREADY_VOTED",
  9: "COURT_ORDER",
  10: "INELIGIBLE_STATUS",
  11: "FRAUD_HOLD",
  12: "EXPIRED_OR_SUSPENDED",
  13: "SANCTION_OR_PROHIBITION",
  14: "OTHER",
};

export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === "class" || key === "className") node.className = value;
    else if (key === "for" || key === "htmlFor") node.htmlFor = value;
    else if (key === "text") node.textContent = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key === "style" && typeof value === "object") Object.assign(node.style, value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "aria" && typeof value === "object") {
      for (const [a, av] of Object.entries(value)) node.setAttribute(`aria-${a}`, String(av));
    } else if (key === "value" && "value" in node) node.value = value;
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function fill(node, ...children) {
  node.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false));
}

export async function api(path, options = {}) {
  const headers = {
    Accept: "application/json",
    ...(options.body != null ? { "Content-Type": "application/json" } : {}),
    ...(options.headers || {}),
  };
  const res = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers,
    body:
      options.body == null || typeof options.body === "string"
        ? options.body
        : JSON.stringify(options.body),
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!res.ok) {
    const err = new Error(
      data?.error || data?.message || data?.detail || res.statusText || t("common.requestFailed")
    );
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function asList(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.elections)) return data.elections;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

export function electionStateInfo(state) {
  const n = Number(state);
  const key = STATE_KEYS[n];
  return {
    code: Number.isFinite(n) ? n : 0,
    label: key ? t(`status.election.${key}`) : t("status.election.state", { state }),
    className: STATE_CLASS[n] || "status-created",
  };
}

export function formatTime(value) {
  if (value == null || value === "") return t("common.dash");
  let ms = Number(value);
  if (!Number.isFinite(ms)) {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) return String(value);
    ms = parsed;
  } else if (ms < 1e12) {
    ms *= 1000;
  }
  try {
    return new Intl.DateTimeFormat(localeTag(), {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

export function electionRefEquals(election, ref) {
  if (!election || ref == null || ref === "") return false;
  const r = String(ref);
  if (String(election.id) === r) return true;
  if (election.shortCode && String(election.shortCode) === r) return true;
  if (election.onChainElectionId != null && String(election.onChainElectionId) === r) return true;
  if (Array.isArray(election.aliases) && election.aliases.some((a) => String(a) === r)) return true;
  return false;
}

export function chainElectionId(election) {
  if (election?.onChainElectionId != null && String(election.onChainElectionId) !== "") {
    return String(election.onChainElectionId);
  }
  return String(election?.id ?? "");
}

export function unixSeconds(value) {
  if (value == null || value === "") return null;
  let n = Number(value);
  if (!Number.isFinite(n)) {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) return null;
    return Math.floor(parsed / 1000);
  }
  if (n > 1e12) n = Math.floor(n / 1000);
  return n;
}

export function normalizeElection(raw, now = Math.floor(Date.now() / 1000)) {
  if (!raw || typeof raw !== "object") return null;
  const params = raw.params || {};
  const id = String(raw.id ?? raw.electionId ?? raw.election_id ?? "");
  let state = raw.state ?? raw.statusCode ?? raw.status;
  if (typeof state === "string") {
    const map = {
      created: 0,
      rollfrozen: 1,
      roll_frozen: 1,
      open: 2,
      closed: 3,
      tallied: 4,
    };
    state = map[state.toLowerCase().replace(/\s+/g, "")] ?? state;
  }
  state = Number(state);
  const startTime = unixSeconds(raw.startTime ?? raw.start ?? params.startTime);
  const cutoffTime = unixSeconds(raw.cutoffTime ?? raw.cutoff ?? params.cutoffTime);
  if (!Number.isFinite(state)) {
    if (raw.tallied) state = 4;
    else if (cutoffTime && now >= cutoffTime) state = 3;
    else if (startTime && now >= startTime) state = 2;
    else if (raw.rollFrozen) state = 1;
    else state = 0;
  }
  const questions = raw.questions || raw.ballot?.questions || raw.ballotSpec?.questions || [];
  return {
    ...raw,
    id,
    shortCode: raw.shortCode || raw.short_code || null,
    onChainElectionId:
      raw.onChainElectionId != null
        ? String(raw.onChainElectionId)
        : raw.on_chain_election_id != null
          ? String(raw.on_chain_election_id)
          : null,
    aliases: Array.isArray(raw.aliases) ? raw.aliases.map((a) => String(a)) : [],
    links: raw.links || null,
    title: raw.title || params.title || t("sample.electionFallback", { id }),
    jurisdiction:
      raw.jurisdiction ||
      raw.jurisdictionName ||
      raw.jurisdictionLabel ||
      (raw.jurisdictionId ? String(raw.jurisdictionId) : t("sample.jurisdictionFallback")),
    jurisdictionId: raw.jurisdictionId || params.jurisdictionId || null,
    state,
    startTime,
    cutoffTime,
    participantCount: Number(raw.participantCount ?? raw.participants ?? 0) || 0,
    maxParticipants: Number(raw.maxParticipants ?? params.maxParticipants ?? 0) || 0,
    questionCount: Number(raw.questionCount ?? params.questionCount ?? questions.length) || questions.length,
    rollFrozen: Boolean(raw.rollFrozen) || state >= 1,
    ballotSpecHash: raw.ballotSpecHash || params.ballotSpecHash || null,
    ballotMethod: raw.ballotMethod || params.ballotMethod || "plurality",
    eligibleRoot: raw.eligibleRoot || null,
    disqualificationRoot: raw.disqualificationRoot || null,
    description: raw.description || raw.summary || "",
    questions,
  };
}

export function sampleElections(now = Math.floor(Date.now() / 1000)) {
  return [
    {
      id: "3f1c0a6e-9b2d-4e11-8c7a-1a2b3c4d5e01",
      shortCode: "nbrdge2k3m",
      onChainElectionId: "1",
      aliases: ["1"],
      title: t("sample.cityTitle"),
      jurisdiction: t("sample.cityJurisdiction"),
      jurisdictionId: "northbridge",
      state: 2,
      startTime: now - 86400,
      cutoffTime: now + 86400 * 12,
      participantCount: 1840,
      maxParticipants: 0,
      questionCount: 2,
      rollFrozen: true,
      ballotSpecHash: "0x" + "ab".repeat(32),
      description: t("sample.cityDesc"),
      questions: sampleQuestions(),
    },
    {
      id: "7a8b9c0d-1e2f-4a3b-9c4d-5e6f70819202",
      shortCode: "ctymeas4n8",
      onChainElectionId: "2",
      aliases: ["2"],
      title: t("sample.measureTitle"),
      jurisdiction: t("sample.measureJurisdiction"),
      jurisdictionId: "northbridge-county",
      state: 1,
      startTime: now + 86400 * 3,
      cutoffTime: now + 86400 * 20,
      participantCount: 22011,
      maxParticipants: 0,
      questionCount: 1,
      rollFrozen: true,
      description: t("sample.measureDesc"),
      questions: [sampleQuestions()[0]],
    },
    {
      id: "4b5c6d7e-8f90-41a2-a3b4-c5d6e7f80903",
      shortCode: "schbrd5p2q",
      onChainElectionId: "3",
      aliases: ["3"],
      title: t("sample.schoolTitle"),
      jurisdiction: t("sample.schoolJurisdiction"),
      jurisdictionId: "nusd",
      state: 3,
      startTime: now - 86400 * 20,
      cutoffTime: now - 3600,
      participantCount: 903,
      maxParticipants: 0,
      questionCount: 1,
      rollFrozen: true,
      description: t("sample.schoolDesc"),
      questions: [sampleQuestions()[1]],
    },
    {
      id: "90ab12cd-34ef-4a56-8b78-90abcdef0404",
      shortCode: "stref6q3r4",
      onChainElectionId: "4",
      aliases: ["4"],
      title: t("sample.stateTitle"),
      jurisdiction: t("sample.stateJurisdiction"),
      jurisdictionId: "state-ex",
      state: 4,
      startTime: now - 86400 * 40,
      cutoffTime: now - 86400 * 10,
      participantCount: 501204,
      maxParticipants: 0,
      questionCount: 1,
      rollFrozen: true,
              description: t("sample.stateDesc"),
      questions: [sampleQuestions()[0]],
    },
    {
      id: "11223344-5566-4777-8899-aabbccdde505",
      shortCode: "wrkcbd7s4t",
      onChainElectionId: "5",
      aliases: ["5"],
      title: t("sample.coopTitle"),
      jurisdiction: t("sample.coopJurisdiction"),
      jurisdictionId: "nfc",
      state: 0,
      startTime: now + 86400 * 14,
      cutoffTime: now + 86400 * 21,
      participantCount: 40,
      maxParticipants: 0,
      questionCount: 2,
      rollFrozen: false,
      description: t("sample.coopDesc"),
      questions: sampleQuestions(),
    },
  ].map((e) => normalizeElection(e, now));
}

export function readVoterStore() {
  try {
    const raw = localStorage.getItem(VOTER_STORE_KEY);
    if (!raw) return { registrations: {}, votes: {} };
    const parsed = JSON.parse(raw);
    return {
      registrations: parsed.registrations || {},
      votes: parsed.votes || {},
    };
  } catch {
    return { registrations: {}, votes: {} };
  }
}

export function writeVoterStore(next) {
  localStorage.setItem(VOTER_STORE_KEY, JSON.stringify(next));
}

export function recordRegistration(electionId, payload) {
  const store = readVoterStore();
  store.registrations[String(electionId)] = {
    at: new Date().toISOString(),
    identityCommitment: payload.identityCommitment,
    status: payload.status || "registered",
  };
  writeVoterStore(store);
}

export function recordVoteReceipt(electionId, payload) {
  const store = readVoterStore();
  store.votes[String(electionId)] = {
    at: payload.at || new Date().toISOString(),
    ballotHash: payload.ballotHash,
    nullifier: payload.nullifier,
    userOpHash: payload.userOpHash,
    choiceOmitted: true,
  };
  writeVoterStore(store);
}

export function announce(message) {
  const live = document.getElementById("live");
  if (live) live.textContent = message;
}

export function setTitle(page) {
  document.title = page ? `${page} — Republic` : t("chrome.titleHome");
}

export function reasonLabel(code) {
  if (code == null || code === "") return null;
  const n = Number(code);
  return REASON_CODES[n] || String(code);
}

function voterKeys(election) {
  const keys = [String(election.id)];
  if (election.shortCode) keys.push(String(election.shortCode));
  if (election.onChainElectionId != null) keys.push(String(election.onChainElectionId));
  for (const a of election.aliases || []) keys.push(String(a));
  return keys;
}

function voterStatusForElection(election, me, store) {
  const keys = voterKeys(election);
  if (keys.some((k) => store.votes[k])) return { key: "recorded", label: t("status.voter.recorded"), className: "status-recorded" };
  const remote = keys.map((k) => me?.elections?.[k] || me?.statuses?.[k]).find(Boolean);
  if (remote) {
    const status = String(remote.status || remote).toLowerCase();
    if (status.includes("disqual")) {
      return {
        key: "disqualified",
        label: remote.reasonCode
          ? t("status.voter.disqualifiedReason", { reason: reasonLabel(remote.reasonCode) })
          : t("status.voter.disqualified"),
        className: "status-disqualified",
      };
    }
    if (status.includes("pending")) return { key: "pending", label: t("status.voter.pending"), className: "status-pending" };
    if (status.includes("eligible")) return { key: "eligible", label: t("status.voter.eligible"), className: "status-eligible" };
    if (status.includes("register")) return { key: "registered", label: t("status.voter.registered"), className: "status-eligible" };
  }
  if (me?.disqualified || me?.isDisqualified) {
    return { key: "disqualified", label: t("status.voter.disqualified"), className: "status-disqualified" };
  }
  if (keys.some((k) => store.registrations[k])) {
    if (election.state === 2) return { key: "eligible", label: t("status.voter.eligibleDevice"), className: "status-eligible" };
    return { key: "registered", label: t("status.voter.registeredDevice"), className: "status-eligible" };
  }
  return { key: "not_registered", label: t("status.voter.notRegistered"), className: "status-created" };
}

export async function loadElections() {
  try {
    const data = await api("/api/elections");
    const list = asList(data).map((row) => normalizeElection(row)).filter(Boolean);
    if (list.length) return { elections: list, source: "api" };
  } catch {
    /* Node API may not be serving yet; show the working sample roll. */
  }
  return { elections: sampleElections(), source: "sample" };
}

export async function loadElection(id) {
  try {
    const data = await api(`/api/elections/${encodeURIComponent(id)}`);
    const raw = data?.election || data;
    const normalized = normalizeElection(raw);
    if (normalized?.id) {
      return { election: normalized, source: "api" };
    }
  } catch {
    /* fall through */
  }
  const sample = sampleElections().find((e) => electionRefEquals(e, id));
  if (sample) return { election: sample, source: "sample" };
  return { election: null, source: "missing" };
}

export async function loadMe() {
  try {
    const data = await api("/api/me");
    const user = data?.me || data?.user || (data?.id ? data : null);
    if (!data && !user) return null;
    return {
      ...data,
      user,
      status:
        data?.status ||
        (user ? `${user.role || "voter"}${user.handle ? ` · ${user.handle}` : ""}` : null),
      elections: data?.elections || user?.elections || {},
    };
  } catch {
    return null;
  }
}

function updateNav(routeName) {
  document.querySelectorAll(".nav-main a[data-nav]").forEach((a) => {
    const href = a.getAttribute("href");
    const current =
      (routeName === "home" && href === "/") ||
      (routeName === "register" && href === "/register") ||
      (routeName === "vote" && href === "/") ||
      ((routeName === "results" || routeName === "resultsIndex") && href === "/elections") ||
      ((routeName === "election-info" || routeName === "option-info") && href === "/");
    if (current) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
}

function ctx() {
  return {
    h,
    api,
    fill,
    navigate,
    announce,
    wallet,
    formatTime,
    electionStateInfo,
    electionRefEquals,
    chainElectionId,
    normalizeElection,
    loadElections,
    loadElection,
    loadMe,
    sampleElections,
    readVoterStore,
    recordRegistration,
    recordVoteReceipt,
    reasonLabel,
    setTitle,
    sampleQuestions,
    mountSignInPanel,
  };
}

function renderHome(main, route, bundle) {
  const { elections, source, me, walletRecord, store } = bundle;
  const openCount = elections.filter((e) => e.state === 2).length;
  const walletLine = walletRecord?.staleWrap
    ? t("home.walletStale")
    : walletRecord
      ? t("home.walletPresent", { commitment: walletRecord.identityCommitment.slice(0, 18) })
      : t("home.walletNone");

  const list =
    elections.length === 0
      ? h("div", { class: "notice notice-warn" }, h("p", { text: t("home.noElections") }))
      : h(
          "div",
          { class: "grid-cards", role: "list" },
          ...elections.map((election) => {
            const st = electionStateInfo(election.state);
            const vs = voterStatusForElection(election, me, store);
            const canVote = election.state === 2 && vs.key !== "disqualified" && vs.key !== "recorded";
            const canRegister = election.state <= 2 && vs.key === "not_registered";
            return h(
              "article",
              { class: "election-card", role: "listitem" },
              h("p", { class: "kicker", text: election.jurisdiction }),
              h("h2", { text: election.title }),
              h(
                "p",
                { class: "cluster" },
                h("span", { class: `status-pill ${st.className}`, text: st.label }),
                h("span", { class: `status-pill ${vs.className}`, text: vs.label })
              ),
              h(
                "ul",
                { class: "meta-list" },
                h("li", {}, h("span", { class: "lbl", text: t("home.opens") }), h("span", { text: formatTime(election.startTime) })),
                h("li", {}, h("span", { class: "lbl", text: t("home.cutoff") }), h("span", { text: formatTime(election.cutoffTime) })),
                election.shortCode
                  ? h(
                      "li",
                      {},
                      h("span", { class: "lbl", text: t("home.shortLink") }),
                      h("a", { href: `/v/${encodeURIComponent(election.shortCode)}`, "data-nav": "", text: `/v/${election.shortCode}` })
                    )
                  : null,
                h(
                  "li",
                  {},
                  h("span", { class: "lbl", text: t("home.roll") }),
                  h(
                    "span",
                    {
                      text: election.maxParticipants
                        ? t("home.rollCapped", { count: election.participantCount, cap: election.maxParticipants })
                        : t("home.rollUnlimited", { count: election.participantCount }),
                    }
                  )
                ),
                h(
                  "li",
                  {},
                  h("span", { class: "lbl", text: t("home.questions") }),
                  h("span", { text: String(election.questionCount || election.questions?.length || t("common.dash")) })
                )
              ),
              election.description ? h("p", { text: election.description }) : null,
              aspectPreview(election, h),
              h(
                "div",
                { class: "cluster" },
                canVote
                  ? h("a", { class: "btn", href: `/vote/${encodeURIComponent(election.id)}`, "data-nav": "", text: t("home.markBallot") })
                  : vs.key === "recorded"
                    ? h("a", { class: "btn btn-secondary", href: `/vote/${encodeURIComponent(election.id)}`, "data-nav": "", text: t("home.viewReceipt") })
                    : election.state === 2
                      ? h("a", { class: "btn btn-secondary", href: `/vote/${encodeURIComponent(election.id)}`, "data-nav": "", text: t("home.openBallot") })
                      : h("a", { class: "btn btn-secondary", href: `/vote/${encodeURIComponent(election.id)}`, "data-nav": "", text: t("home.electionDetail") }),
                canRegister
                  ? h("a", { class: "btn btn-secondary", href: `/register?election=${encodeURIComponent(election.id)}`, "data-nav": "", text: t("home.register") })
                  : null,
                h(
                  "a",
                  {
                    class: election.state >= 4 ? "btn" : "btn btn-secondary",
                    href: `/elections/${encodeURIComponent(election.id)}/results`,
                    "data-nav": "",
                    text: election.state >= 4 ? t("home.results") : t("home.resultsStatus"),
                  }
                ),
                h("a", {
                  class: "btn btn-secondary",
                  href: `/elections/${encodeURIComponent(election.id)}/info`,
                  "data-nav": "",
                  text: t("home.candidateInfo"),
                })
              )
            );
          })
        );

  main.replaceChildren(
    h(
      "div",
      { class: "page-head" },
      h("p", { class: "kicker", text: t("home.kicker") }),
      h("h1", { text: t("home.title") }),
      h(
        "p",
        { class: "lede" },
        t("home.lede")
      ),
        h(
          "div",
          { class: "notice", role: "status" },
          h("p", { text: t("home.openCount", { count: openCount }) }),
          h("p", { text: walletLine }),
          me?.user
            ? h("p", { text: t("home.signedInAs", { handle: me.user.handle, role: me.user.role }) })
            : h("p", { text: t("home.signInHint") }),
          h(
            "p",
            {
              text: t("home.hourlyNote"),
            }
          ),
        source === "sample"
          ? h(
              "p",
              {
                text: t("home.sampleNote"),
              }
            )
          : null
      )
    ),
    h("div", { id: "sign-in-root" }),
    list,
    h("hr", { class: "hr" }),
    h(
      "section",
      { id: "how-it-works", tabindex: "-1" },
      h("h2", { text: t("home.howTitle") }),
      h(
        "div",
        { class: "how-grid" },
        h(
          "article",
          {},
          h("h3", { text: t("home.how1Title") }),
          h(
            "p",
            {
              text: t("home.how1Body"),
            }
          )
        ),
        h(
          "article",
          {},
          h("h3", { text: t("home.how2Title") }),
          h(
            "p",
            {
              text: t("home.how2Body"),
            }
          )
        ),
        h(
          "article",
          {},
          h("h3", { text: t("home.how3Title") }),
          h(
            "p",
            {
              text: t("home.how3Body"),
            }
          )
        ),
        h(
          "article",
          {},
          h("h3", { text: t("home.how4Title") }),
          h(
            "p",
            {
              text: t("home.how4Body"),
            }
          )
        ),
        h(
          "article",
          {},
          h("h3", { text: t("home.how5Title") }),
          h(
            "p",
            {
              text: t("home.how5Body"),
            }
          )
        )
      )
    ),
    h(
      "section",
      {},
      h("h2", { text: t("home.deviceTitle") }),
      renderDeviceStatus(walletRecord, me, store)
    )
  );
  const signInRoot = main.querySelector("#sign-in-root");
  if (signInRoot) {
    signInRoot.setAttribute("data-lede-key", "home.signInLede");
    signInRoot.setAttribute("data-lede", t("home.signInLede"));
    mountSignInPanel(signInRoot);
  }
}

function aspectPreview(election, h) {
  const questions = questionsOf(election);
  if (!questions.length) return null;
  return h(
    "ol",
    { class: "aspect-preview" },
    ...questions.slice(0, 4).map((q) =>
      h("li", {}, h("span", { class: "aspect-type", text: typeLabel(q.type) }), " ", h("span", { text: q.prompt }))
    )
  );
}

function renderDeviceStatus(walletRecord, me, store) {
  const nReg = Object.keys(store.registrations).length;
  const nVote = Object.keys(store.votes).length;
  const rows = [
    h("dt", { text: t("home.passkey") }),
    h("dd", { text: walletRecord?.staleWrap ? t("home.passkeyStale") : walletRecord ? t("home.passkeyPresent") : t("home.passkeyMissing") }),
    h("dt", { text: t("home.identityCommitment") }),
    h("dd", { class: walletRecord ? "hex" : "", text: walletRecord?.identityCommitment || t("common.dash") }),
    h("dt", { text: t("home.localAddress") }),
    h(
      "dd",
      {},
      walletRecord
        ? [h("code", { text: walletRecord.address }), " ", h("span", { class: "field-hint", text: `(${walletRecord.addressScheme})` })]
        : t("common.dash")
    ),
    h("dt", { text: t("home.activeEth") }),
    h("dd", { class: me?.identity?.activeEthAddress ? "hex" : "", text: me?.identity?.activeEthAddress || t("common.dash") }),
    h("dt", { text: t("home.verifiedMethods") }),
    h(
      "dd",
      {
        text: me?.identity?.authMethods?.length
          ? me.identity.authMethods.map((m) => m.type).join(", ")
          : t("common.dash"),
      }
    ),
    h("dt", { text: t("home.localRoll") }),
    h("dd", { text: String(nReg) }),
    h("dt", { text: t("home.localBallots") }),
    h("dd", { text: String(nVote) }),
  ];
  if (me?.status) {
    rows.push(h("dt", { text: t("home.nodeMe") }), h("dd", { text: String(me.status) }));
  }
  return h(
    "div",
    { class: "panel" },
    h("dl", { class: "status-dl" }, ...rows),
    h("p", { class: "field-hint", text: t("wallet.productionNote") }),
    h(
      "div",
      { class: "toolbar" },
      h("a", { class: "btn", href: "/register", "data-nav": "", text: walletRecord ? t("home.reviewIdentity") : t("home.identifyYourself") })
    )
  );
}

function renderNotFound(main, route) {
  main.replaceChildren(
    h("div", { class: "page-head" }, h("h1", { text: t("common.pageNotFound") }), h("p", { text: t("common.noPageAt", { path: route.path }) })),
    h("p", {}, h("a", { class: "btn", href: "/", "data-nav": "", text: t("common.returnElections") }))
  );
}

async function renderRoute(route) {
  const main = document.getElementById("main");
  if (!main) return;
  updateNav(route.name);
  main.replaceChildren(h("p", { class: "loading-msg", text: t("common.loading") }));
  try {
    if (route.name === "home") {
      setTitle(t("chrome.navElections"));
      const [{ elections, source }, me, walletRecord] = await Promise.all([
        loadElections(),
        loadMe(),
        wallet.getPublicRecord().catch(() => null),
      ]);
      renderHome(main, route, {
        elections,
        source,
        me,
        walletRecord,
        store: readVoterStore(),
      });
    } else if (route.name === "register") {
      setTitle(t("chrome.navRegister"));
      await renderRegister(main, { ...ctx(), route });
    } else if (route.name === "vote") {
      setTitle(t("chrome.titleBallot"));
      await renderVote(main, { ...ctx(), route, electionId: route.params.id });
    } else if (route.name === "results") {
      setTitle(t("chrome.titleResults"));
      await renderResults(main, { ...ctx(), route, electionId: route.params.id });
    } else if (route.name === "resultsIndex") {
      setTitle(t("chrome.titleResults"));
      await renderResultsIndex(main, { ...ctx(), route });
    } else if (route.name === "election-info") {
      setTitle(t("chrome.titleInfo"));
      await renderElectionInfo(main, { ...ctx(), route, electionId: route.params.id });
    } else if (route.name === "option-info") {
      setTitle(t("chrome.titleOption"));
      await renderOptionInfo(main, {
        ...ctx(),
        route,
        electionId: route.params.id,
        questionId: route.params.questionId,
        optionId: route.params.optionId,
      });
    } else {
      setTitle(t("chrome.titleNotFound"));
      renderNotFound(main, route);
    }
  } catch (err) {
    main.replaceChildren(
      h(
        "div",
        { class: "notice notice-error", role: "alert" },
        h("p", { text: err.message || t("common.loadError") })
      ),
      h("p", {}, h("a", { class: "btn", href: "/", "data-nav": "", text: t("common.returnElections") }))
    );
  }
  main.focus({ preventScroll: true });
}

if (typeof document !== "undefined") {
  startRouter(renderRoute);
  window.addEventListener(SESSION_EVENT, () => {
    renderRoute(currentRoute());
  });
  window.addEventListener(LOCALE_EVENT, () => {
    renderRoute(currentRoute());
  });
}

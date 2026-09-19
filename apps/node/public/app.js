/**
 * NOT FOR PROFIT — Republic is a civic public good. Not a commercial product.
 * Voter home and application shell for the Republic Node SPA.
 */

import { startRouter, navigate, currentRoute } from "./router.js";
import * as wallet from "./passkey-wallet.js";
import { renderRegister } from "./register.js";
import { renderVote, SAMPLE_QUESTIONS } from "./vote.js";
import { questionsOf, typeLabel } from "./ballot.js";
import { renderElectionInfo, renderOptionInfo } from "./info.js";
import { renderResults, renderResultsIndex } from "./results.js";
import { SESSION_EVENT, logout, mountSignInPanel } from "./signin.js";
import {
  applyAudienceChrome,
  audienceOf,
  homeDestination,
} from "./audience.js";
import { renderAbout, renderFaq, renderOffice, renderPublicHome, renderSignIn } from "./public-pages.js";
import { renderTerms } from "./terms.js";
import {
  loadPublicCms,
  renderCmsPage,
  renderOfficePageEditor,
  renderOfficePages,
  renderOfficeSite,
} from "./cms.js";

const VOTER_STORE_KEY = "republic.voter.v1";

const STATE_LABELS = {
  0: "Created",
  1: "Roll frozen",
  2: "Open",
  3: "Closed",
  4: "Tallied",
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
      data?.error || data?.message || data?.detail || res.statusText || "Request failed"
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
  return {
    code: Number.isFinite(n) ? n : 0,
    label: STATE_LABELS[n] || `State ${state}`,
    className: STATE_CLASS[n] || "status-created",
  };
}

export function formatTime(value) {
  if (value == null || value === "") return "—";
  let ms = Number(value);
  if (!Number.isFinite(ms)) {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) return String(value);
    ms = parsed;
  } else if (ms < 1e12) {
    ms *= 1000;
  }
  try {
    return new Intl.DateTimeFormat(undefined, {
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
    title: raw.title || params.title || `Election ${id}`,
    jurisdiction:
      raw.jurisdiction ||
      raw.jurisdictionName ||
      raw.jurisdictionLabel ||
      (raw.jurisdictionId ? String(raw.jurisdictionId) : "Jurisdiction"),
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
      title: "City of Northbridge General Municipal Election",
      jurisdiction: "City of Northbridge",
      jurisdictionId: "northbridge",
      state: 2,
      startTime: now - 86400,
      cutoffTime: now + 86400 * 12,
      participantCount: 1840,
      maxParticipants: 0,
      questionCount: 2,
      rollFrozen: true,
      ballotSpecHash: "0x" + "ab".repeat(32),
      description: "Mayor is not on this ballot. Council at-large and one ordinance.",
      questions: SAMPLE_QUESTIONS,
    },
    {
      id: "7a8b9c0d-1e2f-4a3b-9c4d-5e6f70819202",
      shortCode: "ctymeas4n8",
      onChainElectionId: "2",
      aliases: ["2"],
      title: "County Measure A — Public Library Bond",
      jurisdiction: "Northbridge County",
      jurisdictionId: "northbridge-county",
      state: 1,
      startTime: now + 86400 * 3,
      cutoffTime: now + 86400 * 20,
      participantCount: 22011,
      maxParticipants: 0,
      questionCount: 1,
      rollFrozen: true,
      description: "Roll is certified. Voting opens at the published start time.",
      questions: [SAMPLE_QUESTIONS[0]],
    },
    {
      id: "4b5c6d7e-8f90-41a2-a3b4-c5d6e7f80903",
      shortCode: "schbrd5p2q",
      onChainElectionId: "3",
      aliases: ["3"],
      title: "School Board, District 4",
      jurisdiction: "Northbridge Unified School District",
      jurisdictionId: "nusd",
      state: 3,
      startTime: now - 86400 * 20,
      cutoffTime: now - 3600,
      participantCount: 903,
      maxParticipants: 0,
      questionCount: 1,
      rollFrozen: true,
      description: "Polls are closed. Tally has not been posted.",
      questions: [SAMPLE_QUESTIONS[1]],
    },
    {
      id: "90ab12cd-34ef-4a56-8b78-90abcdef0404",
      shortCode: "stref6q3r4",
      onChainElectionId: "4",
      aliases: ["4"],
      title: "Statewide special referendum — transit authority",
      jurisdiction: "State of example",
      jurisdictionId: "state-ex",
      state: 4,
      startTime: now - 86400 * 40,
      cutoffTime: now - 86400 * 10,
      participantCount: 501204,
      maxParticipants: 0,
      questionCount: 1,
      rollFrozen: true,
              description: "Tally posted. Receipts list hashes only and cannot prove which option you marked.",
      questions: [SAMPLE_QUESTIONS[0]],
    },
    {
      id: "11223344-5566-4777-8899-aabbccdde505",
      shortCode: "wrkcbd7s4t",
      onChainElectionId: "5",
      aliases: ["5"],
      title: "Workers’ cooperative board (annual)",
      jurisdiction: "Northbridge Food Cooperative",
      jurisdictionId: "nfc",
      state: 0,
      startTime: now + 86400 * 14,
      cutoffTime: now + 86400 * 21,
      participantCount: 40,
      maxParticipants: 0,
      questionCount: 2,
      rollFrozen: false,
      description: "Registration is open. The clerk has not frozen the roll.",
      questions: SAMPLE_QUESTIONS,
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
  document.title = page ? `${page} — Republic` : "Republic — civic elections";
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
  if (keys.some((k) => store.votes[k])) return { key: "recorded", label: "Ballot recorded", className: "status-recorded" };
  const remote = keys.map((k) => me?.elections?.[k] || me?.statuses?.[k]).find(Boolean);
  if (remote) {
    const status = String(remote.status || remote).toLowerCase();
    if (status.includes("disqual")) {
      return {
        key: "disqualified",
        label: `Disqualified${remote.reasonCode ? " · " + reasonLabel(remote.reasonCode) : ""}`,
        className: "status-disqualified",
      };
    }
    if (status.includes("pending")) return { key: "pending", label: "Pending review", className: "status-pending" };
    if (status.includes("eligible")) return { key: "eligible", label: "Eligible", className: "status-eligible" };
    if (status.includes("register")) return { key: "registered", label: "Registered", className: "status-eligible" };
  }
  if (me?.disqualified || me?.isDisqualified) {
    return { key: "disqualified", label: "Disqualified", className: "status-disqualified" };
  }
  if (keys.some((k) => store.registrations[k])) {
    if (election.state === 2) return { key: "eligible", label: "Eligible on this device", className: "status-eligible" };
    return { key: "registered", label: "Registered on this device", className: "status-eligible" };
  }
  return { key: "not_registered", label: "Not registered", className: "status-created" };
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

function updateNav(route, me, extraNav = []) {
  applyAudienceChrome(document, {
    audience: audienceOf(me),
    currentPath: route.path,
    routeName: route.name,
    spa: true,
    extraNav,
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
    SAMPLE_QUESTIONS,
    mountSignInPanel,
    me: null,
  };
}

function electionCard(election, me, store) {
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
      h("li", {}, h("span", { class: "lbl", text: "Opens" }), h("span", { text: formatTime(election.startTime) })),
      h("li", {}, h("span", { class: "lbl", text: "Cutoff" }), h("span", { text: formatTime(election.cutoffTime) })),
      election.shortCode
        ? h(
            "li",
            {},
            h("span", { class: "lbl", text: "Short link" }),
            h("a", { href: `/v/${encodeURIComponent(election.shortCode)}`, "data-nav": "", text: `/v/${election.shortCode}` })
          )
        : null,
      h(
        "li",
        {},
        h("span", { class: "lbl", text: "Roll" }),
        h(
          "span",
          {
            text: `${election.participantCount} registered${
              election.maxParticipants ? ` / cap ${election.maxParticipants}` : " (unlimited)"
            }`,
          }
        )
      ),
      h(
        "li",
        {},
        h("span", { class: "lbl", text: "Questions" }),
        h("span", { text: String(election.questionCount || election.questions?.length || "—") })
      )
    ),
    election.description ? h("p", { text: election.description }) : null,
    aspectPreview(election, h),
    h(
      "div",
      { class: "cluster" },
      canVote
        ? h("a", { class: "btn", href: `/vote/${encodeURIComponent(election.id)}`, "data-nav": "", text: "Mark ballot" })
        : vs.key === "recorded"
          ? h("a", { class: "btn btn-secondary", href: `/vote/${encodeURIComponent(election.id)}`, "data-nav": "", text: "View receipt" })
          : election.state === 2
            ? h("a", { class: "btn btn-secondary", href: `/vote/${encodeURIComponent(election.id)}`, "data-nav": "", text: "Open ballot" })
            : h("a", { class: "btn btn-secondary", href: `/vote/${encodeURIComponent(election.id)}`, "data-nav": "", text: "Election detail" }),
      canRegister
        ? h("a", { class: "btn btn-secondary", href: `/register?election=${encodeURIComponent(election.id)}`, "data-nav": "", text: "Register" })
        : null,
      h(
        "a",
        {
          class: election.state >= 4 ? "btn" : "btn btn-secondary",
          href: `/elections/${encodeURIComponent(election.id)}/results`,
          "data-nav": "",
          text: election.state >= 4 ? "Results" : "Results status",
        }
      ),
      h("a", {
        class: "btn btn-secondary",
        href: `/elections/${encodeURIComponent(election.id)}/info`,
        "data-nav": "",
        text: "Candidate / measure info",
      })
    )
  );
}

function electionGrid(elections, me, store, emptyText) {
  if (!elections.length) {
    return h("div", { class: "notice" }, h("p", { text: emptyText }));
  }
  return h("div", { class: "grid-cards", role: "list" }, ...elections.map((election) => electionCard(election, me, store)));
}

function renderDesk(main, route, bundle) {
  const { elections, source, me, walletRecord, store } = bundle;
  const signedIn = Boolean(me?.user);
  const openCount = elections.filter((e) => e.state === 2).length;
  const walletLine = walletRecord?.staleWrap
    ? "This device has a v1 passkey wrap (identity was derived from the account seed). Reset it on Register, then create a new passkey."
    : walletRecord
      ? `Passkey wallet on this device. Commitment ${walletRecord.identityCommitment.slice(0, 18)}…`
      : "No passkey on this device yet.";
  const yours = elections.filter((election) => voterStatusForElection(election, me, store).key !== "not_registered");
  const others = elections.filter((election) => voterStatusForElection(election, me, store).key === "not_registered");

  main.replaceChildren(
    ...[
    h(
      "div",
      { class: "page-head" },
      h("p", { class: "kicker", text: "Registered desk" }),
      h("h1", { text: signedIn ? "Your elections" : "Sign in to your desk" }),
      h(
        "p",
        { class: "lede" },
        "This is the registered-person desk: identity status, elections you are on, ballots, receipts, and results. Republic is not a commercial product."
      ),
      h(
        "div",
        { class: "notice", role: "status" },
        h("p", { text: `${openCount} election${openCount === 1 ? "" : "s"} currently accepting ballots.` }),
        h("p", { text: walletLine }),
        me?.user
          ? h("p", { text: `Signed in as ${me.user.handle} · ${me.user.role}.` })
          : h("p", { text: "Sign in below with email, Ethereum, a smart card, or a license/passport if you already have a person record on this Node." }),
        h("p", {
          text: "Public turnout and explorer vote proofs publish once an hour, after that hour closes. A person leaving a voting office cannot be matched to a live jurisdiction tick.",
        }),
        source === "sample"
          ? h("p", {
              text: "Showing the built-in sample roll because /api/elections is not available. When the Node API is up, this list is the live calendar.",
            })
          : null
      ),
      signedIn
        ? h(
            "div",
            { class: "cta-row" },
            h("a", { class: "btn", href: "/register", "data-nav": "", text: "Register for more elections" }),
            h("a", { class: "btn btn-secondary", href: "/elections", "data-nav": "", text: "All results" }),
            audienceOf(me) === "officer"
              ? h("a", { class: "btn btn-secondary", href: "/office", "data-nav": "", text: "Admin hub" })
              : null,
            h("button", {
              class: "btn btn-secondary",
              type: "button",
              text: "Sign out",
              onClick: async () => {
                await logout();
                navigate("/");
              },
            })
          )
        : null
    ),
    signedIn ? null : h("div", { id: "sign-in-root" }),
    h(
      "section",
      { "aria-labelledby": "identity-heading" },
      h("h2", { id: "identity-heading", text: "Identity status" }),
      renderDeviceStatus(walletRecord, me, store)
    ),
    h(
      "section",
      { "aria-labelledby": "yours-heading" },
      h("h2", { id: "yours-heading", text: "Elections you are on" }),
      electionGrid(
        yours,
        me,
        store,
        signedIn
          ? "You are not on a roll for any published election yet. Register below."
          : "Sign in to see elections you are registered or eligible for."
      )
    ),
    h(
      "section",
      { "aria-labelledby": "more-heading" },
      h("h2", { id: "more-heading", text: "Register for more elections" }),
      electionGrid(others, me, store, "No additional published elections on this Node.")
    ),
    ].filter(Boolean)
  );
  const signInRoot = main.querySelector("#sign-in-root");
  if (signInRoot) {
    signInRoot.setAttribute(
      "data-lede",
      "Returning users: email, Ethereum, a smart-card reader, or a license/passport already bound to your person. First-time registration is on Identify yourself."
    );
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
    h("dt", { text: "Passkey" }),
    h("dd", { text: walletRecord?.staleWrap ? "v1 wrap — reset required" : walletRecord ? "Present" : "Not created" }),
    h("dt", { text: "Identity commitment" }),
    h("dd", { class: walletRecord ? "hex" : "", text: walletRecord?.identityCommitment || "—" }),
    h("dt", { text: "Local address" }),
    h(
      "dd",
      {},
      walletRecord
        ? [h("code", { text: walletRecord.address }), " ", h("span", { class: "field-hint", text: `(${walletRecord.addressScheme})` })]
        : "—"
    ),
    h("dt", { text: "Active Ethereum address" }),
    h("dd", { class: me?.identity?.activeEthAddress ? "hex" : "", text: me?.identity?.activeEthAddress || "—" }),
    h("dt", { text: "Verified methods" }),
    h(
      "dd",
      {
        text: me?.identity?.authMethods?.length
          ? me.identity.authMethods.map((m) => m.type).join(", ")
          : "—",
      }
    ),
    h("dt", { text: "Local roll receipts" }),
    h("dd", { text: String(nReg) }),
    h("dt", { text: "Local ballot receipts" }),
    h("dd", { text: String(nVote) }),
  ];
  if (me?.status) {
    rows.push(h("dt", { text: "Node /api/me" }), h("dd", { text: String(me.status) }));
  }
  return h(
    "div",
    { class: "panel" },
    h("dl", { class: "status-dl" }, ...rows),
    h("p", { class: "field-hint", text: wallet.PRODUCTION_ADDRESS_NOTE }),
    h(
      "div",
      { class: "toolbar" },
      h("a", { class: "btn", href: "/register", "data-nav": "", text: walletRecord ? "Review identity" : "Identify yourself" })
    )
  );
}

function renderNotFound(main, route, me) {
  const home = homeDestination(audienceOf(me));
  main.replaceChildren(
    h("div", { class: "page-head" }, h("h1", { text: "Page not found" }), h("p", { text: `No voter page at ${route.path}.` })),
    h("p", {}, h("a", { class: "btn", href: home, "data-nav": "", text: "Return home" }))
  );
}

async function loadDeskBundle() {
  const [{ elections, source }, me, walletRecord] = await Promise.all([
    loadElections(),
    loadMe(),
    wallet.getPublicRecord().catch(() => null),
  ]);
  return {
    elections,
    source,
    me,
    walletRecord,
    store: readVoterStore(),
  };
}

async function renderRoute(route) {
  const main = document.getElementById("main");
  if (!main) return;
  main.replaceChildren(h("p", { class: "loading-msg", text: "Loading…" }));
  try {
    const meHint = await loadMe();
    const cms = await loadPublicCms(api);
    updateNav(route, meHint, cms.nav || []);
    const context = { ...ctx(), route, me: meHint, cms };

    if (route.name === "home") {
      const audience = audienceOf(meHint);
      if (audience !== "public") {
        navigate("/me", { replace: true });
        return;
      }
      const bundle = await loadDeskBundle();
      renderPublicHome(main, { ...context, me: bundle.me }, { ...bundle, audience: "public", cms });
    } else if (route.name === "publicHome") {
      const bundle = await loadDeskBundle();
      renderPublicHome(main, { ...context, me: bundle.me }, { ...bundle, audience: audienceOf(bundle.me), cms });
    } else if (route.name === "desk") {
      setTitle("My desk");
      const bundle = await loadDeskBundle();
      renderDesk(main, route, bundle);
    } else if (route.name === "about") {
      renderAbout(main, context);
    } else if (route.name === "faq") {
      renderFaq(main, context);
    } else if (route.name === "terms") {
      setTitle("Terms of Use");
      await renderTerms(main, context);
    } else if (route.name === "cmsPage") {
      let page = (cms.pages || []).find((p) => p.slug === route.params.slug) || null;
      if (!page) {
        try {
          const data = await api(`/api/pages/${encodeURIComponent(route.params.slug)}`);
          page = data.page;
        } catch {
          page = null;
        }
      }
      renderCmsPage(main, context, page);
    } else if (route.name === "signin") {
      await renderSignIn(main, context);
    } else if (route.name === "office") {
      renderOffice(main, context, { me: meHint });
    } else if (route.name === "officePages") {
      await renderOfficePages(main, context, { me: meHint });
    } else if (route.name === "officePageNew") {
      await renderOfficePageEditor(main, context, { me: meHint }, { isNew: true });
    } else if (route.name === "officePageEdit") {
      await renderOfficePageEditor(main, context, { me: meHint }, { isNew: false });
    } else if (route.name === "officeSite") {
      await renderOfficeSite(main, context, { me: meHint });
    } else if (route.name === "register") {
      setTitle("Register");
      await renderRegister(main, context);
    } else if (route.name === "vote") {
      setTitle("Ballot");
      await renderVote(main, { ...context, electionId: route.params.id });
    } else if (route.name === "results") {
      setTitle("Results");
      await renderResults(main, { ...context, electionId: route.params.id });
    } else if (route.name === "resultsIndex") {
      setTitle("Results");
      await renderResultsIndex(main, context);
    } else if (route.name === "election-info") {
      setTitle("Ballot information");
      await renderElectionInfo(main, { ...context, electionId: route.params.id });
    } else if (route.name === "option-info") {
      setTitle("Option information");
      await renderOptionInfo(main, {
        ...context,
        electionId: route.params.id,
        questionId: route.params.questionId,
        optionId: route.params.optionId,
      });
    } else {
      setTitle("Not found");
      renderNotFound(main, route, meHint);
    }
  } catch (err) {
    main.replaceChildren(
      h(
        "div",
        { class: "notice notice-error", role: "alert" },
        h("p", { text: err.message || "Something went wrong loading this page." })
      ),
      h("p", {}, h("a", { class: "btn", href: "/", "data-nav": "", text: "Return home" }))
    );
  }
  main.focus({ preventScroll: true });
}

if (typeof document !== "undefined") {
  startRouter(renderRoute);
  window.addEventListener(SESSION_EVENT, () => {
    renderRoute(currentRoute());
  });
}

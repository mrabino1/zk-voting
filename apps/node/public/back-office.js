/* Back office — clerk, registrar, disqualification officer, tally, notifications. */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const REASON_LABELS = {
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

  async function request(path, opts = {}) {
    const headers = { Accept: "application/json", ...(opts.headers || {}) };
    if (opts.body != null) headers["Content-Type"] = "application/json";
    const res = await fetch(path, {
      credentials: "include",
      ...opts,
      headers,
      body: opts.body == null ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const err = new Error((data && (data.error || data.message)) || res.statusText || "Request failed");
      err.status = res.status;
      err.data = data;
      err.path = path;
      throw err;
    }
    return data;
  }

  function retryable(err) {
    return !err.status || err.status === 404 || err.status === 405 || err.status === 501;
  }

  async function getFirst(paths) {
    let last;
    for (const path of paths) {
      try {
        return await request(path);
      } catch (err) {
        last = err;
        if (!retryable(err)) throw err;
      }
    }
    throw last || new Error("Not found");
  }

  function pick(obj, names) {
    if (obj == null) return undefined;
    for (const name of names) {
      const parts = name.split(".");
      let cur = obj;
      for (const part of parts) {
        if (cur == null) break;
        cur = cur[part];
      }
      if (cur != null && cur !== "") return cur;
    }
    return undefined;
  }

  function asList(data, keys) {
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== "object") return [];
    for (const key of keys) {
      if (Array.isArray(data[key])) return data[key];
    }
    if (Array.isArray(data.data)) return data.data;
    return [];
  }

  function esc(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function flash(el, kind, message) {
    el.className = "flash show " + kind;
    el.textContent = message;
  }

  function errText(err) {
    return (
      (err.status ? err.status + " · " : "") +
      (err.message || "Request failed") +
      (err.path ? " (" + err.path + ")" : "")
    );
  }

  function toUnix(datetimeLocal) {
    const ms = new Date(datetimeLocal).getTime();
    if (Number.isNaN(ms)) throw new Error("Invalid datetime");
    return Math.floor(ms / 1000);
  }

  function defaultTimes() {
    const start = new Date(Date.now() + 60 * 60 * 1000);
    const cutoff = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
    const iso = (d) => {
      const pad = (n) => String(n).padStart(2, "0");
      return (
        d.getFullYear() +
        "-" +
        pad(d.getMonth() + 1) +
        "-" +
        pad(d.getDate()) +
        "T" +
        pad(d.getHours()) +
        ":" +
        pad(d.getMinutes())
      );
    };
    $("e-start").value = iso(start);
    $("e-cutoff").value = iso(cutoff);
  }

  function fillSelect(select, rows, getValue, getLabel) {
    const current = select.value;
    if (!rows.length) {
      select.innerHTML = '<option value="">None loaded</option>';
      return;
    }
    select.innerHTML =
      '<option value="">Select…</option>' +
      rows
        .map((row) => {
          const value = getValue(row);
          const label = getLabel(row);
          return `<option value="${esc(value)}">${esc(label)}</option>`;
        })
        .join("");
    if (current && [...select.options].some((o) => o.value === current)) select.value = current;
  }

  const QUESTION_TYPES = [
    ["YES_NO", "Yes / No"],
    ["SINGLE_CHOICE", "Single choice"],
    ["MULTI_CHOICE", "Multi choice"],
    ["MEASURE", "Measure / article"],
  ];

  const DEFAULT_QUESTIONS = [
    {
      id: "q1",
      type: "SINGLE_CHOICE",
      prompt: "City Council, at-large",
      options: [
        {
          id: "jane",
          label: "Jane Doe",
          summary: "Incumbent. Housing and transit.",
          body: "Jane Doe has served one term. Supporting information here is hashed into the ballot spec.",
          imageUrl: "",
          links: [{ label: "Campaign site", url: "https://example.org/jane" }],
        },
        {
          id: "alex",
          label: "Alex Rivera",
          summary: "Community organizer.",
          body: "",
          imageUrl: "",
          links: [],
        },
      ],
    },
    {
      id: "q2",
      type: "YES_NO",
      prompt: "Shall Ordinance 2026-14 be adopted?",
      options: [
        { id: "no", label: "No", summary: "Reject the ordinance.", body: "", imageUrl: "", links: [] },
        {
          id: "yes",
          label: "Yes",
          summary: "Adopt the ordinance.",
          body: "Full text lives on the jurisdiction site.",
          imageUrl: "",
          links: [{ label: "Ordinance text", url: "https://example.org/ordinance" }],
        },
      ],
    },
  ];

  function blankOption(index) {
    return { id: "o" + (index + 1), label: "", summary: "", body: "", imageUrl: "", links: [] };
  }

  function blankQuestion(index) {
    return {
      id: "q" + (index + 1),
      type: "SINGLE_CHOICE",
      prompt: "",
      options: [blankOption(0), blankOption(1)],
    };
  }

  function hydrateOption(raw, index) {
    if (typeof raw === "string" || typeof raw === "number") {
      return { id: "o" + (index + 1), label: String(raw), summary: "", body: "", imageUrl: "", links: [] };
    }
    const links = Array.isArray(raw?.links)
      ? raw.links.map((link, i) =>
          typeof link === "string"
            ? { label: "Link " + (i + 1), url: link }
            : { label: String(link.label || link.title || ""), url: String(link.url || link.href || "") }
        )
      : [];
    return {
      id: String(raw?.id || "o" + (index + 1)),
      label: String(raw?.label || raw?.name || ""),
      summary: String(raw?.summary || raw?.blurb || ""),
      body: String(raw?.body || raw?.description || ""),
      imageUrl: String(raw?.imageUrl || raw?.image || ""),
      links,
    };
  }

  function hydrateQuestions(raw) {
    if (!Array.isArray(raw) || !raw.length) return DEFAULT_QUESTIONS.map((q) => JSON.parse(JSON.stringify(q)));
    return raw.map((q, i) => {
      const type = String(q.type || "YES_NO").toUpperCase();
      let options = Array.isArray(q.options) ? q.options.map((o, j) => hydrateOption(o, j)) : [];
      if (!options.length && (type === "YES_NO" || !q.type)) {
        options = [
          { id: "yes", label: "Yes", summary: "", body: "", imageUrl: "", links: [] },
          { id: "no", label: "No", summary: "", body: "", imageUrl: "", links: [] },
        ];
      }
      return {
        id: String(q.id || "q" + (i + 1)),
        type,
        prompt: String(q.prompt || q.title || ""),
        options,
      };
    });
  }

  function compactQuestions(questions) {
    return questions.map((q, i) => {
      const out = {
        id: String(q.id || "q" + (i + 1)).trim() || "q" + (i + 1),
        type: String(q.type || "SINGLE_CHOICE"),
        prompt: String(q.prompt || "").trim() || "Question " + (i + 1),
        options: (q.options || []).map((o, j) => {
          const opt = {
            id: String(o.id || "o" + (j + 1)).trim() || "o" + (j + 1),
            label: String(o.label || "").trim() || "Option " + (j + 1),
          };
          const summary = String(o.summary || "").trim();
          const body = String(o.body || "").trim();
          const imageUrl = String(o.imageUrl || "").trim();
          const links = (o.links || [])
            .map((link) => ({
              label: String(link.label || "").trim(),
              url: String(link.url || "").trim(),
            }))
            .filter((link) => link.url);
          if (summary) opt.summary = summary;
          if (body) opt.body = body;
          if (imageUrl) opt.imageUrl = imageUrl;
          if (links.length) opt.links = links;
          return opt;
        }),
      };
      return out;
    });
  }

  let ballotQuestions = hydrateQuestions(DEFAULT_QUESTIONS);
  let editingElectionId = "";
  let ballotLocked = false;
  let syncingJson = false;

  function setJsonFromBuilder() {
    const ta = $("e-questions");
    if (!ta) return;
    syncingJson = true;
    ta.value = JSON.stringify(compactQuestions(ballotQuestions), null, 2);
    syncingJson = false;
  }

  function readBuilderFromDom() {
    const root = $("ballot-builder");
    if (!root) return;
    const next = [];
    root.querySelectorAll(".q-card[data-q]").forEach((card) => {
      const qi = Number(card.getAttribute("data-q"));
      const options = [];
      card.querySelectorAll(".opt-card[data-opt]").forEach((optEl) => {
        const links = [];
        optEl.querySelectorAll(".link-row[data-link]").forEach((row) => {
          links.push({
            label: row.querySelector('[data-f="link-label"]').value,
            url: row.querySelector('[data-f="link-url"]').value,
          });
        });
        options.push({
          id: optEl.querySelector('[data-f="opt-id"]').value,
          label: optEl.querySelector('[data-f="opt-label"]').value,
          summary: optEl.querySelector('[data-f="opt-summary"]').value,
          body: optEl.querySelector('[data-f="opt-body"]').value,
          imageUrl: optEl.querySelector('[data-f="opt-image"]').value,
          links,
        });
      });
      next[qi] = {
        id: card.querySelector('[data-f="q-id"]').value,
        type: card.querySelector('[data-f="q-type"]').value,
        prompt: card.querySelector('[data-f="q-prompt"]').value,
        options,
      };
    });
    ballotQuestions = next.filter(Boolean);
  }

  function typeOptions(selected) {
    return QUESTION_TYPES.map(
      ([value, label]) =>
        `<option value="${esc(value)}"${value === selected ? " selected" : ""}>${esc(label)}</option>`
    ).join("");
  }

  function renderLinkRow(qi, oi, li, link) {
    return `<div class="link-row" data-link="${li}">
      <input class="builder-mini" data-f="link-label" ${ballotLocked ? "disabled" : ""} placeholder="Label" value="${esc(link.label || "")}" aria-label="Link label" />
      <input class="builder-mini" data-f="link-url" ${ballotLocked ? "disabled" : ""} placeholder="https://…" value="${esc(link.url || "")}" aria-label="Link URL" />
      <button class="btn btn-secondary" type="button" data-act="rm-link" data-q="${qi}" data-opt="${oi}" data-link="${li}" ${ballotLocked ? "disabled" : ""}>Remove</button>
    </div>`;
  }

  function renderOptionCard(qi, oi, opt) {
    const links = opt.links && opt.links.length ? opt.links : [];
    return `<article class="opt-card" data-opt="${oi}">
      <div class="opt-card-head">
        <h4>Option ${oi + 1}</h4>
        <button class="btn btn-secondary" type="button" data-act="rm-opt" data-q="${qi}" data-opt="${oi}" ${ballotLocked ? "disabled" : ""}>Remove option</button>
      </div>
      <div class="grid-2">
        <div class="field">
          <label class="field-label">Name / title</label>
          <input class="builder-mini" data-f="opt-label" ${ballotLocked ? "disabled" : ""} required value="${esc(opt.label || "")}" placeholder="Jane Doe" />
        </div>
        <div class="field">
          <label class="field-label">Option id</label>
          <input class="builder-mini" data-f="opt-id" ${ballotLocked ? "disabled" : ""} value="${esc(opt.id || "")}" placeholder="o1" />
        </div>
      </div>
      <div class="field">
        <label class="field-label">Short blurb</label>
        <input class="builder-mini" data-f="opt-summary" ${ballotLocked ? "disabled" : ""} maxlength="500" value="${esc(opt.summary || "")}" placeholder="One-line summary on the voter list" />
      </div>
      <div class="field">
        <label class="field-label">Supporting information</label>
        <textarea class="builder-body" data-f="opt-body" ${ballotLocked ? "disabled" : ""} placeholder="Plain text or light markdown for the mini info page">${esc(opt.body || "")}</textarea>
      </div>
      <div class="field">
        <label class="field-label">Image URL (optional)</label>
        <input class="builder-mini" data-f="opt-image" ${ballotLocked ? "disabled" : ""} value="${esc(opt.imageUrl || "")}" placeholder="https://…" />
      </div>
      <div class="field">
        <span class="field-label">External links</span>
        <div class="link-rows">${links.map((link, li) => renderLinkRow(qi, oi, li, link)).join("")}</div>
        <div class="actions" style="margin-top:0.4rem">
          <button class="btn btn-secondary" type="button" data-act="add-link" data-q="${qi}" data-opt="${oi}" ${ballotLocked ? "disabled" : ""}>Add link</button>
        </div>
      </div>
    </article>`;
  }

  function renderQuestionCard(q, qi) {
    return `<section class="q-card" data-q="${qi}">
      <div class="q-card-head">
        <h3>Question ${qi + 1}</h3>
        <button class="btn btn-secondary" type="button" data-act="rm-q" data-q="${qi}" ${ballotLocked ? "disabled" : ""}>Remove question</button>
      </div>
      <div class="grid-2">
        <div class="field">
          <label class="field-label">Prompt</label>
          <input class="builder-mini" data-f="q-prompt" ${ballotLocked ? "disabled" : ""} required value="${esc(q.prompt || "")}" placeholder="Office or measure text" />
        </div>
        <div class="field">
          <label class="field-label">Type</label>
          <select class="builder-mini" data-f="q-type" ${ballotLocked ? "disabled" : ""}>${typeOptions(q.type)}</select>
        </div>
      </div>
      <div class="field">
        <label class="field-label">Question id</label>
        <input class="builder-mini" data-f="q-id" ${ballotLocked ? "disabled" : ""} value="${esc(q.id || "")}" placeholder="q1" />
      </div>
      <div class="opt-list">${(q.options || []).map((opt, oi) => renderOptionCard(qi, oi, opt)).join("")}</div>
      <div class="actions" style="margin-top:0.75rem">
        <button class="btn btn-secondary" type="button" data-act="add-opt" data-q="${qi}" ${ballotLocked ? "disabled" : ""}>Add option</button>
      </div>
    </section>`;
  }

  function renderBuilder() {
    const root = $("ballot-builder");
    if (!root) return;
    if (!ballotQuestions.length) ballotQuestions = [blankQuestion(0)];
    root.innerHTML = ballotQuestions.map((q, i) => renderQuestionCard(q, i)).join("");
    setJsonFromBuilder();
    const saveBtn = $("btn-save-ballot");
    if (saveBtn) saveBtn.hidden = !editingElectionId;
    const preview = $("link-info-preview");
    if (preview) {
      if (editingElectionId) {
        preview.hidden = false;
        preview.href = "/elections/" + encodeURIComponent(editingElectionId) + "/info";
      } else {
        preview.hidden = true;
      }
    }
    const hint = $("ballot-lock-hint");
    const addQ = $("btn-add-question");
    if (addQ) addQ.disabled = ballotLocked;
    if (hint && ballotLocked) {
      hint.textContent =
        "This ballot is frozen. Supporting information is locked in ballotSpecHash; voters can still read it on the public info pages.";
    }
  }

  function wireBuilder() {
    const root = $("ballot-builder");
    if (!root || root.dataset.wired) return;
    root.dataset.wired = "1";
    root.addEventListener("input", () => {
      if (ballotLocked) return;
      try {
        readBuilderFromDom();
        setJsonFromBuilder();
      } catch (err) {
        flash($("flash-election"), "err", err.message || "Could not read the ballot builder.");
      }
    });
    root.addEventListener("change", () => {
      if (ballotLocked) return;
      try {
        readBuilderFromDom();
        setJsonFromBuilder();
      } catch (err) {
        flash($("flash-election"), "err", err.message || "Could not read the ballot builder.");
      }
    });
    root.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-act]");
      if (!btn || ballotLocked) return;
      event.preventDefault();
      try {
        readBuilderFromDom();
      } catch (err) {
        flash($("flash-election"), "err", err.message || "Could not read the ballot builder.");
        return;
      }
      const act = btn.getAttribute("data-act");
      const qi = Number(btn.getAttribute("data-q"));
      const oi = Number(btn.getAttribute("data-opt"));
      const li = Number(btn.getAttribute("data-link"));
      if (act === "add-opt") {
        ballotQuestions[qi].options.push(blankOption(ballotQuestions[qi].options.length));
      } else if (act === "rm-opt") {
        if (ballotQuestions[qi].options.length <= 1) return;
        ballotQuestions[qi].options.splice(oi, 1);
      } else if (act === "add-link") {
        const opt = ballotQuestions[qi].options[oi];
        opt.links = opt.links || [];
        if (opt.links.length >= 8) return;
        opt.links.push({ label: "", url: "" });
      } else if (act === "rm-link") {
        ballotQuestions[qi].options[oi].links.splice(li, 1);
      } else if (act === "rm-q") {
        if (ballotQuestions.length <= 1) return;
        ballotQuestions.splice(qi, 1);
      }
      renderBuilder();
    });
  }

  function parseQuestionsJson() {
    const parsed = JSON.parse($("e-questions").value);
    if (!Array.isArray(parsed)) throw new Error("Questions must be a JSON array.");
    return parsed;
  }

  $("e-questions").addEventListener("change", () => {
    if (syncingJson || ballotLocked) return;
    try {
      ballotQuestions = hydrateQuestions(parseQuestionsJson());
      renderBuilder();
    } catch {
      /* keep builder; submit will surface JSON errors */
    }
  });

  $("btn-add-question").addEventListener("click", () => {
    if (ballotLocked) return;
    try {
      readBuilderFromDom();
    } catch (err) {
      flash($("flash-election"), "err", err.message || "Could not read the ballot builder.");
      return;
    }
    ballotQuestions.push(blankQuestion(ballotQuestions.length));
    renderBuilder();
  });

  function setEditingElection(id, frozen) {
    editingElectionId = id ? String(id) : "";
    ballotLocked = Boolean(frozen);
    renderBuilder();
  }

  async function loadBallotIntoBuilder(id) {
    const data = await request("/api/elections/" + encodeURIComponent(id));
    const election = data.election || data;
    $("e-title").value = pick(election, ["title"]) || "";
    $("e-uri").value = pick(election, ["metadataURI"]) || "";
    const jid = pick(election, ["jurisdictionId"]);
    if (jid) $("e-jurisdiction").value = jid;
    const start = pick(election, ["startTime"]);
    const cutoff = pick(election, ["cutoffTime"]);
    if (start) $("e-start").value = unixToLocal(start);
    if (cutoff) $("e-cutoff").value = unixToLocal(cutoff);
    ballotQuestions = hydrateQuestions(election.questions || []);
    setEditingElection(election.id, election.rollFrozen || Number(election.state) >= 1);
    if (election.rollFrozen) {
      flash($("flash-election"), "warn", "Loaded frozen election " + election.id + ". Ballot metadata is read-only.");
    } else {
      flash($("flash-election"), "ok", "Loaded election " + election.id + ". Save ballot changes before freezing the roll.");
    }
  }

  function unixToLocal(value) {
    let n = Number(value);
    if (!Number.isFinite(n)) return "";
    if (n < 1e12) n *= 1000;
    const d = new Date(n);
    const pad = (x) => String(x).padStart(2, "0");
    return (
      d.getFullYear() +
      "-" +
      pad(d.getMonth() + 1) +
      "-" +
      pad(d.getDate()) +
      "T" +
      pad(d.getHours()) +
      ":" +
      pad(d.getMinutes())
    );
  }

  $("btn-load-ballot").addEventListener("click", async () => {
    const id = $("e-load").value;
    if (!id) {
      ballotQuestions = hydrateQuestions(DEFAULT_QUESTIONS);
      setEditingElection("", false);
      flash($("flash-election"), "ok", "Cleared to a new ballot. Create election to store it.");
      return;
    }
    try {
      await loadBallotIntoBuilder(id);
    } catch (err) {
      flash($("flash-election"), "err", errText(err));
    }
  });

  $("btn-save-ballot").addEventListener("click", async () => {
    if (!editingElectionId) return;
    if (ballotLocked) {
      flash($("flash-election"), "err", "This ballot is frozen.");
      return;
    }
    try {
      readBuilderFromDom();
      const questions = compactQuestions(ballotQuestions);
      await request("/api/elections/" + encodeURIComponent(editingElectionId), {
        method: "PATCH",
        body: {
          title: $("e-title").value.trim(),
          metadataURI: $("e-uri").value.trim(),
          questions,
        },
      });
      flash($("flash-election"), "ok", "Saved ballot " + editingElectionId + ". Option info is in ballotSpecHash.");
      await loadElections();
    } catch (err) {
      flash($("flash-election"), "err", errText(err));
    }
  });

  function electionIdOf(row) {
    return pick(row, ["id", "electionId"]);
  }

  function electionLabel(row) {
    const title = pick(row, ["title", "name", "stateName"]) || "Election";
    const state = pick(row, ["stateName"]) || "";
    return title + " · #" + electionIdOf(row) + (state ? " · " + state : "");
  }

  function markRole(el, ok) {
    el.className = "pill " + (ok ? "pill-ok" : "pill-warn");
    el.title = ok ? "Granted on this session" : "Not listed on /api/me — the Node still enforces roles";
  }

  function hexUint(value, label) {
    const v = value.trim();
    if (/^0x[0-9a-fA-F]+$/.test(v)) return v;
    if (/^[0-9]+$/.test(v)) return v;
    throw new Error(label + " must be a hex uint (0x…) or decimal integer.");
  }

  function evidenceHex(value, label) {
    const v = value.trim();
    const hex = v.startsWith("0x") ? v : "0x" + v;
    if (!/^0x[0-9a-fA-F]+$/.test(hex) || (hex.length - 2) % 2 !== 0) {
      throw new Error(label + " must be hex (bytes32 preferred; the Node pads shorter values).");
    }
    return hex;
  }

  async function loadMe() {
    try {
      const me = await request("/api/me");
      const user = me.user;
      const role = user && user.role ? String(user.role) : "";
      if (!user) {
        $("me-line").textContent = "Not signed in — the Node will still enforce roles on each action.";
      } else {
        $("me-line").textContent =
          user.handle + " · " + role + (me.unreadCount ? " · " + me.unreadCount + " unread" : "");
      }
      markRole($("role-clerk"), role === "clerk" || role === "platform_admin");
      markRole($("role-registrar"), role === "registrar" || role === "platform_admin");
      markRole($("role-dq"), role === "disqualification_officer" || role === "platform_admin");
      markRole($("role-tally"), role === "tally_operator" || role === "platform_admin");
      try {
        const cfg = await request("/api/config");
        const banner = $("disclosure-banner");
        const helper = globalThis.RepublicDisclosure;
        if (banner && cfg.disclosure && helper) {
          helper.paint(banner, cfg.disclosure);
        } else if (banner && cfg.disclosure && cfg.disclosure.note) {
          const next = cfg.disclosure.nextPublishAt;
          const when =
            next != null
              ? new Date(Number(next) * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC")
              : "";
          banner.textContent = cfg.disclosure.note + (when ? " Next publish: " + when + "." : "");
        }
      } catch {
        /* banner keeps static copy */
      }
      return me;
    } catch (err) {
      $("me-line").textContent = errText(err);
      return null;
    }
  }

  async function loadJurisdictions() {
    try {
      const data = await getFirst(["/api/jurisdictions", "/api/admin/jurisdictions"]);
      const rows = asList(data, ["jurisdictions", "items"]);
      fillSelect(
        $("e-jurisdiction"),
        rows,
        (row) => row.id,
        (row) => (row.name || row.id) + " · " + row.id
      );
    } catch (err) {
      $("e-jurisdiction").innerHTML = `<option value="">${esc(errText(err))}</option>`;
    }
  }

  async function loadReasonCodes() {
    try {
      const data = await getFirst(["/api/reason-codes", "/api/admin/reason-codes"]);
      const rows = asList(data, ["reasonCodes", "items"]);
      if (!rows.length) return;
      $("d-reason").innerHTML = rows
        .map((r) => `<option value="${esc(r.code)}">${esc(r.code)} — ${esc(r.name)}</option>`)
        .join("");
    } catch {
      /* catalog already in the HTML */
    }
  }

  function wireExplorerLinks(id) {
    if (!id) return;
    $("link-results").href = "/elections/" + encodeURIComponent(id) + "/results";
    $("link-explorer").href = "/explorer#/election/" + encodeURIComponent(id);
  }

  async function loadElections() {
    try {
      const data = await request("/api/elections");
      const rows = asList(data, ["elections", "items"]);
      const selects = [$("f-election"), $("r-election"), $("d-election"), $("t-election")];
      for (const sel of selects) fillSelect(sel, rows, electionIdOf, electionLabel);
      const loader = $("e-load");
      if (loader) {
        const current = loader.value;
        loader.innerHTML =
          '<option value="">New election…</option>' +
          rows
            .map((row) => `<option value="${esc(electionIdOf(row))}">${esc(electionLabel(row))}</option>`)
            .join("");
        if (current && [...loader.options].some((o) => o.value === current)) loader.value = current;
      }
      if (rows[0]) wireExplorerLinks(electionIdOf(rows[0]));
    } catch (err) {
      for (const id of ["f-election", "r-election", "d-election", "t-election"]) {
        $(id).innerHTML = `<option value="">${esc(errText(err))}</option>`;
      }
    }
  }

  function fmtNoticeTime(row) {
    const ts = pick(row, ["createdAt", "created_at", "timestamp"]);
    if (ts == null) return "";
    const n = Number(ts);
    const d = Number.isFinite(n) && String(ts).length > 10 ? new Date(n) : new Date(ts);
    if (Number.isNaN(d.getTime())) return String(ts);
    return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
  }

  async function loadNotifications() {
    const list = $("notice-list");
    try {
      const data = await request("/api/notifications");
      const rows = asList(data, ["notifications", "items"]);
      if (!rows.length) {
        list.innerHTML = '<li class="empty">No notifications.</li>';
        return;
      }
      list.innerHTML = rows
        .map((row) => {
          const title = pick(row, ["title", "type"]) || "Notice";
          const body = pick(row, ["body", "message"]) || "";
          const time = fmtNoticeTime(row);
          return `<li><strong>${esc(title)}</strong>${body ? " — " + esc(body) : ""}${
            time ? `<time datetime="">${esc(time)}</time>` : ""
          }</li>`;
        })
        .join("");
    } catch (err) {
      if (err.status === 401) {
        list.innerHTML = '<li class="empty">Sign in to see notifications.</li>';
        return;
      }
      list.innerHTML = `<li class="empty">${esc(errText(err))}</li>`;
    }
  }

  $("form-election").addEventListener("submit", async (event) => {
    event.preventDefault();
    let questions;
    try {
      readBuilderFromDom();
      questions = compactQuestions(ballotQuestions);
      if (!questions.length) throw new Error("Add at least one question.");
      $("e-questions").value = JSON.stringify(questions, null, 2);
    } catch (err) {
      flash($("flash-election"), "err", err.message || "Questions are invalid.");
      return;
    }
    let startTime;
    let cutoffTime;
    try {
      startTime = toUnix($("e-start").value);
      cutoffTime = toUnix($("e-cutoff").value);
    } catch (err) {
      flash($("flash-election"), "err", err.message);
      return;
    }
    if (!(startTime < cutoffTime)) {
      flash($("flash-election"), "err", "Start must be before cutoff.");
      return;
    }
    const body = {
      title: $("e-title").value.trim(),
      metadataURI: $("e-uri").value.trim(),
      startTime,
      cutoffTime,
      maxParticipants: Number($("e-max").value || 0),
      treeDepth: Number($("e-depth").value),
      questions,
      jurisdictionId: $("e-jurisdiction").value,
    };
    try {
      const created = await request("/api/elections", { method: "POST", body });
      const id = pick(created, ["election.id", "id"]) || "";
      flash($("flash-election"), "ok", "Created election" + (id ? " " + id : "") + ". Freeze the roll before opening.");
      if (id) {
        $("e-load").value = String(id);
        setEditingElection(id, false);
        $("link-info-preview").hidden = false;
        $("link-info-preview").href = "/elections/" + encodeURIComponent(id) + "/info";
      }
      await loadElections();
    } catch (err) {
      flash($("flash-election"), "err", errText(err));
    }
  });

  $("form-freeze").addEventListener("submit", async (event) => {
    event.preventDefault();
    const id = $("f-election").value;
    if (!id) {
      flash($("flash-freeze"), "err", "Choose an election.");
      return;
    }
    try {
      await request("/api/elections/" + encodeURIComponent(id) + "/freeze", { method: "POST", body: {} });
      flash($("flash-freeze"), "ok", "Roll frozen for election " + id);
      await loadElections();
    } catch (err) {
      flash($("flash-freeze"), "err", errText(err));
    }
  });

  $("form-register").addEventListener("submit", async (event) => {
    event.preventDefault();
    const id = $("r-election").value;
    let identityCommitment;
    try {
      identityCommitment = hexUint($("r-commit").value, "Identity commitment");
    } catch (err) {
      flash($("flash-register"), "err", err.message);
      return;
    }
    try {
      await request("/api/elections/" + encodeURIComponent(id) + "/register", {
        method: "POST",
        body: { identityCommitment },
      });
      flash($("flash-register"), "ok", "Commitment inserted. The leaf is not a name or wallet.");
      $("r-commit").value = "";
    } catch (err) {
      flash($("flash-register"), "err", errText(err));
    }
  });

  $("form-person-key").addEventListener("submit", async (event) => {
    event.preventDefault();
    const id = $("p-user").value.trim();
    const raw = $("p-key").value.trim();
    if (!id || !raw) {
      flash($("flash-person-key"), "err", "Person id and key are required.");
      return;
    }
    const body = raw.startsWith("0x") && raw.length === 66 ? { personKeyHash: raw } : { personKey: raw };
    try {
      await request("/api/persons/" + encodeURIComponent(id) + "/person-key", { method: "POST", body });
      flash($("flash-person-key"), "ok", "Person key bound. The Node stored a hash, not a legal name.");
    } catch (err) {
      flash($("flash-person-key"), "err", errText(err));
    }
  });

  $("form-person-method").addEventListener("submit", async (event) => {
    event.preventDefault();
    const id = $("pm-user").value.trim();
    const type = $("pm-type").value;
    const fp = $("pm-fp").value.trim();
    const looksPem = fp.includes("-----BEGIN");
    const body = {
      type,
      address: $("pm-addr").value.trim() || undefined,
      credentialId: $("pm-cred").value.trim() || undefined,
    };
    if (fp) {
      if (looksPem) body.certificate = fp;
      else body.fingerprint = fp;
    }
    try {
      await request("/api/persons/" + encodeURIComponent(id) + "/methods", { method: "POST", body });
      flash($("flash-person-method"), "ok", "Authenticator attested to this person. It cannot be bound to a second person.");
    } catch (err) {
      flash($("flash-person-method"), "err", errText(err));
    }
  });

  $("form-person-eth").addEventListener("submit", async (event) => {
    event.preventDefault();
    const id = $("pe-user").value.trim();
    const address = $("pe-addr").value.trim();
    try {
      await request("/api/persons/" + encodeURIComponent(id) + "/eth-accounts", {
        method: "POST",
        body: { address, source: "registrar" },
      });
      flash($("flash-person-eth"), "ok", "Address verified internally. First verified address becomes active automatically.");
    } catch (err) {
      flash($("flash-person-eth"), "err", errText(err));
    }
  });

  $("btn-person-active").addEventListener("click", async () => {
    const id = $("pe-user").value.trim();
    const address = $("pe-addr").value.trim();
    try {
      const data = await request("/api/persons/" + encodeURIComponent(id) + "/eth-accounts/active", {
        method: "POST",
        body: { address },
      });
      flash($("flash-person-eth"), "ok", "Active Ethereum address is now " + (data.activeEthAddress || address) + ".");
    } catch (err) {
      flash($("flash-person-eth"), "err", errText(err));
    }
  });

  async function submitDisqualify(revoke) {
    const id = $("d-election").value;
    let identityCommitment;
    let evidenceHash;
    try {
      identityCommitment = hexUint($("d-commit").value, "Identity commitment");
      evidenceHash = evidenceHex($("d-evidence").value, "Evidence hash");
    } catch (err) {
      flash($("flash-dq"), "err", err.message);
      return;
    }
    const reasonCode = Number($("d-reason").value);
    const body = { identityCommitment, reasonCode, evidenceHash };
    try {
      if (revoke) {
        await request("/api/elections/" + encodeURIComponent(id) + "/disqualify/revoke", {
          method: "POST",
          body,
        });
        flash($("flash-dq"), "ok", "Disqualification revoked (auditable event, not a silent delete).");
      } else {
        await request("/api/elections/" + encodeURIComponent(id) + "/disqualify", { method: "POST", body });
        flash($("flash-dq"), "ok", "Recorded " + REASON_LABELS[reasonCode] + ". The person remains registered.");
      }
    } catch (err) {
      flash($("flash-dq"), "err", errText(err));
    }
  }

  $("form-dq").addEventListener("submit", (event) => {
    event.preventDefault();
    submitDisqualify(false);
  });

  $("btn-revoke").addEventListener("click", () => submitDisqualify(true));

  $("form-tally").addEventListener("submit", async (event) => {
    event.preventDefault();
    const id = $("t-election").value;
    let counts;
    try {
      counts = JSON.parse($("t-counts").value);
      if (!Array.isArray(counts) || counts.some((n) => typeof n !== "number" || !Number.isInteger(n) || n < 0)) {
        throw new Error("Counts must be a JSON array of non-negative integers.");
      }
    } catch (err) {
      flash($("flash-tally"), "err", err.message || "Counts JSON is invalid.");
      return;
    }
    const body = { counts };
    const proofRaw = $("t-proof").value.trim();
    if (proofRaw) {
      try {
        body.proof = JSON.parse(proofRaw);
      } catch {
        flash($("flash-tally"), "err", "Proof JSON is invalid.");
        return;
      }
    }
    try {
      await request("/api/elections/" + encodeURIComponent(id) + "/tally", { method: "POST", body });
      flash($("flash-tally"), "ok", "Tally posted. Sum(counts) must equal accepted ballots.");
      wireExplorerLinks(id);
    } catch (err) {
      flash($("flash-tally"), "err", errText(err));
    }
  });

  $("t-election").addEventListener("change", () => wireExplorerLinks($("t-election").value));

  $("btn-refresh-notices").addEventListener("click", async () => {
    await loadMe();
    await loadNotifications();
  });

  document.querySelectorAll(".local-nav a").forEach((link) => {
    link.addEventListener("click", () => {
      document.querySelectorAll(".local-nav a").forEach((a) => a.classList.remove("active"));
      link.classList.add("active");
    });
  });

  defaultTimes();
  wireBuilder();
  renderBuilder();
  window.addEventListener("republic:session", async () => {
    await loadMe();
    await Promise.all([loadJurisdictions(), loadElections(), loadNotifications()]);
  });
  (async function init() {
    await loadMe();
    await Promise.all([loadJurisdictions(), loadElections(), loadNotifications(), loadReasonCodes()]);
  })();
})();

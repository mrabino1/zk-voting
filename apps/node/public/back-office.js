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

  async function fetchRetry(url, options) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await fetch(url, options);
      if (res.status !== 503 || attempt === 4) return res;
      const retryAfter = Number(res.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(400 * 2 ** attempt, 2000);
      await new Promise((r) => setTimeout(r, delay));
    }
    throw new Error("maintenance handover");
  }

  async function request(path, opts = {}) {
    const headers = { Accept: "application/json", ...(opts.headers || {}) };
    if (opts.body != null) headers["Content-Type"] = "application/json";
    const res = await fetchRetry(path, {
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
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function flash(el, kind, message) {
    el.className = "flash show " + kind;
    el.textContent = message;
  }

  function errText(err) {
    const code = err.data && err.data.code;
    return (
      (err.status ? err.status + " · " : "") +
      (err.message || "Request failed") +
      (code ? " [" + code + "]" : "") +
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

  const ASPECT_TYPES = [
    ["YES_NO", "Yes / No"],
    ["SINGLE_CHOICE", "Single choice"],
    ["MULTI_CHOICE", "Multi choice"],
    ["MEASURE", "Measure"],
    ["ARTICLE", "Article"],
    ["RANKED", "Ranked choice (IRV)"],
  ];

  const DEFAULT_ASPECTS = [
    {
      id: "q-measure",
      type: "YES_NO",
      prompt: "Shall the measure be adopted?",
      description: "",
      maxSelections: 1,
      options: [
        { id: "yes", label: "Yes" },
        { id: "no", label: "No" },
      ],
    },
    {
      id: "q-office",
      type: "SINGLE_CHOICE",
      prompt: "City Council, at-large — choose one.",
      description: "",
      maxSelections: 1,
      options: [
        { id: "cand-a", label: "Alex Rivera" },
        { id: "cand-b", label: "Morgan Chen" },
        { id: "cand-c", label: "Sam Okonkwo" },
      ],
    },
  ];

  let aspectsSyncing = false;

  function slugOpt(value, fallback) {
    const s = String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return s || fallback;
  }

  function readAspectsFromEditor() {
    const cards = [...document.querySelectorAll("#questions-editor .aspect-card")];
    return cards.map((card, i) => {
      const type = card.querySelector(".aspect-type").value;
      const prompt = card.querySelector(".aspect-prompt").value.trim();
      const description = card.querySelector(".aspect-desc").value.trim();
      const maxSelections = Number(card.querySelector(".aspect-maxsel").value || 1);
      const options = [...card.querySelectorAll(".aspect-option")].map((row, j) => {
        const label = row.querySelector(".opt-label").value.trim() || "Option " + (j + 1);
        const id = slugOpt(row.querySelector(".opt-id").value, slugOpt(label, "o" + (j + 1)));
        return { id, label };
      });
      return {
        id: slugOpt(card.querySelector(".aspect-id").value, "q" + (i + 1)),
        type,
        prompt,
        description,
        maxSelections: type === "MULTI_CHOICE" ? maxSelections : type === "RANKED" ? options.length : 1,
        options,
      };
    });
  }

  function writeAspectsJson(questions) {
    aspectsSyncing = true;
    $("e-questions").value = JSON.stringify(questions, null, 2);
    aspectsSyncing = false;
  }

  function optionRowHtml(opt, index) {
    const id = opt && opt.id != null ? opt.id : "o" + (index + 1);
    const label = opt && opt.label != null ? opt.label : typeof opt === "string" ? opt : "";
    return `<li class="aspect-option">
      <input class="opt-id" spellcheck="false" placeholder="id" value="${esc(id)}" aria-label="Option id" />
      <input class="opt-label" placeholder="Label" value="${esc(label)}" aria-label="Option label" />
      <button type="button" class="btn btn-secondary btn-remove-opt" aria-label="Remove option">Remove</button>
    </li>`;
  }

  function aspectCardHtml(q, index) {
    const type = q.type || "YES_NO";
    const options = Array.isArray(q.options) ? q.options : [];
    const typeOpts = ASPECT_TYPES.map(
      ([value, label]) => `<option value="${esc(value)}"${value === type ? " selected" : ""}>${esc(label)}</option>`
    ).join("");
    const maxHidden = type === "MULTI_CHOICE" ? "" : " hidden";
    return `<article class="aspect-card" data-index="${index}">
      <header>
        <h3>Question ${index + 1}</h3>
        <button type="button" class="btn btn-secondary btn-remove-aspect">Remove</button>
      </header>
      <div class="grid-2">
        <div class="field">
          <label class="field-label" for="aq-${index}-type">Type</label>
          <select id="aq-${index}-type" class="aspect-type">${typeOpts}</select>
        </div>
        <div class="field">
          <label class="field-label" for="aq-${index}-id">Id</label>
          <input id="aq-${index}-id" class="aspect-id" spellcheck="false" value="${esc(q.id || "q" + (index + 1))}" />
        </div>
      </div>
      <div class="field aspect-max"${maxHidden}>
        <label class="field-label" for="aq-${index}-max">Max selections</label>
        <input id="aq-${index}-max" class="aspect-maxsel" type="number" min="1" step="1" value="${esc(q.maxSelections || 2)}" />
      </div>
      <div class="field">
        <label class="field-label" for="aq-${index}-prompt">Prompt <span class="req">*</span></label>
        <input id="aq-${index}-prompt" class="aspect-prompt" required maxlength="400" value="${esc(q.prompt || "")}" />
      </div>
      <div class="field">
        <label class="field-label" for="aq-${index}-desc">Description</label>
        <input id="aq-${index}-desc" class="aspect-desc" maxlength="500" value="${esc(q.description || "")}" />
      </div>
      <div class="field">
        <span class="field-label">Options</span>
        <ul class="aspect-options">${options.map((o, j) => optionRowHtml(o, j)).join("")}</ul>
        <button type="button" class="btn btn-secondary btn-add-opt">Add option</button>
      </div>
      ${
        type === "RANKED"
          ? '<p class="field-hint">Voters rank these options. The Node computes IRV after cutoff from accepted ranking envelopes.</p>'
          : ""
      }
    </article>`;
  }

  function renderAspectEditor(questions) {
    const list = Array.isArray(questions) && questions.length ? questions : DEFAULT_ASPECTS;
    $("questions-editor").innerHTML = list.map((q, i) => aspectCardHtml(q, i)).join("");
    writeAspectsJson(list);
  }

  function parseAspectsJson() {
    const parsed = JSON.parse($("e-questions").value);
    if (!Array.isArray(parsed)) throw new Error("Questions must be a JSON array.");
    return parsed.map((q, i) => {
      const options = Array.isArray(q.options)
        ? q.options.map((o, j) =>
            typeof o === "string" || typeof o === "number"
              ? { id: slugOpt(o, "o" + (j + 1)), label: String(o) }
              : { id: String(o.id || "o" + (j + 1)), label: String(o.label || o.name || o.id || "Option") }
          )
        : [
            { id: "yes", label: "Yes" },
            { id: "no", label: "No" },
          ];
      return {
        id: q.id || "q" + (i + 1),
        type: String(q.type || "YES_NO").toUpperCase(),
        prompt: q.prompt || q.title || "",
        description: q.description || "",
        maxSelections: q.maxSelections || 1,
        options,
      };
    });
  }

  function syncEditorFromFields() {
    if (aspectsSyncing) return;
    writeAspectsJson(readAspectsFromEditor());
    document.querySelectorAll("#questions-editor .aspect-card").forEach((card, i) => {
      const heading = card.querySelector("h3");
      if (heading) heading.textContent = "Question " + (i + 1);
      const type = card.querySelector(".aspect-type").value;
      const maxWrap = card.querySelector(".aspect-max");
      if (maxWrap) maxWrap.hidden = type !== "MULTI_CHOICE";
    });
  }

  if ($("questions-editor")) {
    $("questions-editor").addEventListener("click", (event) => {
      const addOpt = event.target.closest(".btn-add-opt");
      if (addOpt) {
        const ul = addOpt.parentElement.querySelector(".aspect-options");
        ul.insertAdjacentHTML("beforeend", optionRowHtml({ id: "", label: "" }, ul.children.length));
        syncEditorFromFields();
        return;
      }
      const rmOpt = event.target.closest(".btn-remove-opt");
      if (rmOpt) {
        const ul = rmOpt.closest(".aspect-options");
        if (ul.querySelectorAll(".aspect-option").length <= 2) return;
        rmOpt.closest(".aspect-option").remove();
        syncEditorFromFields();
        return;
      }
      const rmQ = event.target.closest(".btn-remove-aspect");
      if (rmQ) {
        const cards = document.querySelectorAll("#questions-editor .aspect-card");
        if (cards.length <= 1) return;
        rmQ.closest(".aspect-card").remove();
        syncEditorFromFields();
      }
    });

    $("questions-editor").addEventListener("input", syncEditorFromFields);
    $("questions-editor").addEventListener("change", syncEditorFromFields);

    $("btn-add-question").addEventListener("click", () => {
      const questions = readAspectsFromEditor();
      questions.push({
        id: "q" + (questions.length + 1),
        type: "YES_NO",
        prompt: "",
        description: "",
        maxSelections: 1,
        options: [
          { id: "yes", label: "Yes" },
          { id: "no", label: "No" },
        ],
      });
      renderAspectEditor(questions);
    });

    $("e-questions").addEventListener("change", () => {
      if (aspectsSyncing) return;
      try {
        renderAspectEditor(parseAspectsJson());
      } catch (err) {
        flash($("flash-election"), "err", err.message || "Questions JSON is invalid.");
      }
    });
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
    ["MEASURE", "Measure"],
    ["ARTICLE", "Article"],
    ["RANKED", "Ranked choice (IRV)"],
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
      description: "",
      maxSelections: 1,
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
        description: String(q.description || q.help || ""),
        maxSelections: Number(q.maxSelections ?? q.max ?? (type === "MULTI_CHOICE" ? 2 : 1)) || 1,
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
      const description = String(q.description || "").trim();
      if (description) out.description = description;
      if (out.type === "MULTI_CHOICE") {
        const maxSelections = Number(q.maxSelections || 2);
        out.maxSelections = Number.isInteger(maxSelections) && maxSelections > 0 ? maxSelections : 2;
      } else if (out.type === "RANKED") {
        out.maxSelections = out.options.length;
        out.ballotMethod = "ranked_choice";
      }
      return out;
    });
  }

  let ballotQuestions = hydrateQuestions(DEFAULT_QUESTIONS);
  let editingElectionId = "";
  let storedElectionTitle = "";
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
        description: card.querySelector('[data-f="q-desc"]') ? card.querySelector('[data-f="q-desc"]').value : "",
        maxSelections: card.querySelector('[data-f="q-max"]')
          ? Number(card.querySelector('[data-f="q-max"]').value || 1)
          : 1,
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
      <button class="btn btn-secondary" type="button" data-act="rm-link" data-q="${qi}" data-opt="${oi}" data-link="${li}" ${ballotLocked ? "disabled" : ""} aria-label="Remove link">Remove</button>
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
          <label class="field-label" for="bq-${qi}-o${oi}-label">Name / title</label>
          <input id="bq-${qi}-o${oi}-label" class="builder-mini" data-f="opt-label" ${ballotLocked ? "disabled" : ""} required value="${esc(opt.label || "")}" placeholder="Jane Doe" />
        </div>
        <div class="field">
          <label class="field-label" for="bq-${qi}-o${oi}-id">Option id</label>
          <input id="bq-${qi}-o${oi}-id" class="builder-mini" data-f="opt-id" ${ballotLocked ? "disabled" : ""} value="${esc(opt.id || "")}" placeholder="o1" />
        </div>
      </div>
      <div class="field">
        <label class="field-label" for="bq-${qi}-o${oi}-summary">Short blurb</label>
        <input id="bq-${qi}-o${oi}-summary" class="builder-mini" data-f="opt-summary" ${ballotLocked ? "disabled" : ""} maxlength="500" value="${esc(opt.summary || "")}" placeholder="One-line summary on the voter list" />
      </div>
      <div class="field">
        <label class="field-label" for="bq-${qi}-o${oi}-body">Supporting information</label>
        <textarea id="bq-${qi}-o${oi}-body" class="builder-body" data-f="opt-body" ${ballotLocked ? "disabled" : ""} placeholder="Plain text or light markdown for the mini info page">${esc(opt.body || "")}</textarea>
      </div>
      <div class="field">
        <label class="field-label" for="bq-${qi}-o${oi}-image">Image URL (optional)</label>
        <input id="bq-${qi}-o${oi}-image" class="builder-mini" data-f="opt-image" ${ballotLocked ? "disabled" : ""} value="${esc(opt.imageUrl || "")}" placeholder="https://…" />
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
    const type = q.type || "SINGLE_CHOICE";
    const maxHidden = type === "MULTI_CHOICE" ? "" : " hidden";
    return `<section class="q-card" data-q="${qi}">
      <div class="q-card-head">
        <h3>Question ${qi + 1}</h3>
        <button class="btn btn-secondary" type="button" data-act="rm-q" data-q="${qi}" ${ballotLocked ? "disabled" : ""}>Remove question</button>
      </div>
      <div class="grid-2">
        <div class="field">
          <label class="field-label" for="bq-${qi}-prompt">Prompt</label>
          <input id="bq-${qi}-prompt" class="builder-mini" data-f="q-prompt" ${ballotLocked ? "disabled" : ""} required value="${esc(q.prompt || "")}" placeholder="Office or measure text" />
        </div>
        <div class="field">
          <label class="field-label" for="bq-${qi}-type">Type</label>
          <select id="bq-${qi}-type" class="builder-mini" data-f="q-type" ${ballotLocked ? "disabled" : ""}>${typeOptions(type)}</select>
        </div>
      </div>
      <div class="grid-2">
        <div class="field">
          <label class="field-label" for="bq-${qi}-id">Question id</label>
          <input id="bq-${qi}-id" class="builder-mini" data-f="q-id" ${ballotLocked ? "disabled" : ""} value="${esc(q.id || "")}" placeholder="q1" />
        </div>
        <div class="field aspect-max"${maxHidden}>
          <label class="field-label" for="bq-${qi}-max">Max selections</label>
          <input id="bq-${qi}-max" class="builder-mini" data-f="q-max" type="number" min="1" step="1" ${ballotLocked ? "disabled" : ""} value="${esc(q.maxSelections || 2)}" />
        </div>
      </div>
      <div class="field">
        <label class="field-label" for="bq-${qi}-desc">Description</label>
        <input id="bq-${qi}-desc" class="builder-mini" data-f="q-desc" ${ballotLocked ? "disabled" : ""} maxlength="500" value="${esc(q.description || "")}" placeholder="Voter-facing help text" />
      </div>
      ${
        type === "RANKED"
          ? '<p class="field-hint">Voters rank these options. The Node computes IRV after cutoff from accepted ranking envelopes.</p>'
          : ""
      }
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
    root.addEventListener("change", (event) => {
      if (ballotLocked) return;
      try {
        readBuilderFromDom();
        if (event.target && event.target.getAttribute("data-f") === "q-type") {
          renderBuilder();
        } else {
          setJsonFromBuilder();
        }
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

  function syncElectionDanger() {
    const zone = $("election-danger");
    if (!zone) return;
    const title = storedElectionTitle;
    if (!editingElectionId || !title) {
      zone.hidden = true;
      return;
    }
    zone.hidden = false;
    const current = $("delete-election-current");
    if (current) current.textContent = title;
  }

  function setEditingElection(id, frozen) {
    editingElectionId = id ? String(id) : "";
    ballotLocked = Boolean(frozen);
    renderBuilder();
    syncElectionDanger();
  }

  function openDeleteElectionDialog() {
    const dialog = $("delete-election-dialog");
    const input = $("delete-election-confirm");
    const submit = $("delete-election-submit");
    if (!dialog || !editingElectionId || !storedElectionTitle) return;
    $("delete-election-name").textContent = storedElectionTitle;
    input.value = "";
    submit.disabled = true;
    const flashEl = $("flash-delete-election");
    if (flashEl) flashEl.className = "flash";
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    input.focus();
  }

  function closeDeleteElectionDialog() {
    const dialog = $("delete-election-dialog");
    if (!dialog) return;
    if (typeof dialog.close === "function" && dialog.open) dialog.close();
    else dialog.removeAttribute("open");
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
    if ($("e-method")) {
      $("e-method").value = election.ballotMethod === "ranked_choice" ? "ranked_choice" : "plurality";
    }
    ballotQuestions = hydrateQuestions(election.questions || []);
    storedElectionTitle = String(pick(election, ["title"]) || "");
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
      storedElectionTitle = "";
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
          ballotMethod: $("e-method") ? $("e-method").value || "plurality" : "plurality",
        },
      });
      storedElectionTitle = $("e-title").value.trim();
      syncElectionDanger();
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
    const chain = pick(row, ["onChainElectionId"]);
    const short = pick(row, ["shortCode"]);
    const id = electionIdOf(row);
    const ref = short ? short : String(id).slice(0, 8);
    const nq = pick(row, ["questionCount"]) || (Array.isArray(row.questions) ? row.questions.length : "");
    const qbit = nq ? " · " + nq + " q" : "";
    const chainBit = chain ? " · chain #" + chain : "";
    return title + " · " + ref + chainBit + (state ? " · " + state : "") + qbit;
  }

  function markRole(el, ok) {
    el.className = "pill " + (ok ? "pill-ok" : "pill-warn");
    el.title = ok ? "Granted on this session" : "Not listed on /api/me — the Node still enforces roles";
  }

  function hasOfficerRole(me, name) {
    const user = me && me.user;
    if (!user) return false;
    if (user.role === "platform_admin" || user.role === "platform_super_admin") return true;
    const grants = me.jurisdictionRoles || (me.me && me.me.jurisdictionRoles) || [];
    if (grants.some((g) => g.role === name)) return true;
    const roles = me.roles || [];
    return roles.some((r) => String(r).toLowerCase() === name);
  }

  function clerkJurisdictionIds(me) {
    if (!me || !me.user) return null;
    if (me.user.role === "platform_admin" || me.user.role === "platform_super_admin") return null;
    return new Set(
      (me.jurisdictionRoles || []).filter((g) => g.role === "clerk").map((g) => String(g.jurisdictionId))
    );
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
        const grants = me.jurisdictionRoles || [];
        const offices = grants
          .map((g) => (g.role || "") + "@" + (g.jurisdictionId || ""))
          .filter(Boolean)
          .join(", ");
        $("me-line").textContent =
          user.handle +
          " · " +
          role +
          (offices ? " · " + offices : "") +
          (me.unreadCount ? " · " + me.unreadCount + " unread" : "");
      }
      markRole($("role-clerk"), hasOfficerRole(me, "clerk"));
      markRole($("role-registrar"), hasOfficerRole(me, "registrar"));
      markRole($("role-dq"), hasOfficerRole(me, "disqualification_officer"));
      markRole($("role-tally"), hasOfficerRole(me, "tally_operator"));
      try {
        const cfg = await request("/api/config");
        const banner = $("disclosure-banner");
        const helper = globalThis.ZkVotingDisclosure;
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
        const chainNote = $("chain-election-note");
        if (chainNote && cfg.chain && cfg.chain.note) {
          chainNote.textContent = cfg.chain.note;
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

  async function loadJurisdictions(me) {
    try {
      const data = await getFirst(["/api/jurisdictions", "/api/admin/jurisdictions"]);
      let rows = asList(data, ["jurisdictions", "items"]);
      const clerkIds = clerkJurisdictionIds(me);
      if (clerkIds) rows = rows.filter((row) => clerkIds.has(String(row.id)));
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
      const selects = [$("f-election"), $("r-election"), $("d-election"), $("t-election"), $("rr-election")];
      for (const sel of selects) {
        if (sel) fillSelect(sel, rows, electionIdOf, electionLabel);
      }
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
      await loadRegistrationRequests();
      await loadCredentials();
    } catch (err) {
      for (const id of ["f-election", "r-election", "d-election", "t-election", "rr-election"]) {
        if ($(id)) $(id).innerHTML = `<option value="">${esc(errText(err))}</option>`;
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

  function shortHash(value) {
    const s = String(value || "");
    if (!s) return "—";
    if (s.length <= 22) return s;
    return s.slice(0, 10) + "…" + s.slice(-8);
  }

  function credentialSummary(row) {
    const creds = row.credentials || [];
    if (!creds.length) return "none";
    return creds
      .map((c) => {
        const kind = c.kind === "passport" ? "passport" : c.type === "smart_card" ? "card" : "license";
        return kind + ":" + (c.status || "active");
      })
      .join(", ");
  }

  async function loadRegistrationRequests() {
    const table = $("table-registration-requests");
    if (!table) return;
    const tbody = table.querySelector("tbody");
    const electionId = ($("rr-election") && $("rr-election").value) || ($("r-election") && $("r-election").value);
    if (!electionId) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty">Choose an election.</td></tr>';
      return;
    }
    try {
      const data = await request(
        "/api/elections/" + encodeURIComponent(electionId) + "/registration-requests?status=pending"
      );
      const rows = asList(data, ["requests", "items"]).filter((r) => (r.status || "pending") === "pending");
      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty">No pending requests.</td></tr>';
        return;
      }
      tbody.innerHTML = rows
        .map((row) => {
          const commit = String(row.identityCommitment || "");
          return `<tr>
            <td>${esc(row.handle || row.userId || "—")}</td>
            <td class="hash">${esc(shortHash(commit))}</td>
            <td>${esc(String(row.requestedAt || "").slice(0, 16))}</td>
            <td>${esc(credentialSummary(row))}</td>
            <td>
              <button type="button" class="btn btn-inline" data-approve-request="${esc(row.id)}" data-election="${esc(electionId)}">Approve</button>
              <button type="button" class="btn btn-secondary btn-inline" data-deny-request="${esc(row.id)}" data-election="${esc(electionId)}">Deny</button>
            </td>
          </tr>`;
        })
        .join("");
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty">${esc(errText(err))}</td></tr>`;
    }
  }

  async function loadCredentials() {
    const table = $("table-credentials");
    if (!table) return;
    const tbody = table.querySelector("tbody");
    try {
      const data = await request("/api/office/credentials");
      const rows = asList(data, ["credentials", "items"]);
      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="empty">No smart cards or licenses bound yet.</td></tr>';
        return;
      }
      tbody.innerHTML = rows
        .map((row) => {
          const hash = row.civicIdHash || row.fingerprint || "";
          const typeLabel =
            row.type === "smart_card" ? "smart card" : row.kind === "passport" ? "passport" : "driver’s license";
          return `<tr>
            <td>${esc(row.handle || row.personId || "—")}</td>
            <td>${esc(typeLabel)}</td>
            <td>${esc(row.issuer || "—")}</td>
            <td><span class="pill-status status-${esc(row.status || "active")}">${esc(row.status || "active")}</span></td>
            <td>${esc(row.expiresAt ? String(row.expiresAt).slice(0, 10) : "—")}</td>
            <td class="hash">${esc(hash ? shortHash(hash) : "—")}</td>
            <td>
              ${
                row.status === "revoked"
                  ? "—"
                  : `<button type="button" class="btn btn-secondary btn-inline" data-revoke-cred="${esc(row.id)}" data-person="${esc(row.personId)}">Revoke</button>`
              }
            </td>
          </tr>`;
        })
        .join("");
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="7" class="empty">${esc(errText(err))}</td></tr>`;
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
      tallyScheme: $("e-tally-scheme") ? $("e-tally-scheme").value : "sum_only",
      ballotMethod: $("e-method") ? $("e-method").value || "plurality" : "plurality",
    };
    if (body.tallyScheme === "opens_ballots") {
      body.threshold = Number($("e-threshold") ? $("e-threshold").value : 2);
      body.guardianCount = Number($("e-guardian-count") ? $("e-guardian-count").value : 3);
    }
    try {
      const created = await request("/api/elections", { method: "POST", body });
      const id = pick(created, ["election.id", "id"]) || "";
      const chainMode = pick(created, ["chainMode", "election.chainMode"]);
      const onChainId = pick(created, ["onChainElectionId", "election.onChainElectionId"]);
      const addr = pick(created, ["onChainElectionAddress", "election.onChainElectionAddress"]);
      const tx = pick(created, ["createTxHash", "election.createTxHash"]);
      const short = pick(created, ["election.shortCode", "shortCode"]) || "";
      const bits = ["Created election " + id];
      if (short) bits.push("short /v/" + short);
      if (chainMode === "onchain") {
        bits.push("factory #" + onChainId);
        if (addr) bits.push(addr);
        if (tx) bits.push("tx " + tx);
      } else if (onChainId) {
        bits.push("circuit id " + onChainId + " (JSON demo)");
      }
      flash($("flash-election"), "ok", bits.join(" · ") + ". Freeze the roll before opening.");
      if (id) {
        $("e-load").value = String(id);
        storedElectionTitle = $("e-title").value.trim();
        setEditingElection(id, false);
        $("link-info-preview").hidden = false;
        $("link-info-preview").href = "/elections/" + encodeURIComponent(id) + "/info";
      }
      await loadElections();
    } catch (err) {
      flash($("flash-election"), "err", errText(err));
    }
  });

  if ($("btn-delete-election")) {
    $("btn-delete-election").addEventListener("click", () => openDeleteElectionDialog());
  }
  if ($("delete-election-cancel")) {
    $("delete-election-cancel").addEventListener("click", () => closeDeleteElectionDialog());
  }
  if ($("delete-election-confirm")) {
    $("delete-election-confirm").addEventListener("input", () => {
      const submit = $("delete-election-submit");
      if (submit) submit.disabled = $("delete-election-confirm").value !== storedElectionTitle;
    });
  }
  if ($("form-delete-election")) {
    $("form-delete-election").addEventListener("submit", async (event) => {
      event.preventDefault();
      const id = editingElectionId;
      const confirmTitle = $("delete-election-confirm").value;
      if (!id || confirmTitle !== storedElectionTitle) return;
      try {
        await request("/api/elections/" + encodeURIComponent(id), {
          method: "DELETE",
          body: { confirmTitle },
        });
        closeDeleteElectionDialog();
        storedElectionTitle = "";
        ballotQuestions = hydrateQuestions(DEFAULT_QUESTIONS);
        setEditingElection("", false);
        if ($("e-load")) $("e-load").value = "";
        flash($("flash-election"), "ok", "Deleted election " + id + ".");
        await loadElections();
      } catch (err) {
        flash($("flash-delete-election"), "err", errText(err));
      }
    });
  }

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
      await loadRegistrationRequests();
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
      kind: $("pm-kind") ? $("pm-kind").value || undefined : undefined,
      issuer: $("pm-issuer") ? $("pm-issuer").value.trim() || undefined : undefined,
      documentNumber: $("pm-doc") ? $("pm-doc").value.trim() || undefined : undefined,
      expiresAt: $("pm-exp") ? $("pm-exp").value || undefined : undefined,
    };
    if (fp) {
      if (looksPem) body.certificate = fp;
      else body.fingerprint = fp;
    }
    try {
      await request("/api/persons/" + encodeURIComponent(id) + "/methods", { method: "POST", body });
      flash($("flash-person-method"), "ok", "Authenticator attested to this person. It cannot be bound to a second person.");
      await loadCredentials();
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
    const aspectInputs = document.querySelectorAll("#tally-aspects .tally-count");
    let counts = null;
    try {
      if (aspectInputs.length) {
        counts = [...aspectInputs].map((el) => Number(el.value || 0));
        $("t-counts").value = JSON.stringify(counts);
      } else {
        const raw = $("t-counts").value.trim();
        if (raw) {
          counts = JSON.parse(raw);
          if (!Array.isArray(counts) || counts.some((n) => typeof n !== "number" || !Number.isInteger(n) || n < 0)) {
            throw new Error("Counts must be a JSON array of non-negative integers.");
          }
        }
      }
    } catch (err) {
      flash($("flash-tally"), "err", err.message || "Counts JSON is invalid.");
      return;
    }
    const body = counts && counts.length ? { counts } : {};
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
      const data = await request("/api/elections/" + encodeURIComponent(id) + "/tally", { method: "POST", body });
      const cert = data && data.l1Certification;
      const source = pick(data, ["tally.source", "election.tally.source"]);
      let msg = "Tally posted. Each plurality question is counted on its own options.";
      if (source === "opens_ballots") {
        msg = "Tally posted from guardian partial decryptions (Feldman t-of-n, NON-PRODUCTION). Aggregation is undecided.";
      }
      const winner = pick(data, ["election.tally.questions.0.winnerLabel"]) || pick(data, ["election.tally.questions.0.winner"]);
      const method = pick(data, ["election.tally.ballotMethod"]);
      if (method === "ranked_choice" || method === "mixed") {
        msg =
          "Tally posted. IRV winner: " +
          (winner || "none") +
          ". Round transcript is on the results page.";
      }
      if (cert && cert.status === "skipped") {
        msg += " L1 certification skipped (" + (cert.reason || "L1 env unset") + ").";
      } else if (cert && cert.status === "posted") {
        msg += " Certified on L1. tx=" + (cert.txHash || "");
      } else if (cert && cert.status === "already_posted") {
        msg += " L1 already has this election's hash.";
      } else if (cert && cert.status === "failed") {
        msg += " L1 certification failed: " + (cert.error || "unknown");
      }
      flash($("flash-tally"), cert && cert.status === "failed" ? "err" : "ok", msg);
      wireExplorerLinks(id);
    } catch (err) {
      flash($("flash-tally"), "err", errText(err));
    }
  });

  function isRankedType(type) {
    const t = String(type || "").toUpperCase();
    return t === "RANKED" || t === "RANKED_CHOICE" || t === "IRV";
  }

  function renderTallyAspects(election) {
    const host = $("tally-aspects");
    const hint = $("t-counts-hint");
    if (!host) return;
    if (!election) {
      host.innerHTML = "";
      if (hint) {
        hint.textContent =
          "Concatenated plurality options in ballot order, or pick an election to fill per-question fields.";
      }
      return;
    }
    const questions = election.questions || election.aspects || [];
    const plurality = questions.filter((q) => !isRankedType(q.type));
    const expected = plurality.reduce((n, q) => n + (q.options || []).length, 0);
    if (hint) {
      hint.textContent =
        questions.length +
        " aspect" +
        (questions.length === 1 ? "" : "s") +
        "; plurality vector length " +
        expected +
        ". Each question is counted separately (undervotes allowed). Ranked-choice is computed as IRV from envelopes.";
    }
    if (!questions.length) {
      host.innerHTML = '<p class="field-hint">This election has no published questions.</p>';
      return;
    }
    host.innerHTML = questions
      .map((q, i) => {
        if (isRankedType(q.type)) {
          return `<article class="aspect-card">
            <h3>Question ${i + 1}: ${esc(q.prompt || q.id)}</h3>
            <p class="field-hint">Ranked-choice / IRV is computed from accepted ranking envelopes when you post the tally (leave counts blank on an all-ranked ballot).</p>
          </article>`;
        }
        const opts = (q.options || [])
          .map(
            (o) => `<div class="tally-opt">
              <label class="field-label" for="t-count-${esc(q.id)}-${esc(o.id)}">${esc(o.label || o.id)}</label>
              <input id="t-count-${esc(q.id)}-${esc(o.id)}" class="tally-count" type="number" min="0" step="1" value="0" data-question="${esc(q.id)}" />
            </div>`
          )
          .join("");
        return `<article class="aspect-card">
          <h3>Question ${i + 1}: ${esc(q.prompt || q.id)}</h3>
          <p class="field-hint">${esc(q.type || "SINGLE_CHOICE")} · plurality</p>
          <div class="tally-opts">${opts}</div>
        </article>`;
      })
      .join("");
    $("t-counts").value = JSON.stringify(Array(expected).fill(0));
    if (!plurality.length) $("t-counts").value = "";
  }

  function renderGuardianStatus(ceremony) {
    const host = $("guardian-status");
    if (!host) return;
    if (!ceremony) {
      host.textContent = "This election has no guardian ceremony (sum_only).";
      return;
    }
    const roster = ceremony.roster || [];
    host.textContent =
      "Ceremony " +
      (ceremony.status || "unknown") +
      " · " +
      (ceremony.threshold || "?") +
      "-of-" +
      (ceremony.guardians || "?") +
      " · aggregation " +
      (ceremony.aggregation || "undecided") +
      " · enrolled " +
      roster.length +
      (ceremony.publicKey ? " · joint key ready" : " · joint key not ready");
  }

  async function loadTallyElection(id) {
    if (!id) {
      renderTallyAspects(null);
      renderGuardianStatus(null);
      return;
    }
    try {
      const data = await request("/api/elections/" + encodeURIComponent(id));
      const election = data.election || data;
      renderTallyAspects(election);
      renderGuardianStatus(election.tallyCeremony || null);
    } catch (err) {
      $("tally-aspects").innerHTML = `<p class="field-hint">${esc(errText(err))}</p>`;
    }
  }

  function bindGuardianForm(formId, pathSuffix, readBody, okText) {
    const form = $(formId);
    if (!form) return;
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const id = $("t-election").value;
      if (!id) {
        flash($("flash-tally"), "err", "Choose an election first.");
        return;
      }
      let body;
      try {
        body = readBody();
      } catch (err) {
        flash($("flash-tally"), "err", err.message || "Guardian JSON is invalid.");
        return;
      }
      try {
        await request("/api/elections/" + encodeURIComponent(id) + pathSuffix, { method: "POST", body });
        flash($("flash-tally"), "ok", okText);
        await loadTallyElection(id);
      } catch (err) {
        flash($("flash-tally"), "err", errText(err));
      }
    });
  }

  bindGuardianForm(
    "form-guardian-enroll",
    "/guardians",
    () => ({
      guardianId: $("g-id").value.trim(),
      label: $("g-label").value.trim(),
      transportPublicKey: $("g-transport").value.trim(),
    }),
    "Guardian enrolled."
  );
  bindGuardianForm(
    "form-guardian-deal",
    "/guardians/deals",
    () => JSON.parse($("g-deal").value),
    "Deal stored. The Node keeps encrypted shares only."
  );
  bindGuardianForm(
    "form-guardian-partials",
    "/guardians/partials",
    () => JSON.parse($("g-partials").value),
    "Partial decryptions stored after proof checks."
  );

  $("tally-aspects").addEventListener("input", () => {
    const inputs = [...document.querySelectorAll("#tally-aspects .tally-count")];
    if (inputs.length) $("t-counts").value = JSON.stringify(inputs.map((el) => Number(el.value || 0)));
  });

  $("btn-irv").addEventListener("click", async () => {
    const id = $("t-election").value;
    if (!id) {
      flash($("flash-tally"), "err", "Choose an election first.");
      return;
    }
    try {
      const data = await request("/api/elections/" + encodeURIComponent(id) + "/tally", { method: "POST", body: {} });
      const winner =
        pick(data, ["election.tally.questions.0.winnerLabel"]) || pick(data, ["election.tally.questions.0.winner"]);
      flash(
        $("flash-tally"),
        "ok",
        "IRV computed from accepted ballots. Winner: " + (winner || "none") + "."
      );
      wireExplorerLinks(id);
    } catch (err) {
      flash($("flash-tally"), "err", errText(err));
    }
  });

  $("btn-certify-l1").addEventListener("click", async () => {
    const id = $("t-election").value;
    if (!id) {
      flash($("flash-tally"), "err", "Choose an election first.");
      return;
    }
    try {
      const data = await request("/api/elections/" + encodeURIComponent(id) + "/certify-l1", {
        method: "POST",
        body: {},
      });
      const cert = data && data.l1Certification;
      if (cert && cert.status === "skipped") {
        flash($("flash-tally"), "ok", "L1 no-op: " + (cert.reason || "L1 env unset"));
      } else if (cert && (cert.status === "posted" || cert.status === "already_posted")) {
        flash($("flash-tally"), "ok", "L1 certification " + cert.status + (cert.txHash ? " tx=" + cert.txHash : ""));
      } else {
        flash($("flash-tally"), "err", (cert && (cert.error || cert.reason)) || "L1 certification did not post");
      }
    } catch (err) {
      flash($("flash-tally"), "err", errText(err));
    }
  });

  $("t-election").addEventListener("change", () => {
    const id = $("t-election").value;
    wireExplorerLinks(id);
    loadTallyElection(id);
  });

  $("btn-refresh-notices").addEventListener("click", async () => {
    await loadMe();
    await loadNotifications();
  });

  if ($("rr-election")) {
    $("rr-election").addEventListener("change", () => loadRegistrationRequests());
  }
  if ($("r-election")) {
    $("r-election").addEventListener("change", () => {
      if ($("rr-election") && !$("rr-election").value) {
        $("rr-election").value = $("r-election").value;
      }
      loadRegistrationRequests();
    });
  }
  if ($("btn-refresh-credentials")) {
    $("btn-refresh-credentials").addEventListener("click", () => loadCredentials());
  }

  document.addEventListener("click", async (event) => {
    const approveBtn = event.target.closest("[data-approve-request]");
    if (approveBtn) {
      const electionId = approveBtn.getAttribute("data-election");
      const requestId = approveBtn.getAttribute("data-approve-request");
      try {
        await request(
          "/api/elections/" +
            encodeURIComponent(electionId) +
            "/registration-requests/" +
            encodeURIComponent(requestId) +
            "/approve",
          { method: "POST", body: {} }
        );
        flash($("flash-requests"), "ok", "Approved. The identity commitment is on the roll.");
        await loadRegistrationRequests();
      } catch (err) {
        flash($("flash-requests"), "err", errText(err));
      }
      return;
    }
    const denyBtn = event.target.closest("[data-deny-request]");
    if (denyBtn) {
      const electionId = denyBtn.getAttribute("data-election");
      const requestId = denyBtn.getAttribute("data-deny-request");
      const reason = window.prompt("Reason for denying this registration? (optional)") || "DENIED";
      try {
        await request(
          "/api/elections/" +
            encodeURIComponent(electionId) +
            "/registration-requests/" +
            encodeURIComponent(requestId) +
            "/deny",
          { method: "POST", body: { reason } }
        );
        flash($("flash-requests"), "ok", "Denied. The person is not on the roll.");
        await loadRegistrationRequests();
      } catch (err) {
        flash($("flash-requests"), "err", errText(err));
      }
      return;
    }
    const revokeBtn = event.target.closest("[data-revoke-cred]");
    if (revokeBtn) {
      const personId = revokeBtn.getAttribute("data-person");
      const methodId = revokeBtn.getAttribute("data-revoke-cred");
      const reason = window.prompt("Revoke reason (EXPIRED, SUSPENDED, SUPERSEDED, FRAUD, MANUAL):", "EXPIRED") || "EXPIRED";
      try {
        await request(
          "/api/persons/" + encodeURIComponent(personId) + "/methods/" + encodeURIComponent(methodId) + "/revoke",
          { method: "POST", body: { reason } }
        );
        flash($("flash-credentials"), "ok", "Credential revoked. It can no longer be used to sign in.");
        await loadCredentials();
      } catch (err) {
        flash($("flash-credentials"), "err", errText(err));
      }
    }
  });

  function initTokenPolls(me) {
    const role = me && me.user && me.user.role;
    const superAdmin = role === "platform_super_admin";
    const canTally =
      superAdmin ||
      role === "platform_admin" ||
      role === "tally_operator" ||
      hasOfficerRole(me, "tally_operator");
    const work = document.getElementById("office-work");
    const nav = document.querySelector(".local-nav");
    if (!work || !nav) return;
    Promise.all([
      fetch("/api/config", { credentials: "same-origin", headers: { Accept: "application/json" } }).then((res) =>
        res.ok ? res.json() : null
      ),
      import("/i18n.js"),
    ])
      .then(([cfg, i18n]) => {
        if (!cfg || !cfg.pollsEnabled) return;
        if (!superAdmin && !canTally) return;
        const t = i18n.t;
        const link = document.createElement("a");
        link.href = "#token-polls";
        link.textContent = "Token polls";
        nav.append(link);
        const section = document.createElement("section");
        section.className = "panel";
        section.id = "token-polls";
        section.setAttribute("aria-labelledby", "token-polls-heading");
        const ready = Boolean(cfg.pollsReady && cfg.votingToken && cfg.votingToken.configured);
        section.innerHTML =
          '<header><h2 id="token-polls-heading">Token polls</h2></header>' +
          '<p class="poll-signal" role="note">Signal only · non-binding · NOT FOR PROFIT</p>' +
          '<p class="field-hint">ERC-20 balance-weighted signal polls. Holding the token is the only credential. Tokens in staking or liquidity-pool contracts cannot vote unless that contract signs. Official results publish after close. There is no live provisional tally. Balances are read on Ethereum. No transaction is sent.</p>' +
          (ready
            ? '<p class="field-hint" id="poll-token-host"></p>' +
              '<div id="token-poll-create"></div>' +
              '<div id="token-poll-list"><p class="empty">Loading…</p></div>'
            : '<p class="notice notice-error" id="poll-token-disabled" role="alert"></p>') +
          '<div class="flash" id="flash-polls" role="status"></div>';
        work.append(section);
        if (!ready) {
          const note = document.getElementById("poll-token-disabled");
          if (note) note.textContent = t("polls.disabled");
          return;
        }
        const host = document.getElementById("poll-token-host");
        if (host) {
          host.textContent = t("polls.tokenHost", {
            token: cfg.votingToken.address,
            chain: String(cfg.votingToken.chainId),
          });
        }
        if (superAdmin) mountPollCreate();
        loadPollAdminList(superAdmin, canTally);
      })
      .catch(() => {});
  }

  function mountPollCreate() {
    const host = $("token-poll-create");
    if (!host) return;
    host.innerHTML =
      '<form id="form-token-poll" class="form-grid">' +
      '<div class="field"><label class="field-label" for="p-jurisdiction">Jurisdiction</label><select id="p-jurisdiction"></select></div>' +
      '<div class="field"><label class="field-label" for="p-title">Title</label><input id="p-title" maxlength="200" /></div>' +
      '<div class="field"><label class="field-label" for="p-type">Type</label><select id="p-type"><option value="plurality">Plurality</option><option value="ranked_irv">Ranked choice (IRV)</option></select></div>' +
      '<div class="grid-2"><div class="field"><label class="field-label" for="p-start">Start</label><input id="p-start" type="datetime-local" /></div>' +
      '<div class="field"><label class="field-label" for="p-cutoff">Cutoff</label><input id="p-cutoff" type="datetime-local" /></div></div>' +
      '<div class="field"><label class="field-label" for="p-options">Options (one label per line, at least two). Abstain is added.</label><textarea id="p-options" rows="4">Yes\nNo</textarea></div>' +
      '<div class="field"><label class="field-label" for="p-min">Minimum weight (base units)</label><input id="p-min" value="1" /></div>' +
      '<div class="field"><label class="field-label" for="p-id">Existing draft id (blank creates a new poll)</label><input id="p-id" spellcheck="false" /></div>' +
      '<p class="field-hint">Quorum and pass threshold default to none. Edit is available while the poll is still a draft or scheduled.</p>' +
      '<div class="actions"><button class="btn" type="submit">Create poll</button></div>' +
      '<pre id="p-preflight" class="field-hint"></pre>' +
      "</form>";
    const src = $("e-jurisdiction");
    const jurisdiction = $("p-jurisdiction");
    if (src && jurisdiction) {
      jurisdiction.innerHTML = src.innerHTML;
      const real = [...jurisdiction.options].find((option) => option.value);
      if (real) jurisdiction.value = real.value;
    }
    const start = new Date(Date.now() + 60 * 1000);
    const cutoff = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const iso = (d) => {
      const pad = (n) => String(n).padStart(2, "0");
      return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
    };
    $("p-start").value = iso(start);
    $("p-cutoff").value = iso(cutoff);
    $("form-token-poll").addEventListener("submit", async (event) => {
      event.preventDefault();
      const missing = [];
      if (!$("p-jurisdiction").value) missing.push("jurisdiction");
      if (!$("p-title").value.trim()) missing.push("title");
      if (!$("p-start").value || !$("p-cutoff").value) missing.push("start and cutoff");
      if (missing.length) {
        flash($("flash-polls"), "err", "Fill " + missing.join(", ") + " before creating the poll.");
        return;
      }
      const options = $("p-options")
        .value.split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      try {
        const body = {
          jurisdictionId: $("p-jurisdiction").value,
          title: $("p-title").value.trim(),
          pollType: $("p-type").value,
          startTime: toUnix($("p-start").value),
          cutoffTime: toUnix($("p-cutoff").value),
          options,
          minBallotWeight: $("p-min").value.trim() || "1",
          privacyMode: "public_weighted",
        };
        const existing = $("p-id").value.trim();
        const created = existing
          ? { poll: await request("/api/polls/" + encodeURIComponent(existing), { method: "PATCH", body }) }
          : await request("/api/polls", { method: "POST", body });
        const warnings = (created.preflight && created.preflight.warnings) || [];
        $("p-preflight").textContent =
          (created.poll ? created.poll.id + " · " + (created.preflight && created.preflight.symbol) : "Created") +
          (warnings.length ? "\n" + warnings.join("\n") : "");
        flash($("flash-polls"), "ok", "Draft created. Schedule it when the window is right.");
        await loadPollAdminList(true, true);
      } catch (err) {
        flash($("flash-polls"), "err", errText(err));
      }
    });
  }

  async function loadPollAdminList(superAdmin, canTally) {
    const host = $("token-poll-list");
    if (!host) return;
    try {
      const data = await request("/api/polls");
      const polls = (data && data.polls) || [];
      host.replaceChildren();
      if (!polls.length) {
        const empty = document.createElement("p");
        empty.textContent = "No token polls yet.";
        host.append(empty);
        return;
      }
      for (const poll of polls) {
        const article = document.createElement("article");
        article.className = "election-card";
        const title = document.createElement("h3");
        title.textContent = poll.title + " · " + poll.state;
        const meta = document.createElement("p");
        meta.textContent = (poll.tokenSymbol || "") + " " + poll.token + " · chain " + poll.tokenChainId;
        article.append(title, meta);
        if (superAdmin && (poll.state === "DRAFT" || poll.state === "SCHEDULED")) {
          const schedule = document.createElement("button");
          schedule.type = "button";
          schedule.className = "btn";
          schedule.textContent = "Schedule";
          schedule.addEventListener("click", async () => {
            try {
              await request("/api/polls/" + encodeURIComponent(poll.id) + "/schedule", { method: "POST", body: {} });
              flash($("flash-polls"), "ok", "Scheduled.");
              await loadPollAdminList(superAdmin, canTally);
            } catch (err) {
              flash($("flash-polls"), "err", errText(err));
            }
          });
          article.append(schedule);
        }
        if (canTally && (poll.state === "CLOSED" || poll.state === "TALLYING" || poll.state === "TALLIED")) {
          const tally = document.createElement("button");
          tally.type = "button";
          tally.className = "btn btn-secondary";
          tally.textContent = poll.state === "TALLIED" ? "View tally" : "Tally";
          tally.addEventListener("click", async () => {
            try {
              const result = await request("/api/polls/" + encodeURIComponent(poll.id) + "/tally", { method: "POST", body: {} });
              flash($("flash-polls"), "ok", "Outcome " + (result.outcome || "") + ". Signal only.");
              await loadPollAdminList(superAdmin, canTally);
            } catch (err) {
              flash($("flash-polls"), "err", errText(err));
            }
          });
          article.append(tally);
        }
        const view = document.createElement("a");
        view.href = "/polls/" + encodeURIComponent(poll.id);
        view.textContent = "Open";
        article.append(view);
        host.append(article);
      }
    } catch (err) {
      host.textContent = errText(err);
    }
  }

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
    const me = await loadMe();
    await Promise.all([loadJurisdictions(me), loadElections(), loadNotifications()]);
  });
  (async function init() {
    const me = await loadMe();
    await Promise.all([loadJurisdictions(me), loadElections(), loadNotifications(), loadReasonCodes()]);
    if ($("t-election").value) await loadTallyElection($("t-election").value);
    initTokenPolls(me);
  })();
})();

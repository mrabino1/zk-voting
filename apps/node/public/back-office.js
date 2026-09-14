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

  const ASPECT_TYPES = [
    ["YES_NO", "Yes / No"],
    ["SINGLE_CHOICE", "Single choice"],
    ["MULTI_CHOICE", "Multi choice"],
    ["MEASURE", "Measure"],
    ["ARTICLE", "Article"],
    ["RANKED", "Ranked choice (stored; IRV not tallied)"],
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
      <button type="button" class="btn btn-secondary btn-remove-opt">Remove</button>
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
          <label class="field-label">Type</label>
          <select class="aspect-type">${typeOpts}</select>
        </div>
        <div class="field">
          <label class="field-label">Id</label>
          <input class="aspect-id" spellcheck="false" value="${esc(q.id || "q" + (index + 1))}" />
        </div>
      </div>
      <div class="field aspect-max"${maxHidden}>
        <label class="field-label">Max selections</label>
        <input class="aspect-maxsel" type="number" min="1" step="1" value="${esc(q.maxSelections || 2)}" />
      </div>
      <div class="field">
        <label class="field-label">Prompt <span class="req">*</span></label>
        <input class="aspect-prompt" required maxlength="400" value="${esc(q.prompt || "")}" />
      </div>
      <div class="field">
        <label class="field-label">Description</label>
        <input class="aspect-desc" maxlength="500" value="${esc(q.description || "")}" />
      </div>
      <div class="field">
        <span class="field-label">Options</span>
        <ul class="aspect-options">${options.map((o, j) => optionRowHtml(o, j)).join("")}</ul>
        <button type="button" class="btn btn-secondary btn-add-opt">Add option</button>
      </div>
      ${
        type === "RANKED"
          ? '<p class="field-hint">Ranked-choice rankings can be sealed in the envelope. This Node does not compute IRV.</p>'
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

  function electionIdOf(row) {
    return pick(row, ["id", "electionId"]);
  }

  function electionLabel(row) {
    const title = pick(row, ["title", "name", "stateName"]) || "Election";
    const state = pick(row, ["stateName"]) || "";
    const nq = pick(row, ["questionCount"]) || (Array.isArray(row.questions) ? row.questions.length : "");
    const qbit = nq ? " · " + nq + " q" : "";
    return title + " · #" + electionIdOf(row) + (state ? " · " + state : "") + qbit;
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
        if (banner && cfg.disclosure && cfg.disclosure.note) {
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
      questions = readAspectsFromEditor();
      if (!questions.length) throw new Error("Add at least one question.");
      if (questions.some((q) => !q.prompt)) throw new Error("Every question needs a prompt.");
      if (questions.some((q) => !q.options || q.options.length < 2)) {
        throw new Error("Every question needs at least two options.");
      }
      writeAspectsJson(questions);
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
    const aspectInputs = document.querySelectorAll("#tally-aspects .tally-count");
    let counts;
    try {
      if (aspectInputs.length) {
        counts = [...aspectInputs].map((el) => Number(el.value || 0));
        $("t-counts").value = JSON.stringify(counts);
      } else {
        counts = JSON.parse($("t-counts").value);
      }
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
      flash($("flash-tally"), "ok", "Tally posted. Each plurality question is counted on its own options.");
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
        ". Each question is counted separately (undervotes allowed). Ranked-choice is skipped.";
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
            <p class="field-hint">Ranked-choice / IRV is not tallied on this Node path.</p>
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
  }

  async function loadTallyElection(id) {
    if (!id) {
      renderTallyAspects(null);
      return;
    }
    try {
      const data = await request("/api/elections/" + encodeURIComponent(id));
      renderTallyAspects(data.election || data);
    } catch (err) {
      $("tally-aspects").innerHTML = `<p class="field-hint">${esc(errText(err))}</p>`;
    }
  }

  $("tally-aspects").addEventListener("input", () => {
    const inputs = [...document.querySelectorAll("#tally-aspects .tally-count")];
    if (inputs.length) $("t-counts").value = JSON.stringify(inputs.map((el) => Number(el.value || 0)));
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

  document.querySelectorAll(".local-nav a").forEach((link) => {
    link.addEventListener("click", () => {
      document.querySelectorAll(".local-nav a").forEach((a) => a.classList.remove("active"));
      link.classList.add("active");
    });
  });

  defaultTimes();
  renderAspectEditor(DEFAULT_ASPECTS);
  (async function init() {
    await loadMe();
    await Promise.all([loadJurisdictions(), loadElections(), loadNotifications(), loadReasonCodes()]);
    if ($("t-election").value) await loadTallyElection($("t-election").value);
  })();
})();

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
      questions = JSON.parse($("e-questions").value);
      if (!Array.isArray(questions)) throw new Error("Questions must be a JSON array.");
    } catch (err) {
      flash($("flash-election"), "err", err.message || "Questions JSON is invalid.");
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
  (async function init() {
    await loadMe();
    await Promise.all([loadJurisdictions(), loadElections(), loadNotifications(), loadReasonCodes()]);
  })();
})();

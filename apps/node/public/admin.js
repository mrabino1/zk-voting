/* Platform admin — jurisdictions, officer grants, host status. No fee controls. */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

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

  function flattenFacts(node, acc, prefix) {
    if (node == null) return acc;
    if (typeof node !== "object") {
      acc.push({ name: prefix || "value", value: String(node) });
      return acc;
    }
    if (Array.isArray(node)) {
      acc.push({ name: prefix || "list", value: node.map(String).join(", ") });
      return acc;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "raw") continue;
      const next = prefix ? prefix + "." + key : key;
      if (value && typeof value === "object" && !Array.isArray(value)) flattenFacts(value, acc, next);
      else if (Array.isArray(value)) acc.push({ name: next, value: value.map(String).join(", ") });
      else acc.push({ name: next, value: String(value) });
    }
    return acc;
  }

  function renderFacts(host) {
    const skip = new Set(["ok", "nfp"]);
    const rows = flattenFacts(host, [], "").filter((r) => !skip.has(r.name));
    const tbody = $("table-addresses").querySelector("tbody");
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="2" class="empty">No extra host facts.</td></tr>';
      return;
    }
    tbody.innerHTML = rows
      .map(
        (row) =>
          `<tr><td>${esc(row.name)}</td><td class="hash">${esc(row.value)} ${
            /^0x[0-9a-fA-F]{40}$/.test(row.value)
              ? `<button type="button" class="copy" data-copy="${esc(row.value)}">Copy</button>`
              : ""
          }</td></tr>`
      )
      .join("");
  }

  async function loadHealth() {
    const healthEl = $("stat-health");
    try {
      const health = await getFirst(["/health", "/api/health"]);
      let config = {};
      try {
        config = await request("/api/config");
      } catch {
        config = {};
      }
      const merged = { ...config, ...health };
      const ok = pick(merged, ["ok"]) !== false && pick(merged, ["status"]) !== "down";
      const chainId = pick(merged, ["chainId", "chain_id"]);
      const factory = pick(merged, [
        "electionFactoryAddress",
        "factoryAddress",
        "factory",
        "addresses.factory",
        "contracts.ElectionFactory",
        "contracts.factory",
      ]);
      const nfp = pick(merged, ["nfp", "notForProfit"]) !== false;
      healthEl.innerHTML = ok
        ? '<span class="status-dot on"></span>OK'
        : '<span class="status-dot off"></span>Unhealthy';
      $("stat-chain").textContent = chainId != null ? String(chainId) : "—";
      $("stat-factory").innerHTML = factory
        ? `<span class="hash">${esc(factory)}</span> <button type="button" class="copy" data-copy="${esc(factory)}">Copy</button>`
        : "—";
      $("stat-nfp").textContent = nfp ? "Yes" : "Host did not label itself NOT FOR PROFIT";
      const banner = $("disclosure-banner");
      const helper = globalThis.RepublicDisclosure;
      if (banner && merged.disclosure && helper) {
        helper.paint(banner, merged.disclosure);
      } else if (banner && merged.disclosure && merged.disclosure.note) {
        const next = merged.disclosure.nextPublishAt;
        const when =
          next != null
            ? new Date(Number(next) * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC")
            : "";
        banner.textContent = merged.disclosure.note + (when ? " Next publish: " + when + "." : "");
      }
      renderFacts(merged);
    } catch (err) {
      healthEl.innerHTML = '<span class="status-dot off"></span>Unreachable';
      $("stat-chain").textContent = "—";
      $("stat-factory").textContent = "—";
      $("stat-nfp").textContent = errText(err);
    }
  }

  async function loadMe() {
    try {
      const me = await request("/api/me");
      const user = me.user;
      if (!user) {
        $("session-line").textContent = "Not signed in. Super admin approves admins; admins approve election staff.";
        return me;
      }
      if ($("me-email") && me.me && me.me.contactEmail && !$("me-email").value) {
        $("me-email").value = me.me.contactEmail;
      }
      const grants = me.jurisdictionRoles || [];
      const offices = grants
        .map((g) => (g.role || "") + "@" + (g.jurisdictionId || ""))
        .filter(Boolean)
        .join(", ");
      $("session-line").textContent =
        user.handle +
        " · " +
        user.role +
        (offices ? " · " + offices : "") +
        (me.unreadCount ? " · " + me.unreadCount + " unread" : "");
      return me;
    } catch (err) {
      $("session-line").textContent = errText(err);
      return null;
    }
  }

  function formatOfficers(row) {
    const officers = Array.isArray(row.officers) ? row.officers : [];
    if (!officers.length) return "—";
    return officers
      .map((o) => (o.handle || o.address || o.userId || "?") + ": " + (o.role || "?"))
      .join("; ");
  }

  function formatUserOffices(row) {
    const grants = Array.isArray(row.jurisdictionRoles) ? row.jurisdictionRoles : [];
    if (!grants.length) return "—";
    return grants.map((g) => (g.jurisdictionId || "?") + ": " + (g.role || "?")).join("; ");
  }

  function renderJurisdictions(rows) {
    const tbody = $("table-jurisdictions").querySelector("tbody");
    const select = $("g-jurisdiction");
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty">No jurisdictions yet.</td></tr>';
      if (select) select.innerHTML = '<option value="">None loaded</option>';
      renderOfficers([]);
      return;
    }
    tbody.innerHTML = rows
      .map((row) => {
        return `<tr>
          <td>${esc(row.name || "Untitled")}</td>
          <td class="hash">${esc(row.id)}</td>
          <td>${esc(formatOfficers(row))}</td>
          <td class="hash">${esc(row.metadataURI || "—")}</td>
          <td>${esc(row.createdAt || "—")}</td>
        </tr>`;
      })
      .join("");
    if (select) {
      const current = select.value;
      select.innerHTML =
        '<option value="">Select…</option>' +
        rows
          .map((row) => `<option value="${esc(row.id)}">${esc(row.name || row.id)} · ${esc(row.id)}</option>`)
          .join("");
      if (current && [...select.options].some((o) => o.value === current)) select.value = current;
    }
    renderOfficers(rows);
  }

  function renderOfficers(rows) {
    const table = $("table-officers");
    if (!table) return;
    const tbody = table.querySelector("tbody");
    const grants = [];
    for (const row of rows) {
      for (const grant of row.officers || []) {
        grants.push({
          jurisdictionId: row.id,
          jurisdictionName: row.name || row.id,
          handle: grant.handle || "",
          userId: grant.userId || "",
          address: grant.address || "",
          role: grant.role || "",
          grantedAt: grant.grantedAt || "",
        });
      }
    }
    if (!grants.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty">No jurisdiction officers yet.</td></tr>';
      return;
    }
    tbody.innerHTML = grants
      .map(
        (g) => `<tr>
          <td>${esc(g.jurisdictionName)} <span class="hash">${esc(g.jurisdictionId)}</span></td>
          <td>${esc(g.handle || g.address || g.userId || "—")}</td>
          <td>${esc(g.role)}</td>
          <td>${esc(g.grantedAt || "—")}</td>
          <td>
            <button
              type="button"
              class="btn btn-secondary btn-inline"
              data-revoke="1"
              data-jurisdiction="${esc(g.jurisdictionId)}"
              data-role="${esc(g.role)}"
              data-handle="${esc(g.handle)}"
              data-userid="${esc(g.userId)}"
              data-address="${esc(g.address)}"
            >Revoke</button>
          </td>
        </tr>`
      )
      .join("");
  }

  async function loadJurisdictions() {
    try {
      const data = await getFirst(["/api/jurisdictions", "/api/admin/jurisdictions"]);
      renderJurisdictions(asList(data, ["jurisdictions", "items"]));
    } catch (err) {
      $("table-jurisdictions").querySelector("tbody").innerHTML =
        `<tr><td colspan="5" class="empty">${esc(errText(err))}</td></tr>`;
      const officersBody = $("table-officers") && $("table-officers").querySelector("tbody");
      if (officersBody) {
        officersBody.innerHTML = `<tr><td colspan="5" class="empty">${esc(errText(err))}</td></tr>`;
      }
    }
  }

  function renderUsers(rows) {
    const tbody = $("table-users").querySelector("tbody");
    const select = $("g-user");
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty">No users (or not authorized).</td></tr>';
      select.innerHTML = '<option value="">None loaded</option>';
      return;
    }
    tbody.innerHTML = rows
      .map(
        (row) =>
          `<tr><td>${esc(row.handle)}</td><td>${esc(row.role)}</td><td>${esc(formatUserOffices(row))}</td><td>${row.hasContactEmail ? "yes" : "—"}</td><td>${esc(String(row.authMethodCount ?? 0))}</td><td class="hash">${esc(row.activeEthAddress || "—")}</td><td>${row.personKeyBound ? "bound" : "—"}</td><td class="hash">${esc(row.id)}</td></tr>`
      )
      .join("");
    select.innerHTML =
      '<option value="">Select…</option>' +
      rows
        .map((row) => `<option value="${esc(row.id)}" data-handle="${esc(row.handle)}">${esc(row.handle)} · ${esc(row.role)}</option>`)
        .join("");
  }

  async function loadUsers() {
    try {
      const data = await getFirst(["/api/users", "/api/admin/users"]);
      renderUsers(asList(data, ["users", "items"]));
      renderAdminPicker(asList(data, ["users", "items"]));
    } catch (err) {
      const msg =
        err.status === 401 || err.status === 403
          ? "Sign in as platform_super_admin or platform_admin to list users and grant officers."
          : errText(err);
      $("table-users").querySelector("tbody").innerHTML =
        `<tr><td colspan="8" class="empty">${esc(msg)}</td></tr>`;
      $("g-user").innerHTML = `<option value="">${esc(msg)}</option>`;
      if ($("a-user")) $("a-user").innerHTML = `<option value="">${esc(msg)}</option>`;
    }
  }

  function renderAdminPicker(rows) {
    const select = $("a-user");
    if (!select) return;
    const eligible = rows.filter(
      (row) => row.role !== "platform_admin" && row.role !== "platform_super_admin"
    );
    if (!eligible.length) {
      select.innerHTML = '<option value="">No voters to elevate</option>';
      return;
    }
    select.innerHTML =
      '<option value="">Select…</option>' +
      eligible
        .map(
          (row) =>
            `<option value="${esc(row.id)}" data-handle="${esc(row.handle)}">${esc(row.handle)} · ${esc(row.role)}</option>`
        )
        .join("");
  }

  function renderAdmins(rows) {
    const table = $("table-admins");
    if (!table) return;
    const tbody = table.querySelector("tbody");
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty">No platform admins yet.</td></tr>';
      return;
    }
    tbody.innerHTML = rows
      .map((row) => {
        const canRevoke = row.role === "platform_admin";
        return `<tr>
          <td>${esc(row.handle)}</td>
          <td>${esc(row.role)}</td>
          <td class="hash">${esc(row.id)}</td>
          <td>${
            canRevoke
              ? `<button type="button" class="btn btn-secondary btn-inline" data-revoke-admin="1" data-userid="${esc(row.id)}" data-handle="${esc(row.handle)}">Revoke</button>`
              : "—"
          }</td>
        </tr>`;
      })
      .join("");
  }

  async function loadAdmins() {
    const table = $("table-admins");
    if (!table) return;
    try {
      const data = await getFirst(["/api/admin/admins"]);
      renderAdmins(asList(data, ["admins", "users"]));
    } catch (err) {
      const msg =
        err.status === 401 || err.status === 403
          ? "Sign in as a platform operator to list admins."
          : errText(err);
      table.querySelector("tbody").innerHTML =
        `<tr><td colspan="4" class="empty">${esc(msg)}</td></tr>`;
    }
  }

  $("form-jurisdiction").addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = {
      name: $("j-name").value.trim(),
      id: $("j-code").value.trim() || undefined,
      metadataURI: $("j-uri").value.trim() || undefined,
    };
    try {
      const created = await request("/api/jurisdictions", { method: "POST", body });
      const name = pick(created, ["jurisdiction.name", "name"]) || body.name;
      flash($("flash-jurisdiction"), "ok", "Created " + name);
      event.target.reset();
      await loadJurisdictions();
      await loadUsers();
    } catch (err) {
      flash($("flash-jurisdiction"), "err", errText(err));
    }
  });

  $("form-grant").addEventListener("submit", async (event) => {
    event.preventDefault();
    const userId = $("g-user").value.trim();
    const role = $("g-role").value;
    const jurisdictionId = $("g-jurisdiction").value.trim();
    if (!userId) {
      flash($("flash-grant"), "err", "Choose a user.");
      return;
    }
    if (!jurisdictionId) {
      flash($("flash-grant"), "err", "Choose a jurisdiction.");
      return;
    }
    const selected = $("g-user").selectedOptions[0];
    const handle = (selected && selected.getAttribute("data-handle")) || "";
    const body = { userId, handle, role, jurisdictionId };
    const email = $("g-email") && $("g-email").value.trim();
    if (email) body.contactEmail = email;
    try {
      let granted = null;
      try {
        granted = await request("/api/jurisdictions/" + encodeURIComponent(jurisdictionId) + "/roles", {
          method: "POST",
          body,
        });
      } catch (err) {
        if (!retryable(err)) throw err;
        try {
          granted = await request("/api/admin/roles", { method: "POST", body });
        } catch (err2) {
          if (!retryable(err2)) throw err2;
          granted = await request("/api/admin/grant", { method: "POST", body });
        }
      }
      const who = pick(granted, ["grant.handle", "user.handle"]) || handle || userId;
      const mailStatus = pick(granted, ["mail.mail.status", "mail.status"]);
      const mailNote = mailStatus
        ? " · mail " + mailStatus
        : pick(granted, ["mail.reason"])
          ? " · mail " + pick(granted, ["mail.reason"])
          : "";
      flash($("flash-grant"), "ok", "Granted " + role + " on " + jurisdictionId + " to " + who + mailNote);
      await Promise.all([loadUsers(), loadJurisdictions(), loadOutbox()]);
    } catch (err) {
      flash($("flash-grant"), "err", errText(err));
    }
  });

  window.addEventListener("republic:session", () => {
    Promise.all([loadMe(), loadUsers(), loadJurisdictions(), loadAdmins(), loadMailTemplates(), loadOutbox()]);
  });

  const formAdmin = $("form-admin");
  if (formAdmin) {
    formAdmin.addEventListener("submit", async (event) => {
      event.preventDefault();
      const userId = $("a-user").value.trim();
      if (!userId) {
        flash($("flash-admin"), "err", "Choose a user.");
        return;
      }
      const selected = $("a-user").selectedOptions[0];
      const handle = (selected && selected.getAttribute("data-handle")) || "";
      try {
        const approved = await request("/api/admin/admins", {
          method: "POST",
          body: {
            userId,
            handle,
            ...( $("a-email") && $("a-email").value.trim()
              ? { contactEmail: $("a-email").value.trim() }
              : {}),
          },
        });
        const who = pick(approved, ["user.handle"]) || handle || userId;
        const mailStatus = pick(approved, ["mail.mail.status", "mail.status"]);
        flash(
          $("flash-admin"),
          "ok",
          "Approved " + who + " as platform_admin" + (mailStatus ? " · mail " + mailStatus : "")
        );
        await Promise.all([loadUsers(), loadAdmins(), loadOutbox()]);
      } catch (err) {
        flash($("flash-admin"), "err", errText(err));
      }
    });
  }

  document.addEventListener("click", async (event) => {
    const revokeAdmin = event.target.closest("[data-revoke-admin]");
    if (revokeAdmin) {
      try {
        await request("/api/admin/admins", {
          method: "DELETE",
          body: {
            userId: revokeAdmin.getAttribute("data-userid") || "",
            handle: revokeAdmin.getAttribute("data-handle") || "",
          },
        });
        flash($("flash-admin"), "ok", "Revoked platform_admin");
        await Promise.all([loadUsers(), loadAdmins()]);
      } catch (err) {
        flash($("flash-admin"), "err", errText(err));
      }
      return;
    }
    const revokeBtn = event.target.closest("[data-revoke]");
    if (revokeBtn) {
      const jurisdictionId = revokeBtn.getAttribute("data-jurisdiction") || "";
      const role = revokeBtn.getAttribute("data-role") || "";
      const handle = revokeBtn.getAttribute("data-handle") || "";
      const userId = revokeBtn.getAttribute("data-userid") || "";
      const address = revokeBtn.getAttribute("data-address") || "";
      const flashEl = $("flash-officers") || $("flash-grant");
      try {
        await request("/api/jurisdictions/" + encodeURIComponent(jurisdictionId) + "/roles", {
          method: "DELETE",
          body: { jurisdictionId, role, handle, userId, address },
        });
        flash(flashEl, "ok", "Revoked " + role + " on " + jurisdictionId);
        await Promise.all([loadUsers(), loadJurisdictions()]);
      } catch (err) {
        flash(flashEl, "err", errText(err));
      }
      return;
    }
    const btn = event.target.closest("[data-copy]");
    if (!btn) return;
    try {
      await navigator.clipboard.writeText(btn.getAttribute("data-copy"));
      btn.textContent = "Copied";
      setTimeout(() => {
        btn.textContent = "Copy";
      }, 1200);
    } catch {
      btn.textContent = "Failed";
    }
  });

  function renderOutbox(rows) {
    const table = $("table-outbox");
    if (!table) return;
    const tbody = table.querySelector("tbody");
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty">No promotion mail yet.</td></tr>';
      return;
    }
    tbody.innerHTML = rows
      .map(
        (row) => `<tr>
          <td>${esc(row.createdAt || "—")}</td>
          <td>${esc(row.role || "—")}</td>
          <td>${esc(row.to || "—")}</td>
          <td>${esc(row.status || "—")}</td>
          <td>${esc(row.subject || "—")}</td>
        </tr>`
      )
      .join("");
  }

  async function loadOutbox() {
    const table = $("table-outbox");
    if (!table) return;
    try {
      const data = await request("/api/mail/outbox");
      renderOutbox(asList(data, ["outbox", "items"]));
    } catch (err) {
      const msg =
        err.status === 401 || err.status === 403
          ? "Sign in as a platform operator to read the mail outbox."
          : errText(err);
      table.querySelector("tbody").innerHTML =
        `<tr><td colspan="5" class="empty">${esc(msg)}</td></tr>`;
    }
  }

  async function loadMailTemplates() {
    const select = $("mail-template");
    if (!select) return;
    try {
      const data = await request("/api/mail/templates");
      const rows = asList(data, ["templates", "items"]);
      if (!rows.length) {
        select.innerHTML = '<option value="">No templates</option>';
        return;
      }
      select.innerHTML = rows
        .map(
          (row) =>
            `<option value="${esc(row.id)}">${esc(row.label || row.role)} — ${esc(row.headline || row.subject || row.id)}</option>`
        )
        .join("");
    } catch (err) {
      select.innerHTML = `<option value="">${esc(errText(err))}</option>`;
    }
  }

  const formMail = $("form-mail-preview");
  if (formMail) {
    formMail.addEventListener("submit", async (event) => {
      event.preventDefault();
      const id = $("mail-template").value;
      if (!id) {
        flash($("flash-mail"), "err", "Choose a template.");
        return;
      }
      try {
        const data = await request("/api/mail/templates/" + encodeURIComponent(id));
        const tpl = data.template || data;
        $("mail-subject").textContent = tpl.subject || "";
        const textEl = $("mail-text");
        textEl.hidden = false;
        textEl.textContent = tpl.text || "";
        const frame = $("mail-html");
        frame.hidden = false;
        frame.srcdoc = tpl.html || "";
        flash($("flash-mail"), "ok", "Preview loaded. This is a sample; live mail uses the granted person's handle.");
      } catch (err) {
        flash($("flash-mail"), "err", errText(err));
      }
    });
  }

  const formContact = $("form-contact-email");
  if (formContact) {
    formContact.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        const saved = await request("/api/me/contact-email", {
          method: "PATCH",
          body: { contactEmail: $("me-email").value.trim() },
        });
        flash(
          $("flash-contact-email"),
          "ok",
          saved.contactEmail ? "Saved " + saved.contactEmail : "Cleared contact email"
        );
      } catch (err) {
        flash($("flash-contact-email"), "err", errText(err));
      }
    });
  }

  $("btn-refresh-j").addEventListener("click", () => loadJurisdictions());
  $("btn-refresh-u").addEventListener("click", () => loadUsers());
  const refreshOfficers = $("btn-refresh-o");
  if (refreshOfficers) refreshOfficers.addEventListener("click", () => loadJurisdictions());
  const refreshAdmins = $("btn-refresh-admins");
  if (refreshAdmins) refreshAdmins.addEventListener("click", () => loadAdmins());
  const refreshMail = $("btn-refresh-mail");
  if (refreshMail) refreshMail.addEventListener("click", () => loadOutbox());

  loadHealth();
  loadMe();
  loadJurisdictions();
  loadUsers();
  loadAdmins();
  loadMailTemplates();
  loadOutbox();
})();

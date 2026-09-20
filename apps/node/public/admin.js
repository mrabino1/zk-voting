/* Platform admin — jurisdictions, officer grants, host status. No fee controls. */
import { t, LOCALE_EVENT } from "./i18n.js";

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
      const err = new Error((data && (data.error || data.message)) || res.statusText || t("common.requestFailed"));
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
    throw last || new Error(t("common.notFound"));
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
      (err.message || t("common.requestFailed")) +
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
      tbody.innerHTML = '<tr><td colspan="2" class="empty">' + t("admin.noFacts") + '</td></tr>';
      return;
    }
    tbody.innerHTML = rows
      .map(
        (row) =>
          `<tr><td>${esc(row.name)}</td><td class="hash">${esc(row.value)} ${
            /^0x[0-9a-fA-F]{40}$/.test(row.value)
              ? `<button type="button" class="copy" data-copy="${esc(row.value)}">${t("common.copy")}</button>`
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
        ? '<span class="status-dot on"></span>' + t("common.ok")
        : '<span class="status-dot off"></span>' + t("common.unhealthy");
      $("stat-chain").textContent = chainId != null ? String(chainId) : t("common.dash");
      $("stat-factory").innerHTML = factory
        ? `<span class="hash">${esc(factory)}</span> <button type="button" class="copy" data-copy="${esc(factory)}">${t("common.copy")}</button>`
        : t("common.dash");
      $("stat-nfp").textContent = nfp ? t("admin.nfpYes") : t("admin.nfpNo");
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
        banner.textContent = merged.disclosure.note + (when ? " " + t("disclosure.nextPublish", { time: when }) : "");
      }
      renderFacts(merged);
    } catch (err) {
      healthEl.innerHTML = '<span class="status-dot off"></span>' + t("common.unreachable");
      $("stat-chain").textContent = t("common.dash");
      $("stat-factory").textContent = t("common.dash");
      $("stat-nfp").textContent = errText(err);
    }
  }

  async function loadMe() {
    try {
      const me = await request("/api/me");
      const user = me.user;
      if (!user) {
        $("session-line").textContent = t("admin.sessionAnon");
        return me;
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
        (me.unreadCount ? " · " + t("admin.unread", { count: me.unreadCount }) : "");
      return me;
    } catch (err) {
      $("session-line").textContent = errText(err);
      return null;
    }
  }

  function formatOfficers(row) {
    const officers = Array.isArray(row.officers) ? row.officers : [];
    if (!officers.length) return t("common.dash");
    return officers
      .map((o) => (o.handle || o.address || o.userId || "?") + ": " + (o.role || "?"))
      .join("; ");
  }

  function formatUserOffices(row) {
    const grants = Array.isArray(row.jurisdictionRoles) ? row.jurisdictionRoles : [];
    if (!grants.length) return t("common.dash");
    return grants.map((g) => (g.jurisdictionId || "?") + ": " + (g.role || "?")).join("; ");
  }

  function renderJurisdictions(rows) {
    const tbody = $("table-jurisdictions").querySelector("tbody");
    const select = $("g-jurisdiction");
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty">' + t("admin.noJurisdictions") + '</td></tr>';
      if (select) select.innerHTML = '<option value="">' + t("common.noneLoaded") + '</option>';
      renderOfficers([]);
      return;
    }
    tbody.innerHTML = rows
      .map((row) => {
        return `<tr>
          <td>${esc(row.name || t("common.untitled"))}</td>
          <td class="hash">${esc(row.id)}</td>
          <td>${esc(formatOfficers(row))}</td>
          <td class="hash">${esc(row.metadataURI || t("common.dash"))}</td>
          <td>${esc(row.createdAt || t("common.dash"))}</td>
        </tr>`;
      })
      .join("");
    if (select) {
      const current = select.value;
      select.innerHTML =
        '<option value="">' + t("common.select") + '</option>' +
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
      tbody.innerHTML = '<tr><td colspan="5" class="empty">' + t("admin.noOfficers") + '</td></tr>';
      return;
    }
    tbody.innerHTML = grants
      .map(
        (g) => `<tr>
          <td>${esc(g.jurisdictionName)} <span class="hash">${esc(g.jurisdictionId)}</span></td>
          <td>${esc(g.handle || g.address || g.userId || t("common.dash"))}</td>
          <td>${esc(g.role)}</td>
          <td>${esc(g.grantedAt || t("common.dash"))}</td>
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
            >${t("admin.revoke")}</button>
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
      tbody.innerHTML = '<tr><td colspan="7" class="empty">' + t("admin.noUsers") + '</td></tr>';
      select.innerHTML = '<option value="">' + t("common.noneLoaded") + '</option>';
      return;
    }
    tbody.innerHTML = rows
      .map(
        (row) =>
          `<tr><td>${esc(row.handle)}</td><td>${esc(row.role)}</td><td>${esc(formatUserOffices(row))}</td><td>${esc(String(row.authMethodCount ?? 0))}</td><td class="hash">${esc(row.activeEthAddress || t("common.dash"))}</td><td>${row.personKeyBound ? t("common.bound") : t("common.dash")}</td><td class="hash">${esc(row.id)}</td></tr>`
      )
      .join("");
    select.innerHTML =
      '<option value="">' + t("common.select") + '</option>' +
      rows
        .map((row) => `<option value="${esc(row.id)}" data-handle="${esc(row.handle)}">${esc(row.handle)} · ${esc(row.role)}</option>`)
        .join("");
  }

  async function loadUsers() {
    try {
      const data = await getFirst(["/api/users", "/api/admin/users"]);
      renderUsers(asList(data, ["users", "items"]));
    } catch (err) {
      const msg =
        err.status === 401 || err.status === 403
          ? t("admin.signInToList")
          : errText(err);
      $("table-users").querySelector("tbody").innerHTML =
        `<tr><td colspan="7" class="empty">${esc(msg)}</td></tr>`;
      $("g-user").innerHTML = `<option value="">${esc(msg)}</option>`;
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
      flash($("flash-jurisdiction"), "ok", t("common.created", { name }));
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
      flash($("flash-grant"), "err", t("admin.chooseUser"));
      return;
    }
    if (!jurisdictionId) {
      flash($("flash-grant"), "err", t("admin.chooseJurisdiction"));
      return;
    }
    const selected = $("g-user").selectedOptions[0];
    const handle = (selected && selected.getAttribute("data-handle")) || "";
    const body = { userId, handle, role, jurisdictionId };
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
      flash($("flash-grant"), "ok", t("admin.granted", { role, jurisdiction: jurisdictionId, who }));
      await Promise.all([loadUsers(), loadJurisdictions()]);
    } catch (err) {
      flash($("flash-grant"), "err", errText(err));
    }
  });

  window.addEventListener("republic:session", () => {
    Promise.all([loadMe(), loadUsers(), loadJurisdictions()]);
  });

  document.addEventListener("click", async (event) => {
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
        flash(flashEl, "ok", t("admin.revoked", { role, jurisdiction: jurisdictionId }));
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
      btn.textContent = t("common.copied");
      setTimeout(() => {
        btn.textContent = t("common.copy");
      }, 1200);
    } catch {
      btn.textContent = t("common.failed");
    }
  });

  $("btn-refresh-j").addEventListener("click", () => loadJurisdictions());
  $("btn-refresh-u").addEventListener("click", () => loadUsers());
  const refreshOfficers = $("btn-refresh-o");
  if (refreshOfficers) refreshOfficers.addEventListener("click", () => loadJurisdictions());

  window.addEventListener(LOCALE_EVENT, () => {
    loadHealth();
    loadMe();
    loadJurisdictions();
    loadUsers();
  });

  loadHealth();
  loadMe();
  loadJurisdictions();
  loadUsers();
})();

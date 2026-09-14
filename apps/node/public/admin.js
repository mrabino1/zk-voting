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
      if (banner && merged.disclosure && merged.disclosure.note) {
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
        $("session-line").textContent = "Not signed in. Create a jurisdiction and grant roles as platform_admin.";
        return me;
      }
      $("session-line").textContent =
        user.handle + " · " + user.role + (me.unreadCount ? " · " + me.unreadCount + " unread" : "");
      return me;
    } catch (err) {
      $("session-line").textContent = errText(err);
      return null;
    }
  }

  function renderJurisdictions(rows) {
    const tbody = $("table-jurisdictions").querySelector("tbody");
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty">No jurisdictions yet.</td></tr>';
      return;
    }
    tbody.innerHTML = rows
      .map((row) => {
        return `<tr>
          <td>${esc(row.name || "Untitled")}</td>
          <td class="hash">${esc(row.id)}</td>
          <td class="hash">${esc(row.metadataURI || "—")}</td>
          <td>${esc(row.createdAt || "—")}</td>
        </tr>`;
      })
      .join("");
  }

  async function loadJurisdictions() {
    try {
      const data = await getFirst(["/api/jurisdictions", "/api/admin/jurisdictions"]);
      renderJurisdictions(asList(data, ["jurisdictions", "items"]));
    } catch (err) {
      $("table-jurisdictions").querySelector("tbody").innerHTML =
        `<tr><td colspan="4" class="empty">${esc(errText(err))}</td></tr>`;
    }
  }

  function renderUsers(rows) {
    const tbody = $("table-users").querySelector("tbody");
    const select = $("g-user");
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="3" class="empty">No users (or not authorized).</td></tr>';
      select.innerHTML = '<option value="">None loaded</option>';
      return;
    }
    tbody.innerHTML = rows
      .map(
        (row) =>
          `<tr><td>${esc(row.handle)}</td><td>${esc(row.role)}</td><td class="hash">${esc(row.id)}</td></tr>`
      )
      .join("");
    select.innerHTML =
      '<option value="">Select…</option>' +
      rows
        .map((row) => `<option value="${esc(row.id)}">${esc(row.handle)} · ${esc(row.role)}</option>`)
        .join("");
  }

  async function loadUsers() {
    try {
      const data = await getFirst(["/api/users", "/api/admin/users"]);
      renderUsers(asList(data, ["users", "items"]));
    } catch (err) {
      const msg =
        err.status === 401 || err.status === 403
          ? "Sign in as platform_admin to list users and grant officers."
          : errText(err);
      $("table-users").querySelector("tbody").innerHTML =
        `<tr><td colspan="3" class="empty">${esc(msg)}</td></tr>`;
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
      flash($("flash-jurisdiction"), "ok", "Created " + name);
      event.target.reset();
      await loadJurisdictions();
    } catch (err) {
      flash($("flash-jurisdiction"), "err", errText(err));
    }
  });

  $("form-grant").addEventListener("submit", async (event) => {
    event.preventDefault();
    const userId = $("g-user").value.trim();
    const role = $("g-role").value;
    if (!userId) {
      flash($("flash-grant"), "err", "Choose a user.");
      return;
    }
    try {
      try {
        await request("/api/users/" + encodeURIComponent(userId), {
          method: "PATCH",
          body: { role },
        });
      } catch (err) {
        if (!retryable(err)) throw err;
        await request("/api/admin/users/" + encodeURIComponent(userId), {
          method: "PATCH",
          body: { role },
        });
      }
      flash($("flash-grant"), "ok", "Granted " + role);
      await loadUsers();
    } catch (err) {
      flash($("flash-grant"), "err", errText(err));
    }
  });

  $("form-dev").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const data = await request("/api/auth/dev-login", {
        method: "POST",
        body: { handle: $("dev-handle").value.trim(), role: "platform_admin" },
      });
      flash($("flash-dev"), "ok", "Signed in as " + (data.user && data.user.handle));
      await Promise.all([loadMe(), loadUsers(), loadJurisdictions()]);
    } catch (err) {
      flash($("flash-dev"), "err", errText(err));
    }
  });

  document.addEventListener("click", async (event) => {
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

  $("btn-refresh-j").addEventListener("click", () => loadJurisdictions());
  $("btn-refresh-u").addEventListener("click", () => loadUsers());

  loadHealth();
  loadMe();
  loadJurisdictions();
  loadUsers();
})();

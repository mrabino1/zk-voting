/**
 * NOT FOR PROFIT — civic public good, not a commercial product.
 * ERC-20 poll create and list for /admin. One token per deployment.
 */

export { deploymentMode, deploymentSummary } from "./deployment-mode.js";

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function flash(el, kind, message) {
  if (!el) return;
  el.className = "flash show " + kind;
  el.textContent = message;
}

function errText(err) {
  return (err.status ? err.status + " · " : "") + (err.message || "Request failed");
}

function toUnix(datetimeLocal) {
  const ms = new Date(datetimeLocal).getTime();
  if (Number.isNaN(ms)) throw new Error("Invalid datetime");
  return Math.floor(ms / 1000);
}

function hasOfficerRole(me, name) {
  const user = me && me.user;
  if (!user) return false;
  if (user.role === "platform_admin" || user.role === "platform_super_admin") return true;
  const grants = me.jurisdictionRoles || [];
  if (grants.some((g) => g.role === name)) return true;
  const roles = me.roles || [];
  return roles.some((r) => String(r).toLowerCase() === name);
}

function isoLocal(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    date.getFullYear() +
    "-" +
    pad(date.getMonth() + 1) +
    "-" +
    pad(date.getDate()) +
    "T" +
    pad(date.getHours()) +
    ":" +
    pad(date.getMinutes())
  );
}

async function loadPollAdminList(request, superAdmin, canTally) {
  const host = document.getElementById("token-poll-list");
  if (!host) return;
  try {
    const data = await request("/api/polls");
    const polls = (data && data.polls) || [];
    host.replaceChildren();
    if (!polls.length) {
      const empty = document.createElement("p");
      empty.textContent = "No ERC-20 polls yet.";
      host.append(empty);
      return;
    }
    for (const poll of polls) {
      const article = document.createElement("article");
      article.className = "election-card";
      const title = document.createElement("h3");
      title.textContent = poll.title + " · " + poll.state;
      const meta = document.createElement("p");
      meta.textContent =
        (poll.tokenSymbol || "") +
        " " +
        poll.token +
        " · chain " +
        poll.tokenChainId +
        " · " +
        (poll.weightSource || "balance_hold") +
        " · " +
        (poll.weighting || "gross") +
        " · " +
        (poll.decisionRule || "simple_majority");
      article.append(title, meta);
      if (superAdmin && (poll.state === "DRAFT" || poll.state === "SCHEDULED")) {
        const schedule = document.createElement("button");
        schedule.type = "button";
        schedule.className = "btn";
        schedule.textContent = "Schedule";
        schedule.addEventListener("click", async () => {
          try {
            await request("/api/polls/" + encodeURIComponent(poll.id) + "/schedule", { method: "POST", body: {} });
            flash(document.getElementById("flash-polls"), "ok", "Scheduled.");
            await loadPollAdminList(request, superAdmin, canTally);
          } catch (err) {
            flash(document.getElementById("flash-polls"), "err", errText(err));
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
            flash(document.getElementById("flash-polls"), "ok", "Outcome " + (result.outcome || "") + ". Signal only.");
            await loadPollAdminList(request, superAdmin, canTally);
          } catch (err) {
            flash(document.getElementById("flash-polls"), "err", errText(err));
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

export async function mountTokenPolls(root, { request, me, token }) {
  if (!root || !request) return;
  const role = me && me.user && me.user.role;
  const superAdmin = role === "platform_super_admin";
  const canTally =
    superAdmin || role === "platform_admin" || role === "tally_operator" || hasOfficerRole(me, "tally_operator");
  const address = token && token.address ? token.address : "";
  const chainId = token && token.chainId != null ? String(token.chainId) : "";
  root.replaceChildren();
  const section = document.createElement("div");
  section.id = "token-polls";
  section.innerHTML =
    '<p class="field-hint">Signal polls on the one ERC-20 above. Balance-hold reads the minimum balance through close. Delegated-snapshot reads ERC-20Votes at one finalized Ethereum block. This Node never sends a token transaction.</p>' +
    (address
      ? `<p class="field-hint">Every poll uses ${esc(address)} on chain ${esc(chainId)}. There is no second token.</p>`
      : "") +
    (superAdmin ? '<div id="token-poll-create"></div>' : '<p class="field-hint">Only a platform super admin can create a poll.</p>') +
    '<div id="token-poll-list"><p class="empty">Loading…</p></div>' +
    '<div class="flash" id="flash-polls" role="status"></div>';
  root.append(section);
  if (superAdmin) {
    const host = section.querySelector("#token-poll-create");
    host.innerHTML =
      '<form id="form-token-poll" class="form-grid">' +
      '<div class="field"><label class="field-label" for="p-jurisdiction">Jurisdiction</label><select id="p-jurisdiction"></select></div>' +
      '<div class="field"><label class="field-label" for="p-title">Title</label><input id="p-title" maxlength="200" /></div>' +
      '<div class="field"><label class="field-label" for="p-summary">Summary</label><textarea id="p-summary" rows="2" maxlength="600"></textarea></div>' +
      '<div class="field"><label class="field-label" for="p-body">Proposal</label><textarea id="p-body" rows="6" maxlength="8000"></textarea></div>' +
      '<div class="field"><label class="field-label" for="p-tags">Tags, comma separated</label><input id="p-tags" maxlength="200" /></div>' +
      '<div class="field"><label class="field-label" for="p-discussion">Discussion URL</label><input id="p-discussion" type="url" spellcheck="false" /></div>' +
      '<div class="field"><label class="field-label" for="p-type">Ballot</label><select id="p-type"><option value="plurality">Single choice · simple majority</option><option value="ranked_irv">Ranked choice (IRV)</option></select></div>' +
      '<div class="field"><label class="field-label" for="p-weighting">Count</label><select id="p-weighting"><option value="gross">Gross — token weight as held</option><option value="quadratic">Quadratic — square root of the gross weight</option></select></div>' +
      '<div class="field"><label class="field-label" for="p-weight">Credential</label><select id="p-weight"><option value="balance_hold">Minimum balance through close</option><option value="erc20_votes">Delegated votes at an Ethereum snapshot</option></select></div>' +
      '<div class="field"><label class="field-label" for="p-snap">Snapshot block (blank uses the latest finalized block)</label><input id="p-snap" inputmode="numeric" spellcheck="false" /></div>' +
      '<div class="grid-2"><div class="field"><label class="field-label" for="p-start">Start</label><input id="p-start" type="datetime-local" /></div>' +
      '<div class="field"><label class="field-label" for="p-cutoff">Cutoff</label><input id="p-cutoff" type="datetime-local" /></div></div>' +
      '<div class="field"><label class="field-label" for="p-options">Options (one label per line, at least two). Abstain is added.</label><textarea id="p-options" rows="4">Yes\nNo</textarea></div>' +
      '<div class="field"><label class="field-label" for="p-min">Minimum weight (base units)</label><input id="p-min" value="1" /></div>' +
      '<div class="field"><label class="field-label" for="p-id">Existing draft id (blank creates a new poll)</label><input id="p-id" spellcheck="false" /></div>' +
      '<p class="field-hint">Quorum and pass threshold default to none. Edit is available while the poll is still a draft or scheduled.</p>' +
      '<div class="actions"><button class="btn" type="submit">Create poll</button></div>' +
      '<pre id="p-preflight" class="field-hint"></pre>' +
      "</form>";
    const jurisdiction = host.querySelector("#p-jurisdiction");
    try {
      const data = await request("/api/jurisdictions");
      const rows = Array.isArray(data) ? data : (data && (data.jurisdictions || data.items)) || [];
      jurisdiction.innerHTML = rows.length
        ? rows.map((row) => `<option value="${esc(row.id)}">${esc(row.name || row.id)}</option>`).join("")
        : '<option value="">Create a jurisdiction on this page first</option>';
    } catch (err) {
      jurisdiction.innerHTML = `<option value="">${esc(errText(err))}</option>`;
    }
    const start = new Date(Date.now() + 60 * 1000);
    const cutoff = new Date(Date.now() + 24 * 60 * 60 * 1000);
    host.querySelector("#p-start").value = isoLocal(start);
    host.querySelector("#p-cutoff").value = isoLocal(cutoff);
    host.querySelector("#form-token-poll").addEventListener("submit", async (event) => {
      event.preventDefault();
      const missing = [];
      const $ = (id) => host.querySelector("#" + id);
      if (!$("p-jurisdiction").value) missing.push("jurisdiction");
      if (!$("p-title").value.trim()) missing.push("title");
      if (!$("p-start").value || !$("p-cutoff").value) missing.push("start and cutoff");
      if (missing.length) {
        flash(document.getElementById("flash-polls"), "err", "Fill " + missing.join(", ") + " before creating the poll.");
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
          summary: $("p-summary").value.trim(),
          body: $("p-body").value,
          tags: $("p-tags").value.split(",").map((tag) => tag.trim()).filter(Boolean),
          discussionUrl: $("p-discussion").value.trim() || undefined,
          pollType: $("p-type").value,
          weighting: $("p-weighting").value,
          weightSource: $("p-weight").value,
          snapshotBlock: $("p-snap").value.trim() || undefined,
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
        flash(document.getElementById("flash-polls"), "ok", "Draft created. Schedule it when the window is right.");
        await loadPollAdminList(request, true, true);
      } catch (err) {
        flash(document.getElementById("flash-polls"), "err", errText(err));
      }
    });
  }
  await loadPollAdminList(request, superAdmin, canTally);
}

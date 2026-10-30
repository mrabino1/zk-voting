/* ZK-Voting L2 explorer — blocks, txs, search. Vote txs: nullifier + ballotHash only. */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const FORBIDDEN_KEYS =
    /^(choice|option|optionid|options?selected|vote|plaintext|selected|ballotplaintext|candidate|selection|voteplaintext)$/i;
  const TX_TYPES = ["REGISTER", "VOTE", "DISQUALIFY", "TALLY", "BATCH"];
  const LIMIT = 25;

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

  async function request(path) {
    const res = await fetchRetry(path, { credentials: "include", headers: { Accept: "application/json" } });
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

  function t(key, vars, fallback) {
    const i18n = window.ZkVotingI18n;
    if (i18n && typeof i18n.t === "function") {
      const value = i18n.t(key, vars);
      if (value && value !== key) return value;
    }
    return fallback;
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

  function errText(err) {
    return (
      (err.status ? err.status + " · " : "") +
      (err.message || "Request failed") +
      (err.path ? " (" + err.path + ")" : "")
    );
  }

  function flash(kind, message) {
    const el = $("flash-search");
    el.className = "flash show " + kind;
    el.textContent = message;
  }

  function clearFlash() {
    $("flash-search").className = "flash";
    $("flash-search").textContent = "";
  }

  function qty(value) {
    if (value == null || value === "") return null;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    const s = String(value);
    if (/^0x[0-9a-fA-F]+$/.test(s)) return parseInt(s, 16);
    if (/^\d+$/.test(s)) return Number(s);
    return value;
  }

  function stripChoice(node) {
    if (node == null || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(stripChoice);
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (FORBIDDEN_KEYS.test(key)) continue;
      out[key] = stripChoice(value);
    }
    return out;
  }

  function canonicalType(raw) {
    const t = String(raw || "").toLowerCase();
    if (t.includes("register")) return "REGISTER";
    if (t === "vote" || t.includes("vote")) return "VOTE";
    if (t.includes("disqual") || t === "revoke") return "DISQUALIFY";
    if (t.includes("certif") || t === "l1_certify") return "L1";
    if (t.includes("tally")) return "TALLY";
    return "BATCH";
  }

  function flattenTx(raw) {
    const tx = stripChoice(raw || {});
    const payload = stripChoice(tx.payload || tx.civic || {});
    const merged = { ...tx, ...payload, payload };
    const civic = payload.type || tx.civicType || tx.kind || tx.op;
    if (civic) merged.type = civic;
    else if (/^0x[0-9a-fA-F]+$/.test(String(tx.type || ""))) merged.type = "userop";
    return merged;
  }

  function normalizeTx(raw) {
    if (!raw || typeof raw === "string") {
      return raw ? { hash: raw, type: "BATCH" } : null;
    }
    const tx = flattenTx(raw);
    const type = canonicalType(tx.type || tx.civicType || tx.kind || tx.op);
    const out = {
      hash: pick(tx, ["hash", "txHash", "transactionHash", "id"]),
      type,
      blockNumber: qty(pick(tx, ["blockNumber", "block", "block_number"])),
      timestamp: qty(pick(tx, ["timestamp", "time", "ts"])),
      electionId: pick(tx, ["electionId", "election_id", "election"]),
    };
    if (type === "VOTE") {
      out.nullifier = pick(tx, ["nullifier", "payload.nullifier"]);
      out.ballotHash = pick(tx, ["ballotHash", "ballot_hash", "payload.ballotHash"]);
    } else if (type === "REGISTER") {
      out.identityCommitment = pick(tx, ["identityCommitment", "commitment", "leaf", "payload.identityCommitment"]);
    } else if (type === "DISQUALIFY") {
      out.identityCommitment = pick(tx, ["identityCommitment", "payload.identityCommitment"]);
      out.reasonCode = pick(tx, ["reasonCode", "reason_code", "reason", "payload.reasonCode"]);
      out.evidenceHash = pick(tx, ["evidenceHash", "evidence_hash", "payload.evidenceHash"]);
    } else if (type === "TALLY") {
      out.counts = pick(tx, ["counts", "tally", "payload.counts"]);
      out.countsHash = pick(tx, ["countsHash", "payload.countsHash"]);
    } else if (type === "L1") {
      out.resultHash = pick(tx, ["resultHash", "payload.resultHash", "countsHash"]);
      out.txHash = pick(tx, ["txHash", "payload.txHash"]);
      out.mirror = pick(tx, ["mirror", "payload.mirror"]);
    } else {
      out.batchIndex = pick(tx, ["batchIndex", "batch_index"]);
      out.dataHash = pick(tx, ["dataHash", "data_hash"]);
      out.stateRoot = pick(tx, ["newStateRoot", "stateRoot", "eligibleRoot"]);
      out.title = pick(tx, ["title", "payload.title"]);
    }
    return out;
  }

  function txArray(block) {
    const raw = block.txs || block.transactions || block.items || [];
    return raw.map(normalizeTx).filter(Boolean);
  }

  function normalizeBlock(raw) {
    const b = raw || {};
    const txs = txArray(b);
    const number = qty(pick(b, ["number", "blockNumber", "block_number", "n"]));
    return {
      number,
      timestamp: qty(pick(b, ["timestamp", "time", "ts"])),
      txCount: qty(pick(b, ["txCount", "transactionCount", "tx_count"])) ?? txs.length,
      stateRoot: pick(b, ["stateRoot", "state_root", "root", "newStateRoot", "transactionsRoot"]) || pick(b, ["hash"]),
      hash: pick(b, ["hash", "blockHash", "block_hash"]),
      parentHash: pick(b, ["parentHash", "parent_hash"]),
      txs,
    };
  }

  function fmtTime(ts) {
    if (ts == null || ts === "") return "—";
    const n = Number(ts);
    const d = Number.isFinite(n) ? new Date(n > 1e12 ? n : n * 1000) : new Date(ts);
    if (Number.isNaN(d.getTime())) return String(ts);
    return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
  }

  function fmtCountdown(seconds) {
    const helper = globalThis.ZkVotingDisclosure;
    if (helper && typeof helper.formatCountdown === "function") {
      return helper.formatCountdown(seconds);
    }
    return String(seconds) + "s";
  }

  function shortHex(value, left, right) {
    if (value == null || value === "") return "—";
    const s = String(value);
    const l = left || 10;
    const r = right || 8;
    if (s.length <= l + r + 1) return s;
    return s.slice(0, l) + "…" + s.slice(-r);
  }

  function copyBtn(value) {
    if (!value) return "";
    return ` <button type="button" class="copy" data-copy="${esc(value)}">Copy</button>`;
  }

  function hashLink(href, value) {
    if (!value) return "—";
    return `<a href="${esc(href)}" title="${esc(value)}">${esc(shortHex(value))}</a>${copyBtn(value)}`;
  }

  function typeBadge(type) {
    const t = String(type || "BATCH").toUpperCase();
    const cls = TX_TYPES.includes(t) ? t.toLowerCase() : "batch";
    return `<span class="tx-type ${cls}">${esc(t)}</span>`;
  }

  function txSummary(tx) {
    if (tx.type === "VOTE") {
      return `nullifier ${shortHex(tx.nullifier)} · ballotHash ${shortHex(tx.ballotHash)}`;
    }
    if (tx.type === "REGISTER") {
      return "commitment " + shortHex(tx.identityCommitment);
    }
    if (tx.type === "DISQUALIFY") {
      return "reason " + (tx.reasonCode ?? "—") + " · evidence " + shortHex(tx.evidenceHash);
    }
    if (tx.type === "TALLY") {
      const counts = Array.isArray(tx.counts) ? tx.counts.join(", ") : "posted";
      return "counts [" + counts + "]";
    }
    if (tx.title) return String(tx.title);
    return "civic batch / userop";
  }

  function parseRoute() {
    const params = new URLSearchParams(location.search);
    if (params.get("election")) return { kind: "election", id: params.get("election") };
    if (params.get("block")) return { kind: "block", id: params.get("block") };
    if (params.get("tx")) return { kind: "tx", id: params.get("tx") };
    if (params.get("nullifier")) return { kind: "nullifier", id: params.get("nullifier") };
    if (params.get("q")) return { kind: "search", q: params.get("q") };

    const hash = decodeURIComponent((location.hash || "").replace(/^#\/?/, ""));
    if (!hash) return { kind: "list" };
    const parts = hash.split("/").filter(Boolean);
    const head = (parts[0] || "").toLowerCase();
    if (head === "block" && parts[1]) return { kind: "block", id: parts[1] };
    if (head === "tx" && parts[1]) return { kind: "tx", id: parts.slice(1).join("/") };
    if (head === "nullifier" && parts[1]) return { kind: "nullifier", id: parts.slice(1).join("/") };
    if (head === "election" && parts[1]) return { kind: "election", id: parts[1] };
    if (head === "search") return { kind: "search", q: parts.slice(1).join("/") };
    if (/^\d+$/.test(parts[0]) || /^0x[0-9a-fA-F]+$/.test(parts[0])) {
      if (/^0x[0-9a-fA-F]{1,16}$/.test(parts[0]) && parts[0].length <= 18) {
        return { kind: "block", id: String(qty(parts[0])) };
      }
      if (/^\d+$/.test(parts[0])) return { kind: "block", id: parts[0] };
    }
    return { kind: "search", q: parts.join("/") };
  }

  function crumbs(items) {
    $("crumbs").innerHTML = items
      .map((item, i) =>
        i === items.length - 1 || !item.href
          ? `<span>${esc(item.label)}</span>`
          : `<a href="${esc(item.href)}">${esc(item.label)}</a> › `
      )
      .join("");
  }

  function votePrivacyNote() {
    return `<p class="privacy-callout"><strong>Ballot privacy</strong>
      This transaction proves eligibility and uniqueness. The explorer shows the nullifier and the ballot hash.
      Choice plaintext is not a field on this L2 and is never rendered here.
      Vote rows appear only after the hour that contained them has closed, the disclosure delay has elapsed, and the results gate is open, so leaving a voting office cannot be matched to a live jurisdiction tick.</p>`;
  }

  let disclosurePayload = null;
  let disclosureFetchedAt = 0;
  let countdownTimer = null;

  function paintDisclosure(data, overlay) {
    const el = $("disclosure-banner");
    const helper = globalThis.ZkVotingDisclosure;
    if (!el || !helper) return;
    const d = {
      ...((data && data.disclosure) || {}),
      ...(overlay || {}),
    };
    if (!d.policy && !d.lastClosedHourAt && d.lastPublishedAt == null && !d.note) return;
    disclosurePayload = d;
    disclosureFetchedAt = helper.paint(el, d);
    startCountdown();
  }

  function startCountdown() {
    const helper = globalThis.ZkVotingDisclosure;
    const el = $("disclosure-banner");
    if (!helper || !el) return;
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
    if (!disclosurePayload || !(Number(disclosurePayload.intervalSeconds) > 0)) return;
    countdownTimer = setInterval(() => {
      const remaining = helper.tickCountdown(el, disclosurePayload, disclosureFetchedAt);
      if (remaining <= 0) {
        clearInterval(countdownTimer);
        countdownTimer = null;
        refreshDisclosure();
      }
    }, 1000);
  }

  async function refreshDisclosure(overlay) {
    try {
      const data = await request("/api/explorer/disclosure");
      paintDisclosure(data, overlay);
    } catch {
      if (overlay) paintDisclosure({ disclosure: overlay }, overlay);
    }
  }

  function txTable(txs) {
    if (!txs.length) return '<p class="empty">No transactions in this view.</p>';
    return `<div class="table-wrap"><table class="data-table">
      <thead>
        <tr>
          <th>Type</th>
          <th>Txn hash</th>
          <th>Election</th>
          <th>What this did</th>
        </tr>
      </thead>
      <tbody>
        ${txs
          .map((tx) => {
            const href = tx.hash ? "#/tx/" + encodeURIComponent(tx.hash) : "#";
            return `<tr>
              <td>${typeBadge(tx.type)}</td>
              <td class="hash-cell">${tx.hash ? hashLink(href, tx.hash) : "—"}</td>
              <td>${
                tx.electionId != null
                  ? `<a href="#/election/${esc(tx.electionId)}">${esc(tx.electionId)}</a>`
                  : "—"
              }</td>
              <td>${esc(txSummary(tx))}</td>
            </tr>`;
          })
          .join("")}
      </tbody>
    </table></div>`;
  }

  function txDetailRows(tx) {
    const rows = [
      ["Type", typeBadge(tx.type)],
      ["Txn hash", esc(tx.hash || "—") + copyBtn(tx.hash)],
      [
        "Block",
        tx.blockNumber != null ? `<a href="#/block/${esc(tx.blockNumber)}">${esc(tx.blockNumber)}</a>` : "—",
      ],
      ["Timestamp", esc(fmtTime(tx.timestamp))],
      [
        "Election",
        tx.electionId != null
          ? `<a href="#/election/${esc(tx.electionId)}">${esc(tx.electionId)}</a>`
          : "—",
      ],
    ];
    if (tx.type === "VOTE") {
      rows.push(["Nullifier", esc(tx.nullifier || "—") + copyBtn(tx.nullifier)]);
      rows.push(["Ballot hash", esc(tx.ballotHash || "—") + copyBtn(tx.ballotHash)]);
    } else if (tx.type === "REGISTER") {
      rows.push(["Identity commitment", esc(tx.identityCommitment || "—") + copyBtn(tx.identityCommitment)]);
    } else if (tx.type === "DISQUALIFY") {
      rows.push(["Identity commitment", esc(tx.identityCommitment || "—") + copyBtn(tx.identityCommitment)]);
      rows.push(["Reason code", esc(tx.reasonCode ?? "—")]);
      rows.push(["Evidence hash", esc(tx.evidenceHash || "—") + copyBtn(tx.evidenceHash)]);
    } else if (tx.type === "TALLY") {
      rows.push(["Counts", esc(Array.isArray(tx.counts) ? JSON.stringify(tx.counts) : "—")]);
    } else {
      if (tx.title) rows.push(["Title", esc(tx.title)]);
      if (tx.stateRoot) rows.push(["State / eligible root", esc(tx.stateRoot) + copyBtn(tx.stateRoot)]);
      if (tx.dataHash) rows.push(["Data hash", esc(tx.dataHash) + copyBtn(tx.dataHash)]);
    }
    return rows.map(([dt, dd]) => `<dt>${esc(dt)}</dt><dd>${dd}</dd>`).join("");
  }

  async function fetchBlockList() {
    const data = await request("/api/explorer/blocks");
    const blocks = asList(data, ["blocks", "items"]).map(normalizeBlock);
    blocks.sort((a, b) => Number(b.number) - Number(a.number));
    paintDisclosure(data);
    return { chainId: data.chainId, head: data.head, blocks, disclosure: data.disclosure };
  }

  async function loadBlockList() {
    crumbs([{ label: "Latest blocks" }]);
    const qs = new URLSearchParams(location.search);
    const before = qty(qs.get("before"));
    let pack;
    try {
      pack = await fetchBlockList();
    } catch (err) {
      $("view").innerHTML = `<section class="panel"><p class="empty">${esc(errText(err))}</p></section>`;
      return;
    }
    let rows = pack.blocks;
    if (before != null) rows = rows.filter((b) => Number(b.number) < Number(before));
    const page = rows.slice(0, LIMIT);
    if (!page.length) {
      $("view").innerHTML =
        '<section class="panel"><p class="empty">No blocks yet. The sequencer has not produced a public batch.</p></section>';
      return;
    }
    const oldest = page[page.length - 1]?.number;
    const newerHref = before != null ? "/explorer" : "";
    const olderHref = rows.length > LIMIT ? "/explorer?before=" + encodeURIComponent(String(oldest)) : "";
    $("view").innerHTML = `<section class="panel">
      <header><h2>Blocks</h2><span class="field-hint">Hourly vote disclosure · number · timestamp · tx count · state root</span></header>
      <div class="table-wrap"><table class="data-table">
        <thead>
          <tr>
            <th>Block</th>
            <th>Timestamp</th>
            <th>Txns</th>
            <th>State root</th>
          </tr>
        </thead>
        <tbody>
          ${page
            .map((b) => {
              const href = "#/block/" + encodeURIComponent(b.number);
              return `<tr>
                <td class="block-num"><a href="${esc(href)}">${esc(b.number)}</a></td>
                <td>${esc(fmtTime(b.timestamp))}</td>
                <td class="num">${esc(b.txCount ?? 0)}</td>
                <td class="hash-cell hash" title="${esc(b.stateRoot || "")}">${esc(shortHex(b.stateRoot, 18, 12))}${copyBtn(b.stateRoot)}</td>
              </tr>`;
            })
            .join("")}
        </tbody>
      </table></div>
      <div class="pager">
        <div>
          ${newerHref ? `<a class="btn btn-secondary" href="${esc(newerHref)}">Newest</a>` : ""}
          ${olderHref ? `<a class="btn btn-secondary" href="${esc(olderHref)}">Older</a>` : ""}
        </div>
        <span class="field-hint">${pack.head != null ? "Head #" + pack.head : ""} ${
      pack.chainId != null ? "· chain " + pack.chainId : ""
    }</span>
      </div>
    </section>`;
  }

  async function loadBlock(id) {
    crumbs([
      { href: "/explorer", label: "Blocks" },
      { label: "Block #" + id },
    ]);
    let data;
    try {
      data = await request("/api/explorer/blocks/" + encodeURIComponent(id));
    } catch (err) {
      $("view").innerHTML = `<section class="panel"><p class="empty">${esc(errText(err))}</p></section>`;
      return;
    }
    const block = normalizeBlock(data.block || data);
    paintDisclosure(data);
    const n = Number(block.number ?? id);
    $("view").innerHTML = `<section class="panel">
      <header><h2>Block #${esc(block.number ?? id)}</h2></header>
      <dl class="detail-grid">
        <dt>Number</dt><dd class="block-num">${esc(block.number ?? id)}</dd>
        <dt>Timestamp</dt><dd>${esc(fmtTime(block.timestamp))}</dd>
        <dt>Transactions</dt><dd>${esc(block.txCount ?? block.txs.length)}</dd>
        <dt>State root</dt><dd>${esc(block.stateRoot || "—")}${copyBtn(block.stateRoot)}</dd>
        <dt>Block hash</dt><dd>${esc(block.hash || "—")}${copyBtn(block.hash)}</dd>
        <dt>Parent</dt><dd>${esc(block.parentHash || "—")}${copyBtn(block.parentHash)}</dd>
      </dl>
      <div class="pager">
        ${Number.isFinite(n) && n > 1 ? `<a class="btn btn-secondary" href="#/block/${n - 1}">Previous</a>` : ""}
        ${Number.isFinite(n) ? `<a class="btn btn-secondary" href="#/block/${n + 1}">Next</a>` : ""}
      </div>
    </section>
    <section class="panel">
      <header><h2>What this block did</h2></header>
      ${txTable(block.txs)}
    </section>`;
  }

  async function loadTx(hash) {
    crumbs([
      { href: "/explorer", label: "Blocks" },
      { label: "Transaction" },
    ]);
    let data;
    try {
      data = await request("/api/explorer/txs/" + encodeURIComponent(hash));
    } catch (err) {
      $("view").innerHTML = `<section class="panel"><p class="empty">${esc(errText(err))}</p></section>`;
      return;
    }
    const tx = normalizeTx(data.tx || data.transaction || data);
    await refreshDisclosure();
    $("view").innerHTML = `<section class="panel">
      <header><h2>Transaction</h2></header>
      <dl class="detail-grid">${txDetailRows(tx)}</dl>
      ${tx.type === "VOTE" ? votePrivacyNote() : ""}
    </section>`;
  }

  async function scanTxs() {
    const pack = await fetchBlockList();
    const found = [];
    for (const summary of pack.blocks) {
      let block;
      try {
        const data = await request("/api/explorer/blocks/" + encodeURIComponent(summary.number));
        block = normalizeBlock(data.block || data);
      } catch {
        continue;
      }
      for (const tx of block.txs) found.push(tx);
    }
    return found;
  }

  function sameHex(a, b) {
    if (a == null || b == null) return false;
    return String(a).toLowerCase().replace(/^0x/, "") === String(b).toLowerCase().replace(/^0x/, "");
  }

  async function loadNullifier(value) {
    crumbs([
      { href: "/explorer", label: "Blocks" },
      { label: "Nullifier" },
    ]);
    let tx = null;
    try {
      const data = await getFirst([
        "/api/explorer/nullifiers/" + encodeURIComponent(value),
        "/api/explorer/search?q=" + encodeURIComponent(value),
      ]);
      tx = normalizeTx(data.tx || data.transaction || data);
      if (!tx || (!tx.hash && !tx.nullifier)) tx = null;
    } catch {
      tx = null;
    }
    if (!tx) {
      try {
        const all = await scanTxs();
        tx = all.find((item) => item.type === "VOTE" && sameHex(item.nullifier, value)) || null;
      } catch (err) {
        $("view").innerHTML = `<section class="panel"><p class="empty">${esc(errText(err))}</p></section>`;
        return;
      }
    }
    if (!tx) {
      $("view").innerHTML = `<section class="panel"><p class="empty">No vote used nullifier ${esc(value)}.</p>${votePrivacyNote()}</section>`;
      return;
    }
    $("view").innerHTML = `<section class="panel">
      <header><h2>Nullifier</h2></header>
      <p class="hash">${esc(value)}${copyBtn(value)}</p>
      ${votePrivacyNote()}
      <dl class="detail-grid">${txDetailRows(tx)}</dl>
    </section>`;
  }

  async function loadElection(id) {
    crumbs([
      { href: "/explorer", label: "Blocks" },
      { label: "Election " + id },
    ]);
    let election = null;
    let ballots = [];
    let summary = null;
    try {
      election = await request("/api/elections/" + encodeURIComponent(id));
    } catch {
      election = null;
    }
    try {
      summary = await request("/api/elections/" + encodeURIComponent(id) + "/summary");
    } catch {
      summary = null;
    }
    const sealed = Boolean(
      (election && (election.resultsSealed || election.sealed)) ||
        (summary && (summary.resultsSealed || summary.sealed || summary.code === "RESULTS_SEALED"))
    );
    try {
      const data = await request("/api/elections/" + encodeURIComponent(id) + "/ballots");
      ballots = asList(data, ["ballots", "votes", "items"]).map((v) =>
        normalizeTx({ type: "vote", ...v, electionId: id })
      );
    } catch {
      ballots = [];
    }
    let chainTxs = [];
    try {
      chainTxs = (await scanTxs()).filter((tx) => String(tx.electionId) === String(id));
    } catch {
      chainTxs = [];
    }
    if (sealed) {
      chainTxs = chainTxs.filter((tx) => {
        const kind = String(tx.type || "").toUpperCase();
        return kind !== "TALLY" && kind !== "L1";
      });
    }
    const byHash = new Map();
    for (const tx of [...chainTxs, ...ballots]) {
      const key = tx.hash || tx.nullifier || JSON.stringify(tx);
      if (!byHash.has(key)) byHash.set(key, tx);
    }
    const txs = [...byHash.values()];
    const title = pick(election, ["title", "name"]) || (summary && summary.title) || "Election " + id;
    const tally = sealed ? null : pick(election, ["tally"]);
    const aspects = asList(election, ["aspects", "questions"]);
    const tallied = Boolean(tally);
    const tallyRows = Array.isArray(tally && tally.questions) && tally.questions.length
      ? tally.questions
          .map((q) => {
            if (q.tallied === false) {
              return `<li><strong>${esc(q.prompt || q.id)}</strong> — not tallied (${esc(q.note || "IRV")})</li>`;
            }
            if (q.tallyMethod === "irv" || q.ballotMethod === "ranked_choice") {
              const win = q.winnerLabel || q.winner;
              return `<li><strong>${esc(q.prompt || q.id)}</strong> — IRV${win ? ` winner ${esc(win)}` : ""}</li>`;
            }
            const opts = (q.options || [])
              .map((o) => `${esc(o.label || o.id)}: ${esc(o.count)}`)
              .join("; ");
            const under = q.undervotes != null ? ` · undervotes ${esc(q.undervotes)}` : "";
            return `<li><strong>${esc(q.prompt || q.id)}</strong> — ${opts}${under}</li>`;
          })
          .join("")
      : "";
    const aspectList = aspects.length
      ? `<ol class="aspect-preview">${aspects
          .map((q) => `<li>${esc(q.type || "")} — ${esc(q.prompt || q.id)}</li>`)
          .join("")}</ol>`
      : "";
    const l1 = pick(election, ["tally.l1"]);
    let l1Label = "not posted";
    if (l1) {
      l1Label = l1.status || "unknown";
      if (l1.txHash) l1Label += " · " + l1.txHash;
      else if (l1.reason) l1Label += " · " + l1.reason;
    }
    const disclosure = (summary && summary.disclosure) || (election && election.disclosure) || null;
    const sealedEnd = (election && (election.sealedUntil || election.cutoffTime)) || (summary && summary.sealedUntil) || (disclosure && disclosure.sealedUntil);
    const sealedLine = sealed
      ? t("results.sealedUntil", { end: fmtTime(sealedEnd) }, "Results sealed until " + fmtTime(sealedEnd))
      : "";
    const accepted =
      (summary && summary.acceptedBallots != null
        ? summary.acceptedBallots
        : pick(election, ["acceptedBallots"])) ??
      (disclosure && disclosure.acceptedBallotsDisclosed);
    const resultsUrl = sealed
      ? "/elections/" + encodeURIComponent(id) + "/results"
      : (summary && summary.resultsUrl) ||
        (tallied ? "/elections/" + encodeURIComponent(id) + "/results" : null);
    paintDisclosure({ disclosure: disclosure || {} }, sealed ? { ...(disclosure || {}), resultsSealed: true, sealedUntil: sealedEnd, note: sealedLine } : disclosure);
    const nextLine = !disclosure
      ? "—"
      : Number(disclosure.intervalSeconds) > 0
        ? (disclosure.secondsUntilNext != null ? fmtCountdown(disclosure.secondsUntilNext) + " · " : "") +
          fmtTime(disclosure.nextPublishAt)
        : "Publishes immediately";
    const stateLabel =
      pick(election, ["stateName", "state", "status"]) || (summary && summary.stateName) || "—";
    const headerAction = sealed
      ? '<a class="btn btn-secondary" href="' + esc(resultsUrl) + '">' + esc(t("results.sealedStatus", null, "Results sealed")) + "</a>"
      : resultsUrl
        ? '<a class="btn btn-secondary" href="' + esc(resultsUrl) + '">Final tally</a>'
        : '<span class="field-hint">Tally not posted yet</span>';
    const tallyCell = tallyRows
      ? '<ul class="tally-bars">' + tallyRows + "</ul>"
      : esc(tally && tally.counts ? JSON.stringify(tally.counts) : "not posted");
    const resultsCell = resultsUrl
      ? '<a href="' + esc(resultsUrl) + '">Tally posted — view results</a>'
      : "not posted (winner page is linked after a final tally)";
    const turnoutRows =
      "<dt>Last closed hour</dt><dd>" +
      esc(fmtTime(disclosure && (disclosure.lastClosedHourAt != null ? disclosure.lastClosedHourAt : disclosure.lastPublishedAt))) +
      "</dd><dt>" +
      esc(t("results.ballotsDisclosed", null, "Ballots disclosed")) +
      "</dt><dd>" +
      esc(accepted != null ? accepted : "—") +
      "</dd><dt>Next disclosure</dt><dd>" +
      esc(nextLine) +
      "</dd>";
    const choiceRows = sealed
      ? "<dt>" + esc(t("results.choiceResults", null, "Choice results")) + "</dt><dd>" + esc(sealedLine) + "</dd>"
      : "<dt>Public tally</dt><dd>" +
        tallyCell +
        '</dd><dt>Tally hash</dt><dd class="hash">' +
        esc(pick(election, ["tally.countsHash"]) || "—") +
        "</dd><dt>L1 certification</dt><dd>" +
        esc(l1Label) +
        "</dd><dt>Final tally</dt><dd>" +
        resultsCell +
        "</dd>" +
        (pick(election, ["tally.questions.0.winnerLabel"])
          ? "<dt>IRV winner</dt><dd>" + esc(pick(election, ["tally.questions.0.winnerLabel"])) + "</dd>"
          : "");
    const countRows = turnoutRows + choiceRows;
    const hint = sealed
      ? esc(sealedLine)
      : "Hourly snapshot only. Individual choices are not in this ledger. Vote rows wait until the hour that contained them has closed and the disclosure delay has elapsed. Plurality totals are labeled per question.";
    $("view").innerHTML = `<section class="panel">
      <header>
        <h2>${esc(title)}</h2>
        ${headerAction}
      </header>
      <dl class="detail-grid">
        <dt>Election id</dt><dd>${esc(id)}</dd>
        <dt>State</dt><dd>${esc(stateLabel)}</dd>
        <dt>Eligible root</dt><dd>${esc(pick(election, ["eligibleRoot"]) || "—")}</dd>
        <dt>Questions</dt><dd>${esc(pick(election, ["questionCount"]) ?? aspects.length ?? "—")}</dd>
        ${countRows}
      </dl>
      ${aspectList}
      <p class="field-hint">${hint}</p>
    </section>
    <section class="panel">
      <header><h2>On-chain activity</h2></header>
      ${txTable(txs)}
    </section>`;
  }

  async function runSearch(q) {
    const query = String(q || "").trim();
    if (!query) {
      history.replaceState(null, "", "/explorer");
      await loadBlockList();
      return;
    }
    if (/^\d+$/.test(query) || /^0x[0-9a-fA-F]{1,8}$/.test(query)) {
      location.hash = "#/block/" + qty(query);
      return;
    }
    try {
      const data = await request("/api/explorer/search?q=" + encodeURIComponent(query));
      const kind = String(pick(data, ["kind", "type"]) || "").toLowerCase();
      const hash = pick(data, ["tx.hash", "transaction.hash", "hash", "txHash"]);
      const block = pick(data, ["block.number", "blockNumber", "number"]);
      const nullifier = pick(data, ["nullifier", "tx.nullifier"]);
      if (kind === "block" || (block != null && !hash)) {
        location.hash = "#/block/" + qty(block);
        return;
      }
      if (kind === "nullifier" || (nullifier && !hash)) {
        location.hash = "#/nullifier/" + encodeURIComponent(nullifier || query);
        return;
      }
      if (hash) {
        location.hash = "#/tx/" + encodeURIComponent(hash);
        return;
      }
    } catch {
      /* typed lookups */
    }
    try {
      await request("/api/explorer/txs/" + encodeURIComponent(query));
      location.hash = "#/tx/" + encodeURIComponent(query);
      return;
    } catch {
      /* continue */
    }
    location.hash = "#/nullifier/" + encodeURIComponent(query);
  }

  async function render() {
    clearFlash();
    const route = parseRoute();
    if (route.kind !== "list" && route.kind !== "block" && route.kind !== "election") {
      refreshDisclosure();
    }
    if (route.kind === "list") return loadBlockList();
    if (route.kind === "block") return loadBlock(route.id);
    if (route.kind === "tx") return loadTx(route.id);
    if (route.kind === "nullifier") return loadNullifier(route.id);
    if (route.kind === "election") return loadElection(route.id);
    if (route.kind === "search") return runSearch(route.q);
  }

  $("form-search").addEventListener("submit", (event) => {
    event.preventDefault();
    const q = $("q").value.trim();
    if (!q) {
      history.replaceState(null, "", "/explorer");
      location.hash = "";
      render();
      return;
    }
    if (/^\d+$/.test(q)) {
      location.hash = "#/block/" + q;
      return;
    }
    location.hash = "#/search/" + encodeURIComponent(q);
  });

  $("btn-latest").addEventListener("click", () => {
    $("q").value = "";
    history.replaceState(null, "", "/explorer");
    location.hash = "";
    render();
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

  document.addEventListener("keydown", (event) => {
    if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
    const tag = (event.target && event.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    event.preventDefault();
    $("q").focus();
    $("q").select();
  });

  window.addEventListener("hashchange", render);
  window.addEventListener("popstate", render);

  const route = parseRoute();
  if (route.kind === "search" && route.q) $("q").value = route.q;
  if (route.kind === "block") $("q").value = route.id;
  if (route.kind === "tx" || route.kind === "nullifier") $("q").value = route.id;

  render();
})();

/**
 * NOT FOR PROFIT — civic public good, not a commercial product.
 * zk-voting ceremony transcript: read it, re-check the hash chain, and
 * re-verify every contribution with snarkjs in a Web Worker.
 */

import "./i18n.js";
import {
  fill,
  api,
  download,
  el,
  errorText,
  fmtBytes,
  fmtTime,
  parseVerifiedContributions,
  runWorker,
  sha256Hex,
  statusPill,
  verifyHashChain,
} from "./ceremony-common.js";

const root = document.getElementById("transcript-root");

function idFromPath() {
  const m = window.location.pathname.match(/^\/ceremony\/([^/]+)\/transcript\/?$/);
  return m ? decodeURIComponent(m[1]) : null;
}

function full(hex, label) {
  return el("code", { class: "hash mono hash-full", "aria-label": `${label}: ${hex}` }, hex || "—");
}

function dl(rows) {
  return el("dl", { class: "meta-list" }, ...rows.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)]));
}

function cliBlock(tr, id) {
  const base = `${window.location.origin}/api/ceremonies/${id}`;
  const last = tr.final ? tr.final.zkey : tr.contributions.at(-1)?.zkey || tr.initial?.zkey || "zkey_0000.zkey";
  const lines = [
    `# zk-voting ceremony ${id}: re-verify with the snarkjs CLI (npm i -g snarkjs@0.7.6)`,
    `curl -fsSO ${base}/files/circuit.r1cs`,
    `curl -fsSO ${base}/files/phase2.ptau`,
    `curl -fsSO ${base}/files/${last}`,
    `curl -fsS ${base}/transcript.json -o transcript.json`,
    `sha256sum circuit.r1cs ${last}   # compare with transcript.json`,
    `snarkjs zkey verify circuit.r1cs phase2.ptau ${last}`,
    `# Every "contribution #N" hash printed must equal contributions[N-1].contributionHash.`,
  ];
  if (tr.ptau?.sha256) lines.splice(6, 0, `sha256sum phase2.ptau   # expect ${tr.ptau.sha256}`);
  return el("pre", { class: "mono cli-block", tabindex: "0", "aria-label": "Command-line verification steps" }, el("code", {}, lines.join("\n")));
}

function render(tr, id) {
  const status = el("div", { id: "verify-status", role: "status", "aria-live": "polite" });
  const log = el("pre", { class: "mono cli-block verify-log", id: "verify-log", tabindex: "0", hidden: true, "aria-label": "snarkjs output" });
  const progress = el("progress", { id: "verify-progress", max: "100", value: "0", hidden: true, "aria-label": "Verification progress" });
  const last = tr.final ? tr.final.zkey : tr.contributions.at(-1)?.zkey || tr.initial?.zkey;
  const totalBytes = (tr.circuit?.bytes || 0) + (tr.ptau?.bytes || 0) + ((tr.final || tr.contributions.at(-1) || tr.initial)?.zkeyBytes || 0);

  const chainBtn = el("button", { class: "btn btn-secondary", type: "button" }, "Check the hash chain");
  chainBtn.addEventListener("click", async () => {
    const r = await verifyHashChain(tr.contributions);
    fill(status, 
      el(
        "p",
        { class: `notice ${r.ok ? "notice-ok" : "notice-error"}` },
        r.ok
          ? `Hash chain intact: ${tr.contributions.length} entries, head ${r.headHash}.`
          : `Hash chain broken at entry ${r.badIndex + 1}: ${r.reason}.`
      )
    );
  });

  const fullBtn = el("button", { class: "btn", type: "button", disabled: !last }, "Verify whole chain");
  fullBtn.addEventListener("click", async () => {
    fullBtn.disabled = true;
    chainBtn.disabled = true;
    progress.hidden = false;
    log.hidden = false;
    log.textContent = "";
    const lines = [];
    const say = (text, kind = "") => fill(status, el("p", { class: `notice ${kind ? `notice-${kind}` : ""}`.trim() }, text));
    try {
      const chain = await verifyHashChain(tr.contributions);
      if (!chain.ok) throw new Error(`hash chain broken at entry ${chain.badIndex + 1}`);
      progress.value = 5;
      say("Downloading the circuit, the phase-1 file, and the latest key…");
      const r1cs = await download(`/api/ceremonies/${id}/files/circuit.r1cs`);
      progress.value = 15;
      const ptau = await download(`/api/ceremonies/${id}/files/phase2.ptau`, (g, t) => t && (progress.value = 15 + Math.round((g / t) * 30)));
      const zkey = await download(`/api/ceremonies/${id}/files/${last}`);
      progress.value = 50;
      say("Checking file hashes…");
      const checks = [
        ["circuit.r1cs", await sha256Hex(r1cs), tr.circuit?.sha256],
        [last, await sha256Hex(zkey), (tr.final || tr.contributions.at(-1) || tr.initial).zkeySha256],
      ];
      if (tr.ptau?.sha256) checks.push(["phase2.ptau", await sha256Hex(ptau), tr.ptau.sha256]);
      for (const [name, got, want] of checks) {
        if (want && got !== want) throw new Error(`${name} does not match the transcript hash`);
      }
      progress.value = 55;
      say("Running snarkjs zkey verify in a background worker. Large circuits take minutes…");
      const result = await runWorker("verify", { r1cs, ptau, zkey }, [r1cs, ptau, zkey], (line) => {
        lines.push(line);
        if (lines.length % 20 === 0) log.textContent = lines.slice(-200).join("\n");
      });
      log.textContent = lines.slice(-200).join("\n");
      if (!result.ok) throw new Error("snarkjs rejected the key");
      const found = parseVerifiedContributions(result.log);
      const human = found.filter((f) => !f.beacon);
      if (human.length !== tr.contributions.length) {
        throw new Error(`snarkjs found ${human.length} contributions, the transcript lists ${tr.contributions.length}`);
      }
      tr.contributions.forEach((c, i) => {
        if (human[i].hash !== c.contributionHash) throw new Error(`contribution #${c.index} hash differs from the transcript`);
        if (human[i].name !== c.name) throw new Error(`contribution #${c.index} name differs from the transcript`);
      });
      if (tr.final) {
        const b = found.find((f) => f.beacon);
        if (!b) throw new Error("the final key has no beacon contribution");
        if (tr.beacon?.applied && b.beacon.hash !== tr.beacon.applied.value) throw new Error("beacon value differs from the transcript");
        const bh = tr.beacon?.applied?.blockHash;
        if (bh && bh.toLowerCase().replace(/^0x/, "") !== tr.beacon.applied.value) throw new Error("beacon value is not the recorded block hash");
      }
      progress.value = 100;
      say(
        `Verified. snarkjs accepted the key, and all ${tr.contributions.length} contribution hashes${tr.final ? " and the beacon" : ""} match the transcript.`,
        "ok"
      );
    } catch (err) {
      say(`Verification failed: ${errorText(err)}`, "error");
    } finally {
      fullBtn.disabled = false;
      chainBtn.disabled = false;
    }
  });

  const pre = tr.beacon?.precommit;
  const applied = tr.beacon?.applied;
  fill(root, 
    el(
      "section",
      { class: "panel", "aria-labelledby": "sum-h" },
      el("h2", { id: "sum-h" }, tr.circuit?.label || tr.circuit?.name || id),
      el("p", {}, statusPill(tr.status), " ", el("span", { class: "pill pill-warn" }, tr.trusted ? "Trusted" : "Pending human review")),
      dl([
        ["Ceremony", el("code", { class: "mono" }, tr.ceremonyId)],
        ["Circuit", tr.circuit?.name || "—"],
        ["Constraints", tr.circuit?.constraints != null ? String(tr.circuit.constraints) : "—"],
        ["r1cs SHA-256", full(tr.circuit?.sha256, "r1cs SHA-256")],
        ["Circuit hash (snarkjs)", full(tr.initial?.circuitHash, "Circuit hash")],
        ["Phase-1 file", tr.ptau ? `${tr.ptau.source || "ptau"}${tr.ptau.preset ? `, Hermez power ${tr.ptau.preset.power}` : ""} (${fmtBytes(tr.ptau.bytes)})` : "—"],
        ["Phase-1 SHA-256", full(tr.ptau?.sha256, "Phase-1 SHA-256")],
        [`Phase-1 pinned ${tr.ptau?.pinnedAlgorithm || "hash"}`, full(tr.ptau?.pinnedHash, "Pinned phase-1 hash")],
        ["Opened", fmtTime(tr.openedAt)],
        ["Closed", fmtTime(tr.closedAt)],
        ["Finalized", fmtTime(tr.finalizedAt)],
        ["Server chain check", tr.chainOk ? "Intact" : "BROKEN"],
      ]),
      el("p", {}, el("a", { href: `/api/ceremonies/${id}/transcript.json`, download: `transcript-${id}.json` }, "Download transcript.json"), " · ", el("a", { href: `/ceremony/${id}` }, "Back to the ceremony"))
    ),
    el(
      "section",
      { class: "panel", "aria-labelledby": "verify-h" },
      el("h2", { id: "verify-h" }, "Verify"),
      el(
        "p",
        {},
        `The hash-chain check is instant. The full check downloads about ${fmtBytes(totalBytes)} and re-runs snarkjs on every contribution in your browser. Nothing is uploaded.`
      ),
      el("div", { class: "cta-row" }, fullBtn, chainBtn),
      progress,
      status,
      log,
      el("h3", {}, "Verify from the command line"),
      cliBlock(tr, id)
    ),
    el(
      "section",
      { class: "panel", "aria-labelledby": "list-h" },
      el("h2", { id: "list-h" }, `Contributions (${tr.contributions.length})`),
      tr.contributions.length
        ? el(
            "ol",
            { class: "contrib-list" },
            ...tr.contributions.map((c) =>
              el(
                "li",
                {},
                el("h3", {}, `#${c.index} · ${c.name}`),
                dl([
                  ["Accepted", fmtTime(c.acceptedAt)],
                  ["Contribution hash", full(c.contributionHash, "Contribution hash")],
                  ["zkey SHA-256", full(c.zkeySha256, "zkey SHA-256")],
                  ["Previous zkey SHA-256", full(c.prevZkeySha256, "Previous zkey SHA-256")],
                  ["Entry hash", full(c.hash, "Entry hash")],
                  ["Attestation", c.attestation ? el("span", { class: "attestation" }, c.attestation) : "—"],
                ])
              )
            )
          )
        : el("p", { class: "empty" }, "No contributions yet.")
    ),
    el(
      "section",
      { class: "panel", "aria-labelledby": "beacon-h" },
      el("h2", { id: "beacon-h" }, "Random beacon"),
      el(
        "p",
        {},
        "The beacon is the hash of an Ethereum mainnet block chosen before the window closed, while that block did not exist yet, so no contributor could know or steer it. It is applied only after the block is finalized."
      ),
      dl([
        ["Committed block", pre ? `Ethereum mainnet block ${pre.blockNumber}` : "Not yet"],
        ["Head when committed", pre?.headAtCommit != null ? `${pre.headAtCommit} (at least ${pre.minBlocksAhead} blocks ahead)` : "—"],
        ["Committed at", fmtTime(pre?.committedAt)],
        ["Look it up", pre?.lookupUrl ? el("a", { href: pre.lookupUrl, rel: "noopener noreferrer" }, pre.lookupUrl) : "—"],
        ["Block hash", applied?.blockHash ? full(applied.blockHash, "Block hash") : "Not yet"],
        ["Applied value", applied ? full(applied.value, "Beacon value") : "Not yet"],
        ["Iterations (2^n)", applied ? String(applied.iterations) : "—"],
      ]),
      el(
        "p",
        { class: "field-hint" },
        "Check it independently: open the block on any explorer, or ask any mainnet node with eth_getBlockByNumber, and compare its hash with the block hash above. The applied value is that hash without 0x."
      )
    ),
    el(
      "section",
      { class: "panel", "aria-labelledby": "who-h" },
      el("h2", { id: "who-h" }, "Participation"),
      el(
        "p",
        {},
        `Invite only. ${(tr.participation?.invitees || []).filter((i) => i.status === "active").length} active invites, listed by pseudonymous id. Handles and email addresses are never published.`
      ),
      tr.participation?.invitees?.length
        ? el("p", { class: "mono" }, tr.participation.invitees.map((i) => `${i.id} (${i.status})`).join(", "))
        : null
    ),
    tr.exported
      ? el(
          "section",
          { class: "panel", "aria-labelledby": "exp-h" },
          el("h2", { id: "exp-h" }, "Exported artifacts"),
          el("p", { class: "notice notice-warn" }, "Not deployed and not trusted until a human has reviewed them. The Solidity verifier is not copied into smart-contracts/."),
          el(
            "ul",
            { class: "link-rows" },
            ...Object.entries(tr.exported.files).map(([f, info]) =>
              el("li", {}, el("a", { href: `/api/ceremonies/${id}/export/${encodeURIComponent(f)}`, download: f }, f), ` `, full(info, "SHA-256"))
            )
          )
        )
      : null,
    el("p", { class: "field-hint" }, tr.security)
  );
}

async function boot() {
  const id = idFromPath();
  if (!id) {
    fill(root, el("p", { class: "notice notice-error" }, "No ceremony id in the address."));
    return;
  }
  try {
    const tr = await api(`/api/ceremonies/${encodeURIComponent(id)}/transcript.json`);
    document.getElementById("transcript-title").textContent = `Transcript: ${tr.circuit?.label || tr.circuit?.name || id}`;
    render(tr, id);
  } catch (err) {
    fill(root, el("p", { class: "notice notice-error" }, err?.status === 404 ? "No ceremony with that id on this Node." : `Could not load: ${errorText(err)}`));
  }
}

boot();

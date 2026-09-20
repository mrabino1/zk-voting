/* NOT FOR PROFIT — civic public good, not a commercial product.
 * Shared hourly disclosure snapshot (polling-place unlinkability).
 * Vote proofs appear only after the hour that contained them has closed.
 */
import { t } from "./i18n.js";

(function (global) {
  "use strict";

  function esc(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fmtTime(ts) {
    if (ts == null || ts === "") return "—";
    const n = Number(ts);
    const d = Number.isFinite(n) ? new Date(n > 1e12 ? n : n * 1000) : new Date(ts);
    if (Number.isNaN(d.getTime())) return String(ts);
    return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
  }

  function formatCountdown(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return h + "h " + String(m).padStart(2, "0") + "m " + String(sec).padStart(2, "0") + "s";
    if (m > 0) return m + "m " + String(sec).padStart(2, "0") + "s";
    return s + "s";
  }

  function remainingSeconds(disclosure, fetchedAtMs, nowMs) {
    const d = disclosure || {};
    const now = nowMs != null ? nowMs : Date.now();
    if (d.secondsUntilNext != null && Number.isFinite(Number(d.secondsUntilNext))) {
      const elapsed = Math.floor((now - (fetchedAtMs || now)) / 1000);
      return Math.max(0, Number(d.secondsUntilNext) - elapsed);
    }
    const next = Number(d.nextPublishAt);
    if (!Number.isFinite(next)) return 0;
    const unix = Math.floor(now / 1000);
    return Math.max(0, next - unix);
  }

  function snapshotHtml(disclosure, fetchedAtMs) {
    const d = disclosure || {};
    const last = d.lastClosedHourAt != null ? d.lastClosedHourAt : d.lastPublishedAt;
    const next = d.nextPublishAt;
    const remaining = remainingSeconds(d, fetchedAtMs);
    const ballots = d.acceptedBallotsDisclosed;
    const ballotsText = typeof ballots === "number" ? String(ballots) : "—";
    const interval = Number(d.intervalSeconds) || 0;
    const note =
      d.note ||
      t("disclosure.note");
    let nextVisible;
    let nextHidden = t("disclosure.nextAt", { time: fmtTime(next) });
    if (interval <= 0) {
      nextVisible = t("disclosure.immediate");
      nextHidden = t("disclosure.immediateHidden");
    } else if (remaining === 0) {
      nextVisible = t("disclosure.hourClosed", { time: fmtTime(next) });
    } else {
      nextVisible = formatCountdown(remaining) + " · " + fmtTime(next);
    }
    return `<p class="disclosure-note">${esc(note)}</p>
      <dl class="disclosure-stats">
        <div>
          <dt>${esc(t("disclosure.lastClosed"))}</dt>
          <dd>${esc(fmtTime(last))}</dd>
        </div>
        <div>
          <dt>${esc(t("disclosure.ballots"))}</dt>
          <dd class="num">${esc(ballotsText)}</dd>
        </div>
        <div>
          <dt>${esc(t("disclosure.next"))}</dt>
          <dd>
            <span class="countdown" data-next="${esc(next ?? "")}">${esc(nextVisible)}</span>
            <span class="visually-hidden">${esc(nextHidden)}</span>
          </dd>
        </div>
      </dl>`;
  }

  function paint(el, disclosure, fetchedAtMs) {
    if (!el || !disclosure) return fetchedAtMs || Date.now();
    const at = fetchedAtMs || Date.now();
    el.innerHTML = snapshotHtml(disclosure, at);
    return at;
  }

  function tickCountdown(el, disclosure, fetchedAtMs) {
    if (!el || !disclosure) return remainingSeconds(disclosure, fetchedAtMs);
    const remaining = remainingSeconds(disclosure, fetchedAtMs);
    const span = el.querySelector(".countdown");
    const interval = Number(disclosure.intervalSeconds) || 0;
    if (span) {
      if (interval <= 0) span.textContent = t("disclosure.immediate");
      else if (remaining === 0) span.textContent = t("disclosure.hourClosed", { time: fmtTime(disclosure.nextPublishAt) });
      else span.textContent = formatCountdown(remaining) + " · " + fmtTime(disclosure.nextPublishAt);
    }
    return remaining;
  }

  global.RepublicDisclosure = {
    esc,
    fmtTime,
    formatCountdown,
    remainingSeconds,
    snapshotHtml,
    paint,
    tickCountdown,
  };
})(typeof window !== "undefined" ? window : globalThis);

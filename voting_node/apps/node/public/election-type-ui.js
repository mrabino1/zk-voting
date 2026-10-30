/**
 * Shared labels for poll vs vote elections.
 * A vote shows "Results sealed until {end}" and no counts.
 */

import { t } from "./i18n.js";

export function electionTypeNameOf(election) {
  if (!election) return "poll";
  const name = String(election.electionTypeName || "").toLowerCase();
  if (name === "vote" || name === "poll") return name;
  if (election.electionType === 1 || election.electionType === "1") return "vote";
  return "poll";
}

export function electionTypeLabel(election) {
  return electionTypeNameOf(election) === "vote" ? t("results.typeVote") : t("results.typePoll");
}

export function resultsAreSealed(election) {
  if (!election) return false;
  return Boolean(election.resultsSealed || election.sealed || election.results?.sealed);
}

export function sealedUntilLabel(election, formatTime) {
  const end = election?.sealedUntil ?? election?.cutoffTime ?? null;
  const formatted = typeof formatTime === "function" ? formatTime(end) : end == null ? "" : String(end);
  return t("results.sealedUntil", { end: formatted });
}

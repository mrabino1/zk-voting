/**
 * NOT FOR PROFIT — civic public good. Not a commercial product.
 * Display branding for client scripts. The server renders the current name
 * (site admin > BRAND_NAME env > "ZK-Voting") into <meta name="brand-*"> on
 * every page; this module only reads it.
 */

export const DEFAULT_BRAND_NAME = "ZK-Voting";

function meta(name) {
  if (typeof document === "undefined" || typeof document.querySelector !== "function") return "";
  const el = document.querySelector(`meta[name="${name}"]`);
  return (el && el.getAttribute("content")) || "";
}

/** Product display name, e.g. "ZK-Voting". */
export function brandName() {
  return meta("brand-name").trim() || DEFAULT_BRAND_NAME;
}

export function brandShortName() {
  return meta("brand-short-name").trim() || brandName();
}

export function brandTagline() {
  return meta("brand-tagline").trim();
}

export function escapeBrandHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

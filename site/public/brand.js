/**
 * Display name for the public landing page.
 * The meta tag is the source of truth. The built-in default is used when
 * that tag is missing (tests, and a page opened before the tag is set).
 */

export const DEFAULT_BRAND_NAME = "ZK-Voting";

export function brandName() {
  if (typeof document === "undefined") return DEFAULT_BRAND_NAME;
  const el = document.querySelector('meta[name="brand-name"]');
  const value = el && el.getAttribute("content");
  const trimmed = value && String(value).trim();
  return trimmed || DEFAULT_BRAND_NAME;
}

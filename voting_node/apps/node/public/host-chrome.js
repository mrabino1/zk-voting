/**
 * NOT FOR PROFIT — ZK-Voting is a civic public good. Not a commercial product.
 *
 * A named host is the operator's install: their hostname, their database,
 * their pages. The Demo label is only for a process that has not set VOTE_FQDN.
 */

export function namedVotingHost(config) {
  return Boolean(String(config?.vote?.fqdn || "").trim());
}

/** True only after config loaded and the host has no voting hostname. */
export function showsDemoChrome(config) {
  return Boolean(config) && !namedVotingHost(config);
}

export function footerMetaKey(config) {
  return namedVotingHost(config) ? "chrome.footerMetaHost" : "chrome.footerMeta";
}

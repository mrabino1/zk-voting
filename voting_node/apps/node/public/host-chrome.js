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

/** The Northbridge sample roll is only for an unnamed demo. A VOTE_FQDN install never shows it. */
export function allowSampleRoll(config) {
  return !namedVotingHost(config);
}

export function footerMetaKey(config) {
  return namedVotingHost(config) ? "chrome.footerMetaHost" : "chrome.footerMeta";
}

function clientBrandOf(config) {
  const brand = config?.clientBrand;
  if (brand?.active) return brand;
  if (!namedVotingHost(config)) return null;
  return { active: true, name: "", logoUrl: "", href: "", subtitle: "" };
}

/** Drop civic chrome once /api/config says this process has a VOTE_FQDN. */
export function paintClientHost(doc, config) {
  if (!doc?.documentElement) return;
  const brand = clientBrandOf(config);
  if (!brand) {
    if (config) delete doc.documentElement.dataset.clientHost;
    return;
  }
  doc.documentElement.dataset.clientHost = "1";
  doc.querySelectorAll(".nfp-banner, .office-badge, .poll-signal").forEach((el) => el.remove());
  const sub = doc.querySelector('.brand-sub[data-i18n="chrome.brandSub"]');
  if (sub) {
    sub.removeAttribute("data-i18n");
    if (brand.subtitle) sub.textContent = brand.subtitle;
    else sub.remove();
  }
  const link = doc.querySelector("a.brand");
  if (link && brand.href) link.setAttribute("href", brand.href);
  const mark = doc.querySelector(".brand-mark img");
  if (mark && brand.logoUrl && mark.dataset.brandLogo !== "layout") mark.setAttribute("src", brand.logoUrl);
  const nameEl = doc.querySelector(".brand-name");
  if (nameEl && brand.name) {
    nameEl.setAttribute("title", brand.name);
    nameEl.textContent = brand.name;
  }
  const footer = doc.querySelector("footer.site-footer");
  if (footer && !footer.querySelector(".powered-by")) {
    footer.classList.add("site-footer-client");
    footer.textContent = "";
    const p = doc.createElement("p");
    p.className = "powered-by";
    const a = doc.createElement("a");
    a.className = "powered-by-link";
    a.href = "https://zk-voting.org";
    const img = doc.createElement("img");
    img.className = "powered-by-mark";
    img.src = "/brand-mark.svg";
    img.alt = "";
    img.width = 16;
    img.height = 16;
    a.append(img, doc.createTextNode("powered by zk-voting.org"));
    p.append(a);
    footer.append(p);
  }
}

/**
 * NOT FOR PROFIT — Republic is a civic public good. Not a commercial product.
 *
 * History router with hash fallback for static hosting.
 * Routes: `/`, `/public`, `/about`, `/faq`, `/p/:slug`, `/signin`, `/me`, `/app`,
 * `/office`, `/office/pages`, `/office/site`,
 * `/register`, `/vote/:id`, `/v/:shortCode`, `/e/:shortCode`,
 * `/elections`, `/elections/:id/results`, `/elections/:id/info`, `/terms`, `/receipt`,
 * `/outcomes`, `/outcomes/verify`, `/outcomes/:id`, `/monitor`,
 * `/polls`, `/polls/:id`, `/polls/:id/vote`, `/polls/:id/results`
 */

import { isStandaloneHtmlPath } from "./audience.js";

const listeners = new Set();

function pathFromLocation(loc = window.location) {
  let path = loc.pathname || "/";
    if (path.endsWith("/index.html")) path = "/";
  if (/\.html$/i.test(path)) path = path.replace(/\.html$/i, "") || "/";
  const hash = String(loc.hash || "").replace(/^#/, "");
  if (hash.startsWith("/")) {
    path = hash.split("?")[0];
  }
  path = path.replace(/\/+$/, "") || "/";
  return path;
}

function queryFromLocation(loc = window.location) {
  const hash = String(loc.hash || "").replace(/^#/, "");
  if (hash.includes("?")) return new URLSearchParams(hash.split("?")[1] || "");
  return new URLSearchParams(loc.search || "");
}

export function parseRoute(loc = window.location) {
  const path = pathFromLocation(loc);
  const query = queryFromLocation(loc);
  if (path === "/") return { name: "home", path, params: {}, query };
  if (path === "/public") return { name: "publicHome", path, params: {}, query };
  if (path === "/about") return { name: "about", path, params: {}, query };
  if (path === "/faq") return { name: "faq", path, params: {}, query };
  if (path === "/terms") return { name: "terms", path, params: {}, query };
  if (path === "/signin") return { name: "signin", path, params: {}, query };
  if (path === "/me" || path === "/app") return { name: "desk", path, params: {}, query };
  if (path === "/office/pages/new") return { name: "officePageNew", path, params: {}, query };
  const officePage = path.match(/^\/office\/pages\/([^/]+)$/);
  if (officePage) {
    return {
      name: "officePageEdit",
      path,
      params: { id: decodeURIComponent(officePage[1]) },
      query,
    };
  }
  if (path === "/office/pages") return { name: "officePages", path, params: {}, query };
  if (path === "/office/site") return { name: "officeSite", path, params: {}, query };
  if (path === "/office") return { name: "office", path, params: {}, query };
  const cmsPage = path.match(/^\/p\/([^/]+)$/);
  if (cmsPage) {
    return {
      name: "cmsPage",
      path,
      params: { slug: decodeURIComponent(cmsPage[1]) },
      query,
    };
  }
  if (path === "/receipt" || path === "/proof") return { name: "receipt", path, params: {}, query };
  if (path === "/outcomes/verify" || path === "/monitor/verify") {
    return { name: "outcomeVerify", path, params: {}, query };
  }
  if (path === "/outcomes" || path === "/monitor") return { name: "outcomes", path, params: {}, query };
  const outcome = path.match(/^\/(?:outcomes|monitor)\/([^/]+)$/);
  if (outcome) {
    return {
      name: "outcome",
      path,
      params: { id: decodeURIComponent(outcome[1]) },
      query,
    };
  }
  if (path === "/register") return { name: "register", path, params: {}, query };
  if (path === "/elections") return { name: "resultsIndex", path, params: {}, query };
  const results = path.match(/^\/elections\/([^/]+)\/results$/);
  if (results) {
    return {
      name: "results",
      path,
      params: { id: decodeURIComponent(results[1]) },
      query,
    };
  }
  const infoOption = path.match(/^\/elections\/([^/]+)\/info\/([^/]+)\/([^/]+)$/);
  if (infoOption) {
    return {
      name: "option-info",
      path,
      params: {
        id: decodeURIComponent(infoOption[1]),
        questionId: decodeURIComponent(infoOption[2]),
        optionId: decodeURIComponent(infoOption[3]),
      },
      query,
    };
  }
  const info = path.match(/^\/elections\/([^/]+)\/info$/);
  if (info) {
    return {
      name: "election-info",
      path,
      params: { id: decodeURIComponent(info[1]) },
      query,
    };
  }
  const vote = path.match(/^\/vote\/([^/]+)$/);
  if (vote) {
    return {
      name: "vote",
      path,
      params: { id: decodeURIComponent(vote[1]) },
      query,
    };
  }
  const short = path.match(/^\/(?:v|e)\/([^/]+)$/);
  if (short) {
    return {
      name: "vote",
      path,
      params: { id: decodeURIComponent(short[1]) },
      query,
    };
  }
  if (path === "/polls") return { name: "polls", path, params: {}, query };
  const pollVote = path.match(/^\/polls\/([^/]+)\/vote$/);
  if (pollVote) {
    return {
      name: "pollVote",
      path,
      params: { id: decodeURIComponent(pollVote[1]) },
      query,
    };
  }
  const pollResults = path.match(/^\/polls\/([^/]+)\/results$/);
  if (pollResults) {
    return {
      name: "pollResults",
      path,
      params: { id: decodeURIComponent(pollResults[1]) },
      query,
    };
  }
  const pollDetail = path.match(/^\/polls\/([^/]+)$/);
  if (pollDetail) {
    return {
      name: "poll",
      path,
      params: { id: decodeURIComponent(pollDetail[1]) },
      query,
    };
  }
  const electionAlias = path.match(/^\/elections\/([^/]+)$/);
  if (electionAlias) {
    return {
      name: "results",
      path,
      params: { id: decodeURIComponent(electionAlias[1]) },
      query,
    };
  }
  return { name: "notfound", path, params: {}, query };
}

export function shouldUseHash() {
  if (typeof window === "undefined") return false;
  if (window.location.protocol === "file:") return true;
  if (window.location.hash.startsWith("#/")) return true;
  return false;
}

function emit() {
  const route = parseRoute();
  for (const fn of listeners) fn(route);
}

export function navigate(path, { replace = false } = {}) {
  const next = path.startsWith("/") ? path : `/${path}`;
  const pathOnly = next.split("?")[0].split("#")[0];
  if (typeof window !== "undefined" && isStandaloneHtmlPath(pathOnly)) {
    if (replace) window.location.replace(next);
    else window.location.assign(next);
    return;
  }
  if (shouldUseHash()) {
    const url = `${window.location.pathname}${window.location.search}#${next}`;
    if (replace) window.location.replace(url);
    else window.location.hash = next;
    return;
  }
  if (replace) window.history.replaceState({ path: next }, "", next);
  else window.history.pushState({ path: next }, "", next);
  emit();
}

export function startRouter(onChange) {
  listeners.add(onChange);
  window.addEventListener("popstate", emit);
  window.addEventListener("hashchange", emit);
  document.addEventListener("click", (event) => {
    const a = event.target.closest("a[data-nav]");
    if (!a || event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const href = a.getAttribute("href");
    if (!href || href.startsWith("mailto:") || href.startsWith("http")) return;
    const url = new URL(href, window.location.origin);
    if (url.origin !== window.location.origin) return;
    if (isStandaloneHtmlPath(url.pathname)) return;
    event.preventDefault();
    if (url.hash === "#how-it-works") {
      navigate("/public");
      queueMicrotask(() => {
        document.getElementById("how-it-works")?.scrollIntoView({ block: "start" });
        document.getElementById("how-it-works")?.focus?.();
      });
      return;
    }
    if (url.hash.startsWith("#/") && (url.pathname === "/" || url.pathname.endsWith("/index.html"))) {
      navigate(url.hash.slice(1).split("?")[0]);
      return;
    }
    navigate(`${url.pathname}${url.search}`);
  });
  onChange(parseRoute());
  return () => listeners.delete(onChange);
}

export function currentRoute() {
  return parseRoute();
}

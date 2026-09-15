/**
 * NOT FOR PROFIT — Republic is a civic public good. Not a commercial product.
 *
 * History router with hash fallback for static hosting.
 * Routes: `/`, `/register`, `/vote/:id`, `/elections`, `/elections/:id/results`,
 * `/elections/:id/info`, `/elections/:id/info/:questionId/:optionId`
 */

const listeners = new Set();

function pathFromLocation(loc = window.location) {
  let path = loc.pathname || "/";
  if (path.endsWith("/index.html")) path = "/";
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
    event.preventDefault();
    if (url.hash === "#how-it-works") {
      navigate("/");
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

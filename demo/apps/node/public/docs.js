/**
 * NOT FOR PROFIT — ZK-Voting is a civic public good. Not a commercial product.
 * Self-hosting docs: renders docs/self-hosting/*.md at /docs and /docs/<slug>.
 * The Markdown comes from this server (/docs-src/self-hosting/). Every piece of
 * text is escaped; only a small, fixed set of elements is produced.
 */

const SRC = "/docs-src/self-hosting";
import { brandName } from "./brand.js";

const SITE = `${brandName()} docs`;

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** GitHub-style heading anchor. */
export function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

/** Map a link in the Markdown to a safe href, or null to render it as text. */
export function docHref(target) {
  const raw = String(target || "").trim();
  if (/^https?:\/\//i.test(raw)) return { href: raw, external: true };
  if (raw.startsWith("#")) return { href: raw };
  const md = /^\.\/([a-z0-9-]+|README)\.md(#[\w-]*)?$/i.exec(raw);
  if (md) {
    const slug = md[1];
    const hash = md[2] || "";
    return { href: (slug === "README" ? "/docs" : `/docs/${slug}`) + hash };
  }
  if (/^\/(?!\/)[\w\-./?=&#%]*$/.test(raw)) return { href: raw };
  return null;
}

function inline(text) {
  const codes = [];
  let s = String(text).replace(/`([^`]+)`/g, (_m, code) => {
    codes.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  const links = [];
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, target) => {
    const resolved = docHref(target);
    const inner = inlineText(label, codes);
    if (!resolved) {
      // Repository files outside docs/self-hosting show as a path; anything else as plain text.
      links.push(/^\.{1,2}\//.test(target) ? `<code>${escapeHtml(target.replace(/^(\.{1,2}\/)+/, ""))}</code>` : inner);
    } else if (resolved.external) {
      links.push(`<a href="${escapeHtml(resolved.href)}" rel="noopener noreferrer">${inner}</a>`);
    } else {
      links.push(`<a href="${escapeHtml(resolved.href)}">${inner}</a>`);
    }
    return `\u0001${links.length - 1}\u0001`;
  });
  s = inlineText(s, codes);
  return s.replace(/\u0001(\d+)\u0001/g, (_m, i) => links[Number(i)]);
}

function inlineText(text, codes) {
  return escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])_([^_]+)_(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>")
    .replace(/\u0000(\d+)\u0000/g, (_m, i) => codes[Number(i)]);
}

const LIST_RE = /^(\s*)([-*]|\d+\.)\s+(.*)$/;
const FENCE_RE = /^\s*```/;

function isTableSep(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line || "");
}

function cells(line) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((c) => c.trim());
}

function startsBlock(line, next) {
  return (
    /^#{1,4}\s/.test(line) ||
    FENCE_RE.test(line) ||
    LIST_RE.test(line) ||
    /^>\s?/.test(line) ||
    (/^\s*\|/.test(line) && isTableSep(next))
  );
}

/**
 * Render Markdown to HTML. Supports the subset used in docs/self-hosting:
 * headings, paragraphs, fenced code, lists (with nested blocks), tables,
 * block quotes, inline code, bold, emphasis, and links.
 */
export function renderMarkdown(markdown, headings = []) {
  const lines = String(markdown).replace(/\r\n?/g, "\n").split("\n");
  return renderBlocks(lines, headings);
}

function renderBlocks(lines, headings) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    if (FENCE_RE.test(line)) {
      const indent = line.match(/^\s*/)[0].length;
      const lang = line.trim().slice(3).trim();
      const body = [];
      i += 1;
      while (i < lines.length && !FENCE_RE.test(lines[i])) {
        body.push(lines[i].slice(Math.min(indent, lines[i].match(/^\s*/)[0].length)));
        i += 1;
      }
      i += 1;
      const cls = lang ? ` class="language-${escapeHtml(lang.replace(/[^\w-]/g, ""))}"` : "";
      out.push(`<pre tabindex="0"><code${cls}>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const text = h[2].trim();
      const id = slugify(text.replace(/`/g, ""));
      headings.push({ level, text, id });
      out.push(`<h${level} id="${escapeHtml(id)}">${inline(text)}</h${level}>`);
      i += 1;
      continue;
    }
    if (/^\s*\|/.test(line) && isTableSep(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        rows.push(cells(lines[i]));
        i += 1;
      }
      const thead = `<tr>${head.map((c) => `<th scope="col">${inline(c)}</th>`).join("")}</tr>`;
      const tbody = rows
        .map((r) => `<tr>${head.map((_c, k) => `<td>${inline(r[k] || "")}</td>`).join("")}</tr>`)
        .join("");
      out.push(`<div class="table-wrap" tabindex="0" role="region" aria-label="Table"><table><thead>${thead}</thead><tbody>${tbody}</tbody></table></div>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const body = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        body.push(lines[i].replace(/^>\s?/, ""));
        i += 1;
      }
      out.push(`<blockquote>${renderBlocks(body, headings)}</blockquote>`);
      continue;
    }
    const li = LIST_RE.exec(line);
    if (li) {
      const baseIndent = li[1].length;
      const ordered = /\d/.test(li[2]);
      const start = ordered ? parseInt(li[2], 10) : 1;
      const items = [];
      while (i < lines.length) {
        const m = LIST_RE.exec(lines[i]);
        if (!m || m[1].length !== baseIndent || /\d/.test(m[2]) !== ordered) break;
        const width = m[1].length + m[2].length + 1;
        const body = [m[3]];
        i += 1;
        let inFence = false;
        while (i < lines.length) {
          const l = lines[i];
          const ind = l.match(/^\s*/)[0].length;
          if (FENCE_RE.test(l) && (inFence || ind >= width - 1)) inFence = !inFence;
          if (inFence || !l.trim() || ind >= Math.min(width, baseIndent + 2)) {
            if (!l.trim() && !inFence) {
              const nextLine = lines[i + 1];
              if (nextLine === undefined) break;
              const nextInd = nextLine.match(/^\s*/)[0].length;
              if (nextLine.trim() && nextInd < Math.min(width, baseIndent + 2)) break;
            }
            body.push(l.slice(Math.min(width, ind)));
            i += 1;
            continue;
          }
          break;
        }
        while (body.length && !body[body.length - 1].trim()) body.pop();
        items.push(body);
        while (i < lines.length && !lines[i].trim()) {
          const nxt = lines.slice(i).find((l) => l.trim());
          const m2 = nxt && LIST_RE.exec(nxt);
          if (m2 && m2[1].length === baseIndent) i += 1;
          else break;
        }
      }
      const tag = ordered ? "ol" : "ul";
      const startAttr = ordered && start !== 1 ? ` start="${start}"` : "";
      const html = items
        .map((body) => {
          const simple = body.length === 1 || body.slice(1).every((l) => !l.trim() || (!startsBlock(l) && !FENCE_RE.test(l)));
          if (simple && !body.some((l) => !l.trim())) return `<li>${inline(body.join(" "))}</li>`;
          return `<li>${renderBlocks(body, headings)}</li>`;
        })
        .join("");
      out.push(`<${tag}${startAttr}>${html}</${tag}>`);
      continue;
    }
    const para = [line.trim()];
    i += 1;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i], lines[i + 1])) {
      para.push(lines[i].trim());
      i += 1;
    }
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }
  return out.join("\n");
}

export function slugFromPath(pathname) {
  const clean = String(pathname || "/docs").replace(/\.html$/i, "").replace(/\/+$/, "");
  const m = /^\/docs(?:\/([a-z0-9-]+))?$/i.exec(clean);
  if (!m) return null;
  return m[1] ? m[1].toLowerCase() : "README";
}

function pageHref(slug) {
  return slug === "README" ? "/docs" : `/docs/${slug}`;
}

function renderSidebar(nav, current) {
  const host = document.getElementById("docs-nav");
  if (!host) return;
  const narrow = typeof window.matchMedia === "function" && window.matchMedia("(max-width: 48rem)").matches;
  const parts = [`<p class="docs-sidebar-title"><a href="/docs">${escapeHtml(nav.title || "Self-hosting")}</a></p>`];
  /* On phones the page list starts collapsed so the article is visible first. */
  parts.push(`<details class="docs-nav-details"${narrow ? "" : " open"}><summary>All guides</summary>`);
  (nav.sections || []).forEach((section, n) => {
    const id = `docs-group-${n}`;
    parts.push(`<p class="docs-group" id="${id}">${escapeHtml(section.title)}</p>`);
    parts.push(`<ul aria-labelledby="${id}">`);
    for (const page of section.pages || []) {
      const cur = page.slug === current ? ' aria-current="page"' : "";
      parts.push(`<li><a href="${pageHref(page.slug)}"${cur}>${escapeHtml(page.title)}</a></li>`);
    }
    parts.push("</ul>");
  });
  parts.push("</details>");
  host.innerHTML = parts.join("");
  if (typeof window.matchMedia === "function") {
    const wide = window.matchMedia("(min-width: 48.01rem)");
    const details = host.querySelector(".docs-nav-details");
    /* The summary is hidden on wide screens, so the list must stay open there. */
    const sync = () => { if (wide.matches && details) details.open = true; };
    if (typeof wide.addEventListener === "function") wide.addEventListener("change", sync);
  }
}

function renderToc(headings) {
  const toc = document.getElementById("docs-toc");
  if (!toc) return;
  const h2 = headings.filter((h) => h.level === 2);
  if (h2.length < 2) {
    toc.hidden = true;
    return;
  }
  toc.querySelector("ul").innerHTML = h2
    .map((h) => `<li><a href="#${escapeHtml(h.id)}">${inline(h.text)}</a></li>`)
    .join("");
  toc.hidden = false;
}

function renderPager(pages, current) {
  const pager = document.getElementById("docs-pager");
  if (!pager) return;
  const idx = pages.findIndex((p) => p.slug === current);
  const prev = idx > 0 ? pages[idx - 1] : null;
  const next = idx >= 0 && idx < pages.length - 1 ? pages[idx + 1] : null;
  pager.innerHTML = [
    prev ? `<a class="prev" href="${pageHref(prev.slug)}" rel="prev"><span class="pager-label">Previous</span>${escapeHtml(prev.title)}</a>` : "",
    next ? `<a class="next" href="${pageHref(next.slug)}" rel="next"><span class="pager-label">Next</span>${escapeHtml(next.title)}</a>` : "",
  ].join("");
}

async function load() {
  const article = document.getElementById("docs-article");
  const slug = slugFromPath(window.location.pathname);
  let nav = { title: "Self-hosting", sections: [] };
  try {
    const res = await fetch(`${SRC}/nav.json`, { headers: { Accept: "application/json" } });
    if (res.ok) nav = await res.json();
  } catch {
    /* sidebar stays minimal */
  }
  const pages = (nav.sections || []).flatMap((s) => s.pages || []);
  const page = pages.find((p) => p.slug === slug);
  renderSidebar(nav, page ? slug : null);

  if (!page) {
    article.innerHTML = `<h1>Page not found</h1><p>There is no self-hosting guide at this address. Start from the <a href="/docs">overview</a>.</p>`;
    document.title = `Page not found — ${SITE}`;
    article.removeAttribute("aria-busy");
    return;
  }
  try {
    const res = await fetch(`${SRC}/${slug}.md`, { headers: { Accept: "text/markdown" } });
    if (!res.ok) throw new Error(String(res.status));
    const headings = [];
    article.innerHTML = renderMarkdown(await res.text(), headings);
    const h1 = headings.find((h) => h.level === 1);
    document.title = `${h1 ? h1.text.replace(/`/g, "") : page.title} — ${SITE}`;
    renderToc(headings);
    renderPager(pages, slug);
    if (window.location.hash) {
      const target = document.getElementById(decodeURIComponent(window.location.hash.slice(1)));
      if (target) target.scrollIntoView();
    }
  } catch {
    article.innerHTML = `<h1>${escapeHtml(page.title)}</h1><p>This guide could not be loaded. It is also in the repository at <code>docs/self-hosting/${escapeHtml(slug)}.md</code>.</p>`;
  } finally {
    article.removeAttribute("aria-busy");
  }
}

if (typeof document !== "undefined" && document.getElementById("docs-article")) {
  load();
}

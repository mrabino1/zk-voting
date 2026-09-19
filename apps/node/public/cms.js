/**
 * NOT FOR PROFIT — Republic is a civic public good. Not a commercial product.
 * Jurisdiction CMS: clerks edit pages like a WordPress site. One shared factory.
 */

import { audienceOf, isOfficer, signInHref } from "./audience.js";
import { logout } from "./signin.js";

export const SHARED_DEPLOYMENT_NOTE =
  "Fork this Node for a clerk desk. Do not deploy a new ElectionFactory for each jurisdiction. Pin the one shared factory, inbox, and verifier; officers update pages here like a WordPress site.";

function mount(node, ...children) {
  node.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false));
}

const BLOCK_TYPES = [
  { type: "heading", label: "Heading" },
  { type: "paragraph", label: "Paragraph" },
  { type: "note", label: "Note" },
  { type: "faq", label: "FAQ item" },
  { type: "cta", label: "Button / link" },
];

function emptyBlock(type) {
  if (type === "heading") return { type, text: "" };
  if (type === "note") return { type, text: "" };
  if (type === "faq") return { type, q: "", a: "" };
  if (type === "cta") return { type, label: "", href: "/" };
  return { type: "paragraph", text: "" };
}

export function canEditPages(me) {
  if (!me?.user) return false;
  if (me.user.role === "platform_admin") return true;
  const grants = me.jurisdictionRoles || [];
  return grants.some((g) => String(g.role || "").toLowerCase() === "clerk");
}

export async function loadPublicCms(api) {
  try {
    return await api("/api/pages");
  } catch {
    return {
      nfp: true,
      pages: [],
      nav: [],
      overlays: { home: null, about: null, faq: null },
      site: null,
      contracts: null,
    };
  }
}

function isInternalHref(href) {
  return typeof href === "string" && href.startsWith("/") && !href.startsWith("//");
}

export function renderBlocks(h, blocks) {
  return (blocks || []).map((block) => {
    if (!block) return null;
    if (block.type === "heading") return h("h2", { text: block.text || "" });
    if (block.type === "note") {
      return h("div", { class: "notice" }, h("p", { text: block.text || "" }));
    }
    if (block.type === "cta" && block.label && block.href) {
      const attrs = {
        class: "btn",
        href: block.href,
        text: block.label,
      };
      if (isInternalHref(block.href)) attrs["data-nav"] = "";
      return h("p", { class: "cta-row" }, h("a", attrs));
    }
    if (block.type === "faq" && block.q) {
      return h(
        "details",
        { class: "faq-item" },
        h("summary", {}, h("span", { class: "faq-q", text: block.q })),
        h("div", { class: "faq-a" }, h("p", { text: block.a || "" }))
      );
    }
    if (block.text) return h("p", { text: block.text });
    return null;
  });
}

function clerkGate(h, ctx, me, routePath) {
  const { navigate } = ctx;
  if (!me?.user) {
    navigate(signInHref(routePath || "/office/pages"), { replace: true });
    return true;
  }
  if (!isOfficer(me)) {
    return "officer";
  }
  if (!canEditPages(me)) {
    return "clerk";
  }
  return false;
}

function gateScreen(h, me, kind) {
  const title = kind === "officer" ? "Officer access required" : "Clerk access required";
  const copy =
    kind === "officer"
      ? `Signed in as ${me.user.handle} (${me.user.role}). This hub is for election officials.`
      : `Signed in as ${me.user.handle} (${me.user.role}). Pages are edited by clerks and the Node host, like a WordPress site. Registrars and tally operators use the back office for the roll and counts.`;
  return h(
    "div",
    { class: "page-head audience-gate", id: "officer-gate" },
    h("p", { class: "kicker", text: "Pages" }),
    h("h1", { text: title }),
    h("p", { class: "lede", text: copy }),
    h(
      "div",
      { class: "cta-row" },
      h("a", { class: "btn", href: "/office", "data-nav": "", text: "Admin hub" }),
      h("a", { class: "btn btn-secondary", href: "/me", "data-nav": "", text: "My desk" }),
      h("button", {
        class: "btn btn-secondary",
        type: "button",
        text: "Sign out",
        onClick: async () => {
          await logout();
        },
      })
    )
  );
}

function cmsSubnav(h, current) {
  const items = [
    { href: "/office/pages", id: "pages", label: "Pages" },
    { href: "/office/pages/new", id: "new", label: "New page" },
    { href: "/office/site", id: "site", label: "Site & contracts" },
    { href: "/office", id: "hub", label: "Admin hub" },
  ];
  return h(
    "nav",
    { class: "office-hub", "aria-label": "Page editor" },
    ...items.map((item) =>
      h("a", {
        href: item.href,
        "data-nav": "",
        text: item.label,
        "aria-current": current === item.id ? "page" : undefined,
      })
    )
  );
}

export function renderCmsPage(main, ctx, page) {
  const { h, setTitle } = ctx;
  if (!page) {
    setTitle("Page not found");
    mount(main,
      h("div", { class: "page-head" }, h("h1", { text: "Page not found" })),
      h("p", {}, h("a", { class: "btn", href: "/", "data-nav": "", text: "Public home" }))
    );
    return;
  }
  setTitle(page.title || "Page");
  const audience = audienceOf(ctx.me);
  mount(main, 
    h(
      "div",
      { class: "page-head" },
      h("p", { class: "kicker", text: page.navLabel || "Page" }),
      h("h1", { text: page.title || "Untitled" }),
      audience === "public"
        ? h(
            "div",
            { class: "cta-row" },
            h("a", { class: "btn", href: "/register", "data-nav": "", text: "Register" }),
            h("a", { class: "btn btn-secondary", href: "/signin", "data-nav": "", text: "Sign in" })
          )
        : h(
            "div",
            { class: "cta-row" },
            h("a", { class: "btn", href: "/me", "data-nav": "", text: "My desk" })
          )
    ),
    h("div", { class: "prose cms-prose" }, ...renderBlocks(h, page.blocks))
  );
}

export async function renderOfficePages(main, ctx, bundle) {
  const { h, setTitle, api, announce, route } = ctx;
  const { me } = bundle;
  setTitle("Pages");
  const gate = clerkGate(h, ctx, me, route.path);
  if (gate === true) return;
  if (gate) {
    mount(main, gateScreen(h, me, gate));
    return;
  }

  let list = { pages: [], jurisdictions: [] };
  try {
    list = await api("/api/office/pages");
  } catch (err) {
    mount(main,
      cmsSubnav(h, "pages"),
      h("div", { class: "notice notice-error", role: "alert" }, h("p", { text: err.message }))
    );
    return;
  }

  const rows = list.pages || [];
  mount(main, 
    h(
      "div",
      { class: "page-head" },
      h("p", { class: "kicker", text: "WordPress-style pages" }),
      h("h1", { text: "Update public pages" }),
      h(
        "p",
        { class: "lede" },
        "Fork this Node for your jurisdiction. Keep the one shared ElectionFactory. Clerks edit About, FAQ, home copy, and extra pages here — publish when ready."
      )
    ),
    cmsSubnav(h, "pages"),
    h(
      "div",
      { class: "cta-row" },
      h("a", { class: "btn", href: "/office/pages/new", "data-nav": "", text: "New page" }),
      h("a", { class: "btn btn-secondary", href: "/office/site", "data-nav": "", text: "Shared contracts" })
    ),
    rows.length
      ? h(
          "div",
          { class: "table-wrap" },
          h(
            "table",
            { class: "cms-pages-table" },
            h(
              "thead",
              {},
              h(
                "tr",
                {},
                h("th", { text: "Title" }),
                h("th", { text: "Kind" }),
                h("th", { text: "Status" }),
                h("th", { text: "Jurisdiction" }),
                h("th", { text: "Path" }),
                h("th", { text: "Edit" })
              )
            ),
            h(
              "tbody",
              {},
              ...rows.map((page) =>
                h(
                  "tr",
                  {},
                  h("td", { text: page.title }),
                  h("td", { text: page.kind }),
                  h("td", {}, h("span", { class: `status-pill ${page.status === "published" ? "status-open" : "status-created"}`, text: page.status })),
                  h("td", { text: page.jurisdictionId || "This Node" }),
                  h("td", {}, h("a", { href: page.path, "data-nav": "", text: page.path })),
                  h(
                    "td",
                    {},
                    h("a", {
                      class: "btn btn-secondary",
                      href: `/office/pages/${encodeURIComponent(page.id)}`,
                      "data-nav": "",
                      text: "Edit",
                    })
                  )
                )
              )
            )
          )
        )
      : h("div", { class: "notice" }, h("p", { text: "No pages yet. Create Home, About, FAQ, or a custom page." })),
    h("p", { class: "field-hint", text: SHARED_DEPLOYMENT_NOTE })
  );
  announce(`${rows.length} page${rows.length === 1 ? "" : "s"}`);
}

function field(h, label, control, hint) {
  return h(
    "label",
    { class: "field" },
    h("span", { class: "field-label", text: label }),
    control,
    hint ? h("span", { class: "field-hint", text: hint }) : null
  );
}

function bindInput(el, onChange) {
  el.addEventListener("input", () => onChange(el.value));
  el.addEventListener("change", () => onChange(el.value));
  return el;
}

function blockEditor(h, blocks, onChange) {
  const root = h("div", { class: "cms-blocks" });

  function paint() {
    root.replaceChildren(
      ...blocks.map((block, index) => {
        const typeSelect = h(
          "select",
          { "aria-label": `Block ${index + 1} type` },
          ...BLOCK_TYPES.map((t) =>
            h("option", { value: t.type, selected: t.type === block.type, text: t.label })
          )
        );
        typeSelect.addEventListener("change", () => {
          const next = emptyBlock(typeSelect.value);
          blocks[index] = { ...next, ...keepFields(block, next.type) };
          onChange(blocks);
          paint();
        });

        const body = blockFields(h, block, () => {
          onChange(blocks);
        });

        return h(
          "article",
          { class: "cms-block panel", "data-block-index": String(index) },
          h(
            "div",
            { class: "cms-block-toolbar" },
            typeSelect,
            h("button", {
              class: "btn btn-secondary",
              type: "button",
              text: "Up",
              disabled: index === 0,
              onClick: () => {
                if (index === 0) return;
                const tmp = blocks[index - 1];
                blocks[index - 1] = blocks[index];
                blocks[index] = tmp;
                onChange(blocks);
                paint();
              },
            }),
            h("button", {
              class: "btn btn-secondary",
              type: "button",
              text: "Down",
              disabled: index === blocks.length - 1,
              onClick: () => {
                if (index >= blocks.length - 1) return;
                const tmp = blocks[index + 1];
                blocks[index + 1] = blocks[index];
                blocks[index] = tmp;
                onChange(blocks);
                paint();
              },
            }),
            h("button", {
              class: "btn btn-danger",
              type: "button",
              text: "Remove",
              onClick: () => {
                blocks.splice(index, 1);
                onChange(blocks);
                paint();
              },
            })
          ),
          body
        );
      }),
      h(
        "div",
        { class: "cms-add-blocks cluster" },
        ...BLOCK_TYPES.map((t) =>
          h("button", {
            class: "btn btn-secondary",
            type: "button",
            text: `Add ${t.label.toLowerCase()}`,
            onClick: () => {
              blocks.push(emptyBlock(t.type));
              onChange(blocks);
              paint();
            },
          })
        )
      )
    );
  }

  paint();
  return root;
}

function keepFields(block, type) {
  if (type === "faq") return { q: block.q || block.text || "", a: block.a || "" };
  if (type === "cta") return { label: block.label || block.text || "", href: block.href || "/" };
  return { text: block.text || block.q || block.label || "" };
}

function blockFields(h, block, onChange) {
  if (block.type === "faq") {
    const q = h("input", { type: "text", value: block.q || "", "aria-label": "Question" });
    const a = h("textarea", { rows: "4", "aria-label": "Answer" });
    a.value = block.a || "";
    bindInput(q, (v) => {
      block.q = v;
      onChange();
    });
    bindInput(a, (v) => {
      block.a = v;
      onChange();
    });
    return h("div", { class: "stack" }, field(h, "Question", q), field(h, "Answer", a));
  }
  if (block.type === "cta") {
    const label = h("input", { type: "text", value: block.label || "", "aria-label": "Button label" });
    const href = h("input", { type: "text", value: block.href || "/", "aria-label": "Link" });
    bindInput(label, (v) => {
      block.label = v;
      onChange();
    });
    bindInput(href, (v) => {
      block.href = v;
      onChange();
    });
    return h(
      "div",
      { class: "stack" },
      field(h, "Label", label),
      field(h, "Link", href, "Use /about or https://… (no javascript: URLs).")
    );
  }
  const area =
    block.type === "heading"
      ? h("input", { type: "text", value: block.text || "", "aria-label": "Heading" })
      : h("textarea", { rows: block.type === "note" ? "3" : "6", "aria-label": "Text" });
  if (area.tagName === "TEXTAREA") area.value = block.text || "";
  bindInput(area, (v) => {
    block.text = v;
    onChange();
  });
  return field(h, block.type === "heading" ? "Heading" : "Text", area, "Plain text only. HTML is stripped.");
}

export async function renderOfficePageEditor(main, ctx, bundle, { isNew = false } = {}) {
  const { h, setTitle, api, announce, navigate, route } = ctx;
  const { me } = bundle;
  setTitle(isNew ? "New page" : "Edit page");
  const gate = clerkGate(h, ctx, me, route.path);
  if (gate === true) return;
  if (gate) {
    mount(main, gateScreen(h, me, gate));
    return;
  }

  let meta = { jurisdictions: [] };
  try {
    meta = await api("/api/office/pages");
  } catch {
    meta = { jurisdictions: [] };
  }

  let page = {
    kind: "custom",
    slug: "",
    title: "",
    status: "draft",
    navLabel: "",
    showInNav: false,
    replaceBuiltin: false,
    jurisdictionId: "",
    blocks: [{ type: "paragraph", text: "" }],
  };

  if (!isNew) {
    try {
      const data = await api(`/api/office/pages/${encodeURIComponent(route.params.id)}`);
      page = { ...page, ...data.page, blocks: Array.isArray(data.page.blocks) ? data.page.blocks.map((b) => ({ ...b })) : [] };
      if (!page.blocks.length) page.blocks = [{ type: "paragraph", text: "" }];
    } catch (err) {
      mount(main,
        cmsSubnav(h, "pages"),
        h("div", { class: "notice notice-error", role: "alert" }, h("p", { text: err.message || "Page not found." })),
        h("p", {}, h("a", { class: "btn", href: "/office/pages", "data-nav": "", text: "Back to pages" }))
      );
      return;
    }
  }

  const statusEl = h("p", { class: "field-hint", id: "cms-save-status", text: isNew ? "Draft — not saved yet." : `Last saved ${page.updatedAt || "—"}.` });
  const preview = h("div", { class: "cms-preview prose", "aria-live": "polite" });

  function refreshPreview() {
    mount(preview, h("h2", { class: "cms-preview-title", text: page.title || "Untitled" }), ...renderBlocks(h, page.blocks));
  }

  const titleInput = h("input", { type: "text", value: page.title, id: "cms-title" });
  const slugInput = h("input", { type: "text", value: page.slug, id: "cms-slug" });
  const navInput = h("input", { type: "text", value: page.navLabel || "", id: "cms-nav" });
  const kindSelect = h(
    "select",
    { id: "cms-kind" },
    h("option", { value: "custom", selected: page.kind === "custom", text: "Custom page (/p/…)" }),
    h("option", { value: "home", selected: page.kind === "home", text: "Home overlay" }),
    h("option", { value: "about", selected: page.kind === "about", text: "About overlay" }),
    h("option", { value: "faq", selected: page.kind === "faq", text: "FAQ overlay" })
  );
  const statusSelect = h(
    "select",
    { id: "cms-status" },
    h("option", { value: "draft", selected: page.status === "draft", text: "Draft" }),
    h("option", { value: "published", selected: page.status === "published", text: "Published" })
  );
  const jidSelect = h(
    "select",
    { id: "cms-jid" },
    h("option", { value: "", selected: !page.jurisdictionId, text: "This Node (all visitors)" }),
    ...(meta.jurisdictions || []).map((j) =>
      h("option", {
        value: j.id,
        selected: page.jurisdictionId === j.id,
        text: j.name ? `${j.name} (${j.id})` : j.id,
      })
    )
  );
  const navCheck = h("input", { type: "checkbox", id: "cms-show-nav", checked: Boolean(page.showInNav) });
  const replaceCheck = h("input", { type: "checkbox", id: "cms-replace", checked: Boolean(page.replaceBuiltin) });

  bindInput(titleInput, (v) => {
    page.title = v;
    refreshPreview();
  });
  bindInput(slugInput, (v) => {
    page.slug = v;
  });
  bindInput(navInput, (v) => {
    page.navLabel = v;
  });
  kindSelect.addEventListener("change", () => {
    page.kind = kindSelect.value;
  });
  statusSelect.addEventListener("change", () => {
    page.status = statusSelect.value;
  });
  jidSelect.addEventListener("change", () => {
    page.jurisdictionId = jidSelect.value || null;
  });
  navCheck.addEventListener("change", () => {
    page.showInNav = navCheck.checked;
  });
  replaceCheck.addEventListener("change", () => {
    page.replaceBuiltin = replaceCheck.checked;
  });

  const blocksHost = blockEditor(h, page.blocks, () => {
    refreshPreview();
  });

  async function save() {
    const body = {
      kind: page.kind,
      slug: page.slug,
      title: page.title,
      status: page.status,
      navLabel: page.navLabel,
      showInNav: page.showInNav,
      replaceBuiltin: page.replaceBuiltin,
      jurisdictionId: page.jurisdictionId || null,
      blocks: page.blocks,
    };
    try {
      if (isNew || !page.id) {
        const created = await api("/api/office/pages", { method: "POST", body });
        announce("Page created");
        navigate(`/office/pages/${encodeURIComponent(created.page.id)}`, { replace: true });
        return;
      }
      const updated = await api(`/api/office/pages/${encodeURIComponent(page.id)}`, { method: "PATCH", body });
      page.updatedAt = updated.page.updatedAt;
      page.slug = updated.page.slug;
      page.path = updated.page.path;
      statusEl.textContent = `Saved ${page.updatedAt}.`;
      announce("Page saved");
    } catch (err) {
      statusEl.textContent = err.message || "Save failed.";
      announce(err.message || "Save failed");
    }
  }

  async function destroy() {
    if (!page.id) {
      navigate("/office/pages");
      return;
    }
    if (!window.confirm(`Delete “${page.title || page.slug}”? This cannot be undone.`)) return;
    try {
      await api(`/api/office/pages/${encodeURIComponent(page.id)}`, { method: "DELETE" });
      announce("Page deleted");
      navigate("/office/pages");
    } catch (err) {
      statusEl.textContent = err.message || "Delete failed.";
    }
  }

  refreshPreview();

  mount(main, 
    h(
      "div",
      { class: "page-head" },
      h("p", { class: "kicker", text: "WordPress-style editor" }),
      h("h1", { text: isNew ? "New page" : `Edit: ${page.title || "Untitled"}` }),
      h("p", { class: "lede", text: "Blocks are plain text. HTML is stripped on save so a clerk cannot inject scripts." })
    ),
    cmsSubnav(h, isNew ? "new" : "pages"),
    h(
      "form",
      {
        class: "cms-editor",
        onSubmit: (event) => {
          event.preventDefault();
          save();
        },
      },
      h(
        "div",
        { class: "cms-meta panel" },
        field(h, "Title", titleInput),
        field(h, "Kind", kindSelect, "Home / About / FAQ overlay the built-in pages. Custom pages live at /p/slug."),
        field(h, "Slug", slugInput, "Custom pages only. Home, About, and FAQ use fixed paths."),
        field(h, "Nav label", navInput),
        field(h, "Status", statusSelect),
        field(h, "Jurisdiction", jidSelect, "Leave as This Node for site-wide copy. Tag a page so only that clerk desk can edit it."),
        h("label", { class: "choice" }, navCheck, " Show custom page in the public nav"),
        h("label", { class: "choice" }, replaceCheck, " Replace the built-in Home / About / FAQ copy (keep the elections calendar on home)")
      ),
      h("h2", { text: "Blocks" }),
      blocksHost,
      h(
        "div",
        { class: "cta-row" },
        h("button", { class: "btn", type: "submit", text: isNew ? "Create page" : "Save" }),
        h("button", {
          class: "btn btn-secondary",
          type: "button",
          text: "Publish",
          onClick: async () => {
            page.status = "published";
            statusSelect.value = "published";
            await save();
          },
        }),
        page.id
          ? h("a", {
              class: "btn btn-secondary",
              href: page.kind === "home" ? "/" : page.kind === "about" ? "/about" : page.kind === "faq" ? "/faq" : `/p/${encodeURIComponent(page.slug)}`,
              "data-nav": "",
              text: "View",
            })
          : null,
        h("button", { class: "btn btn-danger", type: "button", text: "Delete", onClick: destroy })
      ),
      statusEl
    ),
    h("h2", { text: "Preview" }),
    h("p", { class: "field-hint", text: "This is how visitors will see the blocks. No HTML rendering." }),
    preview
  );
}

export async function renderOfficeSite(main, ctx, bundle) {
  const { h, setTitle, api, announce, route } = ctx;
  const { me } = bundle;
  setTitle("Site & contracts");
  const gate = clerkGate(h, ctx, me, route.path);
  if (gate === true) return;
  if (gate) {
    mount(main, gateScreen(h, me, gate));
    return;
  }

  let payload;
  try {
    payload = await api("/api/office/site");
  } catch (err) {
    mount(main,
      cmsSubnav(h, "site"),
      h("div", { class: "notice notice-error", role: "alert" }, h("p", { text: err.message }))
    );
    return;
  }

  const site = payload.site || {};
  const contracts = site.contracts || {};
  const pinned = contracts.pinnedByEnv || {};
  const canPin = Boolean(payload.canPinContracts);
  const statusEl = h("p", { class: "field-hint", text: site.updatedAt ? `Last saved ${site.updatedAt}.` : "Not saved yet." });

  const titleInput = h("input", { type: "text", value: site.title || "Republic", id: "site-title" });
  const taglineInput = h("textarea", { id: "site-tagline", rows: "3" });
  taglineInput.value = site.tagline || "";
  const factoryInput = h("input", {
    type: "text",
    value: contracts.factory || "",
    id: "site-factory",
    disabled: !canPin || pinned.factory,
    spellcheck: "false",
  });
  const inboxInput = h("input", {
    type: "text",
    value: contracts.ballotInbox || "",
    id: "site-inbox",
    disabled: !canPin || pinned.ballotInbox,
    spellcheck: "false",
  });
  const verifierInput = h("input", {
    type: "text",
    value: contracts.verifier || "",
    id: "site-verifier",
    disabled: !canPin || pinned.verifier,
    spellcheck: "false",
  });

  async function save(event) {
    event.preventDefault();
    const body = { title: titleInput.value, tagline: taglineInput.value };
    if (canPin) {
      body.contracts = {
        factory: factoryInput.value.trim(),
        ballotInbox: inboxInput.value.trim(),
        verifier: verifierInput.value.trim(),
      };
    }
    try {
      const updated = await api("/api/office/site", { method: "PATCH", body });
      statusEl.textContent = "Saved. Forked Nodes should pin this same factory — do not deploy a new one.";
      announce("Site saved");
      const next = updated.site?.contracts || {};
      factoryInput.value = next.factory || "";
      inboxInput.value = next.ballotInbox || "";
      verifierInput.value = next.verifier || "";
    } catch (err) {
      statusEl.textContent = err.message || "Save failed.";
      announce(err.message || "Save failed");
    }
  }

  mount(main, 
    h(
      "div",
      { class: "page-head" },
      h("p", { class: "kicker", text: "Shared deployment" }),
      h("h1", { text: "Site identity and one contract" }),
      h(
        "p",
        { class: "lede" },
        "Jurisdictions fork this Node to run their own pages. The ElectionFactory, BallotInbox, and verifier stay the one shared deploy. Pin those addresses here when env is empty."
      )
    ),
    cmsSubnav(h, "site"),
    h("div", { class: "notice notice-warn", role: "note" }, h("p", { text: SHARED_DEPLOYMENT_NOTE })),
    h(
      "form",
      { class: "cms-editor", onSubmit: save },
      h(
        "div",
        { class: "panel stack" },
        field(h, "Site title", titleInput),
        field(h, "Tagline", taglineInput, "Shown on overlays when you replace built-in copy.")
      ),
      h("h2", { text: "Shared contract pin" }),
      h(
        "p",
        {
          text: canPin
            ? "You are the Node host. Paste the existing factory. Do not run DeployLocal again for a new city."
            : "Only the Node host (platform_admin) can change contract addresses. Clerks still update pages.",
        }
      ),
      h(
        "div",
        { class: "panel stack" },
        field(
          h,
          "ElectionFactory",
          factoryInput,
          pinned.factory ? "Locked by ELECTION_FACTORY_ADDRESS on this process." : "0x… from the shared deploy."
        ),
        field(
          h,
          "BallotInbox",
          inboxInput,
          pinned.ballotInbox ? "Locked by BALLOT_INBOX_ADDRESS on this process." : ""
        ),
        field(
          h,
          "Verifier",
          verifierInput,
          pinned.verifier ? "Locked by VERIFIER_ADDRESS on this process." : "Often MockVerifier on test/unstable."
        )
      ),
      h("p", { text: `Pin source: ${contracts.source || "unset"}. Chain id ${contracts.chainId ?? "—"}.` }),
      h("button", { class: "btn", type: "submit", text: "Save site" }),
      statusEl
    )
  );
}

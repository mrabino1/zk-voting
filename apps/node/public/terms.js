/**
 * NOT FOR PROFIT — ZK-Voting is a civic public good. Not a commercial product.
 * Public /terms page: canonical copy, SHA-256 of PDF bytes, accept + email PDF.
 */

import { brandName } from "./brand.js";

function blockNodes(h, block, i) {
  if (!block) return null;
  if (block.type === "h1") return h("h1", { id: `t-${i}`, text: block.text });
  if (block.type === "h2") return h("h2", { id: `t-${i}`, text: block.text });
  if (block.type === "list") {
    return h(
      "ul",
      {},
      ...(block.items || []).map((item) => h("li", { text: item }))
    );
  }
  return h("p", { text: block.text || "" });
}

export async function renderTerms(main, ctx) {
  const { h, api, announce, me } = ctx;
  let data = null;
  let error = "";
  let info = "";
  let busy = false;

  try {
    data = await api("/api/terms");
  } catch (err) {
    error = err.message || "Could not load Terms of Use.";
  }

  if (me?.user) {
    api("/api/terms/view", { method: "POST", body: {} }).catch(() => {});
  }

  function paint() {
    const hash = data?.pdfSha256 || "";
    const accepted = Boolean(data?.accepted);
    const signedIn = Boolean(me?.user);
    main.replaceChildren(
      ...[
        h(
          "div",
          { class: "page-head" },
          h("p", { class: "kicker", text: "Legal" }),
          h("h1", { text: data?.title || `${brandName()} Terms of Use` }),
          h(
            "p",
            { class: "lede" },
            "NOT FOR PROFIT — civic public good. Not a commercial product. The fingerprint stored on accept is SHA-256 of the exact PDF bytes (the file SES emails). Markdown SHA-256 is published next to it."
          )
        ),
        error ? h("div", { class: "notice notice-error", role: "alert" }, h("p", { text: error })) : null,
        info ? h("div", { class: "notice notice-ok", role: "status" }, h("p", { text: info })) : null,
        data
          ? h(
              "section",
              { class: "panel terms-meta", "aria-labelledby": "terms-hash-heading" },
              h("h2", { id: "terms-hash-heading", text: "Content hashes" }),
              h("p", { class: "field-hint", text: `Version ${data.version} · Last updated ${data.lastUpdated}` }),
              h("p", {}, h("strong", { text: "PDF SHA-256 (stored on accept): " }), h("code", { class: "hex", text: hash })),
              h(
                "p",
                {},
                h("strong", { text: "Markdown SHA-256: " }),
                h("code", { class: "hex", text: data.markdownSha256 || "—" })
              ),
              h(
                "div",
                { class: "toolbar" },
                h("a", { class: "btn", href: "/terms.pdf", text: "Download PDF" }),
                signedIn && !accepted
                  ? h(
                      "button",
                      {
                        class: "btn btn-secondary",
                        type: "button",
                        disabled: busy,
                        text: busy ? "Recording…" : "I agree — email me the PDF",
                        onClick: onAccept,
                      }
                    )
                  : null
              ),
              accepted
                ? h(
                    "p",
                    { class: "field-hint", text: `You accepted this hash${data.acceptance?.createdAt ? ` at ${data.acceptance.createdAt}` : ""}.` }
                  )
                : signedIn
                  ? h("p", { class: "field-hint", text: "Accepting records this PDF SHA-256 on your person and emails the PDF via AWS SES when configured." })
                  : h(
                      "p",
                      { class: "field-hint" },
                      "Registration requires agreeing to these Terms. ",
                      h("a", { href: "/register", "data-nav": "", text: "Register" }),
                      " or ",
                      h("a", { href: "/signin", "data-nav": "", text: "sign in" }),
                      " to store an acceptance and receive the PDF."
                    )
            )
          : null,
        data
          ? h(
              "article",
              { class: "panel terms-doc prose", "aria-label": "Terms of Use" },
              ...(data.blocks || []).map((block, i) => blockNodes(h, block, i))
            )
          : h("p", { class: "loading-msg", text: "Loading Terms…" }),
      ].filter((node) => node != null)
    );
  }

  async function onAccept() {
    if (busy) return;
    busy = true;
    error = "";
    info = "";
    paint();
    try {
      const result = await api("/api/terms/accept", {
        method: "POST",
        body: { acceptedTerms: true, source: "page" },
      });
      data = { ...data, accepted: true, acceptance: result.acceptance };
      info = result.emailed
        ? "Accepted. A PDF copy was emailed (captured or sent via SES)."
        : result.emailSkipped === "already_sent_this_hash"
          ? "Accepted. A PDF of this hash was already emailed."
          : result.emailSkipped === "no_email"
            ? "Accepted. Add an email to this person to receive the PDF."
            : "Accepted. PDF email was recorded without SES (set SES_FROM_ADDRESS and AWS_REGION to send).";
      announce(info);
    } catch (err) {
      error = err.message || "Could not record acceptance.";
      announce(error);
    } finally {
      busy = false;
      paint();
    }
  }

  paint();
}

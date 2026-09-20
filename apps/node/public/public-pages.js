/**
 * NOT FOR PROFIT — Republic is a civic public good. Not a commercial product.
 * Unregistered marketing pages, sign-in, and voting-admin hub (SPA).
 */

import { audienceOf, isOfficer, postLoginPath, safeNextPath, signInHref } from "./audience.js";
import { canEditPages, renderBlocks } from "./cms.js";
import { FAQ_ENTRIES, faqAnswerText } from "./faq.js";
import { logout, mountSignInPanel } from "./signin.js";

const DEMO_NOTE =
  "This Node is a working demo on the test/unstable line. Local tests still use MockVerifier; Poseidon is not wired; there is no production Groth16 ceremony. The passkey helper may show republic-local-address. Tally that opens ballots uses a threshold-1 operator key (NON-PRODUCTION). Republic is not claiming this deploy is court-ready.";

function mount(node, ...children) {
  node.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false));
}

function paragraphs(h, texts) {
  return (Array.isArray(texts) ? texts : [texts]).filter(Boolean).map((text) => h("p", { text }));
}

function ctaRow(h, audience) {
  if (audience === "public") {
    return h(
      "div",
      { class: "cta-row" },
      h("a", { class: "btn", href: "/register", "data-nav": "", text: "Register" }),
      h("a", { class: "btn btn-secondary", href: "/signin", "data-nav": "", text: "Sign in" }),
      h("a", { class: "btn btn-secondary", href: "/receipt", "data-nav": "", text: "Check a receipt" }),
      h("a", { class: "btn btn-secondary", href: "/outcomes", "data-nav": "", text: "Outcomes monitor" }),
      h("a", { class: "btn btn-secondary", href: "/about", "data-nav": "", text: "About us" }),
      h("a", { class: "btn btn-secondary", href: "/faq", "data-nav": "", text: "FAQ" })
    );
  }
  return h(
    "div",
    { class: "cta-row" },
    h("a", { class: "btn", href: "/me", "data-nav": "", text: "My desk" }),
    audience === "officer"
      ? h("a", { class: "btn btn-secondary", href: "/office", "data-nav": "", text: "Admin hub" })
      : null
  );
}

function demoBanner(h) {
  return h(
    "div",
    { class: "notice notice-warn", role: "note" },
    h("p", { text: DEMO_NOTE })
  );
}

function publicCalendar(h, ctx, elections, source) {
  const { formatTime, electionStateInfo } = ctx;
  if (!elections.length) {
    return h("div", { class: "notice notice-warn" }, h("p", { text: "No elections are published on this Node yet." }));
  }
  return h(
    "div",
    { class: "grid-cards", role: "list" },
    source === "sample"
      ? h(
          "p",
          {
            class: "field-hint",
            style: { gridColumn: "1 / -1" },
            text: "Showing the built-in sample calendar because /api/elections is not available. When the Node API is up, this list is the live public calendar.",
          }
        )
      : null,
    ...elections.map((election) => {
      const st = electionStateInfo(election.state);
      return h(
        "article",
        { class: "election-card", role: "listitem" },
        h("p", { class: "kicker", text: election.jurisdiction }),
        h("h2", { text: election.title }),
        h("p", { class: "cluster" }, h("span", { class: `status-pill ${st.className}`, text: st.label })),
        h(
          "ul",
          { class: "meta-list" },
          h("li", {}, h("span", { class: "lbl", text: "Opens" }), h("span", { text: formatTime(election.startTime) })),
          h("li", {}, h("span", { class: "lbl", text: "Cutoff" }), h("span", { text: formatTime(election.cutoffTime) })),
          election.shortCode
            ? h(
                "li",
                {},
                h("span", { class: "lbl", text: "Short link" }),
                h("a", {
                  href: `/v/${encodeURIComponent(election.shortCode)}`,
                  "data-nav": "",
                  text: `/v/${election.shortCode}`,
                })
              )
            : null
        ),
        election.description ? h("p", { text: election.description }) : null,
        h(
          "div",
          { class: "cluster" },
          h("a", {
            class: "btn btn-secondary",
            href: `/elections/${encodeURIComponent(election.id)}/info`,
            "data-nav": "",
            text: "Candidate / measure info",
          }),
          h("a", {
            class: election.state >= 4 ? "btn" : "btn btn-secondary",
            href: `/elections/${encodeURIComponent(election.id)}/results`,
            "data-nav": "",
            text: election.state >= 4 ? "Results" : "Results status",
          }),
          election.state <= 2
            ? h("a", {
                class: "btn btn-secondary",
                href: `/register?election=${encodeURIComponent(election.id)}`,
                "data-nav": "",
                text: "Register",
              })
            : null
        )
      );
    })
  );
}

export function renderPublicHome(main, ctx, bundle) {
  const { h, setTitle } = ctx;
  const { elections, source, audience } = bundle;
  const overlay = bundle.cms?.overlays?.home;
  const siteTitle = bundle.cms?.site?.title;
  const tagline = overlay?.blocks?.length && overlay.replaceBuiltin ? null : bundle.cms?.site?.tagline;
  setTitle(siteTitle || "Republic");
  const openCount = elections.filter((e) => e.state === 2).length;
  const replace = Boolean(overlay?.replaceBuiltin && overlay.blocks?.length);
  const heading = replace ? overlay.title : "Republic — civic elections you can check";
  const ledeDefault =
    "Republic is a not-for-profit zero-knowledge voting system. The people vote for representatives, and those representatives vote. A city, county, state, nation, union, or cooperative should be able to run an election with private ballots and a public process — without a token, a paid tier, or a vendor black box.";
  mount(main,
    h(
      "div",
      { class: "page-head" },
      h("p", { class: "kicker", text: "Public home" }),
      h("h1", { text: heading }),
      replace
        ? null
        : h("p", { class: "lede", text: tagline || ledeDefault }),
      ctaRow(h, audience || "public"),
      demoBanner(h),
      h(
        "div",
        { class: "notice", role: "status" },
        h("p", {
          text: `${openCount} election${openCount === 1 ? "" : "s"} currently listed as open on this Node.`,
        }),
        h("p", {
          text: "Choice stays private. Eligibility, disqualification reason codes, and the published tally are meant to be checkable. Public turnout waits until the hour that contained each ballot has closed.",
        })
      )
    ),
    replace ? h("div", { class: "prose cms-prose" }, ...renderBlocks(h, overlay.blocks)) : null,
    overlay && !replace && overlay.blocks?.length
      ? h("section", { class: "prose cms-prose", "aria-label": "From this Node" }, ...renderBlocks(h, overlay.blocks))
      : null,
    h(
      "section",
      { "aria-labelledby": "calendar-heading" },
      h("h2", { id: "calendar-heading", text: "Open elections calendar" }),
      h("p", {
        text: "This calendar is public. It does not show whether you are on a roll. Sign in or register to see your personal status and to mark a ballot.",
      }),
      publicCalendar(h, ctx, elections, source)
    ),
    replace
      ? null
      : h(
          "section",
          { id: "how-it-works", tabindex: "-1" },
          h("h2", { text: "How Republic is supposed to work" }),
      h(
        "div",
        { class: "how-grid" },
        h(
          "article",
          {},
          h("h3", { text: "Privacy of choice" }),
          h("p", {
            text: "The option you mark is not published. Receipts are hashes. A coercer who sees that you registered still cannot read the ballot from this desk.",
          })
        ),
        h(
          "article",
          {},
          h("h3", { text: "Public verifiability" }),
          h("p", {
            text: "Anyone can inspect registration commitments, disqualification codes, hourly disclosed proofs, and the posted tally. The /outcomes portal groups every contest before, during, and after voting from chain status and runs those checks. Paste a vote receipt at /receipt to confirm that ballot counted — never which option it carried. Officials still maintain the legal roll; counting should not be a second invisible database.",
          })
        ),
        h(
          "article",
          {},
          h("h3", { text: "One person, several authenticators" }),
          h("p", {
            text: "Email, Ethereum, smart-card reader, driver’s license or passport, or passkey. Several ETH addresses may be verified; only one is active. The Merkle leaf is an identity commitment, never that address and never a document number.",
          })
        ),
        h(
          "article",
          {},
          h("h3", { text: "Jurisdictions at cost" }),
          h("p", {
            text: "Clerks, registrars, disqualification officers, and tally operators are granted per jurisdiction. The jurisdiction paymaster sponsors gas. Voters are not charged.",
          })
        )
      )
    ),
    h(
      "p",
      {},
      h("a", { href: "/about", "data-nav": "", text: "About us" }),
      " · ",
      h("a", { href: "/faq", "data-nav": "", text: "Frequently asked questions" }),
      " · AGPL-3.0-or-later"
    )
  );
}

export function renderAbout(main, ctx) {
  const { h, setTitle } = ctx;
  const audience = audienceOf(ctx.me);
  const overlay = ctx.cms?.overlays?.about;
  const replace = Boolean(overlay?.replaceBuiltin && overlay.blocks?.length);
  setTitle(overlay?.title || "About us");
  const builtin = [
    h("h2", { text: "Purpose" }),
    h("p", {
      text: "Democratic processes still depend on a small set of trusted operators: who is on the roll, who was turned away, whether a ballot was counted, and whether the published result matches the ballots. Paper and proprietary machines can work. They do not, by themselves, let a voter, a losing candidate, or a court verify those claims without re-trusting the same operators.",
    }),
    h("p", {
      text: "This project exists to make those claims checkable: register, cast a private ballot, publish a tally anyone can inspect, and record disqualification as an auditable state change — not an invisible database flag.",
    }),
    h("h2", { text: "Privacy of choice" }),
    h("p", {
      text: "A voter’s choice is not published. Eligibility and “this person already voted / is barred” are. Zero-knowledge is used so the chain can check facts about a voter without putting the ballot (and, where the jurisdiction requires it, civil identity) in the clear.",
    }),
    h("h2", { text: "Public verifiability" }),
    h("p", {
      text: "Registration events, disqualification reason codes, poll parameters, hourly disclosed vote proofs, and final tallies are attributable to known roles. Independent auditors can reconstruct an election from chain data, proofs, and published artifacts without a vendor’s private database.",
    }),
    h("h2", { text: "Jurisdictions" }),
    h("p", {
      text: "A jurisdiction is any body that needs a roll, a ballot, and a binding result: government, county, nation, union, board, cooperative. Nested districts are a registry concern. The same machinery is not limited to national general elections. Fork this Node to run your clerk desk; pin the one shared ElectionFactory instead of deploying a new contract.",
    }),
    h("h2", { text: "License (AGPL)" }),
    h("p", {
      text: "The software is licensed AGPL-3.0-or-later. If you run a modified Node as a network service, you must offer the corresponding source to its users. Keep the NOT FOR PROFIT label. Do not sell the software or wrap it in a token.",
    }),
    h("h2", { text: "Honest maturity" }),
    demoBanner(h),
    h("p", {
      text: "We will not claim that a local demo is court-ready, that MockVerifier is a ceremony, or that using this repository satisfies a given elections statute. Legal adoption is a jurisdiction question. This page is about civic purpose, not a sales pitch.",
    }),
    h(
      "p",
      {},
      h("a", { href: "/faq", "data-nav": "", text: "Read the FAQ" }),
      " · ",
      h("a", { href: "/register", "data-nav": "", text: "Register" })
    ),
  ];
  mount(main,
    h(
      "div",
      { class: "page-head" },
      h("p", { class: "kicker", text: "About us" }),
      h("h1", { text: replace ? overlay.title : "A civic public good, not a product" }),
      replace
        ? null
        : h(
            "p",
            { class: "lede" },
            "Republic exists to protect and preserve a republic driven by democracy. It is not for profit. There is no token. There is no paid tier. There is no vendor lock-in."
          ),
      ctaRow(h, audience)
    ),
    h(
      "div",
      { class: "prose" },
      ...(replace ? renderBlocks(h, overlay.blocks) : builtin),
      !replace && overlay?.blocks?.length ? h("hr", { class: "hr" }) : null,
      !replace && overlay?.blocks?.length ? h("h2", { text: overlay.title || "From this Node" }) : null,
      !replace && overlay?.blocks?.length ? renderBlocks(h, overlay.blocks) : null
    )
  );
}

export function renderFaq(main, ctx) {
  const { h, setTitle } = ctx;
  const audience = audienceOf(ctx.me);
  const overlay = ctx.cms?.overlays?.faq;
  const replace = Boolean(overlay?.replaceBuiltin);
  const extraFaq = (overlay?.blocks || []).filter((b) => b.type === "faq");
  const extraOther = (overlay?.blocks || []).filter((b) => b.type !== "faq");
  setTitle("FAQ");
  const builtin = FAQ_ENTRIES.map((entry, index) =>
    h(
      "details",
      { class: "faq-item", id: entry.id, open: index === 0 && !replace },
      h("summary", {}, h("span", { class: "faq-q", text: entry.q })),
      h("div", { class: "faq-a" }, ...paragraphs(h, Array.isArray(entry.a) ? entry.a : [faqAnswerText(entry)]))
    )
  );
  const overlayFaq = extraFaq.map((block, index) =>
    h(
      "details",
      { class: "faq-item", open: replace && index === 0 },
      h("summary", {}, h("span", { class: "faq-q", text: block.q })),
      h("div", { class: "faq-a" }, h("p", { text: block.a || "" }))
    )
  );
  mount(main,
    h(
      "div",
      { class: "page-head" },
      h("p", { class: "kicker", text: "FAQ" }),
      h("h1", { text: overlay?.title && replace ? overlay.title : "Questions people actually ask" }),
      h(
        "p",
        { class: "lede" },
        replace
          ? "Answers published by this Node’s clerks."
          : `Answers for voters, officials, and observers. ${FAQ_ENTRIES.length} built-in entries. Copy matches the honest status of this branch — including MockVerifier and other demo limits.`
      ),
      ctaRow(h, audience)
    ),
    extraOther.length ? h("div", { class: "prose" }, ...renderBlocks(h, extraOther)) : null,
    h("div", { class: "faq-list", id: "faq-list" }, ...(replace ? overlayFaq : [...builtin, ...overlayFaq]))
  );
}

export async function renderSignIn(main, ctx) {
  const { h, setTitle, navigate, loadMe, route } = ctx;
  setTitle("Sign in");
  const next = safeNextPath(route.query.get("next"));
  const me = await loadMe();
  if (me?.user) {
    navigate(postLoginPath(me, next), { replace: true });
    return;
  }
  const host = h("div", {
    id: "sign-in-root",
    dataset: {
      heading: "Sign in",
      lede:
        next && isOfficeish(next)
          ? "Election officials sign in with email, Ethereum, a smart-card reader, or a license/passport. Every path uses an email one-time code. The Node still enforces roles on every action."
          : "Returning users: email, a bound Ethereum wallet, a smart-card reader, or a driver’s license / passport already bound to your person. First-time registration is on Register.",
    },
  });
  mount(main,
    h(
      "div",
      { class: "page-head" },
      h("p", { class: "kicker", text: "Session" }),
      h("h1", { text: "Sign in to Republic" }),
      h(
        "p",
        { class: "lede" },
        "Use email, Ethereum (signature), a smart-card reader, or a driver’s license / passport. There is no password product and no token login. Every path completes with an email one-time code via AWS SES. If you have never identified yourself on this Node, register first."
      ),
      h(
        "div",
        { class: "cta-row" },
        h("a", { class: "btn btn-secondary", href: "/register", "data-nav": "", text: "Register instead" }),
        h("a", { class: "btn btn-secondary", href: "/about", "data-nav": "", text: "About us" })
      )
    ),
    host
  );
  mountSignInPanel(host);
}

function isOfficeish(path) {
  return /^\/(admin|back-office|office)(\/|$)/.test(path);
}

export function renderOffice(main, ctx, bundle) {
  const { h, setTitle, navigate, route } = ctx;
  const { me } = bundle;
  setTitle("Voting admin");
  if (!me?.user) {
    navigate(signInHref(route.path || "/office"), { replace: true });
    return;
  }
  if (!isOfficer(me)) {
    mount(main,
      h(
        "div",
        { class: "page-head audience-gate", id: "officer-gate" },
        h("p", { class: "kicker", text: "Voting admin" }),
        h("h1", { text: "Officer access required" }),
        h("p", {
          class: "lede",
          text: `Signed in as ${me.user.handle} (${me.user.role}). This hub is for clerks, registrars, disqualification officers, tally operators, and the platform host.`,
        }),
        h(
          "div",
          { class: "cta-row" },
          h("a", { class: "btn", href: "/me", "data-nav": "", text: "Go to my desk" }),
          h("button", {
            class: "btn btn-secondary",
            type: "button",
            text: "Sign out",
            onClick: async () => {
              await logout();
            },
          })
        )
      )
    );
    return;
  }

  const grants = me.jurisdictionRoles || [];
  const offices =
    grants
      .map((g) => `${g.role}@${g.jurisdictionId}`)
      .filter(Boolean)
      .join(", ") || me.user.role;

  const cards = [
    {
      href: "/back-office#clerk",
      title: "Create and manage elections",
      body: "Stand up a contest, author questions (including ranked choice), freeze the roll.",
    },
    {
      href: "/back-office#registrar",
      title: "Voter roll",
      body: "Insert identity commitments. Never names, never wallet addresses as leaves.",
    },
    {
      href: "/back-office#disqualify",
      title: "Disqualify",
      body: "Apply or revoke public reason codes. Evidence stays off-chain; only its hash is posted.",
    },
    {
      href: "/back-office#tally",
      title: "Tally",
      body: "Post counts after cutoff. opens_ballots demo keys are NON-PRODUCTION.",
    },
    {
      href: "/office/pages",
      title: "Pages (WordPress-style)",
      body: "The host updates Home, About, and FAQ. Clerks publish extra pages tagged to their jurisdiction. HTML is stripped.",
      spa: true,
    },
    {
      href: "/office/site",
      title: "Shared contracts",
      body: "Fork the UI; pin the one ElectionFactory. Do not deploy a new factory per jurisdiction.",
      spa: true,
    },
    {
      href: "/admin",
      title: "Jurisdictions and roles",
      body: "Host this Node: create jurisdictions and grant clerks, registrars, DQ, and tally officers.",
    },
    {
      href: "/explorer",
      title: "Explorer",
      body: "Public L2 record. Vote proofs wait for the hour to close.",
    },
  ];

  mount(main,
    h(
      "div",
      { class: "page-head" },
      h("p", { class: "kicker", text: "Voting admin" }),
      h("h1", { text: "Election officials" }),
      h(
        "p",
        { class: "lede" },
        "Create elections, maintain the roll, record disqualifications, post tallies, and grant jurisdiction roles. Choice plaintext never belongs here. Public proofs still wait for the hour to close."
      ),
      h("p", { class: "session-line", text: `${me.user.handle} · ${offices}` }),
      demoBanner(h)
    ),
    h(
      "div",
      { class: "grid-cards hub-cards", role: "list" },
      ...cards
        .filter((card) => {
          if (card.href === "/office/pages" || card.href === "/office/site") return canEditPages(me);
          return true;
        })
        .map((card) =>
        h(
          "article",
          { class: "election-card", role: "listitem" },
          h("h2", { text: card.title }),
          h("p", { text: card.body }),
          h("a", { class: "btn", href: card.href, "data-nav": card.spa ? "" : undefined, text: "Open" })
        )
      )
    ),
    h(
      "p",
      {},
      h("a", { href: "/me", "data-nav": "", text: "Registered desk" }),
      " · officials still vote from My desk when they are on a roll."
    )
  );
}

export { DEMO_NOTE };

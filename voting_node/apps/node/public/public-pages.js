/**
 * NOT FOR PROFIT — ZK-Voting is a civic public good. Not a commercial product.
 * Demo home (voting flow only), legacy about/FAQ pages, sign-in, and voting-admin hub (SPA).
 */

import { brandName } from "./brand.js";
import { electionTypeLabel, resultsAreSealed, sealedUntilLabel } from "./election-type-ui.js";
import { t } from "./i18n.js";
import {
  COMMUNITY_URL,
  MAIN_SITE_URL,
  audienceOf,
  isOfficer,
  postLoginPath,
  safeNextPath,
  signInHref,
} from "./audience.js";
import { canEditPages, renderBlocks } from "./cms.js";
import { FAQ_ENTRIES, faqAnswerText } from "./faq.js";
import { logout, mountSignInPanel } from "./signin.js";

const DEMO_NOTE =
  `This Node is a working demo on the test/unstable line. Local tests still use MockVerifier. Poseidon(2) matches the vote circuit and the passkey commitment, but the dev Groth16 key is UNTRUSTED — no ceremony. The passkey helper may show zk-voting-local-address. Tally that opens ballots uses Feldman t-of-n guardians (NON-PRODUCTION); homomorphic versus mixnet aggregation is not decided. ${brandName()} is not claiming this deploy is court-ready.`;

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
      h("a", { class: "btn btn-secondary", href: "/outcomes", "data-nav": "", text: "See the tally" })
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

/** Decorative tinted icon tile for dashboard cards (styles.css .card-icon). */
function cardIcon(h, icon) {
  return h("span", { class: `card-icon card-icon-${icon}`, "aria-hidden": "true" });
}

function demoBanner(h) {
  return h(
    "div",
    { class: "notice notice-warn", role: "note" },
    h("p", { text: DEMO_NOTE })
  );
}

/**
 * Home opening. A named host (VOTE_FQDN) or a page the operator replaced
 * is their site. The demo opening is only the unnamed built-in home.
 */
export function homeIntro({
  namedHost = false,
  replace = false,
  overlayTitle = "",
  siteTitle = "",
  brand = "ZK-Voting",
} = {}) {
  if (replace) {
    return { kicker: null, heading: overlayTitle || brand, lede: null, demoNote: false };
  }
  if (namedHost) {
    return {
      kicker: null,
      heading: siteTitle || brand,
      lede: "Register, cast a private ballot, and check the published tally.",
      demoNote: false,
    };
  }
  return {
    kicker: "Voting demo",
    heading: `Try a ${brand} vote`,
    lede:
      "This is a working demo of the voting flow: how members of a group join the roll, cast an anonymous ballot with a zero-knowledge proof, and check the tally.",
    demoNote: true,
  };
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
        { class: "election-card dash-card", role: "listitem" },
        cardIcon(h, "ballot"),
        h("p", { class: "kicker", text: election.jurisdiction }),
        h("h2", { text: election.title }),
        h(
          "p",
          { class: "cluster" },
          h("span", { class: `status-pill ${st.className}`, text: st.label }),
          h("span", { class: "status-pill status-created", text: electionTypeLabel(election) })
        ),
        h(
          "ul",
          { class: "meta-list" },
          h("li", {}, h("span", { class: "lbl", text: "Opens" }), h("span", { text: formatTime(election.startTime) })),
          h("li", {}, h("span", { class: "lbl", text: "Cutoff" }), h("span", { text: formatTime(election.cutoffTime) })),
          resultsAreSealed(election)
            ? h("li", {}, h("span", { text: sealedUntilLabel(election, formatTime) }))
            : null,
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
            text: resultsAreSealed(election) ? t("results.sealedStatus") : election.state >= 4 ? "Results" : "Results status",
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

/**
 * Demo home: the voting flow only. What ZK Voting is and why it matters
 * lives on the main site (MAIN_SITE_URL); discussion on the community forum.
 */
function votingSteps(h, ctx) {
  const steps = [
    {
      n: "1",
      icon: "register",
      accent: "yellow",
      title: "Join the roll",
      text: "Register for an election with a passkey, wallet, email, or ID. The roll stores an identity commitment, never your address or document number.",
      href: "/register",
      cta: "Register",
    },
    {
      n: "2",
      icon: "signin",
      accent: "orange",
      title: "Sign in",
      text: "Come back with the same passkey or account. Your desk lists the ballots you can mark.",
      href: "/signin",
      cta: "Sign in",
    },
    {
      n: "3",
      icon: "ballot",
      accent: "green",
      title: "Cast a private ballot",
      text: "Your device builds a zero-knowledge proof that you are eligible and have not voted yet. The ballot is accepted without revealing your choice.",
      href: ctx.pollsEnabled ? "/polls" : "/elections",
      cta: ctx.pollsEnabled ? "Open polls" : "Elections",
    },
    {
      n: "4",
      icon: "receipt",
      accent: "purple",
      title: "Check your receipt",
      text: "Paste your receipt to confirm your ballot was counted. It never shows which option you picked.",
      href: "/receipt",
      cta: "Check a receipt",
    },
    {
      n: "5",
      icon: "tally",
      accent: "red",
      title: "See the tally",
      text: "After the poll closes, the published totals can be checked against the accepted ballots.",
      href: "/outcomes",
      cta: "Outcomes",
    },
  ];
  return h(
    "ol",
    { class: "how-grid demo-steps" },
    ...steps.map((step) =>
      h(
        "li",
        { class: `dash-card accent-${step.accent}` },
        cardIcon(h, step.icon),
        h("h3", { text: `${step.n}. ${step.title}` }),
        h("p", { text: step.text }),
        h(
          "div",
          { class: "card-stats" },
          h("span", { class: "card-stat" }, "Step ", h("strong", { text: step.n }), ` of ${steps.length}`),
          h("a", { class: "btn btn-secondary", href: step.href, "data-nav": "", text: step.cta })
        )
      )
    )
  );
}

export function renderPublicHome(main, ctx, bundle) {
  const { h, setTitle } = ctx;
  const { elections, source, audience } = bundle;
  const overlay = bundle.cms?.overlays?.home;
  const siteTitle = bundle.cms?.site?.title;
  setTitle(siteTitle || brandName());
  const openCount = elections.filter((e) => e.state === 2).length;
  const replace = Boolean(overlay?.replaceBuiltin && overlay.blocks?.length);
  const intro = homeIntro({
    namedHost: Boolean(ctx.namedHost),
    replace,
    overlayTitle: overlay?.title,
    siteTitle,
    brand: brandName(),
  });
  mount(main,
    h(
      "div",
      { class: "page-head" },
      intro.kicker ? h("p", { class: "kicker", text: intro.kicker }) : null,
      h("h1", { text: intro.heading }),
      intro.lede ? h("p", { class: "lede", text: intro.lede }) : null,
      ctaRow(h, audience || "public"),
      intro.demoNote ? demoBanner(h) : null,
      h(
        "div",
        { class: "notice", role: "status" },
        h("p", {
          text: `${openCount} election${openCount === 1 ? "" : "s"} currently listed as open on this Node.`,
        })
      )
    ),
    replace ? h("div", { class: "prose cms-prose" }, ...renderBlocks(h, overlay.blocks)) : null,
    overlay && !replace && overlay.blocks?.length
      ? h("section", { class: "prose cms-prose", "aria-label": "From this Node" }, ...renderBlocks(h, overlay.blocks))
      : null,
    replace
      ? null
      : h(
          "section",
          { id: "how-it-works", tabindex: "-1", "aria-labelledby": "steps-heading" },
          h("h2", { id: "steps-heading", text: "How a vote works" }),
          votingSteps(h, ctx)
        ),
    h(
      "section",
      { "aria-labelledby": "calendar-heading" },
      h("h2", { id: "calendar-heading", text: "Open elections calendar" }),
      h("p", {
        text: "Pick an election to register for, vote in, or follow. Sign in to see your personal status.",
      }),
      publicCalendar(h, ctx, elections, source)
    ),
    h(
      "p",
      { class: "field-hint" },
      "Officials create ballots and freeze the roll from the ",
      h("a", { href: "/office", text: "admin hub" }),
      ". Want to know what ZK Voting is and why it matters? ",
      h("a", { href: MAIN_SITE_URL, text: "Visit zk-voting.org" }),
      " · ",
      h("a", { href: COMMUNITY_URL, text: "Community forum" })
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
    ctx.namedHost ? null : demoBanner(h),
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
            `${brandName()} exists to protect and preserve a democratic republic. It is not for profit. There is no token. There is no paid tier. There is no vendor lock-in.`
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
      h("h1", { text: `Sign in to ${brandName()}` }),
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
      body: "Post counts after cutoff. opens_ballots uses Feldman t-of-n guardians (NON-PRODUCTION).",
    },
    {
      href: "/office/pages",
      title: "Pages",
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
      ctx.namedHost ? null : demoBanner(h)
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

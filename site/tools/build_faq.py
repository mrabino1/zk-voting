#!/usr/bin/env python3
"""Generate site/public/faq.html and site/public/locales/faq/en.js from the copy below.

Other locales are maintained by hand and must carry the same keys.
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"

# group, id, nav, title, lede, blocks
# block is ("p", key, text) or ("h2", key, q, a) or ("note", key, text)
# or ("callout", title_key, title, body_key, body) or ("links",) or ("glossary",) or ("terminal",)

PAGES = []


def page(group, pid, nav, title, lede, blocks):
    PAGES.append(
        {
            "group": group,
            "id": pid,
            "nav": nav,
            "title": title,
            "lede": lede,
            "blocks": blocks,
        }
    )


page(
    "start",
    "welcome",
    "Welcome",
    "Welcome",
    "Notes for voters, officials, and people deciding whether to host a node. This is not a lending protocol. There is nothing to deposit.",
    [
        (
            "p",
            "p1",
            "ZK-Voting is a not-for-profit, open-source way for a group to run its own elections and polls. A civic election is one person, one vote, and the choice is designed to stay unpublished. Separately, a host can run an advisory token signal on Ethereum mainnet. That signal is not a civic election: weight comes from an ERC-20 at one finalized block, there is no registration, signing is free, and the choice stays public.",
        ),
        (
            "p",
            "p2",
            "These pages follow the landing page. They explain how a poll differs from a vote, what is public, what is designed to stay private, and how a group hosts its own node. They are not a promise that a deploy satisfies an elections statute.",
        ),
        (
            "callout",
            "disclaimerTitle",
            "Disclaimer",
            "disclaimer",
            "This site is general information. It is not legal advice and it is not a certification. ZK-Voting is under active development. Tests use a mock verifier, and the trusted-setup ceremony has not happened. Do not use it for a binding election today. Passing a vote never auto-executes anything.",
        ),
    ],
)

page(
    "start",
    "quick-links",
    "Quick Links",
    "Quick Links",
    "The pages and rooms that exist for this project. There is no borrow screen, no lend screen, and no place to deposit funds.",
    [
        ("links",),
        (
            "p",
            "note",
            "Markets, liquidations, reserve auctions, incentive programs, and price buckets are not part of ZK-Voting. If a page asks you to deposit or to buy a token, it is not this project.",
        ),
    ],
)

GLOSSARY = [
    ("civic", "Civic election", "One person, one vote, with registration and a secret ballot."),
    (
        "signal",
        "Token signal",
        "An advisory poll weighted by an ERC-20 at one finalized Ethereum block. There is no registration, and the choice stays public. It does not use the civic L2.",
    ),
    (
        "poll",
        "Poll",
        "A civic contest that publishes per-choice counts on a delayed hourly schedule after a gate. Turnout uses that same hourly schedule.",
    ),
    (
        "vote",
        "Vote",
        "A civic contest that keeps choices sealed until the deadline. Turnout is published on a delayed hourly schedule. There are no interim per-choice counts.",
    ),
    (
        "roll",
        "Roll",
        "The eligible set for one election. It stores identity commitments, not names, wallet addresses, or document numbers.",
    ),
    (
        "commitment",
        "Identity commitment",
        "The value written on the roll. It is not a wallet address and not a document number.",
    ),
    (
        "revote",
        "Re-vote",
        "The operator decides at creation whether re-voting is allowed, and that setting can't be changed afterward. If it is allowed, the last ballot before the deadline counts. If not, a second ballot is rejected.",
    ),
    (
        "gate",
        "Gate",
        "For a poll, choice counts stay hidden until 100 voters have cast their first ballot, or the scheduled end arrives, whichever comes first.",
    ),
    (
        "block",
        "Hourly block",
        "A published slice of a poll's per-choice counts. An hour with fewer than 10 ballots merges forward until a block has at least 10. A published block is designed to stay as first published.",
    ),
    (
        "receipt",
        "Receipt",
        "Evidence that a ballot was accepted. It is hashes, designed so it doesn't show how you voted.",
    ),
    (
        "guardian",
        "Guardian",
        "One of the k-of-n parties who can decrypt a vote only as an aggregate at the deadline. The design gives the operator no key share.",
    ),
    (
        "l2",
        "Civic L2",
        "A purpose-built sequencer and prover a group runs for its own elections. It settles batches to Ethereum. It is not a general-purpose chain.",
    ),
    (
        "uuid",
        "Election UUID",
        "The public id of one election, unique within that L2. Ethereum keys a batch by hash of the L2 id and this UUID.",
    ),
    (
        "mock",
        "Mock verifier",
        "The stand-in used in tests for a real proof check. With it, rejection of a voter who is not pre-approved is not yet enforced.",
    ),
]

page(
    "start",
    "glossary",
    "Glossary",
    "Glossary",
    "Short definitions. They match the landing page, and they leave out anything this project does not do.",
    [
        (
            "p",
            "note",
            "Definitions are simplified and may not be a complete specification.",
        ),
        ("glossary",),
    ],
)

QA_PAGES = [
    (
        "faqs",
        "general",
        "General",
        "What the project is, what it costs, and what it refuses to claim.",
        [
            (
                "what",
                "What is ZK-Voting?",
                "A not-for-profit, open-source voting system any group can run itself. Zero-knowledge proofs are designed to show that only eligible people voted, each one once, and that the published tally matches the ballots. Tests currently use a mock verifier. Individual choices are designed not to be published.",
            ),
            (
                "features",
                "What are the key features?",
                "Self-hosting, and one person, one vote on a civic election. A separate advisory token signal that is not a secret ballot. Polls with delayed hourly choice counts after a gate, and votes that stay sealed until the deadline. Public registration and disqualification codes. Receipts that are hashes. An AGPL license, no fee for voters, and no product token.",
            ),
            (
                "who",
                "Who is it for?",
                "Any body that needs a roll, a ballot, and a result people can check: cities, counties, unions, cooperatives, boards, schools, clubs, and observers.",
            ),
            (
                "fees",
                "What are the fees?",
                "Voters are not charged. There is no deposit, no origination fee, and no interest. A host pays for its own servers. On the civic L2, the operator's minimally funded Ethereum key pays to submit batches. On a token signal, signing a ballot is free. Delegating that token is the transaction that costs gas.",
            ),
            (
                "audit",
                "Has it been audited?",
                "Not as a finished system. The code is public under AGPL-3.0-or-later. Tests use a mock verifier, the first proving path is in progress, and the trusted-setup ceremony has not happened. There is no paid bug-bounty program.",
            ),
            (
                "down",
                "What if this website goes down?",
                "This website only explains the project. A group's election runs on the node that group hosts. The software is open source, so someone else can serve the same pages from the repository. A node can also stay on a private network.",
            ),
            (
                "admin",
                "Does anyone control every election?",
                "No. Each group runs its own node and owns its roll. Officials on that node create elections, freeze the roll, record disqualifications, and post the tally. Those jobs are not a back door that publishes choices.",
            ),
        ],
    ),
    (
        "faqs",
        "elections",
        "Elections",
        "A contest with a roll and a ballot. Not a liquidity pool.",
        [
            (
                "what",
                "What is an election here?",
                "A contest with a roll, a ballot, and a published result. When it is created, the operator chooses a poll or a vote, and whether re-voting is allowed. That setting can't be changed afterward.",
            ),
            (
                "many",
                "Can one node run many elections?",
                "Yes. One civic L2 can hold any number of elections. Anyone can run a civic L2, and there is no limit on how many exist.",
            ),
            (
                "id",
                "How is an election identified?",
                "By an election UUID, unique within that L2. Batches settled to Ethereum are keyed by hash of the L2 id and the election UUID, so two groups do not share a record just by reusing a name.",
            ),
            (
                "districts",
                "Can districts be nested?",
                "Yes. A city, county, or district can run elections and referendums with nested districts, measures, and articles. That structure lives on the group's roll. It is not a separate chain.",
            ),
        ],
    ),
    (
        "faqs",
        "registration",
        "Registration",
        "Joining a roll. Nothing is deposited and nothing is lent.",
        [
            (
                "join",
                "How does someone join a civic election?",
                "They register with a passkey, a wallet, email, or an ID. The roll stores an identity commitment. Registering for one election does not enroll someone in every contest on the node.",
            ),
            (
                "stored",
                "What is stored on the roll?",
                "An identity commitment. Not a name, not a wallet address, and not a document number.",
            ),
            (
                "deposit",
                "Is registration a deposit?",
                "No. Nothing of value is locked, escrowed, or lent. There is no collateral and no price bucket.",
            ),
            (
                "token",
                "Does a token balance put me on the roll?",
                "Not for a civic election. A token signal is separate: holding the chosen ERC-20 at one finalized block is the credential, there is no sign-up, and the choice stays public.",
            ),
        ],
    ),
    (
        "faqs",
        "ballots",
        "Ballots",
        "Marking a choice and proving you were allowed to mark it.",
        [
            (
                "cast",
                "How is a ballot cast?",
                "The voter marks a choice and submits a proof designed to show they are on the frozen roll and not disqualified. Voters are not charged for that submission.",
            ),
            (
                "change",
                "Can I change my vote?",
                "Only if the operator allowed re-voting when the election was created. The operator decides at creation whether re-voting is allowed, and that setting can't be changed afterward. If it is allowed, the last ballot before the deadline counts. If not, a second ballot is rejected.",
            ),
            (
                "proof",
                "What does the proof show?",
                "That an eligible person voted, once, in the way that election allows, and that the ballot is well formed. It is designed not to show which option was marked. With the mock verifier in tests, this check is not yet enforced.",
            ),
            (
                "back",
                "What do I get back?",
                "A receipt of hashes, designed so it doesn't show how you voted. Every ballot, including a re-vote, gets one.",
            ),
        ],
    ),
    (
        "faqs",
        "polls",
        "Polls",
        "A civic contest that can show running choice counts, on a delay, after a gate.",
        [
            (
                "what",
                "What is a poll?",
                "A civic contest that publishes per-choice counts on a delayed hourly schedule after a gate. Turnout is published on a delayed hourly schedule for both a poll and a vote.",
            ),
            (
                "when",
                "When do choice counts appear?",
                "Once 100 voters have cast their first ballot, or at the scheduled end, whichever comes first. Each hour publishes 30 minutes after it closes.",
            ),
            (
                "small",
                "What if an hour is small?",
                "An hour with fewer than 10 ballots merges forward until a block has at least 10.",
            ),
            (
                "blocks",
                "Do published hourly blocks change?",
                "No. Published hourly blocks are designed to stay as first published. If re-voting was allowed, replacement ballots show up only in the final tally.",
            ),
        ],
    ),
    (
        "faqs",
        "votes",
        "Votes",
        "A civic contest whose choices stay sealed until the deadline.",
        [
            (
                "what",
                "What is a vote?",
                "A civic contest that keeps choices sealed until the deadline. Turnout is published on a delayed hourly schedule. There are no interim per-choice counts.",
            ),
            (
                "read",
                "When can choices be read?",
                "At the deadline, and only as an aggregate. Choices are encrypted to a public key posted on the L2. The matching private key is split among the guardians with Shamir secret sharing, designed so no single party, including the operator, can decrypt early. The design gives the operator no key share.",
            ),
            (
                "why",
                "Why choose a vote instead of a poll?",
                "When a running choice count would add pressure. Nothing a voter is given is designed to prove their choice to someone pressuring them.",
            ),
            (
                "rank",
                "Can a vote be ranked choice?",
                "Yes, as an opt-in. Ranked choice is also available in polls. In a sealed vote, guardians then see individual rankings, not identities.",
            ),
        ],
    ),
    (
        "faqs",
        "results",
        "Results",
        "What is visible while a contest is open, and what is posted after the deadline.",
        [
            (
                "open",
                "What is published while a contest is open?",
                "Turnout is published on a delayed hourly schedule for both kinds. A poll also publishes per-choice counts on that schedule once 100 voters have cast their first ballot, or at the scheduled end, whichever comes first. A vote publishes choices only at the deadline.",
            ),
            (
                "deadline",
                "What happens at the deadline?",
                "No more ballots are accepted. One final batch goes to Ethereum at the deadline. A challenge window, which must be longer than zero, comes before the final tally.",
            ),
            (
                "extra",
                "What is the supplementary batch?",
                "After the grace period, anyone may post a missing final batch and the supplementary batch, before the final tally.",
            ),
            (
                "execute",
                "Does the tally carry out the decision?",
                "No. Passing a vote never auto-executes anything. Outcomes are verifiable. Acting on them stays with the people.",
            ),
            (
                "check",
                "How can an outsider check?",
                "Anyone can check that the published totals match the accepted ballots. An independent auditor is designed to be able to rebuild a published result without the operator's private database. Until a real aggregate verifier is in place, the tally is checked by summing ciphertexts on chain.",
            ),
        ],
    ),
    (
        "faqs",
        "privacy",
        "Privacy",
        "The choice is the secret. The process is the public part.",
        [
            (
                "private",
                "What is designed to stay private?",
                "The option on a civic ballot. It is designed never to be a readable field in a transaction or a database. Receipts are hashes, designed so they don't show how you voted.",
            ),
            (
                "public",
                "What is public?",
                "Registrations and disqualification codes are public. Turnout is published on a delayed hourly schedule for both kinds. A poll also publishes per-choice counts on that schedule once 100 voters have cast their first ballot, or at the scheduled end, whichever comes first. The final tally is public too.",
            ),
            (
                "delay",
                "Why wait to publish turnout?",
                "So leaving a polling place cannot be matched to a live tick. The delay is the hourly schedule. Counts are not padded.",
            ),
            (
                "signal",
                "Is a token signal private?",
                "No. In a token signal the choice stays public. Secret ballots are the civic election.",
            ),
        ],
    ),
    (
        "faqs",
        "officers",
        "Officers",
        "The group that hosts the node owns the roll. Officers have jobs, not a master key.",
        [
            (
                "who",
                "Who operates a node?",
                "The group that hosts it. They own the node, the roll, and the record. No vendor account is required to start, and there is no vendor lock-in.",
            ),
            (
                "jobs",
                "What do officials do?",
                "They create the election and the ballot, freeze the roll, approve registration, record a disqualification with a public reason code, and post the tally after the deadline. A host can also publish its own pages.",
            ),
            (
                "read",
                "Can an officer read how people voted?",
                "That is not the design. A vote's choices are encrypted to the guardian key, and the operator has no key share. A poll publishes aggregates. Officials do not get a private live feed of choices.",
            ),
        ],
    ),
    (
        "faqs",
        "dq",
        "Disqualification",
        "Barring someone is a public, coded change. It is not a silent flag.",
        [
            (
                "why",
                "Why might a registered person be barred?",
                "Registered is not the same as eligible. An official can bar someone for a stated reason code, for example not of age, not resident, a duplicate, or a court order. The code is public so a purge cannot hide.",
            ),
            (
                "evidence",
                "Where does the evidence go?",
                "Personal evidence stays off the chain. The public record is the reason code and a hash of the evidence, so a later review can match a sealed file to what was posted.",
            ),
            (
                "barred",
                "Can a barred person vote anyway?",
                "No. The eligible set is people who are registered and not currently disqualified. The proof is designed to require membership in that set. With the mock verifier in tests, this check is not yet enforced.",
            ),
        ],
    ),
    (
        "faqs",
        "receipts",
        "Receipts",
        "Proof that you voted. Not proof of the option you marked.",
        [
            (
                "what",
                "What is on a receipt?",
                "Hashes that show a ballot was accepted. Enough to look it up, not the option that was marked. If a screen says which option you chose, that is a bug.",
            ),
            (
                "check",
                "How do I check that it counted?",
                "On the node that ran the election, open the receipt page and paste the proof, or use the file the node gave you. The check answers whether that ballot was accepted. It does not show a candidate.",
            ),
            (
                "pressure",
                "Can someone demand my receipt as proof of my choice?",
                "A receipt is designed so it doesn't show how you voted. It cannot satisfy someone who demands proof of a choice. That refusal is intentional.",
            ),
        ],
    ),
    (
        "faqs",
        "token",
        "Not a token",
        "There is no project token, no reward for voting, and nothing to deposit.",
        [
            (
                "product",
                "Is there a ZK-Voting token?",
                "No. There is no product token, no paid tier, and no reward for voting. The license is AGPL-3.0-or-later. The repository is not a way to make money.",
            ),
            (
                "signal",
                "Then what is a token signal?",
                "An optional advisory mode on Ethereum mainnet. The host picks an existing ERC-20. Weight comes from that token at one finalized block. Delegated voting power is read there. It is not a secret ballot, it does not use the civic roll, and the result does not execute anything.",
            ),
            (
                "markets",
                "Are there incentive programs or liquidity pools?",
                "No. There is nothing to deposit, lend, borrow, liquidate, or auction. Do not send funds to anyone who announces a token sale under this name.",
            ),
        ],
    ),
    (
        "faqs",
        "community",
        "Community",
        "A forum and a public repository. Not a grants round.",
        [
            (
                "talk",
                "Where do people talk?",
                "On the community forum. Groups discuss real uses, running a node, and what to build next.",
            ),
            (
                "grants",
                "Is there a grants program?",
                "No token grants and no funding vote. Contribution is the ordinary open-source kind: read the code, file an issue, or send a patch.",
            ),
            (
                "help",
                "Can you help a group go live?",
                "Yes. The project is available for contracting for a local implementation. Use the email address in the site footer.",
            ),
        ],
    ),
    (
        "info",
        "runs",
        "Where it runs",
        "Civic ballots settle to Ethereum. There is no bridge between lending markets, because there are no lending markets.",
        [
            (
                "land",
                "Where do civic ballots land?",
                "On the group's civic L2, a purpose-built sequencer and prover. Final batches settle to Ethereum so the record outlives any single operator. Day-to-day activity is not a general-purpose chain, and it does not bridge deposits.",
            ),
            (
                "signal",
                "Where do token signals land?",
                "On Ethereum mainnet only. That mode needs an Ethereum mainnet RPC. It does not use the civic L2.",
            ),
            (
                "addresses",
                "Is there one list of official contract addresses?",
                "No single global deployment is published here as a table to copy. Each group pins the contracts its own node uses. The demo node is for trying the software, not for a production election.",
            ),
            (
                "rebuild",
                "Can results be rebuilt if a node disappears?",
                "Settling to Ethereum is what makes that possible. Results are designed to be rebuilt from the L2's data or from the L1 record. An unproven root publishes nothing and can roll back after a timeout.",
            ),
        ],
    ),
    (
        "info",
        "fits",
        "How it fits",
        "Many independent civic L2s. One shared record on Ethereum.",
        [
            (
                "picture",
                "What is the large picture?",
                "Anyone can run a civic L2, and there is no limit on how many exist. Each L2 can hold any number of elections. Every L2 settles its vote batches to Ethereum, keyed by hash of the L2 id and the election UUID.",
            ),
            (
                "inside",
                "What happens inside one L2?",
                "Voters at the edge vote for free. Only pre-approved voters are accepted. The sequencer batches the votes. The L2 computes the state root and the tally. L1 commits that root hourly and is designed to check a proof of the computation later, in order. Until a real aggregate verifier is in place, the tally is checked by summing ciphertexts on chain.",
            ),
            (
                "drawing",
                "Where is the diagram?",
                "The home page draws it: a macro view of many L2s, an L2 view of one election team, and the path a poll and a vote take to the final tally. Those figures are the protocol diagram.",
            ),
        ],
    ),
    (
        "info",
        "roadmap",
        "Roadmap",
        "What is true on this development line, and what a tally will not start doing later.",
        [
            (
                "today",
                "What is true today?",
                "You can read this site and try the voting demo. Tests use a mock verifier. The trusted-setup ceremony has not happened. Do not use it for a binding election today.",
            ),
            (
                "proving",
                "What is the proving path?",
                "A real proof check is in progress. With the mock verifier in tests, rejection of a voter who is not pre-approved is not yet enforced. Do not describe a local demo as ready for a binding election.",
            ),
            (
                "never",
                "What will a result not do?",
                "It will not auto-execute. The tally is evidence. Acting on it stays with the people. The project will also not add a product token or a fee for voters.",
            ),
        ],
    ),
    (
        "info",
        "builder",
        "Builder kit",
        "The repository is the starter kit. Fork it, and keep the not-for-profit label.",
        [
            (
                "repo",
                "What is in the repository?",
                "The node, the civic L2, the contracts, and the circuits, together, under AGPL-3.0-or-later. A group is not meant to depend on a vendor's private build. Fork it and keep the not-for-profit label.",
            ),
            (
                "read",
                "What should I read first?",
                "The README at the root of the repository, then the self-hosting guides. Every running node serves those guides at /docs.",
            ),
            (
                "agpl",
                "What does AGPL ask of a host?",
                "If you run a modified node as a network service, offer the corresponding source to the people who use that service.",
            ),
        ],
    ),
    (
        "info",
        "deploy",
        "How to deploy",
        "Run the node yourself. Do not deploy a pool, a bridge, or a token sale. Those pieces are not in this software.",
        [
            (
                "start",
                "How do I start a node?",
                "From a checkout, copy the example environment file, then start the stack. The node answers a health check. This website is only the explanation. It is not the node.",
            ),
            ("terminal",),
            (
                "platforms",
                "Which platforms?",
                "Docker Compose, Coolify, Dokploy, or CapRover. The node can stay private behind a Tailscale sidecar.",
            ),
            (
                "not",
                "What should I not deploy?",
                "Do not deploy a lending pool, a bridge for deposits, or a token sale. This software does not include them. Pin the contracts for that group's node, and do not treat the demo as a finished ceremony.",
            ),
        ],
    ),
]

for group, pid, nav, lede, qas in QA_PAGES:
    blocks = []
    for item in qas:
        if item[0] == "terminal":
            blocks.append(("terminal",))
        else:
            key, q, a = item
            blocks.append(("h2", key, q, a))
    page(group, pid, nav, nav, lede, blocks)

LINKS = [
    ("home", "Home", "/", "/"),
    ("faq", "This FAQ", "/faq", "/faq"),
    ("poll", "Poll vs Vote", "/#poll-vs-vote", "/#poll-vs-vote"),
    ("vision", "Vision", "/#vision", "/#vision"),
    ("host", "Self-host", "/#self-host", "/#self-host"),
    ("forum", "Community forum", "https://community.zk-voting.org", "community.zk-voting.org"),
    ("demo", "Voting demo", "https://demo.zk-voting.org", "demo.zk-voting.org"),
    ("github", "Source code", "https://github.com/mrabino1/zk-voting", "github.com/mrabino1/zk-voting"),
    ("email", "Email", "mailto:hello@zk-voting.org", "hello@zk-voting.org"),
    ("docs", "Node guides", "https://demo.zk-voting.org/docs", "demo.zk-voting.org/docs"),
]

GROUPS = {
    "start": "Getting started",
    "faqs": "FAQs",
    "info": "Info",
}

SHARED = {
    "faq.meta.title": "FAQ · ZK-Voting",
    "faq.meta.description": "Questions about ZK-Voting: private ballots, polls and votes, self-hosting, and what this project does not do. There is nothing to deposit.",
    "faq.navLabel": "FAQ sections",
    "faq.menu": "Sections",
    "faq.homeLink": "Home",
    "faq.onThisPage": "On this page",
    "faq.pager.prev": "Previous",
    "faq.pager.next": "Next",
    "faq.group.start": GROUPS["start"],
    "faq.group.faqs": GROUPS["faqs"],
    "faq.group.info": GROUPS["info"],
    "faq.links.resources": "Resources",
    "faq.deploy.terminalLabel": "Self-host quickstart",
    "faq.deploy.terminalComment": "# run your own node",
}

for key, label, _href, _shown in LINKS:
    SHARED[f"faq.links.{key}"] = label


def esc(text):
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def brand_key(text):
    return text.replace("ZK-Voting", "{brand}")


STRINGS = dict(SHARED)


def remember(key, text):
    STRINGS[key] = text
    return key


def article(p, prev_p, next_p):
    pid = p["id"]
    lines = []
    lines.append(f'        <article class="docs-page" id="{pid}">')
    lines.append(
        f'          <p class="eyebrow" data-i18n="faq.group.{p["group"]}">{esc(GROUPS[p["group"]])}</p>'
    )
    lines.append(f'          <h1 data-i18n="faq.{pid}.title">{esc(p["title"])}</h1>')
    remember(f"faq.{pid}.title", p["title"])
    remember(f"faq.{pid}.nav", p["nav"])
    lines.append(f'          <p class="docs-lede" data-i18n="faq.{pid}.lede">{esc(p["lede"])}</p>')
    remember(f"faq.{pid}.lede", p["lede"])
    questions = [b for b in p["blocks"] if b[0] == "h2"]
    if questions:
        lines.append(f'          <nav class="docs-onpage" aria-labelledby="{pid}-onpage">')
        lines.append(
            f'            <p id="{pid}-onpage" data-i18n="faq.onThisPage">On this page</p>'
        )
        for _kind, key, q, _a in questions:
            lines.append(
                f'            <a href="#{pid}-{key}" data-i18n="faq.{pid}.{key}.q">{esc(q)}</a>'
            )
        lines.append("          </nav>")
    for block in p["blocks"]:
        kind = block[0]
        if kind == "p":
            _k, key, text = block
            lines.append(f'          <p data-i18n="faq.{pid}.{key}">{esc(text)}</p>')
            remember(f"faq.{pid}.{key}", text)
        elif kind == "callout":
            _k, title_key, title, body_key, body = block
            lines.append('          <aside class="docs-callout">')
            lines.append(f'            <h2 data-i18n="faq.{pid}.{title_key}">{esc(title)}</h2>')
            lines.append(f'            <p data-i18n="faq.{pid}.{body_key}">{esc(body)}</p>')
            lines.append("          </aside>")
            remember(f"faq.{pid}.{title_key}", title)
            remember(f"faq.{pid}.{body_key}", body)
        elif kind == "h2":
            _k, key, q, a = block
            lines.append(f'          <h2 id="{pid}-{key}" data-i18n="faq.{pid}.{key}.q">{esc(q)}</h2>')
            lines.append(f'          <p data-i18n="faq.{pid}.{key}.a">{esc(a)}</p>')
            remember(f"faq.{pid}.{key}.q", q)
            remember(f"faq.{pid}.{key}.a", a)
        elif kind == "links":
            lines.append('          <h2 data-i18n="faq.links.resources">Resources</h2>')
            lines.append('          <ul class="docs-links">')
            for key, label, href, shown in LINKS:
                external = href.startswith("http") or href.startswith("mailto:")
                extra = ' target="_blank" rel="noopener noreferrer"' if href.startswith("http") else ""
                lines.append("            <li>")
                lines.append(f'              <a href="{esc(href)}"{extra}>')
                lines.append(
                    f'                <span data-i18n="faq.links.{key}">{esc(label)}</span>'
                )
                lines.append(f'                <span class="docs-url" dir="ltr">{esc(shown)}</span>')
                lines.append("              </a>")
                lines.append("            </li>")
            lines.append("          </ul>")
        elif kind == "glossary":
            lines.append('          <dl class="docs-glossary">')
            for key, term, defin in GLOSSARY:
                lines.append(
                    f'            <dt id="gloss-{key}" data-i18n="faq.glossary.{key}.term">{esc(term)}</dt>'
                )
                lines.append(f'            <dd data-i18n="faq.glossary.{key}.def">{esc(defin)}</dd>')
                remember(f"faq.glossary.{key}.term", term)
                remember(f"faq.glossary.{key}.def", defin)
            lines.append("          </dl>")
        elif kind == "terminal":
            lines.append(
                '          <pre class="terminal" aria-label="Self-host quickstart" data-i18n-aria-label="faq.deploy.terminalLabel"><span class="dim" dir="auto" data-i18n="faq.deploy.terminalComment"># run your own node</span>'
            )
            lines.append("cp .env.example .env")
            lines.append("docker compose up -d --build")
            lines.append("curl -fsS http://127.0.0.1:3000/health</pre>")
        else:
            raise SystemExit(f"unknown block {kind}")
    lines.append('          <p class="docs-pager">')
    if prev_p:
        lines.append(
            f'            <a class="docs-prev" href="#{prev_p["id"]}"><span data-i18n="faq.pager.prev">Previous</span><strong data-i18n="faq.{prev_p["id"]}.nav">{esc(prev_p["nav"])}</strong></a>'
        )
    if next_p:
        lines.append(
            f'            <a class="docs-next" href="#{next_p["id"]}"><span data-i18n="faq.pager.next">Next</span><strong data-i18n="faq.{next_p["id"]}.nav">{esc(next_p["nav"])}</strong></a>'
        )
    lines.append("          </p>")
    lines.append("        </article>")
    return "\n".join(lines)


def nav_html():
    lines = []
    current = None
    for p in PAGES:
        if p["group"] != current:
            current = p["group"]
            lines.append(
                f'            <p class="docs-group" data-i18n="faq.group.{current}">{esc(GROUPS[current])}</p>'
            )
        lines.append(
            f'            <a href="#{p["id"]}" data-i18n="faq.{p["id"]}.nav">{esc(p["nav"])}</a>'
        )
    return "\n".join(lines)


HEAD = r"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <script>
    /* html lang/dir before first paint. Same list as site/public/i18n.js. */
    (function () {
      var tags = { en: "en", es: "es", zh: "zh-Hans", fil: "fil", vi: "vi", ar: "ar", fr: "fr", ko: "ko", pt: "pt-BR", hi: "hi" };
      var prefixes = { en: ["en"], es: ["es"], zh: ["zh"], fil: ["fil", "tl"], vi: ["vi"], ar: ["ar"], fr: ["fr"], ko: ["ko"], pt: ["pt"], hi: ["hi"] };
      function match(list) {
        var langs = list || [];
        for (var i = 0; i < langs.length; i++) {
          var base = String(langs[i] || "").toLowerCase().replace(/_/g, "-").split("-")[0];
          if (!base) continue;
          for (var code in prefixes) {
            if (prefixes[code].indexOf(base) !== -1) return code;
          }
        }
        return "en";
      }
      var code = "en";
      try {
        var stored = window.localStorage.getItem("site_lang");
        code = tags[stored] ? stored : match(navigator.languages || [navigator.language || "en"]);
      } catch (err) {
        try { code = match(navigator.languages || [navigator.language || "en"]); } catch (err2) { code = "en"; }
      }
      document.documentElement.lang = tags[code] || "en";
      document.documentElement.dir = code === "ar" ? "rtl" : "ltr";
    })();
  </script>
  <meta name="brand-name" content="ZK-Voting">
  <title data-i18n="faq.meta.title">FAQ · ZK-Voting</title>
  <meta name="description" data-i18n-content="faq.meta.description" content="Questions about ZK-Voting: private ballots, polls and votes, self-hosting, and what this project does not do. There is nothing to deposit.">
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://zk-voting.org/faq">
  <meta property="og:site_name" data-brand-content content="ZK-Voting">
  <meta property="og:title" data-i18n-content="faq.meta.title" content="FAQ · ZK-Voting">
  <meta property="og:description" data-i18n-content="faq.meta.description" content="Questions about ZK-Voting: private ballots, polls and votes, self-hosting, and what this project does not do. There is nothing to deposit.">
  <meta property="og:locale" data-og-current content="en_US">
  <meta property="og:locale:alternate" content="es_ES">
  <meta property="og:locale:alternate" content="zh_CN">
  <meta property="og:locale:alternate" content="fil_PH">
  <meta property="og:locale:alternate" content="vi_VN">
  <meta property="og:locale:alternate" content="ar_AR">
  <meta property="og:locale:alternate" content="fr_FR">
  <meta property="og:locale:alternate" content="ko_KR">
  <meta property="og:locale:alternate" content="pt_BR">
  <meta property="og:locale:alternate" content="hi_IN">
  <link rel="canonical" href="https://zk-voting.org/faq">
  <meta name="color-scheme" content="dark">
  <link rel="icon" href="/brand-mark.svg" type="image/svg+xml">
  <link rel="icon" href="/favicon-32.png" type="image/png" sizes="32x32">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180">
  <link rel="manifest" href="/site.webmanifest">
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <!-- NOT FOR PROFIT: civic public good, not a commercial product. No tracking, no third-party assets. -->
  <a class="skip-link" href="#main" data-i18n="nav.skip">Skip to main content</a>
  <header class="nav">
    <div class="wrap nav-inner">
      <a class="brand" href="/" aria-label="ZK-Voting home" data-i18n-aria-label="nav.home"><img class="logo" src="/brand-mark-dark.svg" alt="ZK-Voting logo" data-i18n-alt="nav.logoAlt" width="30" height="36"><span class="wordmark" title="ZK-Voting"><span data-brand><span class="brand-zk">ZK</span><span class="brand-rest">-Voting</span></span></span></a>
      <div class="nav-tools">
      <nav aria-label="Main" data-i18n-aria-label="nav.main">
        <a href="/" data-i18n="faq.homeLink">Home</a>
        <a href="/faq" aria-current="page" data-i18n="nav.faq">FAQ</a>
        <a class="btn btn-sm" href="https://community.zk-voting.org" data-i18n="nav.forum">Community forum</a>
      </nav>
      <label class="lang-label nav-lang">
        <span class="visually-hidden" data-i18n="lang.label">Language</span>
        <select id="lang-switcher" data-lang-switcher>
          <option value="en">English</option>
          <option value="es">Español</option>
          <option value="zh">中文</option>
          <option value="fil">Filipino</option>
          <option value="vi">Tiếng Việt</option>
          <option value="ar">العربية</option>
          <option value="fr">Français</option>
          <option value="ko">한국어</option>
          <option value="pt">Português</option>
          <option value="hi">हिन्दी</option>
        </select>
      </label>
      </div>
    </div>
  </header>
  <div class="docs">
    <details class="docs-drawer" open>
      <summary data-i18n="faq.menu">Sections</summary>
      <nav class="docs-nav" aria-label="FAQ sections" data-i18n-aria-label="faq.navLabel">
"""

FOOT = r"""      </nav>
    </details>
    <div class="docs-content" id="main" tabindex="-1">
"""

TAIL = r"""    </div>
  </div>
  <footer>
    <div class="wrap foot-main">
      <div class="foot-block" role="region" aria-labelledby="footer-contact-label">
        <p class="foot-label" id="footer-contact-label" data-i18n="footer.contact">Contact</p>
        <a class="foot-mail" href="mailto:hello@zk-voting.org">hello@zk-voting.org</a>
      </div>
      <div class="foot-block">
        <p class="foot-oss"><a href="https://github.com/mrabino1/zk-voting" data-i18n="footer.oss">ZK-Voting is 100% open source and free to use.</a></p>
      </div>
      <div class="foot-block">
        <p data-i18n="footer.contracting">We are available for contracting for your local implementation.</p>
        <a class="btn btn-sm" href="mailto:hello@zk-voting.org" data-i18n="footer.email">Email us</a>
      </div>
    </div>
    <div class="wrap foot">
      <span>&copy; <span data-brand>ZK-Voting</span> <span data-i18n="footer.contributors">contributors</span> &middot; AGPL-3.0-or-later &middot; <span data-i18n="footer.nonprofit">Not for profit</span></span>
      <span class="foot-end">
        <span><a href="/faq" aria-current="page" data-i18n="footer.faq">FAQ</a> &middot; <a href="https://community.zk-voting.org" data-i18n="footer.forum">Community forum</a> &middot; <a href="https://demo.zk-voting.org" data-i18n="footer.demo">Voting demo</a></span>
        <a class="gh-link" href="https://github.com/mrabino1/zk-voting" target="_blank" rel="noopener noreferrer" data-i18n-aria-label="footer.github" aria-label="ZK-Voting on GitHub">
          <svg class="gh-mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill-rule="evenodd" clip-rule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/></svg>
        </a>
      </span>
    </div>
  </footer>
  <script type="module" src="/i18n.js"></script>
  <script type="module" src="/faq-nav.js"></script>
</body>
</html>
"""


def js_string(value):
    return '"' + brand_key(value).replace("\\", "\\\\").replace('"', '\\"') + '"'


def dump_en():
    # Nest by dotted keys under export default.
    root = {}
    for key, value in STRINGS.items():
        parts = key.split(".")
        cur = root
        for part in parts[:-1]:
            cur = cur.setdefault(part, {})
        cur[parts[-1]] = brand_key(value)

    def emit(obj, indent):
        pad = "  " * indent
        if isinstance(obj, dict):
            lines = ["{"]
            items = list(obj.items())
            for i, (k, v) in enumerate(items):
                comma = "," if i < len(items) - 1 else ""
                key = js_string(k)
                if isinstance(v, dict):
                    lines.append(f"{pad}  {key}: {emit(v, indent + 1)}{comma}")
                else:
                    lines.append(f"{pad}  {key}: {js_string(v)}{comma}")
            lines.append(f"{pad}}}")
            return "\n".join(lines)
        return js_string(obj)

    body = emit(root, 0)
    return (
        "/** FAQ copy for zk-voting.org/faq (English). {brand} is the display name. */\n\n"
        f"export default {body};\n"
    )


def main():
    parts = [HEAD, nav_html(), FOOT]
    for i, p in enumerate(PAGES):
        prev_p = PAGES[i - 1] if i else None
        next_p = PAGES[i + 1] if i + 1 < len(PAGES) else None
        parts.append(article(p, prev_p, next_p))
        parts.append("")
    parts.append(TAIL)
    html = "\n".join(parts)
    (PUBLIC / "faq.html").write_text(html, encoding="utf-8")
    out = PUBLIC / "locales" / "faq"
    out.mkdir(parents=True, exist_ok=True)
    (out / "en.js").write_text(dump_en(), encoding="utf-8")
    print(f"pages {len(PAGES)} strings {len(STRINGS)}")


if __name__ == "__main__":
    main()

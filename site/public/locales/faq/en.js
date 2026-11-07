/** FAQ copy for zk-voting.org/faq (English). {brand} is the display name. */

export default {
  "faq": {
    "meta": {
      "title": "FAQ · {brand}",
      "description": "Questions about {brand}: private ballots, polls and votes, self-hosting, and what this project does not do. There is nothing to deposit."
    },
    "navLabel": "FAQ sections",
    "menu": "Sections",
    "homeLink": "Home",
    "onThisPage": "On this page",
    "pager": {
      "prev": "Previous",
      "next": "Next"
    },
    "group": {
      "start": "Getting started",
      "faqs": "FAQs",
      "info": "Info"
    },
    "links": {
      "resources": "Resources",
      "home": "Home",
      "faq": "This FAQ",
      "poll": "Poll vs Vote",
      "vision": "Vision",
      "host": "Self-host",
      "forum": "Community forum",
      "demo": "Voting demo",
      "github": "Source code",
      "email": "Email",
      "docs": "Node guides"
    },
    "deploy": {
      "terminalLabel": "Self-host quickstart",
      "terminalComment": "# run your own node",
      "title": "How to deploy",
      "nav": "How to deploy",
      "lede": "Run the node yourself. Do not deploy a pool, a bridge, or a token sale. Those pieces are not in this software.",
      "start": {
        "q": "How do I start a node?",
        "a": "From a checkout, copy the example environment file, then start the stack. The node answers a health check. This website is only the explanation. It is not the node."
      },
      "platforms": {
        "q": "Which platforms?",
        "a": "Docker Compose, Coolify, Dokploy, or CapRover. The node can stay private behind a Tailscale sidecar."
      },
      "not": {
        "q": "What should I not deploy?",
        "a": "Do not deploy a lending pool, a bridge for deposits, or a token sale. This software does not include them. Pin the contracts for that group's node, and do not treat the demo as a finished ceremony."
      }
    },
    "welcome": {
      "title": "Welcome",
      "nav": "Welcome",
      "lede": "Notes for voters, officials, and people deciding whether to host a node. This is not a lending protocol. There is nothing to deposit.",
      "p1": "{brand} is a not-for-profit, open-source way for a group to run its own elections and polls. A civic election is one person, one vote, and the choice is designed to stay unpublished. Separately, a host can run an advisory token signal on Ethereum mainnet. That signal is not a civic election: weight comes from an ERC-20 at one finalized block, there is no registration, signing is free, and the choice stays public.",
      "p2": "These pages follow the landing page. They explain how a poll differs from a vote, what is public, what is designed to stay private, and how a group hosts its own node. They are not a promise that a deploy satisfies an elections statute.",
      "disclaimerTitle": "Disclaimer",
      "disclaimer": "This site is general information. It is not legal advice and it is not a certification. {brand} is under active development. Tests use a mock verifier, and the trusted-setup ceremony has not happened. Do not use it for a binding election today. Passing a vote never auto-executes anything."
    },
    "quick-links": {
      "title": "Quick Links",
      "nav": "Quick Links",
      "lede": "The pages and rooms that exist for this project. There is no borrow screen, no lend screen, and no place to deposit funds.",
      "note": "Markets, liquidations, reserve auctions, incentive programs, and price buckets are not part of {brand}. If a page asks you to deposit or to buy a token, it is not this project."
    },
    "glossary": {
      "title": "Glossary",
      "nav": "Glossary",
      "lede": "Short definitions. They match the landing page, and they leave out anything this project does not do.",
      "note": "Definitions are simplified and may not be a complete specification.",
      "civic": {
        "term": "Civic election",
        "def": "One person, one vote, with registration and a secret ballot."
      },
      "signal": {
        "term": "Token signal",
        "def": "An advisory poll weighted by an ERC-20 at one finalized Ethereum block. There is no registration, and the choice stays public. It does not use the civic L2."
      },
      "poll": {
        "term": "Poll",
        "def": "A civic contest that publishes per-choice counts on a delayed hourly schedule after a gate. Turnout uses that same hourly schedule."
      },
      "vote": {
        "term": "Vote",
        "def": "A civic contest that keeps choices sealed until the deadline. Turnout is published on a delayed hourly schedule. There are no interim per-choice counts."
      },
      "roll": {
        "term": "Roll",
        "def": "The eligible set for one election. It stores identity commitments, not names, wallet addresses, or document numbers."
      },
      "commitment": {
        "term": "Identity commitment",
        "def": "The value written on the roll. It is not a wallet address and not a document number."
      },
      "revote": {
        "term": "Re-vote",
        "def": "The operator decides at creation whether re-voting is allowed, and that setting can't be changed afterward. If it is allowed, the last ballot before the deadline counts. If not, a second ballot is rejected."
      },
      "gate": {
        "term": "Gate",
        "def": "For a poll, choice counts stay hidden until 100 voters have cast their first ballot, or the scheduled end arrives, whichever comes first."
      },
      "block": {
        "term": "Hourly block",
        "def": "A published slice of a poll's per-choice counts. An hour with fewer than 10 ballots merges forward until a block has at least 10. A published block is designed to stay as first published."
      },
      "receipt": {
        "term": "Receipt",
        "def": "Evidence that a ballot was accepted. It is hashes, designed so it doesn't show how you voted."
      },
      "guardian": {
        "term": "Guardian",
        "def": "One of the k-of-n parties who can decrypt a vote only as an aggregate at the deadline. The design gives the operator no key share."
      },
      "l2": {
        "term": "Civic L2",
        "def": "A purpose-built sequencer and prover a group runs for its own elections. It settles batches to Ethereum. It is not a general-purpose chain."
      },
      "uuid": {
        "term": "Election UUID",
        "def": "The public id of one election, unique within that L2. Ethereum keys a batch by hash of the L2 id and this UUID."
      },
      "mock": {
        "term": "Mock verifier",
        "def": "The stand-in used in tests for a real proof check. With it, rejection of a voter who is not pre-approved is not yet enforced."
      }
    },
    "general": {
      "title": "General",
      "nav": "General",
      "lede": "What the project is, what it costs, and what it refuses to claim.",
      "what": {
        "q": "What is {brand}?",
        "a": "A not-for-profit, open-source voting system any group can run itself. Zero-knowledge proofs are designed to show that only eligible people voted, each one once, and that the published tally matches the ballots. Tests currently use a mock verifier. Individual choices are designed not to be published."
      },
      "features": {
        "q": "What are the key features?",
        "a": "Self-hosting, and one person, one vote on a civic election. A separate advisory token signal that is not a secret ballot. Polls with delayed hourly choice counts after a gate, and votes that stay sealed until the deadline. Public registration and disqualification codes. Receipts that are hashes. An AGPL license, no fee for voters, and no product token."
      },
      "who": {
        "q": "Who is it for?",
        "a": "Any body that needs a roll, a ballot, and a result people can check: cities, counties, unions, cooperatives, boards, schools, clubs, and observers."
      },
      "fees": {
        "q": "What are the fees?",
        "a": "Voters are not charged. There is no deposit, no origination fee, and no interest. A host pays for its own servers. On the civic L2, the operator's minimally funded Ethereum key pays to submit batches. On a token signal, signing a ballot is free. Delegating that token is the transaction that costs gas."
      },
      "audit": {
        "q": "Has it been audited?",
        "a": "Not as a finished system. The code is public under AGPL-3.0-or-later. Tests use a mock verifier, the first proving path is in progress, and the trusted-setup ceremony has not happened. There is no paid bug-bounty program."
      },
      "down": {
        "q": "What if this website goes down?",
        "a": "This website only explains the project. A group's election runs on the node that group hosts. The software is open source, so someone else can serve the same pages from the repository. A node can also stay on a private network."
      },
      "admin": {
        "q": "Does anyone control every election?",
        "a": "No. Each group runs its own node and owns its roll. Officials on that node create elections, freeze the roll, record disqualifications, and post the tally. Those jobs are not a back door that publishes choices."
      }
    },
    "elections": {
      "title": "Elections",
      "nav": "Elections",
      "lede": "A contest with a roll and a ballot. Not a liquidity pool.",
      "what": {
        "q": "What is an election here?",
        "a": "A contest with a roll, a ballot, and a published result. When it is created, the operator chooses a poll or a vote, and whether re-voting is allowed. That setting can't be changed afterward."
      },
      "many": {
        "q": "Can one node run many elections?",
        "a": "Yes. One civic L2 can hold any number of elections. Anyone can run a civic L2, and there is no limit on how many exist."
      },
      "id": {
        "q": "How is an election identified?",
        "a": "By an election UUID, unique within that L2. Batches settled to Ethereum are keyed by hash of the L2 id and the election UUID, so two groups do not share a record just by reusing a name."
      },
      "districts": {
        "q": "Can districts be nested?",
        "a": "Yes. A city, county, or district can run elections and referendums with nested districts, measures, and articles. That structure lives on the group's roll. It is not a separate chain."
      }
    },
    "registration": {
      "title": "Registration",
      "nav": "Registration",
      "lede": "Joining a roll. Nothing is deposited and nothing is lent.",
      "join": {
        "q": "How does someone join a civic election?",
        "a": "They register with a passkey, a wallet, email, or an ID. The roll stores an identity commitment. Registering for one election does not enroll someone in every contest on the node."
      },
      "stored": {
        "q": "What is stored on the roll?",
        "a": "An identity commitment. Not a name, not a wallet address, and not a document number."
      },
      "deposit": {
        "q": "Is registration a deposit?",
        "a": "No. Nothing of value is locked, escrowed, or lent. There is no collateral and no price bucket."
      },
      "token": {
        "q": "Does a token balance put me on the roll?",
        "a": "Not for a civic election. A token signal is separate: holding the chosen ERC-20 at one finalized block is the credential, there is no sign-up, and the choice stays public."
      }
    },
    "ballots": {
      "title": "Ballots",
      "nav": "Ballots",
      "lede": "Marking a choice and proving you were allowed to mark it.",
      "cast": {
        "q": "How is a ballot cast?",
        "a": "The voter marks a choice and submits a proof designed to show they are on the frozen roll and not disqualified. Voters are not charged for that submission."
      },
      "change": {
        "q": "Can I change my vote?",
        "a": "Only if the operator allowed re-voting when the election was created. The operator decides at creation whether re-voting is allowed, and that setting can't be changed afterward. If it is allowed, the last ballot before the deadline counts. If not, a second ballot is rejected."
      },
      "proof": {
        "q": "What does the proof show?",
        "a": "That an eligible person voted, once, in the way that election allows, and that the ballot is well formed. It is designed not to show which option was marked. With the mock verifier in tests, this check is not yet enforced."
      },
      "back": {
        "q": "What do I get back?",
        "a": "A receipt of hashes, designed so it doesn't show how you voted. Every ballot, including a re-vote, gets one."
      }
    },
    "polls": {
      "title": "Polls",
      "nav": "Polls",
      "lede": "A civic contest that can show running choice counts, on a delay, after a gate.",
      "what": {
        "q": "What is a poll?",
        "a": "A civic contest that publishes per-choice counts on a delayed hourly schedule after a gate. Turnout is published on a delayed hourly schedule for both a poll and a vote."
      },
      "when": {
        "q": "When do choice counts appear?",
        "a": "Once 100 voters have cast their first ballot, or at the scheduled end, whichever comes first. Each hour publishes 30 minutes after it closes."
      },
      "small": {
        "q": "What if an hour is small?",
        "a": "An hour with fewer than 10 ballots merges forward until a block has at least 10."
      },
      "blocks": {
        "q": "Do published hourly blocks change?",
        "a": "No. Published hourly blocks are designed to stay as first published. If re-voting was allowed, replacement ballots show up only in the final tally."
      }
    },
    "votes": {
      "title": "Votes",
      "nav": "Votes",
      "lede": "A civic contest whose choices stay sealed until the deadline.",
      "what": {
        "q": "What is a vote?",
        "a": "A civic contest that keeps choices sealed until the deadline. Turnout is published on a delayed hourly schedule. There are no interim per-choice counts."
      },
      "read": {
        "q": "When can choices be read?",
        "a": "At the deadline, and only as an aggregate. Choices are encrypted to a public key posted on the L2. The matching private key is split among the guardians with Shamir secret sharing, designed so no single party, including the operator, can decrypt early. The design gives the operator no key share."
      },
      "why": {
        "q": "Why choose a vote instead of a poll?",
        "a": "When a running choice count would add pressure. Nothing a voter is given is designed to prove their choice to someone pressuring them."
      },
      "rank": {
        "q": "Can a vote be ranked choice?",
        "a": "Yes, as an opt-in. Ranked choice is also available in polls. In a sealed vote, guardians then see individual rankings, not identities."
      }
    },
    "results": {
      "title": "Results",
      "nav": "Results",
      "lede": "What is visible while a contest is open, and what is posted after the deadline.",
      "open": {
        "q": "What is published while a contest is open?",
        "a": "Turnout is published on a delayed hourly schedule for both kinds. A poll also publishes per-choice counts on that schedule once 100 voters have cast their first ballot, or at the scheduled end, whichever comes first. A vote publishes choices only at the deadline."
      },
      "deadline": {
        "q": "What happens at the deadline?",
        "a": "No more ballots are accepted. One final batch goes to Ethereum at the deadline. A challenge window, which must be longer than zero, comes before the final tally."
      },
      "extra": {
        "q": "What is the supplementary batch?",
        "a": "After the grace period, anyone may post a missing final batch and the supplementary batch, before the final tally."
      },
      "execute": {
        "q": "Does the tally carry out the decision?",
        "a": "No. Passing a vote never auto-executes anything. Outcomes are verifiable. Acting on them stays with the people."
      },
      "check": {
        "q": "How can an outsider check?",
        "a": "Anyone can check that the published totals match the accepted ballots. An independent auditor is designed to be able to rebuild a published result without the operator's private database. Until a real aggregate verifier is in place, the tally is checked by summing ciphertexts on chain."
      }
    },
    "privacy": {
      "title": "Privacy",
      "nav": "Privacy",
      "lede": "The choice is the secret. The process is the public part.",
      "private": {
        "q": "What is designed to stay private?",
        "a": "The option on a civic ballot. It is designed never to be a readable field in a transaction or a database. Receipts are hashes, designed so they don't show how you voted."
      },
      "public": {
        "q": "What is public?",
        "a": "Registrations and disqualification codes are public. Turnout is published on a delayed hourly schedule for both kinds. A poll also publishes per-choice counts on that schedule once 100 voters have cast their first ballot, or at the scheduled end, whichever comes first. The final tally is public too."
      },
      "delay": {
        "q": "Why wait to publish turnout?",
        "a": "So leaving a polling place cannot be matched to a live tick. The delay is the hourly schedule. Counts are not padded."
      },
      "signal": {
        "q": "Is a token signal private?",
        "a": "No. In a token signal the choice stays public. Secret ballots are the civic election."
      }
    },
    "officers": {
      "title": "Officers",
      "nav": "Officers",
      "lede": "The group that hosts the node owns the roll. Officers have jobs, not a master key.",
      "who": {
        "q": "Who operates a node?",
        "a": "The group that hosts it. They own the node, the roll, and the record. No vendor account is required to start, and there is no vendor lock-in."
      },
      "jobs": {
        "q": "What do officials do?",
        "a": "They create the election and the ballot, freeze the roll, approve registration, record a disqualification with a public reason code, and post the tally after the deadline. A host can also publish its own pages."
      },
      "read": {
        "q": "Can an officer read how people voted?",
        "a": "That is not the design. A vote's choices are encrypted to the guardian key, and the operator has no key share. A poll publishes aggregates. Officials do not get a private live feed of choices."
      }
    },
    "dq": {
      "title": "Disqualification",
      "nav": "Disqualification",
      "lede": "Barring someone is a public, coded change. It is not a silent flag.",
      "why": {
        "q": "Why might a registered person be barred?",
        "a": "Registered is not the same as eligible. An official can bar someone for a stated reason code, for example not of age, not resident, a duplicate, or a court order. The code is public so a purge cannot hide."
      },
      "evidence": {
        "q": "Where does the evidence go?",
        "a": "Personal evidence stays off the chain. The public record is the reason code and a hash of the evidence, so a later review can match a sealed file to what was posted."
      },
      "barred": {
        "q": "Can a barred person vote anyway?",
        "a": "No. The eligible set is people who are registered and not currently disqualified. The proof is designed to require membership in that set. With the mock verifier in tests, this check is not yet enforced."
      }
    },
    "receipts": {
      "title": "Receipts",
      "nav": "Receipts",
      "lede": "Proof that you voted. Not proof of the option you marked.",
      "what": {
        "q": "What is on a receipt?",
        "a": "Hashes that show a ballot was accepted. Enough to look it up, not the option that was marked. If a screen says which option you chose, that is a bug."
      },
      "check": {
        "q": "How do I check that it counted?",
        "a": "On the node that ran the election, open the receipt page and paste the proof, or use the file the node gave you. The check answers whether that ballot was accepted. It does not show a candidate."
      },
      "pressure": {
        "q": "Can someone demand my receipt as proof of my choice?",
        "a": "A receipt is designed so it doesn't show how you voted. It cannot satisfy someone who demands proof of a choice. That refusal is intentional."
      }
    },
    "token": {
      "title": "Not a token",
      "nav": "Not a token",
      "lede": "There is no project token, no reward for voting, and nothing to deposit.",
      "product": {
        "q": "Is there a {brand} token?",
        "a": "No. There is no product token, no paid tier, and no reward for voting. The license is AGPL-3.0-or-later. The repository is not a way to make money."
      },
      "signal": {
        "q": "Then what is a token signal?",
        "a": "An optional advisory mode on Ethereum mainnet. The host picks an existing ERC-20. Weight comes from that token at one finalized block. Delegated voting power is read there. It is not a secret ballot, it does not use the civic roll, and the result does not execute anything."
      },
      "markets": {
        "q": "Are there incentive programs or liquidity pools?",
        "a": "No. There is nothing to deposit, lend, borrow, liquidate, or auction. Do not send funds to anyone who announces a token sale under this name."
      }
    },
    "community": {
      "title": "Community",
      "nav": "Community",
      "lede": "A forum and a public repository. Not a grants round.",
      "talk": {
        "q": "Where do people talk?",
        "a": "On the community forum. Groups discuss real uses, running a node, and what to build next."
      },
      "grants": {
        "q": "Is there a grants program?",
        "a": "No token grants and no funding vote. Contribution is the ordinary open-source kind: read the code, file an issue, or send a patch."
      },
      "help": {
        "q": "Can you help a group go live?",
        "a": "Yes. The project is available for contracting for a local implementation. Use the email address in the site footer."
      }
    },
    "runs": {
      "title": "Where it runs",
      "nav": "Where it runs",
      "lede": "Civic ballots settle to Ethereum. There is no bridge between lending markets, because there are no lending markets.",
      "land": {
        "q": "Where do civic ballots land?",
        "a": "On the group's civic L2, a purpose-built sequencer and prover. Final batches settle to Ethereum so the record outlives any single operator. Day-to-day activity is not a general-purpose chain, and it does not bridge deposits."
      },
      "signal": {
        "q": "Where do token signals land?",
        "a": "On Ethereum mainnet only. That mode needs an Ethereum mainnet RPC. It does not use the civic L2."
      },
      "addresses": {
        "q": "Is there one list of official contract addresses?",
        "a": "No single global deployment is published here as a table to copy. Each group pins the contracts its own node uses. The demo node is for trying the software, not for a production election."
      },
      "rebuild": {
        "q": "Can results be rebuilt if a node disappears?",
        "a": "Settling to Ethereum is what makes that possible. Results are designed to be rebuilt from the L2's data or from the L1 record. An unproven root publishes nothing and can roll back after a timeout."
      }
    },
    "fits": {
      "title": "How it fits",
      "nav": "How it fits",
      "lede": "Many independent civic L2s. One shared record on Ethereum.",
      "picture": {
        "q": "What is the large picture?",
        "a": "Anyone can run a civic L2, and there is no limit on how many exist. Each L2 can hold any number of elections. Every L2 settles its vote batches to Ethereum, keyed by hash of the L2 id and the election UUID."
      },
      "inside": {
        "q": "What happens inside one L2?",
        "a": "Voters at the edge vote for free. Only pre-approved voters are accepted. The sequencer batches the votes. The L2 computes the state root and the tally. L1 commits that root hourly and is designed to check a proof of the computation later, in order. Until a real aggregate verifier is in place, the tally is checked by summing ciphertexts on chain."
      },
      "drawing": {
        "q": "Where is the diagram?",
        "a": "The home page draws it: a macro view of many L2s, an L2 view of one election team, and the path a poll and a vote take to the final tally. Those figures are the protocol diagram."
      }
    },
    "roadmap": {
      "title": "Roadmap",
      "nav": "Roadmap",
      "lede": "What is true on this development line, and what a tally will not start doing later.",
      "today": {
        "q": "What is true today?",
        "a": "You can read this site and try the voting demo. Tests use a mock verifier. The trusted-setup ceremony has not happened. Do not use it for a binding election today."
      },
      "proving": {
        "q": "What is the proving path?",
        "a": "A real proof check is in progress. With the mock verifier in tests, rejection of a voter who is not pre-approved is not yet enforced. Do not describe a local demo as ready for a binding election."
      },
      "never": {
        "q": "What will a result not do?",
        "a": "It will not auto-execute. The tally is evidence. Acting on it stays with the people. The project will also not add a product token or a fee for voters."
      }
    },
    "builder": {
      "title": "Builder kit",
      "nav": "Builder kit",
      "lede": "The repository is the starter kit. Fork it, and keep the not-for-profit label.",
      "repo": {
        "q": "What is in the repository?",
        "a": "The node, the civic L2, the contracts, and the circuits, together, under AGPL-3.0-or-later. A group is not meant to depend on a vendor's private build. Fork it and keep the not-for-profit label."
      },
      "read": {
        "q": "What should I read first?",
        "a": "The README at the root of the repository, then the self-hosting guides. Every running node serves those guides at /docs."
      },
      "agpl": {
        "q": "What does AGPL ask of a host?",
        "a": "If you run a modified node as a network service, offer the corresponding source to the people who use that service."
      }
    }
  }
};

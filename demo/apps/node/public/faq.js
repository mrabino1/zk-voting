/**
 * NOT FOR PROFIT — ZK-Voting is a civic public good. Not a commercial product.
 * Public FAQ copy. Keep answers honest to README on test/unstable (demo crypto).
 */

import { brandName } from "./brand.js";

export const FAQ_ENTRIES = [
  {
    id: "what-is-zk",
    topic: "zk-voting",
    q: "What is zero-knowledge voting here?",
    a: [
      `${brandName()} uses zero-knowledge proofs so the chain can check facts about a voter without putting the ballot in the clear. A valid vote proof is supposed to show: you are in the eligible set for that election, you are not on the disqualification set, and this ciphertext is a well-formed ballot. A nullifier marks that you already voted, without naming you.`,
      "ZK does not mean nobody is in charge. A jurisdiction still maintains the legal roll. ZK means that once that roll and the disqualification list are committed, counting and eligibility checks are not meant to be a second, invisible trust sink.",
      "On this development line the product intent is that model. Implementation is incomplete: unit tests still default to a MockVerifier, and a production Groth16 ceremony has not been run. Poseidon(2) is the vote-circuit hasher and matches the JS and Solidity helpers. The checked Groth16 fixture is an untrusted local Vote(4) setup, not an election and not a ceremony. Do not treat a local demo accept as circuit-enforced exclusion.",
    ],
  },
  {
    id: "privacy-vs-transparency",
    topic: "privacy-transparency",
    q: "How can a ballot stay private if the election is publicly verifiable?",
    a: [
      "Privacy is for the choice. Transparency is for the process. Registration events, disqualification actions (reason codes, not personal evidence), poll parameters, and the published tally are meant to be checkable. The option you marked is not an on-chain plaintext field.",
      "Receipts list hashes only (ballot hash, nullifier, related transaction identifiers). They cannot prove “I voted for X.” After you vote you may email that receipt: the message body and a PDF attachment are the same evidence, still without your choices. Dashboards delay vote proofs by one closed hour so walking out of a polling place cannot be matched to a live tick.",
    ],
  },
  {
    id: "fork-shared-contracts",
    topic: "who-runs",
    q: "Do we deploy a new smart contract when we fork this Node?",
    a: [
      "No. Fork the Node UI for your jurisdiction’s clerk desk and public pages. Pin the one shared ElectionFactory, BallotInbox, and verifier on Site & contracts (or with ELECTION_FACTORY_ADDRESS). Do not run a new factory deploy for each city.",
      "The Node host (platform_admin) updates About, FAQ, home copy, and the site title. Clerks publish extra pages tagged to their own jurisdiction. A clerk of one body on a shared Node cannot rewrite the public record for every body. The chain addresses stay the shared deployment. This line is still a demo: MockVerifier, unwired Poseidon, no production ceremony.",
    ],
  },
  {
    id: "who-can-run",
    topic: "who-runs",
    q: `Who can run ${brandName()}?`,
    a: [
      "Any body that needs a roll, a ballot, and a binding result can host it at cost: a city, county, state, nation, union, cooperative, professional college, or (if a jurisdiction demanded it) a shareholder meeting. There is no vendor lock-in and no paid SaaS tier in this repository.",
      "Running it does not, by itself, satisfy a given elections statute. Legal adoption is a question for that jurisdiction. This software is a civic public good, not a certification that a court must accept a particular deploy.",
    ],
  },
  {
    id: "passkey-vs-wallet",
    topic: "passkey-wallet",
    q: "Should I use a passkey or a Web3 wallet?",
    a: [
      "A person is unique. You may verify email, a Web3 wallet, a smart-card reader, a driver’s license or passport, and a passkey. Several Ethereum addresses can be verified internally; only one is active. The vote Merkle leaf is an identity commitment, never the active wallet address, never a document number, and never a seed phrase.",
      "Passkeys (WebAuthn, discoverable) remain available on the device you will vote from. Ethereum login is a SIWE-like personal_sign. Smart cards are a kiosk reader fingerprint in this build. License/passport login hashes the document; it is not commercial identity verification and it is not court-ready. Every path still sends a one-time code to email via AWS SES.",
    ],
  },
  {
    id: "one-vote",
    topic: "one-vote",
    q: "Can I vote more than once in an election?",
    a: [
      "No. Each nullifier is accepted once. A second ballot — including a new ciphertext — is rejected (NullifierUsed). Double voting is impossible on that rule. You may change your mind privately on the ballot form before you submit. After the inbox accepts the ballot you cannot recast.",
      "This is not MACI and not “last vote counts.” Coercion-resistance upgrades of that kind are still later work.",
    ],
  },
  {
    id: "disqualification",
    topic: "disqualification",
    q: "I am registered. Why might I still be barred?",
    a: [
      "Registered is not the same as eligible. A clerk or disqualification officer may bar a registered person for a coded reason: not of age, not resident, duplicate identity, deceased, moved out, district mismatch, already voted, court order, and others in the public catalog. The code is public so a mass purge cannot hide behind ZK. Personal evidence stays off-chain; only a hash of the evidence is posted.",
      "A disqualified person is dropped from the eligible set (registered, and not currently disqualified) and placed on an indexed disqualification chain. The vote proof must show membership in the eligible set and a gap in that chain, so a disqualified leaf has no accepting witness. The vote POST does not carry the commitment; open-window roots must still match. An unarmed MockVerifier still accepts a dummy proof that copies the published roots. The dev Vote(20) key is untrusted until a ceremony.",
    ],
  },
  {
    id: "hourly-disclosure",
    topic: "hourly-disclosure",
    q: "Why do public counts wait an hour?",
    a: [
      "Your ballot is accepted immediately so the nullifier cannot be reused. Public dashboards and the explorer only show that vote after the UTC hour that contained it has closed. A person leaving a voting office cannot be matched to a live jurisdiction increase.",
      "The snapshot lists the last closed hour, how many ballots have been disclosed so far, and a countdown to the next hour close — never a pending-per-election live tick. Officials do not get a private live precinct feed either.",
    ],
  },
  {
    id: "ranked-choice",
    topic: "ranked-choice",
    q: `Does ${brandName()} support ranked choice?`,
    a: [
      "Yes, on this Node path. Clerks can set the election ballot method to ranked_choice (instant-runoff / IRV). RANKED questions always use IRV. YES_NO stays plurality. Voters rank options on the ballot; the Node stores an IRV round transcript (aggregate first-preference counts per round, eliminated candidate, winner). Individual rankings are not published.",
      "On-chain v1 does not add a Solidity method enum; the method lives in the canonical ballot JSON hashed into ballotSpecHash. Mixed ballots still certify a plurality concatenation on L1. Ranked-choice is implemented in the Node UI and tally helpers, not as a separate production ZK ranking circuit.",
    ],
  },
  {
    id: "results",
    topic: "results",
    q: "Where do I see results?",
    a: [
      "Open /elections for the list, or /elections/:id/results for one contest (UUID or short code). Results pages are public. Plurality winners are labeled per question. Ranked-choice contests show the IRV winner and round transcript when posted.",
      "Until a tally operator posts counts after cutoff, the page reports status (open, closed, not yet tallied). Choice plaintext never appears there.",
      "A separate public monitor at /outcomes (alias /monitor) lists every election in before / during / after columns from chain and election state, and runs the auditor pack plus freeze-root and L1 checks. It is not the /receipt portal. During voting it still does not invent unofficial option counts.",
    ],
  },
  {
    id: "outcomes-monitor",
    topic: "outcomes",
    q: "What is the /outcomes portal?",
    a: [
      "It is a public monitor of every election on this Node, separate from certified results at /elections and from personal receipts at /receipt. Contests sit in before, during, or after columns according to chain and election state: created or roll-frozen, open for voting, or closed / tallied.",
      "Each contest runs the same public auditor pack an independent observer can download (unique nullifiers, no choice leak, tally bounds when posted) plus freeze-root and L1 hash checks. While voting is open the page shows disclosed turnout only — never unofficial option totals. Certified counts appear only after a tally is posted. After cutoff and a tally, the locked official PDF is also published there for download and verification.",
    ],
  },
  {
    id: "official-outcome-pdf",
    topic: "outcome-reports",
    q: "What is the official outcome PDF?",
    a: [
      `Once voting time has completely expired and a certified tally is posted, ${brandName()} issues a locked official PDF: how many people voted for each option, when the contest started, and when it ended. The file uses PDF Standard Security so it cannot be edited. A QR code and SHA-256 / HMAC seals are always included; clerks can customize letterhead and intro on the admin page but cannot remove those seals.`,
      "If you vote, you are subscribed to that contest’s official report by default. Unsubscribe from My desk only if you do not want the email. Drop the file at /outcomes/verify (or scan the QR) to confirm the bytes still match the Node fingerprint. A changed copy will fail.",
    ],
  },
  {
    id: "not-for-profit",
    topic: "not-for-profit",
    q: "Is this a company or a token?",
    a: [
      `No. ${brandName()} is not for profit: civic public good, not a commercial product. There is no token, no paid tier, and no vendor lock-in. Nobody is to make money off this repository. Jurisdictions may run it at cost (hosts, paymaster gas, paper notice). Voter data is not a product.`,
      "The license is AGPL-3.0-or-later. Every document carries a visible NOT FOR PROFIT label. If a build adds a fee control, that is a bug.",
    ],
  },
  {
    id: "will-not",
    topic: "will-not",
    q: "What will this system not do?",
    a: [
      "It will not guarantee that a government must use it, or that using it satisfies a given elections statute. It will not put every voter’s home address and ID number on Ethereum by default. It will not let a disqualified person vote “privately anyway.” It will not hide mass disqualification behind ZK. It will not charge voters or wrap itself in a token.",
      "It also will not replace a nation’s identity system, invent a legal person who does not exist, or force a tally operator to publish on time (liveness is different from tallying wrong). It is not a production ceremony, not MACI, and not a claim that a particular demo is court-ready.",
    ],
  },
  {
    id: "how-to-register",
    topic: "how-to-register",
    q: "How do I register to vote?",
    a: [
      "Open Register (or Identify yourself). Bind email, a Web3 wallet, a smart-card reader, one or more driver’s licenses or passports, or a passkey. You may verify several Ethereum addresses by signing a challenge; exactly one is active. Then request a place on an election whose roll is still open. A registrar or clerk of that election’s jurisdiction must approve before the identity commitment is on the roll. The public tree holds that commitment hex, not your name and not a document number.",
      "Civil officers can inspect each smart card and license and revoke one whose registration has expired. Automated DMV checks are Future; review is manual today. After you have a method, Sign in on later visits — each path still uses email MFA. Register separately for each election you are eligible for; being on one roll does not silently enroll you in every contest on the Node.",
    ],
  },
  {
    id: "how-admins-work",
    topic: "admins",
    q: `How do election officials work in ${brandName()}?`,
    a: [
      "Voting admin is role-gated. Election clerk: create elections, author the ballot, freeze the roll, and (with the registrar) approve voter registration requests; publish pages tagged to that jurisdiction. Registrar: approve those requests, insert identity commitments (never names), and revoke expired smart cards or driver’s licenses. Disqualification officer: apply or revoke public reason codes. Tally operator: post counts after cutoff. Platform admin: host the Node, create jurisdictions, grant those offices per jurisdiction, publish About / FAQ / home, set the site title, pin shared contracts, and design the official outcome PDF letterhead (QR and hash seals stay required).",
      "Clerk / registrar / disqualification officer / tally operator are granted per jurisdiction. platform_admin is a global override, not a token admin. If you are not signed in as an officer, the admin hub sends you to sign-in. The Node still enforces roles on each API action even if a form is visible.",
    ],
  },
  {
    id: "fees-gas",
    topic: "fees-gas",
    q: "Do voters pay fees or gas?",
    a: [
      "No. Voters do not pay gas. You authorize a UserOp (for example with a passkey). The Node relays it; the jurisdiction paymaster sponsors L2 gas. The bundler is the visible sender, not your local address. Gas sponsorship is not a product fee.",
      "Hosts and jurisdictions may pay real infrastructure cost. There is no paid tier in this software and no skimming of ETH beyond that sponsorship.",
    ],
  },
  {
    id: "open-source",
    topic: "open-source",
    q: `Is ${brandName()} open source?`,
    a: [
      "Yes. The license is GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later). If you run a modified Node as a network service, AGPL requires you to offer the corresponding source to users of that service.",
      `The monorepo holds the Node app, Solidity, circuits, ${brandName()} L2 sequencer, and operator docs together so a jurisdiction is not trapped in a vendor black box.`,
    ],
  },
  {
    id: "security-limits",
    topic: "security-limits",
    q: "What are the security limits on this branch? Is MockVerifier still used?",
    a: [
      "Yes — be precise. Local Foundry unit tests still use MockVerifier. Poseidon(2) is the vote hasher, the proof helpers, PoseidonHasher, and the passkey commitment on this screen. A committed Groth16 check verifies an untrusted local Vote(4) proof and an untrusted Vote(20) dev proof. Those keys are not a ceremony.",
      "Passkey demo addresses may be zk-voting-local-address, not production secp256k1. Tally that opens ballots uses a Feldman t-of-n guardian key (NON-PRODUCTION). Homomorphic aggregation versus a mixnet is not decided. Do not treat MockVerifier, a local circuits:setup zkey, or this guardian ceremony as production cryptography. This is not court-ready.",
    ],
  },
  {
    id: "identity-commitment",
    topic: "identity",
    q: "What is stored on the roll if not my name?",
    a: [
      "An identity commitment. WebAuthn PRF derives identity secrets; the Merkle leaf is Poseidon(trapdoor, nullifierSecret), never the active Ethereum address. Trapdoors and seed phrases must never appear in the UI or in receipts.",
      "Several ETH addresses may be verified internally on your person record; only one is active. Switching the active address does not change the leaf.",
    ],
  },
  {
    id: "explorer",
    topic: "explorer",
    q: "What is the block explorer for?",
    a: [
      "The public explorer at /explorer reads the civic L2 record: registrations (commitments only), accepted ballots (nullifier + ballot hash, never the choice), disqualifications, tallies, and rollup batches. Vote proofs appear only after the hour that contained them closes.",
      `${brandName()} L2 as implemented is an application-specific civic sequencer (JSON transactions), chainId 27427. It is not a general-purpose EVM and it does not proxy to Anvil.`,
    ],
  },
  {
    id: "receipts",
    topic: "receipts",
    q: "Will my receipt show which option I marked?",
    a: [
      `No. A ${brandName()} receipt is hashes only. It records that a ballot was accepted, not which option you selected. If a screen, email, or PDF prints “I voted for X,” that is a bug.`,
      "After you vote you may email the receipt to yourself. The email body and the attached PDF are the same evidence: election title, ballot hash, nullifier, and a copy-paste proof. The PDF is encrypted and locked against modification (print and copy are allowed; editing is not). They do not include marked options or a ciphertext opening. A changed file will not match the SHA-256 the Node recorded.",
      "Keep the receipt if you need to show that you participated. Paste it at /receipt, or drop the PDF, to confirm it counted and that the file is unmodified. That portal also shows how many ballots have been disclosed and when each hour closed. It cannot satisfy a coercer who demands proof of choice — that is intentional.",
    ],
  },
  {
    id: "receipt-check",
    topic: "receipt-check",
    q: "How do I prove my vote counted without showing who I voted for?",
    a: [
      "Open /receipt and paste the proof from the ballot screen or the emailed PDF, or drop that PDF file. The Node answers whether that ballot was accepted, whether the hour that contained it has been disclosed, and whether the PDF bytes still match the locked file it issued. You will not be shown a candidate or an option.",
      "Salient public metrics on that page are when hours closed and how many ballots were disclosed — not live pending turnout, and not a count by candidate. A holder token on the receipt can confirm a count before the hour closes; public hash lookup waits for disclosure so walking out of a polling place cannot be matched to a live tick.",
    ],
  },
  {
    id: "jurisdictions",
    topic: "jurisdictions",
    q: `What is a jurisdiction in ${brandName()}?`,
    a: [
      "The administrative owner of a roll and its elections: a nation, state, county, city, union, cooperative, or other body. It defines officers, the reason catalog, and which contests it runs. Nested precincts are a Node/registry concern.",
      "Platform admin creates jurisdictions and grants clerks and other officers onto them. A clerk in one jurisdiction cannot freeze another jurisdiction’s roll.",
    ],
  },
  {
    id: "short-links",
    topic: "short-links",
    q: "Why do elections have UUIDs and short links?",
    a: [
      "New elections mint a UUID v5 public id bound to the shared ElectionFactory, the factory uint256, and the jurisdiction (plus a short code such as /v/nbrdge2k3m). A second body that copies that UUID does not share the L1 proof: L1TallyMirror keys by factory + on-chain id + jurisdiction, not by the UUID. Results and info pages accept UUID, short code, or on-chain id.",
      "Bookmark the UUID or the short link. Both should keep working as deep links even when the marketing home and the registered desk are different pages. Outcome verification recomputes the scoped UUID; a copied id fails.",
    ],
  },
  {
    id: "tally-schemes",
    topic: "tally",
    q: "How are ballots opened and counted?",
    a: [
      "Legacy sum_only still allows any partition of acceptedBallots (the operator cannot add or drop ballots, but they can rearrange which option received them). opens_ballots encrypts choices to a Feldman t-of-n public key. t guardians each publish a proved partial decryption; t-1 cannot open the envelopes. Invented counts[] that only match the sum are rejected. The ceremony is NON-PRODUCTION. Homomorphic aggregation and a mixnet are not selected.",
      "Production remains homomorphic / mixnet decryption proofs plus a real Groth16 verifier. Do not run a binding election on the demo key. A corrupt tally operator can still stall (never submit a tally).",
    ],
  },
  {
    id: "smart-card",
    topic: "smart-card",
    q: "Can I use a smart-card digital ID?",
    a: [
      "Yes. Kiosk or clerk desk. This Node hashes a certificate fingerprint (or PEM). Live X.509 path verification is not in this build — production registrars attest the card. It does not become the Merkle leaf. Sign-in still completes with an email one-time code.",
    ],
  },
  {
    id: "demo-maturity",
    topic: "maturity",
    q: "Is this ready for a binding public election?",
    a: [
      "No. test/unstable is the development line. master is reserved for production when a jurisdiction pins addresses. Circuits, Node, L2, and contracts are in-tree, but Poseidon, a trusted setup ceremony, production passkey secp256k1, a chosen homomorphic or mixnet tally, and MACI-style coercion resistance are not done. Feldman t-of-n guardians are in this tree and are still NON-PRODUCTION.",
      "Treat this Node as a working demo you can inspect, run locally, and improve. Do not tell a court, a clerk, or a voter that the current MockVerifier path is a finished, court-ready proving system.",
    ],
  },
  {
    id: "sign-in-vs-register",
    topic: "sign-in",
    q: "What is the difference between Sign in and Register?",
    a: [
      "Register (Identify yourself) creates or reviews email, wallet, smart-card, license/passport, and passkey methods and submits a commitment to a chosen election roll. Sign in is for returning people who already have a method on this Node.",
      "If you are not signed in, the public home, About, and FAQ are the unregistered surface. After a session, you land on My desk (/me) instead of the marketing home.",
    ],
  },
  {
    id: "observers",
    topic: "observers",
    q: "I am a candidate or observer. What can I see without registering?",
    a: [
      "About, FAQ, the public elections calendar, candidate/measure info pages, results, and the explorer. You can watch how many people are registered, which reason codes were used for disqualification, hourly published ballot counts after each hour closes, and the posted tally.",
      "You cannot see anyone’s choice. You should not expect a live tick while polls are open.",
    ],
  },
  {
    id: "agpl-hosting",
    topic: "agpl",
    q: "If my county hosts a modified Node, what does AGPL require?",
    a: [
      `AGPL-3.0-or-later requires that users of a modified network service receive the corresponding source. Hosting ${brandName()} as a public desk is exactly that kind of service. Keep the NOT FOR PROFIT label. Do not add a paid tier.`,
    ],
  },
  {
    id: "appeal-dq",
    topic: "appeals",
    q: "What if I think a disqualification is wrong?",
    a: [
      "Appeals are a Node + clerk workflow that ends in revoke or replace on the disqualification record. There are no silent deletes; revocation is an event. You should be able to see that you are disqualified and the reason code, once the jurisdiction’s notice rules allow it.",
      "Evidence files stay off-chain. A court can still match a sealed file to the on-chain evidence hash.",
    ],
  },
  {
    id: "email-mfa",
    topic: "email-mfa",
    q: "Why does every sign-in ask for an email code?",
    a: [
      `Email is the username and the second factor. After email, Ethereum signature, smart-card reader, or license/passport, ${brandName()} sends a 6-digit code through AWS SES. Dev login on a local host can skip that; a production desk should not.`,
      "The Node does not invent a password product. The code expires in ten minutes. If SES is not configured, product MFA stays off except for the email-first path, which always uses a captured or sent OTP.",
    ],
  },
  {
    id: "vote-pin",
    topic: "vote-pin",
    q: "Why do I enter a PIN on a scrambled keypad when I vote?",
    a: [
      "Every person sets a 4–8 digit vote PIN while they set up their profile — the same idea as a password, not a sign-in password product. You can change it anytime. If you forget it, email MFA sends a one-time code and you set a new PIN on the phone keypad (forgot PIN is the same flow as forgot password).",
      "The pad is a standard 3×3 with zero at the bottom. When you finalize a ballot the numbers on those keys are shuffled for you, and the keyboard cannot type the PIN, so a watcher cannot copy a tap or keystroke pattern. The Node stores a hash, never the digits. A signed-in vote is rejected until that PIN is confirmed.",
    ],
  },
  {
    id: "civic-id",
    topic: "civic-id",
    q: "Can I sign in with a driver’s license or passport?",
    a: [
      "Yes, as the socially certified photo ID this desk expects. You (or a registrar) bind the document once. Later visits re-enter the type, issuing jurisdiction, and number. The Node stores only a keccak hash — never the image, never the full number. Then you still complete email MFA.",
      "This is not commercial identity verification, not NFC ePassport chip reading, and not a claim that a court must accept the binding. Clerks attest in production; the mock path is for demos when ALLOW_CIVIC_ID_MOCK=1.",
    ],
  },
  {
    id: "terms-hash",
    topic: "terms",
    q: "What is SHA-256 tracking on /terms?",
    a: [
      "The public Terms of Use live at /terms. The canonical source is markdown in the Node package. The Node generates a deterministic PDF from that source and emails that PDF when you accept (AWS SES, same From address as MFA). The fingerprint stored on your person is SHA-256 of the exact PDF bytes — 64 hex characters. Markdown SHA-256 is published next to it so you can see both.",
      "Accepting at register, or the accept control while signed in, writes who, when, which version, both hashes, and whether the PDF was emailed (termsAcceptances in zk-voting.json). Viewing /terms while signed in records a view of the current hash for that session. Changing the markdown changes both hashes.",
    ],
  },
];

export const FAQ_REQUIRED_TOPICS = [
  "zk-voting",
  "privacy-transparency",
  "who-runs",
  "passkey-wallet",
  "one-vote",
  "disqualification",
  "hourly-disclosure",
  "ranked-choice",
  "results",
  "outcomes",
  "outcome-reports",
  "receipts",
  "receipt-check",
  "not-for-profit",
  "will-not",
  "how-to-register",
  "admins",
  "fees-gas",
  "open-source",
  "security-limits",
  "email-mfa",
  "vote-pin",
  "civic-id",
  "terms",
];

export function faqAnswerText(entry) {
  const parts = Array.isArray(entry.a) ? entry.a : [entry.a];
  return parts.filter(Boolean).join("\n");
}

export function faqCorpus() {
  return FAQ_ENTRIES.map((entry) => `${entry.q}\n${faqAnswerText(entry)}`).join("\n\n");
}

/**
 * NOT FOR PROFIT — Republic is a civic public good. Not a commercial product.
 * Public FAQ copy. Keep answers honest to README on test/unstable (demo crypto).
 */

export const FAQ_ENTRIES = [
  {
    id: "what-is-zk",
    topic: "zk-voting",
    q: "What is zero-knowledge voting here?",
    a: [
      "Republic uses zero-knowledge proofs so the chain can check facts about a voter without putting the ballot in the clear. A valid vote proof is supposed to show: you are in the eligible set for that election, you are not on the disqualification set, and this ciphertext is a well-formed ballot. A nullifier marks that you already voted, without naming you.",
      "ZK does not mean nobody is in charge. A jurisdiction still maintains the legal roll. ZK means that once that roll and the disqualification list are committed, counting and eligibility checks are not meant to be a second, invisible trust sink.",
      "On this development line the product intent is that model. Implementation is incomplete: unit tests still default to a MockVerifier, Poseidon is not wired, and a production Groth16 ceremony has not been run. Do not treat a local demo accept as circuit-enforced exclusion.",
    ],
  },
  {
    id: "privacy-vs-transparency",
    topic: "privacy-transparency",
    q: "How can a ballot stay private if the election is publicly verifiable?",
    a: [
      "Privacy is for the choice. Transparency is for the process. Registration events, disqualification actions (reason codes, not personal evidence), poll parameters, and the published tally are meant to be checkable. The option you marked is not an on-chain plaintext field.",
      "Receipts list hashes only (ballot hash, nullifier, related transaction identifiers). They cannot prove “I voted for X.” Dashboards delay vote proofs by one closed hour so walking out of a polling place cannot be matched to a live tick.",
    ],
  },
  {
    id: "who-can-run",
    topic: "who-runs",
    q: "Who can run Republic?",
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
      "A person is unique. You may verify a passkey, a Web3 wallet, and a smart-card digital ID. Several Ethereum addresses can be verified internally; only one is active. The vote Merkle leaf is an identity commitment, never the active wallet address and never a seed phrase.",
      "Passkeys (WebAuthn, discoverable) are the default desk path. A production design derives a secp256k1 smart-account key from WebAuthn PRF and, under a separate domain, identity secrets. This Node demo may display a keccak256 commitment hex and a local address labeled republic-local-address — that is not production secp256k1. Prefer the passkey on the device you will vote from. Use a bound Ethereum wallet if you already have one on this person record.",
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
      "A disqualified person is not supposed to produce an accepting vote proof. On the Node path today, the relay rejects currently disqualified (and unregistered) commitments when chain RPC is unset. The remaining ZK gap: the vote circuit still only binds the disqualification root; it does not yet prove non-membership, and MockVerifier still accepts any proof.",
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
    q: "Does Republic support ranked choice?",
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
    ],
  },
  {
    id: "not-for-profit",
    topic: "not-for-profit",
    q: "Is this a company or a token?",
    a: [
      "No. Republic / zk-voting is not for profit: civic public good, not a commercial product. There is no token, no paid tier, and no vendor lock-in. Nobody is to make money off this repository. Jurisdictions may run it at cost (hosts, paymaster gas, paper notice). Voter data is not a product.",
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
      "Open Register (or Identify yourself). Create a passkey on this device, or bind a Web3 wallet / smart-card method the jurisdiction accepts. Submit an identity commitment to an election whose roll is still open. The public tree holds that commitment hex, not your name.",
      "A clerk or registrar may still need to match you to the civil roll. After you have a passkey, Sign in on later visits. Register separately for each election you are eligible for; being on one roll does not silently enroll you in every contest on the Node.",
    ],
  },
  {
    id: "how-admins-work",
    topic: "admins",
    q: "How do election officials work in Republic?",
    a: [
      "Voting admin is role-gated. Election clerk: create elections, author the ballot, freeze the roll. Registrar: insert identity commitments (never names). Disqualification officer: apply or revoke public reason codes. Tally operator: post counts after cutoff. Platform admin: host the Node, create jurisdictions, grant those offices per jurisdiction.",
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
    q: "Is Republic open source?",
    a: [
      "Yes. The license is GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later). If you run a modified Node as a network service, AGPL requires you to offer the corresponding source to users of that service.",
      "The monorepo holds the Node app, Solidity, circuits, Republic L2 sequencer, and operator docs together so a jurisdiction is not trapped in a vendor black box.",
    ],
  },
  {
    id: "security-limits",
    topic: "security-limits",
    q: "What are the security limits on this branch? Is MockVerifier still used?",
    a: [
      "Yes — be precise. Local Foundry unit tests still use MockVerifier until Poseidon and a real Groth16 ceremony exist. The first proving path is in progress (compile / untrusted local powers-of-tau setup / export / prove scripts). That is not a production ceremony. Poseidon is not wired; the circuit hasher is gated as a stand-in (standin-v0 / keccak-dev-v1).",
      "Passkey demo addresses may be republic-local-address, not production secp256k1. Tally that opens ballots uses a threshold-1 operator key (NON-PRODUCTION), not guardian threshold > 1 or a mixnet. Do not treat MockVerifier, a local circuits:setup zkey, or the demo tally key as production cryptography. This is not court-ready.",
    ],
  },
  {
    id: "identity-commitment",
    topic: "identity",
    q: "What is stored on the roll if not my name?",
    a: [
      "An identity commitment. In the intended production construction, WebAuthn PRF derives identity secrets; the Merkle leaf is that commitment, never the active Ethereum address. This demo Node may show a keccak256 commitment hex. Trapdoors and seed phrases must never appear in the UI or in receipts.",
      "Several ETH addresses may be verified internally on your person record; only one is active. Switching the active address does not change the leaf.",
    ],
  },
  {
    id: "explorer",
    topic: "explorer",
    q: "What is the block explorer for?",
    a: [
      "The public explorer at /explorer reads the civic L2 record: registrations (commitments only), accepted ballots (nullifier + ballot hash, never the choice), disqualifications, tallies, and rollup batches. Vote proofs appear only after the hour that contained them closes.",
      "Republic L2 as implemented is an application-specific civic sequencer (JSON transactions), chainId 27427. It is not a general-purpose EVM and it does not proxy to Anvil.",
    ],
  },
  {
    id: "receipts",
    topic: "receipts",
    q: "Will my receipt show which option I marked?",
    a: [
      "No. A Republic receipt is hashes only. It records that a ballot was accepted, not which option you selected. If a screen prints “I voted for X,” that is a bug.",
      "Keep the receipt if you need to show that you participated. It cannot satisfy a coercer who demands proof of choice — that is intentional.",
    ],
  },
  {
    id: "jurisdictions",
    topic: "jurisdictions",
    q: "What is a jurisdiction in Republic?",
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
      "New elections mint a UUID v4 public id used in /vote/:id, plus a short code such as /v/nbrdge2k3m (and /e/… as an alias). The factory uint256 stays as onChainElectionId for the circuit. Results and info pages accept the same identifiers.",
      "Bookmark the UUID or the short link. Both should keep working as deep links even when the marketing home and the registered desk are different pages.",
    ],
  },
  {
    id: "tally-schemes",
    topic: "tally",
    q: "How are ballots opened and counted?",
    a: [
      "Legacy sum_only still allows any partition of acceptedBallots (the operator cannot add or drop ballots, but they can rearrange which option received them). opens_ballots encrypts choices to a P-256 tally pubkey; the Node decrypts accepted envelopes and rejects invented counts[] that only match the sum. That demo key is threshold-1, held by the operator host, and labeled NON-PRODUCTION.",
      "Production remains homomorphic / mixnet decryption proofs plus a real Groth16 verifier. Do not run a binding election on the demo key. A corrupt tally operator can still stall (never submit a tally).",
    ],
  },
  {
    id: "smart-card",
    topic: "smart-card",
    q: "Can I use a smart-card digital ID?",
    a: [
      "Yes, as one of the three person methods (passkey, Web3, smart card). Officials can attest a smart-card fingerprint on the person record. It does not become the Merkle leaf. The same uniqueness rules apply: one person, one active ETH address.",
    ],
  },
  {
    id: "demo-maturity",
    topic: "maturity",
    q: "Is this ready for a binding public election?",
    a: [
      "No. test/unstable is the development line. master is reserved for production when a jurisdiction pins addresses. Circuits, Node, L2, and contracts are in-tree, but Poseidon, a trusted setup ceremony, production passkey secp256k1, guardian tally threshold > 1, and MACI-style coercion resistance are not done.",
      "Treat this Node as a working demo you can inspect, run locally, and improve. Do not tell a court, a clerk, or a voter that the current MockVerifier path is a finished, court-ready proving system.",
    ],
  },
  {
    id: "sign-in-vs-register",
    topic: "sign-in",
    q: "What is the difference between Sign in and Register?",
    a: [
      "Register (Identify yourself) creates or reviews the passkey / wallet / smart-card methods and submits a commitment to a chosen election roll. Sign in is for returning people who already have a passkey on this device or a bound Ethereum wallet.",
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
      "AGPL-3.0-or-later requires that users of a modified network service receive the corresponding source. Hosting Republic as a public desk is exactly that kind of service. Keep the NOT FOR PROFIT label. Do not add a paid tier.",
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
  "not-for-profit",
  "will-not",
  "how-to-register",
  "admins",
  "fees-gas",
  "open-source",
  "security-limits",
];

export function faqAnswerText(entry) {
  const parts = Array.isArray(entry.a) ? entry.a : [entry.a];
  return parts.filter(Boolean).join("\n");
}

export function faqCorpus() {
  return FAQ_ENTRIES.map((entry) => `${entry.q}\n${faqAnswerText(entry)}`).join("\n\n");
}

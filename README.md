# zk-voting

A monorepo for a **zero-knowledge, Ethereum-settled voting system**.

This repository will hold two tightly coupled pieces of software:

1. A **Node application** (same operational shape as [DealPunchList](https://dealpunchlist.com) / `dealpunchlist-node`): the product surface for voters, election officials, and public observers.
2. A **`smart-contracts/`** package: Solidity for Ethereum that registers voters, opens ballots, records (or commits to) votes with zero-knowledge proofs, and **enforces disqualification** so that a person who is on the roll can still be barred from a given election for jurisdiction-defined reasons.

The same contracts are meant to run **on Ethereum mainnet (L1)** and on a **Layer 2 in the Lighter family** ([lighter.xyz](https://lighter.xyz)): a ZK rollup that settles proofs and state to Ethereum. Cheap, high-volume voter activity belongs on L2. Canonical law, final tallies, and dispute-grade records can live on L1, or be mirrored there.

**Status:** this repository is documentation-first. The README is the current source of truth. Application and contract code have not been added yet. Work happens on `test/unstable`. `master` is production only.

---

## Table of contents

- [Purpose](#purpose)
- [Who it is for](#who-it-is-for)
- [What “zero-knowledge voting” means here](#what-zero-knowledge-voting-means-here)
- [Current status](#current-status)
- [Monorepo layout](#monorepo-layout)
- [Node application](#node-application)
- [Smart contracts](#smart-contracts)
- [Chains: Ethereum L1 and Lighter L2](#chains-ethereum-l1-and-lighter-l2)
- [Registration](#registration)
- [Eligibility, disqualification, and due process](#eligibility-disqualification-and-due-process)
- [Ballots and “voting on aspects”](#ballots-and-voting-on-aspects)
- [Election types and jurisdictions](#election-types-and-jurisdictions)
- [Roles](#roles-and-permissions)
- [End-to-end flows](#end-to-end-flows)
- [Privacy, coercion resistance, and public verifiability](#privacy-coercion-resistance-and-public-verifiability)
- [Security and threat model](#security-and-threat-model)
- [What this system will not do](#what-this-system-will-not-do)
- [Development](#development)
- [Roadmap](#roadmap)
- [Glossary](#glossary)
- [Related work](#related-work)
- [Legal note](#legal-and-policy-note)

---

## Purpose

Democratic processes still depend on a small set of trusted operators: who is on the roll, who was turned away, whether a ballot was counted, and whether the published result matches the ballots. Paper and proprietary machines can work. They do not, by themselves, let a voter, a losing candidate, or a court **verify** those claims without re-trusting the same operators.

This project exists to make those claims **checkable**:

- A person can **register to vote** for a jurisdiction (a city, a district, a nation, a private body that still wants an election-grade process).
- That person can **cast a ballot** on one or more questions (“aspects”) in an election.
- The public can verify that **only eligible people voted, at most once**, and that the **tally is the sum of those ballots**.
- Election officials can still **disqualify** a registered person when the law or the body’s rules require it (death, non-residency, duplicate identity, court order, already voted, and other coded reasons). Disqualification is an on-chain, auditable state change — not an invisible database flag.
- A voter’s **choice** is not published. Eligibility and “this person already voted / is barred” are.

The Node app is how humans do that work. The contracts are how Ethereum (L1 and L2) enforces it.

---

## Who it is for

| Audience | What they do here |
| --- | --- |
| **Voters** | Register, see whether they are eligible or disqualified, cast a ballot, keep a receipt that does not reveal their choice. |
| **Election officials / clerks** | Stand up an election, define the roll and the questions, apply and reverse disqualifications, publish results. |
| **Jurisdictions** | A government, a county, a nation, a union, a board — any body that needs a roll, a ballot, and a binding result. |
| **Candidates and observers** | Watch the public state: how many registered, how many disqualified (and on what coded grounds), how many ballots, the proven tally. |
| **Auditors and courts** | Reconstruct the election from chain data, proofs, and the Node’s published artifacts without trusting a vendor’s black box. |

The product is **not** limited to national general elections. The same machinery should cover a municipal referendum, a legislative internal vote, or a professional body’s election, as long as someone is willing to run the jurisdiction and accept the legal consequences.

---

## What “zero-knowledge voting” means here

Zero-knowledge is used so that the chain can check **facts about a voter** without putting the **ballot** (and, where the jurisdiction requires it, the voter’s civil identity) in the clear.

The properties we are aiming for:

1. **Eligibility.** A vote proof is only valid if the prover is in the current eligible set for that election.
2. **Disqualification.** Being registered is not enough. If the person is on the disqualification set for that election (or that question), the same circuits must reject the vote.
3. **One ballot per eligible person** (or one ballot per question, depending on the election rules), via nullifiers so a second vote is detectable without naming the voter.
4. **Hidden choice.** The option selected is not an on-chain plaintext field anyone can read from the transaction.
5. **Public tally.** After the poll closes, anyone can check a proof that the published totals match the accepted ballots.
6. **Public process.** Registration events, disqualification actions, poll parameters, and final tallies are attributable to known roles (jurisdiction, clerk, registrar).

Zero-knowledge does **not** mean “nobody is in charge.” Someone still maintains the legal roll. ZK means that once that roll and the disqualification list are committed, **counting and eligibility checks are not a second trust sink**.

---

## Current status

| Area | State |
| --- | --- |
| This README | Source of truth for intent and architecture |
| Node application | Not started (will follow the `dealpunchlist-node` style: Node API + web frontend, hosted with `system_actions.sh`) |
| `smart-contracts/` | Not started (Solidity, Ethereum L1 + Lighter L2) |
| Circuits / proving keys | Not started |
| Production deployment | None. `master` is reserved for it. |

If this file and the code disagree later, treat that as a bug in the code or an overdue README update.

---

## Monorepo layout

Planned layout. Only the files that already exist are real today.

```text
zk-voting/
  README.md                 ← you are here
  system_actions.sh        ← host/operator menu (DealPunchList pattern)
  apps/
    node/                  ← DealPunchList-style Node app (API + frontend)
  packages/                ← shared TS types, proof helpers, chain clients
  smart-contracts/         ← Solidity, tests, deploy scripts (L1 and L2)
    src/
    test/
    script/
  circuits/                ← ZK circuits (added when proving work starts)
```

Names can move slightly when the first packages land. The invariants will not:

- **One repo** for the voting product, the Node host, and the contracts.
- **`smart-contracts/`** is the Solidity home. It is not buried inside the Node app.
- The Node app talks to those contracts. It does not become a second, private source of election truth.

---

## Node application

The Node side is the human product. It should feel operationally familiar to anyone who has run `dealpunchlist-node`: a long-lived Node process, a web frontend, authenticated users, organizations (here: **jurisdictions**), admin tools, notifications, and a host script (`system_actions.sh`) that can pull a branch, build, and restart.

### What it is responsible for

- **Voter UI:** registration intake, identity/document collection as required by the jurisdiction, status (“registered”, “eligible”, “disqualified”, “ballot accepted”), ballot UI, confirmation.
- **Official UI:** create a jurisdiction and an election, define questions and options, manage the roll, record disqualifications with a reason code and evidence reference, freeze the roll, open/close voting, publish the tally.
- **Public UI:** election calendar, certified parameters (chain, contract addresses, merkle roots, proving-key hashes), live counts that are safe to show, final results and verifier artifacts.
- **API:** the same jobs as HTTP, so a jurisdiction’s own systems or a kiosk can be wired in without scraping the frontend.
- **Proof client:** help the browser or a local helper build the witness for registration, vote, and (when needed) eligibility refresh. The Node may **orchestrate** proving; it must not be the only place a proof can be produced.
- **Relaying (optional):** submit a voter’s already-signed/proofed transaction to L2 so the voter does not need gas, without learning their choice.

### What it is not responsible for

- Being the canonical roll. The canonical eligible-set and disqualification-set commitments live in the contracts.
- Silently “fixing” a tally. If the chain says the proof is invalid, the UI reports failure.
- Inventing disqualification law. The app presents **coded reasons** the jurisdiction configured; clerks apply them.

### Shape (DealPunchList parallel)

| DealPunchList-node | zk-voting Node |
| --- | --- |
| Organizations / companies | Jurisdictions (nation, state, county, city, other body) |
| Users with roles | Voters, clerks, registrars, observers, admins |
| A “room” with a process | An election with a roll, a ballot, and a result |
| Requirements that get satisfied | Registration steps, eligibility checks, disqualification holds |
| Notifications | “You are registered”, “you are disqualified from X”, “polls are open”, “tally posted” |
| Hosting via `system_actions.sh` | Same: `test/unstable` for development, `master` for production |

---

## Smart contracts

Solidity on Ethereum. This is the enforcement layer.

The first contract set is expected to cover:

| Contract (working name) | Role |
| --- | --- |
| `JurisdictionRegistry` | Who may create elections, which chain roles exist, which reason codes are valid. |
| `VoterRegistry` | Commitments to registered persons (identity commitments / public keys), per jurisdiction. Registration is not a vote. |
| `DisqualificationRegistry` | Registered persons who **must not** be able to vote in a given election (or on a given question), with reason codes, effective times, and issuer. |
| `Election` / `Poll` | Parameters: questions (“aspects”), options, open/close, eligible-set root, disqualification-set root, voting rules. |
| `BallotInbox` | Accepts vote messages + ZK proofs. Rejects proofs that fail eligibility, disqualification, uniqueness, or time window. |
| `TallyVerifier` | Verifies the coordinator/prover’s batch proofs that the published totals match the inbox. |
| `BridgeOrMirror` (as needed) | If L2 is where votes land, L1 holds the result (or a commitment to it) that courts and the Node treat as final. |

Exact names will follow the first Solidity drop. The **behaviors** are the spec:

### Registration on chain

- A jurisdiction (or its registrar role) admits a voter by publishing an **identity commitment**, not necessarily the person’s legal name, on chain.
- The Node may keep the legal file (name, address, document numbers) off-chain, encrypted, because many jurisdictions cannot put that on a public chain.
- The on-chain object is enough to prove later: “this commitment was on the roll at time T.”

### Voting on chain

- A vote is a **proof + ciphertext / commitment**, not a public `vote(optionId)`.
- The verifier checks: registered, **not disqualified**, in the voting window, unique nullifier, well-formed ballot for that election’s questions.
- Multiple questions in one election (“aspects”) can be one ballot or one proof per question; the election parameters say which.

### Disqualification on chain

This is a first-class feature, not an admin footnote.

- A registered voter can be marked **ineligible to cast** (or to have a ballot counted) for a specific election, a specific question, or (if the jurisdiction allows) all current elections in that jurisdiction.
- The mark carries a **reason code** from a published catalog (see [Eligibility, disqualification, and due process](#eligibility-disqualification-and-due-process)).
- Vote circuits take the **disqualification tree / set** as a public input. A valid vote proves **non-membership** (or an equivalent “still eligible” delta) for that person.
- Removing a disqualification (appeal granted, error, restored rights) is the same kind of auditable event, with its own actor and timestamp.
- Once a poll is frozen for tally, new disqualifications must not rewrite history. Late legal changes are a **new** election or a jurisdiction-level process off this protocol, unless the election was parameterized to allow a documented freeze/unfreeze.

Contracts must be **boring Solidity**: explicit access control, no upgrade surprise unless a jurisdiction opted into a proxy, events for every state change the Node or an auditor will need.

---

## Chains: Ethereum L1 and Lighter L2

### Why two layers

| Layer | Job |
| --- | --- |
| **Lighter L2** ([lighter.xyz](https://lighter.xyz)) | High-volume voter actions: registration commitments, vote messages, frequent eligibility-set updates. Lighter is a **ZK rollup on Ethereum**: execution is proven, and Ethereum verifies those proofs. That matches this project’s bias — do not ask the public to trust an operator’s matching/counting engine. |
| **Ethereum mainnet (L1)** | Canonical settlement. Deploy the same Solidity when the election must live where any Ethereum full node can verify it without an L2 client: national-scale certification, dispute windows, or “this result is an L1 transaction.” |

Lighter’s original core is an application-specific ZK rollup (verifiable exchange operations, proofs verified on Ethereum). Lighter has also moved toward a **general-purpose EVM** surface so ordinary Solidity can be deployed beside that core. This repo’s contracts will be written as **portable EVM bytecode**:

- Deploy to **Ethereum mainnet** when L1 is the required venue.
- Deploy to **Lighter** (Lighter EVM / the L2’s contract environment) when the election wants L2 fees and throughput, with L1 used to verify the rollup (and, if we add it, to mirror the certified tally).
- If a given Lighter environment is not yet suitable for these contracts, the same artifacts should still deploy to Ethereum L1 and to any other EVM L2. The product requirement is “L2 like Lighter, plus L1,” not a hard dependency on a single sequencer remaining available.

### Deployment policy

- **Development / staging elections** → L2 (and L1 test networks).
- **Production elections** → explicit choice per jurisdiction: L2-only, L1-only, or L2 execution + L1 result mirror.
- `system_actions.sh` and later deploy scripts must never “accidentally” point a production jurisdiction at `test/unstable` configuration. `master` is the production line.

### What “on chain” means for an election

An election is “on chain” when:

1. Contract addresses and compiler metadata are published.
2. The roll commitment and disqualification-set commitment are on the chosen chain.
3. Ballots that count are accepted only by those contracts.
4. The tally (or a binding hash of it) is verified on that chain, and if L2, optionally copied to L1.

The Node is allowed to be down. The chain records must still be enough for an independent verifier.

---

## Registration

Registration is a **legal and operational** process that **ends** in an on-chain commitment.

### Off-chain (Node)

Typical intake (jurisdiction-configurable, not all required for every election):

- Legal name, date of birth, address / residency evidence
- Citizenship or membership evidence
- Government ID or an approved identity attestation
- District / precinct / constituency
- Contact channel for notices (disqualification, poll dates)
- Attestation that the person is who they claim and understands the rules

The Node stores what the jurisdiction is legally required to keep. That store is **not** the roll the circuits use.

### On-chain

- An **identity commitment** (e.g. a hash of a voter key and jurisdiction salt) is added to the `VoterRegistry` for that jurisdiction.
- Optional: a **district leaf**, so a municipal election can require residency in that district without putting the street address on chain.
- Duplicate prevention: the jurisdiction’s uniqueness rule (national ID hash, one-person attestation, etc.) is checked before the commitment is inserted. The contracts can enforce “this uniqueness nullifier is unused,” which is stronger than a SQL unique index.

### Status the voter should see

- **Not registered**
- **Pending review** (documents in with the clerk)
- **Registered** (on the roll commitment)
- **Eligible for election E** (registered, and not disqualified for E)
- **Disqualified for election E** (registered, but a live disqualification applies)
- **Ballot recorded** (nullifier spent; choice not shown)

---

## Eligibility, disqualification, and due process

**Registered ≠ allowed to vote.** That is a core requirement of this repo.

Election law (and private-body bylaws) routinely keep someone on a master list while denying them a ballot in a particular contest: they moved, they died, they are serving a sentence the jurisdiction treats as disqualifying, they already voted, a court ordered it, the registration was fraudulent, they are not in this district for this contest.

### How it will work

1. **Reason catalog (per jurisdiction).** A published list of codes, for example:

   | Code | Example meaning (illustrative, not legal advice) |
   | --- | --- |
   | `NOT_OF_AGE` | Below the voting age for this election |
   | `NOT_RESIDENT` | Not a resident of the jurisdiction or district |
   | `NOT_CITIZEN_OR_MEMBER` | Fails the body’s membership / citizenship rule |
   | `DUPLICATE_IDENTITY` | Same person already registered under another commitment |
   | `DECEASED` | Death recorded |
   | `MOVED_OUT` | Left the jurisdiction |
   | `DISTRICT_MISMATCH` | Registered, but this ballot is for another district |
   | `ALREADY_VOTED` | Ballot already accepted (also enforced by nullifier) |
   | `COURT_ORDER` | Court or competent authority barred this person |
   | `INELIGIBLE_STATUS` | Jurisdiction-specific legal status (incarceration, guardianship, etc.) |
   | `FRAUD_HOLD` | Registrar hold for suspected fraudulent registration |
   | `EXPIRED_OR_SUSPENDED` | Registration lapsed or suspended |
   | `SANCTION_OR_PROHIBITION` | Explicit legal prohibition |
   | `OTHER` | Requires a public or sealed memo reference |

   Jurisdictions add, rename, or disable codes. The protocol does not hard-code one country’s election code.

2. **On-chain record.** `{ voterCommitment, electionId or * , questionId or *, reasonCode, evidenceHash, issuer, issuedAt, expiresAt?, revokedAt? }`

3. **Eligible set for proving.** Before voting opens (and at defined refresh points), the system builds the set the circuits use:

   `eligible = registered ∩ ¬disqualified(election, question)`

   The vote proof shows membership in that set (or non-membership in the disqualification set plus membership in the registry), so a disqualified person **cannot** produce an accepting proof.

4. **Visibility.**

   - **Public:** that a disqualification exists, which election it applies to, reason **code**, issuer role, timestamps.
   - **Restricted (Node / clerk / court):** identity file, evidence, narrative. Hash of the evidence is on chain so a court can match the file later.
   - The **ballot** is never attached to a disqualification record.

5. **Due process (product rules, enforced as far as the contracts can).**

   - A voter can see that they are disqualified and the **code**, via the Node, once the jurisdiction’s notice rules allow it.
   - Appeals are a Node + clerk workflow that ends in `revoke` or `replace` on the disqualification record.
   - No silent deletes. Revocation is an event.
   - After a poll’s **roll freeze**, disqualifications that would change who could have voted are rejected or queued for the next contest, unless the election was created with an explicit, public “late update” flag (discouraged).

6. **Who may disqualify.** Only roles the jurisdiction bound in `JurisdictionRegistry` (registrar, clerk of court, statutory officer). The Node UI is how they do it; the contract is what makes it real.

### Failure mode we are designing against

A clerk who can quietly drop a person from a private database at 7:59 p.m. That is not allowed to be the only control. If they are dropped, it is a **disqualification (or registry removal) with a reason**, or it did not happen.

---

## Ballots and “voting on aspects”

An election is not only “choose one candidate.” Officials and voters need to vote on **aspects**: questions, measures, offices, ranked choices, yes/no articles.

Each **Election** contains one or more **questions**:

- `SINGLE_CHOICE` — one option
- `MULTI_CHOICE` — up to *k* options
- `YES_NO`
- `RANKED` — if the jurisdiction wants it (later)
- `MEASURE` / `ARTICLE` — labeled text plus options

Rules per question (quorum, supermajority, “eligible to vote on this aspect even if disqualified from another”) are parameters. Disqualification can be **election-wide** or **per question** (example: eligible for a local measure, barred from a national office in the same calendar).

The Node is the authoring tool for this ballot. The contracts store the hash of the full ballot definition so the UI cannot later show a different question than the one that was voted on.

---

## Election types and jurisdictions

| Kind | Example | Typical chain choice |
| --- | --- | --- |
| Local / municipal | City council, school board, local measure | L2 |
| Regional / state / province | Statewide office or referendum | L2, L1 mirror of tally |
| National | General election, national referendum | L1 certified result; L2 may still take the vote messages |
| Non-governmental | Union, cooperative, professional college | L2, optional L1 |

A **jurisdiction** is the administrative owner: it defines the roll, the reason catalog, the officers, and which elections it runs. Nested jurisdictions (nation → district → precinct) are a Node/registry concern: a precinct election must only count commitments tagged for that precinct.

---

## Roles and permissions

| Role | Node | Contracts |
| --- | --- | --- |
| **Voter** | Register, view status, vote | Submit register/vote proofs as allowed |
| **Registrar** | Approve registrations | Insert/remove registry commitments |
| **Disqualification officer** | Apply/revoke reason codes | Write `DisqualificationRegistry` |
| **Election clerk** | Create election, freeze roll, open/close | Configure `Election`, freeze roots |
| **Tally operator** | Run the prover / batch | Submit tally proofs (cannot invent votes) |
| **Observer** | Read-only | Read state and verify |
| **Platform admin** | Host the Node, keys, uptime | Not an election officer unless also granted |

A **corrupt tally operator** must not be able to change outcomes or add votes. They **can** stall (never submit a tally). The README’s threat model calls that out; later work can add a forced-reveal or guardian path. They **cannot** make a disqualified voter’s proof succeed.

---

## End-to-end flows

### A. Register

1. Voter completes the Node intake for jurisdiction J.
2. Clerk verifies documents (or an automated attestation the jurisdiction accepts).
3. Node (or voter wallet) submits a registration transaction: identity commitment to `VoterRegistry`.
4. Voter sees **Registered**.

### B. Disqualify

1. Officer enters a reason code and evidence in the Node.
2. Contract appends a disqualification record and the eligible-set root is updated (immediately or at the next freeze).
3. Voter’s status becomes **Disqualified for election E** (code visible per policy).
4. Any vote proof they generate for E fails verification.

### C. Vote

1. Polls open. Eligible-set root is frozen (or the election allows a documented refresh).
2. Voter builds a ZK proof: I am in the eligible set, I am not in the disqualification set, this nullifier is unused, this ciphertext is a well-formed ballot for these questions.
3. `BallotInbox` accepts the message. Choice is not plaintext.
4. A second vote with the same nullifier fails.

### D. Tally and certify

1. Poll closes. Inbox no longer accepts messages.
2. Operator processes messages and proves the tally.
3. `TallyVerifier` accepts only a correct proof.
4. If the election is L2, a hash of the result can be posted to L1.
5. Node publishes the human-readable result plus verifier artifacts.

---

## Privacy, coercion resistance, and public verifiability

These three fight each other. The design chooses explicitly:

| Goal | Approach |
| --- | --- |
| **Privacy of choice** | Vote is encrypted / committed; proof talks about eligibility, not the option. |
| **Public verifiability** | Anyone can check proofs, set roots, inbox size, and the tally. |
| **Coercion resistance** | Longer-term: last-vote-counts or MACI-style collusion-resistant messaging so a voter can overwrite a coerced ballot. First versions may be weaker (hidden choice, but a coerced voter might still prove they voted a certain way off-chain). The Node must not print a “I voted for X” receipt. |
| **Disqualification transparency** | Reason **codes** are public so a jurisdiction cannot hide mass purges. Personal evidence stays off-chain. |

If a jurisdiction needs a fully public roll (some do), that is a configuration: commitments can be replaced or accompanied by identified records. ZK voting still hides the **ballot**.

---

## Security and threat model

**In scope**

- Forged eligibility (voting while unregistered or disqualified)
- Double voting
- Tally that does not match accepted ballots
- Silent roll changes after freeze
- Node lying about what the chain said
- Replay of a vote message on the wrong election or chain
- Privilege abuse that is not logged on chain

**Partially in scope**

- Coercion and vote buying (cryptographic mitigations over time; process and law still matter)
- L2 sequencer censorship (mitigate with L1 inclusion path / timeout, in the spirit of Lighter’s priority/escape design)

**Out of scope for v1**

- Replacing a nation’s identity system
- Making a dishonest registrar invent a legal person who does not exist (the registry is only as good as the jurisdiction’s identity practice; uniqueness nullifiers reduce duplicates, they do not create a global proof of personhood)
- Stopping a tally operator from **refusing to tally** (liveness), as opposed to tallying **wrong**

**Operational**

- Production secrets and deploy keys are not in git.
- `master` is the only production line.
- Contract addresses for a live election are pinned in the Node’s published election record.

---

## What this system will not do

- Guarantee that a government **must** use it, or that using it satisfies a given elections statute. That is a legal adoption question.
- Put every voter’s home address and ID number on Ethereum by default.
- Let a disqualified person vote “privately anyway.” Privacy is for the **choice**, not for bypassing the roll.
- Hide mass disqualification behind ZK. The **fact** of disqualification is meant to be visible; the **ballot** is not.
- Ship as a single-chain toy that cannot be certified on L1.

---

## Development

### Branches

- **`test/unstable`** — default development and staging. Almost all work happens here.
- **`master`** — production only. Promote when a build is ready to ship.

### Host actions

`system_actions.sh` is the operator menu, adapted from the DealPunchList (`dealpunchlist-node`) pattern:

```bash
./system_actions.sh              # interactive menu
./system_actions.sh status
./system_actions.sh deploy-dev   # pull test/unstable, install, build, restart
./system_actions.sh deploy-prod  # pull master (confirms first)
```

Install / build / restart stay no-ops until a `package.json`, PM2 ecosystem, systemd unit, or Compose file exists.

### What to build next (when we leave README-only)

Not in this change. When code starts, the expected order is:

1. Monorepo skeleton (`apps/node`, `smart-contracts/`) with no election logic.
2. Solidity interfaces and reason-code enums matching this document.
3. Node screens that can display election and voter status against those contracts on a test chain.
4. Circuits for eligibility + non-disqualification + vote.

---

## Roadmap

Documentation-level only. Dates are not committed.

1. **Spec freeze (this README)** — purpose, monorepo, L1 + Lighter L2, registration, disqualification.
2. **Contract interfaces** — registry, disqualification, election, inbox, tally verifier; deploy scripts for Ethereum and Lighter.
3. **Node skeleton** — DealPunchList-style app: jurisdictions, users, roles, election admin, voter home.
4. **First proving path** — eligible vote on a single yes/no question on L2 test deployment.
5. **Disqualification path** — same voter, after a coded disqualification, cannot obtain a valid proof.
6. **Multi-question ballots** — “aspects.”
7. **L1 certification** — tally or tally hash on Ethereum mainnet.
8. **Coercion-resistance upgrades** and independent auditor tooling.

---

## Glossary

| Term | Meaning in this repo |
| --- | --- |
| **Jurisdiction** | The body that owns a roll and elections (government or other). |
| **Roll / registry** | The set of registered identity commitments. |
| **Eligible set** | Registered minus disqualified, for a given election/question. |
| **Disqualification** | An on-chain record that blocks voting despite registration. |
| **Aspect / question** | One decision on a ballot (office, measure, article). |
| **Nullifier** | A unique value revealed at vote time so the same person cannot vote twice, without publishing their name. |
| **Tally proof** | A ZK proof that published totals match accepted ballots. |
| **L1** | Ethereum mainnet (or an Ethereum testnet during development). |
| **L2** | Lighter (and, if needed, other EVM L2s). Execution off L1, security anchored to Ethereum. |

---

## Related work

This project is **not** a fork of any of the following. They are the prior art the design will learn from:

- [MACI](https://maci.pse.dev/) — on-chain polls, signup policies, collusion-resistant messaging, proven tallies.
- [Semaphore](https://semaphore.pse.dev/) — anonymous group membership proofs (a likely building block for “I am still in the eligible set”).
- [Lighter](https://lighter.xyz) — ZK rollup that settles to Ethereum; the L2 this repo intends to treat as the high-throughput venue.
- DealPunchList / `dealpunchlist-node` — the Node/product and hosting pattern this monorepo’s application side will follow.

---

## Legal and policy note

This repository describes software for running elections and for **denying a registered person a ballot** under coded rules. It is not legal advice. Disqualification reasons, notice, appeals, retention of identity files, and whether a blockchain record satisfies a given elections code are **jurisdiction-specific**. Operators must not run a binding public election on this stack without their own counsel and statutory authority.

The authors’ intent is that **eligibility and disqualification are visible as process**, while **individual political choice is not**. If a deployment inverts that (public ballots, secret purges), it is misusing this design.

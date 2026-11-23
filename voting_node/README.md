# ZK-Voting

**NOT FOR PROFIT** — civic public good. Not a commercial product. See [`NOT_FOR_PROFIT.md`](./docs/NOT_FOR_PROFIT.md).

> **Monorepo layout:** this folder (`voting_node/`) holds the app. The Solidity package lives at the
> repository root in [`../smart-contracts/`](../smart-contracts) and the landing page in
> [`../site/`](../site). Commands in this README run from `voting_node/`.

A **zero-knowledge, Ethereum-settled voting and polling system** that anyone can self-host, fork
and rebrand, the way a community runs its own Discourse. Default product name: **ZK-Voting**, until
an administrator renames it.

> **Your fork, your name.** A super admin sets the product name, short name and tagline in
> **Site admin > Appearance > Branding**; that wins over `BRAND_NAME` / `BRAND_SHORT_NAME` /
> `BRAND_TAGLINE`, which win over the built-in "ZK-Voting". The name is rendered into page titles,
> headers, docs, emails, PDFs and the WebAuthn relying-party name. Some identifiers keep the old
> name for compatibility (`zk-voting.json`, the `zk-voting` Compose network).

## Quickstart

You need Docker with Compose v2 (and Node.js 20+ once, for the setup script). Full guide:
[Docker Compose quickstart](./docs/self-hosting/docker-compose.md).

```bash
git clone https://github.com/mrabino1/zk-voting.git
cd zk-voting/voting_node
./setup.sh                    # guided: writes .env, never prints a secret
docker compose up -d --build  # setup.sh prints this exact command for your answers
curl -fsS http://127.0.0.1:3000/health
```

`./setup.sh` (also `npm run setup`) asks for the super admin and setup token, the chain id, the
entropy ceremony and setup entropy, the hostname, port, proxy and database, and the rollup: a
**local chain** in Compose (the default; Anvil with ZkVotingRollup deployed for you, no paid
service) or **an existing deployment**. Run it again any time: your answers are the defaults.
`--deploy coolify` prints the Coolify settings instead. By hand: `cp .env.example .env`.

Then open the site and finish [first-run setup](./docs/self-hosting/first-launch.md) at `/setup`.

Private by default: [`docker-compose.tailscale.yml`](./docker-compose.tailscale.yml) runs the same
stack behind a Tailscale sidecar with HTTPS on your tailnet and no public ports.

## Self-hosting docs

The same guides are served by every node at **`/docs`** and live in
[`docs/self-hosting/`](./docs/self-hosting/README.md).

| Install | Run and upgrade |
| --- | --- |
| [Overview](./docs/self-hosting/README.md) | [Upgrading](./docs/self-hosting/upgrading.md) |
| [Requirements](./docs/self-hosting/requirements.md) | [Backups](./docs/self-hosting/backups.md) |
| [Docker Compose quickstart](./docs/self-hosting/docker-compose.md) | [Rollback](./docs/self-hosting/rollback.md) |
| [Coolify](./docs/self-hosting/coolify.md) | [Rolling updates](./docs/self-hosting/rolling-updates.md) |
| [Dokploy, CapRover, plain Compose](./docs/self-hosting/other-platforms.md) | [Forking and staying current](./docs/self-hosting/forking.md) |
| [Tailscale sidecar](./docs/self-hosting/tailscale.md) | [Health checks](./docs/self-hosting/health-checks.md) |
| [Configuration reference](./docs/self-hosting/configuration.md) | [Groth16 ceremony](./docs/self-hosting/ceremony.md) |
| [First launch](./docs/self-hosting/first-launch.md) | [Community forum (Discourse)](./docs/self-hosting/discourse.md) |

Day-two operations, guardians and keys: [`docs/OPERATOR.md`](./docs/OPERATOR.md).

---

## Not for profit

This software is **not a commercial product**. A city, county, union, cooperative or school should
be able to run a binding election with **public verifiability** and **private ballots**.

- There is **no token**, **no paid tier** and **no vendor lock-in**.
- Jurisdictions may run it **at cost** (hosting, L1 gas). Voters never pay.
- Voter data is not a product.

License: AGPL-3.0-or-later. Full charter: [`NOT_FOR_PROFIT.md`](./docs/NOT_FOR_PROFIT.md).

---

## Contents

- [Two kinds of contest](#two-kinds-of-contest)
- [Current status and known limits](#current-status-and-known-limits)
- [Repository layout](#repository-layout)
- [How to run and test](#how-to-run-and-test)
- [How a civic vote works](#how-a-civic-vote-works)
- [How a poll works](#how-a-poll-works)
- [Identity, registration and eligibility](#identity-registration-and-eligibility)
- [Disqualification and due process](#disqualification-and-due-process)
- [Ballots and aspects](#ballots-and-aspects)
- [Roles](#roles)
- [Privacy, coercion and verifiability](#privacy-coercion-and-verifiability)
- [Forking](#forking)
- [Voting subdomain](#voting-subdomain)
- [Community discussion (optional Discourse)](#community-discussion-optional-discourse)
- [What this system will not do](#what-this-system-will-not-do)
- [Development](#development)
- [Glossary](#glossary)
- [Related work](#related-work)
- [Legal and policy note](#legal-and-policy-note)

---

## Two kinds of contest

The creator of each contest picks one:

| | **Civic vote** | **Poll** |
| --- | --- | --- |
| Where it is counted | **ZkVotingRollup** on Ethereum L1, through an L2 operator | On your Node |
| What is ever decrypted | **Only the final per-option sum**, by k-of-n guardians, checked by L1 | The Node opens ballots for the tally (guardian threshold on `opens_ballots` polls) |
| Interim results | None. No partial sum exists in decryptable form. | Hourly disclosure blocks; per-choice counts after a turnout gate |
| Ballot methods | One question, choose one | Plurality, multi-choice, ranked choice (IRV), several questions |
| Anonymity floor | Below `minBallots` the result is **Withheld** | `RESULTS_MIN_VOTES` gate on per-choice counts |
| Token weighting | No | ERC-20 token polls (`POLLS_ENABLED`) |
| Privacy | Strongest this stack offers | Weaker, and the app labels it so |

Design of the civic path: [`smart-contracts/docs/ROLLUP.md`](../smart-contracts/docs/ROLLUP.md).
Polls: [`docs/POLLS.md`](./docs/POLLS.md).

---

## Current status and known limits

| Area | State |
| --- | --- |
| `ZkVotingRollup` (L1) | In-tree, tested (`forge test`): jurisdictions, elections, Feldman DKG with Baby Jubjub guardian keys, priority queue, commit/verify/execute/revert, desert mode, threshold decryption of the final sum. **Not deployed on a public chain.** |
| L2 operator (`l2/rollup`) | In-tree: state tree, pubdata, batches, HTTP API. Settles against `MockBatchVerifier` on the local chain only. |
| **Batch validity circuit** | **Not built.** Specified in ROLLUP.md; needs recursion over the voters' ballot proofs. Until it exists the operator refuses a real verifier, so **no public-chain civic vote is possible yet**. |
| Ballot proofs | Real: each option ciphertext is 0 or 1 and they sum to one (checked by the operator). |
| Eligibility | **Not proven in zero knowledge yet.** The Node gates civic ballots with one blind vote pass per voter on the roll, and keeps a poll book of who took a pass (never which ballot). |
| Node (`apps/node`) | Express API + vanilla JS pages, Postgres (or JSON files without Compose). Voter, back office, site admin, explorer, results, outcomes monitor, bot API. |
| Polls | Node-side: plurality, IRV, sealed ranked choice, hourly disclosure, `opens_ballots` guardian tally (**NON-PRODUCTION** P-256 Feldman), ERC-20 token polls. |
| Poll circuits (`circuits/`) | Circom vote / tally circuits with **untrusted** local keys; the phase-2 ceremony tooling is in-tree and has **not** been run. |
| Docker Compose | One command to a full local stack (Node, operator, Postgres, Anvil, deploy). |
| Accessibility | WCAG 2.2 AA axe checks on the main shells ([`docs/ACCESSIBILITY.md`](./docs/ACCESSIBILITY.md)). |
| Bot API | Public `/api` docs, OpenAPI and `llms.txt`; personal API keys on `/me` ([`docs/BOT_API.md`](./docs/BOT_API.md)). |
| Independent auditor | `tools/auditor` still reads the **old** contracts; a rollup version is pending ([`docs/AUDITOR.md`](./docs/AUDITOR.md)). |

Also know:

- Civic ballots appear in L1 batch pubdata as a nullifier and a hiding commitment, so **turnout
  over time is public at batch granularity**, though no choice is.
- The operator sees ciphertexts and arrival times. A threshold of colluding guardians together
  with the operator could decrypt individual ballots; that is the honest-threshold assumption.
- Civic revoting is off: nothing yet proves the sender owns a nullifier.

---

## Repository layout

```text
voting_node/
  apps/node/            Express API + vanilla JS pages (public/), the rollup client (src/rollup/)
  l2/rollup/            L2 operator: state, pubdata, batches, HTTP API (main.mjs)
  packages/             @zk-voting/types, proof-helpers, chain-client (poll path)
  circuits/             Circom poll circuits and the ceremony scripts
  tools/                setup, deploy, auditor, load harness
  scripts/              start-anvil, deploy, ABI export, image smoke, migrations-verify
  docs/                 operator docs; docs/self-hosting is served at /docs
  docker-compose.yml    node, l2, db, and the local-l1 profile (l1, l1-deploy)
../smart-contracts/     ZkVotingRollup, libraries (Guardians, Ops, StateTree, BabyJub, PoseidonT3),
                        verifiers (Groth16, Desert, Mock), Foundry tests
```

The Node talks to the rollup. It is never a second, private source of a civic vote's truth.

---

## How to run and test

**Full stack:** see [Quickstart](#quickstart).

**Without Docker** (development):

```bash
npm ci
npm run dev                               # the Node on :3000 (JSON store under apps/node/data/)
npm run l2:operator                       # the L2 operator (needs L1_RPC, ROLLUP_ADDRESS, OPERATOR_PRIVATE_KEY, L2_BALLOT_TOKEN)
./scripts/start-anvil.sh --background     # a local chain
./scripts/deploy.sh --target local        # ZkVotingRollup on it; writes a deployment record
```

**Tests:**

```bash
npm test                                  # everything below
npm run test:node                         # Node API, pages, crypto (Chrome needed for the a11y tests)
npm run test:l2                           # operator, including integration against Anvil
npm run test:contracts                    # cd ../smart-contracts && forge test
npm run test:packages
npm run test:setup
npm run test:docs
```

Guardians of a civic vote use `npm run guardian:rollup -- init | commit | receive | decrypt`
from `apps/node` ([`docs/OPERATOR.md`](./docs/OPERATOR.md)).

Host menu: `./system_actions.sh` (status, logs, health, deploy).

---

## How a civic vote works

1. **Draft and publish.** A clerk drafts a VOTE on the Node. In the back office, under
   **Guardians and tally**, they set k and the anonymity floor (`minBallots`), enroll guardians by
   their Baby Jubjub identity key, and publish. The Node account (`ROLLUP_PRIVATE_KEY`, the
   jurisdiction's clerk on L1) calls `createElection`.
2. **Key ceremony.** Each guardian runs `guardian:rollup commit`, then `receive`. The Node relays
   their signed messages; it cannot forge them. Anyone finalizes the joint key on L1.
3. **Roll.** Until the start, the Node's tick syncs registrations and disqualifications to L1
   through the priority queue. The roll is fixed on L1 at `startTime`.
4. **Voting.** A voter on the roll takes one blind vote pass (signed in, PIN). The browser gets
   the nullifier `Poseidon(nullifierSecret, l1ElectionId)` from the passkey wallet, encrypts the
   ballot to the joint key with its 0/1 and sum-to-one proofs, and sends it **without cookies**.
   The Node relays it to the operator and keeps only a receipt. A voter whose ballot is refused
   can force it in through L1.
5. **Close.** After the cutoff anyone (normally the Node's tick) closes the election; L1 stores
   the final encrypted accumulator.
6. **Decrypt the sum.** Guardians run `guardian:rollup decrypt`. `finalizeResult` checks the totals
   against their Chaum-Pedersen shares and that they add up to the ballot count. Below
   `minBallots` the result is **Withheld**.
7. **Results.** `/elections/:id/results` reads the certified totals from L1.

If the operator stops serving the queue for three days, anyone can activate **desert mode** and
finish closed elections from the last proven state.

---

## How a poll works

Polls run on the Node and keep features a civic vote cannot have: several questions, ranked
choice (IRV), interim disclosure, and token weighting.

- Ballots are encrypted in the browser and relayed without the voter's session.
- Turnout publishes **hourly** from the first ballot, 30 minutes after each hour closes
  (`DISCLOSURE_DELAY_SECONDS`); an hour under `DISCLOSURE_MIN_BLOCK_VOTES` ballots merges forward.
- Per-choice counts wait until `RESULTS_MIN_VOTES` voters have cast, or until the end.
- `opens_ballots` polls are tallied by t-of-n guardians (P-256 Feldman, **NON-PRODUCTION**;
  [`docs/TALLY_GUARDIANS.md`](./docs/TALLY_GUARDIANS.md)).
- Token polls weight by an ERC-20 on Ethereum mainnet; they are public, signal-only polls
  ([`docs/POLLS.md`](./docs/POLLS.md)).
- `ALLOW_REVOTE` lets a poll voter replace their ballot until the deadline.

---

## Identity, registration and eligibility

A person identifies with **email** (up to 5, one primary), an **Ethereum wallet**, a
**smart-card reader**, a **driver's license or passport** (hashed; no images or full numbers
stored), or a **passkey** (up to 5). Every sign-in completes with **email MFA** when SES is
configured. Profile setup includes a **vote PIN** (4–8 digits, tapped on a shuffled keypad when
casting). WebAuthn **PRF** derives, under a separate domain, the identity trapdoor and nullifier
secret; the roll leaf is the identity commitment, never a wallet address or a name.
[`docs/IDENTITY.md`](./docs/IDENTITY.md), [`docs/PASSKEYS.md`](./docs/PASSKEYS.md).

Registration ends in a commitment on the roll. A voter's `POST /api/elections/:id/register` is
**pending** until a registrar of that jurisdiction approves it; officers can add a commitment
directly. The Node keeps the clerk's file (name, documents) off chain; the roll has only
commitments.

Voter statuses: not registered, pending review, registered, eligible, disqualified (with the
public reason code), ballot recorded.

---

## Disqualification and due process

**Registered ≠ allowed to vote.** An officer can bar a registered person from an election with a
public **reason code** and the hash of sealed evidence:

| Code | Meaning (illustrative) | Code | Meaning |
| --- | --- | --- | --- |
| 1 `NOT_OF_AGE` | Below voting age | 8 `ALREADY_VOTED` | Ballot already accepted |
| 2 `NOT_RESIDENT` | Not a resident | 9 `COURT_ORDER` | Barred by a court |
| 3 `NOT_CITIZEN_OR_MEMBER` | Fails membership rule | 10 `INELIGIBLE_STATUS` | Jurisdiction-specific status |
| 4 `DUPLICATE_IDENTITY` | Registered twice | 11 `FRAUD_HOLD` | Registrar hold |
| 5 `DECEASED` | Death recorded | 12 `EXPIRED_OR_SUSPENDED` | Lapsed registration |
| 6 `MOVED_OUT` | Left the jurisdiction | 13 `SANCTION_OR_PROHIBITION` | Legal prohibition |
| 7 `DISTRICT_MISMATCH` | Wrong district | 14 `OTHER` | Needs a memo reference |

- For a civic vote, disqualifications reach L1 through the priority queue before `startTime`
  and are public as events; after the start the roll is fixed.
- The **fact** of a disqualification and its code are public; the evidence and the person's file
  are not; a ballot is never attached to it.
- Revoking a disqualification is its own auditable event. Nothing is silently deleted.

The failure mode this guards against: a clerk who can quietly drop a person from a private
database the night before the vote.

---

## Ballots and aspects

Question types in the Node: `YES_NO`, `SINGLE_CHOICE`, `MULTI_CHOICE`, `RANKED` (IRV),
`MEASURE`, `ARTICLE`. A **civic vote** has one question with one choice (each option is one
ciphertext). A **poll** can carry several questions on one envelope, plurality or ranked choice;
sealed ranked choice and its trade-offs are described in [`docs/POLLS.md`](./docs/POLLS.md).
The ballot definition is hashed, so the UI cannot later show a different question.

---

## Roles

| Role | Node | L1 (civic votes) |
| --- | --- | --- |
| Voter | Register, see status, vote, keep a receipt | Can force a refused ballot in |
| Registrar | Approve registrations | Roll changes until the start (via the Node account) |
| Disqualification officer | Apply and revoke reason codes | Disqualify until the start |
| Clerk | Create, publish and close elections | The jurisdiction's clerk account |
| Guardian | Holds a key share | Key ceremony; one decryption share per option after close |
| Tally operator | Poll tallies on the Node | — |
| Platform admin / super admin | Host, branding, users | — |
| Anyone | Read public pages and the API | Close after cutoff, finalize, desert mode |

The L2 operator orders ballots and commits batches. It cannot create an election, change a roll,
censor a ballot (it can be forced in) or invent a result.

---

## Privacy, coercion and verifiability

| Goal | Approach |
| --- | --- |
| Privacy of choice | Ballots are encrypted in the browser. Civic votes decrypt only the final sum; polls open ballots only at tally. |
| Unlinkability | The ballot request carries no session, user id or commitment; the vote pass is blind; the active wallet is not the roll leaf. |
| Verifiability | L1 checks the civic result against the guardians' shares; anyone can read the rollup's events and batches; the outcomes monitor and explorer show public state. |
| Coercion | Receipts list hashes only and cannot prove a choice. Polls may allow revoting. MACI-style collusion resistance is not implemented. |
| Disqualification transparency | Reason codes are public so a mass purge cannot hide. |

Brief for officials: [`docs/how_voters_privacy_is_protected.md`](./docs/how_voters_privacy_is_protected.md).
Threat model: [`docs/THREAT_MODEL.md`](./docs/THREAT_MODEL.md).

---

## Forking

Forking is **the intended way** to run ZK-Voting. A jurisdiction copies the Node, runs it on its
own host, and keeps taking upstream releases. On a public chain every fork uses the **one shared**
ZkVotingRollup and gets its own jurisdiction there; it does not deploy its own contract. Keep your
changes in configuration, the CMS, plugins and theme tokens so upstream merges stay clean.

Guide: [Forking and staying current](./docs/self-hosting/forking.md). AGPL-3.0-or-later: a
modified Node run as a network service must offer its source.

### Voting subdomain

Publish the Node on a subdomain you control, for example `vote.domain.tld`, and set
`VOTE_FQDN=vote.domain.tld`. That hostname is the voting authority: voters open it, passkeys are
bound to it, and official links and QR codes print it. Leave it empty for a local demo
(WebAuthn on `localhost`). When it is set, `RP_ID` becomes that hostname (set `RP_ID` only to
use a parent domain), `https://vote.domain.tld` is always an allowed origin, and
`PUBLIC_BASE_URL` defaults to it. Terminate TLS in front of the Node. Set `VOTE_FQDN` before
voters register passkeys; changing it later means they register again.

---

## Community discussion (optional Discourse)

A vote tells you *what* people want; a conversation tells you *why*. We encourage operators to run
an open-source [Discourse](https://www.discourse.org) forum next to the Node, on its own subdomain.
It is optional; nothing in the app depends on it.

Rules that protect the ballot: nobody is ever asked how they voted; forum accounts are never
linked to ballots, receipts, nullifiers or credentials; vote-buying and coercion are removed; a
civic vote has no counts to discuss until its final sum is certified.
Guide: [Community forum](./docs/self-hosting/discourse.md).

---

## What this system will not do

- Guarantee that a government must use it, or that it satisfies an elections statute.
- Put voters' addresses or ID numbers on Ethereum.
- Let a disqualified person vote "privately anyway". Privacy is for the choice, not the roll.
- Hide mass disqualification behind zero knowledge.
- Charge voters, sell the software, or wrap it in a token.

---

## Development

- **Branches:** `test/unstable` is the development line; `master` is production. See
  [`CONTRIBUTING.md`](../CONTRIBUTING.md).
- **Tooling:** Node.js 24.7+, npm workspaces, vanilla JS front end (no bundler), Foundry
  (`forge test`), Circom 2 for the poll circuits.
- **Image check:** `./scripts/migrations-verify.sh` builds the production image and boots it with
  dummy secrets and a 384 MB cap; `/health` must answer within 120 seconds.
- **Workflow diagram:** `npm run docs:workflow` renders
  [`docs/diagrams/election-workflow.mmd`](./docs/diagrams/election-workflow.mmd).

Still ahead of a binding civic election: the batch validity circuit (with eligibility proofs),
a public ZkVotingRollup deployment, a rollup auditor, and a production review of the guardian
ceremony. Do not treat `MockBatchVerifier`, untrusted local keys or the poll guardian tally as
production cryptography.

---

## Glossary

| Term | Meaning here |
| --- | --- |
| **ZkVotingRollup** | The one L1 contract that settles civic votes for every jurisdiction. |
| **L2 operator** | Orders ballots into batches and commits them to L1 (`l2/rollup`). |
| **Civic vote** | A contest settled on the rollup; only its final sum is decrypted. |
| **Poll** | A contest counted on the Node; weaker privacy, more features. |
| **Guardian** | Holder of one share of an election's decryption key (k-of-n). |
| **Desert mode** | Permanent freeze anyone can trigger when the operator ignores the L1 queue. |
| **Withheld** | A civic result with fewer ballots than `minBallots`; never decrypted. |
| **Jurisdiction** | The body that owns a roll and its elections. |
| **Roll** | The registered identity commitments of an election. |
| **Nullifier** | `Poseidon(nullifierSecret, electionId)`: lets a person be counted once without naming them. |
| **Vote pass** | A blind-signed token the Node issues once per eligible voter; it gates a ballot without linking it to the voter. |
| **Poll book** | The Node's record of who took a vote pass, never of which ballot is whose. |
| **`localElectionId`** | The Node's own numeric sequence for an election (the poll proof's electionId). |
| **`rollupElectionId`** | A civic vote's election id on L1. |
| **Voting FQDN** | The subdomain a jurisdiction serves the Node on (`VOTE_FQDN`). |

---

## Related work

This project is not a fork of these; they are prior art:

- [Lighter](https://lighter.xyz) and zkSync Lite — the app-specific rollup pattern ZkVotingRollup follows: L1 enforces, an operator proves, a priority queue and desert mode keep the operator honest.
- [MACI](https://maci.pse.dev/) — collusion-resistant on-chain voting.
- [Semaphore](https://semaphore.pse.dev/) — anonymous group membership proofs.
- [ElectionGuard](https://www.electionguard.vote/) — homomorphic tallying with guardian threshold decryption.

---

## Legal and policy note

This repository describes software for running elections and for **denying a registered person a
ballot** under coded rules. It is not legal advice. Reason codes, notice, appeals, retention of
identity files, and whether an Ethereum record satisfies an elections code are jurisdiction
specific. Do not run a binding public election on this stack without your own counsel and
statutory authority.

The intent is that **eligibility and disqualification are visible as process**, while
**individual political choice is not**. A deployment that inverts that (public ballots, secret
purges) misuses this design.

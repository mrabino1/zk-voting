# Rollup redesign — handoff (updated 2026-11-23, phases 4 and 5 done)

Branch: `rollup-redesign` (cut from `test/unstable` at `7945ab6`). Design: `smart-contracts/docs/ROLLUP.md`.
The working tree is clean at the commit after `028c44e`, which only updates this file.

## Resume here

1. Read "Goal and decisions", then "Next: phase 4", then "Decision needed".
2. Set up the environment ("Environment" at the end) and run the tests to confirm the baseline:
   node 861 pass with `CHROME_PATH` set (without Chrome only `a11y` and `landing-lang` fail);
   `test:packages`, `test:l2` (21), `test:auditor`, `test:docs`, `test:setup`, and `forge test` (99) all pass.

## Goal and decisions

The user asked to replicate the lighter.xyz model. Ethereum L1 settles and enforces the rules
with **one L1 contract for the world** (`ZkVotingRollup`), and an L2 operator proves batches. The
ballot outcome is never reverse-calculable: L1 decrypts and enforces only the **final sum**. A full
top-to-bottom redesign (contracts, node, UI/UX) is authorized, ABI and storage breakage included.

- Civic VOTEs run on the rollup: sum-only, final-only, k-of-n guardians, anonymity floor (Withheld).
- Informal POLLs keep IRV and interim disclosure blocks, off-chain in the node, labelled as weaker privacy.
  ERC-20 token polls stay.

## Commits on the branch

| Commit | Phase | What |
| --- | --- | --- |
| `4b5257a`, `a215eec` | contracts | `ZkVotingRollup` (jurisdictions, elections, Feldman DKG with Baby Jubjub guardian identity keys, priority queue, commit/verify/execute/revert, desert mode and `desertClose`, threshold decryption, `finalizeResult`). Libraries Guardians, Ops, StateTree, BabyJub, PoseidonT3. Verifiers Groth16 (one input), Desert, Mock. Old contracts removed. |
| `1f7ad25` | L2 operator | `voting_node/l2/rollup/` (state, pubdata, batches, operator, HTTP API, `main.mjs`). Shared crypto in `apps/node/public/ballot-crypto.js`. `CrossLanguage.t.sol` settles a JS-generated election. |
| `8905286` | node (WIP) | Rollup client, service and routes (`/api/elections/:id/rollup`), the rollup branch of `POST /vote`, `scripts/rollup-guardian.mjs`, the `decryptionShares` view. |
| `e64ef27` | 1. node cleanup | Old chain, L1 mirror, `/api/l2/*`, site contract pins, factory-scoped ids and old config keys removed. Setup step 6 is "Rollup connection" (`GET /api/setup/rollup`). |
| `af34959` | 2. deploy and ops | Docker Compose with the `local-l1` profile (`l1` Anvil + one-shot `l1-deploy`), `ROLLUP_DEPLOYMENT_FILE`, Anvil-key guard off 31337, L1 chain-id check, `./setup.sh` step 6, `scripts/deploy.sh --target local\|public`, `tools/deploy`. Old L2 identity system removed. |
| `028c44e` | 3. browser | `public/rollup-vote.js` (encrypt in the browser, cast with a pass, follow the receipt), `public/rollup-results.js` (results from L1), back-office "Civic vote on L1" panel, copy updated, vote-pass and nullifier rules (below). |

## Standing directives from the user (2026-11-23, apply to all remaining work)

### 1. A public good that people fork and run themselves (think Discourse)

The project is a civic public good. Assume a town clerk, a co-op or a volunteer will clone it,
run it on a laptop or a small VPS, and run their own fork for years. Architect for that:

- **One command to a working local install.** `./setup.sh` then `docker compose up` must give a
  usable node with a local L1 (the `local-l1` profile) and no paid services. Every external service
  (SES, Postgres, a public RPC, S3) is optional, with a local default that works.
- **No hidden coupling to us.** No hard-coded hostnames, brand names, analytics, keys or contract
  addresses for "our" deployment. Branding, site name, locales and the rollup deployment come from
  config or the deployment file (`ROLLUP_DEPLOYMENT_FILE`). A fork changes config, not code.
- **Forks stay upgradable.** Keep customisation in config, the CMS, the plugin hooks
  (`src/plugins`) and theme tokens (CSS custom properties), so a fork can merge upstream without
  conflicts. Store migrations run on boot and keep old data loadable (as `normalizeLoadedData` does).
- **Docs for the operator who is not us.** Phase 5 docs are written for a self-hoster: install,
  upgrade, backup and restore, rotating keys, running guardians, going from local Anvil to a public
  chain. `docs/self-hosting/*` is the entry point.
- **Honest defaults.** Mock proofs and Anvil keys stay refused off chain 31337. A fresh fork must
  never look production-ready when it isn't (see "Known gaps").

### 2. Voting UI: simple and clean, tracking grants.ajnafi.com

Redesign the voter-facing pages (home/elections list, ballot, receipt, results) to track the
layout and "bubble" (rounded pill/card) UI of https://grants.ajnafi.com, and above all its
simplicity. What could be read from the site (it renders client-side, so only its structure came
through a fetch): a top bar with logo, a few tabs, a chain indicator and one primary action; a
**side nav that walks the phases of a cycle** (Overview → Screening → Funding → Finalize →
Execute, plus Previous Cycles); and plain tables for past cycles. Colours, pill shapes, spacing and
the voting controls were **not** visible. Look at the site in a real browser before styling.

How it maps here:
- An election's lifecycle as the phase nav: Draft → Key ceremony → Voting → Counting → Result
  (civic vote), or Open → Closed → Tallied (poll). The current phase is highlighted, as
  `voteSteps` already does on the ballot page.
- Elections as rounded cards with pill badges (status, civic vote / poll, time left, ballots cast
  where public), in a single column; no dense panels on voter pages.
- The ballot: one question per card, large rounded option "bubbles" (radio/checkbox styled as
  pills), one primary button. Explanations go behind a "How this is counted" disclosure, not walls
  of text.
- Keep the token system in `styles.css` (`:root` custom properties, light/dark, WCAG 2.2 AA, the
  a11y test) and restyle through tokens, so forks can re-theme (directive 1).
- Back-office pages are out of scope for the bubble look; clarity there is enough.

Not done yet. It is the next task, before or alongside phase 5. Chrome
is missing on this host, so render and screenshot on a machine with a browser.

## How a civic vote works now (for orientation)

- **Draft and publish.** A clerk creates a VOTE draft on the node. In the back office, under "Civic
  vote on L1", they set k and `minBallots`, enroll guardians by identity key
  (`npm run guardian:rollup -- init`), and click Publish (L1 `createElection`).
- **Key ceremony.** Guardians run `guardian:rollup commit` and then `receive`. Someone clicks
  "Finalize key". The node tick (`ROLLUP_TICK_SECONDS`) syncs the roll to L1 until `startTime`.
- **Voting.** A voter on the roll gets one blind vote pass (`POST /vote-pass`, signed in, PIN). The
  browser gets the nullifier `Poseidon(nullifierSecret, l1ElectionId)` from the passkey wallet,
  encrypts the ballot (`encryptBallot`), and sends `POST /vote` without cookies. The node relays the
  ballot to the operator (`POST /v1/ballots`, bearer `L2_BALLOT_TOKEN`) and keeps only a receipt.
- **Close and finalize.** After the cutoff the node tick closes the vote. Guardians run
  `guardian:rollup decrypt`. Finalize computes the totals from the L1 sum and shares, and L1 checks
  them. The results page reads `/rollup`.
- **Accounts on local compose.** Anvil 0 is the governor, 1 the L2 operator, and 2 the node clerk.
  All are public keys, refused off chain 31337.

Server rules added in phase 3 (`src/routes/elections.mjs`, `src/rollup/service.mjs`):

- `POST /vote-pass` for a rollup vote requires a signed-in user whose linked commitment
  (`store.findLink`) is eligible, and issues one pass each (`claimIssue`, key `u:<userId>`).
- A rollup ballot requires a pass; there is no signed-in PIN shortcut.
- One ballot per nullifier (`NULLIFIER_USED`), reserved in `castBallot` against concurrent
  requests. A ballot the operator rejected may be cast again. **Civic revoting is off**: nothing
  proves the sender owns a nullifier, and nullifiers are public in pubdata, so a revote could
  overwrite another voter's ballot. `ALLOW_REVOTE` affects polls only for now.
- On a node connected to the rollup, an unpublished civic vote takes no pass and no ballot
  (`VOTE_NOT_ON_L1`).
- A vote on L1 counts as roll-fixed (`rollFixed` in `electionState.mjs`); the node freeze is not used.

## Decision taken: vote-pass poll book

The user chose to persist vote-pass issuance (2026-11-23). The store keeps `votePassIssued`:
per election, sorted sha256 hashes of `u:<userId>` / `c:<commitment>` (`votePassIssueKey`), no
timestamps, hour-coarse in Postgres. `POST /vote-pass` checks it before signing and records it
before returning the signature, so a restart cannot issue a second pass. It records who took a
pass, never which pass. The real fix is still the eligibility proof in the batch circuit.

## Phase 4 progress log (newest last; update with every commit)

- Explorer: `GET /api/explorer/rollup` (batches and status from the L2 operator, minus the live
  `pendingBallots`), with an explorer view at `/explorer#/rollup` and a "Rollup batches" button. Removed
  `POST /api/explorer/ingest`, `EXPLORER_INGEST_SECRET` (config, compose, `.env.example`, setup,
  diagnostics, migrations-verify) and the ingest tests in `election-ids.test.mjs`. Left in place:
  `Explorer.ingest()` and its block-import internals in `src/explorer.mjs`, still used by
  `explorer-ingest.test.mjs` and `rolling-handover.test.mjs`. Nothing calls it over HTTP now; remove
  it with those tests later.

- Store: removed the uncalled chain-ballot and exclusion writers (`chainBallotPayload`,
  `markChainBallotQueued`, `dropChainBallotPayloads`, `noteExclusionApproval`,
  `recordBallotExclusion`, `setExclusionReleasePending`, `EXCLUSION_APPROVAL_TTL_SECONDS`) and their
  test. Still there:
  - the chain-vote-queue persistence (`chainVote*` collections, `applyChainVoteQueue`,
    `loadChainQueueFromDisk`, `saveChainVoteQueue`, `queuePath` sidecar, both JSON and Postgres);
  - `listPublicElections` filtering `l2OpenStatus`;
  - the exclusion read helpers (`excludedNullifiers`, `liveExcludedCount`, `publicExclusion`),
    which old records may still use.

- Locales: the `office` section of every `public/locales/*.js` is pruned to the 6 keys that
  `back-office.html` uses (`electionType`, `typeLocked`, `typePoll`, `typePollHelp`, `typeVote`,
  `typeVoteHelp`). `i18n.test.mjs` passes. Full node suite not re-run after this commit; run it first.
- CSS: `styles.css` already uses tokens (544 `var(--…)`). The "duplicate selectors" are mostly
  media-query and high-contrast overrides. Do not consolidate without a browser to compare
  before and after.
- Vote-pass poll book (`f2b27c6`): see "Decision taken".
- Voter flow: `public/vote-flow.js` (`ballotPath`, `voteSteps`, `voteBlockers`, tested in
  `test/vote-flow.test.mjs`). The ballot page shows a step bar (mark → PIN → passkey → receipt),
  one "how this ballot is counted" notice (civic vote on L1, poll on this node, sample), and one
  "Before you can cast" checklist instead of three separate warnings. A live ballot can no longer
  be sent to a closed election after a confirm dialog; the button is disabled. Both submit paths
  share `acceptReceipt`. CSS: `.vote-steps`, `.vote-path-*`, `.vote-blockers` at the end of
  `styles.css`, tokens only. Not rendered in a browser.
- Back office: the "Tally operator" and "Civic vote on L1" panels are one panel, "Guardians and
  tally" (`#tally`), with one election picker (`t-election`). Picking a civic vote shows the L1
  steps and controls (`#tally-civic`); picking a poll shows the poll tally, with the
  `opens_ballots` P-256 guardian forms folded into a disclosure (`#tally-poll`). `ru-election` is
  gone; `showTallyMode` in `back-office.js` switches on the election kind. The freeze-roll picker
  lists polls only. An empty `<span id="rollup">` keeps old `#rollup` links working. Found, not
  fixed: `renderAspectEditor` writes to `#questions-editor`, which the page does not have (it
  predates this branch). Not rendered in a browser.
- Full node suite after these commits: 797 pass; only the Chrome-dependent a11y and landing-lang
  tests fail.
- Rename: `onChainElectionId` is now `localElectionId` (the node's local sequence, the poll proof's
  electionId) in `src`, `public`, tests, `packages/types` and the docs that named it. Helpers:
  `localElectionIdOf`, `getElectionByLocalId`, `_allocateLocalElectionId`, wallet
  `authorizeBallot({ localElectionId })`. `renameLocalElectionIds` in `store.mjs` moves stored
  records on load; `createElection` still accepts `onChainElectionId`. The locale key
  `elections.onChainId` ("On-chain id") was left alone.
- Voting UI, first pass (directive 2): voter-page tokens `--radius-voter-card`, `--radius-bubble`,
  `--radius-option` in `:root`, and a scoped block at the end of `styles.css` that rounds the
  ballot's question cards, option bubbles, step pills, buttons and the election cards. The contest
  tags were already pills. Radius and spacing only, no colour change, so the contrast checks are
  unaffected. Still to do for directive 2, and best done with a browser and the reference site
  side by side: the election lifecycle phase nav on the election and results pages, the
  single-column card list on the home page, and moving long explanations behind disclosures.
- Phase 5 docs (done): both READMEs rewritten (civic vote vs poll, known limits, forking);
  `self-hosting/*` describe the rollup stack (local L1 by default) and drop the removed services
  and variables; new `self-hosting/forking.md`; `OPERATOR.md`, `L2.md`, `L2_VPS_SETUP.md` (now
  "deploying ZkVotingRollup to a public chain"), `ROLLING_UPDATES.md`, `ARCHITECTURE.md`,
  `THREAT_MODEL.md`, `how_voters_privacy_is_protected.md`, `PASSKEYS.md`, `POLLS.md`,
  `BLOCK_EXPLORER.md`, `AUDITOR.md` (marked out of date for civic votes), `LOAD_TEST.md` (scoped
  to polls), `circuits/README.md`, `CONTRIBUTING.md`, `implementation.md`. Deleted
  `OPERATIONS-L2-LIFECYCLE.md`. The two old contract proposals are marked superseded. The
  workflow diagram is redrawn for the civic flow and re-rendered.
- Gas economics (done): `scripts/lib/gas_economics.py` models one civic vote on ZkVotingRollup
  from `forge test --gas-report`; `docs/voting_cost_estimate.md` has the numbers. Findings: the
  roll costs ~5,500 gas per voter (the biggest line); the operator's default
  `L2_BATCH_SECONDS=10` can cost ~180× more than full batches when ballots trickle in, so a
  public deployment should batch every few minutes. Not changed in code: it is a latency/cost
  call for the user.
- Browser check (done): Chrome for Testing in a session scratchpad (see Environment). All a11y and
  landing-language tests pass (63); the ballot page and back office were screenshotted and three
  small defects fixed.
- Voting UI, second pass (directive 2): a lifecycle phase strip (`contestPhaseStrip`,
  `contestPhases` in `public/contests.js`: Draft → Registration → Voting → Counting → Results; no
  Draft for polls) on every contest card and in the ballot header. Card kickers say "Civic vote" or
  "Poll" when there is no jurisdiction name. The home page's limits note, "how a vote works" steps
  and the FAQ now describe the rollup (no paymaster, sequencer or inbox). Rendered and checked in
  Chrome; a11y suite passes.
- Voting UI, third pass (directive 2): grants.ajnafi.com rendered in headless Chrome. Adopted its
  layout language in our own tokens (no Ajna colours or fonts): borderless 1.5rem cards, uppercase
  tracked section labels, filled pill buttons, and the lifecycle as an underlined uppercase tab row
  on the ballot page (`contestPhaseStrip(h, e, { tabs: true })`). Wrapped in
  `@media (prefers-contrast: no-preference)` so high-contrast mode keeps borders. Not done: Ajna's
  header-only navigation (no left sidebar); that is an app-shell change for every page.
- Batch validity circuit: design and options in
  [`batch-validity-circuit.md`](./batch-validity-circuit.md). Recommendation: Noir/UltraHonk with
  recursive voter proofs (BN254-native, no per-circuit ceremony). Prototyping needs `nargo`/`bb`;
  installing an unverified binary was refused by the session's safety check, so it waits for the
  user. Also fixed: `ROLLUP.md` gave `ELECTION_TREE_DEPTH = 16`; the code uses 32.
- CI (`.github/workflows/ci.yml`, still manual-only): the compose job runs `./setup.sh -y` and checks
  the rollup stack; `test:setup` added. Setup now generates credentials for the bundled Postgres.
- **Resume at:** "Other follow-ups" below, or step 1 of the batch-circuit plan once the toolchain
  is approved.

## Next: phase 4 (UI/UX cleanup, requested by the user)

None of it is started. Suggested order:

1. **CSS.** `apps/node/public/styles.css` is about 3.9k lines. Introduce tokens (colours, spacing,
   type, radius) as custom properties with dark mode, then consolidate duplicated component
   rules. `office.css` is shared by site-admin and the back office. The rollup modules use existing
   classes: `panel`, `meta-list`, `notice`, `status-pill`, `results-table`, `receipt`.
2. **Voter flow** (`public/vote.js`, about 1.2k lines; `register.js`). The rollup path sits in
   `submitRollupBallot` / `renderRollupReceipt`. Simplify the steps (passkey → PIN → ballot →
   receipt) and make it clear which path a ballot takes (civic vote on L1 or poll on the node).
3. **Back office** (`public/back-office.html` + `back-office.js`, a static English IIFE page).
   Merge the old `opens_ballots` P-256 guardian forms (node-side polls) and the new "Civic vote on
   L1" panel into one clear flow. Hide the poll-only tally tools for votes.
4. ~~Explorer~~ (done, see the progress log).
5. ~~Locales~~ (done). The `office` section of `public/locales/*.js` is mostly unused (no `data-i18n`
   points at it). Prune it in every locale together, because `test/i18n.test.mjs` requires the
   same keys in all of them.
6. ~~`onChainElectionId` rename~~ (done: `localElectionId`, see the progress log).

## Phase 5: docs

These still describe the old stack: root `README.md`, `voting_node/README.md`, `docs/OPERATOR.md`,
`docs/ARCHITECTURE.md`, `docs/L2.md`, `docs/L2_VPS_SETUP.md`, `docs/ROLLING_UPDATES.md`,
`docs/OPERATIONS-L2-LIFECYCLE.md`, `docs/TALLY_GUARDIANS*`, `docs/THREAT_MODEL.md`
(certificationId), `docs/self-hosting/*` (`first-launch.md` links the deleted
`L2-IDENTITY-AND-SETTLEMENT.md`), `docs/voting_cost_estimate.md`, `scripts/README.md`, and
`implementation.md`. `docs/BOT_API.md` and `llms.txt` are generated from
`apps/node/src/botApiCatalog.mjs`, and `test/api-keys.test.mjs` checks them.

## Other follow-ups

- **Store and explorer cleanup (done).** Removed `Explorer.ingest()` and its helpers and test,
  the chain vote queue (`chainVote*`, `chain-vote-queue.json`), `chainBallotPayloads`, the
  `l2OpenStatus` pending-open machinery, and the `EXCLUSION_RELEASE_PENDING` tally check (nothing
  could clear it any more). `dropRetiredChainState` deletes those keys from stored data on load.
  Kept: the `excludedBallots` readers, for older records. Still open: whether polls keep
  `TALLY_CHALLENGE_SECONDS`.
- **Auditor (done).** `tools/auditor/rollup.mjs` + `cli.mjs verify-rollup`: a civic vote audited
  from L1 alone (ballots decoded from executed batches' pubdata, joint key, floor, result hash,
  every k-subset of guardian shares). Exercised at the end of `l2/rollup/test/end-to-end.test.mjs`,
  including a falsified count and a missing ballot. `export-chain` (old contracts) removed.
  The outcomes monitor runs the same audit for civic votes (`src/rollup/audit.mjs`, cached;
  `ROLLUP_DEPLOY_BLOCK` sets the first block scanned). The image copies `tools/auditor/rollup.mjs`
  and `l2/rollup/pubdata.mjs` for it.
- **Terms of Use.** `apps/node/legal/terms.md` still mentions a paymaster and an L1 tally mirror.
  Editing it changes the Terms hash and re-prompts every user, so it was left for the user.
- **Batch interval (done).** The operator now holds ballots up to `L2_BATCH_MAX_WAIT_SECONDS`
  (0 on chain 31337, 600 elsewhere) and seals at once for a full batch, a waiting priority request,
  or an approaching cutoff (`Operator.ballotsDue`, `l2/rollup/test/batching.test.mjs`). Worst case
  for the modelled 12-hour vote drops from ~2.3 B to ~38 M gas of batches.
- **Operator updates.** The L2 operator has no writer lease, so there is no overlap update for it.
  Recreate the container instead; the node answers 503 while it is down, and voters retry.
- **`l1-deploy` network.** It compiles the contracts on each fresh deploy, so it needs network once,
  to fetch solc.

## Known gaps (tell the user, do not hide)

- **No batch circuit.** The batch validity circuit is specified but not built. It needs recursion
  for the voters' ballot proofs (Lighter uses Plonky2). Until it exists, only `MockBatchVerifier`
  works, and only on chain 31337. The operator refuses to start against a real verifier, and the
  operator accepts ballots without eligibility proofs only with `ZK_VOTING_ALLOW_MOCK_PROOFS=1` on 31337.
- **Eligibility.** Roll membership is not proven in zero knowledge; the node's vote pass gates
  ballots, with a persisted poll book (see "Decision taken"). The ballot 0/1 and sum-to-one proofs are real, and the operator
  checks them.
- **Not run.** Docker Compose was never run (no Docker on this host), and the browser pages were
  never rendered (no Chrome). What was checked instead: the compose YAML parses; the `l1-deploy`
  script ran against a host Anvil; `rollup/main.mjs` and `server.mjs` booted with the compose
  environment; `scripts/image-import-smoke.mjs` passes; the page modules load in Node; the browser
  ballot verifies with `verifyBallot`.
- **Next real-machine step.** On a machine with Docker, run
  `cd voting_node && ./setup.sh && docker compose up -d --build`, then cast a civic vote end to end
  in a browser.

## Environment

- **Node.js.** The host has no Node.js. Node 24 was unpacked in an earlier session's scratchpad
  (`/tmp/claude-1000/-home-mr-src-zk-voting/536cab08-…/scratchpad/tools/node-v24.11.1-linux-x64`), which may be
  gone. To reinstall, get `https://nodejs.org/dist/v24.11.1/node-v24.11.1-linux-x64.tar.xz`, verify it
  against `SHASUMS256.txt`, put its `bin` on `PATH`, and run `npm ci` in `voting_node` if
  `node_modules` is missing.
- **Foundry** is at `~/.foundry/bin` (forge 1.10.0). The L2 and node integration tests start Anvil
  themselves.
- **Running the tests:**
  - node: `cd voting_node/apps/node && NODE_ENV=test ZK_VOTING_USE_MOCK_VERIFIER=1 ZK_VOTING_ALLOW_MOCK_PROOFS=1 node --test test/*.test.mjs`
  - the rest, from `voting_node`: `npm run -s test:packages | test:l2 | test:auditor | test:docs | test:setup`
  - contracts: `cd smart-contracts && forge test`
- **Linter.** The repo has none. eslint 9.15 with `no-undef` caught the helpers the rewrite had
  dropped. It was installed in a session scratchpad (`npm i eslint@9.15.0 globals@15.12.0`, flat
  config with `no-undef` and `no-unused-vars`, Node and browser globals); reinstall it if needed.
  Known warnings that predate this work: `qr.mjs` `inTiming`, and some unused test locals.
- **Chrome** is not installed on the host. Chrome for Testing 158 was fetched into a session
  scratchpad with `node node_modules/@puppeteer/browsers/lib/cjs/main-cli.js install chrome@stable
  --path <dir>` (no extra system libraries needed). Set `CHROME_PATH` (tests) or
  `PUPPETEER_EXECUTABLE_PATH` (`npm run docs:workflow`) to its `chrome-linux64/chrome`. With it the
  full node suite passes (861/861).

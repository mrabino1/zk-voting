# Rollup redesign — handoff (updated 2026-11-23, end of phase 3)

Branch: `rollup-redesign` (cut from `test/unstable` at `7945ab6`). Design: `smart-contracts/docs/ROLLUP.md`.
The working tree is clean at the commit after `028c44e`, which only updates this file.

## Resume here

1. Read "Goal and decisions", then "Next: phase 4", then "Decision needed".
2. Set up the environment ("Environment" at the end) and run the tests to confirm the baseline:
   node 792 pass (only the Chrome-dependent `a11y` and `landing-lang` tests fail, as before);
   `test:packages`, `test:l2` (21), `test:auditor`, `test:docs`, `test:setup`, and `forge test` (99)
   all pass.

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
6. **`onChainElectionId`.** This is a historical name for the node's local sequence (the poll
   proof's electionId). Rename it across `src`, `public` and the tests.

## Phase 5: docs

These still describe the old stack: root `README.md`, `voting_node/README.md`, `docs/OPERATOR.md`,
`docs/ARCHITECTURE.md`, `docs/L2.md`, `docs/L2_VPS_SETUP.md`, `docs/ROLLING_UPDATES.md`,
`docs/OPERATIONS-L2-LIFECYCLE.md`, `docs/TALLY_GUARDIANS*`, `docs/THREAT_MODEL.md`
(certificationId), `docs/self-hosting/*` (`first-launch.md` links the deleted
`L2-IDENTITY-AND-SETTLEMENT.md`), `docs/voting_cost_estimate.md`, `scripts/README.md`, and
`implementation.md`. `docs/BOT_API.md` and `llms.txt` are generated from
`apps/node/src/botApiCatalog.mjs`, and `test/api-keys.test.mjs` checks them.

## Other follow-ups

- **Store.** `store.mjs` still carries the old chain vote queue and exclusion machinery, which
  nothing reaches any more: `chainVoteDeadLetter` / `chainVoteSupplementary`,
  `exclusionApprovals`, `excludedBallots.releasePending`, and the `pendingReleases` check in
  `POST /:id/tally` and diagnostics. Remove it with the remaining revote-flag tests that use it.
  Decide whether polls keep `TALLY_CHALLENGE_SECONDS` (`supplementaryBatch.mjs`).
- **Auditor tools.** `tools/auditor/export.mjs` and `cli.mjs` read the old ElectionFactory over RPC.
  Rewrite them for ZkVotingRollup.
- **Gas economics.** `scripts/get-gas-economics.sh` and `scripts/lib/gas_economics.py` model the
  old contracts (the script prints a warning). Write a rollup cost model.
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
- **Chrome** is missing, so the a11y and landing-language browser tests fail. They failed before this work too.

# Rollup redesign — handoff (2026-11-23)

Branch: `rollup-redesign` (cut from `test/unstable` at `7945ab6`). Design: `smart-contracts/docs/ROLLUP.md`.

Goal from the user: replicate the lighter.xyz model. Ethereum L1 settles and enforces the rules
with **one L1 contract for the world**. An L2 operator proves batches. The ballot outcome is
never reverse-calculable, and L1 only decrypts and enforces the **final sum**. Full top-to-bottom
redesign (contracts, node, UI/UX) is authorized. Decisions taken with the user:

- Civic VOTEs run on the rollup: sum-only, final-only, k-of-n guardians, anonymity floor.
- Informal POLLs keep IRV and interim disclosure blocks, off-chain in the node, labelled as weaker privacy.

## Done (committed)

1. `4b5257a`, `a215eec`: **contracts**. `ZkVotingRollup` (jurisdictions, elections, Feldman DKG
   with guardian Baby Jubjub identity keys, priority queue, commit/verify/execute/revert, desert
   mode plus `desertClose`, threshold decryption with `finalizeResult`). Libraries: Guardians, Ops,
   StateTree, BabyJub, PoseidonT3. Verifiers: Groth16 (one input), Desert, Mock. All old contracts
   are removed. `forge test`: 99 passing.
2. `1f7ad25`: **L2 operator** in `voting_node/l2/rollup/` (state machine, pubdata, batches, operator,
   HTTP API, `main.mjs`). Shared crypto lives in `apps/node/public/ballot-crypto.js`, with keccak in
   `public/keccak.js`. `chain-client` now ships the rollup ABIs. `npm run test:l2`: 22 passing,
   including the end-to-end run on Anvil. `smart-contracts/test/CrossLanguage.t.sol` settles a
   JS-generated election.
3. Contract view `decryptionShares` was added after that commit (it is in the WIP commit below).

4. **Node integration** (WIP commit `8905286`, then the node cleanup commit after it):
   - `src/rollup/client.mjs`, `src/rollup/service.mjs`, `src/routes/rollup.mjs` (mounted at
     `/api/elections/:id/rollup`), the rollup branch in `POST /:id/vote`, and
     `scripts/rollup-guardian.mjs`.
   - The old chain is gone: `chain.mjs`, `l1Certify.mjs`, `l2Identity.mjs`, `routes/l2Results.mjs`
     (`/api/l2/*`), the L2-open, dead-letter, L1-mirror and archive routes, and their tests.
   - Config: `CHAIN_RPC`, the factory, inbox, verifier, relayer, mirror and publisher keys,
     `L2_CIVIC_RPC`, `ARCHIVE_ENABLED` and the `ALLOW_REVOTE` chain refusal (TODO #113) are removed.
     `ALLOW_REVOTE` works with the rollup configured: it governs both polls and civic votes
     (the rollup subtracts the replaced vector).
   - Site contract pins are removed. `/api/site` and `/api/office/site` show `rollup` read-only
     (from `ROLLUP_ADDRESS`); `PATCH /api/office/site` with `contracts` answers 400
     `CONTRACTS_FROM_ENV`. `/api/config` has `rollup`, not `contracts`.
   - Public election ids are UUID v5 of (node, jurisdiction, local sequence). Factory scoping,
     `certificationId`, `publicIdHash` and `l1IdentityOf` are gone. The election DTO has
     `chainMode` (`node` | `rollup`) and `rollupElectionId`.
   - Setup step 6 is "Rollup connection": `GET /api/setup/rollup` (super admin) shows the contract,
     L1 chain, node account, its L1 balance (low/empty warning) and whether the L2 answers.
   - `createApp({ rollupService })` injects a service; `createApp({ rollup })` is config.
   - Auditor packs carry `rollup { address, chainId, electionId }` instead of `contracts`.
   - `docs/BOT_API.md` and `llms.txt` are regenerated from `botApiCatalog.mjs`.
   - Tests: node 777 pass (only the Chrome-dependent a11y and landing-lang tests fail, as before);
     packages, `test:l2` (22), auditor, docs, setup and `forge test` (99) all pass.

5. **Deployment and operations** (phase 2):
   - `docker-compose.yml` (and the tailscale copy): `node`, `l2` (`node rollup/main.mjs`), `db`,
     and under the `local-l1` profile `l1` (Anvil 31337, foundry image pinned by digest, state on
     `l1-data`) plus `l1-deploy`. That one-shot runs `DeployLocal.s.sol` from `../smart-contracts`
     unless the recorded rollup already has code, and writes `/deployments/local.json` to the
     `l1-deployment` volume. The `prover` and `archive` services are gone.
   - Accounts: Anvil 0 is the governor, 1 the L2 operator (`OPERATOR`), 2 the node clerk (`CLERK`).
     `DeployLocal.s.sol` takes `OPERATOR` and `CLERK`. The node integration test uses the same split.
   - `ROLLUP_DEPLOYMENT_FILE` fills `ROLLUP_ADDRESS`, `L1_CHAIN_ID` and `ROLLUP_JURISDICTION_ID` in
     the node (`resolveRollupConfig`) and the operator (`chain-client` `readDeployment`).
   - Public Anvil dev keys are refused off chain 31337 (`chain-client` `assertKeyAllowedOnChain`)
     in the node, the operator and `./setup.sh`. The node client also checks that `L1_RPC` serves
     the configured chain before any L1 call (`L1_CHAIN_MISMATCH`).
   - `.env.example` defaults to the local stack (`COMPOSE_PROFILES=local-l1`). `./setup.sh` step 6
     offers a local L1 or an existing deployment (RPC, address, jurisdiction, node and operator
     keys, balance check of both) and mints `L2_BALLOT_TOKEN`.
   - `scripts/deploy.sh --target local|public` wraps `DeployLocal.s.sol` / `Deploy.s.sol` with the
     deploy-once guard. `npm run deploy:l1 -- --check|--verify` does the same check in JS.
     `deploy-fork-dryrun.sh` and `l2-vps-bootstrap.sh` are removed, along with the old L2 identity
     system (`l2/identity.mjs`, `funding.mjs`, `adminAuth.mjs`, `bin/`, `npm run l2:identity`,
     `npm run certify:l1`, `docs/L2-IDENTITY-AND-SETTLEMENT.md`).
   - The node image no longer copies the deleted `l2/archive`, `l2/sequencer` and `l2/prover`
     files (its COPY lines were broken). `docker-compose.rolling.yml` drops `l2-next`.
   - Fixed: a promoted standby node now starts the rollup tick.
   - **Not verified with Docker** (none on this host): the images were not built and compose was
     not run. Checked instead: the compose YAML parses; the `l1-deploy` script was run on a host
     Anvil (deploys, then skips on re-run); `rollup/main.mjs` and `server.mjs` booted with the
     compose environment against that Anvil; `scripts/image-import-smoke.mjs` passes.

6. **Browser** (phase 3):
   - `public/rollup-vote.js` + the rollup branch in `vote.js`: ballot context → the wallet's
     `rollupNullifier(l1ElectionId)` (only the nullifier leaves the wallet) → `encryptBallot` in the
     browser → `POST /vote` with the vote pass and no cookies → a rollup receipt with "Check status"
     (pending → committed → settled, or rejected). A blank ballot is refused, never counted for
     option 0.
   - `public/rollup-results.js`: the results page of a rollup vote reads `/rollup` (L1): status,
     guardian progress, certified totals, Withheld below the floor, Halted. Turnout only once closed.
   - Back office: a "Civic vote on L1" panel (settings, enroll guardian by identity key, publish,
     finalize key, sync roll, close, finalize). The dead "Certify hash on L1" button is gone.
   - Outcomes, admin and copy (cms, faq, public pages) name the rollup, not the old factory.
     `office.chainNote` / `office.certifyL1` were removed from every locale.
   - Server rules found while wiring it:
     - `POST /vote-pass` for a rollup vote needs a signed-in voter whose linked commitment is on the roll,
       one pass each. Before, anyone could mint passes, and the operator accepts any ballot with a pass.
     - A rollup ballot needs a pass (no signed-in PIN shortcut).
     - One ballot per nullifier (`NULLIFIER_USED`), checked in `castBallot` and reserved against races.
       Nothing yet proves the sender owns a nullifier and nullifiers are public in pubdata, so a
       "revote" could overwrite another voter's ballot. Civic revoting is therefore off until the
       eligibility proof exists. A ballot the batch rejected may be cast again.
     - On a node connected to the rollup, an unpublished civic vote takes no pass and no ballot
       (`VOTE_NOT_ON_L1`).
     - A vote published to L1 counts as roll-fixed (`rollFixed`); the node freeze is not needed.
     - Fixed: `renderReceipt` threw on a sealed vote (`formatTime` was not passed in).
   - **Not verified in a browser** (no Chrome here). The modules load in Node, the encryption is
     checked against `verifyBallot`, and the HTTP gate is tested with a fake L1/L2 client.

## Decision needed (ask the user)

- Vote-pass issuance is remembered in memory only (`votePass.claimIssue`). After a node restart a
  voter on the roll can get a second pass and cast a second ballot under another nullifier.
  Persisting "voter X got a pass for election E" closes that, and does not link the pass to the
  ballot (it is blind), but it records who took part, like a paper poll book. The real fix is the
  eligibility proof in the batch circuit.

## Follow-ups found during the node cleanup

- The `office` section of `public/locales/*.js` is mostly unused (the back office is static English
  HTML). Prune it with the UI/UX cleanup.

- The L2 operator has no writer lease, so it cannot run in an overlap like the node. Update it by
  recreating the container (the node answers 503 meanwhile, and the voter retries).
- `scripts/get-gas-economics.sh` and `scripts/lib/gas_economics.py` still model the old contracts.
  Write a cost model for the rollup (createElection, guardian calls, commit/execute per batch).
- The explorer `/api/explorer/ingest` route and `EXPLORER_INGEST_SECRET` are dead (nothing pushes
  blocks). Remove them with the explorer rewrite in phase 4.
- `l1-deploy` compiles the contracts on each fresh deploy and needs network once, for solc.

- `store.mjs` still carries the old chain vote queue and exclusion machinery, now unreachable:
  `chainVoteDeadLetter` / `chainVoteSupplementary`, `exclusionApprovals`, `excludedBallots` with
  `releasePending`, and the `pendingReleases` check in `POST /:id/tally` and diagnostics. Remove it
  together with the remaining revote-flag tests that exercise it. Decide whether polls keep
  `TALLY_CHALLENGE_SECONDS` (`supplementaryBatch.mjs`).
- `onChainElectionId` is a historical name for the node's local sequence (the poll proof's
  electionId). Rename it with the browser work in phase 3.
- `tools/auditor/export.mjs` and `cli.mjs` still read the old ElectionFactory over RPC. Rewrite
  them for ZkVotingRollup.

## Remaining phases

1. ~~Node cleanup~~ (done).
2. ~~Docker Compose, setup and deploy tooling~~ (done, see item 5 above).
3. ~~Browser~~ (done, see item 6 above).
4. **Next:** UI/UX cleanup that was requested: CSS tokens and consolidation of `styles.css` (3.9k lines),
   the voter flow, the admin/back office, and the contract-facing pages (explorer shows rollup
   batches from L2 `/v1/batches`).
5. Docs: README, `voting_node/docs/*` (ARCHITECTURE, L2, OPERATOR, TALLY_GUARDIANS), root README.
   Still describing the old stack: `voting_node/README.md`, `docs/OPERATOR.md`, `docs/ROLLING_UPDATES.md`,
   `docs/OPERATIONS-L2-LIFECYCLE.md`, `docs/L2.md`, `docs/L2_VPS_SETUP.md`, `docs/self-hosting/*`
   (`first-launch.md` links the deleted L2 identity doc), `docs/voting_cost_estimate.md`,
   `scripts/README.md`, `implementation.md`.

## Known gaps (tell the user, do not hide)

- The batch validity circuit is specified but not built. It needs recursion for the voters'
  ballot proofs (Lighter uses Plonky2). Until it exists, only `MockBatchVerifier` is used, on
  chain 31337.
- Voter eligibility (roll membership in zero knowledge) still relies on the node's vote pass.
  The ballot 0/1 and sum-to-one proofs are real and checked by the operator.

## Environment notes

- The host has no Node.js and no Docker access. Node 24 lives in the session scratchpad. To
  reinstall it:
  `curl https://nodejs.org/dist/v24.11.1/node-v24.11.1-linux-x64.tar.xz`, verify it against
  `SHASUMS256.txt`, then run `npm ci` in `voting_node`.
- Foundry is at `~/.foundry/bin`. The L2 and node integration tests start Anvil themselves.
- Chrome is missing, so the a11y and landing-language browser tests fail (they did before this work too).

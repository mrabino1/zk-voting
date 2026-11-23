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
     `ALLOW_REVOTE` now governs polls only; civic votes revote natively on the rollup.
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

## Follow-ups found during the node cleanup

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

1. ~~Node cleanup~~ (done). The old keys still remain in `.env.example`, `tools/setup/setup.mjs`,
   the compose files, `scripts/` and `system_actions/`. Remove them in phase 2, which rewrites
   those files anyway, along with the old L2 identity system: `l2/identity.mjs`, `funding.mjs`,
   `adminAuth.mjs`, `lease/`, `bin/l2-identity.mjs`, the `l2:identity` and `certify:l1` npm scripts,
   and `docs/L2-IDENTITY-AND-SETTLEMENT.md`.
2. **Next:** Docker Compose: an `l1` service (Anvil, foundry image) and a one-shot `forge script DeployLocal`.
   The `l2` service becomes `node rollup/main.mjs`. Remove the `prover` service. Node env:
   `L1_RPC`, `ROLLUP_ADDRESS`, `ROLLUP_PRIVATE_KEY`, `ROLLUP_JURISDICTION_ID`, `L2_URL`,
   `L2_BALLOT_TOKEN`. Rewrite `tools/deploy/` for the new contract.
3. Browser:
   - `public/vote.js` rollup branch: `GET /rollup/ballot-context`, `encryptBallot`, nullifier
     `Poseidon(nullifierSecret, l1ElectionId)` via `passkey-wallet.js`, `POST /vote` with a vote
     pass, then poll the receipt.
   - Results page reads `/rollup` (status, certified totals, Withheld).
   - Back office gets a Rollup panel: enroll guardians, publish, finalize key, close, finalize.
   - Still showing old chain fields: `admin.js` (addresses table), `back-office.js`
     (`createTxHash` / `onChainElectionAddress` after create), `outcomes.js` (factory, tx, election
     address), and other ElectionFactory/BallotInbox copy in `public/`.
4. UI/UX cleanup that was requested: CSS tokens and consolidation of `styles.css` (3.9k lines),
   the voter flow, the admin/back office, and the contract-facing pages (explorer shows rollup
   batches from L2 `/v1/batches`).
5. Docs: README, `voting_node/docs/*` (ARCHITECTURE, L2, OPERATOR, TALLY_GUARDIANS), root README.

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

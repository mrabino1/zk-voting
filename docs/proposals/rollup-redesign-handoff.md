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

## In progress (WIP commit, node tests failing)

Node integration in `voting_node/apps/node`:

- New code, done and passing in `test/rollup.test.mjs`, including the integration through node,
  operator and Anvil:
  - `src/rollup/client.mjs` and `src/rollup/service.mjs`
  - `src/routes/rollup.mjs`, mounted at `/api/elections/:id/rollup`
  - the rollup branch in `POST /:id/vote`
  - `scripts/rollup-guardian.mjs`
- The old chain is removed:
  - deleted: `src/chain.mjs`, `src/l1Certify.mjs`, `scripts/certify-l1.mjs`
  - stripped out: L2-open, dead-letter, L1-mirror and archive routes, and the chain paths in
    `relay.mjs`, health, outcomes and diagnostics
  - `electionIds.mjs` now has the id helpers inlined

**Next step:** `npm run test:node` fails 105 tests. Most of them are 500s on `POST /api/elections`.
That handler (in `src/routes/elections.mjs`) was rewritten as node-only, so run
`node --test test/api.test.mjs` and read the server stack. The likely cause is a leftover reference
in the create handler, such as `fingerprint`, `requestedOnChainId` or `store.createElection` params.
`store.createElection` still mints the public id from `onChainElectionId` and `factoryAddress`;
check `store.mjs` around line 1603. After that:

- Delete or rewrite these tests that target removed modules:
  - `chain-batch`, `elections-chain`, `inbox-abi-artifact`, `l1-certify`
  - the chain parts of `ballot-secrecy`, `election-type`, `ranked-sealed` and `revote-flag`
- Fix the remaining assertions: `/api/config` fields (`chain` became `rollup`), outcome checks
  (`l1*` became `rollupModeConsistent`), and API docs.

## Remaining phases

1. Finish the node cleanup above. Remove the old config keys (`CHAIN_RPC`, factory/inbox/mirror
   addresses) from `config.mjs`, `.env.example`, setup and docs.
2. Docker Compose: an `l1` service (Anvil, foundry image) and a one-shot `forge script DeployLocal`.
   The `l2` service becomes `node rollup/main.mjs`. Remove the `prover` service. Node env:
   `L1_RPC`, `ROLLUP_ADDRESS`, `ROLLUP_PRIVATE_KEY`, `ROLLUP_JURISDICTION_ID`, `L2_URL`,
   `L2_BALLOT_TOKEN`. Rewrite `tools/deploy/` for the new contract.
3. Browser:
   - `public/vote.js` rollup branch: `GET /rollup/ballot-context`, `encryptBallot`, nullifier
     `Poseidon(nullifierSecret, l1ElectionId)` via `passkey-wallet.js`, `POST /vote` with a vote
     pass, then poll the receipt.
   - Results page reads `/rollup` (status, certified totals, Withheld).
   - Back office gets a Rollup panel: enroll guardians, publish, finalize key, close, finalize.
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

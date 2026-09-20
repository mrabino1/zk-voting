# NOT FOR PROFIT

**Republic** Node — civic public good, not a commercial product.

This package is the DealPunchList-shaped long-lived Node process for **zk-voting**
(product name Republic): JSON HTTP API, WebAuthn passkeys, Web3 and smart-card
person identity, a gasless vote relayer, an L2 block-explorer backend, and a
static host for **vanilla JS** pages in `public/`. There is no Vite and no React.

There is no token. There is no paid tier. Do not commercialize this software.
See `/NOT_FOR_PROFIT.md` at the repo root.

---

## What it is

| DealPunchList-node | This process |
| --- | --- |
| Organizations | Jurisdictions |
| Rooms / processes | Elections (start + cutoff, roll, inbox) |
| Users + roles | `voter` / `observer` / `platform_admin` / `platform_super_admin` are global. Super admin approves admins; admins approve election staff. `clerk`, `registrar`, `disqualification_officer`, `tally_operator`, and `election_staff` are granted **per jurisdiction** (staff may also be granted per election). |
| Host menu | repo-root `system_actions.sh` |

Canonical election truth is the chain when `CHAIN_RPC` is set. Local JSON under
`apps/node/data/` is the demo / operator cache (gitignored). Native addons such
as `better-sqlite3` are **not** used.

Privacy: a vote is stored as `{ nullifier, ballotHash, electionId, relayer: "node", acceptedAt }`.
One ballot per nullifier: a later ciphertext for the same nullifier is rejected
(`NULLIFIER_USED`). Double voting is impossible. The Node never writes a
passkey user id onto the same record as an encrypted ballot or a choice. The UI
must not print “I voted for X” (receipts are hashes only). Voters may change
their mind on the ballot form before submit; after accept they cannot recast.
Public dashboards and the explorer show vote proofs only after the hour that
contained the vote has closed (`DISCLOSURE_INTERVAL_SECONDS`, default 3600; `0`
in tests). The explorer snapshot lists last closed hour, ballots disclosed so far,
and a countdown to the next hour close — never a pending-per-election count.
Independent auditors use `GET /api/elections/:id/artifacts` or `tools/auditor`
(see `/docs/AUDITOR.md`) — never `apps/node/data/`.

---

## Run

Node **22+**. From this directory:

```bash
npm install
npm start          # node src/server.mjs   (PORT=3000)
npm run dev        # node --watch src/server.mjs
npm test           # NODE_ENV=test node --test test/*.test.mjs
```

From the monorepo root:

```bash
npm start          # workspace start
npm run dev
npm test -w apps/node
./system_actions.sh health    # GET http://127.0.0.1:3000/health
./system_actions.sh status
./system_actions.sh restart   # pm2 / systemd / compose when configured
```

Docker Compose from the **repository root** (not this directory):

```bash
docker compose up -d --build
curl -fsS http://127.0.0.1:3000/health
```

`GET /health` returns `{ ok: true, app: "zk-voting", nfp: true, chainId }`.

The process serves `public/` (and `dist/` if someone drops files there). Unknown GET routes that are
not `/api/*` or `/health` fall back to `index.html` (or a “UI is loading” shell).
`GET /v/:shortCode` and `GET /e/:shortCode` 302 to `/vote/<uuid>` when the code
resolves.

New elections mint a UUID v4 canonical `id` plus a 10-character `shortCode`.
`GET /api/elections/:id` accepts UUID, short code, or `onChainElectionId`.
On-chain / circuit `electionId` stays the factory `uint256`, stored as
`onChainElectionId` on the Node record.

Voter client routes in `public/router.js`: `/`, `/register`, `/vote/:id`,
`/v/:shortCode`, `/e/:shortCode`, `/elections/:id/results`,
`/elections/:id/info`, `/elections/:id/info/:questionId/:optionId`.
Admin / back-office / explorer are separate HTML files.

### Ballot option information

Each question option may be a plain string, `{ id, label }`, or a supporting-info
object (`summary`, `body`, optional `imageUrl`, `links: [{ label, url }]`). Clerks
edit that as a punch-list on `/back-office` (JSON remains under Advanced). The Node
canonicalizes options and keccak-hashes `{ title, questions }` as `ballotSpecHash`.
Empty optional fields are omitted so older elections without metadata keep working.
`GET /api/elections/:id/info` returns the public copy (no `createdBy` / clerk notes).

Ranked-choice (`RANKED` / election `ballotMethod: ranked_choice`) is instant-runoff
on this Node. `POST /api/elections/:id/tally` with an empty body computes IRV from
accepted ranking envelopes and stores a winner plus round transcript. Mixed
ballots still post a plurality-only `counts` vector for L1 certification.

---

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP listen port |
| `HOST` | `0.0.0.0` | Listen address (`0.0.0.0` for Docker / Compose) |
| `CHAIN_ID` | `27427` | Republic L2 chain id (health + explorer) |
| `CHAIN_RPC` | _empty_ | If set, clerk `POST /api/elections` calls `ElectionFactory.createElection` and `POST /api/elections/:id/vote` calls `BallotInbox.submitVote` via viem. Unset = JSON-only demo. |
| `ELECTION_FACTORY_ADDRESS` | _empty_ | Required when `CHAIN_RPC` is set for create-election (`FACTORY` alias matches Foundry scripts). Also published on `GET /api/config` and auditor artifacts. |
| `VERIFIER_ADDRESS` | _empty_ | Groth16 / MockVerifier address (`VERIFIER` alias). Required for on-chain create |
| `BALLOT_INBOX_ADDRESS` | _empty_ | Required when `CHAIN_RPC` is set for vote relay |
| `RELAYER_PRIVATE_KEY` | _empty_ | Relayer key for factory create and on-chain submit |
| `L1_RPC` | _empty_ | Ethereum JSON-RPC for `L1TallyMirror.postResult`. Unset → tally still works (no-op certify) |
| `L1_TALLY_MIRROR_ADDRESS` | _empty_ | Required with `L1_RPC` and `L1_PUBLISHER_PRIVATE_KEY` to post |
| `L1_PUBLISHER_PRIVATE_KEY` | _empty_ | Mirror admin or `setPublisher` key. Not the L2 prover `PRIVATE_KEY`. Never a mainnet key in CI |
| `L1_SETTLEMENT_ADDRESS` | _empty_ | Optional `RollupSettlement` to attach `stateRoot()` |
| `L1_CHAIN_ID` | RPC | Optional override |
| `RP_ID` | `localhost` | WebAuthn rpID |
| `WEBAUTHN_ORIGINS` | localhost:PORT and :5173 | Comma-separated expected origins. `:5173` is a leftover default (no Vite server in this tree). |
| `ADMIN_HANDLE` | `admin` | Seeded `platform_admin` on first boot |
| `DATA_DIR` | `apps/node/data` | JSON store + `l2-chain.json` |
| `L2_CHAIN_FILE` | `$DATA_DIR/l2-chain.json` | Shared with the sequencer when it writes the same file |
| `ALLOW_DEV_LOGIN` | off (`1` in tests) | `POST /api/auth/dev-login` for local/dev only |
| `ALLOW_SMART_CARD_MOCK` | off (`1` in tests) | Self-service smart-card `{ mock: true }` (kiosk demo). Production uses registrar attest |
| `NODE_ENV` | _unset_ | `test` enables dev login, smart-card mock, and sets disclosure interval to 0 |
| `DISCLOSURE_INTERVAL_SECONDS` | `3600` (`0` when `NODE_ENV=test`) | Public vote proofs and turnout wait until this interval’s bucket closes |
| `REPUBLIC_PROVING_PATH` | off | `1` marks the Node as non-mock proving-path (`GET /api/config` `proving.provingPath`) |
| `REPUBLIC_HASH_SCHEME` | `keccak-dev-v1` | HashLeftRight version advertised in config; see `/circuits/HASH_SCHEME.md` |

Passkey rpName is always **Republic**.

Sign-in UX: `/`, `/admin`, and `/back-office` share **Sign in with passkey** and **Sign in with Ethereum**. Register a person first (`/register`). Dev login is hidden unless `auth.allowDevLogin` is true on `GET /api/config`.

---

## HTTP

```
GET  /health
GET  /v/:shortCode                  (302 → /vote/<uuid>)
GET  /e/:shortCode                  (302 → /vote/<uuid>)
GET  /api/elections
POST /api/elections                 (clerk of that jurisdiction / platform_admin)
PATCH /api/elections/:id            (clerk of that jurisdiction; ballot metadata until roll freeze)
GET  /api/elections/:id             (UUID, shortCode, or onChainElectionId)
GET  /api/elections/:id/results     (public certified plurality/IRV; empty before tally)
GET  /api/elections/:id/summary     (public: last closed hour, disclosed turnout, countdown)
GET  /api/elections/:id/ballots
GET  /api/elections/:id/info        (public option metadata; no clerk-only fields)
GET  /api/elections/:id/info/:questionId/:optionId
POST /api/elections/:id/register    (after passkey; registrar of that jurisdiction may register another person)
POST /api/elections/:id/vote        (relays proof; no passkey identity on the ballot; live external-party gate)
POST /api/elections/:id/disqualify  (disqualification officer of that jurisdiction)
POST /api/elections/:id/tally       (tally operator of that jurisdiction; plurality/IRV and/or opens_ballots; attempts L1 certify if env set)
GET  /api/elections/:id/tally-key   (public ceremony view; no private key)
POST /api/elections/:id/certify-l1  (tally operator of that jurisdiction; retry L1 postResult; no-op if env unset)
GET  /api/elections/:id/l1
GET  /api/elections/:id/artifacts   (public auditor pack; no private DB)
GET  /api/elections/:id/staff
POST /api/elections/:id/staff        (platform operator; approve election staff)
DELETE /api/elections/:id/staff
GET  /api/elections/:id/parties
POST /api/elections/:id/parties      (election staff; unbounded external gates)
PATCH /api/elections/:id/parties/:partyId
POST /api/elections/:id/parties/:partyId/reject
POST /api/elections/:id/parties/:partyId/attest
POST /api/admin/admins               (platform_super_admin)
DELETE /api/admin/admins
POST /api/jurisdictions/:id/roles   (platform_admin; grant clerk/registrar/dq/tally/election_staff on that jurisdiction)
DELETE /api/jurisdictions/:id/roles (platform_admin; revoke a scoped officer grant)
GET  /api/me
GET  /api/me/identity
GET  /api/identity/methods
POST /api/identity/web3/challenge
POST /api/identity/web3/verify
POST /api/identity/smart-card/challenge
POST /api/identity/smart-card/verify
POST /api/me/eth-accounts
POST /api/me/eth-accounts/active
POST /api/persons/:id/person-key     (registrar / platform_admin)
POST /api/persons/:id/methods
POST /api/persons/:id/eth-accounts
POST /api/persons/:id/eth-accounts/active
POST /api/auth/passkey/register/begin
POST /api/auth/passkey/register/finish
POST /api/auth/passkey/login/begin
POST /api/auth/passkey/login/finish
POST /api/auth/web3/challenge
POST /api/auth/web3/login
POST /api/auth/logout
POST /api/auth/dev-login            (ALLOW_DEV_LOGIN / tests only)
GET  /api/explorer/blocks
GET  /api/explorer/blocks/:n
GET  /api/explorer/txs/:hash
GET  /api/explorer/disclosure         (last closed hour, disclosed ballots, countdown)
POST /api/explorer/ingest
GET  /api/config
```

Also: freeze roll, envelopes (tally operator; ciphertext only), jurisdictions,
reason codes, CORS open for local tools.

Without `CHAIN_RPC`, creating an election writes the local JSON store (UUID public id + minted short code + a demo `onChainElectionId` for the circuit). Votes that pass the election window, nullifier check, **Node eligibility** (`identityCommitment` is registered and not currently disqualified), **and live external-party clearance** are accepted in that store so the explorer and SPA can run a demo. Those accepts still wait for hourly public disclosure unless the interval is `0`. External-party vetoes are public immediately. Disqualify/revoke rebuild `eligibleRoot` as registered ∩ ¬currently-disqualified. Freeze snapshots the roots used for the open window. The circuit may still not prove non-disqualification; Node enforcement is the product control on this path.

When `CHAIN_RPC` is set, `POST /api/elections` must also succeed on
`ElectionFactory` (same params as `smart-contracts/script/CreateElection.s.sol`).
The Node keeps a UUID public id and stores `onChainElectionId` /
`onChainElectionAddress` / `createTxHash` on the election record. A factory
revert returns **502/503** to the clerk and does **not** write `republic.json`.

Without `L1_RPC` + `L1_TALLY_MIRROR_ADDRESS` + `L1_PUBLISHER_PRIVATE_KEY`,
`POST /tally` still records counts. `l1Certification.status` is `skipped`.
Operator details: [`docs/OPERATOR.md`](../../docs/OPERATOR.md). `npm run certify:l1`
from the repo root is the same no-op unless those vars are set.

---

## Ops (DealPunchList / system_actions)

Development happens on `test/unstable`. `master` is production only.

```bash
./system_actions.sh              # interactive menu
./system_actions.sh help
./system_actions.sh status
./system_actions.sh deploy-dev   # pull test/unstable, install, build, restart
./system_actions.sh deploy-prod  # pull master (confirms)
./system_actions.sh restart
./system_actions.sh logs
./system_actions.sh health
```

Health URL: `http://127.0.0.1:${ZK_VOTING_PORT:-3000}/health`
(override with `ZK_VOTING_HEALTH_URL`).

Register the process with pm2 (`ZK_VOTING_PM2_NAME`, default `zk-voting`), a
systemd unit of the same name, or Docker Compose; `restart` targets the first
one it finds.

---

## Data

```
apps/node/data/republic.json    users, elections, votes, envelopes (gitignored)
apps/node/data/l2-chain.json    append-only blocks/txs for /explorer
```

Do not put legal names, DOB, or street addresses on chain. Do not emit a selected
option in an explorer payload. AGPL-3.0-or-later.

# NOT FOR PROFIT

**Republic** Node — civic public good, not a commercial product.

This package is the DealPunchList-shaped long-lived Node process for **zk-voting**
(product name Republic): JSON HTTP API, WebAuthn passkeys, email / Web3 /
smart-card / license-passport person identity with AWS SES email MFA, a gasless
vote relayer, an L2 block-explorer backend, and a
static host for **vanilla JS** pages in `public/`. There is no Vite and no React.

There is no token. There is no paid tier. Do not commercialize this software.
See `/NOT_FOR_PROFIT.md` at the repo root.

---

## What it is

| DealPunchList-node | This process |
| --- | --- |
| Organizations | Jurisdictions |
| Rooms / processes | Elections (start + cutoff, roll, inbox) |
| Users + roles | `voter` / `observer` / `platform_admin` are global. `clerk`, `registrar`, `disqualification_officer`, and `tally_operator` are granted **per jurisdiction**. `platform_admin` is a global override. |
| Host menu | repo-root `system_actions.sh` |

Canonical election truth is the chain when `CHAIN_RPC` is set. Local JSON under
`apps/node/data/` is the demo / operator cache (gitignored). Native addons such
as `better-sqlite3` are **not** used.

Privacy: a vote is stored as `{ nullifier, ballotHash, electionId, relayer: "node", acceptedAt }`.
One ballot per nullifier: a later ciphertext for the same nullifier is rejected
(`NULLIFIER_USED`). Double voting is impossible. The Node never writes a
passkey user id onto the same record as an encrypted ballot or a choice. The UI
must not print “I voted for X” (receipts are hashes only). After accept, voters
may email a PDF of that receipt and paste the proof at `/receipt` to confirm it
counted. The PDF is encrypted and locked against modification; drop it on that
portal to confirm the bytes still match. Turnout there is hourly (when and how many), never by candidate. Voters
may change their mind on the ballot form before submit; after accept they cannot recast.
Public dashboards and the explorer show vote proofs only after the hour that
contained the vote has closed (`DISCLOSURE_INTERVAL_SECONDS`, default 3600; `0`
in tests). The explorer snapshot lists last closed hour, ballots disclosed so far,
and a countdown to the next hour close — never a pending-per-election count.
Independent auditors use `GET /api/elections/:id/artifacts` or `tools/auditor`
(see `/docs/AUDITOR.md`) — never `apps/node/data/`. A public `/outcomes` portal
runs those same checks for every election, grouped before / during / after voting
from chain status. During the open window it still does not invent unofficial
option counts. After voting time expires and a tally is posted, subscribers
receive a locked official outcome PDF (counts, start, end); `/outcomes/verify`
checks the file was not changed. Voters are subscribed by default when they
vote.

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

New elections mint a UUID v5 canonical `id` (bound to factory, on-chain id, and
jurisdiction) plus a 10-character `shortCode`.
`GET /api/elections/:id` accepts UUID, short code, or `onChainElectionId`.
On-chain / circuit `electionId` stays the factory `uint256`, stored as
`onChainElectionId` on the Node record. L1 proof slots use
`(factory, onChainElectionId, jurisdictionId)`, not the public UUID.

Voter client routes in `public/router.js`: `/`, `/about`, `/faq`, `/terms`, `/receipt`, `/outcomes`, `/outcomes/verify`, `/outcomes/:id`, `/p/:slug`, `/register`, `/vote/:id`,
`/v/:shortCode`, `/e/:shortCode`, `/elections/:id/results`,
`/elections/:id/info`, `/elections/:id/info/:questionId/:optionId`.
Public URLs are `/admin`, `/back-office`, `/explorer` (not `*.html`). The host edits About / FAQ / home at `/office/pages`. Clerks publish jurisdiction-tagged pages.

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

Forked jurisdiction Nodes copy the repo-root [`.env.example`](../../.env.example) to `.env` and **pin the one shared factory**. Env wins over `/office/site`. Do not deploy a new `ElectionFactory` per city. Root README: [Intentional forking](../../README.md#intentional-forking).

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP listen port |
| `HOST` | `0.0.0.0` | Listen address (`0.0.0.0` for Docker / Compose) |
| `CHAIN_ID` | `27427` | Republic L2 chain id (health + explorer) |
| `CHAIN_RPC` | _empty_ | If set, clerk `POST /api/elections` calls `ElectionFactory.createElection` and `POST /api/elections/:id/vote` calls `BallotInbox.submitVote` via viem. Unset = JSON-only demo. |
| `ELECTION_FACTORY_ADDRESS` | _empty_ | Shared factory for every forked Node (`FACTORY` alias). Env wins over `/office/site`. Required when `CHAIN_RPC` is set unless the site pin is set. |
| `VERIFIER_ADDRESS` | _empty_ | Groth16 / MockVerifier address (`VERIFIER` alias). Required for on-chain create |
| `BALLOT_INBOX_ADDRESS` | _empty_ | Required when `CHAIN_RPC` is set for vote relay |
| `RELAYER_PRIVATE_KEY` | _empty_ | Relayer key for factory create and on-chain submit |
| `L1_RPC` | _empty_ | Ethereum JSON-RPC for `L1TallyMirror.postCertifiedResult`. Unset → tally still works (no-op certify) |
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
| `ALLOW_CIVIC_ID_MOCK` | off (`1` in tests) | Self-service driver’s license / passport bind `{ mock: true }` |
| `SES_FROM_ADDRESS` | _empty_ | AWS SES From address. With `AWS_REGION`, turns on email MFA for every non-dev login **and** emails the Terms PDF on accept |
| `AWS_REGION` | _empty_ | SES region (also `SES_REGION`) |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | host IAM role | Optional static SES credentials. Leave empty to use the default AWS credential chain |
| `SES_CONFIGURATION_SET` | _empty_ | Optional SESv2 configuration set |
| `SES_ENDPOINT` | AWS default | Optional SES endpoint override (local stack) |
| `REQUIRE_EMAIL_MFA` | off in tests; on when SES is configured | Force or disable email OTP MFA |
| `CREDENTIAL_PROVIDER_SECRET` | _empty_ | Shared secret for `POST /api/integrations/credentials/status`. Unset = manual officer review |
| `CREDENTIAL_PROVIDER_ID` | `manual` | Label stored on credential methods until a DMV / eID connector exists |
| `RECEIPT_PDF_SECRET` | `$DATA_DIR/receipt-pdf.secret` | HMAC + PDF owner password for locked vote-receipt **and** official outcome PDFs. Unset → Node mints a file |
| `PUBLIC_BASE_URL` | first WebAuthn origin | Origin printed in official-outcome QR codes (`/o/<reportId>`) |
| `NODE_ENV` | _unset_ | `test` enables dev login, smart-card mock, and sets disclosure interval to 0 |
| `DISCLOSURE_INTERVAL_SECONDS` | `3600` (`0` when `NODE_ENV=test`) | Public vote proofs and turnout wait until this interval’s bucket closes |
| `REPUBLIC_PROVING_PATH` | off | `1` marks the Node as non-mock proving-path (`GET /api/config` `proving.provingPath`) |
| `REPUBLIC_HASH_SCHEME` | `keccak-dev-v1` (Poseidon if `REPUBLIC_PROVING_PATH=1`) | HashLeftRight advertised in config. The vote circuit is Poseidon. See `/circuits/HASH_SCHEME.md` |

Passkey rpName is always **Republic**.

Sign-in UX: `/`, `/admin`, and `/back-office` share **email**, **Ethereum**, **smart-card reader**, **license/passport**, and passkey. A person may bind **up to 5 emails** (exactly one primary) and **up to 5 passkeys**. Register a person first (`/register`). Manage them on `/me`. Every path completes with an email one-time code when SES MFA is on (primary inbox by default). Caps are code constants — no extra env vars. Dev login is hidden unless `auth.allowDevLogin` is true on `GET /api/config`.

---

## HTTP

```
GET  /health
GET  /terms                         (SPA Terms of Use; hashes from GET /api/terms)
GET  /terms.pdf                     (deterministic PDF; X-Pdf-SHA256 header)
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
POST /api/elections/:id/register    (voter: pending civil review; officer of that jurisdiction: insert now)
GET  /api/elections/:id/registration-requests
POST /api/elections/:id/registration-requests/:requestId/approve
POST /api/elections/:id/registration-requests/:requestId/deny
POST /api/elections/:id/vote        (relays proof; signed-in ballots need a vote PIN token)
POST /api/elections/:id/disqualify  (disqualification officer of that jurisdiction)
POST /api/elections/:id/tally       (tally operator of that jurisdiction; plurality/IRV and/or opens_ballots; attempts L1 certify if env set)
GET  /api/elections/:id/tally-key   (public ceremony view; no private key)
POST /api/elections/:id/certify-l1  (tally operator of that jurisdiction; retry L1 identity post; no-op if env unset)
GET  /api/elections/:id/l1
GET  /api/elections/:id/artifacts   (public auditor pack; no private DB)
POST /api/jurisdictions/:id/roles   (platform_admin; grant clerk/registrar/dq/tally on that jurisdiction)
DELETE /api/jurisdictions/:id/roles (platform_admin; revoke a scoped officer grant)
GET  /api/me
GET  /api/me/identity
GET  /api/me/emails
POST /api/me/emails/primary
DELETE /api/me/emails/:id
GET  /api/me/passkeys
DELETE /api/me/passkeys/:credentialId
GET  /api/identity/methods
POST /api/identity/email/start
POST /api/identity/web3/challenge
POST /api/identity/web3/verify
POST /api/identity/smart-card/challenge
POST /api/identity/smart-card/verify
POST /api/identity/civic-id/verify
POST /api/me/eth-accounts
POST /api/me/eth-accounts/active
GET  /api/me/credentials
GET  /api/office/credentials
POST /api/me/pin/keypad
POST /api/me/pin
POST /api/me/pin/verify
POST /api/me/pin/forgot
POST /api/pin/forgot
POST /api/persons/:id/methods/:methodId/review
POST /api/persons/:id/methods/:methodId/revoke
POST /api/integrations/credentials/status
POST /api/persons/:id/person-key     (registrar / platform_admin)
POST /api/persons/:id/methods
POST /api/persons/:id/eth-accounts
POST /api/persons/:id/eth-accounts/active
POST /api/auth/email/start
POST /api/auth/passkey/register/begin
POST /api/auth/passkey/register/finish
POST /api/auth/passkey/login/begin
POST /api/auth/passkey/login/finish
POST /api/auth/web3/challenge
POST /api/auth/web3/login
POST /api/auth/smart-card/challenge
POST /api/auth/smart-card/login
POST /api/auth/civic-id/login
POST /api/auth/mfa/email
POST /api/auth/mfa/resend
POST /api/auth/mfa/verify
GET  /api/auth/mfa/status
POST /api/auth/logout
POST /api/auth/dev-login            (ALLOW_DEV_LOGIN / tests only)
GET  /api/explorer/blocks
GET  /api/explorer/blocks/:n
GET  /api/explorer/txs/:hash
GET  /api/explorer/disclosure         (last closed hour, disclosed ballots, countdown)
POST /api/explorer/ingest
GET  /api/config
GET  /api/terms                     (public: pdfSha256, markdownSha256, hashOf=pdf-bytes)
GET  /api/terms.pdf
POST /api/terms/view                (signed-in: one view record per session+hash)
POST /api/terms/accept              (signed-in; `{ acceptedTerms: true }`; emails PDF via SES)
GET  /api/receipts/metrics          (disclosed turnout hours; never by candidate)
POST /api/receipts/verify           (paste proof and/or drop PDF; pdfUnmodified)
POST /api/receipts/email            (holder token; SES body + locked PDF)
POST /api/receipts/pdf              (holder token; encrypted PDF, X-Pdf-Protected: true)
GET  /api/outcomes                  (public monitor: every election before/during/after)
GET  /api/outcomes/:id              (auditor + chain verification; certified counts only after tally)
GET  /api/outcomes/reports
GET  /api/outcomes/reports/:id
GET  /api/outcomes/reports/:id/pdf
POST /api/outcomes/verify           (drop official PDF or report id; pdfUnmodified)
GET  /api/me/outcome-subscriptions
PUT  /api/me/outcome-subscriptions/:electionId
POST /api/me/outcome-subscriptions
GET  /api/admin/outcome-report-template
PATCH /api/admin/outcome-report-template
POST /api/admin/outcome-report-template/preview
```

Terms fingerprint: **SHA-256 of the exact PDF bytes** generated from `legal/terms.md` (64 hex, stored as `user.termsHash`). Markdown SHA-256 is published next to it. New-person register requires `acceptedTerms: true`. Acceptances live in `republic.json` → `termsAcceptances[]` (who, when, version, both hashes, whether the PDF was emailed). The same SES From address as MFA sends the PDF as a raw MIME attachment (`SESv2` Simple cannot attach). Without `SES_FROM_ADDRESS` + `AWS_REGION`, tests and local demos **capture** the message in-process (same as MFA).

Also: freeze roll, envelopes (tally operator; ciphertext only), jurisdictions,
reason codes, CORS open for local tools.

Without `CHAIN_RPC`, creating an election writes the local JSON store (UUID public id + minted short code + a demo `onChainElectionId` for the circuit). Votes that pass the election window, nullifier check, and bound open-window roots are accepted in that store so the explorer and SPA can run a demo. The vote POST does not carry `identityCommitment`. Those accepts still wait for hourly public disclosure unless the interval is `0`. Disqualify/revoke rebuild `eligibleRoot` as registered ∩ ¬currently-disqualified, matching the on-chain eligible root. Freeze snapshots the roots used for the open window. The circuit proves membership in that root and only binds the disqualification log; an unarmed MockVerifier still does not check the witness.

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
./system_actions.sh 1            # pull + npm run dev
./system_actions.sh 2 my-feature # feature/* from test/unstable
./system_actions.sh 3            # merge feature/* into test/unstable
./system_actions.sh 4            # merge test/unstable → master (type MERGE)
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
apps/node/data/republic.json    users, elections, votes, envelopes, termsAcceptances (gitignored)
apps/node/data/l2-chain.json    append-only blocks/txs for /explorer
apps/node/legal/terms.md        canonical Terms of Use (PDF + hashes derived at boot)
```

Do not put legal names, DOB, or street addresses on chain. Do not emit a selected
option in an explorer payload. AGPL-3.0-or-later.

# NOT FOR PROFIT

**ZK-Voting** Node — civic public good, not a commercial product.

This package is the long-lived Node process for **ZK-Voting**
(product name ZK-Voting by default): JSON HTTP API, WebAuthn passkeys, email / Web3 /
smart-card / license-passport person identity with AWS SES email MFA, the
rollup client for civic votes (`src/rollup/`), the poll engine, an explorer, and
a static host for **vanilla JS** pages in `public/`. There is no Vite and no React.

There is no token. There is no paid tier. Do not commercialize this software.
See `/NOT_FOR_PROFIT.md` at the repo root.

---

## What it is

| Piece | What this process holds |
| --- | --- |
| Jurisdictions | The body that owns a roll and its elections |
| Elections | Start, cutoff, roll, and inbox |
| Users + roles | `voter` / `observer` / `platform_admin` / `platform_super_admin` are global. `clerk`, `registrar`, `disqualification_officer`, `tally_operator`, and `election_staff` are granted **per jurisdiction**. `platform_super_admin` and `platform_admin` are global overrides. The seeded host is `platform_super_admin`. |
| Host menu | repo-root `system_actions.sh` |

A **civic vote**'s truth is ZkVotingRollup on L1: the Node publishes it, syncs
its roll, relays guardian messages and ballots to the L2 operator, and keeps only
a receipt per ballot (never the ciphertexts). A **poll**'s truth is this Node.
State lives in Postgres (`DATABASE_URL`) or JSON under `DATA_DIR`.

Privacy (polls): a poll ballot is stored as `{ nullifier, ballotHash, electionId, relayer: "node", acceptedAt }`.
One ballot per nullifier. A second ballot is rejected unless re-vote is enabled.
When it is on, the replacement is counted only in the final tally, a published
poll block keeps the original ballot, and `acceptedBallots` does not increase.
Double voting is impossible. The Node never writes a
passkey user id onto the same record as an encrypted ballot or a choice. The UI
must not print “I voted for X” (receipts are hashes only). After accept, voters
may email a PDF of that receipt and paste the proof at `/receipt` to confirm it
counted. The PDF is encrypted and locked against modification; drop it on that
portal to confirm the bytes still match. Turnout there is hourly (when and how many), never by candidate. A poll
may show hourly choice sums after the results gate; a vote does not show choice
counts before the deadline. Turnout for a vote is visible. The inbox still accepts a nullifier once,
so a replacement is not submitted again.
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
checks the file was not changed. Subscribing is opt-in on `/me`; casting a
ballot never subscribes anyone.

---

## Run

Node **24.7+**. From this directory:

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

Docker Compose from `voting_node/` (not this directory):

```bash
docker compose up -d --build
curl -fsS http://127.0.0.1:3000/health
```

`GET /health` returns `{ ok: true, app, nfp: true, chainId, mode }` (`mode` is `active` or `standby`).

The process serves `public/` (and `dist/` if someone drops files there). Unknown GET routes that are
not `/api/*` or `/health` fall back to `index.html` (or a “UI is loading” shell).
`GET /v/:shortCode` and `GET /e/:shortCode` 302 to `/vote/<uuid>` when the code
resolves.

New elections get a UUID `id` plus a 10-character `shortCode`.
`GET /api/elections/:id` accepts UUID, short code, or `localElectionId` (the
Node's numeric sequence, used as the poll proof's electionId). A civic vote also
carries `rollupElectionId`, its id on L1, once published.

Voter client routes in `public/router.js`: `/`, `/about`, `/faq`, `/terms`, `/feedback`, `/receipt`, `/outcomes`, `/outcomes/verify`, `/outcomes/:id`, `/p/:slug`, `/register`, `/vote/:id`,
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
accepted ranking envelopes and stores a winner plus round transcript. Polls only; a civic vote is one question with one choice.

---

## Environment

Every variable, including the rollup ones (`L1_RPC`, `ROLLUP_ADDRESS`,
`ROLLUP_DEPLOYMENT_FILE`, `ROLLUP_JURISDICTION_ID`, `ROLLUP_PRIVATE_KEY`,
`ROLLUP_TICK_SECONDS`, `L2_URL`, `L2_BALLOT_TOKEN`), is described in the
[configuration reference](../../docs/self-hosting/configuration.md). Forks: see
[Forking and staying current](../../docs/self-hosting/forking.md). The table below
covers what matters when running this package directly.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP listen port |
| `HOST` | `0.0.0.0` | Listen address (`0.0.0.0` for Docker / Compose) |
| `CHAIN_ID` | `27427` | The node's own chain id (poll signatures, wallets) |
| `L1_RPC`, `ROLLUP_ADDRESS` | _empty_ | Connect civic votes to ZkVotingRollup. Unset = civic votes stay drafts (`VOTE_NOT_ON_L1`); polls still work. |
| `L1_RPC_AUTH_TOKEN` | _empty_ | Optional bearer token for an L1 RPC that requires auth. Empty sends no Authorization header. |
| `VOTE_FQDN` | _empty_ | Public voting hostname this jurisdiction creates, e.g. `vote.domain.tld`. Bare FQDN (no scheme, port, or path). It is the voting authority: when set, `RP_ID` becomes this host unless `RP_ID` is already a different public hostname, `https://<VOTE_FQDN>` is always an accepted origin, and `PUBLIC_BASE_URL` defaults to that `https://` origin. Empty = local demo. |
| `RP_ID` | `localhost`, or `VOTE_FQDN` when that is set | WebAuthn rpID. `localhost` does not override `VOTE_FQDN`. |
| `WEBAUTHN_ORIGINS` | localhost:PORT and :5173 | Comma-separated expected origins. `:5173` is a leftover default (no Vite server in this tree). `https://$VOTE_FQDN` is prepended when `VOTE_FQDN` is set. |
| `CORS_ALLOWED_ORIGINS` | empty | Comma-separated extra origins allowed to make **credentialed** cross-origin requests. `WEBAUTHN_ORIGINS` and `PUBLIC_BASE_URL` are always trusted. Other origins still get CORS for public reads, without cookies. |
| `ADMIN_HANDLE` | `admin` | Seeded `platform_super_admin` when the store has none. Does not create a second super admin |
| `SUPER_ADMIN_EMAIL` | _empty_ | Contact email for that person. Empty leaves `contactEmail` as stored. Invalid refuses to start. Read at process start (not a build arg). The active writer applies it on every boot; standby does not write |
| `DATABASE_URL` | _empty_ | Postgres. Empty = JSON store under `DATA_DIR` |
| `DATA_DIR` | `apps/node/data` | JSON store, ceremony files, plugin uploads, writer lease |
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
| `PUBLIC_BASE_URL` | `https://$VOTE_FQDN` when that is set, else first WebAuthn origin | Origin printed in official-outcome QR codes (`/o/<reportId>`) |
| `NODE_ENV` | _unset_ | `test` enables dev login, smart-card mock, and sets disclosure interval to 0 |
| `DISCLOSURE_INTERVAL_SECONDS` | `3600` (`0` when `NODE_ENV=test`) | Public vote proofs and turnout wait until this interval’s bucket closes |
| `ZK_VOTING_PROVING_PATH` | off | `1` marks the Node as non-mock proving-path (`GET /api/config` `proving.provingPath`) |
| `ZK_VOTING_HASH_SCHEME` | `keccak-dev-v1` (Poseidon if `ZK_VOTING_PROVING_PATH=1`) | HashLeftRight advertised in config. The vote circuit is Poseidon. See `/circuits/HASH_SCHEME.md` |

Passkey rpName is the current product name (site admin > Branding, else `BRAND_NAME`, else **ZK-Voting**).

When `VOTE_FQDN` is set, the pages are the client's site. `CLIENT_BRAND_NAME`, `CLIENT_LOGO_URL`, `CLIENT_BRAND_URL`, and `CLIENT_BRAND_SUBTITLE` replace the header mark and the "Office of civic elections" line. The civic ribbon and the ZK-Voting footer are removed; the footer is a "powered by zk-voting.org" link. Those four variables are ignored when `VOTE_FQDN` is empty, so the demo keeps the built-in branding. `CLIENT_BRAND_NAME` also wins over Site admin for the display name on that host. Logo and link are a site path or an https URL.

Sign-in UX: `/`, `/admin`, and `/back-office` share **email**, **Ethereum**, **smart-card reader**, **license/passport**, and passkey. A person may bind **up to 5 emails** (exactly one primary) and **up to 5 passkeys**. Register a person first (`/register`). Manage them on `/me`. Every path completes with an email one-time code when SES MFA is on (primary inbox by default). Caps are code constants — no extra env vars. Dev login is hidden unless `auth.allowDevLogin` is true on `GET /api/config`.

---

## HTTP

The public API is documented at `/api` on every Node (HTML, `/api/openapi.json`,
`/api/llms.txt`), generated from `src/botApiCatalog.mjs`; the same text is in
[`docs/BOT_API.md`](../../docs/BOT_API.md).

Civic-vote routes, under `/api/elections/:id/rollup`:

```
GET  /                         status on L1 and the Node's view (public)
GET  /ballot-context           L1 election id, chain, rollup address, joint key, options (public)
GET  /receipts/:nullifier      pending → committed → executed (public)
POST /prepare                  clerk: k and minBallots
POST /guardians                clerk: enroll a guardian identity key
POST /publish                  clerk: createElection on L1
POST /guardians/:index/commit  relay a guardian's signed Feldman commitment
POST /mailbox, GET /mailbox/:index    encrypted guardian shares
POST /disputes/:action         key-ceremony complaints and reveals
POST /finalize-key             fix the joint key on L1
POST /roll/sync                send roll changes through the priority queue
POST /close                    after the cutoff
POST /guardians/:index/shares  relay a guardian's decryption shares
POST /finalize                 finalizeResult on L1
```

A civic ballot is `POST /api/elections/:id/vote` with a vote pass and no cookies;
the pass comes from `POST /api/elections/:id/vote-pass` (signed in, on the roll,
PIN, one per voter, recorded in the poll book).

Terms fingerprint: **SHA-256 of the exact PDF bytes** generated from `legal/terms.md`. New-person register requires `acceptedTerms: true`. With `SES_FROM_ADDRESS` + `AWS_REGION` the Terms PDF is mailed on accept; without them, tests and local demos capture the message in-process.

---

## Ops (`system_actions`)

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
apps/node/data/zk-voting.json    the store when DATABASE_URL is empty (gitignored)
apps/node/legal/terms.md        canonical Terms of Use (PDF + hashes derived at boot)
```

Do not put legal names, DOB, or street addresses on chain. Do not emit a selected
option in an explorer payload. AGPL-3.0-or-later.

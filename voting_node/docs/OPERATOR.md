# Operator guide

**NOT FOR PROFIT** — civic public good. Not a commercial product. See [`/NOT_FOR_PROFIT.md`](../NOT_FOR_PROFIT.md).

How to host ZK-Voting: the Node, the L2 rollup operator, ZkVotingRollup on L1, and the split between **`test/unstable`** and **`master`**. Install guides: [`self-hosting/`](./self-hosting/README.md).

This software may be run **at cost** by a government, county clerk, union, cooperative, or volunteer. It must not be sold as SaaS, wrapped in a token, or used to skim voter or jurisdiction funds. Voters never pay. Cost ranges: [`voting_cost_estimate.md`](./voting_cost_estimate.md).

---

## What you are operating

1. **`apps/node`** — the Node: voter, clerk and observer pages (vanilla JS in `public/`), the HTTP API, the poll engine, and the rollup client that publishes civic votes and relays their ballots. State in Postgres (or JSON without `DATABASE_URL`).
2. **`l2/rollup`** — the L2 operator: takes ballots from the Node, follows the L1 priority queue, commits and executes batches.
3. **`../smart-contracts/`** — `ZkVotingRollup`, the one L1 contract for every jurisdiction ([design](../../smart-contracts/docs/ROLLUP.md)).
4. **`circuits/`** — Circom circuits for the poll path, with untrusted local keys.

A civic vote's record is on L1. If the Node is down, the result on L1 still stands and anyone can close and finalize it there.

---

## Branch policy (non-negotiable)

| Line | Branch | Meaning |
| --- | --- | --- |
| Development / staging | `test/unstable` | Default. Local chain (Anvil 31337) with `MockBatchVerifier`, the operator on `:8546`. |
| Production | `master` | Only builds a jurisdiction may treat as binding. |

`system_actions.sh deploy-dev` pulls **`test/unstable`**. `deploy-prod` pulls **`master`** and **asks for confirmation** (unless you pass `--yes`, which you should not wire to an unattended cron for a live election).

Never point a production jurisdiction at a test deployment of the rollup.

---

## `system_actions.sh`

From the repository root. Numbers **1–4** are the git flow: feature branches land on `test/unstable`, then promote to `master`.

```bash
./system_actions.sh              # interactive menu
./system_actions.sh help

# Git workflow
./system_actions.sh 1            # fetch + pull, npm install, npm run dev
./system_actions.sh 2 my-feature # create feature/my-feature from test/unstable
./system_actions.sh 3            # merge feature/* into test/unstable and push
./system_actions.sh 4            # merge test/unstable → master (type MERGE)

# Data / connectivity
./system_actions.sh 5            # store counts
./system_actions.sh 6            # Node / L2 / L1 reachability
./system_actions.sh 7            # local Node users (handle + role)

# Host / operator
./system_actions.sh status       # branch, SHA, dirty, pm2/systemd/compose
./system_actions.sh checkout-dev
./system_actions.sh checkout-prod
./system_actions.sh deploy-dev   # fetch, ff-only pull, npm install, build, restart
./system_actions.sh deploy-prod  # same on master; confirms
./system_actions.sh restart
./system_actions.sh logs
./system_actions.sh health       # GET $ZK_VOTING_HEALTH_URL (default :3000/health)
```

`4` only **merges and pushes git**. It does not install, build, or restart. After a release merge, run `deploy-prod` on the host that serves the jurisdiction.

Options 5–7 read the store, probe HTTP and RPC, and list local handles.

Environment overrides: `ZK_VOTING_DEV_BRANCH`, `ZK_VOTING_PROD_BRANCH`, `ZK_VOTING_APP_NAME`, `ZK_VOTING_PM2_NAME`, `ZK_VOTING_SYSTEMD_UNIT`, `ZK_VOTING_HEALTH_URL`, `ZK_VOTING_PORT`, `ZK_VOTING_LOG_LINES`, `ZK_VOTING_HOST`, `ZK_VOTING_L2_HEALTH_URL`.

## IS_DEMO

`IS_DEMO` marks the disposable public demo. **If the variable is not set, this install is not a demo.** Blank, `false`, `0`, and any unrecognised value are also not a demo (an unrecognised value is logged and treated as false). Only `true` or `1`, in any case, is a demo.

A real election clone must leave `IS_DEMO` unset or set it to `false`. `./setup.sh` does not write the variable. It rewrites an existing unrecognised value to `false`.

When `IS_DEMO=true`, the node schedules one monthly soft-delete. Even UTC months (January, March, …) soft-delete sessions and attributable poll ballots of logins already flagged by the abuse rule in `apps/node/src/demoPurge.mjs`. Odd UTC months (February, April, …) soft-delete user-data rows and keep the election shells, the super-admin account, and setup state. Rows stay in the store with `is_deleted=true`. No job is registered when `IS_DEMO` is not exactly that true value, and the job body checks again and does nothing.

Restart order: **pm2** → **systemd** unit → **docker compose**. If none are configured, `restart` warns and does not fail the machine. Install / build still run on deploy.

Deploy refuses a **dirty worktree**. Commit or stash first.

Root [`.dockerignore`](../.dockerignore) applies to every image built from this repo (Node, L2 operator). It keeps `.git`, `node_modules`, `.env` / keys, Foundry `out/` `cache/` `broadcast/`, `apps/node/data`, and Circom trusted-setup files (`.ptau`, `.zkey`) out of the build context. Mount voter data and proving keys as volumes; do not `COPY` them into the image.

---

## Docker Compose

[`docker-compose.yml`](../docker-compose.yml) runs the whole stack. Guide:
[Docker Compose quickstart](./self-hosting/docker-compose.md).

```bash
./setup.sh                    # or: cp .env.example .env
docker compose up -d --build  # or: npm run compose:up
curl -fsS http://127.0.0.1:3000/health
curl -fsS http://127.0.0.1:8546/health
./system_actions.sh health
```

| Service | Host port | Role |
| --- | --- | --- |
| `node` | `${ZK_VOTING_PORT:-3000}` | The Node |
| `l2` | `127.0.0.1:${L2_RPC_PORT:-8546}` | The rollup operator |
| `db` | none | Postgres |
| `l1` (profile `local-l1`) | `127.0.0.1:${L1_RPC_PORT:-8545}` | Anvil, chain 31337 |
| `l1-deploy` (profile `local-l1`) | none | One-shot: deploys ZkVotingRollup and writes `/deployments/local.json` |

Secrets stay in `.env` (gitignored). Host-specific mounts belong in `docker-compose.override.yml`
(start from [`docker-compose.override.example.yml`](../docker-compose.override.example.yml)).
Do not bake `ROLLUP_PRIVATE_KEY`, `OPERATOR_PRIVATE_KEY` or `L2_BALLOT_TOKEN` into an image.
`l1-deploy` compiles the contracts on a fresh deploy, so it needs network once to fetch solc.

### Coolify rolling update

Old and new **Node** containers overlap on one host and share `node-data`. The Node takes a file
lease before it writes. The new container starts **standby**: `/health` is HTTP 200 with
`"mode":"standby"`; it serves reads and answers writes with 503 `maintenance handover`
(`Retry-After: 2`). Do not require `mode=active` in a probe. On SIGTERM the old container
releases the lease within `stop_grace_period: 30s`; a crash is taken over after the lease TTL
(default 8s). Two hosts are not supported.

The L2 operator has **no** writer lease and is not overlapped: recreate its container. While it is
down the Node answers ballot requests with 503 and voters retry. Details:
[`ROLLING_UPDATES.md`](./ROLLING_UPDATES.md).

### Forked jurisdiction Nodes

Forking this Node is **intentional**. Run `./setup.sh`, set `VOTE_FQDN` (below) and SES, and on
a public chain point `ROLLUP_ADDRESS` and `ROLLUP_JURISDICTION_ID` at the **shared** deployment.
Do not deploy your own rollup. Guide: [Forking and staying current](./self-hosting/forking.md).

### Voting subdomain (`VOTE_FQDN`)

A jurisdiction that runs this repo publishes the Node on a **subdomain it controls**. That FQDN is the voting authority: voters open it, passkeys are bound to it, and official links use it.

```text
vote.domain.tld
```

`domain.tld` is the body’s domain. `vote` is the usual host label. Create a DNS `A`, `AAAA`, or `CNAME` for that name pointing at this host, and terminate TLS for it. This repo does not register the name. The Node itself keeps listening on `ZK_VOTING_PORT` (HTTP). Put Caddy, nginx, or the host load balancer in front.

```env
VOTE_FQDN=vote.domain.tld
```

Leave it empty for a local demo (`RP_ID` stays `localhost`).

| Derived setting | When `VOTE_FQDN` is set |
| --- | --- |
| `RP_ID` | Becomes the FQDN. The template value `localhost` does not override it. Set `RP_ID` to another public hostname only when the relying party must be a parent of the subdomain. |
| `WEBAUTHN_ORIGINS` | `https://<VOTE_FQDN>` is always accepted, including when the env list is still the localhost default. |
| `PUBLIC_BASE_URL` | Defaults to `https://<VOTE_FQDN>` when empty (official-outcome QR codes). |

Check it after the process is up:

```bash
curl -fsS http://127.0.0.1:3000/health
# "voteFqdn": "vote.domain.tld"
curl -fsS http://127.0.0.1:3000/api/config
# "vote": { "fqdn": "vote.domain.tld", "origin": "https://vote.domain.tld", ... }
```

The value is a bare hostname. `https://vote.domain.tld`, a port, or a path is rejected at startup.

`RP_ID`, when it is a public parent of the request host (the host equals it or ends with `.<RP_ID>`), stays the relying party for that host. Otherwise the request hostname is the RP ID, so a rotating test host does not share passkeys with the production name. `WEBAUTHN_HOST_SUFFIXES` is an optional comma-separated list of parent domains. A request is allowed when its host is `VOTE_FQDN`, its origin is already in `WEBAUTHN_ORIGINS`, `RP_ID` is a suffix of the host, or the host matches one of those suffixes. Any other `Host` keeps the configured RP ID and origins. The ceremony stores that RP ID and origin list and verifies the attestation against the stored values.

### First-run setup token

`/setup` always requires a setup token before it creates the super admin. The token is never included in an HTTP response.

- When `SETUP_TOKEN` is set, type that value on `/setup`. It stays valid until a super admin exists, so a failed attempt can be retried. `./setup.sh` can write it to `voting_node/.env`. The script does not print it.
- When `SETUP_TOKEN` is unset, the process mints a one-time token at boot and prints it only on the process log. Type that value on `/setup`. It is not written to `.env`. Restarting before the super admin is created replaces it. A successful claim invalidates it.

The seeded super admin handle cannot be claimed through `/register` while a setup token is in force, which is every boot. Dev sign-in is unchanged and stays off in production.

---

## First-time machine

```bash
# Node 24.7+
node -v

# Foundry 1.8+ (solc 0.8.24, via_ir on — foundry.toml)
foundryup
cd smart-contracts && forge test

# Optional: circom 2 + snarkjs for the proving path (not a ceremony)
npm run circuits:status
# npm run circuits:compile && npm run circuits:setup   # UNTRUSTED local ptau
# Optional: viem in the Node app for ABI encoding (packages/chain-client)

git checkout test/unstable
./system_actions.sh deploy-dev
```

Without Docker: `./scripts/start-anvil.sh --background` and `./scripts/deploy.sh --target local` give a local chain with ZkVotingRollup; `npm run l2:operator` runs the operator. See [`scripts/README.md`](../scripts/README.md).

---

## Running the pieces

### Foundry tests

```bash
cd smart-contracts
forge test
forge test --fuzz-runs 256
forge test --match-path test/invariant/*
```

From repo root: `npm run test:contracts`, `npm run test:fuzz`, `npm run test:invariant`, `npm run test:proof-helpers`.

Poll circuits (optional tools): `npm run circuits:status`. See [`circuits/HASH_SCHEME.md`](../circuits/HASH_SCHEME.md).

### Independent auditor (no Node private DB)

```bash
node tools/auditor/cli.mjs verify-rollup --rpc "$L1_RPC" --rollup "$ROLLUP_ADDRESS" --election 4
npm run test:auditor
```

`verify-rollup` checks a civic vote from L1 alone (ballots in pubdata, joint key, floor, the result
against every k-subset of guardian shares). Polls use `export-node` / `verify`. Docs:
[`AUDITOR.md`](./AUDITOR.md).

### Node

```bash
# workspaces
npm install
npm run dev          # node --watch apps/node (Express + public/)
npm run start        # production-style Node process
npm test -w apps/node
```

Expect `GET /health`. Public pages: `/`, `/vote/:id` (UUID or short code), `/v/:shortCode`, `/e/:shortCode`, `/register`, `/elections/:id/info`, `/elections/:id/results`, `/outcomes`, `/outcomes/:id`, `/outcomes/verify`, `/receipt`, `/feedback`, `/admin`, `/back-office`, `/explorer`. Vanilla JS, not Vite/React. Every page footer: **NOT FOR PROFIT**.

### Platform super admin

On an empty store the Node seeds one `platform_super_admin`. A later boot does not create a second one. Register that handle at `/register` so the person can sign in.

`SUPER_ADMIN_EMAIL` is read when the process starts. It is not a Docker build arg and it is not baked into the image. An empty value leaves `contactEmail` as it was set in the app. A non-empty value must be a valid email (the same check as sign-in). Anything else refuses to start. The active writer writes that address onto the existing super admin on every boot, so a new value rotates the inbox. A standby process does not write the store. When it takes the writer lease, it applies the env then. Info logs show a masked address, not the full one. `/feedback` delivers to that `contactEmail`.

| Env | Role |
| --- | --- |
| `ADMIN_HANDLE` | Handle seeded as `platform_super_admin` when the store has none. Default `admin`. Does not add another user if a super admin already exists. |
| `SUPER_ADMIN_EMAIL` | Contact email for that person. Empty: leave `contactEmail` unchanged. Set: the active writer stores it on every boot. Invalid: the process refuses to start. Runtime env only. |

### Creating elections

Clerk **Create election** in `/back-office` is `POST /api/elections`. A **poll** is live on the
Node from then on. A **civic vote** stays a draft on the Node until it is published to L1; until
then it takes no vote pass and no ballot (`VOTE_NOT_ON_L1`). The Node's numeric
`localElectionId` and the civic vote's `rollupElectionId` on L1 are different numbers.

### Civic votes on the rollup

In `/back-office` > **Guardians and tally**, pick the civic vote:

1. **Settings.** k (guardians needed to decrypt; empty = a majority) and the anonymity floor
   `minBallots` (fewer ballots and the result is **Withheld**).
2. **Guardians.** Each guardian runs `npm run guardian:rollup -- init` (in `apps/node`) on their own
   machine and sends you the printed identity key. Enroll each one. Guardian secrets never reach
   the Node.
3. **Publish to L1.** The Node account (`ROLLUP_PRIVATE_KEY`, your jurisdiction's clerk) calls
   `createElection`.
4. **Key ceremony.** Guardians run `guardian:rollup -- commit`, then `receive`. Click **Finalize key**.
5. **Roll.** The Node tick (`ROLLUP_TICK_SECONDS`) syncs registrations and disqualifications to L1
   until `startTime` (**Sync roll** forces one).
6. **Voting.** Voters take one vote pass each and cast from the browser.
7. **Close.** After the cutoff the tick closes the vote (or click **Close**).
8. **Decrypt.** Guardians run `guardian:rollup -- decrypt`.
9. **Finalize.** The tick finalizes once k shares are in (or click **Finalize result**). L1 checks
   the totals; the results page reads them from L1.

Keep the Node account funded with a little ETH: it pays for publish, roll sync, guardian relays,
close and finalize. `/setup` step 6 shows its balance.

### The L2 operator

`node rollup/main.mjs` in the `l2` service (`npm run l2:operator` outside Docker). It needs an
account registered with `setOperator` (`OPERATOR_PRIVATE_KEY`, pays batch gas) and shares
`L2_BALLOT_TOKEN` with the Node. Its state file is `rollup-operator.json` on `l2-data`; back it
up. Details: [`L2.md`](./L2.md), [`l2/README.md`](../l2/README.md).

If the operator ignores the L1 priority queue for 3 days, anyone can call
`activateDesertMode()`. That is permanent: closed elections finish; an open one can be closed
once from the last proven state (`desertClose`, using `GET /v1/elections/:id/desert-proof`).

### Deploying the rollup

On the local stack, Compose's `l1-deploy` does it. A public deployment happens **once** per chain
and is shared by everyone; it needs the batch circuit's verifying key, which does not exist yet.
See [`L2_VPS_SETUP.md`](./L2_VPS_SETUP.md).

### Block explorer

Node route `/explorer`. **Rollup batches** (`/explorer#/rollup`, `GET /api/explorer/rollup`) lists the operator's batches and status, without the live pending-ballot count. The poll explorer (`GET /api/explorer/blocks`) shows what happened in block N: commitments, nullifiers, reason codes, tallies, batches — **not** ballot choices. Vote proofs and public turnout publish hourly from the first ballot, on a block `DISCLOSURE_DELAY_SECONDS` (default 1800) after that hour closes. `RESULTS_MIN_VOTES` (default **100**; the gate opens once 100 voters have cast their first ballot) gates poll per-choice counts only. After that gate, hourly choice sums publish on the same delay, and a published block stays as first published. Blocks smaller than `DISCLOSURE_MIN_BLOCK_VOTES` (default 10) merge forward. A person leaving a voting office at 08:59 cannot be matched to a 09:00 tick; the block is 09:30 at the earliest. Local instant demo: `DISCLOSURE_INTERVAL_SECONDS=0`. On load, a `poll_params` or `poll_tally` row that has no stored source order is recovered from `closeBlock`, `sequence`, or `postedAt` on the payload, so a later close block can become the latest row. Lookups use that stored order, or the same fields on the payload when the stored order is missing. The poll-params sequence is per process: two Node instances can issue the same sequence, which raises `poll_params_conflict`, and `postedAt` still orders a later clock. When sequence and postedAt are both equal, the first row stays latest. [`docs/BLOCK_EXPLORER.md`](./BLOCK_EXPLORER.md).

### Outcomes monitor

Public SPA `/outcomes` (alias `/monitor`) plus `GET /api/outcomes` and `GET /api/outcomes/:id`. For a civic vote the detail also runs the L1 audit (`verification.l1`, the same checks as `verify-rollup`); an unreachable L1 is reported, not treated as a failure. Every election is grouped **before / during / after** voting from chain and election state (`Created`/`RollFrozen`, `Open`, `Closed`/`Tallied`). The Node runs the public auditor pack (`tools/auditor` / `GET /api/elections/:id/artifacts`) plus freeze-root and L1 hash checks. During voting the page shows disclosed turnout only — never unofficial option counts. The final tally appears only after it is posted. This is not `/receipt` and not `/elections/:id/results`.

### Passkeys

WebAuthn with PRF wraps a secp256k1 smart-account key. The Merkle leaf is Poseidon(trapdoor, nullifierSecret), not the address. A person may register **up to 5** passkeys; any of them can sign in. [`docs/PASSKEYS.md`](./PASSKEYS.md).

### Emails (primary)

Up to **5** addresses per person. Exactly one is **primary** whenever any email exists. MFA (except email-as-username login) and the Terms PDF use the primary inbox. Caps are code constants — **no new env vars**. [`docs/IDENTITY.md`](./IDENTITY.md).

### Civil registration approval and credential review

A voter’s `POST /api/elections/:id/register` is **pending** until a registrar or clerk of that election’s jurisdiction approves (`POST .../registration-requests/:requestId/approve`) or denies. Officers of that jurisdiction may still insert a commitment immediately from the back office.

Smart cards and driver’s licenses / passports (up to **5** live of each) are listed at `GET /api/office/credentials`. Officers revoke an expired civil registration with `POST /api/persons/:id/methods/:methodId/revoke`. Login on a revoked or expired credential is `403 CREDENTIAL_REVOKED` / `CREDENTIAL_EXPIRED`.

A later DMV / AAMVA / national-eID connector can `POST /api/integrations/credentials/status` with `CREDENTIAL_PROVIDER_SECRET` (header `x-zk-voting-provider-secret` or `Authorization: Bearer`). Unset secret → `501 CREDENTIAL_PROVIDER_MANUAL`. Review is **manual** until that secret is set. [`docs/IDENTITY.md`](./IDENTITY.md).

| Env | Role |
| --- | --- |
| `CREDENTIAL_PROVIDER_SECRET` | Shared secret for the status webhook. Empty = manual officer review only. |
| `CREDENTIAL_PROVIDER_ID` | Provider id recorded on updates (`manual` by default). |

### Sign in (email, Ethereum, smart card, license/passport)

Returning users sign in on `/`, `/admin`, and `/back-office` (same chrome). First-time **registration** is still `/register`. Requesting a place on an election roll waits for a **registrar or clerk** of that election’s jurisdiction to approve. Every path except gated `dev-login` completes with a **6-digit email code via AWS SES** when `SES_FROM_ADDRESS` and `AWS_REGION` are set.

**Email (username)**

1. `POST /api/auth/email/start` `{ email }`
2. SES delivers the OTP
3. `POST /api/auth/mfa/verify` `{ code }` — set `zk-voting.sid`

**Passkey**

1. `POST /api/auth/passkey/login/begin` — discoverable / resident-key options (no username). An optional `handle` scopes `allowCredentials` when the authenticator cannot discover the passkey.
2. Browser `navigator.credentials.get` (WebAuthn assertion).
3. `POST /api/auth/passkey/login/finish` — verify assertion, then email MFA when required.
4. The credential id already maps to a Person. Roles are unchanged (`voter`, `clerk`, `platform_admin`, …).

ZK-Voting implements this with `@simplewebauthn/server`, Express, and the JSON store: challenge, assertion, then an HttpOnly session.

**Ethereum wallet**

1. Connect a wallet (EIP-1193 `eth_requestAccounts`).
2. `POST /api/auth/web3/challenge` `{ address }` — SIWE-like **login** message (nonce stored on the Node; the client message is not trusted).
3. Wallet `personal_sign`s that message.
4. `POST /api/auth/web3/login` `{ address, signature }` — verify, resolve the Person, then email MFA.

Unknown passkeys, emails, cards, licenses, and wallets return `404` `UNKNOWN_CREDENTIAL` and **do not** create a person. Revoked or expired cards and licenses return `403 CREDENTIAL_REVOKED` / `CREDENTIAL_EXPIRED`. Binding a new wallet is `POST /api/identity/web3/verify` on `/register`. Extra wallets while signed in must sign `POST /api/me/eth-accounts`.

Each person sets a **vote PIN** (4–8 digits) on Identify yourself. Change it anytime. Forgot PIN emails an MFA code (`POST /api/pin/forgot` or `POST /api/me/pin/forgot`) and then the person sets a new PIN on the phone keypad. At ballot submit the keypad **layout stays 3×3+0** but the **numbers are shuffled per person**; the UI does not accept keyboard PIN entry. A signed-in vote needs a one-use `pinToken`.

`ALLOW_DEV_LOGIN=1` (or `NODE_ENV=test`) keeps `POST /api/auth/dev-login` as a **local/test fallback** only. It skips MFA. It is not the primary officer path. Production (`master`) must leave it off.

RP id, origins: [`docs/PASSKEYS.md`](./PASSKEYS.md). Person binding rules: [`docs/IDENTITY.md`](./IDENTITY.md).

### Terms of Use (`/terms`)

Public page `/terms` (nav on public, registered, and officer chrome). Canonical source is `apps/node/legal/terms.md`. The Node builds a **deterministic PDF 1.4** from that markdown (fixed CreationDate, Helvetica — no host timestamps).

| Fingerprint | What is hashed | Where it lives |
| --- | --- | --- |
| **PDF SHA-256** (canonical, 64 hex) | Exact PDF bytes (the SES attachment) | `user.termsHash`, `termsAcceptances[].pdfSha256`, `X-Pdf-SHA256` on `GET /terms.pdf` |
| Markdown SHA-256 | UTF-8 markdown body after YAML front matter | Published on `/terms` and stored as `markdownSha256` next to the PDF hash |

Acceptance (checkbox on `/register`, or “I agree” while signed in on `/terms`) writes **who, when, version, both hashes, and whether the PDF was emailed**. New-person identity APIs require `{ acceptedTerms: true }` (`TERMS_REQUIRED` otherwise). Viewing `/terms` while signed in records one `view` per session + current PDF hash. Public `GET /api/terms` does not include PII.

The PDF is emailed with **AWS SES** on first accept of a hash, using the same env as MFA. Vote-receipt PDFs use PDF Standard Security so they cannot be edited; `/receipt` checks SHA-256 of the exact bytes.

A separate public monitor at `/outcomes` (alias `/monitor`) lists every election before / during / after voting from chain and election state. It runs the public auditor pack plus freeze-root and L1 checks. During voting it shows disclosed turnout only; option counts appear in the final tally. It is not the receipt portal.

After `cutoffTime` has fully expired **and** a final tally is posted, the Node issues a locked **official outcome PDF** (how many people voted for each option, when voting started, when it ended). Subscribing to that email is opt-in on `/me`; casting a ballot never creates a subscription (see "Ballot unlinkability" below). Platform admin customizes letterhead and intro on `/admin`; the QR verification mark and SHA-256 / HMAC seals cannot be removed. Anyone can drop the file (or scan the QR at `/o/<reportId>`) on `/outcomes/verify` to confirm the bytes still match.

| Variable | Role |
| --- | --- |
| `VOTE_FQDN` | Voting subdomain, e.g. `vote.domain.tld`. When set, official links default to `https://` that host |
| `PUBLIC_BASE_URL` | Origin printed in the official-PDF QR (defaults to `https://$VOTE_FQDN`, else the first WebAuthn origin) |
| `SES_FROM_ADDRESS` | From address (required to send) |
| `AWS_REGION` (alias `SES_REGION`) | SES region |
| `SES_CONFIGURATION_SET` | Optional SESv2 configuration set |

SESv2 Simple content cannot attach files. The Node sends **raw MIME** (`multipart/mixed`) with `zk-voting-terms.pdf`. A second accept of the same PDF hash does not resend (`already_sent_this_hash`). If SES is unset, the Node still records the accept and **captures** the message in-process (tests use `mailer.lastTermsPdf()`, same pattern as MFA OTP capture).

**Terms updated (sign-in).** `plainTextSha256` is SHA-256 of the UTF-8 `/terms` plain text (the markdown body after front matter; same digest as `markdownSha256`). Each member stores `termsNotifiedHash` and `termsNotifiedAt`. On the next sign-in (dev login, or after email MFA), if that hash differs from the current plain-text hash, the same AWS SES mailer sends one message: the terms PDF attached and a link to `/terms`. It is sent once per member per hash. The hash and timestamp are written only after the send succeeds. A send failure is logged as `userId` plus `reason=send_failed` (no address, no message body, no credentials) and sign-in still succeeds; the next sign-in tries again. A member with no email is skipped and not marked notified. Opening an older `zk-voting.json` backfills the two fields to null and raises `meta.version` to 8. No new environment variables: `SES_FROM_ADDRESS`, `AWS_REGION`, and optional `PUBLIC_BASE_URL` (the link origin).

Store (private `apps/node/data/zk-voting.json`, gitignored):

```
termsAcceptances: [{ id, action: "accept"|"view", userId, handle, email, sessionId,
  termsVersion, pdfSha256, markdownSha256, hashOf: "pdf-bytes", emailed, emailedAt, createdAt }]
users[].termsHash / termsVersion / termsAcceptedAt / termsEmailSentAt / termsEmailHash
users[].termsNotifiedHash / termsNotifiedAt
```

Changing `legal/terms.md` changes both hashes. Prior rows keep the hash that was current when the person accepted. Version 3 is a **placeholder template**: before real voters accept it, replace every bracketed field (operator name, governing law, contacts, liability cap, retention) and have counsel review it. Each edit changes the hash and asks every signed-in person to accept again, so finish the edits before launch. A person who accepted an earlier version keeps that PDF hash; the next acceptance stores the new one.

### Feedback (`/feedback`)

Public page `/feedback` (nav and footer on the voter SPA, and the footer on admin, back office, and the explorer). `POST /api/feedback` emails the platform super admin through the same AWS SES mailer as MFA and the Terms PDF. The message is not a vote receipt. It is not written to `zk-voting.json`, not written to civic L2, and not logged at info level.

**Inbox.** The To address is the `platform_super_admin` person’s `contactEmail`, or that person’s sign-in email if no contact email is set. Set `SUPER_ADMIN_EMAIL` at deploy time (see [Platform super admin](#platform-super-admin)) to fill `contactEmail` on boot. If neither address is set, the Node **fails closed**: it logs a warning naming the missing super-admin email, returns `503 FEEDBACK_UNAVAILABLE`, and does not drop the message silently. The visitor sees “Feedback cannot be delivered right now. Please try again later.” The same `503` is returned when SES is not configured (`SES_FROM_ADDRESS` and `AWS_REGION` both required) unless `SES_DRY_RUN=1` with those two set (capture, no SES call) or the process is allowed to capture mail (`NODE_ENV=test` or `ALLOW_CAPTURE_MAILER=1`).

The visitor must tick the checkbox that feedback becomes the property of the project’s legal owner. The server rejects a missing tick with `400 ASSIGNMENT_REQUIRED`. The acceptance record (timestamp, terms version, PDF SHA-256, markdown SHA-256) is in the email and on one info log line. That log line does not include the message, the name, or the reply address.

| Env | Role |
| --- | --- |
| `SES_FROM_ADDRESS` | From address. Required to deliver, including dry-run. |
| `AWS_REGION` (alias `SES_REGION`) | SES region. Required with the From address. |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Optional. Empty uses the host IAM role. |
| `SES_CONFIGURATION_SET` | Optional SESv2 configuration set. |
| `SES_ENDPOINT` | Optional SESv2 endpoint override. |
| `SES_DRY_RUN` | `1` captures the message and does not call SES. Still requires From + region. |
| `FEEDBACK_RATE_WINDOW_SECONDS` | Gap between accepted submissions from one IP. Default `3600`. Values below `3600` are raised to `3600` (at most one per hour). A larger value waits longer. |
| `FEEDBACK_MIN_SUBMIT_MS` | Minimum time from form open to submit. Default `3000`. |
| `FEEDBACK_MAX_BODY_BYTES` | Maximum POST body. Default `16384`. The message is also capped at 4,000 characters. |
| `TRUST_PROXY` | Set to `1` when a reverse proxy is the TCP peer, so the limit uses the client address. Unset keys the limit on the socket peer. |

**Rate limit.** One **accepted** submission per IP per window, in memory on that Node process (not shared across replicas, cleared on restart). The second accepted-path submit returns `429` with `Retry-After` (seconds) and “You can send another message in about N minutes”. A missing checkbox, honeypot hit, too-fast submit, oversized body, or fail-closed delivery does **not** consume the slot. Another IP is not affected.

Reply-To is set only when the optional address validates. Names, the message, and request metadata are stripped of control characters. HTML in the mail is escaped. The email may include User-Agent and Accept-Language. It does not include an IP address, a cookie, a voter id, or any election field.

---

## Ballot unlinkability

Goal: nothing the Node writes, relays, logs or emails ties a ballot (nullifier,
`ballotHash`, receipt, ciphertext) to an account, session, email address or
identity commitment. The Node-side mechanics:

- **Vote pass, then a cookie-less ballot.** Checks that need to know who is
  voting (session, vote PIN, external-party clearance of an identity
  commitment) run on `POST /api/elections/:id/vote-pass`. The browser sends only
  an RSA-blinded value (RSA-FDH, domain `zk-voting.vote-pass.v1`, bound to the
  election id). It unblinds the signature locally and casts on
  `POST /api/elections/:id/vote` with `credentials: "omit"`, sending
  `{ token, signature }`. The Node checks the signature but cannot tell which
  issuance it came from. Spent passes are stored as a hash only, in a
  collection with no user id or time. The key lives in `$DATA_DIR/vote-pass.key.json`
  or the `vote-pass-rsa` row in `zkv_secrets`. Its public half is served by
  `GET /api/elections/:id/vote-pass` and must stay the same for every voter.
  When external parties are active, a ballot without a pass gets
  `403 VOTE_PASS_REQUIRED`.
  Older backups may still hold `votePassTags` keyed with `receiptPdfSecret`.
  Those tags tie a pass to a nullifier. Purge them. Current data keeps spent
  passes only as an unlinked hash list (`votePassSpent`), and load deletes
  leftover tags and `spentPassHash` fields.
- **Poll book.** `votePassIssued` holds, per election, sorted hashes of the
  voters who took a vote pass, so a restart cannot issue a second pass. It
  records who took part, never which pass or ballot is theirs (the pass is
  blind). Deleting it reopens the double-pass gap until the batch circuit
  proves eligibility.
- **No identity on the ballot request.** `sanitizeVoteBody` strips
  `identityCommitment`, `userId`, `pinToken`, `userOpHash`, `address`,
  `credentialId` and choice keys. The API-key "last used" stamp is not touched
  on a ballot request. The passkey wallet's UserOp hash is salted per
  authorization and never leaves the browser.
- **No timing or order join.** `acceptedAt` is floored to the disclosure
  interval (hourly by default). Ballot rows are inserted at a random position.
  The Postgres `updated_at` column is floored to the hour for `votes`,
  `receipts`, `envelopes`, `votePassSpent`, `votePassIssued` and `elections`. The Node's own access log skips
  `POST /api/elections/:id/vote` entirely: no line, no timestamp.
- **No subscription on vote.** Casting never creates an outcome-PDF
  subscription; it is opt-in on `/me`. Legacy `vote-default` rows are relabelled
  `legacy-default` and their timestamps floored to the day on load.
- **Receipts.** Download is the default. Emailing a copy is opt-in
  (`optIn: true` and an explicit address; no session fallback). The email holds
  the election and the holder token only, with no nullifier, `ballotHash`,
  `userOpHash`, time or attachment. Nothing about the send (`emailHint`,
  `emailedAt`) is written to the receipt row, and the in-memory mail log does
  not keep it outside tests.
- **No plaintext ballots.** A ciphertext that decodes as readable JSON is
  refused with `400 PLAINTEXT_BALLOT`. `ZKV_ALLOW_PLAINTEXT_BALLOTS=1`
  (`allowPlaintextBallots`) turns that off for ranked/IRV demos and tests only.
  It is **NON-PRODUCTION**. The Node does not copy a decoded ranking into `rankingPayload`.
- **Relayed, not sent from the voter's wallet.** A civic ballot goes from the
  browser to the Node (no cookies) and from the Node to the operator with
  `L2_BALLOT_TOKEN`. It carries no identity commitment.

### `/vote` log policy (operators must enforce)

- Do not log client IP, cookies, `Authorization`, user agent or request body
  for `POST /api/elections/*/vote` at any layer: reverse proxy (nginx, Caddy,
  Traefik), load balancer (ALB, Cloudflare), WAF, APM or packet capture.
  Disable access logs for that path, or strip it to method, path and status
  with the timestamp truncated to the hour.
- Do not keep request-level logs for `POST /api/elections/*/vote-pass` next to
  ballot data. If you keep them, keep them apart and short-lived.
- Do not run a session-sticky load balancer on `/vote`. Do not add tracing
  headers or request ids that are also set on signed-in requests.
- Support dumps and backups of `zk-voting.json` / `zkv_rows` must not be joined
  with proxy logs.

### Residual risks (Node side)

- An operator watching live traffic can still guess by timing: a pass issued at
  12:00:01 and a ballot at 12:00:03 from the same network. The browser keeps
  the pass, so a voter who wants more distance can wait or use another network
  before casting. Tor or a mixnet relay would close this; neither is built.
- A malicious operator could serve a different vote-pass public key to each
  voter and tag them. The key is served from one place and is the same for
  everyone on an honest Node; auditors should compare its fingerprint from
  several clients.
- `POST /vote-pass` with an identity commitment and no session (polls with
  external parties) is unauthenticated, like the old vote path. It is capped
  once per commitment per election by the poll book. The nullifier still stops
  a second counted ballot.
- A voter who opts into the receipt email gives their mail provider the holder
  token. With the token, `/api/receipts/verify` returns the nullifier. The
  tally does not open that ballot, so the token does not reveal the option.
  It can still show that the person voted.
- The clearance entry point and per-ballot tally openings are not in the
  client ABI. Plurality totals are an aggregate decryption. Ranked tally opens
  each sealed ranking with `t` guardian partials and runs IRV (recomputable,
  not ZK proof-verified; no verified shuffle).

## Secrets and production

- Deploy keys, `ROLLUP_PRIVATE_KEY`, `OPERATOR_PRIVATE_KEY`, `L2_BALLOT_TOKEN` and proving keys are **not** in git.
- `.env` is gitignored. `./setup.sh` writes it. Do not paste production RPC URLs with credentials into issues.
- `RECEIPT_PDF_SECRET` (or `$DATA_DIR/receipt-pdf.secret`) is the HMAC / PDF owner-password material for locked vote-receipt PDFs **and** official outcome PDFs. It is not a voter password; readers open the PDF without one. Editing remains forbidden.
- A civic result is certified on L1; nothing in the Node's store can change it. Do not edit a poll tally in the store after roll freeze.
- `opens_ballots` elections run a **Feldman t-of-n** guardian ceremony (`p256-feldman-dkg-v1`). The Node stores public commitments and shares encrypted to each guardian’s transport key. It does not store a tally private key. After cutoff, `t` guardians decrypt the **summed** option ciphertexts (`aggregate:<option>`), not each ballot. The guardian CLI refuses a per-ballot partial on the AG ciphertext. See [`TALLY_GUARDIANS.md`](./TALLY_GUARDIANS.md). The ceremony is NON-PRODUCTION. Do not use it for a binding election. Ranked questions (polls, or sealed votes with the `sealedRankedChoice` opt-in) also need one `ranking:<rankingId>` partial per sealed `RK` ranking envelope, keyed by a random id; the guardian CLI emits them from the `rankings` list and skips excluded and deleted envelopes. Ranked choice on a sealed vote is an opt-in per-election setting (`sealedRankedChoice`, off by default, bound into `ballotSpecHash`; turning it on requires acknowledging a disclosure that voters also see). Polls always allow it. The voter seals the full ranking in a fixed-size `RK` envelope (one size per election) and its hash is folded into the proven AG tag, so it cannot be swapped after casting. Ranking hashes are published with the poll's hourly disclosure blocks. After cutoff, `t` guardians post `ranking:<rankingId>` partials, keyed by a random per-ballot id (never the nullifier); the opened set is published in sorted order. Trade-off: until a verified shuffle exists, guardians see each individual ranking in plaintext (not who cast it). The opened ranking carries the first-choice tag randomness `r` (needed for the cast-time first-choice check), so whoever opens the rankings (the Node, or `t` colluding guardians) can also match each ranking to its encrypted ballot, and so to that ballot's nullifier and hourly block (not to the voter's identity). `r` itself is never published in the opened set or the results. IRV is recomputable but not ZK-proven. Coercion: a voter who keeps `r` can show a coercer which on-chain ballot is theirs and then point to their ranking in the published set; a distinctive ranking pattern is a further coercion risk.

## Results on L1

A civic vote's result is certified by `ZkVotingRollup.finalizeResult`, which checks the totals
against the guardians' decryption shares and the ballot count. There is no separate
certification step and no tally hash to post. Polls are not certified on L1.

When `L1_RPC_AUTH_TOKEN` is set, L1 JSON-RPC calls send `Authorization: Bearer <token>`. Leave it empty when the endpoint does not. The value is never logged.


## Disqualification operations

Only the jurisdiction's disqualification officers may disqualify. Every mark has a **reason code** from the public catalog, an evidence **hash**, issuer and timestamp. No silent deletes: revocation is an event. For a civic vote, marks reach L1 through the priority queue and are refused after `startTime`. For a poll, marks after the roll freeze are refused unless the poll was created with `lateUpdateAllowed` (default false, discouraged).

The operator's job is to keep the Node and the L2 operator up and the accounts funded — not to decide who is eligible.

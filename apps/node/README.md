# NOT FOR PROFIT

**Republic** Node — civic public good, not a commercial product.

This package is the DealPunchList-shaped long-lived Node process for **zk-voting**
(product name Republic): JSON HTTP API, WebAuthn passkeys, a gasless vote
relayer, an L2 block-explorer backend, and a static host for the React SPA.

There is no token. There is no paid tier. Do not commercialize this software.
See `/NOT_FOR_PROFIT.md` at the repo root.

---

## What it is

| DealPunchList-node | This process |
| --- | --- |
| Organizations | Jurisdictions |
| Rooms / processes | Elections (start + cutoff, roll, inbox) |
| Users + roles | `voter`, `clerk`, `registrar`, `disqualification_officer`, `tally_operator`, `platform_admin`, `observer` |
| Host menu | repo-root `system_actions.sh` |

Canonical election truth is the chain when `CHAIN_RPC` is set. Local JSON under
`apps/node/data/` is the demo / operator cache (gitignored). Native addons such
as `better-sqlite3` are **not** used.

Privacy: a vote is stored as `{ nullifier, ballotHash, electionId, relayer: "node" }`.
The Node never writes a passkey user id onto the same record as an encrypted
ballot or a choice. The UI must not print “I voted for X”.

---

## Run

Node **22+**. From this directory:

```bash
npm install
npm start          # node src/server.mjs   (PORT=3000)
npm run dev        # node --watch src/server.mjs
npm test           # node --test test/api.test.mjs
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

`GET /health` returns `{ ok: true, app: "zk-voting", nfp: true, chainId }`.

The process serves `public/` and `dist/` if present. Unknown GET routes that are
not `/api/*` or `/health` fall back to `index.html` (or a “UI is loading” shell).

---

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP listen port |
| `CHAIN_ID` | `27427` | Republic L2 chain id (health + explorer) |
| `CHAIN_RPC` | _empty_ | If set, `POST /api/elections/:id/vote` calls `BallotInbox.submitVote` via viem |
| `BALLOT_INBOX_ADDRESS` | _empty_ | Required when `CHAIN_RPC` is set |
| `RELAYER_PRIVATE_KEY` | _empty_ | Relayer key for on-chain submit |
| `RP_ID` | `localhost` | WebAuthn rpID |
| `WEBAUTHN_ORIGINS` | localhost:PORT and :5173 | Comma-separated expected origins |
| `ADMIN_HANDLE` | `admin` | Seeded `platform_admin` on first boot |
| `DATA_DIR` | `apps/node/data` | JSON store + `l2-chain.json` |
| `L2_CHAIN_FILE` | `$DATA_DIR/l2-chain.json` | Shared with the sequencer when it writes the same file |
| `ALLOW_DEV_LOGIN` | off (`1` in tests) | `POST /api/auth/dev-login` for local/dev only |
| `NODE_ENV` | _unset_ | `test` enables dev login |

Passkey rpName is always **Republic**.

---

## HTTP

```
GET  /health
GET  /api/elections
POST /api/elections                 (clerk / platform_admin)
GET  /api/elections/:id
POST /api/elections/:id/register    (after passkey)
POST /api/elections/:id/vote        (relays proof; no passkey identity on the ballot)
POST /api/elections/:id/disqualify  (disqualification officer)
POST /api/elections/:id/tally       (tally operator)
GET  /api/me
POST /api/auth/passkey/register/begin
POST /api/auth/passkey/register/finish
POST /api/auth/passkey/login/begin
POST /api/auth/passkey/login/finish
GET  /api/explorer/blocks
GET  /api/explorer/blocks/:n
GET  /api/explorer/txs/:hash
```

Also: freeze roll, envelopes (tally operator; ciphertext only), jurisdictions,
reason codes, CORS open for local tools.

Without `CHAIN_RPC`, votes that pass the election window and nullifier check are
accepted in the local store so the explorer and SPA can run a demo.

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

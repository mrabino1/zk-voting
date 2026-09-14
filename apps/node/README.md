# Node application

**NOT FOR PROFIT** — civic public good. Not a commercial product. See [`/NOT_FOR_PROFIT.md`](../../NOT_FOR_PROFIT.md).

DealPunchList-shaped **Node 22** process for Republic / zk-voting: HTTP API + SPA, jurisdictions as organizations, elections as rooms, `system_actions.sh` to pull / build / restart.

The Node is the **human product**. It is **not** the canonical roll. Eligible-set and disqualification-set commitments live in the contracts. If this process lies about the chain, that is a bug; the explorer and L2 JSON-RPC are the check.

Footer on every page: **NOT FOR PROFIT**. No commercialization copy. No token.

---

## Run

From the **repository root** (npm workspaces):

```bash
npm install
npm run dev -w apps/node      # or: npm run dev
npm run start -w apps/node    # long-lived process for system_actions restart
npm test -w apps/node
```

Health check (also `./system_actions.sh health`):

```text
GET http://127.0.0.1:3000/health
```

Override with `ZK_VOTING_PORT` / `ZK_VOTING_HEALTH_URL`. SQLite file: `apps/node/data/republic.sqlite` (gitignored).

Point the API at Republic L2:

```bash
export REPUBLIC_RPC_URL=http://127.0.0.1:8545
export REPUBLIC_CHAIN_ID=27427
# factory / inbox / paymaster addresses from forge script stdout (name=0x…)
```

Shared clients: `@zk-voting/chain-client`, `@zk-voting/proof-helpers`, `@zk-voting/types`. Install optional **viem** for ABI encoding of `createElection` / `submitVote`.

Host menu: [`../../system_actions.sh`](../../system_actions.sh) — `deploy-dev` uses **`test/unstable`**, `deploy-prod` uses **`master`**. See [`../../docs/OPERATOR.md`](../../docs/OPERATOR.md).

---

## HTTP

```text
GET  /health
GET  /api/elections
POST /api/elections                  (clerk)
GET  /api/elections/:id
POST /api/elections/:id/register     (after passkey)
POST /api/elections/:id/vote         (relays UserOp / proof)
POST /api/elections/:id/disqualify   (officer)
POST /api/elections/:id/tally
GET  /api/me
POST /api/auth/passkey/register/begin
POST /api/auth/passkey/register/finish
POST /api/auth/passkey/login/begin
POST /api/auth/passkey/login/finish
GET  /api/explorer/blocks
GET  /api/explorer/blocks/:n
GET  /api/explorer/txs/:hash
```

## Pages (SPA)

| Route | Who |
| --- | --- |
| `/` | Voter home |
| `/register` | Intake |
| `/vote/:id` | Ballot (passkey; no “I voted for X” receipt) |
| `/admin` | Platform admin (hosts, keys, jurisdictions) |
| `/back-office` | Clerks, registrars, disqualification officers |
| `/explorer` | Republic L2 block explorer |
| `/elections/:id/results` | Certified tally + verifier artifacts |

## Passkeys, L2, explorer

- Passkeys: WebAuthn PRF wraps the Ethereum key; identity trapdoor is a **separate** PRF domain. [`docs/PASSKEYS.md`](../../docs/PASSKEYS.md).
- Gasless L2: paymaster sponsors vote / register UserOps. chainId **27427**. [`docs/L2.md`](../../docs/L2.md).
- Explorer: visible vs hidden data. [`docs/BLOCK_EXPLORER.md`](../../docs/BLOCK_EXPLORER.md).

Do not log trapdoors, PRF output, or decrypted choices. Do not resolve explorer commitments to legal names on public routes.

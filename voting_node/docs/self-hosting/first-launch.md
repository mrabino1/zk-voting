# First launch

**NOT FOR PROFIT** — civic public good. Not a commercial product.

On the very first boot the Node prepares itself. Compose uses Postgres and creates the `zkv_*` tables. The first visitor is sent to the **first-run setup screen** (`/setup`) to create the platform super admin, choose the chain id and check the rest of the setup. Run `./setup.sh` before the first boot to fill in `.env` (below); Compose will not start without the database settings and the ballot token it writes.

## Before the first boot: `./setup.sh`

From a clone, run `./setup.sh` (repository root or `voting_node/`; same as `npm run setup` in `voting_node/`). It writes `voting_node/.env` (mode 600) and prints the launch command. It asks, in this order:

1. Super admin: `ADMIN_HANDLE`, `SUPER_ADMIN_EMAIL`, and `SETUP_TOKEN` (generate, enter, keep or remove). A passkey can only be made in a browser, so the token is what protects `/setup` until you claim it there. The script never prints it: read it from `voting_node/.env`.
2. `CHAIN_ID`, or `web` to leave it for the setup screen.
3. Entropy ceremony: yes or no, and its host (`ENTROPY_CEREMONY_URL`, stored as an `https://` origin).
4. Setup entropy (`ZK_ENTROPY`): a closed ceremony's `zke1:ceremony:…` output (checksum-validated, typed hidden), local entropy generated now from OS randomness, keyboard timing and jitter (`zke1:local:…`), or skip.
5. `VOTE_FQDN`, the host port (`ZK_VOTING_PORT`), `TRUST_PROXY`, the database (by default the Postgres bundled with Compose, with a generated password; or your own Postgres URL, typed hidden; or JSON files when you are not using Compose) and `BRAND_NAME`. An empty `RECEIPT_PDF_SECRET` is generated.
6. Rollup: **local chain** (the default: Compose runs Anvil on chain 31337, deploys ZkVotingRollup once and uses Anvil's public test keys, which are refused on any other chain) or **an existing deployment** (`L1_RPC`, `ROLLUP_ADDRESS`, `ROLLUP_JURISDICTION_ID`, the node key `ROLLUP_PRIVATE_KEY` and the operator key `OPERATOR_PRIVATE_KEY`, both hidden; it checks both L1 balances). Optional `L1_RPC_AUTH_TOKEN` is a bearer token for an L1 RPC that requires auth; leave it empty when the endpoint does not. `L2_BALLOT_TOKEN`, the node's bearer token for the operator, is minted when missing.

Then it asks how you run it and prints the exact next command: `docker compose up -d --build` (plus the health check), the Coolify settings ([Coolify](./coolify.md); secret values are listed by name only), or `npm run dev`.

It does not set `IS_DEMO`. Leave that variable out (the default) unless this host is the disposable public demo, in which case set `IS_DEMO=true` yourself. A missing value is not a demo. If the key is already in `.env`, `true`/`1` stays a demo and any other value is rewritten to `false`.

It is idempotent: every saved value is the default the next time, only changed lines are rewritten (comments and your other lines stay), and a run with no changes writes nothing. Secrets are never echoed: secret prompts are hidden, and the summary says "set (secret, not shown)". Back up `voting_node/.env`: it holds the node and operator keys. `./setup.sh -y` takes every default without asking (useful in scripts); `./setup.sh --help` lists the options.

Re-check the rollup connection later on `/setup` step 6 or with `GET /api/setup/rollup`.

## What happens on an empty volume

1. The Node creates its Postgres tables (`zkv_*`), or `$DATA_DIR/zk-voting.json` when it runs without `DATABASE_URL`, and writes a random node id.
2. It seeds **one platform administrator** with the handle from `ADMIN_HANDLE` (default `admin`). That account has no passkey yet. A later boot never creates a second administrator.
3. If `SUPER_ADMIN_EMAIL` is set, it is stored as that administrator's contact address. `/feedback` messages go there.
4. It seeds a **Demo jurisdiction** so the officer pages have something to show.
5. If `RECEIPT_PDF_SECRET` is empty, it creates `$DATA_DIR/receipt-pdf.secret`.

## First-run setup (`/setup`)

Do this right after the first deploy, before you share the address:

1. Open the site. While no super admin exists every page sends you to `/setup`.
2. **Super admin.** Keep or change the handle (default from `ADMIN_HANDLE`), enter the setup token, accept the Terms, and create a passkey. If `SETUP_TOKEN` is set, type that value. If it is empty, type the one-time token the server printed in its process log at boot. Complete the email code if SES is configured.
3. **Chain id.** The node's own chain id, used for poll signatures and wallets (the rollup's L1 chain is `L1_CHAIN_ID`). If `CHAIN_ID` is set in the environment it is shown read-only ("fixed by the environment"). Otherwise pick 27427 (default), 1 (Ethereum mainnet), 11155111 (Sepolia), 31337 (local) or a custom positive integer. `CHAIN_ID` in the environment always wins. Restart the Node after changing it.
4. **Entropy ceremony.** Say whether a public entropy ceremony is used ([`zk-entropy/ceremony`](../../../zk-entropy/ceremony/README.md)) and, if so, its host (e.g. `ceremony.zk-voting.org`). `ENTROPY_CEREMONY_URL` in the environment fixes it.
5. **Setup entropy.** If the ceremony is closed, paste its output (`zke1:ceremony:…`, checksum-validated as you type). Otherwise generate local entropy now on the pad (mouse, keys and `crypto.getRandomValues`, giving `zke1:local:…`) or skip. `ZK_ENTROPY` in the environment wins and makes this read-only. Only the super admin can read the saved value back; `/api/setup` shows only whether it is set and its transcript hash. It is prefilled in the "Entropy string" field of `/ceremony/<id>` and mixed into your contribution.
6. **Site and environment.** Shows what the environment set (hostname, public URL, passkey RP ID, proxy, port, database kind, whether a setup token is set), read-only; change those with `./setup.sh` and restart. The product name can be set here; the `BRAND_NAME` / built-in default is stored as "inherit", like Site admin > Layout.
7. **Rollup connection.** Shows the ZkVotingRollup address, the L1 chain, the node account and its L1 balance (with a warning when it is low or empty), and whether the L2 operator answers. Keys and the ballot token are never shown; they live in the environment.
8. Press **Finish setup**. The screen never shows again.

Only the first super admin wins: once one exists, `POST /api/setup/admin/*` answers `409 SETUP_ADMIN_EXISTS`, including for a second visitor who started at the same time. `GET /api/setup` reports the state.

The first-run claim always requires a setup token. When `SETUP_TOKEN` is set, type that value on `/setup`. When it is unset, the server prints a one-time token at boot, only in the process log. Type that on `/setup`. It is not served over HTTP. Restarting before the super admin is created replaces a generated token. An environment token stays valid until a super admin exists.

`/register` cannot claim the seeded super admin. Use `/setup`. Keep the Node private until that claim is done if you want a smaller window: the [Tailscale sidecar](./tailscale.md), a firewall, or your PaaS's basic-auth option. Then open it to the public.

## Make it yours

- **Name and text.** Set `BRAND_NAME` (and the `CLIENT_*` variables for your office's face), or use Site admin > Appearance > Branding. As an officer, open `/office/site` to edit the public home page. Keep your changes in configuration so your fork can take upstream updates.
- **Voting hostname.** Set `VOTE_FQDN` before voters register passkeys. Passkeys are bound to that hostname; changing it later means voters must register again.
- **Email.** Set `SES_FROM_ADDRESS` and `AWS_REGION` so sign-in codes and Terms PDFs are delivered.
- **Jurisdictions and officers.** Add your real jurisdiction and officers from `/admin`, then create your first election from the admin hub (`/office`).

## Check it

```bash
curl -fsS https://vote.example.org/health
curl -fsS https://vote.example.org/api/config
```

`/health` must show `"ok": true` and your `voteFqdn`. `/api/config` shows the passkey relying party and the rollup connection. See [Health checks](./health-checks.md).

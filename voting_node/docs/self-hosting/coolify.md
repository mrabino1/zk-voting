# Coolify

**NOT FOR PROFIT** — civic public good. Not a commercial product.

[Coolify](https://coolify.io) is an open-source, self-hosted PaaS. It builds this repository's
Compose file, issues TLS certificates and runs updates. It is the recommended way to run your
own fork: **you do not need to type any settings before the first deploy.** Coolify generates
the database password and the setup token, gives the site an address, and the rest is chosen in
your browser on the setup screen.

## 1. Fork the repository

On GitHub, fork `zk-voting`. Your fork is your site: its name, pages and settings are yours,
and you can [take upstream updates](./forking.md) whenever you like.

## 2. Create the resource in Coolify

1. In your Coolify project choose **+ New → Public Repository** (or **Private Repository** with
   the GitHub App for a private fork).
2. Repository: your fork. Branch: `master` (production) or `test/unstable` (staging), see
   [Upgrading](./upgrading.md#release-channels).
3. Build pack: **Docker Compose**.
4. **Base Directory:** `/voting_node`
5. **Docker Compose Location:** `/docker-compose.coolify.yml`
6. Click **Deploy**. The first build takes several minutes (it builds the app, the L2 operator
   and compiles the smart contracts for the built-in test chain).

That is all. Coolify creates these for you and keeps them across redeploys; you can see them
under the resource's **Environment Variables**:

| Variable | What it is |
| --- | --- |
| `SERVICE_USER_POSTGRES`, `SERVICE_PASSWORD_POSTGRES` | The database account. The app builds its connection from them. |
| `SERVICE_PASSWORD_SETUP` | The **setup token**. You type it once on the setup screen to prove you own this deployment. |
| `SERVICE_FQDN_NODE` | The site's address (see the next step). |

The app generates the rest itself on first boot (the key the app and the L2 operator share, the
receipt-signing key) and keeps them on its own volumes.

## 3. Give it your address

Coolify assigns a temporary address to the `node` service, often a plain `http://…sslip.io`
one. **Passkeys, which voters and officials sign in with, only work over https**, and they are
bound to the address they were created on. So before anyone registers:

1. Point a DNS name at your Coolify server (for example `vote.example.org`).
2. In the resource, open the **node** service and set **Domains** to `https://vote.example.org`.
3. Redeploy. Coolify gets the certificate; the app picks the address up by itself
   (`COOLIFY_FQDN` / `COOLIFY_URL`), so there is nothing else to change.

The setup screen warns you while the site is still on plain http.

## 4. Open the site and follow the setup screen

Open your address. While the site has no administrator, every page leads to **/setup**:

1. **Claim the site.** Choose your handle, paste the setup token (`SERVICE_PASSWORD_SETUP`
   from step 2), accept the Terms and create a passkey. You are now the super administrator;
   this step closes for good.
2. **Chain id, entropy.** Defaults are fine; each step explains its choice.
3. **Website address.** Shows the address and database the site is running with and where
   each came from.
4. **How civic votes are counted.**
   - **Polls only**: no blockchain, nothing to pay.
   - **Built-in test chain**: free practice civic votes on a private Ethereum test chain that
     runs inside this deployment. Choose this to learn the system.
   - **A public Ethereum network**: choose the network from the list (the chain id and the
     shared contract address are filled in for you), paste an RPC address, and fund the two
     accounts the screen shows. Public networks become selectable once the shared contract is
     deployed there; until then the screen says why.

   Saving restarts the app and the L2 operator to apply it; the page reconnects by itself.
5. **Finish.**

Then add your jurisdiction and officers from `/admin` and create your first election from the
admin hub (`/office`). See [First launch](./first-launch.md) for what each step stores.

## Email (optional)

Sign-in codes, receipts and official outcome PDFs are sent with Amazon SES. Without it the site
works, but nothing is emailed. To turn it on, set `SES_FROM_ADDRESS` and `AWS_REGION` (plus
`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` unless the server has an IAM role) under
Environment Variables and redeploy. Do this **after** you have claimed the site: once email is
configured, every sign-in, including the first administrator's, needs an email code.

## Changing settings later

Every setting the setup screen chose can be overridden in Coolify's Environment Variables; a
value set there always wins and the setup screen shows it as fixed. The full list is in the
[Configuration reference](./configuration.md). Commonly used:

| Variable | Example | Why |
| --- | --- | --- |
| `SUPER_ADMIN_EMAIL` | `clerk@example.org` | Where `/feedback` and the first admin's mail go. |
| `BRAND_NAME` | `Springfield Votes` | Default product name (Site admin > Appearance wins). |
| `VOTE_FQDN` | `vote.example.org` | Pin the address instead of following Coolify's domain. |
| `IS_DEMO` | `true` | Only on a disposable public demo (monthly soft-delete). |

## Health checks

The Compose file defines health checks for `node` and `l2`. If you also enable Coolify's own
HTTP health check, use path `/health`, port `3000`, success HTTP 200, on the **node** service.
Do not require `"mode":"active"`: a new container starts in standby during a rolling update.

Until you choose how civic votes are counted, the `l2` service waits in **standby**
(`/health` answers 200 with `"status":"standby"`); that is expected and does not keep the site
down. The one-shot `l1-deploy` service exits after deploying the test-chain contract; Coolify
leaves it out of the resource's health status.

## Updates and backups

Enable **Auto Deploy** on the branch, or click **Redeploy**. The volumes `postgres-data` (all
app data), `node-data`, `l2-data`, `install` (the setup screen's choices and the keys it
generated) and `l1-data` persist across deploys. **Back up `postgres-data` and `install`**: the
second holds this site's Ethereum keys. Read [Upgrading](./upgrading.md) and
[Backups](./backups.md) first.

## Running without the one-click file

`docker-compose.yml` is the hand-configured variant (every secret in `.env`, written by
`./setup.sh`). With Coolify, `./setup.sh --deploy coolify` prints the settings for it. Use it
when you want every value under your own control; the setup screen then shows them as fixed by
the environment.

If you mount a file from the repository into a container yourself, enable **Preserve Repository
During Deployment**. `docker-compose.coolify.yml` does not need it: the contracts are compiled
into the `l1-deploy` image at build time.

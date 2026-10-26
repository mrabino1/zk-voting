# zk-entropy ceremony

**NOT FOR PROFIT**: civic public good, not a commercial product. License: AGPL-3.0-or-later.

A small public website where many people add randomness, and whose closed output is a `zke1:ceremony:…` string that a zk-voting demo super admin pastes at first-run setup (`/setup` step 4, or `ZK_ENTROPY`). One process, no build step, Node ≥ 22.13, one dependency (`pg`, used only with `DATABASE_URL`).

## Pages

| Path | Who | What |
| --- | --- | --- |
| `/` | anyone | Contribute: move the mouse / type over the pad (optional text is mixed in locally and never sent). The browser mixes it with `crypto.getRandomValues` and sends only the 32-byte result. Receipts stay in the browser. |
| `/transcript` | anyone | Chain facts, every contribution's hash and time, an in-browser verify button and a JSON download. Raw contributions appear only after close. |
| `/admin` | admin | First-run admin setup, sign-in, open / close, settings (title, minimum count, deadline, close after N). |
| `/health` | probes | `200 {"ok":true,…}` when the store answers. |
| `/api/state`, `/api/transcript` | anyone | JSON. `/api/transcript` is what `zk-entropy verify-transcript` reads. |

## How the chain works

```
state_0 = SHA-256("zk-entropy/ceremony/v1/genesis" ‖ salt)                (salt: 32 random bytes, public)
state_i = SHA-256("zk-entropy/ceremony/v1/step"    ‖ state_{i-1} ‖ c_i)   (c_i: 32 bytes from contributor i)
output  = SHA-256("zk-entropy/ceremony/v1/final"   ‖ state_n ‖ u32 n)
```

Contributions are appended in one transaction each, so 25 people pressing the button at once still give one linear chain. While open, the transcript lists `SHA-256(c_i)` and the server time of each contribution. On close it reveals every `c_i` and `state_n`, then publishes `zke1:ceremony:<output>:<transcript hash>:<check>`.

The transcript holds no personal data: no names, emails, IP addresses or user agents. IPs are used in memory for rate limiting only (`RATE_LIMIT_PER_MINUTE`) and never stored.

### Trust model

- The output is unpredictable as long as **one** contributor's randomness was good and was not seen by the coordinator **before it was chained**.
- The server operator sees each `c_i` as it arrives. A malicious operator could stop accepting contributions, or add their own last, after looking at the state, and so pick among a few outputs ("grinding"). They cannot pick an arbitrary output. Anyone can detect a tampered chain after close by recomputing it.
- The zk-voting demo never uses the output alone: the browser contribution mixes it with its own fresh randomness, and snarkjs adds its own. So a weak ceremony cannot make the keys weaker than not using one.
- Verify a closed ceremony yourself:

  ```bash
  node zk-entropy/bin/zk-entropy.js verify-transcript https://ceremony.zk-voting.org/api/transcript
  ```

## Admin

The admin is created one of two ways:

- **First run**: open `/admin` and choose a passphrase (at least 12 characters). Only the first one wins; later attempts answer `409`. Set `SETUP_TOKEN` so a stranger cannot claim it before you do, or keep the site private until you have.
- **Environment**: set `ADMIN_TOKEN` (use 24+ random characters, e.g. `openssl rand -hex 24`) and sign in with it. It works alongside a first-run passphrase.

Sessions are an `HttpOnly; SameSite=Strict` cookie, `Secure` when the request came over HTTPS (directly or via `X-Forwarded-Proto: https` with `TRUST_PROXY` on). Cookie writes must be same-origin.

Closing: by hand (forced if below the minimum, with a confirmation), at `CEREMONY_CLOSE_AT` / the deadline in settings, or after `CEREMONY_CLOSE_AFTER` contributions. A closed ceremony cannot be reopened.

## Environment

| Variable | Default | Secret | Meaning |
| --- | --- | --- | --- |
| `PORT` | `8080` | | Listen port. |
| `HOST` | `0.0.0.0` | | Listen address. |
| `DATA_DIR` | `/data` | | SQLite directory (mount a volume here). |
| `SQLITE_FILE` | `$DATA_DIR/ceremony.sqlite` | | Override the SQLite path. |
| `DATABASE_URL` | empty | **yes** | `postgres://…`. Set = Postgres instead of SQLite (tables are created on start). |
| `ADMIN_TOKEN` | empty | **yes** | Admin sign-in token (use 24+ random characters). |
| `SETUP_TOKEN` | empty | **yes** | Required to create the first-run admin passphrase. |
| `PUBLIC_URL` | empty | | Public origin, e.g. `https://ceremony.zk-voting.org`. Used for the verify hint and the same-origin check. |
| `TRUST_PROXY` | `1` | | Trust `X-Forwarded-For` / `X-Forwarded-Proto` from the reverse proxy. |
| `CEREMONY_TITLE` | `zk-voting entropy ceremony` | | Title until the admin changes it. |
| `CEREMONY_MIN_CONTRIBUTIONS` | `2` | | Close refuses below this unless forced. |
| `CEREMONY_CLOSE_AT` | empty | | ISO 8601 deadline (e.g. `2026-11-30T18:00:00+01:00`). |
| `CEREMONY_CLOSE_AFTER` | empty | | Close automatically after this many contributions. |
| `CEREMONY_AUTO_OPEN` | `0` | | Open for contributions on first start without an admin click. |
| `CEREMONY_MAX_CONTRIBUTIONS` | `100000` | | Hard cap. |
| `RATE_LIMIT_PER_MINUTE` | `6` | | Contributions per IP per minute (in memory). |
| `AUTO_CLOSE_INTERVAL_MS` | `15000` | | How often the deadline is checked. |
| `ADMIN_SESSION_HOURS` | `12` | | Admin cookie lifetime. |

Settings changed in `/admin` are stored in the database; the `CEREMONY_*` values are only the starting defaults.

## Deploy with Coolify

The site does not redirect to HTTPS itself; it expects a TLS-terminating proxy (Cloudflare tunnel → Traefik) in front.

| Coolify field | Value |
| --- | --- |
| Build pack | Dockerfile |
| Base directory | `/zk-entropy` |
| Dockerfile location | `ceremony/Dockerfile` |
| Ports exposes | `8080` |
| Health check path | `/health` |
| Persistent storage | volume mounted at `/data` (not needed with `DATABASE_URL`) |
| Domain | `https://ceremony.zk-voting.org` |
| Env (secret) | `ADMIN_TOKEN`, `SETUP_TOKEN`, `DATABASE_URL` (only for Postgres) |
| Env (plain) | `PUBLIC_URL=https://ceremony.zk-voting.org`, optional `CEREMONY_*` |

Locally:

```bash
cd zk-entropy && docker build -f ceremony/Dockerfile -t zk-entropy-ceremony .
docker run --rm -p 8080:8080 -v zkc-data:/data -e SETUP_TOKEN=change-me zk-entropy-ceremony
# or without Docker (Node ≥ 22.13):
cd zk-entropy/ceremony && npm ci && DATA_DIR=./data npm start
```

## Tests

```bash
cd zk-entropy/ceremony && npm ci && npm test
TEST_DATABASE_URL=postgres://user:pw@localhost:5432/db npm test   # also runs the Postgres test
```

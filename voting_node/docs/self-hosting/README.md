# Self-hosting zk-voting

**NOT FOR PROFIT** — civic public good. Not a commercial product.

zk-voting is built to be forked and run by anyone who needs to read the will of the people: a city, a union, a cooperative, a school board, a club. This section explains how to install a Node, put it on the internet (or a private tailnet), launch it for the first time, and keep it up to date.

The same pages are served by every running Node at `/docs`, so operators can read them without leaving the app.

> **Branding is yours.** "zk-voting" is the default name. A full branding configuration (name, logo, colors, emails, PDFs) is planned in a follow-up change; until then, the public site text can be edited by an officer at `/office/site`, and environment variables always win over that editor.

## Install

| Page | Use it when |
| --- | --- |
| [Requirements](./requirements.md) | You are sizing a host or checking ports, DNS, and HTTPS. |
| [Docker Compose quickstart](./docker-compose.md) | You want a Node running on one machine in five minutes. |
| [Coolify](./coolify.md) | You deploy with Coolify (the recommended managed path). |
| [Dokploy, CapRover, plain Compose](./other-platforms.md) | You use another self-hosted PaaS or none at all. |
| [Tailscale sidecar](./tailscale.md) | You want private operator access, automatic HTTPS on a `*.ts.net` name, or an optional public Funnel. |
| [Configuration reference](./configuration.md) | You need to know what an environment variable does. |
| [First launch](./first-launch.md) | The containers are up and you need the first administrator. |
| [Health checks](./health-checks.md) | You wire probes into a proxy, PaaS, or monitor. |

## Upgrade

| Page | Use it when |
| --- | --- |
| [Upgrading](./upgrading.md) | Release channels, pulling the latest build, and how the data store upgrades itself on boot. |
| [Backups](./backups.md) | Before every upgrade, and on a schedule. |
| [Rollback](./rollback.md) | An upgrade went wrong and you need the previous build back. |
| [Rolling updates](./rolling-updates.md) | You want zero-downtime deploys (old and new containers overlap). |

## Trusted setup

| Page | Use it when |
| --- | --- |
| [Groth16 ceremony](./ceremony.md) | You coordinate the phase-2 trusted-setup ceremony for the production circuits. |

## Community

| Page | Use it when |
| --- | --- |
| [Community forum (optional Discourse)](./discourse.md) | You want constituents to discuss polls and elections on an open-source forum next to the Node. |

## What runs

| Service | Image | Role |
| --- | --- | --- |
| `node` | built from `Dockerfile` (`node:22-bookworm-slim`) | Voter, officer, and public web app plus the JSON API. Stores its data in one JSON file on the `node-data` volume. |
| `l2` | built from `l2/Dockerfile` | Civic sequencer (JSON-RPC on 8546). |
| `prover` | same as `l2` | Batch prover. |
| `archive` | same as `l2` | Hourly archive of sealed blocks to S3 or R2. Safe no-op when no bucket is set. |
| `tailscale` (optional) | `tailscale/tailscale:stable` | Joins the Node to your tailnet and terminates HTTPS. See [Tailscale sidecar](./tailscale.md). |

There is **no Postgres and no Redis** to run. The Node keeps its state in `$DATA_DIR/zk-voting.json` (the file name is kept for compatibility with existing installs).

## Deeper reading

- `docs/OPERATOR.md` — full operator runbook (chain deploys, guardians, L1 certification).
- `docs/ROLLING_UPDATES.md` — writer lease, fencing, and failure modes during overlap.
- `docs/ARCHITECTURE.md` — package map and interfaces.

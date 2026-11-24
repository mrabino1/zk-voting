# Self-hosting zk-voting

**NOT FOR PROFIT** — civic public good. Not a commercial product.

zk-voting is built to be forked and run by anyone who needs to read the will of the people: a city, a union, a cooperative, a school board, a club. This section explains how to install a Node, put it on the internet (or a private tailnet), launch it for the first time, and keep it up to date.

The same pages are served by every running Node at `/docs`, so operators can read them without leaving the app.

> **Your fork, your name.** "ZK-Voting" is only the default. Set `BRAND_NAME`, the `CLIENT_*`
> variables and the theme from Site admin; a fork changes configuration, not code, so it can keep
> merging upstream releases.

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
| [Forking and staying current](./forking.md) | You run your own fork and want to keep taking upstream releases without conflicts. |

## Trusted setup

| Page | Use it when |
| --- | --- |
| [Groth16 ceremony](./ceremony.md) | You coordinate the phase-2 trusted-setup ceremony for the production circuits. |

## Community

| Page | Use it when |
| --- | --- |
| [Community forum (optional Discourse)](./discourse.md) | You want constituents to discuss polls and elections on an open-source forum next to the Node, and you need the rule for when a result may be mentioned. |

## What runs

| Service | Image | Role |
| --- | --- | --- |
| `node` | built from `Dockerfile` (`node:24-bookworm-slim`) | Voter, officer and public web app plus the JSON API. Runs polls itself; publishes civic votes to L1 and relays their ballots to `l2`. |
| `l2` | built from `l2/Dockerfile` | The rollup operator: takes ballots from the node, commits and executes batches on ZkVotingRollup. |
| `db` | `postgres:16-alpine` | The node's state. |
| `l1` (profile `local-l1`) | Foundry (Anvil) | A local Ethereum chain (31337) for a laptop or a test install. |
| `l1-deploy` (profile `local-l1`) | Foundry | One-shot: deploys ZkVotingRollup on the local chain and writes the deployment record the node and `l2` read. |
| `tailscale` (optional) | `tailscale/tailscale:stable` | Joins the Node to your tailnet and terminates HTTPS. See [Tailscale sidecar](./tailscale.md). |

The default `.env` (`COMPOSE_PROFILES=local-l1`) runs the whole stack on one machine with no
paid service and no public chain: a fork works out of the box. To settle on a public chain, point
`L1_RPC` and `ROLLUP_ADDRESS` at the one shared ZkVotingRollup deployment instead (step 6 of
`./setup.sh`). Until the batch validity circuit is built, settlement works only on the local chain
(see "Known limits" in the root README).

## Deeper reading

- `docs/OPERATOR.md` — full operator runbook (the rollup, guardians, keys).
- `smart-contracts/docs/ROLLUP.md` — the rollup design: one L1 contract, sum-only results.
- `docs/ROLLING_UPDATES.md` — writer lease, fencing, and failure modes during overlap.
- `docs/ARCHITECTURE.md` — package map and interfaces.

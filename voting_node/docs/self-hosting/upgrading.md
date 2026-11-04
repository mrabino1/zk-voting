# Upgrading

**NOT FOR PROFIT** — civic public good. Not a commercial product.

## Release channels

| Channel | Branch | Use for |
| --- | --- | --- |
| **Stable** | `master` | Production. Changes reach `master` only after they have run on `test/unstable`. |
| **Unstable** | `test/unstable` | Staging and development. Newest features, may break. |

Images are built from source by your host (`docker compose up --build`, Coolify, Dokploy). Published, versioned images are planned; when they exist this page will list their tags.

Do not deploy `test/unstable` to a host that is running a binding election.

## Before you upgrade

1. Read the commits or release notes since your current version: `git log --oneline HEAD..origin/master`.
2. Do not upgrade while polls are open unless the change is a security fix.
3. **Take a backup** of both volumes: [Backups](./backups.md).
4. Note the current commit (`git rev-parse HEAD`) so you can [roll back](./rollback.md).

## Pull the latest build

### Plain Compose

```bash
cd zk-voting
git fetch origin
git checkout master && git pull --ff-only
docker compose pull            # refreshes third-party images (tailscale/tailscale:stable)
docker compose up -d --build   # rebuilds node and l2 from the new source
curl -fsS http://127.0.0.1:3000/health
```

Add `-f docker-compose.tailscale.yml` to each command if you use the Tailscale file. `./system_actions.sh deploy-prod` does the same pull, build, and restart (it asks for confirmation first).

### Coolify / Dokploy

Click **Redeploy** (or enable auto-deploy on the branch). The platform pulls the branch, rebuilds, and swaps containers. With Coolify's rolling strategy, old and new containers overlap safely: see [Rolling updates](./rolling-updates.md).

## Data upgrades on boot

There are no `.sql` files and nothing to run by hand.

- The Node keeps its data in one JSON file, or in Postgres when `DATABASE_URL` is set. When a new version starts, it fills in any collections or fields that the new code expects and raises the stored schema version (`meta.version`). These upgrades are additive: existing records are not rewritten or removed.
- Passkey credentials gain `coseAlg` on that boot (JSON file and Postgres migration 3). A missing algorithm is read from the stored COSE key, or set to ES256 (`-7`) when the key does not decode. Details and rollback: [Passkeys](../PASSKEYS.md#passkey-algorithms).
- Only the process that holds the **writer lease** saves the upgraded file. A standby process upgrades its in-memory copy and writes nothing until it becomes the writer.
- CI fails any change that adds a `.sql` file, and boots the production image against an empty volume before merge.

Because upgrades are additive, an older build can usually read a file written by a newer one. Still, restore the backup when you [roll back](./rollback.md) across many versions.

## Breaking: legacy name removed (reset test data; rename env vars)

Earlier builds used the legacy product name in identifiers. This release removes it everywhere and uses `zk-voting` / `ZK_VOTING_*` / `ZkVoting*`. It is a **clean break**: there is no fallback that reads the old names, and there is no data migration.

**Reset test data.** Hash-scheme ids, the election-id domain, PRF key-derivation salts, receipt and outcome-report schemas, and token-poll signing data all changed. Election ids, jurisdiction-derived ids, passkey-wrapped account keys and receipts made by an older build do not verify under this one. Back up, then start from empty volumes (or delete the old data file) and redeploy the contracts. Do not upgrade a host that holds a binding election.

**Rename every environment variable** that started with the old prefix to the `ZK_VOTING_` prefix. An old variable is now ignored, so the Node falls back to the default value.

| Old | New |
| --- | --- |
| `<old>_NODE_URL` | `ZK_VOTING_NODE_URL` |
| `<old>_RPC_URL` | `ZK_VOTING_RPC_URL` |
| `<old>_L2_RPC_URL` | `ZK_VOTING_L2_RPC_URL` |
| `<old>_CHAIN_ID` | `ZK_VOTING_CHAIN_ID` |
| `<old>_L2_CHAIN_ID` | `ZK_VOTING_L2_CHAIN_ID` |
| `<old>_API_KEY` | `ZK_VOTING_API_KEY` |
| `<old>_STORE_FILE` | `ZK_VOTING_STORE_FILE` |
| `<old>_ELECTION_NAMESPACE` | `ZK_VOTING_ELECTION_NAMESPACE` |
| `<old>_HASH_SCHEME` | `ZK_VOTING_HASH_SCHEME` |
| `<old>_PROVING_PATH` | `ZK_VOTING_PROVING_PATH` |
| `<old>_USE_MOCK_VERIFIER` | `ZK_VOTING_USE_MOCK_VERIFIER` |
| `<old>_ALLOW_MOCK_VERIFIER` | `ZK_VOTING_ALLOW_MOCK_VERIFIER` |
| `<old>_SETTLEMENT_MOCK_MODE` | `ZK_VOTING_SETTLEMENT_MOCK_MODE` |
| `<old>_VOTE_VERIFIER` | `ZK_VOTING_VOTE_VERIFIER` |
| `<old>_TALLY_VERIFIER` | `ZK_VOTING_TALLY_VERIFIER` |
| `<old>_PTAU_POWER` | `ZK_VOTING_PTAU_POWER` |
| `<old>_SMOKE_PTAU_POWER` | `ZK_VOTING_SMOKE_PTAU_POWER` |
| `<old>_CEREMONY_ENTROPY` | `ZK_VOTING_CEREMONY_ENTROPY` |

**Other renames you may see:**
- The data file is now `zk-voting.json`.
- The Compose network is now `zk-voting`.
- Cookies are now `zk-voting.sid` and `zk-voting.mfa`, so everyone signs in again.
- HTTP headers are now `X-ZK-Voting-*`. This includes the ingest secret, the provider secret, the API key, the minimum level and the mode headers.
- Receipt blocks now start with `BEGIN ZK-VOTING VOTE RECEIPT`.
- Contracts are now `ZkVotingEntryPoint`, `ZkVotingPaymaster` and `ZkVotingMailbox`.

Update any reverse-proxy rules, scripts or bots that set these headers or env vars.

## After you upgrade

- `/health` returns `"ok": true` and `docker compose ps` shows `healthy`.
- Sign in as an officer and open the admin hub.
- Check `docker compose logs --since 10m node l2` for errors.

## Base image

The Node image is built on `node:24-bookworm-slim`. Rebuild regularly (`docker compose build --pull`) so the base image picks up Node.js and Debian security updates.

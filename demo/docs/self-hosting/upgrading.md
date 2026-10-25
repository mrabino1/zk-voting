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

There are no SQL migrations and nothing to run by hand.

- The Node keeps its data in one JSON file. When a new version starts, it fills in any collections or fields that the new code expects and raises the stored schema version (`meta.version`). These upgrades are additive: existing records are not rewritten or removed.
- Only the process that holds the **writer lease** saves the upgraded file. A standby process upgrades its in-memory copy and writes nothing until it becomes the writer.
- CI fails any change that adds a `.sql` file, and boots the production image against an empty volume before merge.

Because upgrades are additive, an older build can usually read a file written by a newer one. Still, restore the backup when you [roll back](./rollback.md) across many versions.

## After you upgrade

- `/health` returns `"ok": true` and `docker compose ps` shows `healthy`.
- Sign in as an officer and open the admin hub.
- Check `docker compose logs --since 10m node l2` for errors.

## Base image

The Node image is built on `node:22-bookworm-slim`. Rebuild regularly (`docker compose build --pull`) so the base image picks up Node.js and Debian security updates.

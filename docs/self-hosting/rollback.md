# Rollback

**NOT FOR PROFIT** — civic public good. Not a commercial product.

If an upgrade misbehaves, go back to the commit you noted before upgrading.

## Plain Compose

```bash
cd zk-voting
git checkout <previous-commit>
docker compose up -d --build
curl -fsS http://127.0.0.1:3000/health
```

When the check passes, return the checkout to a branch later with `git checkout master`.

## Coolify / Dokploy

Open the resource's **Deployments** list and redeploy the previous successful deployment (Coolify: **Rollback** on an earlier image). Volumes are untouched.

## When to restore data too

Data upgrades on boot only add fields, so the previous build normally runs on the newer file. Restore the pre-upgrade [backup](./backups.md) as well when:

- the release notes say the change is not backward compatible;
- the older build fails to start or reports store errors in `docker compose logs node`;
- you are rolling back across many releases.

Votes accepted after the backup was taken would be lost by a restore. Do not restore over an election that took ballots after the backup; ask on the issue tracker first.

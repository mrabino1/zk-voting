# Backups

**NOT FOR PROFIT** — civic public good. Not a commercial product.

Node app state lives in Postgres (`postgres-data`). Ceremony files and the writer lease stay on `node-data`. The L2 chain stays on `l2-data`.

| Store | Contains | Loss means |
| --- | --- | --- |
| `postgres-data` | Accounts, rolls, elections, ballots, receipts, officers | Voters and officers must start over. Move it with `pg_dump` / `pg_restore`. |
| `node-data` | Ceremony files, plugin uploads, writer lease | Ceremony artifacts and the lease are gone. App state remains in Postgres. |
| `l2-data` | Sealed L2 blocks, proofs, mempool, archive state | Chain history on this host. Restorable from the S3/R2 archive if enabled. |

Dump the database without copying the volume by hand:

```bash
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > backups/zk-voting-$(date +%Y%m%d-%H%M%S).sql
```

Restore that dump into an empty database with `psql` before the node starts writing. Take the volume copies below from the same moment when you also need the chain and the ceremony files.

Compose prefixes volume names with the project name, for example `zk-voting_node-data`. List them with `docker volume ls`.

## Back up

A consistent copy needs the writers stopped for a moment:

```bash
docker compose stop node l2 prover archive db
mkdir -p backups
for v in postgres-data node-data l2-data; do
  docker run --rm -v zk-voting_${v}:/v:ro -v "$PWD/backups":/b alpine \
    tar -czf /b/${v}-$(date +%Y%m%d-%H%M%S).tgz -C /v .
done
docker compose start db l2 prover archive node
```

The `pg_dump` above is the copy to use when moving the app to another host. The volume archive is the copy of the files on this host.

## Where to keep backups

- Off the host (object storage, another machine). Encrypt them: they contain personal data.
- Keep at least one copy from before every upgrade.
- Coolify and Dokploy can schedule volume backups to S3-compatible storage from their UI.
- The archive service already copies sealed L2 hours to S3/R2 when `ARCHIVE_S3_BUCKET` is set.

## Restore

```bash
docker compose down        # keeps volumes
for v in postgres-data node-data l2-data; do
  docker run --rm -v zk-voting_${v}:/v -v "$PWD/backups":/b alpine \
    sh -c "rm -rf /v/* && tar -xzf /b/${v}-YYYYMMDD-HHMMSS.tgz -C /v"
done
docker compose up -d
```

Restore the database and both file volumes from the same point in time. After roll freeze, do not edit a dump by hand to change a tally.

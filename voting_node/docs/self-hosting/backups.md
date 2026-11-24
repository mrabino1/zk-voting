# Backups

**NOT FOR PROFIT** — civic public good. Not a commercial product.

Node app state lives in Postgres (`postgres-data`). Ceremony files and the writer lease stay on `node-data`. The rollup operator's state stays on `l2-data`. Civic-vote results and batches are settled on L1 and need no backup there; your keys in `.env` do.

| Store | Contains | Loss means |
| --- | --- | --- |
| `postgres-data` | Accounts, rolls, elections, ballots, receipts, officers | Voters and officers must start over. Move it with `pg_dump` / `pg_restore`. |
| `node-data` | Ceremony files, plugin uploads, writer lease | Ceremony artifacts and the lease are gone. App state remains in Postgres. |
| `l2-data` | The operator's state (`rollup-operator.json`): the rollup state tree, ballots not yet in a batch, receipts, batch history | Ballots not yet batched are lost, and the operator cannot continue batching. Committed batches stay on L1; there is no tool yet to rebuild this file from L1. |
| `.env` | Database password, `ROLLUP_PRIVATE_KEY`, `OPERATOR_PRIVATE_KEY`, `L2_BALLOT_TOKEN` | The node's and the operator's L1 accounts. |

Dump the database without copying the volume by hand:

```bash
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > backups/zk-voting-$(date +%Y%m%d-%H%M%S).sql
```

Restore that dump into an empty database with `psql` before the node starts writing. Take the volume copies below from the same moment when you also need the chain and the ceremony files.

Compose prefixes volume names with the project name, for example `zk-voting_node-data`. List them with `docker volume ls`.

## Back up

A consistent copy needs the writers stopped for a moment:

```bash
docker compose stop node l2 db
mkdir -p backups
for v in postgres-data node-data l2-data; do
  docker run --rm -v zk-voting_${v}:/v:ro -v "$PWD/backups":/b alpine \
    tar -czf /b/${v}-$(date +%Y%m%d-%H%M%S).tgz -C /v .
done
docker compose start db l2 node
```

The `pg_dump` above is the copy to use when moving the app to another host. The volume archive is the copy of the files on this host.

## Where to keep backups

- Off the host (object storage, another machine). Encrypt them: they contain personal data.
- Keep at least one copy from before every upgrade.
- Coolify and Dokploy can schedule volume backups to S3-compatible storage from their UI.

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

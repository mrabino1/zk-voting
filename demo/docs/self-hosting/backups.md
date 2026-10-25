# Backups

**NOT FOR PROFIT** — civic public good. Not a commercial product.

All state lives in two Docker volumes. There is no database server to dump.

| Volume | Contains | Loss means |
| --- | --- | --- |
| `node-data` | `republic.json` (people, rolls, elections, receipts, officers), `receipt-pdf.secret`, lease files | Voters and officers must start over. |
| `l2-data` | Sealed L2 blocks, proofs, mempool, archive state | Chain history on this host. Restorable from the S3/R2 archive if enabled. |

Compose prefixes volume names with the project name, for example `zk-voting_node-data`. List them with `docker volume ls`.

## Back up

A consistent copy needs the writers stopped for a moment:

```bash
docker compose stop node l2 prover archive
mkdir -p backups
for v in node-data l2-data; do
  docker run --rm -v zk-voting_${v}:/v:ro -v "$PWD/backups":/b alpine \
    tar -czf /b/${v}-$(date +%Y%m%d-%H%M%S).tgz -C /v .
done
docker compose start l2 prover archive node
```

For a backup without downtime, copy `republic.json` from the running container. It is replaced atomically on every save, so a single copy is always a complete file:

```bash
docker compose cp node:/data/republic.json backups/republic-$(date +%Y%m%d-%H%M%S).json
```

## Where to keep backups

- Off the host (object storage, another machine). Encrypt them: they contain personal data.
- Keep at least one copy from before every upgrade.
- Coolify and Dokploy can schedule volume backups to S3-compatible storage from their UI.
- The archive service already copies sealed L2 hours to S3/R2 when `ARCHIVE_S3_BUCKET` is set.

## Restore

```bash
docker compose down        # keeps volumes
docker run --rm -v zk-voting_node-data:/v -v "$PWD/backups":/b alpine \
  sh -c 'rm -rf /v/* && tar -xzf /b/node-data-YYYYMMDD-HHMMSS.tgz -C /v'
docker run --rm -v zk-voting_l2-data:/v -v "$PWD/backups":/b alpine \
  sh -c 'rm -rf /v/* && tar -xzf /b/l2-data-YYYYMMDD-HHMMSS.tgz -C /v'
docker compose up -d
```

Restore both volumes from the same point in time. After roll freeze, never edit `republic.json` by hand to "fix" a tally.

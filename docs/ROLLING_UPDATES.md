# Rolling updates

NOT FOR PROFIT. This is the handover used when Coolify (or any other runner) starts the new container before it stops the old one. Old and new share one data volume on one host. Only one of them writes.

## Failure modes

| Overlap | What goes wrong | What this repo does |
| --- | --- | --- |
| Two sequencers | Two block producers, forked block numbers, or a second empty heartbeat block | Sequencer lease. Standby `tickProducer` returns before `shouldProduceBlock` |
| Two Node writers | Torn `republic.json`, duplicate votes or registrations | Node lease. Mutations return HTTP 503 |
| Two provers | `submitBatch` sent twice for one `batchIndex` | Prover lease, plus cursor / on-disk record / L1 `batchCount` checked before send |
| Two archive jobs | The same hour pruned twice, or pruned before upload | Archive lease, then the existing archive lock. Default-on with no bucket does not prune |
| Two explorer ingests | The same L2 block appended twice | Dedupe by block hash |
| Crash, no SIGTERM | The lock directory is left behind | Steal after the lease TTL (default 8s) and bump the fencing epoch |
| Healthcheck that fails while standby | Coolify never marks the new container healthy, so it never stops the old one | `/health` is HTTP 200 with `ok: true` for active and standby |

File locks only work when both containers mount the **same** Docker volume on the **same** host. They do not coordinate two hosts, and they are not reliable on NFS. If the volume cannot be shared, do not use a rolling update: stop the old container first.

## Lease

`l2/lease/lease.mjs` is the lock. `mkdir` of `dataDir/leases/<role>.lock` is the atomic acquire. The owner file records `ownerId`, `epoch`, `pid`, `heartbeat`, and `ttlMs`. The epoch file is `leases/<role>.epoch`.

Roles are separate, so the sequencer and the archive can both be active on `l2-data`:

| Role | Process | Volume |
| --- | --- | --- |
| `sequencer` | `l2` | `l2-data` |
| `prover` | `prover` | `l2-data` |
| `archive` | `archive` | `l2-data` |
| `node` | `node` | `node-data` |

A new container that cannot get the lease starts **standby**:

- It serves reads.
- `/health` stays ready (`ok: true`, `mode: "standby"`).
- It does not produce blocks, prove, prune, ingest, or mutate the store.
- It polls about once a second.

The old container, on SIGTERM, stops accepting new writes, finishes the in-flight block or JSON write, flushes mempool and sealed votes, deletes the lock directory, and exits 0. `stop_grace_period` is 30s. A graceful release does **not** bump the epoch. The next holder reuses it.

A crashed holder is taken over after the TTL. Steal renames the lock directory aside (only one rename wins), bumps the epoch, and creates a new lock. Writes call `assertFence()`. A stale owner is rejected. The chain heartbeat (`L2_HEARTBEAT_SECONDS`, default 3600) is not this lease renew interval (default 2s).

## Skip-empty blocks and archive

Skip-empty stays on by default (`L2_SKIP_EMPTY_BLOCKS=1`). The producer seals when there is a transaction, when the disclosure hour closes, or when the chain heartbeat has elapsed. `tickProducer` checks the lease **before** `shouldProduceBlock`, so a standby cannot seal a second heartbeat block for the same head. `produceBlock()` still seals immediately for the holder (tests and a manual mine).

Archive stays on by default (`ARCHIVE_ENABLED=1`, `ARCHIVE_COMPRESS=1`). With an empty bucket and no `file://` sink the holder warns and does not prune. The job still takes the archive lease first, so two daemons cannot both prune. The daemon holds that lease for the life of the process. A one-shot CLI run acquires and releases it.

## Idempotency

- L2: the same tx hash already in the chain, mempool, or sealed set returns that hash. A different payload with the same `(electionId, nullifier)`, the same `(type, electionId, identityCommitment)` for register/disqualify, or a second tally for the election is rejected. Block files are created with `O_EXCL`. An existing file or a parent-hash mismatch is refused. The block hash does not include the epoch; the epoch is stored beside it.
- Node: duplicate votes stay HTTP 409 `NULLIFIER_USED`. Standby mutations are HTTP 503 `STANDBY` with `Retry-After: 2`, before that check.
- Prover: never deploys. No `L1_RPC` keeps the local JSON proof path. `L1_RPC` set with a missing `SETTLEMENT_ADDRESS`, a missing or mismatched `L1_CHAIN_ID`, or `eth_getCode` of `0x` fails closed and does not advance the cursor. `submitBatch` is sent only when `batchIndex` equals L1 `batchCount`. The contract also reverts any other index.
- Explorer: a block hash already in `seenBlockHashes` imports nothing.

## Health

Do not require `mode=active` in the healthcheck. Both modes are success.

```json
{"ok":true,"ready":true,"mode":"active","acceptingWrites":true,"epoch":1}
```

`mode` is `active` or `standby`. The header is `x-republic-mode`. Node: `GET /health` on port 3000. Sequencer: `GET /health` on port 8546.

Clients (`apps/node/public/standby-retry.js`, the classic pages, and `@zk-voting/chain-client`) retry HTTP 503 and a JSON-RPC `maintenance handover` a few times, honoring `Retry-After` (capped at 5s). The voter sees a short pause.

## Coolify settings

Apply these on the Node service and the L2 sequencer service. Prover and archive have no HTTP healthcheck; they only write while they hold their lease.

| Setting | Value |
| --- | --- |
| Update strategy | Rolling update: start the new container, wait until it is healthy, then SIGTERM the old one |
| Node health path | `http://127.0.0.1:3000/health` |
| L2 health path | `http://127.0.0.1:8546/health` |
| Health success | HTTP 200 and `ok` is not `false`. This matches active **and** standby |
| Do not | Require `mode=active`, or treat standby as unhealthy |
| Stop grace | 30 seconds (`stop_grace_period: 30s` in `docker-compose.yml`) |
| Health interval / start period | Interval 10s. Node `start_period` 25s. L2 `start_period` 15s. Retries 12 |
| Volumes | `node-data` and `l2-data` are the same Docker volumes the old container already has. Persistent, single-attached to this host, shared by old and new during the overlap. Not a fresh volume per container |
| One host | Required. Two hosts do not share this file lock. Use stop-then-start instead |
| Archive | Leave `ARCHIVE_ENABLED` at the default `1`. Only the lease holder uploads or prunes. No bucket means warn and do not prune |
| L1 contracts | Deploy once (below). Containers only read addresses. Only the prover that holds the prover lease submits |

`docker-compose.rolling.yml` is the overlap smoke: `l2-next` on host port 8547 and `node-next` on host port 3001, same volumes. The first container stays `mode: "active"`. The second stays `mode: "standby"` and still returns HTTP 200.

## One-time L1 deploy

`RollupSettlement`, the Groth16 verifier, `L1TallyMirror`, and the election stack are deployed to Ethereum L1 **once**. Container start, a rolling update, and a second `forge script` run do not deploy them again.

1. From a workstation (not from the node, sequencer, prover, or archive container):

   ```bash
   npm run deploy:l1 -- --check
   DEPLOYMENTS_FILE="$DATA_DIR/deployments/$L1_CHAIN_ID.json" \
     forge script smart-contracts/script/DeployL1.s.sol \
     --rpc-url "$L1_RPC" --broadcast --private-key "$L1_PUBLISHER_PRIVATE_KEY"
   ```

   `DeployL1`, `DeployLocal`, and `DeployL2` call `DeployOnce` before `vm.startBroadcast()`. The same check is `tools/deploy/l1Guard.mjs`.

2. After broadcast, confirm code and write the record. Paste the printed lines into `.env`:

   ```bash
   SETTLEMENT_ADDRESS=0x… VERIFIER_ADDRESS=0x… L1_TALLY_MIRROR_ADDRESS=0x… \
   L1_SETTLEMENT_ADDRESS=0x… ELECTION_FACTORY_ADDRESS=0x… BALLOT_INBOX_ADDRESS=0x… \
     npm run deploy:l1 -- --verify
   ```

   `--verify` calls `eth_getCode`. Empty code fails. `deployments/template.json` is the committed empty template. The real `deployments/<chainId>.json` lives on the data volume or wherever `DEPLOYMENTS_FILE` points, and is gitignored.

3. A later run refuses when any of those address variables is set, or when the record has `deployed: true`. `FORCE_REDEPLOY=1` overrides it and prints a warning. Do not use that on a live election.

4. The prover reads `SETTLEMENT_ADDRESS` and `L1_CHAIN_ID`. If `L1_RPC` is set and the address is missing, has no code, or the chain id does not match, the prover does not submit and does not advance its cursor. `DEPLOY_ON_START` throws. During a rolling update only the prover lease holder submits.

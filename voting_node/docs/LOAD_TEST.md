# ZK-Voting local load test

**NOT FOR PROFIT** — civic public good. Not a commercial product.

This report lists figures produced by `tools/load/harness.mjs` against a ZK-Voting Node listening on `127.0.0.1`. Displayed latencies are rounded to 0.1 ms and throughputs to 0.01 ops/s. The JSON next to this file keeps the unrounded summaries. Nothing in the tables was filled in by hand.

## What ran

Each population is a new Node process state: its own data directory, one YES/NO election, tree depth 20, disclosure interval 3600 seconds (the production default is 3600; this run set that value). Client concurrency was 1 in-flight request(s).

The harness drove HTTP:

1. `POST /api/auth/dev-login` once per voter (`ALLOW_DEV_LOGIN`, role `voter`) and once for a `platform_admin` clerk.
2. `POST /api/elections` (clerk).
3. `POST /api/elections/:id/register` (voter) — pending civil review.
4. `POST /api/elections/:id/registration-requests/:requestId/approve` (clerk).
5. `POST /api/elections/:id/freeze` (clerk).
6. `POST /api/elections/:id/vote` with a unique nullifier and `{ proof: { accept: true } }`. No session cookie, so the relay path does not attach the voter to the ballot. `CHAIN_RPC` was unset, so votes stayed on the JSON demo path.
7. `GET /api/elections/:id/summary` while the disclosure hour was still open.
8. The harness then advanced that Node's `nowFn` by the disclosure interval plus 5 seconds (same clock the vote and disclosure routes use) and called `GET /api/elections/:id/summary`, `GET /api/elections/:id/ballots`, summary again, and `GET /api/explorer/blocks` with no `limit` query (the route default is 50 blocks). That is the hourly disclosure publish path without waiting 3600 seconds of wall clock.
9. The harness set `cutoffTime` on the live store to one second before wall-clock now (the tally route compares cutoff to `Date.now()`, which `nowFn` does not move) and `POST /api/elections/:id/tally` with counts `[acceptedBallots, 0]`.

Latency is time waiting on `fetch` for that request (nearest-rank p50/p95/p99). Throughput is successful responses divided by the phase's wall clock. CPU/wall is process CPU time (user + system) divided by wall time. The client and the server share this Node process, so CPU includes both. "Last/first quartile mean" splits successful requests in send order into the first and last quarter of the phase.

A phase stops the ladder when its wall time exceeds 300000 ms. Later populations are skipped.

## Run: before

Started 2026-09-27T13:07:25.403Z, finished 2026-09-27T13:11:32.903Z. At the largest completed population (800), the slowest phase by wall clock was `registration_approve` at 150168.0 ms.

| Fact | Value |
| --- | --- |
| Node | v22.14.0 |
| Platform | linux / x64 |
| CPUs | 4 × Intel(R) Xeon(R) Processor |
| Memory | 16014 MB |
| Load average at start | 0.09, 0.04, 0.00 |
| Data directory parent | /tmp |

### Dev-login (person provision) (`provision`)

| Phase | 100 | 200 | 400 | 800 |
| --- | ---: | ---: | ---: | ---: |
| ok / errors | 100/0 | 200/0 | 400/0 | 800/0 |
| throughput (ops/s) | 556.47 | 581.94 | 452.50 | 272.45 |
| mean ms | 1.8 | 1.7 | 2.2 | 3.7 |
| p50 ms | 1.6 | 1.6 | 2.0 | 3.0 |
| p95 ms | 2.8 | 2.2 | 3.5 | 5.6 |
| max ms | 5.7 | 3.8 | 13.3 | 365.2 |
| wall ms | 179.7 | 343.7 | 884.0 | 2936.3 |
| CPU/wall | 1.15 | 1.16 | 1.07 | 0.90 |
| last/first quartile mean | 0.87 | 1.33 | 2.10 | 1.41 |

### Registration request (`registration_request`)

| Phase | 100 | 200 | 400 | 800 |
| --- | ---: | ---: | ---: | ---: |
| ok / errors | 100/0 | 200/0 | 400/0 | 800/0 |
| throughput (ops/s) | 442.69 | 421.85 | 237.80 | 128.66 |
| mean ms | 2.3 | 2.4 | 4.2 | 7.8 |
| p50 ms | 2.2 | 2.3 | 4.0 | 6.9 |
| p95 ms | 2.9 | 3.0 | 6.0 | 12.3 |
| max ms | 3.5 | 4.9 | 8.2 | 366.2 |
| wall ms | 225.9 | 474.1 | 1682.1 | 6217.7 |
| CPU/wall | 1.09 | 1.05 | 0.87 | 0.99 |
| last/first quartile mean | 1.15 | 1.27 | 1.76 | 1.63 |

### Registration approve (`registration_approve`)

| Phase | 100 | 200 | 400 | 800 |
| --- | ---: | ---: | ---: | ---: |
| ok / errors | 100/0 | 200/0 | 400/0 | 800/0 |
| throughput (ops/s) | 38.37 | 20.67 | 10.00 | 5.33 |
| mean ms | 26.1 | 48.4 | 100.0 | 187.7 |
| p50 ms | 27.3 | 47.5 | 99.9 | 191.4 |
| p95 ms | 43.2 | 86.1 | 190.9 | 340.0 |
| max ms | 47.8 | 131.2 | 327.7 | 412.7 |
| wall ms | 2606.4 | 9675.5 | 40014.9 | 150168.0 |
| CPU/wall | 1.02 | 0.97 | 0.97 | 1.00 |
| last/first quartile mean | 4.27 | 4.38 | 5.07 | 4.97 |

### Freeze roll (`freeze`)

| Phase | 100 | 200 | 400 | 800 |
| --- | ---: | ---: | ---: | ---: |
| ok / errors | 1/0 | 1/0 | 1/0 | 1/0 |
| throughput (ops/s) | 22.05 | 11.57 | 5.44 | 2.96 |
| mean ms | 45.3 | 86.4 | 183.7 | 338.2 |
| p50 ms | 45.3 | 86.4 | 183.7 | 338.2 |
| p95 ms | 45.3 | 86.4 | 183.7 | 338.2 |
| max ms | 45.3 | 86.4 | 183.7 | 338.2 |
| wall ms | 45.4 | 86.4 | 183.7 | 338.2 |
| CPU/wall | 0.99 | 0.99 | 1.03 | 1.10 |
| last/first quartile mean | 1.00 | 1.00 | 1.00 | 1.00 |

### Vote submission (`vote`)

| Phase | 100 | 200 | 400 | 800 |
| --- | ---: | ---: | ---: | ---: |
| ok / errors | 100/0 | 200/0 | 400/0 | 800/0 |
| throughput (ops/s) | 224.96 | 113.53 | 64.70 | 35.69 |
| mean ms | 4.4 | 8.8 | 15.5 | 28.0 |
| p50 ms | 4.2 | 8.1 | 14.3 | 26.0 |
| p95 ms | 6.3 | 11.7 | 22.3 | 31.8 |
| max ms | 8.6 | 84.7 | 141.8 | 441.5 |
| wall ms | 444.5 | 1761.7 | 6182.7 | 22414.0 |
| CPU/wall | 1.10 | 0.81 | 1.11 | 0.75 |
| last/first quartile mean | 1.02 | 1.06 | 1.23 | 1.24 |

### Disclosure read (hour still open) (`disclosure_sealed_read`)

| Phase | 100 | 200 | 400 | 800 |
| --- | ---: | ---: | ---: | ---: |
| ok / errors | 1/0 | 1/0 | 1/0 | 1/0 |
| throughput (ops/s) | 453.27 | 388.82 | 72.73 | 135.29 |
| mean ms | 2.2 | 2.6 | 13.7 | 7.4 |
| p50 ms | 2.2 | 2.6 | 13.7 | 7.4 |
| p95 ms | 2.2 | 2.6 | 13.7 | 7.4 |
| max ms | 2.2 | 2.6 | 13.7 | 7.4 |
| wall ms | 2.2 | 2.6 | 13.7 | 7.4 |
| CPU/wall | 1.00 | 1.00 | 3.18 | 0.94 |
| last/first quartile mean | 1.00 | 1.00 | 1.00 | 1.00 |

### Hourly disclosure publish (`disclosure_publish`)

| Phase | 100 | 200 | 400 | 800 |
| --- | ---: | ---: | ---: | ---: |
| ok / errors | 1/0 | 1/0 | 1/0 | 1/0 |
| throughput (ops/s) | 77.31 | 47.94 | 20.62 | 7.36 |
| mean ms | 12.9 | 20.9 | 48.5 | 135.8 |
| p50 ms | 12.9 | 20.9 | 48.5 | 135.8 |
| p95 ms | 12.9 | 20.9 | 48.5 | 135.8 |
| max ms | 12.9 | 20.9 | 48.5 | 135.8 |
| wall ms | 12.9 | 20.9 | 48.5 | 135.8 |
| CPU/wall | 0.96 | 1.40 | 1.05 | 1.07 |
| last/first quartile mean | 1.00 | 1.00 | 1.00 | 1.00 |

### Disclosed ballot list (`disclosure_ballots`)

| Phase | 100 | 200 | 400 | 800 |
| --- | ---: | ---: | ---: | ---: |
| ok / errors | 1/0 | 1/0 | 1/0 | 1/0 |
| throughput (ops/s) | 315.52 | 471.24 | 291.47 | 187.98 |
| mean ms | 3.2 | 2.1 | 3.4 | 5.3 |
| p50 ms | 3.2 | 2.1 | 3.4 | 5.3 |
| p95 ms | 3.2 | 2.1 | 3.4 | 5.3 |
| max ms | 3.2 | 2.1 | 3.4 | 5.3 |
| wall ms | 3.2 | 2.1 | 3.4 | 5.3 |
| CPU/wall | 2.04 | 1.20 | 0.91 | 1.28 |
| last/first quartile mean | 1.00 | 1.00 | 1.00 | 1.00 |

### Disclosure read after publish (`disclosure_reread`)

| Phase | 100 | 200 | 400 | 800 |
| --- | ---: | ---: | ---: | ---: |
| ok / errors | 1/0 | 1/0 | 1/0 | 1/0 |
| throughput (ops/s) | 579.10 | 378.56 | 338.22 | 218.89 |
| mean ms | 1.7 | 2.6 | 3.0 | 4.6 |
| p50 ms | 1.7 | 2.6 | 3.0 | 4.6 |
| p95 ms | 1.7 | 2.6 | 3.0 | 4.6 |
| max ms | 1.7 | 2.6 | 3.0 | 4.6 |
| wall ms | 1.7 | 2.6 | 3.0 | 4.6 |
| CPU/wall | 0.93 | 0.79 | 0.90 | 0.92 |
| last/first quartile mean | 1.00 | 1.00 | 1.00 | 1.00 |

### Explorer block list (`disclosure_explorer`)

| Phase | 100 | 200 | 400 | 800 |
| --- | ---: | ---: | ---: | ---: |
| ok / errors | 1/0 | 1/0 | 1/0 | 1/0 |
| throughput (ops/s) | 465.43 | 537.21 | 315.52 | 177.81 |
| mean ms | 2.1 | 1.9 | 3.2 | 5.6 |
| p50 ms | 2.1 | 1.9 | 3.2 | 5.6 |
| p95 ms | 2.1 | 1.9 | 3.2 | 5.6 |
| max ms | 2.1 | 1.9 | 3.2 | 5.6 |
| wall ms | 2.1 | 1.9 | 3.2 | 5.6 |
| CPU/wall | 0.79 | 1.41 | 0.83 | 1.06 |
| last/first quartile mean | 1.00 | 1.00 | 1.00 | 1.00 |

### Tally (`tally`)

| Phase | 100 | 200 | 400 | 800 |
| --- | ---: | ---: | ---: | ---: |
| ok / errors | 1/0 | 1/0 | 1/0 | 1/0 |
| throughput (ops/s) | 49.32 | 64.58 | 40.06 | 23.33 |
| mean ms | 20.3 | 15.5 | 25.0 | 42.9 |
| p50 ms | 20.3 | 15.5 | 25.0 | 42.9 |
| p95 ms | 20.3 | 15.5 | 25.0 | 42.9 |
| max ms | 20.3 | 15.5 | 25.0 | 42.9 |
| wall ms | 20.3 | 15.5 | 25.0 | 42.9 |
| CPU/wall | 1.68 | 1.38 | 0.80 | 0.84 |
| last/first quartile mean | 1.00 | 1.00 | 1.00 | 1.00 |

### Errors

_No phase reported an HTTP or client error._

### Disclosure counts

- Population 100: disclosed ballots before the hour closed 0; after the harness advanced the Node clock, publish reported 100 and the ballot list returned 100. Votes accepted in this scale: 100.
- Population 200: disclosed ballots before the hour closed 0; after the harness advanced the Node clock, publish reported 200 and the ballot list returned 200. Votes accepted in this scale: 200.
- Population 400: disclosed ballots before the hour closed 0; after the harness advanced the Node clock, publish reported 400 and the ballot list returned 400. Votes accepted in this scale: 400.
- Population 800: disclosed ballots before the hour closed 0; after the harness advanced the Node clock, publish reported 800 and the ballot list returned 800. Votes accepted in this scale: 800.

### Tally outcomes

- Population 100: tally HTTP 200, acceptedBallots on the store 100, counts [100,0] , L1 status skipped, outcome subscribers 0.
- Population 200: tally HTTP 200, acceptedBallots on the store 200, counts [200,0] , L1 status skipped, outcome subscribers 0.
- Population 400: tally HTTP 200, acceptedBallots on the store 400, counts [400,0] , L1 status skipped, outcome subscribers 0.
- Population 800: tally HTTP 200, acceptedBallots on the store 800, counts [800,0] , L1 status skipped, outcome subscribers 0.

### Latency growth inside a phase

- At population 100, `registration_approve` last-quartile mean latency was 40.7 ms versus 9.5 ms in the first quartile (ratio 4.27).
- At population 200, `registration_approve` last-quartile mean latency was 79.2 ms versus 18.1 ms in the first quartile (ratio 4.38).
- At population 400, `registration_approve` last-quartile mean latency was 173.3 ms versus 34.2 ms in the first quartile (ratio 5.07).
- At population 400, `registration_request` last-quartile mean latency was 5.4 ms versus 3.1 ms in the first quartile (ratio 1.76).
- At population 400, `provision` last-quartile mean latency was 3.0 ms versus 1.4 ms in the first quartile (ratio 2.10).
- At population 800, `registration_approve` last-quartile mean latency was 312.7 ms versus 62.9 ms in the first quartile (ratio 4.97).
- At population 800, `registration_request` last-quartile mean latency was 9.3 ms versus 5.7 ms in the first quartile (ratio 1.63).

### CPU versus wall

- At population 100, `provision` spent CPU/wall 1.15 over 179.7 ms wall (206.5 ms CPU). The phase was CPU-bound in this shared process.
- At population 100, `registration_request` spent CPU/wall 1.09 over 225.9 ms wall (246.7 ms CPU). The phase was CPU-bound in this shared process.
- At population 100, `registration_approve` spent CPU/wall 1.02 over 2606.4 ms wall (2659.8 ms CPU). The phase was CPU-bound in this shared process.
- At population 100, `vote` spent CPU/wall 1.10 over 444.5 ms wall (490.2 ms CPU). The phase was CPU-bound in this shared process.
- At population 200, `provision` spent CPU/wall 1.16 over 343.7 ms wall (398.8 ms CPU). The phase was CPU-bound in this shared process.
- At population 200, `registration_request` spent CPU/wall 1.05 over 474.1 ms wall (498.6 ms CPU). The phase was CPU-bound in this shared process.
- At population 200, `registration_approve` spent CPU/wall 0.97 over 9675.5 ms wall (9383.4 ms CPU). The phase was CPU-bound in this shared process.
- At population 200, `freeze` spent CPU/wall 0.99 over 86.4 ms wall (85.4 ms CPU). The phase was CPU-bound in this shared process.
- At population 200, `vote` spent CPU/wall 0.81 over 1761.7 ms wall (1421.0 ms CPU). The phase was CPU-bound in this shared process.
- At population 400, `provision` spent CPU/wall 1.07 over 884.0 ms wall (945.3 ms CPU). The phase was CPU-bound in this shared process.
- At population 400, `registration_request` spent CPU/wall 0.87 over 1682.1 ms wall (1458.2 ms CPU). The phase was CPU-bound in this shared process.
- At population 400, `registration_approve` spent CPU/wall 0.97 over 40014.9 ms wall (38654.4 ms CPU). The phase was CPU-bound in this shared process.
- At population 400, `freeze` spent CPU/wall 1.03 over 183.7 ms wall (189.8 ms CPU). The phase was CPU-bound in this shared process.
- At population 400, `vote` spent CPU/wall 1.11 over 6182.7 ms wall (6874.2 ms CPU). The phase was CPU-bound in this shared process.
- At population 800, `provision` spent CPU/wall 0.90 over 2936.3 ms wall (2638.6 ms CPU). The phase was CPU-bound in this shared process.
- At population 800, `registration_request` spent CPU/wall 0.99 over 6217.7 ms wall (6177.1 ms CPU). The phase was CPU-bound in this shared process.
- At population 800, `registration_approve` spent CPU/wall 1.00 over 150168.0 ms wall (150460.6 ms CPU). The phase was CPU-bound in this shared process.
- At population 800, `freeze` spent CPU/wall 1.10 over 338.2 ms wall (371.8 ms CPU). The phase was CPU-bound in this shared process.
- At population 800, `disclosure_publish` spent CPU/wall 1.07 over 135.8 ms wall (145.0 ms CPU). The phase was CPU-bound in this shared process.

### Store files

- Population 100: `zk-voting.json` 435352 bytes, `l2-chain.json` 155690 bytes.
  One snapshot of that `zk-voting.json`: pretty stringify 0.6 ms (435352 bytes), compact stringify 0.4 ms (359769 bytes), pretty write 0.3 ms.
- Population 200: `zk-voting.json` 841200 bytes, `l2-chain.json` 307990 bytes.
  One snapshot of that `zk-voting.json`: pretty stringify 1.1 ms (841200 bytes), compact stringify 0.8 ms (692117 bytes), pretty write 1.4 ms.
- Population 400: `zk-voting.json` 1653549 bytes, `l2-chain.json` 612590 bytes.
  One snapshot of that `zk-voting.json`: pretty stringify 2.2 ms (1653549 bytes), compact stringify 1.8 ms (1357466 bytes), pretty write 10.2 ms.
- Population 800: `zk-voting.json` 3276681 bytes, `l2-chain.json` 1221790 bytes.
  One snapshot of that `zk-voting.json`: pretty stringify 4.0 ms (3276681 bytes), compact stringify 3.0 ms (2686598 bytes), pretty write 1.7 ms.

### CPU profile

Separate process from the timing ladder: population 200, V8 profiler on, code before the tree append. Timings from that process are not in the tables above.
Inspector self-samples: 11743. Sampling interval is the V8 profiler default. Percents are this run's share of self-hits.
| Self % | Hits | Function | Location |
| ---: | ---: | --- | --- |
| 25.3 | 2974 | `keccakP` | file:///workspace/node_modules/@noble/hashes/esm/sha3.js:49 |
| 24.3 | 2859 | `keccakP` | file:///workspace/node_modules/@noble/hashes/esm/sha3.js:49 |
| 10.3 | 1208 | `(idle)` | —:0 |
| 5.5 | 645 | `(anonymous)` | file:///workspace/apps/node/src/store.mjs:230 |
| 4.3 | 501 | `(anonymous)` | file:///workspace/apps/node/src/store.mjs:230 |
| 2.6 | 306 | `hexToBytes` | file:///workspace/node_modules/viem/_esm/utils/encoding/toBytes.js:106 |
| 1.6 | 189 | `hexToBytes` | file:///workspace/node_modules/viem/_esm/utils/encoding/toBytes.js:106 |
| 1.5 | 177 | `(garbage collector)` | —:0 |
| 1.2 | 140 | `RegExp: ^0x[0-9a-fA-F]*$` | —:0 |
| 1.0 | 115 | `Keccak` | file:///workspace/node_modules/@noble/hashes/esm/sha3.js:97 |
| 0.8 | 98 | `Keccak` | file:///workspace/node_modules/@noble/hashes/esm/sha3.js:97 |
| 0.8 | 96 | `(program)` | —:0 |
| 0.8 | 91 | `(anonymous)` | file:///workspace/apps/node/src/explorer.mjs:91 |
| 0.8 | 91 | `refresh` | file:///workspace/apps/node/src/explorer.mjs:99 |
| 0.7 | 84 | `toBytes32` | file:///workspace/apps/node/src/merkle.mjs:10 |
| 0.7 | 81 | `RegExp: ^0x[0-9a-fA-F]*$` | —:0 |
| 0.5 | 64 | `toBytes32` | file:///workspace/apps/node/src/merkle.mjs:10 |
| 0.5 | 56 | `update` | file:///workspace/node_modules/@noble/hashes/esm/sha3.js:128 |
| 0.4 | 52 | `update` | file:///workspace/node_modules/@noble/hashes/esm/sha3.js:128 |
| 0.3 | 41 | `slice` | node:buffer:636 |


### Recommended limit for this run

Rule: largest completed population where registration request, registration approve, vote, hourly disclosure publish, and tally each had **zero errors** and **p95 under 1000 ms**.

Every completed scale passed p95 < 1000 ms with zero errors on registration_request, registration_approve, vote, disclosure_publish, tally. The largest population measured was **800**. Larger populations were not measured.

Half-rate rule for `registration_approve`: throughput at the smallest completed population (100) was 38.37 ops/s. Largest completed population still at or above half of that (19.18 ops/s) was **200**. Population 400 measured 10.00 ops/s, which is under that half-rate.

Half-rate rule for `vote`: throughput at the smallest completed population (100) was 224.96 ops/s. Largest completed population still at or above half of that (112.48 ops/s) was **200**. Population 400 measured 64.70 ops/s, which is under that half-rate.

## Run: after

Started 2026-09-27T13:18:39.595Z, finished 2026-09-27T13:19:34.115Z. At the largest completed population (800), the slowest phase by wall clock was `registration_approve` at 14962.0 ms.

| Fact | Value |
| --- | --- |
| Node | v22.14.0 |
| Platform | linux / x64 |
| CPUs | 4 × Intel(R) Xeon(R) Processor |
| Memory | 16014 MB |
| Load average at start | 0.08, 0.44, 0.33 |
| Data directory parent | /tmp |

### Dev-login (person provision) (`provision`)

| Phase | 100 | 200 | 400 | 800 |
| --- | ---: | ---: | ---: | ---: |
| ok / errors | 100/0 | 200/0 | 400/0 | 800/0 |
| throughput (ops/s) | 515.71 | 558.92 | 358.80 | 285.54 |
| mean ms | 1.9 | 1.8 | 2.8 | 3.5 |
| p50 ms | 1.7 | 1.7 | 2.1 | 2.8 |
| p95 ms | 3.0 | 2.5 | 3.1 | 5.9 |
| max ms | 10.9 | 3.8 | 256.2 | 284.1 |
| wall ms | 193.9 | 357.8 | 1114.8 | 2801.7 |
| CPU/wall | 1.17 | 1.14 | 0.86 | 0.87 |
| last/first quartile mean | 0.90 | 1.37 | 3.86 | 1.76 |

### Registration request (`registration_request`)

| Phase | 100 | 200 | 400 | 800 |
| --- | ---: | ---: | ---: | ---: |
| ok / errors | 100/0 | 200/0 | 400/0 | 800/0 |
| throughput (ops/s) | 443.79 | 401.99 | 226.23 | 119.88 |
| mean ms | 2.2 | 2.5 | 4.4 | 8.3 |
| p50 ms | 2.2 | 2.4 | 4.3 | 7.5 |
| p95 ms | 2.7 | 2.9 | 6.0 | 11.9 |
| max ms | 3.8 | 5.1 | 7.5 | 383.8 |
| wall ms | 225.3 | 497.5 | 1768.1 | 6673.2 |
| CPU/wall | 1.14 | 1.06 | 0.90 | 0.89 |
| last/first quartile mean | 1.05 | 1.18 | 1.32 | 1.64 |

### Registration approve (`registration_approve`)

| Phase | 100 | 200 | 400 | 800 |
| --- | ---: | ---: | ---: | ---: |
| ok / errors | 100/0 | 200/0 | 400/0 | 800/0 |
| throughput (ops/s) | 267.37 | 205.44 | 107.71 | 53.47 |
| mean ms | 3.7 | 4.9 | 9.3 | 18.7 |
| p50 ms | 3.6 | 4.7 | 8.1 | 16.9 |
| p95 ms | 5.0 | 6.7 | 11.8 | 24.3 |
| max ms | 6.6 | 8.6 | 399.4 | 481.5 |
| wall ms | 374.0 | 973.5 | 3713.7 | 14962.0 |
| CPU/wall | 1.10 | 0.98 | 0.74 | 0.98 |
| last/first quartile mean | 1.05 | 1.47 | 2.20 | 1.52 |

### Freeze roll (`freeze`)

| Phase | 100 | 200 | 400 | 800 |
| --- | ---: | ---: | ---: | ---: |
| ok / errors | 1/0 | 1/0 | 1/0 | 1/0 |
| throughput (ops/s) | 31.09 | 20.74 | 10.39 | 5.31 |
| mean ms | 32.2 | 48.2 | 96.3 | 188.4 |
| p50 ms | 32.2 | 48.2 | 96.3 | 188.4 |
| p95 ms | 32.2 | 48.2 | 96.3 | 188.4 |
| max ms | 32.2 | 48.2 | 96.3 | 188.4 |
| wall ms | 32.2 | 48.2 | 96.3 | 188.4 |
| CPU/wall | 2.00 | 1.00 | 1.02 | 1.16 |
| last/first quartile mean | 1.00 | 1.00 | 1.00 | 1.00 |

### Vote submission (`vote`)

| Phase | 100 | 200 | 400 | 800 |
| --- | ---: | ---: | ---: | ---: |
| ok / errors | 100/0 | 200/0 | 400/0 | 800/0 |
| throughput (ops/s) | 282.09 | 197.57 | 111.50 | 53.62 |
| mean ms | 3.5 | 5.1 | 9.0 | 18.6 |
| p50 ms | 3.2 | 4.8 | 8.6 | 17.6 |
| p95 ms | 5.4 | 7.1 | 11.6 | 21.2 |
| max ms | 9.3 | 8.9 | 13.3 | 337.7 |
| wall ms | 354.5 | 1012.3 | 3587.3 | 14920.3 |
| CPU/wall | 1.19 | 0.95 | 0.86 | 0.74 |
| last/first quartile mean | 1.03 | 1.31 | 1.28 | 1.16 |

### Disclosure read (hour still open) (`disclosure_sealed_read`)

| Phase | 100 | 200 | 400 | 800 |
| --- | ---: | ---: | ---: | ---: |
| ok / errors | 1/0 | 1/0 | 1/0 | 1/0 |
| throughput (ops/s) | 448.13 | 349.11 | 208.42 | 143.64 |
| mean ms | 2.2 | 2.9 | 4.8 | 7.0 |
| p50 ms | 2.2 | 2.9 | 4.8 | 7.0 |
| p95 ms | 2.2 | 2.9 | 4.8 | 7.0 |
| max ms | 2.2 | 2.9 | 4.8 | 7.0 |
| wall ms | 2.2 | 2.9 | 4.8 | 7.0 |
| CPU/wall | 1.00 | 0.89 | 0.77 | 1.10 |
| last/first quartile mean | 1.00 | 1.00 | 1.00 | 1.00 |

### Hourly disclosure publish (`disclosure_publish`)

| Phase | 100 | 200 | 400 | 800 |
| --- | ---: | ---: | ---: | ---: |
| ok / errors | 1/0 | 1/0 | 1/0 | 1/0 |
| throughput (ops/s) | 73.02 | 49.66 | 19.77 | 7.55 |
| mean ms | 13.7 | 20.1 | 50.6 | 132.5 |
| p50 ms | 13.7 | 20.1 | 50.6 | 132.5 |
| p95 ms | 13.7 | 20.1 | 50.6 | 132.5 |
| max ms | 13.7 | 20.1 | 50.6 | 132.5 |
| wall ms | 13.7 | 20.1 | 50.6 | 132.5 |
| CPU/wall | 0.96 | 1.46 | 1.08 | 1.04 |
| last/first quartile mean | 1.00 | 1.00 | 1.00 | 1.00 |

### Disclosed ballot list (`disclosure_ballots`)

| Phase | 100 | 200 | 400 | 800 |
| --- | ---: | ---: | ---: | ---: |
| ok / errors | 1/0 | 1/0 | 1/0 | 1/0 |
| throughput (ops/s) | 605.03 | 542.99 | 267.14 | 166.49 |
| mean ms | 1.6 | 1.8 | 3.7 | 6.0 |
| p50 ms | 1.6 | 1.8 | 3.7 | 6.0 |
| p95 ms | 1.6 | 1.8 | 3.7 | 6.0 |
| max ms | 1.6 | 1.8 | 3.7 | 6.0 |
| wall ms | 1.7 | 1.8 | 3.7 | 6.0 |
| CPU/wall | 1.58 | 1.00 | 0.91 | 1.11 |
| last/first quartile mean | 1.00 | 1.00 | 1.00 | 1.00 |

### Disclosure read after publish (`disclosure_reread`)

| Phase | 100 | 200 | 400 | 800 |
| --- | ---: | ---: | ---: | ---: |
| ok / errors | 1/0 | 1/0 | 1/0 | 1/0 |
| throughput (ops/s) | 589.89 | 408.15 | 285.11 | 186.01 |
| mean ms | 1.7 | 2.4 | 3.5 | 5.4 |
| p50 ms | 1.7 | 2.4 | 3.5 | 5.4 |
| p95 ms | 1.7 | 2.4 | 3.5 | 5.4 |
| max ms | 1.7 | 2.4 | 3.5 | 5.4 |
| wall ms | 1.7 | 2.5 | 3.5 | 5.4 |
| CPU/wall | 0.96 | 1.02 | 0.86 | 1.04 |
| last/first quartile mean | 1.00 | 1.00 | 1.00 | 1.00 |

### Explorer block list (`disclosure_explorer`)

| Phase | 100 | 200 | 400 | 800 |
| --- | ---: | ---: | ---: | ---: |
| ok / errors | 1/0 | 1/0 | 1/0 | 1/0 |
| throughput (ops/s) | 582.51 | 553.35 | 335.80 | 195.52 |
| mean ms | 1.7 | 1.8 | 3.0 | 5.1 |
| p50 ms | 1.7 | 1.8 | 3.0 | 5.1 |
| p95 ms | 1.7 | 1.8 | 3.0 | 5.1 |
| max ms | 1.7 | 1.8 | 3.0 | 5.1 |
| wall ms | 1.7 | 1.8 | 3.0 | 5.1 |
| CPU/wall | 1.00 | 1.37 | 0.94 | 0.82 |
| last/first quartile mean | 1.00 | 1.00 | 1.00 | 1.00 |

### Tally (`tally`)

| Phase | 100 | 200 | 400 | 800 |
| --- | ---: | ---: | ---: | ---: |
| ok / errors | 1/0 | 1/0 | 1/0 | 1/0 |
| throughput (ops/s) | 59.16 | 68.22 | 42.31 | 20.29 |
| mean ms | 16.9 | 14.7 | 23.6 | 49.3 |
| p50 ms | 16.9 | 14.7 | 23.6 | 49.3 |
| p95 ms | 16.9 | 14.7 | 23.6 | 49.3 |
| max ms | 16.9 | 14.7 | 23.6 | 49.3 |
| wall ms | 16.9 | 14.7 | 23.6 | 49.3 |
| CPU/wall | 1.91 | 1.66 | 0.88 | 0.73 |
| last/first quartile mean | 1.00 | 1.00 | 1.00 | 1.00 |

### Errors

_No phase reported an HTTP or client error._

### Disclosure counts

- Population 100: disclosed ballots before the hour closed 0; after the harness advanced the Node clock, publish reported 100 and the ballot list returned 100. Votes accepted in this scale: 100.
- Population 200: disclosed ballots before the hour closed 0; after the harness advanced the Node clock, publish reported 200 and the ballot list returned 200. Votes accepted in this scale: 200.
- Population 400: disclosed ballots before the hour closed 0; after the harness advanced the Node clock, publish reported 400 and the ballot list returned 400. Votes accepted in this scale: 400.
- Population 800: disclosed ballots before the hour closed 0; after the harness advanced the Node clock, publish reported 800 and the ballot list returned 800. Votes accepted in this scale: 800.

### Tally outcomes

- Population 100: tally HTTP 200, acceptedBallots on the store 100, counts [100,0] , L1 status skipped, outcome subscribers 0.
- Population 200: tally HTTP 200, acceptedBallots on the store 200, counts [200,0] , L1 status skipped, outcome subscribers 0.
- Population 400: tally HTTP 200, acceptedBallots on the store 400, counts [400,0] , L1 status skipped, outcome subscribers 0.
- Population 800: tally HTTP 200, acceptedBallots on the store 800, counts [800,0] , L1 status skipped, outcome subscribers 0.

### Latency growth inside a phase

- At population 400, `registration_approve` last-quartile mean latency was 14.1 ms versus 6.4 ms in the first quartile (ratio 2.20).
- At population 400, `provision` last-quartile mean latency was 5.5 ms versus 1.4 ms in the first quartile (ratio 3.86).
- At population 800, `registration_approve` last-quartile mean latency was 23.4 ms versus 15.3 ms in the first quartile (ratio 1.52).
- At population 800, `registration_request` last-quartile mean latency was 10.1 ms versus 6.2 ms in the first quartile (ratio 1.64).
- At population 800, `provision` last-quartile mean latency was 5.3 ms versus 3.0 ms in the first quartile (ratio 1.76).

### CPU versus wall

- At population 100, `provision` spent CPU/wall 1.17 over 193.9 ms wall (227.4 ms CPU). The phase was CPU-bound in this shared process.
- At population 100, `registration_request` spent CPU/wall 1.14 over 225.3 ms wall (257.9 ms CPU). The phase was CPU-bound in this shared process.
- At population 100, `registration_approve` spent CPU/wall 1.10 over 374.0 ms wall (412.7 ms CPU). The phase was CPU-bound in this shared process.
- At population 100, `vote` spent CPU/wall 1.19 over 354.5 ms wall (423.1 ms CPU). The phase was CPU-bound in this shared process.
- At population 200, `provision` spent CPU/wall 1.14 over 357.8 ms wall (408.8 ms CPU). The phase was CPU-bound in this shared process.
- At population 200, `registration_request` spent CPU/wall 1.06 over 497.5 ms wall (526.6 ms CPU). The phase was CPU-bound in this shared process.
- At population 200, `registration_approve` spent CPU/wall 0.98 over 973.5 ms wall (953.9 ms CPU). The phase was CPU-bound in this shared process.
- At population 200, `vote` spent CPU/wall 0.95 over 1012.3 ms wall (957.8 ms CPU). The phase was CPU-bound in this shared process.
- At population 400, `provision` spent CPU/wall 0.86 over 1114.8 ms wall (962.6 ms CPU). The phase was CPU-bound in this shared process.
- At population 400, `registration_request` spent CPU/wall 0.90 over 1768.1 ms wall (1599.7 ms CPU). The phase was CPU-bound in this shared process.
- At population 400, `freeze` spent CPU/wall 1.02 over 96.3 ms wall (98.4 ms CPU). The phase was CPU-bound in this shared process.
- At population 400, `vote` spent CPU/wall 0.86 over 3587.3 ms wall (3080.1 ms CPU). The phase was CPU-bound in this shared process.
- At population 400, `disclosure_publish` spent CPU/wall 1.08 over 50.6 ms wall (54.7 ms CPU). The phase was CPU-bound in this shared process.
- At population 800, `provision` spent CPU/wall 0.87 over 2801.7 ms wall (2436.8 ms CPU). The phase was CPU-bound in this shared process.
- At population 800, `registration_request` spent CPU/wall 0.89 over 6673.2 ms wall (5924.6 ms CPU). The phase was CPU-bound in this shared process.
- At population 800, `registration_approve` spent CPU/wall 0.98 over 14962.0 ms wall (14683.8 ms CPU). The phase was CPU-bound in this shared process.
- At population 800, `freeze` spent CPU/wall 1.16 over 188.4 ms wall (218.1 ms CPU). The phase was CPU-bound in this shared process.
- At population 800, `disclosure_publish` spent CPU/wall 1.04 over 132.5 ms wall (137.2 ms CPU). The phase was CPU-bound in this shared process.

### Store files

- Population 100: `zk-voting.json` 435152 bytes, `l2-chain.json` 155690 bytes.
  One snapshot of that `zk-voting.json`: pretty stringify 0.7 ms (435152 bytes), compact stringify 0.5 ms (359569 bytes), pretty write 0.7 ms.
- Population 200: `zk-voting.json` 841936 bytes, `l2-chain.json` 307990 bytes.
  One snapshot of that `zk-voting.json`: pretty stringify 1.1 ms (841936 bytes), compact stringify 0.9 ms (692853 bytes), pretty write 0.6 ms.
- Population 400: `zk-voting.json` 1653469 bytes, `l2-chain.json` 612590 bytes.
  One snapshot of that `zk-voting.json`: pretty stringify 3.2 ms (1653469 bytes), compact stringify 3.0 ms (1357386 bytes), pretty write 1.6 ms.
- Population 800: `zk-voting.json` 3276481 bytes, `l2-chain.json` 1221790 bytes.
  One snapshot of that `zk-voting.json`: pretty stringify 4.7 ms (3276481 bytes), compact stringify 3.1 ms (2686398 bytes), pretty write 2.9 ms.

### CPU profile

Separate process from the timing ladder: population 400, V8 profiler on, code after the tree append and single-persist vote/approve writes. Timings from that process are not in the tables above.
Inspector self-samples: 10176. Sampling interval is the V8 profiler default. Percents are this run's share of self-hits.
| Self % | Hits | Function | Location |
| ---: | ---: | --- | --- |
| 34.3 | 3495 | `(idle)` | —:0 |
| 18.7 | 1905 | `(anonymous)` | file:///workspace/apps/node/src/store.mjs:230 |
| 10.6 | 1082 | `(anonymous)` | file:///workspace/apps/node/src/store.mjs:230 |
| 3.7 | 373 | `(anonymous)` | file:///workspace/apps/node/src/explorer.mjs:91 |
| 3.2 | 327 | `refresh` | file:///workspace/apps/node/src/explorer.mjs:99 |
| 1.9 | 192 | `(garbage collector)` | —:0 |
| 1.5 | 150 | `(program)` | —:0 |
| 1.1 | 115 | `slice` | node:buffer:636 |
| 0.6 | 63 | `keccakP` | file:///workspace/node_modules/@noble/hashes/esm/sha3.js:49 |
| 0.6 | 56 | `(anonymous)` | —:0 |
| 0.5 | 51 | `(anonymous)` | —:0 |
| 0.5 | 50 | `keccakP` | file:///workspace/node_modules/@noble/hashes/esm/sha3.js:49 |
| 0.4 | 45 | `(anonymous)` | —:0 |
| 0.4 | 39 | `(anonymous)` | file:///workspace/apps/node/src/explorer.mjs:172 |
| 0.3 | 35 | `runMicrotasks` | —:0 |
| 0.3 | 35 | `writev` | —:0 |
| 0.3 | 26 | `findByNullifier` | file:///workspace/apps/node/src/explorer.mjs:331 |
| 0.2 | 21 | `request` | file:///workspace/tools/load/harness.mjs:102 |
| 0.2 | 21 | `(anonymous)` | node:internal/buffer:1061 |
| 0.2 | 17 | `openFileHandle` | —:0 |


### Recommended limit for this run

Rule: largest completed population where registration request, registration approve, vote, hourly disclosure publish, and tally each had **zero errors** and **p95 under 1000 ms**.

Every completed scale passed p95 < 1000 ms with zero errors on registration_request, registration_approve, vote, disclosure_publish, tally. The largest population measured was **800**. Larger populations were not measured.

Half-rate rule for `registration_approve`: throughput at the smallest completed population (100) was 267.37 ops/s. Largest completed population still at or above half of that (133.68 ops/s) was **200**. Population 400 measured 107.71 ops/s, which is under that half-rate.

Half-rate rule for `vote`: throughput at the smallest completed population (100) was 282.09 ops/s. Largest completed population still at or above half of that (141.05 ops/s) was **200**. Population 400 measured 111.50 ops/s, which is under that half-rate.

## Before and after

The after run is the same harness and the same populations. Between the runs: a registration appends one eligible Merkle leaf when the in-memory tree already matches that set (disqualification still rebuilds); zero-subtree hashes are cached per depth; approving a request writes the leaf and the approved row in one store file; a vote writes the receipt PDF fingerprint in the same store file as the ballot.

| Population | Phase | Before mean ms | After mean ms | Before ops/s | After ops/s | Before wall ms | After wall ms |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | `registration_approve` | 26.1 | 3.7 | 38.37 | 267.37 | 2606.4 | 374.0 |
| 100 | `freeze` | 45.3 | 32.2 | 22.05 | 31.09 | 45.4 | 32.2 |
| 100 | `vote` | 4.4 | 3.5 | 224.96 | 282.09 | 444.5 | 354.5 |
| 100 | `disclosure_publish` | 12.9 | 13.7 | 77.31 | 73.02 | 12.9 | 13.7 |
| 100 | `tally` | 20.3 | 16.9 | 49.32 | 59.16 | 20.3 | 16.9 |
| 200 | `registration_approve` | 48.4 | 4.9 | 20.67 | 205.44 | 9675.5 | 973.5 |
| 200 | `freeze` | 86.4 | 48.2 | 11.57 | 20.74 | 86.4 | 48.2 |
| 200 | `vote` | 8.8 | 5.1 | 113.53 | 197.57 | 1761.7 | 1012.3 |
| 200 | `disclosure_publish` | 20.9 | 20.1 | 47.94 | 49.66 | 20.9 | 20.1 |
| 200 | `tally` | 15.5 | 14.7 | 64.58 | 68.22 | 15.5 | 14.7 |
| 400 | `registration_approve` | 100.0 | 9.3 | 10.00 | 107.71 | 40014.9 | 3713.7 |
| 400 | `freeze` | 183.7 | 96.3 | 5.44 | 10.39 | 183.7 | 96.3 |
| 400 | `vote` | 15.5 | 9.0 | 64.70 | 111.50 | 6182.7 | 3587.3 |
| 400 | `disclosure_publish` | 48.5 | 50.6 | 20.62 | 19.77 | 48.5 | 50.6 |
| 400 | `tally` | 25.0 | 23.6 | 40.06 | 42.31 | 25.0 | 23.6 |
| 800 | `registration_approve` | 187.7 | 18.7 | 5.33 | 53.47 | 150168.0 | 14962.0 |
| 800 | `freeze` | 338.2 | 188.4 | 2.96 | 5.31 | 338.2 | 188.4 |
| 800 | `vote` | 28.0 | 18.6 | 35.69 | 53.62 | 22414.0 | 14920.3 |
| 800 | `disclosure_publish` | 135.8 | 132.5 | 7.36 | 7.55 | 135.8 | 132.5 |
| 800 | `tally` | 42.9 | 49.3 | 23.33 | 20.29 | 42.9 | 49.3 |

## How to reproduce

From the repository root, with dependencies installed (`npm install`):

```bash
node tools/load/harness.mjs --scales 100,200,400,800 --concurrency 1 --disclosure-seconds 3600 --tree-depth 20 --json docs/load-test-results.json
node tools/load/harness.mjs --render docs/load-test-results.json --out docs/LOAD_TEST.md
```

The harness does not print a throughput or latency figure it did not just measure. Stats unit tests: `node --test tools/load/stats.test.mjs`.

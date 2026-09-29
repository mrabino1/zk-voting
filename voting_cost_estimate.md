# Expected cost to operate Republic

**NOT FOR PROFIT** — civic public good. Not a commercial product. Jurisdictions run this **at cost** (hosts, L1 gas, paper notice). There is no token, no paid tier, and no voter fee. See [`NOT_FOR_PROFIT.md`](./NOT_FOR_PROFIT.md).

Commander-facing ranges for **this tree on `test/unstable`**. Pull facts from the cited files. Dollar figures are **order-of-magnitude estimates** (assumptions stated). They are not invoices, quotes, or a SaaS price list.

**As of:** 20 September 2026. **Branch facts:** `test/unstable`.

---

## How to read this file

| Label | Meaning |
| --- | --- |
| **Repo fact** | Measured or stated in this repository. Cited. |
| **Estimate** | Order of magnitude. Assumptions in the row or footnote. Not fake precision. |
| **Market-variable** | ETH, gas (gwei), AWS list prices, and VPS rates move. Recheck the vendor page before budgeting. |

Voters pay **zero**. The jurisdiction budget pays hosts, optional L1 settlement, and optional AWS mail. [`docs/L2.md`](./docs/L2.md) (“Gas and money”), [`NOT_FOR_PROFIT.md`](./NOT_FOR_PROFIT.md).

---

## Commander snapshot

| Line item | Quiet month / demo | Election month (small) | Election month (medium) | Notes |
| --- | --- | --- | --- | --- |
| Hosts (Node + sequencer + prover) | **~$15–60** always-on small VPS | same, or **~$5–20** if you only run the box for the window | **~$40–150** 4 vCPU / 8–16 GB | **Estimate.** One small VM running Docker Compose is typical. |
| L1 proof posting (`RollupSettlement`) | **$0** if `L1_RPC` unset (**repo default**) | **$0** on testnet / unset | **Do not** post default 2s / `batchSize=4` to mainnet | **Repo fact** + **estimate** below. |
| L1 tally hash (`L1TallyMirror`) | $0 if unset | **cents–tens of USD** per election | same (one tx / election) | **Estimate**, market-variable ETH/gwei. |
| AWS SES (MFA + Terms PDF + optional receipt / outcome PDFs) | **~$0–2** | **~$1–5** (~2k people) | **~$25–50** (~50k people) | **Estimate** from AWS list prices. |
| Optional S3 / R2 attic | **off by default** (`ARCHIVE_ENABLED=0`) | **~$0–2** for tens of GB | **~$2–10** for ~100–400 GB | **Estimate**, us-east-1 Standard or R2. VPS keeps the hot window. |
| Extra “live results” cluster | **none required** | none | none | Hourly disclosure, same Node. |

**Do this / don’t do this**

- **Do** leave L1 env empty on `test/unstable` until a jurisdiction pins `master` addresses. [`docs/OPERATOR.md`](./docs/OPERATOR.md).
- **Do** persist Compose volumes at `/data` (Node) and a **separate** L2 volume at `/data` (`L2_DATA_DIR`).
- **Don’t** point `L1_RPC` + `SETTLEMENT_ADDRESS` + prover `PRIVATE_KEY` at Ethereum mainnet while the sequencer mints a block every **2 seconds** with `L2_BATCH_SIZE=4`. That is tens of thousands of L1 txs per day. **Estimate:** hundreds of thousands of USD per month at 10 gwei — see §3.
- **Don’t** treat Merkle depth 20 (~1M leaves) as “this Node can serve 1M voters today.” The JSON store is the practical cap. See §4.

---

## 1. Running the L2 (sequencer + prover, chainId 27427)

### Repo facts

| Item | Value | Source |
| --- | --- | --- |
| chainId | **27427** | [`l2/genesis.json`](./l2/genesis.json), [`packages/types`](./packages/types/index.js) `REPUBLIC_CHAIN_ID` |
| Block period | **2 seconds**, 1 sequencer | `genesis.json` `blockTime` / `period`; [`docs/L2.md`](./docs/L2.md) |
| Processes | Node 22 sequencer (`l2/sequencer/index.mjs`) + prover (`l2/prover/index.mjs`) | [`l2/Dockerfile`](./l2/Dockerfile), [`docker-compose.yml`](./docker-compose.yml) |
| RPC | JSON-RPC subset **:8546** | [`docs/L2.md`](./docs/L2.md) |
| What it is | Civic **JSON** txs (`register` / `vote` / `disqualify` / `tally` / `userop`). **Not** an EVM, **not** Anvil, **not** a hosted Lighter sequencer | [`docs/L2.md`](./docs/L2.md), [`docs/OPERATOR.md`](./docs/OPERATOR.md) |
| Compose | `restart: unless-stopped` for `node`, `l2`, `prover` | [`docker-compose.yml`](./docker-compose.yml) |
| Images | `node:22-bookworm-slim` (Node app and L2) | [`Dockerfile`](./Dockerfile), [`l2/Dockerfile`](./l2/Dockerfile) |
| Mock proofs | `DEV_MOCK_PROOF` default **true**; prover writes `a=[1,0], b=[[1,0],[1,0]], c=[1,0]` | [`l2/README.md`](./l2/README.md), [`l2/prover/batch.mjs`](./l2/prover/batch.mjs) |
| L1 submit | Only if `L1_RPC` + `SETTLEMENT_ADDRESS` + `PRIVATE_KEY` are **all** set; else JSON under the L2 volume | [`l2/README.md`](./l2/README.md), [`l2/prover/index.mjs`](./l2/prover/index.mjs) |
| Batch size | `L2_BATCH_SIZE` default **4** blocks / proof | [`l2/config.json`](./l2/config.json), `.env.example` |
| Empty blocks | Producer loop **always** calls `produceBlock()` on the period, including empty blocks | [`l2/sequencer/state.mjs`](./l2/sequencer/state.mjs) `startProducer` |
| Startup RAM | Sequencer **loads every** `blocks/N.json` into memory | `ChainState.load()` |
| Voters | No L2 gas token. `eth_getBalance` is `0` for ordinary addresses | [`docs/L2.md`](./docs/L2.md) |
| Who pays | Jurisdiction funds host + (on an EVM) paymaster **at cost** | [`docs/L2.md`](./docs/L2.md), [`docs/PASSKEYS.md`](./docs/PASSKEYS.md) |
| Node down | Allowed. Chain records must still suffice for an independent verifier | [`docs/OPERATOR.md`](./docs/OPERATOR.md) |

There is **no** CPU/RAM table in Compose or the Dockerfiles (no `deploy.resources`). Host sizing is operator policy.

### Always-on vs election-window

| Mode | What the tree does | When to use |
| --- | --- | --- |
| **Always-on** | Compose `unless-stopped`: empty 2s blocks, prover batches of 4, logs | Staging, or a public Node that must accept registration any day. **Estimate:** light CPU, **growing RAM/disk** from the block log (§2). |
| **Election-window** | Run sequencer + prover while the poll (and registration, if on this L2) is live; stop them after tally. Keep the Node up if you still need `/explorer`, `/results`, `/outcomes` | Binding elections. Matches “Node may be down; chain records remain.” |
| **L1 posting** | Independent of the host being up. Default env **does not** post to Ethereum | Keep unset until you have a batching policy that is not “every 8 seconds.” |

### CPU / RAM assumptions (**estimate**)

| Workload | CPU | RAM | Why |
| --- | --- | --- | --- |
| Local demo / town clerk, mock proofs | 2 vCPU | 4 GB | Three Node 22 processes; JSON store in RAM; mock prover is keccak/JSON, not a GPU SNARK. |
| County election-window, tens of thousands of voters | 4 vCPU | 8–16 GB | Same processes; `republic.json` + explorer + hourly vote flush; Merkle trees keep **all leaves** in the JSON store. |
| Always-on L2 for **months** at 2s | 2–4 vCPU | **grows with block count** | Sequencer holds the full chain in RAM. Not a coded prune. Prefer election-window or accept tens of GB after months (§2). |
| Real Groth16 **vote** proofs in Node (`REPUBLIC_PROVING_PATH`) | Extra CPU at vote time | + proving keys | **In progress**, untrusted local ptau. Poseidon `Vote(4)` smoke is about **1966 non-linear** constraints. Poseidon `Vote(20)` is not benchmarked here. Ceremony is not done. |

`master` must not ship mock rollup proofs ([`docs/L2.md`](./docs/L2.md)). Budget a real prover when that lands; today’s default is mock.

### Monthly host $ (**estimate**, market-variable)

Assumes one VM running Docker Compose. Not AWS list for a three-AZ production mesh — this repo does not define that.

| Shape | Always-on $/month | Election-window only |
| --- | --- | --- |
| Small VPS (2 vCPU / 4 GB, 40–80 GB disk) | **$15–60** | A few days ≈ **$2–15** plus any idle Node |
| Medium (4 vCPU / 8–16 GB) | **$40–150** | A 1–2 week window ≈ **$10–50** |
| Cloud VM in the same class (e.g. AWS `t3.medium` / `t3.large` + gp3) | Often **the high end** of those bands + disk | Same |

You pay the VPS. This repository does not bill a platform fee.

---

## 2. Disk needed

### Where data lives (**repo fact**)

| Volume / path | Env | Contents |
| --- | --- | --- |
| Node `DATA_DIR` default `apps/node/data`; **Compose `/data`** | `DATA_DIR=/data` | `republic.json` (users, elections, votes, envelopes, terms, CMS), `l2-chain.json` (explorer), `receipt-pdf.secret` | [`apps/node/src/config.mjs`](./apps/node/src/config.mjs), [`Dockerfile`](./Dockerfile), [`docs/OPERATOR.md`](./docs/OPERATOR.md) |
| L2 `L2_DATA_DIR` default `l2/data`; **Compose `/data`** | `L2_DATA_DIR=/data` | Hot window: `blocks/N.json`, `head.json`, `mempool.json`, `sealed.json`, `proofs/batch-N.json`, `archive/index.json`. Sealed hours older than `ARCHIVE_HOT_WINDOW_HOURS` (default 2) offload to S3/R2 when `ARCHIVE_ENABLED=1`. | [`l2/sequencer/state.mjs`](./l2/sequencer/state.mjs), [`l2/archive/job.mjs`](./l2/archive/job.mjs), [`l2/prover/index.mjs`](./l2/prover/index.mjs) |
| Compose volumes | `node-data:/data`, `l2-data:/data` | **Two** named volumes. Both appear as `/data` **inside** their containers. | [`docker-compose.yml`](./docker-compose.yml) |
| Image build | `.dockerignore` excludes `apps/node/data`, `l2/data`, `.ptau`, `.zkey` | Mount data and proving keys; do not `COPY` them | [`docs/OPERATOR.md`](./docs/OPERATOR.md) |
| Store type | JSON files. **No SQLite.** Pretty-printed rewrite of the **whole** file on persist | [`apps/node/src/store.mjs`](./apps/node/src/store.mjs), [`apps/node/src/explorer.mjs`](./apps/node/src/explorer.mjs) |
| Logs | Compose `json-file` `max-size: 10m`, `max-file: 3` per service | ~30 MB cap per service | [`docker-compose.yml`](./docker-compose.yml) |

### Persistent `/data` volume

**Repo fact:** the Node image sets `DATA_DIR=/data` and `mkdir /data` ([`Dockerfile`](./Dockerfile)). Mount a volume there. A redeploy without that mount wipes the roll.

| If you deploy… | Mount |
| --- | --- |
| **Node image only** | Persistent volume → container **`/data`**. That is `republic.json` + `l2-chain.json`. Redeploys without this mount **wipe the roll.** |
| **Compose** (`node` + `l2` + `prover`) | **Two** volumes. Node `/data` ≠ L2 `/data`. Do not point both services at one empty dir and expect isolation — Compose already uses two named volumes. |
| Proving keys / ptau | Separate mount. Not in the image. |

Size the Node volume for **Node JSON + explorer**, and a second volume (the Compose `l2-data` volume) for **L2 blocks + proofs**. They scale differently (below).

### GB estimates (**estimate**, from measured empty-block size)

Empty sequencer block JSON was measured at **~1.4 KB** compact (includes a 256-byte `logsBloom` hex string). Period **2s** ⇒ **43,200 blocks/day** if the producer is left up.

| Store | Driver | Quiet / demo | Always-on 30 days (mostly empty blocks) | ~50k voters, one election |
| --- | --- | --- | --- | --- |
| L2 `blocks/` | One file per block, including empty | tens of MB | **~1.5–2.5 GB/month** (~60 MB/day × 30) | same **plus** vote txs (usually smaller than the empty-block flood) |
| L2 `proofs/` | One pretty JSON per 4-block batch | tens of MB | **~0.3–0.8 GB/month** | same |
| `republic.json` | Full pretty rewrite; eligible tree **stores every leaf** (~70 B/leaf compact; vote row ~0.2 KB) | **< 50 MB** | grows with people, not with empty L2 | **~0.2–1 GB** order of magnitude if identity + envelope + CMS sit on the person |
| `l2-chain.json` | Explorer. Empty L2 blocks **are not** appended (ingest only civic rows) | **< 50 MB** | modest unless you ingest every vote | **~0.1–0.5 GB** for tens of thousands of disclosed votes |
| Node `/data` | `republic.json` + `l2-chain.json` | **20–80 GB** volume is plenty | same | **50–200 GB** gives headroom |
| Compose L2 `/data` | blocks + proofs | **20–80 GB** | **plan 50–200 GB** if always-on for months | election-window: **20–80 GB** is usually enough |

**Practical disk takeaway:** always-on L2 disk is dominated by **empty 2s blocks**, not by voters. Node `/data` is dominated by **people and ballots**. Size them separately. Turn on hourly attic offload (`ARCHIVE_ENABLED=1`) so the VPS keeps only the last 1–2 hours of L2 JSON; S3/R2 holds the rest.

### Hourly L2 attic (**repo fact**)

Object storage is the attic, not the live sequencer disk. ~2s writes and Node `DATA_DIR` stay local. [`l2/archive/job.mjs`](./l2/archive/job.mjs), [`docs/OPERATOR.md`](./docs/OPERATOR.md).

| Item | Fact |
| --- | --- |
| Default | `ARCHIVE_ENABLED=0` — sequencer unchanged |
| Hot window | `ARCHIVE_HOT_WINDOW_HOURS=2` (disclosure hour buckets) |
| Prefix | `l2/{chainId}/YYYY/MM/DD/HH/` plus `manifest.json` (keys + sha256) |
| Prune | Only after PUT + GET checksum verify. Failed hours stay on the VPS |
| API | Path-style S3 (`ARCHIVE_S3_ENDPOINT` empty = AWS; set for Cloudflare R2) |

Merkle **depth 20** (~1M leaves) is **not** “reserve 1M × 32-byte hashes only.” The Node also stores persons, sessions, envelopes, terms rows, and pretty-printed JSON. See §4.

---

## 3. Cost to post proofs (L1 settlement / tally mirror)

### What actually hits Ethereum (**repo fact**)

| Call | When | What is posted |
| --- | --- | --- |
| `RollupSettlement.submitBatch(batchIndex, prevStateRoot, newStateRoot, dataHash, a, b, c)` | Prover, every `L2_BATCH_SIZE` (default **4**) L2 blocks, **only if** L1 env is fully set | Roots + Groth16-shaped proof. **`dataLength` is 0** — the contract does **not** store batch calldata. Anyone is supposed to re-derive `dataHash` from public batch data ([`docs/L2.md`](./docs/L2.md)); the Solidity `computeDataHash` is `keccak256(abi.encode(batchIndex, prev, next))`. |
| Mock vs real | `mockMode` on the contract skips `verifyProof`. Dev prover: `DEV_MOCK_PROOF=true` (default). If `DEV_MOCK_PROOF=false`, current prover **refuses** L1 submit (“production groth16 keys are not present”) | [`RollupSettlement.sol`](./smart-contracts/src/l2/RollupSettlement.sol), [`l2/prover/index.mjs`](./l2/prover/index.mjs) |
| `L1TallyMirror.postResult(electionId, resultHash, totalBallots, l2StateRoot)` | After Node tally, **one tx per election**, if `L1_RPC` + `L1_TALLY_MIRROR_ADDRESS` + `L1_PUBLISHER_PRIVATE_KEY` are set. Unset → tally still works (`skipped`) | Hash of counts, not ballots. [`docs/OPERATOR.md`](./docs/OPERATOR.md) |
| Voters | **Never** pay L1 or L2 gas on the civic path | [`docs/L2.md`](./docs/L2.md) |
| EVM paymaster | Separate: `RepublicPaymaster` sponsors UserOps that hit inbox / registry / factory **on an EVM**. Civic sequencer is not that EVM. | [`docs/OPERATOR.md`](./docs/OPERATOR.md) |

This repo **does not** ship a Foundry gas snapshot for `submitBatch`. Do not treat the next table as measured.

### Gas per tx (**estimate**)

| Path | Gas order of magnitude | Why |
| --- | --- | --- |
| `submitBatch` **mockMode** | **~5e4–1.5e5** | SSTORE of `Batch` + event + calldata; **no** pairing precompile. |
| `submitBatch` **real Groth16** | **~2.3e5–3.5e5** | Industry BN254 Groth16 verify is about **207k + ~7k × public inputs**. This contract passes **4** inputs, then writes storage. Not measured here. |
| `postResult` tally mirror | **~4e4–1e5** | Two mappings + event. One per election. |
| Full ballot calldata on L1 | **not implemented** | Current `dataLength = 0`. A future “post the batch body” design would add **16 gas/nonzero calldata byte** and would **not** be these numbers. |

### ETH / gwei scenarios (**market-variable**)

USD ≈ `gas × gwei × 1e-9 × ETH_USD`. Recheck spot ETH and the gas oracle; these are **scenarios**, not a forecast.

**Per L1 tx** (pick a gas column, then a price row):

| ETH USD \ gwei | 1 gwei | 10 gwei | 30 gwei | 50 gwei |
| --- | --- | --- | --- | --- |
| **$2,000** | mock ~$0.10–0.30 · real ~$0.50–0.70 | mock ~$1–3 · real ~$5–7 | mock ~$3–9 · real ~$14–21 | mock ~$5–15 · real ~$23–35 |
| **$4,000** | mock ~$0.20–0.60 · real ~$1.00–1.40 | mock ~$2–6 · real ~$10–14 | mock ~$6–18 · real ~$28–42 | mock ~$10–30 · real ~$46–70 |
| **$6,000** | mock ~$0.30–0.90 · real ~$1.50–2.10 | mock ~$3–9 · real ~$15–21 | mock ~$9–27 · real ~$42–63 | mock ~$15–45 · real ~$69–105 |

Using **~250k gas** as a round “real verify + store” stand-in: at **10 gwei** and **$4,000/ETH** that is **~$10 per `submitBatch`**.

### Per-batch vs per-election (**repo math** × **estimate $**)

Default: 2s blocks × batch of 4 ⇒ **one L1 submit every 8 seconds** if L1 env is set, **including empty batches**.

| Cadence | Batches | At ~$10 / real batch (10 gwei, $4k ETH) |
| --- | --- | --- |
| 1 hour | 450 | **~$4,500** |
| 12-hour election day | 5,400 | **~$54,000** |
| 30 days always-on | **324,000** | **~$3 million** |
| Same, mock ~$3 / batch | 324,000 | **~$1 million** |
| **L1 env unset** (Compose / `.env.example` default) | 0 | **$0** |
| **Sepolia / Anvil** | testnet ETH | **$0** (plus any RPC vendor fee) |
| **1 `postResult` / election** | 1 | **cents to tens of USD** |

**Commander rule:** with the code as written, **mainnet `submitBatch` at default batch size is not a civic budget item — it is a misconfiguration.** Options that *are* in policy/docs today:

1. Leave L1 unset; write `proofs/batch-N.json` only (**default**).
2. Use a testnet for staging.
3. If mainnet settlement is required later: raise `L2_BATCH_SIZE` a lot, run L2 only in the election window, and/or change the prover to skip empty batches (**not implemented**). Example **estimate:** `L2_BATCH_SIZE=1800` (~1 hour / proof) → ~$10/hour at the 10 gwei / $4k scenario — still a policy choice, not current default.

Tally mirror is cheap even on mainnet because it is **once per election**.

---

## 4. How many people can vote each time

### Tree and contract caps (**repo fact**)

| Knob | Default / range | Meaning |
| --- | --- | --- |
| `treeDepth` | Clerk UI **20** selected; API `body.treeDepth \|\| 20`; allowed **16..32** | [`apps/node/public/back-office.html`](./apps/node/public/back-office.html), [`apps/node/src/routes/elections.mjs`](./apps/node/src/routes/elections.mjs) |
| Circuit | `Vote(20)` compiled by default (~1M leaves). Recompile to match the election | [`circuits/vote.circom`](./circuits/vote.circom), [`circuits/README.md`](./circuits/README.md) |
| Leaves at depth *d* | **2^d** | 16 → 65,536; **20 → 1,048,576**; 32 → ~4e9 ([`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)) |
| `maxParticipants` | UI **0**; `0` = unlimited (registry does not cap). Non-zero → insert reverts at cap | back-office hint “0 = unbounded roll”; [`packages/types`](./packages/types/index.js) |
| Merkle full | `insertLeaf` throws `merkle tree full` at `2 ** depth` | [`apps/node/src/merkle.mjs`](./apps/node/src/merkle.mjs) |
| L2 block | `maxTxsPerBlock` **4096** | [`l2/config.json`](./l2/config.json) |
| Hourly flush | Sealed votes publish when the hour closes, lumped, ordered by hash/nullifier | [`l2/disclosure.mjs`](./l2/disclosure.mjs), [`docs/BLOCK_EXPLORER.md`](./docs/BLOCK_EXPLORER.md) |

`maxParticipants = 0` does **not** mean infinite RAM. It means the **contract** will not apply a numeric cap; the **tree depth** still caps leaves at 2^d.

### Practical bottlenecks (**repo fact** + **estimate**)

| Layer | What breaks first | Practical size (**estimate**) |
| --- | --- | --- |
| Node JSON store | Whole `republic.json` pretty-printed on **every** persist; eligible tree keeps **all leaves** in that file | **Thousands–low tens of thousands** of people is the comfortable band on one Node 22 process. **~100k** is already a large pretty JSON rewrite per vote. **~1M** is the Merkle depth-20 *theory*, not a tested Node path. |
| Sequencer RAM | Loads **all** historical blocks | Election-window: fine. Always-on months: RAM tracks ~1.4 KB × block count (JS objects larger). |
| Hourly disclosure | Up to 4096 txs / 2s block after the hour closes | **50k votes in one hour** ≈ 13 blocks ≈ **~30 s** to unseal. **1M in one hour** ≈ 244 blocks ≈ **~8 min**. Throughput is OK; the JSON store is not. |
| Explorer | `l2-chain.json` full rewrite; public APIs on the **same** Node | Same order as voter count, not empty L2. |
| Vote SNARK | Poseidon is wired. Committed check is untrusted `Vote(4)`, not `Vote(20)`, and not a ceremony. | Do not budget “1M Groth16 proves / hour on one laptop” until `Vote(20)` is measured. |
| Single sequencer | Liveness / censorship assumption (v1: one sequencer) | [`docs/L2.md`](./docs/L2.md). A stall stops voting; it must not silently change a tally. |

**How many people can vote each time — answer for a commander**

- **Circuit / roll (depth 20, `maxParticipants=0`):** up to **~1,048,576** registered leaves, if you recompile nothing and never hit `merkle tree full`.
- **This Node, today:** plan **municipal / county** rolls in the **thousands to tens of thousands** unless you replace the JSON store (not in tree). Depth 20 is headroom for the tree, not a load test.
- **Hourly public count:** everyone who voted in closed hours; not a live precinct tick (§6).

---

## 5. AWS — SES and optional S3

### SES — what the Node sends (**repo fact**)

When `SES_FROM_ADDRESS` and `AWS_REGION` are set ([`.env.example`](./.env.example), [`docs/OPERATOR.md`](./docs/OPERATOR.md)):

| Mail | Who | Attachment |
| --- | --- | --- |
| 6-digit MFA OTP | Every non-dev sign-in (primary email) | no |
| Vote PIN reset OTP | Forgot-PIN | no |
| Terms of Use PDF | First accept of a given PDF hash (`already_sent_this_hash` otherwise) | yes — raw MIME; SESv2 Simple **cannot** attach ([`apps/node/src/mailer.mjs`](./apps/node/src/mailer.mjs)) |
| Optional hash-only vote receipt PDF | After accept, if the voter emails it | yes, locked PDF |
| Official outcome PDF | After cutoff + certified tally; voters subscribed by default | yes, locked PDF |

Unset SES → Node still records accepts and **captures** mail in-process (tests). No AWS bill.

There is **no** SES price in this repo. Figures below are **AWS list** as of the [SES pricing page](https://aws.amazon.com/ses/pricing/) fetched 20 September 2026. **Market-variable.** New accounts may land on **Essentials** ($0.16 / 1,000 under 10M) rather than à la carte ($0.10 / 1,000). Attachments: **$0.12 / GB**.

### SES monthly $ (**estimate**)

Assume à la carte **$0.10 / 1,000** plus **$0.16 / 1,000** as an Essentials column. Count ~**3–6 emails per person** in an election month (register MFA, later login MFA, one Terms PDF, optional receipt, one outcome PDF). PDF attachments are tens of KB, not MB — attachment line is **pennies** at these volumes.

| Volume | Emails / month (order of mag.) | À la carte | Essentials | Attachments |
| --- | --- | --- | --- | --- |
| **Small** — ~2,000 people, one poll | ~8k–12k | **~$1** | **~$1.50–2** | **≪ $1** |
| **Medium** — ~50,000 people | ~150k–300k | **~$15–30** | **~$25–50** | **~$0.50–2** |
| Quiet month, officers only | hundreds | **≪ $1** | **≪ $1** | ~0 |

Dedicated IPs, Virtual Deliverability Manager, and Mail Manager are **optional AWS add-ons** this app does not require. Skip them unless deliverability staff asks. Dedicated IP list: **$24.95 / IP / month** (à la carte page).

### S3 / R2 hourly attic (**in this repo**)

Hourly job (`npm run l2:archive`, Compose `archive`, `./system_actions.sh archive`). Default **off**. When `ARCHIVE_ENABLED=1`, sealed L2 hours older than the hot window upload to AWS S3 or Cloudflare R2 (same path-style client). The VPS keeps ~2 hours of block JSON plus `head.json` / mempool / sealed votes / Node `DATA_DIR`.

| Item | **Estimate** (S3 Standard, us-east-1 first 50 TB, list ~**$0.023 / GB-month**; R2 is often similar or cheaper, no egress to Workers) |
| --- | --- |
| Small — 20–50 GB attic | **~$0.50–1.50 / month** storage + cheap PUTs |
| Medium — 100–400 GB | **~$2–10 / month** storage |
| Egress if you download off-AWS | **~$0.09 / GB** after the usual free slice — often larger than storage |

Glacier / IA / R2 lifecycle can be cheaper for cold election archives; retrieval fees apply. Recheck [S3 pricing](https://aws.amazon.com/s3/pricing/) or [R2 pricing](https://developers.cloudflare.com/r2/pricing/).

---

## 6. Showing results live

### What “live” means here (**repo fact**)

Republic **does not** show a live precinct tick. Vote proofs and public turnout publish **once an hour** after that hour closes (`DISCLOSURE_INTERVAL_SECONDS` default **3600**; `0` = instant, local demo / tests). A person leaving a voting office must not match a dashboard bump. [`docs/BLOCK_EXPLORER.md`](./docs/BLOCK_EXPLORER.md), [`apps/node/public/results.js`](./apps/node/public/results.js), [`docs/OPERATOR.md`](./docs/OPERATOR.md).

| Surface | During the poll | After certified tally |
| --- | --- | --- |
| `/explorer` | Registrations, reason codes, **hourly** disclosed ballots, countdown to next hour | History + batches |
| `/elections/:id/results` | No unofficial option counts | Plurality / IRV counts |
| `/outcomes` | Disclosed turnout only | Auditor pack, L1 hash checks, official PDF |

Safe live numbers: registered, disqualified-by-code, **last closed hour** turnout. Not “accepted ballots right now.”

### Bandwidth and extra infra (**estimate**)

| Need | Extra machines? |
| --- | --- |
| Explorer + results + outcomes | **No.** Same Node (`:3000`) serves the SPA and `GET /api/explorer/*`, `/api/elections/:id/summary`, `/api/outcomes`. |
| Hourly refresh | Observers poll JSON. No websocket tick in tree. Traffic **spikes at hour close** when sealed votes flush (up to 4096 txs / block). |
| CDN | Optional, for `public/` static files only. Not required. |
| Sequencer during results-only | **Not required** after ingest. Keep Node + `/data`. |
| “TV station horse race” | **Out of scope** by design. Would break polling-place unlinkability. |

Bandwidth **estimate:** public JSON snapshots are KB–low MB per view. A county night with thousands of observers is ordinary HTTPS on one VM plus optional CDN. It is not an L1 cost and not a second cluster in this repo.

---

## Token polls (phase 1)

**NOT FOR PROFIT.** Phase 1 posts **no EVM transactions**. Voters pay **$0**. Figures below are **estimates**. Archive-RPC spend is **market-variable**.

| Item | Estimate | Note |
| --- | --- | --- |
| Ballot acceptance | 1 `eth_blockNumber` + 1 `balanceOf` (+1 ERC-1271 `eth_call`) | **Estimate.** Voter pays $0. The Node reads the token chain. |
| Tally per ballot | 2 paged `eth_getLogs` + 1 `balanceOf` per touched block + 1 at close | **Estimate.** Holders who do not move tokens are about 3 calls. Archive RPC is **market-variable**, about $0 to a few dollars per poll. |
| Optional later `createPoll` / `postResult` | ~1e5 / ~8e4 gas | **Estimate.** Not in phase 1. One-off, on an EVM venue, not chain 27427. |
| Optional `L1TallyMirror.postResult` | ~4e4–1e5 gas | **Estimate.** Phase 1 skips this. The current mirror keys a uint256 civic election id. |

The host token is `VOTING_TOKEN_ADDRESS` on Ethereum mainnet (chain id 1). Reads only: no transaction and no spend. Tests use an in-memory ERC-20 on a local chain and do not spend RPC quota.

---

## Citations (tree)

| Topic | Files |
| --- | --- |
| Not for profit / at cost | [`NOT_FOR_PROFIT.md`](./NOT_FOR_PROFIT.md), README “Not for profit”, [`docs/L2.md`](./docs/L2.md) “Gas and money” |
| L2 genesis / period / chainId | [`l2/genesis.json`](./l2/genesis.json), [`docs/L2.md`](./docs/L2.md), [`l2/README.md`](./l2/README.md) |
| Operator / Compose / `/data` | [`docs/OPERATOR.md`](./docs/OPERATOR.md), [`docker-compose.yml`](./docker-compose.yml), [`Dockerfile`](./Dockerfile), [`l2/Dockerfile`](./l2/Dockerfile) |
| Prover / mock / L1 submit | [`l2/prover/index.mjs`](./l2/prover/index.mjs), [`l2/prover/batch.mjs`](./l2/prover/batch.mjs), [`smart-contracts/src/l2/RollupSettlement.sol`](./smart-contracts/src/l2/RollupSettlement.sol) |
| Tally mirror | [`smart-contracts/src/l2/L1TallyMirror.sol`](./smart-contracts/src/l2/L1TallyMirror.sol), OPERATOR “L1 certification” |
| Disclosure | [`l2/disclosure.mjs`](./l2/disclosure.mjs), [`apps/node/src/disclosure.mjs`](./apps/node/src/disclosure.mjs), [`docs/BLOCK_EXPLORER.md`](./docs/BLOCK_EXPLORER.md) |
| treeDepth / maxParticipants | [`apps/node/src/routes/elections.mjs`](./apps/node/src/routes/elections.mjs), [`apps/node/public/back-office.html`](./apps/node/public/back-office.html), [`circuits/vote.circom`](./circuits/vote.circom), [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) |
| SES | [`apps/node/src/mailer.mjs`](./apps/node/src/mailer.mjs), [`.env.example`](./.env.example), [`docs/IDENTITY.md`](./docs/IDENTITY.md) |
| L2 attic (S3/R2) | [`l2/archive/job.mjs`](./l2/archive/job.mjs), [`.env.example`](./.env.example), [`docs/OPERATOR.md`](./docs/OPERATOR.md) |
| JSON store | [`apps/node/src/store.mjs`](./apps/node/src/store.mjs), [`apps/node/src/merkle.mjs`](./apps/node/src/merkle.mjs) |

**External list prices (market-variable, not repo facts):** [Amazon SES pricing](https://aws.amazon.com/ses/pricing/), [Amazon S3 pricing](https://aws.amazon.com/s3/pricing/). Groth16 verify gas order of magnitude: public BN254 pairing / Groth16 writeups (~207k + ~7k per public signal), not a measurement of this `RollupSettlement`.

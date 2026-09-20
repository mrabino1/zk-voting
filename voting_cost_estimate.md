# Republic operating-cost brief

**NOT FOR PROFIT** — civic public good. Not a commercial product. See [`NOT_FOR_PROFIT.md`](./NOT_FOR_PROFIT.md).

This is a **commander / clerk** brief: what it costs a jurisdiction to run Republic **at cost**. There is no token, no SaaS fee, and no voter gas. Hosts, L1 gas (if you settle), and AWS SES are the bill.

Two kinds of numbers:

| Kind | Meaning |
| --- | --- |
| **Repo fact** | Taken from this tree (`test/unstable`). Cited. |
| **Estimate** | Order-of-magnitude money or GB. Assumptions stated. **Not** a bid and **not** a gas oracle. |

**Assumptions for every dollar figure (label: market-variable, snapshot ~2026-09-20):**

- Region: **US East** (SES example in README is `us-east-1`). EU/Hetzner VPS is often cheaper.
- ETH: **~$2,500 / ETH** (spot this week was roughly $2.1k–$2.6k — treat as a round placeholder).
- Gas: tables use **1 / 10 / 30 / 100 gwei**. Mainnet base can sit **well below 1 gwei**; spikes still happen. Do not budget only the quiet day.
- Host: one Coolify (or Compose) box running the in-tree `docker-compose.yml` (Node + sequencer + prover).

---

## 1. Running the L2 (sequencer + prover)

Republic L2 is **this repo’s civic JSON sequencer + prover**, chainId **27427**, not a rented commercial sequencer and not Anvil.

### Repo facts

| Fact | Where |
| --- | --- |
| chainId **27427**, **2s** period, **one** sequencer | [`l2/genesis.json`](./l2/genesis.json), [`docs/L2.md`](./docs/L2.md) |
| JSON-RPC default **:8546**; Compose publishes `${L2_RPC_PORT:-8546}` | [`l2/config.json`](./l2/config.json), [`docker-compose.yml`](./docker-compose.yml), [`l2/Dockerfile`](./l2/Dockerfile) (`EXPOSE 8546`) |
| Node image: Node **22**, `PORT=3000`, `DATA_DIR=/data` | [`Dockerfile`](./Dockerfile) |
| L2 image: Node **22**, `L2_DATA_DIR=/data`, `DEV_MOCK_PROOF=true` | [`l2/Dockerfile`](./l2/Dockerfile) |
| Three Compose services, `restart: unless-stopped` | `node`, `l2` (sequencer), `prover` in [`docker-compose.yml`](./docker-compose.yml) |
| Sequencer **always produces a block** on the period, including empty ones | [`l2/sequencer/state.mjs`](./l2/sequencer/state.mjs) `startProducer` / `produceBlock` |
| `batchSize` default **4** (blocks per proof) | [`l2/config.json`](./l2/config.json), env `L2_BATCH_SIZE` |
| `maxTxsPerBlock` **4096** | [`l2/config.json`](./l2/config.json) |
| Voters pay **zero**. Jurisdiction funds the host and (on a real EVM) the paymaster **at cost** | [`docs/L2.md`](./docs/L2.md) “Gas and money”, [`smart-contracts/src/account/RepublicPaymaster.sol`](./smart-contracts/src/account/RepublicPaymaster.sol) |
| Civic sequencer is **not** an EVM. Foundry Anvil (`:8545`) is a separate local EVM | [`docs/L2.md`](./docs/L2.md), [`docs/OPERATOR.md`](./docs/OPERATOR.md) |
| On an EVM, `RepublicPaymaster` sponsors UserOps to `BallotInbox`, `VoterRegistry.register`, `PasskeyAccountFactory`. `DeployL2` default deposit **10 ETH** (`PAYMASTER_DEPOSIT_WEI`) — Anvil monopoly money, not a mainnet invoice | [`docs/OPERATOR.md`](./docs/OPERATOR.md), [`smart-contracts/script/DeployL2.s.sol`](./smart-contracts/script/DeployL2.s.sol) |
| `test/unstable` default: **mock** rollup proofs. **`master` must not** ship mock proofs | [`docs/L2.md`](./docs/L2.md), `.env.example` `DEV_MOCK_PROOF=true` |
| Prover CPU for **mock** proofs is trivial (`a=[1,0]`, …). Real Groth16 for **vote** circuits is a different flag (`REPUBLIC_PROVING_PATH`) and is **in progress** (untrusted local ptau) | [`l2/prover/batch.mjs`](./l2/prover/batch.mjs), [`circuits/README.md`](./circuits/README.md) |

Always-on arithmetic (from the 2s period):

| Clock | Empty blocks | Proof batches (`batchSize=4`) |
| --- | ---: | ---: |
| 1 hour | 1,800 | 450 |
| 12-hour poll | 21,600 | 5,400 |
| 30-day always-on | ~1.3 million | ~324,000 |

### CPU / RAM class (estimate)

Nothing in-tree pins an instance size. The **RAM driver** is the sequencer: it **loads every block file into memory** on start (`ChainState.load`). The Node holds `republic.json` + `l2-chain.json` in process (`apps/node/src/store.mjs`, `explorer.mjs`).

| Role | Class (estimate) | Why |
| --- | --- | --- |
| Local demo / town meeting | **2 vCPU / 4 GB** | Three Node 22 processes + JSON store. Mock prover. |
| County / medium poll (hours–days) | **4 vCPU / 8 GB** | Sequencer RSS grows with chain length; JSON rewrite under load. |
| Always-on L2 for weeks | **8 GB+** or **stop the sequencer between elections** | ~1.3M empty blocks/month in RAM is a practical limit long before Merkle depth 20. |
| Real Groth16 (future, not this default) | Extra CPU during prove; **not** the Compose default | `DEV_MOCK_PROOF=true`; production keys are not in git. |

### Always-on vs election-window (estimate)

Compose is **always-on** (`restart: unless-stopped`). That is a host choice, not a product fee.

| Mode | Monthly host $ (estimate, Coolify/VPS US/EU) | Notes |
| --- | --- | --- |
| **Election-window** — Node up for registration; sequencer+prover for the poll + a few hours either side | **$10–40** | Same 2–4 GB box; idle most of the month. Disk stays small (see §2). |
| **Always-on L2** — 2s empty blocks 24/7 | **$20–80** | Host is still cheap; **disk and RAM** grow every idle second. Do **not** attach mainnet `submitBatch` in this mode (see §3). |
| **Always-on + public results** | **$25–120** | Add bandwidth (see §6). Still one box in this tree — no extra “results cluster.” |

Voters remain gasless in both modes.

---

## 2. Disk needed

### Repo facts — what to volume-mount

| Volume / path | Env | Contents |
| --- | --- | --- |
| Compose `node-data` → container **`/data`** | `DATA_DIR=/data` | `republic.json`, `l2-chain.json`, `receipt-pdf.secret` | [`Dockerfile`](./Dockerfile), [`docker-compose.yml`](./docker-compose.yml), [`apps/node/README.md`](./apps/node/README.md) |
| Compose `l2-data` → container **`/data`** | `L2_DATA_DIR=/data` | `blocks/{n}.json`, `head.json`, `mempool.json`, `sealed.json`, `proofs/batch-N.json` | [`l2/Dockerfile`](./l2/Dockerfile), [`l2/sequencer/state.mjs`](./l2/sequencer/state.mjs), [`l2/prover/index.mjs`](./l2/prover/index.mjs) |
| **Do not** `COPY` voter data or `.ptau`/`.zkey` into the image | [`.dockerignore`](./.dockerignore), [`docs/OPERATOR.md`](./docs/OPERATOR.md) | Mount proving keys as a volume when you have them |

**Coolify (operator assumption, not an in-tree file):** Coolify speaks Compose. Give the stack **persistent volumes** on those `/data` mounts (Coolify “Persistent Storage” / destination volume). If Coolify’s backup job can snapshot volumes to **S3**, that is optional host backup — this repo does not configure S3.

Local without Docker: `apps/node/data/` and `l2/data/` (both gitignored).

### Growth (repo facts + measured bytes)

Empty L2 block JSON on this tree: **1423 bytes** compact (`blocks/{n}.json`, includes 256-byte `logsBloom`). Idle mock batch JSON: **~1.1 KB** pretty (`proofs/batch-N.json`). Measured from `formatBlock` / `buildBatch` on this checkout.

| Store | Growth vs voters / elections | GB picture |
| --- | --- | --- |
| **L2 chain data** (`l2-data` `/data/blocks`) | **Time**, not turnout. One file **per 2s block**, empty or not. | Always-on: **~60 MB/day**, **~1.8 GB/30 days** empty blocks. Election-window 12h: **~30 MB**. |
| **Proof artifacts** (`l2-data` `/data/proofs`) | One JSON per `batchSize` blocks (default 4). Mock proofs stay small. | Always-on: **~12 MB/day**, **~0.4 GB/30 days**. Real Groth16 artifacts (future keys) are **not** sized in-tree — reserve extra GB when a ceremony exists. |
| **Node JSON** (`DATA_DIR/republic.json`) | Pretty-printed **whole file rewrite** on persist. Users, elections, votes, envelopes, terms rows. **No SQLite.** | Order-of-magnitude: **~2–10 KB/person** in the store (identity methods + one vote + receipt metadata). 1k voters → tens of MB; 50k → **hundreds of MB**; **1M in one JSON file is not a realistic demo**. |
| **Explorer log** (`DATA_DIR/l2-chain.json`) | Pretty-printed chain of **civic outcomes**. Empty sequencer blocks are **not** ingested (ingest only has txs). | Grows with registrations / disclosed votes / tallies, not with idle 2s ticks. Same order as the public slice of `republic.json`. |
| Compose logs | `max-size: 10m`, `max-file: 3` per service | **≤ ~90 MB** across three services |

**Volume-mount (Coolify `/data`):** persist **both** Compose volumes. Losing `node-data` loses the clerk JSON and explorer log. Losing `l2-data` loses the civic chain and proof JSON. Images are replaceable; `/data` is not.

---

## 3. Cost to post proofs (L1 settlement / tally mirror)

Voters never pay. L1 money is **optional** and only moves when env + keys are set.

### Repo facts

| Path | When it posts | Call | If unset |
| --- | --- | --- | --- |
| **Rollup batch** | Prover has **all three** of `L1_RPC`, `SETTLEMENT_ADDRESS`, `PRIVATE_KEY` | `RollupSettlement.submitBatch(batchIndex, prevStateRoot, newStateRoot, dataHash, a, b, c)` | Writes `l2/data/proofs/batch-N.json` only | [`.env.example`](./.env.example), [`l2/prover/index.mjs`](./l2/prover/index.mjs), [`docs/L2.md`](./docs/L2.md), [`smart-contracts/src/l2/RollupSettlement.sol`](./smart-contracts/src/l2/RollupSettlement.sol) |
| **Tally hash (court mirror)** | Node has `L1_RPC` + `L1_TALLY_MIRROR_ADDRESS` + `L1_PUBLISHER_PRIVATE_KEY` | `L1TallyMirror.postResult(electionId, resultHash, totalBallots, l2StateRoot)` — **hash of counts, not ballots** | Tally still works; certify status `skipped` (`L1 env unset`) | [`docs/OPERATOR.md`](./docs/OPERATOR.md) “L1 certification”, [`smart-contracts/src/l2/L1TallyMirror.sol`](./smart-contracts/src/l2/L1TallyMirror.sol), Foundry [`smart-contracts/script/CertifyL1.s.sol`](./smart-contracts/script/CertifyL1.s.sol) / `npm run certify:l1` |
| **EVM factory / inbox** (Anvil or other EVM, **not** civic `:8546`) | Node `CHAIN_RPC` + factory / inbox / relayer key | `ElectionFactory.createElection`, `BallotInbox.submitVote` via viem | JSON-only demo | [`docs/OPERATOR.md`](./docs/OPERATOR.md), [`apps/node/README.md`](./apps/node/README.md) |

**mockMode vs real proofs**

| Mode | Repo fact |
| --- | --- |
| `DEV_MOCK_PROOF=true` (Compose / `test/unstable` default) | Placeholder Groth16-shaped points. Prover **will still `submitBatch`** if L1 env is set. `RollupSettlement.mockMode` on **DeployL1 is `false`** — L1 deploy is meant for a real verifier; local mock is a **dev** path. |
| `DEV_MOCK_PROOF=false` | Prover **refuses** L1 submit until production Groth16 keys exist (`production groth16 keys are not present`). |
| `RollupSettlement.submitBatch` | If `!mockMode && batchVerifier != 0`, calls `IGroth16Verifier.verifyProof` (BN254 pairing). |
| Vote circuit proving | **Separate** from rollup mock: `REPUBLIC_PROVING_PATH`. Local ptau is **untrusted**. Foundry tests use `MockVerifier`. |

Do **not** point `CHAIN_RPC` at civic `:8546` and expect Solidity `createElection` to execute. `@zk-voting/chain-client` still defaults Anvil `:8545` for EVM calls ([README](./README.md) L2 section).

### Per-batch and per-election (estimate — not `forge` snapshots)

Calldata for `submitBatch` is a handful of `bytes32` + Groth16 `(a,b,c)` (~0.4 KB ABI). **No batch body on L1** in this contract (`dataLength` stored as 0). Pairing (when not mock) is the expensive part: `VoteVerifier` uses precompile `0x08` with a 4-pairing input (`0x300` bytes) — **~0.2–0.4M gas** is the usual Groth16 ballpark, **not measured here**.

| Tx | Gas used (order of magnitude, **unmeasured**) | What you pay it for |
| --- | --- | --- |
| `submitBatch` **mock** / no verifier | ~**0.08–0.15M** | Storage + event |
| `submitBatch` **real Groth16** | ~**0.25–0.45M** | Pairing + storage |
| `postResult` (one per election) | ~**0.05–0.08M** | Three mappings + event |
| `createElection` EIP-1167 clone (EVM only) | ~**0.15–0.3M** | Once per election, not per voter |

USD ≈ `gas × gwei × 1e-9 × $2,500/ETH` (**market-variable**). Example: 120k gas × 10 gwei × 1e-9 × 2500 ≈ **$3**. Quiet mainnet base can sit **≪ 1 gwei** (then divide the 1 gwei column); do not budget only that day.

| Scenario | 1 gwei | 10 gwei | 30 gwei | 100 gwei |
| --- | ---: | ---: | ---: | ---: |
| One mock `submitBatch` (~0.12M gas) | ~$0.30 | ~$3 | ~$9 | ~$30 |
| One Groth16 `submitBatch` (~0.35M gas) | ~$0.90 | ~$9 | ~$26 | ~$90 |
| One `postResult` (~0.06M gas) | ~$0.15 | ~$1.50 | ~$4.50 | ~$15 |
| **Danger:** always-on `submitBatch` every 8s for 30 days (~324k txs, mock) | ~**$100k** | ~**$1M** | ~**$3M** | ~**$10M** |
| Same, Groth16 | ~**$300k** | ~**$3M** | ~**$8M** | ~**$30M** |
| **Intended court path:** one tally hash / election | **~$0.15** | **~$1.50** | **~$4.50** | **~$15** |

**Commander takeaway:** leave prover L1 env **empty** until you mean it. Certify **one tally hash per election** for courts. Do not stream empty 2s batches onto Ethereum mainnet.

Paymaster ETH on a **real EVM** is extra (jurisdiction budget). Civic JSON L2 reports `gasUsed = 0` and a **fake** sponsored balance — **$0** L2 gas.

---

## 4. How many people can vote each time

### Repo facts (caps)

| Cap | Default / rule | Where |
| --- | --- | --- |
| `treeDepth` | Allowed **16..32**. Node API default **20**. Foundry `CreateElection` / `DeployLocal` **20**. Back-office select **20** selected | [`apps/node/src/routes/elections.mjs`](./apps/node/src/routes/elections.mjs), [`smart-contracts/script/CreateElection.s.sol`](./smart-contracts/script/CreateElection.s.sol) `TREE_DEPTH` default 20, [`smart-contracts/script/DeployLocal.s.sol`](./smart-contracts/script/DeployLocal.s.sol), [`apps/node/public/back-office.html`](./apps/node/public/back-office.html), [`circuits/vote.circom`](./circuits/vote.circom) `Vote(20)` |
| Leaves | **2^depth**. Depth 20 ⇒ **1,048,576**. Depth 16 ⇒ 65,536. Depth 32 ⇒ **~4e9** (ARCHITECTURE / back-office label) | [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) `ElectionParams`, [`apps/node/src/merkle.mjs`](./apps/node/src/merkle.mjs) `2 ** treeDepth` |
| `maxParticipants` | **0 = unlimited** (registry still stops at tree capacity). UI default 0 (“unbounded roll”) | [`packages/types/index.js`](./packages/types/index.js), [`smart-contracts/src/interfaces/ElectionParams.sol`](./smart-contracts/src/interfaces/ElectionParams.sol), [`smart-contracts/src/VoterRegistry.sol`](./smart-contracts/src/VoterRegistry.sol) |
| Circuit | `Vote(levels)` must match `treeDepth`. Recompile 16/24/32 to match | [`circuits/README.md`](./circuits/README.md), [`circuits/vote.circom`](./circuits/vote.circom) |
| Block | `maxTxsPerBlock` **4096** | [`l2/config.json`](./l2/config.json) |
| Disclosure | Default **3600 s**. Votes accepted immediately (nullifier unique); **public** only after the UTC hour closes. `0` = instant (local demo / tests) | [`DISCLOSURE_INTERVAL_SECONDS`](./.env.example), [`docs/BLOCK_EXPLORER.md`](./docs/BLOCK_EXPLORER.md), [`l2/README.md`](./l2/README.md) |
| Identity room | Up to **5** emails, **5** passkeys, **5** live cards / licenses per person | [`docs/IDENTITY.md`](./docs/IDENTITY.md), [`apps/node/src/identity.mjs`](./apps/node/src/identity.mjs) |
| Registration | Civil `POST .../register` is **pending** until a registrar/clerk approves (unless officer insert). No DMV connector unless `CREDENTIAL_PROVIDER_SECRET` | [`docs/OPERATOR.md`](./docs/OPERATOR.md) |

Merkle **depth 20 ⇒ ~1M leaves** is a **circuit / tree** ceiling, not a load test.

### Practical bottlenecks (this demo stack)

These bite **far below** 1M:

| Bottleneck | Why |
| --- | --- |
| **One JSON file** | `republic.json` is parsed and rewritten as a whole. Fine for hundreds–low thousands; painful at tens of thousands; not a national roll. |
| **Sequencer RAM** | All `blocks/*.json` loaded into memory. Weeks of always-on empty blocks dominate long before 1M votes. |
| **Hourly disclosure dump** | After an hour closes, sealed votes are mined hashed-order. 4096 tx/block × 2s can drain a large hour, but the **Node persist** of each accept is the choke, not Merkle hashing. |
| **Manual registrar queue** | Unlimited tree does not mean unlimited **human** approvals. |
| **Tally circuit** | In-tree `Tally(8, 4)` is a **demo** size. Production Node tally for `opens_ballots` is off-circuit (threshold-1 key, **NON-PRODUCTION**). |
| **MockVerifier / stand-in hasher** | Binding elections need Poseidon + a real ceremony — not a capacity number, a **trust** gate ([`circuits/HASH_SCHEME.md`](./circuits/HASH_SCHEME.md)). |

**Working planning numbers (estimate, not a guarantee):**

| Election size | Fits this tree as a demo? |
| --- | --- |
| Board / union (**≤ ~200**) | Yes. 2 vCPU / 4 GB. |
| Town / small city (**~1k–10k**) | Yes if you watch JSON size and do not always-on the sequencer for months. |
| County (**~50k**) | Possible with **8 GB**, election-window L2, and accepting slow JSON persists. Not “live precinct tick.” |
| **~1M (depth 20)** | Tree **allows** it. **Node + civic JSON L2 as written do not.** Needs a different store (not in this repo). |

---

## 5. AWS (SES now; S3 only if the host backups)

### Repo facts — SES

Transactional mail is **AWS SES (SESv2)** when **`SES_FROM_ADDRESS` and `AWS_REGION`** are set. Empty = local capture, no outbound mail.

| Env | Role |
| --- | --- |
| `SES_FROM_ADDRESS` | From (required to send) |
| `AWS_REGION` (alias `SES_REGION`) | SES region. README fork example: `us-east-1` |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Optional. **Empty → host IAM / instance role** |
| `SES_CONFIGURATION_SET` | Optional SESv2 configuration set |
| `SES_ENDPOINT` | Optional (local stack) |
| `SES_DRY_RUN` | Skip send |
| `REQUIRE_EMAIL_MFA` | Force OTP in tests; production follows SES configured |

Cited: [`.env.example`](./.env.example), [`docs/OPERATOR.md`](./docs/OPERATOR.md) Terms / MFA, [`apps/node/src/mailer.mjs`](./apps/node/src/mailer.mjs), [`apps/node/src/config.mjs`](./apps/node/src/config.mjs).

What SES sends:

- **6-digit MFA** on every non-dev login (primary inbox).
- **Terms PDF** on first accept of a hash (raw MIME attachment; SESv2 Simple cannot attach).
- Optional **vote-receipt PDF** (locked).
- **Official outcome PDF** to subscribers (voters subscribed by default when they vote).

No S3 client, bucket env, or Coolify backup config lives in this repository.

### Monthly $ (estimate, market-variable)

AWS SES list (2026): **à-la-carte ~$0.10 / 1,000** emails; **new accounts default Essentials ~$0.16 / 1,000** (first 10M). Attachments: à-la-carte **~$0.12 / GB**. Confirm [aws.amazon.com/ses/pricing](https://aws.amazon.com/ses/pricing/). Civic OTP is tiny; PDFs dominate attachment GB.

Planning volumes (not code constants — **~4–8 messages / person** if they register, MFA a few times, accept terms, optionally email a receipt, and get the outcome PDF):

| Scale | Emails / month (order) | SES send $ | Attachment $ | **SES total** |
| --- | ---: | ---: | ---: | ---: |
| Small (500 voters, one poll) | ~3k–5k | **< $1** | **< $0.05** | **~$0–2** |
| Medium (50k voters) | ~0.2–0.4M | **~$20–65** | **~$0.50–2** | **~$20–70** |
| Quiet month (officers only) | hundreds | **cents** | none | **~$0–1** |

Dedicated IPs / Pro–Enterprise SES plans (**$105+ / mo**) are **not required** for this product. Stay on Essentials or à-la-carte unless deliverability policy says otherwise.

### Optional S3 backups (Coolify / host — estimate)

If Coolify (or the VPS) snapshots `/data` volumes to S3: **not in-tree**. S3 Standard is still **cents/GB-month** at the sizes in §2 (idle L2 ~2 GB/month; election-window << 1 GB). Budget **$1–5 / mo** for backups at small/medium, not hundreds.

---

## 6. Showing results “live”

### What “live” means here (repo fact)

**Hourly disclosure, not a live precinct tick.**

- Votes are **accepted immediately** (nullifier spent once).
- Public explorer / turnout / receipts show the ballot **only after the hour that contained it has closed** (`DISCLOSURE_INTERVAL_SECONDS`, default **3600**).
- A 14:05 vote appears at **15:00**, lumped with that hour, ordered by hash/nullifier, timestamp = hour boundary — not the minute they left the office.
- During voting, `/outcomes` shows **disclosed turnout only**, never unofficial option counts. Certified counts appear **after tally**.
- `DISCLOSURE_INTERVAL_SECONDS=0` is **local demo / tests**, not a public jurisdiction.

Cited: [`docs/BLOCK_EXPLORER.md`](./docs/BLOCK_EXPLORER.md), README public UI, [`docs/OPERATOR.md`](./docs/OPERATOR.md) explorer / outcomes.

Public pages on the **same Node** (`PORT=3000`): `/explorer`, `/elections/:id/results`, `/elections/:id/summary`, `/outcomes`, `/receipt`. Backend: `l2-chain.json` + `GET /api/explorer/*`. Independent auditors use `GET /api/elections/:id/artifacts` — Node may be down; chain records remain.

### Cost of explorer / results (estimate)

No extra results cluster. Same Express process, vanilla JS (no Vite/React CDN product). The bill is **egress + CPU** on the Coolify/VPS box.

| Traffic | Extra $ (estimate) |
| --- | ---: |
| Officers + a few observers | **~$0–5 / mo** (often inside the VPS cap) |
| County + press refreshing `/explorer` and `/outcomes` | **~$5–30 / mo** on a typical 1–5 TB VPS cap; JSON APIs are small compared to video |

Do **not** add a second “results app”, a websocket tick, or a public mempool of sealed votes. That would break the hour-bucket privacy rule.

L1 explorer (Etherscan on `submitBatch` / `postResult`) is **free to the public**; you already paid the gas in §3.

---

## Roll-up (jurisdiction at cost)

| Line | Small poll (hundreds, election-window) | Medium poll (tens of thousands) |
| --- | ---: | ---: |
| VPS / Coolify host (Node+L2+prover) | **$10–40 / mo** | **$40–120 / mo** |
| Disk `/data` | **< 5 GB** | **10–50 GB** headroom (JSON + short L2 window) |
| SES | **~$0–2** | **~$20–70** that month |
| L1 (tally hash only) | **$0–$15** | **$0–$15** |
| L1 (always-on batch stream) | **Do not** | **Do not** |
| **Voters** | **$0** | **$0** |

Nobody is to make money off this repository. If a quote includes a Republic “license,” a token, or a per-voter fee, it is not this software.

---

## Citation index

| Topic | Paths |
| --- | --- |
| NFP / at cost | [`NOT_FOR_PROFIT.md`](./NOT_FOR_PROFIT.md), README “Not for profit”, [`docs/L2.md`](./docs/L2.md) “Gas and money” |
| Compose / ports / `/data` | [`docker-compose.yml`](./docker-compose.yml), [`Dockerfile`](./Dockerfile), [`l2/Dockerfile`](./l2/Dockerfile), [`.env.example`](./.env.example) |
| L2 genesis / RPC / mock proofs | [`l2/genesis.json`](./l2/genesis.json), [`l2/config.json`](./l2/config.json), [`l2/README.md`](./l2/README.md), [`docs/L2.md`](./docs/L2.md) |
| Operator / SES / L1 env | [`docs/OPERATOR.md`](./docs/OPERATOR.md) |
| Factory / tree / paymaster scripts | [`smart-contracts/script/CreateElection.s.sol`](./smart-contracts/script/CreateElection.s.sol), [`DeployLocal.s.sol`](./smart-contracts/script/DeployLocal.s.sol), [`DeployL1.s.sol`](./smart-contracts/script/DeployL1.s.sol), [`DeployL2.s.sol`](./smart-contracts/script/DeployL2.s.sol) |
| Settlement / mirror | [`smart-contracts/src/l2/RollupSettlement.sol`](./smart-contracts/src/l2/RollupSettlement.sol), [`L1TallyMirror.sol`](./smart-contracts/src/l2/L1TallyMirror.sol) |
| Hourly disclosure | [`docs/BLOCK_EXPLORER.md`](./docs/BLOCK_EXPLORER.md) |
| Circuits depth 20 | [`circuits/vote.circom`](./circuits/vote.circom), [`circuits/README.md`](./circuits/README.md) |

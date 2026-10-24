# Web trusted-setup ceremony

**NOT FOR PROFIT** — civic public good. Not a commercial product. See [`/NOT_FOR_PROFIT.md`](../NOT_FOR_PROFIT.md).

License: AGPL-3.0-or-later.

zk-voting proves ballots and tallies with Groth16. Groth16 needs a circuit-specific **phase-2** setup, and whoever knows all of its secret randomness ("toxic waste") can forge proofs that verify. A ceremony spreads that secret across many people: each adds fresh randomness and throws it away. The keys are safe if **at least one** contributor was honest.

This page covers the browser ceremony served by the Node at `/ceremony`. The command-line runbook for the same phase 2 is [`CEREMONY.md`](./CEREMONY.md). Both use snarkjs and produce keys that `snarkjs zkey verify` accepts.

**A production ceremony has not been run.** Keys exported by this tool are marked `trusted: false` and stay in the Node's data directory until a human reviews them. Nothing here deploys a verifier or edits `smart-contracts/`.

---

## Which ceremonies are needed

One ceremony per production circuit and parameter set:

| Circuit | File | Parameters | Phase 1 |
| --- | --- | --- | --- |
| Ballot proof | `circuits/vote.circom` | `Vote(20)` (tree depth 20) | Hermez `powersOfTau28_hez_final_16.ptau` covers it (measure with `npm run circuits:status`) |
| Tally proof | `circuits/tally.circom` | `Tally(8, 4)` | Choose the smallest Hermez power that fits the compiled constraint count |

A different tree depth or tally shape is a different circuit and needs its own ceremony. Phase 1 (powers of tau) is reused from the public Hermez ceremony; it is not run here.

---

## Roles and pages

| Page | Who | What |
| --- | --- | --- |
| `/admin/ceremony` | Platform super admin | Upload inputs, create a ceremony, open and close the window, manage the queue, commit the beacon, finalize, download exports, read the audit log |
| `/ceremony` and `/ceremony/<id>` | Any signed-in account (or an invited list) | Join the queue, contribute in the browser when it is your turn, download a receipt |
| `/ceremony/<id>/transcript` | Anyone, no sign-in | Read every contribution, check the hash chain, and **verify the whole chain** in the browser or from the command line |

The coordinator API (`/api/ceremony-admin/*`) refuses everyone except the platform super admin, and refuses API keys. A delegable `manage_ceremony` capability is a TODO in the code.

---

## How to run a ceremony

1. **Compile the circuit** from the reviewed commit (`npm run circuits:compile`) and note the `.r1cs` SHA-256.
2. **Fetch the phase-1 file yourself.** The Node never downloads anything. The coordinator page lists the Hermez URLs and their published BLAKE2b-512 hashes.
3. **Upload inputs** on `/admin/ceremony` or copy them into `CEREMONY_INPUT_DIR` (needed for files above `CEREMONY_MAX_INPUT_MB`). Inputs are never overwritten.
4. **Create the ceremony.** Pick the `.r1cs` and `.ptau`. Pin the ptau with a Hermez preset (BLAKE2b-512) or paste a SHA-256 / BLAKE2b-512 hash. Optionally pin the `.r1cs` SHA-256. The Node checks both pins and runs `groth16 setup` to make contribution #0 (setup fails if the ptau is too small for the circuit). It starts as a draft.
5. **Choose participation.** Any signed-in account, or a list of invited handles. Set a turn length (1 to 1440 minutes, default 30). The minimum number of contributions is at least 2 (default 3).
6. **Open the window.** Participants join a queue. Only the person at the head of the queue can upload. A turn that runs out passes to the next person.
7. **Commit the beacon** before closing (see below). It can be replaced while the window is open.
8. **Close the window** once the minimum is met and a beacon is committed.
9. **Finalize** after the beacon value is published. Paste it, keep the default 10 iterations (2^10 hashes) unless you have a reason, and wait for the job. The Node applies the beacon, verifies the final key against the `.r1cs` and ptau, and exports.
10. **Review the exports** (`<circuit>_final.zkey`, `<circuit>_verification_key.json`, `<circuit>_Groth16Verifier.sol`, `export.json`). They carry `trusted: false` and a review banner. Copying a verifier into `smart-contracts/` is a separate, reviewed change.

### What a participant does

1. Sign in, open `/ceremony/<id>`, and press **Join the queue**.
2. When it is their turn, move the pointer over the randomness box or type into it. The browser's secure random generator is always mixed in, so this only adds to it.
3. Enter a public name (a pseudonym is fine) and an optional attestation, then press **Contribute**.
4. The page downloads the latest key, checks its SHA-256 against the transcript, runs `snarkjs zkey contribute` **in a Web Worker in that tab**, and uploads only the new key. The randomness never leaves the tab, and the worker zeroes its buffers when done.
5. The page compares the contribution hash the server computed with the one the browser computed, then downloads a JSON receipt (also kept in the browser so it can be downloaded again).

Contributors who want more assurance can use the CLI instead (`circuits/scripts/ceremony.mjs contribute` on an offline machine) and hand the result to the coordinator; the web flow is for reach, not for the strongest possible hygiene.

---

## How to verify

### In the browser

On `/ceremony/<id>/transcript`:

- **Check the hash chain** recomputes every transcript entry's SHA-256 link with SubtleCrypto. Instant.
- **Verify whole chain** downloads `circuit.r1cs`, `phase2.ptau`, and the latest (or final) zkey, checks their SHA-256 against the transcript, runs `snarkjs zkey verify` in a worker, and checks that every contribution hash and name, and the beacon, match the transcript.

### From the command line

The transcript page prints the exact commands for that ceremony. In short:

```bash
curl -fsSLO https://<node>/api/ceremonies/<id>/transcript.json
curl -fsSL -o circuit.r1cs https://<node>/api/ceremonies/<id>/files/circuit.r1cs
curl -fsSL -o phase2.ptau  https://<node>/api/ceremonies/<id>/files/phase2.ptau
curl -fsSL -o final.zkey   https://<node>/api/ceremonies/<id>/files/zkey_final.zkey
sha256sum circuit.r1cs phase2.ptau final.zkey   # compare with transcript.json
npx snarkjs@0.7.6 zkey verify circuit.r1cs phase2.ptau final.zkey
```

`snarkjs zkey verify` lists every contribution hash. Each one must match `contributions[].contributionHash` in the transcript, and the beacon line must match `beacon.applied`. Also compare the ptau's hash with the published Hermez hash yourself (`b2sum phase2.ptau`).

### What the transcript contains

`transcript.json` (schema `zk-voting.groth16.phase2.web-transcript.v1`) records the circuit and ptau hashes, the initial zkey, each contribution (index, public name, contribution hash, zkey SHA-256, previous zkey SHA-256, attestation, accepted time), the beacon commitment and value, the final key, exports, and two hash chains:

- **Contribution chain**: each entry's `hash` is SHA-256 over its canonical JSON plus the previous entry's `hash` (genesis is 64 zeros). Editing or reordering any past entry breaks every later link.
- **Audit chain**: every coordinator and participant action (create, open, join, leave, upload accepted or rejected, beacon commit, close, finalize) is an append-only, hash-linked log entry. It records handles and actions, never IP addresses.

---

## Beacon

The last human contributor could, in principle, keep their randomness. The beacon closes that gap: a final contribution from public randomness that nobody knew while contributions were open.

The coordinator **commits to a future source before closing**:

- **drand (recommended).** A round of the League of Entropy `quicknet` chain (3-second rounds) or the `default` chain (30-second rounds). The Node refuses a round whose publish time has already passed, and refuses to finalize before it. Pick a time after you plan to close; the page fills in the round. The value is the round's `randomness` field (`https://api.drand.sh/<chain-hash>/public/<round>`).
- **Block hash.** A future block height on Ethereum mainnet or Bitcoin mainnet. The Node cannot check the time, so pick a height comfortably after the close.

The commitment and its time are in the transcript and the audit log. At finalize the coordinator pastes the published 32-byte value; anyone can look it up at the recorded URL and compare.

---

## Threat model

| Threat | Mitigation |
| --- | --- |
| Every contributor colludes or is compromised | Out of scope by design. Recruit independent contributors (other jurisdictions, auditors, the public). Security needs one honest participant. |
| A malicious contributor uploads a key that is not a valid contribution | The Node runs `snarkjs zkey verify` (`verifyFromR1cs`) against the `.r1cs`, the pinned ptau, and the whole chain before accepting. Exactly one new contribution, built on the current tip, with the public name the uploader gave. |
| Two people upload on the same parent (fork) | Uploads carry the parent index. Only the person whose turn it is can upload, one upload at a time; a stale parent is refused. |
| Oversized or junk uploads | Body size capped at the tip size plus 64 KiB and at `CEREMONY_MAX_ZKEY_MB`. Per-account and per-IP rate limits (join 20 and upload 10 per 10 minutes). |
| The coordinator edits history | Hash-chained transcript and audit log. Anyone can recompute both and re-verify the full key chain from public files. |
| The coordinator biases the final key with the beacon | The beacon source is committed before the window closes, to a value published later. |
| The server learns a contributor's randomness | Randomness is generated and used only in the browser worker. Only the resulting key is uploaded. |
| A tampered page or script steals randomness | Pages are same-origin only with a strict CSP (below). snarkjs is served from the Node, not a CDN. A contributor who does not trust the host can use the CLI. |
| A wrong phase-1 file | The ptau must match a pinned hash (Hermez preset or pasted). The Node never fetches it. |
| Exports are deployed by accident | Exports stay in the data directory with `trusted: false` and a review banner. Nothing is copied into `smart-contracts/`. |

Not covered: a compromised contributor device, or a host that serves malicious JavaScript to one participant. Independent contributors and the public transcript are the defence; the CLI path removes the browser from the trust base.

---

## CSP

Only the ceremony pages carry a Content-Security-Policy, so the rest of the app is unchanged.

- **Pages** (`/ceremony*`, `/admin/ceremony*`, and their own JS and CSS): `default-src 'self'; script-src 'self'; worker-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`. No inline scripts, no inline styles, no eval.
- **Worker and vendored snarkjs** (`/ceremony-worker.js`, `/vendor/snarkjs.min.js`): `default-src 'none'; script-src 'self' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; connect-src 'self'; base-uri 'none'`.

`'wasm-unsafe-eval'` lets snarkjs compile its WebAssembly field arithmetic (ffjavascript); it does not allow JavaScript `eval`. `blob:` is needed because ffjavascript starts its own threads from blob URLs. Both are limited to the worker scripts. Pages also send `X-Content-Type-Options: nosniff` and `Referrer-Policy: same-origin`.

---

## Limits and settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `CEREMONY_DIR` | `DATA_DIR/ceremonies` | Per-ceremony files: inputs copied in, every zkey, transcript, exports |
| `CEREMONY_INPUT_DIR` | `DATA_DIR/ceremony-inputs` | Where the coordinator's `.r1cs` and `.ptau` files are picked from |
| `CEREMONY_MAX_ZKEY_MB` | `1024` | Largest contribution upload |
| `CEREMONY_MAX_INPUT_MB` | `2048` | Largest input uploaded through the page (larger files: copy into the input directory) |

Each ceremony keeps every intermediate zkey, so disk use is roughly (contributions + 2) × zkey size plus the ptau. Back up `CEREMONY_DIR` with the rest of `DATA_DIR`.

Rate limits are kept in memory per Node process. Verification of a large circuit takes minutes; the participant's page polls a job.

---

## Relation to other tools

- **CLI** ([`CEREMONY.md`](./CEREMONY.md)): same phase 2, run by hand. It accepts a beacon of 1 to 255 bytes and requires 2 contributions. The web ceremony uses a committed drand round or block hash (32 bytes) and defaults to 3.
- **Nuursha** (a sibling project) contributed the shape: refuse to finalize below a minimum count, require a public beacon fixed after the last contribution, run `zkey verify`, and publish per-contribution hashes. Differences: Nuursha has no UI, requires at least 3 contributions, takes a 64-hex beacon, downloads the ptau in its Makefile, and loads snarkjs from a CDN. Here the Node never fetches, and snarkjs is served locally.

The toy circuit in `apps/node/test/fixtures/ceremony` is for tests only. Its phase-1 file was made with published entropy and is not trusted.

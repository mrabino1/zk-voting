# Groth16 phase-2 ceremony runbook

**NOT FOR PROFIT** — civic public good. Not a commercial product. See [`/NOT_FOR_PROFIT.md`](../NOT_FOR_PROFIT.md).

**A ceremony has not been run.** The scripts in this document move zkeys around and check them. They do not attest that a public multi-party setup happened, and they have no flag that marks keys trusted. Every transcript they write keeps `ceremony: "not-done"` and `trusted: false`.

The committed Vote(4) files in [`circuits/fixtures/untrusted`](../circuits/fixtures/untrusted/README.md) are a local Groth16 fixture with **published** entropy. They are not this ceremony. `MockVerifier` remains the Foundry unit-test default. Do not deploy an export from this tooling for a binding election.

License: AGPL-3.0-or-later.

**Browser ceremony.** The Node also runs this phase 2 as a web ceremony: a coordinator page at `/admin/ceremony`, in-browser contributions at `/ceremony`, and a public transcript with a whole-chain verifier. See [`ceremony-web.md`](./ceremony-web.md). This runbook stays the reference for offline contributions and for checking any key by hand.

---

## What phase 2 is

Groth16 needs a structured reference string.

1. **Phase 1** is powers-of-tau. It is circuit-independent. ZK-Voting does not run that ceremony in this repository. A coordinator points phase 2 at a phase-2-prepared `.ptau` file.
2. **Phase 2** is circuit-specific. `groth16 setup` binds one `.r1cs` to that `.ptau` and produces `zkey_0000.zkey`. That file still contains phase-2 toxic waste. Each later participant re-randomizes it. A final **beacon** contribution uses public randomness so the last human participant does not know the finished key either.

`circuits/scripts/ceremony.mjs` (wrapper: `circuits/scripts/ceremony.sh`) runs only phase 2:

| Command | Who | What it does |
| --- | --- | --- |
| `init` | Coordinator | `snarkjs groth16 setup` → `zkey_0000.zkey` and `transcript.json` |
| `contribute` | Participant | `snarkjs zkey contribute` on the latest zkey |
| `accept` | Coordinator | Verify a participant's zkey and append it to the transcript |
| `verify` | Either | `snarkjs zkey verify` on the setup zkey, every contribution, and the beacon zkey if present |
| `beacon` | Coordinator | `snarkjs zkey beacon` with a hash the coordinator supplies |
| `export` | Coordinator | Copy the final zkey; write `verification_key.json` and a Solidity verifier |

`export` refuses to write under `smart-contracts/src` or `circuits/fixtures`. Do not copy the Solidity file onto `smart-contracts/src/zk/VoteVerifier.sol`.

---

## Rules that keep the keys untrusted

- The script overwrites `ceremony`, `trusted`, `attestation`, and `publicCeremony` on every save. Hand-editing them to claim a ceremony makes `verify` fail.
- `--trusted`, `--ceremony-done`, and `--claim-ceremony` are refused.
- Private entropy is read from `ZK_VOTING_CEREMONY_ENTROPY` and is not written into the transcript, the sidecar, or the log line. `--entropy` on the command line is refused for that reason.
- A drill may pass `--published-entropy`. The transcript then stores that string so it is obvious the toxic waste is known. The CI toy does this. A published-entropy transcript is not a ceremony.
- `beacon` does not download Bitcoin, drand, or any other public source. It records `source: "coordinator-supplied"`. A hash you chose yourself is not a random beacon.
- Phase 1 is labeled `untrusted-local` unless the coordinator passes `--phase1 external` and a `--phase1-note` naming the public file. External phase 1 still does not complete phase 2.

Attesting a real ceremony is a human act: publish the procedure, the participant list, the contribution hashes, and the precommitted beacon source, then land that record in a reviewed commit. These scripts will not do that for you. Until that record exists, treat every zkey and verifier from this tool as untrusted, including one that `verify` says is internally consistent.

---

## Coordinator

Work on a machine that can hold the `.ptau` and the zkeys. Keep the ceremony directory out of git until you intend to publish `transcript.json`. Zkeys match `*.zkey` in `.gitignore`. The default toy directory `circuits/build/` is gitignored entirely.

### 1. Pin the circuit

Compile in public from a commit you name. The smoke circuit is Vote(4), not an election (elections are depth 16..32). `vote.circom` is `Vote(20)`.

```bash
circom circuits/mains/vote_smoke.circom --r1cs --wasm --sym -o circuits/build
# constraint count must be <= 2^power of the ptau you use.
# The Vote(4) smoke circuit is about 5k constraints, so power >= 13.
```

Record the git commit and the sha256 of the `.r1cs` (the transcript stores that hash again at `init`).

### 2. Choose powers-of-tau

Use a public phase-1 file that has already been prepared for phase 2 (`snarkjs powersoftau prepare phase2`), at a power large enough for this `.r1cs`. Record the URL and the file hash in `--phase1-note`.

Do not feed phase 2 with the powers-of-tau from `npm run circuits:setup` or `npm run circuits:smoke`. Those contributions use the published string `zk-voting-local-untrusted-dev-only-not-a-ceremony`.

```bash
node circuits/scripts/ceremony.mjs init \
  --dir ceremonies/vote4 \
  --r1cs circuits/build/vote_smoke.r1cs \
  --ptau /path/to/public_phase2.ptau \
  --circuit vote_smoke \
  --phase1 external \
  --phase1-note "Name the exact public ptau file and its sha256"
```

`--circuit` is a label (`vote_smoke`, `vote`), not a path. `init` copies the r1cs and ptau into the ceremony directory as `circuit.r1cs` and `phase2.ptau`, then runs `snarkjs groth16 setup`.

Publish `transcript.json` and the sha256 of `zkey_0000.zkey`. Participants need that zkey to contribute. They need the r1cs and ptau as well if they will `verify` before contributing.

### 3. Take contributions one at a time

Two participants who both start from the same zkey produce a fork. Accept one. The other must contribute again on the new tip.

When a participant sends only the new zkey (not their copy of `transcript.json`):

```bash
node circuits/scripts/ceremony.mjs accept \
  --dir ceremonies/vote4 \
  --zkey /path/to/participant.zkey
```

`accept` runs `snarkjs zkey verify` against `circuit.r1cs` and `phase2.ptau`, checks that the file contains exactly one new private contribution, checks that every previous contribution hash and name still match, and only then copies the zkey in. The participant name is the name stored inside the zkey.

Then:

```bash
node circuits/scripts/ceremony.mjs verify --dir ceremonies/vote4
```

Publish the new contribution hash and the new zkey hash. Ask the participant to confirm the hash matches what their own `contribute` printed.

Collect at least two contributions before the beacon. A real ceremony wants many independent participants, on machines you do not control. Two is the minimum the `beacon` command will accept, not a recommendation.

### 4. Precommit the beacon, then apply it

Before the last contribution is accepted, publish the randomness source you will use and the exact encoding (the web ceremony uses the hash of a future, finalized Ethereum mainnet block; use the same here). Do not choose the hash after you have seen the last contribution.

When that value is public, pass the bytes yourself. This repository does not fetch them.

```bash
node circuits/scripts/ceremony.mjs beacon \
  --dir ceremonies/vote4 \
  --hash <even-length hex, 1..255 bytes> \
  --iterations 10 \
  --name "Final Beacon" \
  --note "Ethereum mainnet block <number>, block hash, checked by <who>"
```

snarkjs requires the iteration exponent to be an integer from 10 to 63. `10` means `2^10` hash iterations.

`--note` is stored as `beacon.coordinatorNote`. It does not change `source`, which stays `coordinator-supplied`. Verify afterwards:

```bash
node circuits/scripts/ceremony.mjs verify --dir ceremonies/vote4
```

Verification checks the setup zkey, each contribution zkey, and `zkey_final.zkey`. A passing verify means the files match each other and the circuit. It does not mean a public ceremony took place.

### 5. Export

```bash
node circuits/scripts/ceremony.mjs export \
  --dir ceremonies/vote4 \
  --out ceremonies/vote4/export
```

`export` verifies the transcript again, copies the final zkey, and writes:

- `<circuit>_final.zkey`
- `<circuit>_verification_key.json`
- `<circuit>_Groth16Verifier.sol` with an `UNTRUSTED GROTH16 VERIFIER — ceremony not done` banner
- `EXPORT.json` with `ceremony: "not-done"` and `trusted: false`

The Solidity file is the snarkjs Groth16 template plus that banner. Deploying it, and wrapping it with `Groth16VerifierAdapter`, is a later step for a key you have actually decided to trust. This export is not that decision. The circuit depth must match the election (`Vote(20)` versus the Vote(4) smoke circuit).

---

## Participant

1. Get the coordinator's ceremony directory, or at least the latest zkey plus `transcript.json`, `circuit.r1cs`, and `phase2.ptau`.
2. Check it before you add entropy:

```bash
node circuits/scripts/ceremony.mjs verify --dir <ceremony-dir>
```

Confirm `ceremony` is `not-done`. Confirm your view of the latest contribution hash matches what the coordinator published. If `verify` fails, do not contribute.

3. Generate entropy locally (at least 32 characters; use a long draw from a CSPRNG). Put it in the environment so it is not an argument to the script:

```bash
read -s ZK_VOTING_CEREMONY_ENTROPY
export ZK_VOTING_CEREMONY_ENTROPY
```

4. Contribute. Either update a directory you hold:

```bash
node circuits/scripts/ceremony.mjs contribute \
  --dir <ceremony-dir> \
  --name "Your Name"
```

or, if you only have the previous zkey:

```bash
node circuits/scripts/ceremony.mjs contribute \
  --in zkey_000N.zkey \
  --out zkey_next.zkey \
  --name "Your Name"
```

The script prints a 64-byte contribution hash. The standalone form also writes `zkey_next.zkey.contribution.json` with that hash and **without** your entropy.

5. Send the new zkey to the coordinator over a public channel. Do not send `ZK_VOTING_CEREMONY_ENTROPY`. Unset it (`unset ZK_VOTING_CEREMONY_ENTROPY`) and delete any file you used to hold it.
6. Wait until the coordinator publishes a transcript that includes your hash. Compare it to the hash you printed. If they accepted someone else's fork of the same parent zkey, contribute again on the new tip. Your previous zkey cannot be appended out of order.

You do not run `beacon` or `export`.

---

## CI toy (not a ceremony)

`circuits/ceremony/toy.circom` is a one-constraint square. It is not `Vote`. The GitHub job **untrusted toy phase-2 transcript** runs:

```bash
npm run circuits:ceremony:toy
```

That command:

1. Compiles the toy circuit (Circom 2.2.2; the script can download the pinned linux-amd64 binary into `circuits/build/bin/` when `circom` is not on `PATH`).
2. Builds a **published-entropy** powers-of-tau at power 4 and prepares phase 2.
3. Takes three phase-2 contributions. The third is a standalone `contribute` followed by `accept`, so both participant paths run.
4. Applies the published beacon hash `0123456789abcdef` repeated to 32 bytes, with iteration exponent 10, and the note that this is not a random beacon.
5. Verifies the transcript and exports an untrusted verifier under `circuits/build/ceremony-toy-test/export/` (the test directory).

The entropy strings contain `not-a-ceremony` and are stored in the transcript because they are published. Delete that directory when you are done; it is gitignored via `circuits/build/`.

A green CI job means the scripts can build and check a multi-contributor transcript. It does not mean ZK-Voting has a trusted setup.

---

## Command reference

```bash
node circuits/scripts/ceremony.mjs help
npm run circuits:ceremony -- help
```

Same commands through `circuits/scripts/ceremony.sh`.

snarkjs underneath:

```text
snarkjs groth16 setup <circuit.r1cs> <phase2.ptau> zkey_0000.zkey
snarkjs zkey contribute <prev.zkey> <next.zkey> --name=<participant>
snarkjs zkey verify <circuit.r1cs> <phase2.ptau> <zkey>
snarkjs zkey beacon <prev.zkey> zkey_final.zkey <beaconHex> <iterationsExp> --name=<name>
snarkjs zkey export verificationkey zkey_final.zkey verification_key.json
snarkjs zkey export solidityverifier zkey_final.zkey verifier.sol
```

The script redacts `--entropy` in its own log line. snarkjs still receives the entropy as a process argument. Contribute on a machine you trust, and do not leave that process's environment in a shared log.

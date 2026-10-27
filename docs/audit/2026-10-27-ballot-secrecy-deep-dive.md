# Ballot secrecy deep dive

**Verdict: Partially.** An individual's vote can be reconstructed on this branch when a live contract entry point or a demo mechanism below is used. It cannot be reconstructed by a passive chain observer of a PRF-path ballot that a shared relayer submitted with `submitVote` and that nobody later opens.

**Date:** 2026-10-27
**Branch:** `test/unstable`
**Commit reviewed:** `107820779f5a22069f5b1432cd7e2ec7ff83d3ac`
**Reviewer:** source review of this tree (contracts, circuits, demo Node, demo client, L2 sequencer, archive, token polls). No code was changed. Contracts were not re-executed for this note; every finding is a behavior present in the files cited.
**Question:** can an operator, a relayer / paymaster / bundler, a jurisdiction admin, a chain observer, a forum operator, or a mix of those reconstruct how an individual voter voted?

This note treats that as a hypothesis. “How they voted” means the **option** (or ranking), not merely that a ballot was accepted. A join from a person to a nullifier is reported separately, because that join plus any later opening is the option.

Related design notes already in the tree: `demo/docs/how_voters_privacy_is_protected.md`, `demo/docs/proposals/ballot-unlinkability-contracts.md`. Where those notes and the code disagree, this report follows the code.

---

## Verdict

**Partially.**

A chain observer who only watches the path the demo Node actually relays today — blind vote pass, one shared relayer key, `BallotInbox.submitVote`, and a ciphertext the Node cannot decode — **cannot** read a named person’s option off the contracts. The Poseidon identity on the PRF path is not invertible from the public roll, and the client encryption is not a brute-force puzzle over a small candidate list.

The same contracts **do** publish that option, or the join that makes the option trivial, when callers use functions that are compiled, tested, and still in the ABI on this commit:

- `submitVoteWithClearance` places the identity commitment in the same public transaction as the nullifier and the ballot bytes.
- `submitOpenedTally` places one plaintext option index per accepted ballot in transaction calldata, in inbox order, which lines up with `VoteAccepted` and `ballotHashAt`.

Those two calls are not what `demo/apps/node/src/chain.mjs` sends. They are still live entry points. A tally operator, a relayer, or any account that can submit them can put the reconstruction on chain permanently.

Off the contracts, three demo mechanisms reconstruct the option for a narrower attacker: the PRF-unavailable identity fallback (operator who can read credential ids), threshold partials stored in the Node database (host, after `t` guardians have posted), and ERC-20 polls (anyone, after the disclosure hour, by design).

So the public claim “the contracts let a nefarious actor reverse-engineer an individual’s vote” is **true for those entry points and for the demo mechanisms above**, and **false for a passive reading of a PRF-path, relayer-submitted election that never calls them and never opens ballots**.

---

## Severity

| Level | Meaning in this note |
| --- | --- |
| Critical | Public calldata, events, or storage on a live function recover the option, or recover person ↔ ballot in the same transaction as the ballot bytes. |
| High | A realistic role on this branch (operator, tally host, bundler of account-abstraction ops, poll reader) recovers the option with data the code stores or emits. |
| Medium | The code identifies which ballot is a person’s, but not the option, unless the anonymity set collapses or another finding supplies the opening. |
| Low | A stand-in weakens soundness or a documented claim, and does not itself open a ballot. |

“Real today” means the behavior is in `test/unstable` at the commit above, not only in a proposal.

---

## BS-1 — Critical. Clearance votes publish the identity commitment next to the nullifier

**Real today:** yes. `BallotInbox.submitVoteWithClearance` is in the ABI. Foundry tests call it. The Node’s chain client does **not** call it (`demo/apps/node/src/chain.mjs` only sends `submitVote`). An opt-in ABI still exports it (`demo/packages/chain-client/index.js`, `CLEARANCE_INBOX_ABI`).

**Attacker:** any chain observer. The submitter can be the voter, a relayer, a bundler, or a jurisdiction integration that turned external-party gates on. No secret is required beyond the transaction, which is public. Joining the commitment to a civil name uses the roll the registrar already keeps (`identityLinks` in the Node store, or an off-chain clerk file). That file is the point of registration.

**Reconstruction:**

1. Registration emits `VoterRegistered(electionId, identityCommitment, index)` and stores the leaf (`smart-contracts/src/VoterRegistry.sol` lines 113–134). The Node stores `userId` ↔ commitment when a signed-in person registers (`demo/apps/node/src/store.mjs` lines 1512–1523).
2. A clearance ballot calls `submitVoteWithClearance(..., publicInputs, encryptedBallot, identityCommitment, mustAttestIds)` (`smart-contracts/src/BallotInbox.sol` lines 99–125). `publicInputs[2]` is the nullifier. `encryptedBallot` is the ballot bytes. `identityCommitment` is an ABI argument in the same transaction.
3. `_requireExternalClearance` checks that this commitment is eligible and clears the external-party gate (lines 189–201). It does **not** prove the commitment is the one inside the Groth16 witness. The vote circuit’s public instance is still `[root, disqRoot, nullifier, ballotHash, electionId]` (`circuits/vote.circom` line 15). The commitment is not a public input, so a caller can attach any eligible leaf to any proof.
4. `_recordAcceptance` emits `VoteAccepted(electionId, nullifier, ballotHash, msg.sender)` (lines 244–254). The commitment is not in the event. It does not need to be: it remains in the transaction input forever.
5. The observer now has person → commitment → nullifier → ballot bytes. The option is inside those bytes (plaintext, BS-9), in a later `submitOpenedTally` (BS-2), or available to whoever can decrypt (BS-4).

The interface comment says the commitment “is not stored and is not in VoteAccepted” and that “the civic L2 path checks then discards” it (`smart-contracts/src/interfaces/IBallotInbox.sol` lines 29–42). The first sentence is true of contract storage. The second is not true of the L2 sequencer: a vote payload that contains `identityCommitment` is kept (BS-8).

**Fix:** delete `submitVoteWithClearance` and `_requireExternalClearance`. Put rejections into the disqualification root and require attestations before the eligible root is frozen, which `Vote(20)` already proves. Do not add the commitment as a public input. The sketch in `demo/docs/proposals/ballot-unlinkability-contracts.md` (option A) is the right shape.

---

## BS-2 — Critical. Opened tallies publish every option in calldata, in ballot order

**Real today:** yes, in `Tally.submitOpenedTally`. The Node tally route does **not** call it. It decrypts locally, posts counts, and leaves `openings` out of the HTTP response (`demo/apps/node/src/routes/elections.mjs` lines 955–1081). Any tally-operator key can still call the contract.

**Attacker:** any chain observer of that transaction. The caller must be `params.tallyOperator` (`Tally.sol` lines 190–207). No decryption key is required at read time: the options are arguments.

**Reconstruction:**

1. Each accepted ballot is appended in submission order: `_ballotHashList.push(ballotHash)` and `VoteAccepted` in the same function (`BallotInbox.sol` lines 244–254). `ballotHashAt(electionId, i)` is that list (lines 148–150). `ballotHashOf(electionId, nullifier)` maps the other way (lines 138–140).
2. `submitOpenedTally(electionId, counts, openings, a, b, c)` requires `openings.length == acceptedBallots` (lines 123–137).
3. `_requireHistogram` checks that the multiset of `openings` matches `counts` (lines 227–241). It does **not** check that `openings[i]` is the decryption of ballot `i`. The only bind is `openingsHash = keccak256(abi.encodePacked(openings))` inside the tally proof (`TallyPublicInputs.sol` lines 63–66; `Tally.sol` lines 143–160). With `MockVerifier.acceptAll` (BS-12) that proof checks nothing, so a dishonest operator can file a histogram that is not the real one. An operator who files the **real** openings — the function’s purpose — publishes them.
4. The event `OpenedTallyPosted` stores only hashes (lines 167–168). The `uint256[] openings` array is still in the transaction input. On any EVM that retains inputs, that array is public.
5. Align index `i` across `openings[i]`, `ballotHashAt(i)`, and the `VoteAccepted` log with that `ballotHash`. The result is nullifier → option index. BS-1, BS-3, BS-5, or BS-11 then names the person.

There is no shuffle. `demo/apps/node/src/guardians/aggregate.mjs` lines 45–60 returns each ciphertext unchanged and says this is neither a homomorphic product nor a mix.

**Fix:** stop accepting per-ballot openings on chain. For single-choice ballots, tally a homomorphic product and decrypt only the aggregate. For ranked ballots, require a shuffle proof and open only the shuffled list. Until that exists, do not deploy `TallyScheme.OPENS_BALLOTS`, and do not call `submitOpenedTally`.

---

## BS-3 — High. Without WebAuthn PRF, the vote identity is a public function of the credential id

**Real today:** yes, on the client fallback path. The PRF path is not affected (see “Checked and sound”).

**Attacker:** anyone who can read passkey credential ids from the Node database or from `publicAuthMethod` on a person record. That is the Node operator, a database backup, or a compromised host. Credential ids are stored on the user (`demo/apps/node/src/identity.mjs` lines 174–180 and 445). The Node does not store the PRF output. It does not need to, on this path.

**Reconstruction:**

1. If the authenticator does not return a PRF output, `provisionFromCredential` derives the identity input as SHA-256 of the constant `zk-voting-prf-fallback-identity-v1` concatenated with the credential id (`demo/apps/node/public/passkey-wallet.js` lines 48–49, 528–534, 887–918). The same function runs again at vote time (lines 968–980).
2. `deriveIdentitySecrets` HKDF-SHA-256s that input with salt `zk-voting:identity:v1` and info `trapdoor+nullifier`, then splits 64 bytes into trapdoor and `nullifierSecret` (lines 478–497). The Merkle leaf is Poseidon of those two field elements. Both are determined by the credential id.
3. The value the SPA actually publishes is **not** the circuit nullifier. `authorizeBallot` sets

   `nullifier = keccak256(nullifierSecret || keccak256(utf8(electionId)))`

   where `electionId` is the id passed by the page, which is the election’s Node id (`passkey-wallet.js` lines 1269–1270; `vote.js` lines 772–777). The circuit instead requires Poseidon(`nullifierSecret`, election id) (`circuits/identity.circom` lines 34–48; `circuits/vote_lib.circom` lines 197–201). Mock proofs are accepted anyway (BS-12), so the published nullifier is the keccak one.
4. The operator recomputes that keccak nullifier for each stored credential id and compares it to `votes[].nullifier` and `envelopes[].nullifier` (`store.mjs` lines 2234–2266). A match is person → ballot. Confirm the leaf against `identityLinks` so authenticators that did use PRF are skipped: only the fallback leaf will match.
5. The option is still inside the ciphertext. The fallback does **not** put the account seed on the server, so the sum-only AES key (derived from that seed, lines 1280–1301) is not recoverable from the credential id alone. The option comes from BS-2, from BS-4, or from a plaintext payload (BS-9).

`demo/docs/PASSKEYS.md` describes this fallback as a key derived from an assertion signature or from a device secret the Node never sees. The code derives it from the credential id, which the Node does see. That gap is the bug.

**Fix:** if PRF identity output is missing, refuse to vote. Do not derive `nullifierSecret` from the credential id. Keep the documented rule: the trapdoor is not the account seed, and it is not a function of a server-held identifier.

---

## BS-4 — High. `opens_ballots` decrypts every ballot, and the shares are stored

**Real today:** yes, for elections whose `tallyScheme` is `opens_ballots`. Default tally scheme elsewhere is sum-only, which does not take this path.

**Attacker:** any `t` guardians, acting together. After they POST partials, also the Node host and anyone with a copy of the database. One guardian, and the host before those partials exist, cannot open an envelope. The public tally-key endpoint returns commitments and verification keys, not shares.

**Reconstruction:**

1. The client encrypts a packed choice index under the joint P-256 key, with a fresh ephemeral key and a fresh AES-GCM IV (`passkey-wallet.js` lines 1274–1278; `demo/apps/node/public/tally-crypto.js` lines 178–192). The envelope is stored next to the nullifier (`store.mjs` lines 2259–2266). `GET /api/elections/:id/envelopes` returns that row to a tally operator after cutoff (`elections.mjs` lines 451–468), including `rankingPayload` when one was decoded.
2. Guardians submit per-ballot partial points. `acceptPartials` stores `ballotHash`, `point`, and the DLEQ proof in the election bucket (`demo/apps/node/src/guardianFlow.mjs` lines 76–114). Those points are the decryption shares, not a ciphertext wrapped to the Node.
3. `openBallots` walks every envelope, combines `t` points (`demo/apps/node/src/guardians/threshold.mjs` lines 127–159), and decrypts (`tallyOpen.mjs` lines 67–108). The aggregator does not shuffle (BS-2).
4. The HTTP tally response omits the `openings` array. The process still computed nullifier → option, and the partials remain in the database, so a later reader can recompute it offline. `demo/docs/how_voters_privacy_is_protected.md` says the Node host alone cannot decrypt. That is true only until `t` partials have been stored.

The guardian deal inbox (`GET /api/elections/:id/guardians/:index/inbox`, `elections.mjs` lines 893–918) is unauthenticated. It returns shares sealed to each guardian’s transport key (`demo/apps/node/src/guardians/dkg.mjs` lines 63–84), not ballot plaintext. It becomes a ballot-secrecy break only together with `t` stolen transport keys, which is the same threshold as above.

**Fix:** do not persist per-ballot partials. Decrypt only an aggregate ciphertext, or a shuffled list, and discard shares after the aggregate is formed. Refuse `opens_ballots` while `aggregation` is `undecided`.

---

## BS-5 — High. The account that submits, and any UserOp sender, is tied to that ballot

**Real today:** yes, whenever a vote is not submitted by a shared relayer. The demo Node’s chain path **is** a shared relayer (`chain.mjs` lines 374–392 writes `submitVote` with `RELAYER_PRIVATE_KEY`; the stored row uses `relayer: 'node'`, `relay.mjs` lines 300–304). That default path does not put the voter’s account in `VoteAccepted`.

**Attacker:** a chain observer. For a UserOp, also the bundler, who sees the op before it is included. The paymaster does not add a second identifier, and it does not remove this one.

**Reconstruction:**

1. `VoteAccepted` records `msg.sender` as `relayer` (`BallotInbox.sol` line 253; event at `IBallotInbox.sol` line 7). `submitVote` is permissionless (lines 69–72). A wallet that calls it directly is published next to that nullifier and those ballot bytes.
2. `ZkVotingEntryPoint.handleOps` executes `op.callData` from `op.sender` and emits `UserOpHandled(sender, nonce, paymaster)` (`smart-contracts/src/account/ZkVotingEntryPoint.sol` lines 48 and 81–110). The UserOp layout includes `sender` and `callData` (lines 10–21). If `callData` is `PasskeyAccount.execute` into `submitVote`, the account address and the ballot are in one transaction. `ZkVotingPaymaster.validateAndPay` sponsors gas and returns a boolean (lines 90–98). Sponsorship does not hide `sender`.
3. The passkey helper can sign a user-op hash (`passkey-wallet.js` lines 1218–1250) but the vote POST drops it (`vote.js` `buildVoteRequestBody`, lines 88–106; `relay.mjs` lines 276–279). That omission is what keeps the shipped browser path clean. A deployment that follows the passkey document and submits a real UserOp loses that property.

**Fix:** allow `submitVote` only from an allow-listed relayer or entry point, and document that a UserOp sender is a voter identifier. Do not treat paymaster sponsorship as anonymity.

---

## BS-6 — High. Token polls publish the holding address and the choices

**Real today:** yes. This is declared, not accidental: `privacyMode: 'public_weighted'` (`demo/apps/node/src/polls.mjs` line 78) and `demo/docs/THREAT_MODEL.md` (“Address-hiding is not offered”).

**Attacker:** anyone who can read disclosed poll ballots, the Node database, or the token chain plus the poll record. No collusion.

**Reconstruction:**

1. The ballot row stores `voter`, `choices`, `choiceIndexes`, and the signature (`polls.mjs` lines 489–512).
2. The L2 poll transaction carries `voter` and `choicesHash`, not the option ids (lines 513–520). The hash does not hide the options once the Node row is public: the option list is short, but the code does not rely on that. It publishes the options.
3. `disclosedBallots` / `publicBallot` return `voter` and `choices` after the disclosure hour (lines 532–568). `weightView` returns `choices` once disclosed (line 375).

A forum operator who only runs discussion software learns nothing from this. A token-poll reader learns the whole mapping.

**Fix:** none inside civic ballot secrecy. Keep polls labeled as public weighted signal, and do not describe them as anonymous ballots. If a later mode must hide the holder, it needs a nullifier and a ciphertext, which this module deliberately does not have.

---

## BS-7 — High. On a public EVM the hourly seal does not exist; vote transactions are timed

**Real today:** yes. Hourly disclosure is implemented in the Node explorer and the L2 sequencer. `BallotInbox` increments `acceptedBallots` and emits `VoteAccepted` inside `submitVote`, with `block.timestamp` as the chain’s clock (`BallotInbox.sol` lines 244–254). `demo/docs/how_voters_privacy_is_protected.md` section 7 already says this. It is still a reconstruction path when the anonymity set is small.

**Attacker:** a chain observer, or anyone watching a public RPC. They do not learn a name from the event alone, because the relayer is shared (BS-5). They learn the exact inclusion time of each nullifier.

**Reconstruction:**

1. The Node coarsens `acceptedAt` to the disclosure bucket and sorts a bucket by nullifier before publication (`relay.mjs` lines 214–218; `demo/apps/node/src/explorer.mjs` lines 275–289; `demo/apps/node/src/disclosure.mjs` lines 8–10 and 69–74).
2. If `CHAIN_RPC` is set, `relayVote` also sends one `submitVote` transaction per ballot (`relay.mjs` lines 267–273; `chain.mjs` lines 386–392). Each transaction has its own timestamp. The explorer delay does not rewrite that transaction.
3. An observer who saw a single person vote during a quiet interval matches that person to the only `VoteAccepted` in the interval. After tally, a one-ballot election (or a one-ballot hour whose other ballots are already known) makes the published counts that person’s option. No cryptography is required. This is the usual anonymity-set limit; the contracts do not add padding, a mix, or a delayed inclusion list.

**Fix:** if the inbox is on a public chain, submit ballots in a batch after the hour, in random order, from the relayer, and do not expose a live `acceptedBallots()` that ticks per vote. The L2 seal (`demo/l2/disclosure.mjs`, `isHeldVoteType`) is the model; the Solidity inbox does not implement it.

---

## BS-8 — High. The L2 sequencer keeps identity and answer fields on a vote it was handed

**Real today:** yes, for civic JSON submitted to the sequencer. The Node relay path strips those keys before it builds a vote (`demo/apps/node/src/http.mjs` lines 97–171; `relay.mjs` lines 99 and 220–232) and does not put them in the explorer row. A client or bundler that talks to the sequencer directly is not stripped the same way.

**Attacker:** a chain observer after the hour opens, and the sequencer operator immediately (sealed votes are persisted before disclosure, `demo/l2/sequencer/state.mjs` `rememberSealed`). The archive job copies sealed-hour block and proof objects (`demo/l2/archive/job.mjs`); it does not add a join, but it keeps whatever the block contained.

**Reconstruction:**

1. `decodeCivicRaw` rejects a vote whose JSON contains a small banned set (`plaintext`, `choice`, `option`, `email`, …) via `containsBallotPlaintext` and `stripForbidden` (`state.mjs` lines 49–71 and 839–847).
2. For a vote it then deletes only `sender` and `from` (lines 844–847). `identityCommitment`, `answers`, `ranking`, `rankingPayload`, and `encryptedBallot` are not in the banned set. They stay in `tx.civic` and in the hex `input` (lines 854–869).
3. `publicFieldsForTx` copies `identityCommitment` onto the public view for every type that has the field, not only party transactions (lines 273–276).
4. After the disclosure hour the block, and therefore the archive object, shows commitment ↔ nullifier, or the answers themselves if they were in the JSON.

The Node’s own banned list is stricter (`answers`, `ranking`, `identityCommitment` in `http.mjs` lines 97–126). The sequencer’s list is the one that becomes the public L2 record.

**Fix:** on `type == vote`, drop every key except `electionId`, `nullifier`, `ballotHash`, roots, and proof fields. Reject `identityCommitment` on a vote the same way the Node rejects it. Do not rely on a denylist of choice synonyms.

---

## BS-9 — Medium. Nothing on chain checks that the ballot bytes are a ciphertext

**Real today:** yes. The Node refuses a UTF-8 JSON “ciphertext” unless `ZKV_ALLOW_PLAINTEXT_BALLOTS` is set, and that flag defaults off (`demo/apps/node/src/config.mjs` lines 287–288; `relay.mjs` lines 225–232). The contract has no such check.

**Attacker:** a chain observer, if the submitter put the option in `encryptedBallot`. That submitter is the voter’s client, a malicious wrapper, or a relayer that was given plaintext. A relayer that was given a real AES-GCM or ECIES blob cannot turn it back into an option (see the sound section).

**Reconstruction:**

1. `submitVote` requires non-empty `encryptedBallot` and `publicInputs[3] == uint256(keccak256(encryptedBallot)) mod r` (`BallotInbox.sol` lines 80–81 and 215–241). Any bytes satisfy that.
2. The vote circuit forces `ballotHash` into the instance with a squaring constraint and does not open it (`vote_lib.circom` lines 234–240). Choice bits are explicitly out of scope.
3. A transaction whose ballot bytes are the JSON of the marked options is the option, next to the nullifier, in calldata. BS-1 adds the commitment to the same call. BS-5 adds the sender.

`decodeBallotEnvelope` on the Node will also recover rankings from hex-encoded JSON and store `rankingPayload` on the envelope (`demo/apps/node/src/ballot.mjs` lines 560–592 and 662–672; `store.mjs` lines 2259–2266). Production refusal happens first, so the shipped SPA’s AES-GCM and ECIES blobs do not take this branch.

**Fix:** keep refusing plaintext at the Node. On chain, require a well-formedness proof that the ciphertext encrypts a valid option under the tally key. Do not accept raw ballot bytes as the secret.

---

## BS-10 — Medium. The operator can join the signed-in vote-pass request to the cookieless ballot

**Real today:** yes, as a traffic observation. It is not stored as a foreign key. The blind signature itself does not create the join (sound section).

**Attacker:** the Node operator, or a reverse proxy that sees both requests. A forum operator has this power only if they are also that host.

**Reconstruction:**

1. The page always sends `identityCommitment` on `POST /api/elections/:id/vote-pass` when the wallet has one (`vote.js` lines 789–797; `vote-pass.js` lines 112–121). That request carries the session cookie. The handler may check the PIN and, when external parties are active, the commitment (`elections.mjs` lines 676–712).
2. The ballot `POST` uses `credentials: "omit"` and a body of ciphertext, mock proof, nullifier, ballot hash, and the unblinded pass (`vote.js` lines 800–827). The route does not read `req.user` when a pass is present (`elections.mjs` lines 727–753).
3. The app log skips the ballot POST entirely (`demo/apps/node/src/server.mjs` lines 350–364) and logs method, URL, and status for the vote-pass, not the body and not the user id. The two calls are still the same browser, usually the same connection, a moment apart. One voter in that window joins the session (and the commitment in the vote-pass body, if the proxy logs bodies) to the nullifier and ciphertext.
4. The option then requires BS-4, BS-9, or a singleton tally (BS-7).

At rest, spent passes are a sorted list of token hashes with no nullifier and no timestamp (`votePass.mjs` lines 119–127 and 155–164; `store.mjs` lines 2268–2274). Reading the JSON later does not reconstruct step 3. Watching the process does.

**Fix:** treat vote-pass and vote as election-critical traffic: no body logs, no shared connection log that records both, and no disclosure of live per-election volume. This does not become cryptographic unlinkability. A host that handles both requests in one process can always be modified to record the pair.

---

## BS-11 — Medium. A receipt token names the ballot, not the option

**Real today:** yes. Receipts do not contain the option. They do let a holder, and anyone they show the token to, learn the nullifier.

**Attacker:** a coercer or buyer to whom the voter shows the receipt, the email, or the PDF. Also anyone who later obtains the token. Not a chain observer who lacks the token.

**Reconstruction:**

1. The vote response and the local record store nullifier, ballot hash, and token, with `receiptsProveChoice: false` (`vote.js` lines 844–861; `demo/apps/node/public/app.js` lines 408–421). The choice preview is cleared and is not written to `localStorage`.
2. The opt-in email contains the election id and the holder token. It does not contain the nullifier, the ballot hash, or an attachment (`demo/apps/node/src/receipts.mjs` lines 389–422). The send is not written to the mail outbox unless the capture mailer is on (`mailer.mjs` lines 222–224; `emailReceipt` lines 631–650). The mail provider still sees the recipient and the token.
3. `GET` receipt-by-token resolves token hash → nullifier (`receipts.mjs` lines 639–642 and the holder view around lines 600–616). The public explorer row for that nullifier is still only hashes (`store.mjs` `publicVoteRecord`, lines 104–111).
4. The coercer has person → nullifier. The option requires BS-2 or BS-4. The receipt alone cannot buy a specific option. It can buy or compel **participation**, and it becomes vote-buying of an option as soon as openings are public.

There is no second ballot. A spent nullifier reverts (`BallotInbox.sol` lines 93–95). A voter cannot overwrite a coerced ballot. That is an anti-coercion limit of “one ballot per nullifier,” not a secrecy break by itself.

**Fix:** keep choice off the receipt. If email must exist, send it only over a channel the voter already trusts, and assume the token will be treated as a pointer to the nullifier. Do not add a “how I voted” line to the PDF.

---

## BS-12 — Low. Mock proofs and `MockVerifier` do not open a ballot, and they do not enforce the story the circuit tells

**Real today:** yes.

- `MockVerifier.acceptAll` defaults to true (`smart-contracts/src/zk/MockVerifier.sol` line 38). `verifyProof` returns true for any well-shaped input unless the owner has armed an inclusion or non-membership witness (lines 163–198). Armed witnesses are supplied by the owner; they are not extracted from a Groth16 witness, so arming is not a decryption oracle.
- `ElectionFactory` allows a mock verifier only when `chainid == 31337`, unless a super admin calls `setAllowMockVerifiers` (lines 103–109 and 273).
- The SPA sends `proof: { mock: true }` and zero points (`vote.js` lines 806–815). The Node relay does not run a Groth16 check on the JSON path.
- The published nullifier is the keccak construction in BS-3, not Poseidon(`nullifierSecret`, election id). A real `Vote(20)` verifier would reject the SPA’s public inputs even when the voter is eligible.
- `circuits/tally.circom` takes the plaintext ballot vector as a **private** witness (lines 89–93) and exposes counts. The proof does not reveal the witness. `Tally.sol` does not use that circuit’s instance (`TallyPublicInputs.sol` lines 10–32). A retained `.wtns` file would be a disclosure; the voting path does not write one.

This is why “the circuit makes the vote unlinkable” is not a statement about this branch’s public record. It is a statement about a proof the client does not produce. It does not, by itself, display an option.

**Fix:** ship a ceremony-backed verifying key, reject mock verifiers off the dev chain, and generate the client proof in the browser so the trapdoor never leaves the device. The proposal’s D1/D3 section matches this.

---

## Paths checked and found sound

These were examined and do **not** reconstruct an option on the PRF path, with the Node relay, and without BS-1, BS-2, BS-4, or BS-6.

| Path | Result |
| --- | --- |
| Identity commitment ↔ nullifier, PRF path | The leaf is Poseidon(trapdoor, nullifierSecret) from the identity-domain PRF (`passkey-wallet.js` lines 7–12 and 867–886; `identity.circom` lines 18–32). The PRF salt is derived from the credential id; the PRF output is not. The operator cannot recompute the leaf or the nullifier from the credential id. The account seed is a separate domain and is not the trapdoor. |
| Brute force of a small candidate set | Sum-only ballots are AES-GCM under a key HKDF’d from the random account seed, with a random 12-byte IV (`passkey-wallet.js` lines 1280–1301). `opens_ballots` ballots are P-256 ECIES with a fresh ephemeral key and a fresh IV (`tally-crypto.js` lines 178–192). `ballotHash` is keccak of the ciphertext, not of the option (`BallotInbox.sol` lines 239–241). Neither ciphertext is a deterministic encryption of a short option. Guessing the option does not test the ciphertext without the key. |
| Public Node vote row | `publicVoteRecord` is nullifier, ballot hash, election id, relayer (`store.mjs` lines 104–111). `stripBallotPii` / `sanitizeVoteBody` drop user id, commitment, address, credential id, answers, and ranking before relay (`http.mjs` lines 97–171). |
| Blind vote pass at rest | Issuance signs a blinded full-domain hash; the blinding factor stays in the browser (`votePass.mjs` lines 1–15 and 166–181; `vote-pass.js` lines 99–105). Spent tokens are stored as sorted hashes, not next to a nullifier. This does not stop BS-10. |
| App access log | Ballot `POST` is not logged. Other lines are method, URL, status, duration (`server.mjs` lines 350–364). The log line is not a person ↔ option join. Proxy body logs are BS-10. |
| Receipt contents | No option in the JSON receipt, the PDF inputs, or the email body (`receipts.mjs` lines 389–470). |
| Forum | No DiscourseConnect provider and no code that reads a forum account into a ballot, a nullifier, or a credential. A shared email used on both sites is an out-of-band correlation; the repository does not build it. |
| Disqualification | Events and rows carry commitment, reason code, and evidence hash. They do not carry a nullifier or an option. |
| Paymaster as a hidden voter id | The paymaster sees the UserOp it is asked to sponsor and does not write a voter address of its own. It also does not conceal `UserOp.sender` (BS-5). |
| Sum-only tally integrity vs secrecy | `submitTally` accepts any `counts` whose sum equals `acceptedBallots` (`Tally.sol` lines 81–120). The operator can mis-state the histogram. They cannot read an individual sum-only ciphertext from that freedom. |
| Wallet address as the Merkle leaf | `PrivacyUnlinkability.t.sol` checks the leaf is not the wallet and that indexed `VoteAccepted` topics are election id and nullifier. That test does not cover BS-1 or BS-2. The nullifier in the test is `keccak256("nullifier" \|\| wallet \|\| 1)` (`PrivacyUnlinkability.t.sol` line 24), which is a test fixture, not the client formula. |
| Archive offload | The job copies hour objects the sequencer already built. It does not attach a user id. It will faithfully archive a poisoned vote payload from BS-8. |
| One-time nullifier | A second ballot reverts `NullifierUsed`. That stops double voting. It does not hide the first ballot. |

---

## What would make the claim false

The claim is false for a **passive chain observer** of an election that meets all of the following, which the Node’s default relay is aiming at and does not fully reach:

- votes use `submitVote` only, from a shared relayer, with no UserOp sender;
- `submitVoteWithClearance` and `submitOpenedTally` are not called, and are not left callable;
- ballot bytes are randomized ciphertexts, and tally decryption is of an aggregate or a shuffle, with per-ballot shares not retained;
- identity secrets exist only inside a PRF the server cannot recompute;
- the public chain does not emit a per-vote timestamp the observer can match to a singleton, or the batch is large enough that the tally does not identify one person.

Until those are true in the contracts and not only in the Node’s JSON path, a nefarious use of the live ABI, or a host who holds fallback credential ids plus openings, can reconstruct individual options.

---

## Method limits

- Reviewed the Solidity under `smart-contracts/src`, the Circom under `circuits/`, the Node under `demo/apps/node/src`, the browser vote and passkey scripts, `demo/l2` sequencer and archive, and `demo/packages/chain-client`. Dependency trees (`forge-std`, vendored poseidon constants) were not audited for hash collisions.
- No deployment was probed. “Real today” means the source on this commit, not a particular chain’s storage.
- No attempt was made to break Poseidon or AES-GCM. Unlinkability of the PRF path assumes those functions hide their inputs and that the authenticator’s PRF key is not extracted.
- Forum software outside this repository was not reviewed. Only this tree’s integration, which is documentation plus the absence of a join.

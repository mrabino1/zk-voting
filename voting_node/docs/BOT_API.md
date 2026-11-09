# ZK-Voting bot API

> NOT FOR PROFIT — civic public good. Not a commercial product. No token. No fees to voters.

A person signs in at `/me` and creates one or more API keys. An external bot reads this guide, `GET /api`, or `GET /api/openapi.json`, then calls the JSON API with a key. The key can use the routes below, up to its level and the roles that person already holds.

## Authentication

Send either header:

- `Authorization: Bearer rk_…`
- `X-Api-Key: rk_…`

The secret is displayed once, in the create response, and cannot be shown again. Only a SHA-256 hash is stored. Revoked and expired keys receive `401`. A read-only key that calls a write receives `403` with `code` `API_KEY_SCOPE`.

Create and revoke from the profile while the browser session is signed in:

```http
POST /api/me/api-keys
Content-Type: application/json
Cookie: zk-voting.sid=…

{ "name": "assistant", "level": "read", "expiresIn": "30d" }
```

`level` is `read`, `voter`, or `officer`. `expiresIn` is `7d`, `30d`, `90d`, `180d`, `365d`, or `never`. The default expiration is `30d`. The default level is `read`. An API key cannot call `POST /api/me/api-keys`. A voter or officer key can revoke with `DELETE /api/me/api-keys/:id`.

Creating a key sends the transactional template `api_key.created` to the account contact email, or the primary email when no contact email is set. The message says an API key was created. If the person did not create it, they contact support as soon as possible at `/feedback` and revoke the key on `/me`. The email does not contain the API key.

## Levels

- `read` (Read-only). GET and HEAD, plus receipt and outcome verification. Cannot create, vote, register, email, or change a profile.
- `voter` (Voter). Read-only plus this person’s own actions: contact email, vote PIN, registration request, ballot submit, identity methods, notifications, feedback, and outcome subscriptions.
- `officer` (Officer). Voter plus the clerk, registrar, disqualification officer, tally operator, election staff, and platform admin routes this account is already allowed to call. A key does not add a role the person does not hold.

WebAuthn ceremonies need a WebAuthn client. Email and Ethereum sign-in can be completed by a bot that can read mail or sign. A personal API key is the path that skips that ceremony. Sign-in routes refuse an API key so a key cannot mint a browser session.

## Identifiers

Path parameters named `id`, `partyId`, `requestId`, `methodId`, and `electionId` are UUIDs. A sequential integer is rejected with `400` and `code` `ID_NOT_UUID`. Counting `1`, `2`, `3` would reveal how many people, contests, keys, or other records exist.

The on-chain election id is a circuit uint256 inside the election object. It is not a path id. Human short links `/v/{code}` and `/e/{code}` redirect to `/vote/{uuid}` and are not accepted on `/api/elections/:id`.

These path values are not record counts: `questionId` and `optionId` are ballot labels, `guardians/:index` is a ceremony slot, `/api/mail/templates/:id` is a template name, and `/api/pages/:slug` is a public page slug. A new jurisdiction is assigned a UUID.

## Calling the API

```bash
curl -sS \
  -H "Authorization: Bearer $ZK_VOTING_API_KEY" \
  -H "Accept: application/json" \
  "$ORIGIN/api/me"
```

JSON errors look like `{ "error": "…", "nfp": true, "code": "…" }`. Successful JSON includes `"nfp": true`. Ballot choice is never a response field. Public turnout publishes hourly from the first ballot, after the hour closes, the disclosure delay elapses, and the block meets the floor.

Machine-readable copies:

- `GET /api/openapi.json`
- `GET /api/llms.txt`
- `GET /api?format=json`
- Repo guide: `docs/BOT_API.md`

## Routes

### Status

- `GET /health` (key read). Process health, writer mode, chain id, and the hourly disclosure window.
- `GET /api/health` (key read). Same payload as GET /health.
- `GET /api/config` (key read). Public Node configuration: voting hostname, chain, polls flag, identity caps, ballot types, receipt portal, and outcome portal.
### Documentation

- `GET /api` (key read). Human documentation for this bot API. Send Accept: application/json, or ?format=json, for a machine index of the same routes.
- `GET /api/openapi.json` (key read). OpenAPI 3 description of every route listed here.
- `GET /api/llms.txt` (key read). Plain-text guide for a language model that will call this API.
- `GET /llms.txt` (key read). Same plain-text guide as GET /api/llms.txt.
### Sign-in

- `POST /api/auth/passkey/register/begin` (API key refused). Begin WebAuthn registration. An API key is refused here. A bot that already has a key does not need this ceremony. Body: handle, acceptedTerms.
- `POST /api/auth/passkey/register/finish` (API key refused). Finish WebAuthn registration and start email MFA when MFA is on. Body: WebAuthn credential, handle, email.
- `POST /api/auth/passkey/login/begin` (API key refused). Begin WebAuthn sign-in. Body: handle.
- `POST /api/auth/passkey/login/finish` (API key refused). Finish WebAuthn sign-in. Sets the session cookie after MFA.
- `POST /api/auth/web3/challenge` (API key refused). Issue a sign-in challenge for a bound Ethereum address. Body: address.
- `POST /api/auth/web3/login` (API key refused). Submit the Ethereum signature for that challenge. Body: address, signature.
- `POST /api/auth/email/start` (API key refused). Start email sign-in. The one-time code arrives by transactional email. Body: email.
- `POST /api/auth/smart-card/challenge` (API key refused). Issue a smart-card sign-in challenge.
- `POST /api/auth/smart-card/login` (API key refused). Complete smart-card sign-in.
- `POST /api/auth/civic-id/login` (API key refused). Sign in with a hashed driver license or passport already bound to the person.
- `GET /api/auth/mfa/status` (API key refused). Whether email MFA is required and whether SES is configured.
- `POST /api/auth/mfa/email` (API key refused). Send or confirm the email factor during sign-in.
- `POST /api/auth/mfa/resend` (API key refused). Resend the email one-time code.
- `POST /api/auth/mfa/verify` (API key refused). Verify the email one-time code and receive the session cookie. Body: code.
- `POST /api/auth/logout` (API key refused). End the browser session. An API key is refused here.
- `GET /api/auth/session` (API key refused). Session cookie profile. Prefer GET /api/me with an API key.
### Profile

- `GET /api/me` (key read, signed in). The signed-in person: handle, role, identity summary, jurisdiction grants, and election registration status. Choice is never included.
- `GET /api/session` (key read, signed in). Same payload as GET /api/me.
- `PATCH /api/me/contact-email` (key voter, signed in). Set or clear the contact email used for operator notices and the API-key alert. Body: contactEmail.
- `GET /api/notifications` (key read, signed in). In-app notices for this person, newest first.
- `POST /api/notifications/:id/read` (key voter, signed in). Mark one notice read.
### API keys

- `GET /api/me/api-keys` (key read, signed in). List this account’s API keys. The secret is never returned. Revoked and expired keys stay in the list.
- `POST /api/me/api-keys` (API key refused). Create a key from a browser session on /me. Body fields: name, level (read, voter, or officer), expiresIn (7d, 30d, 90d, 180d, 365d, or never; default 30d). The secret is displayed once and cannot be retrieved again. The account email says a key was created and does not include the key. Body: name, level, expiresIn.
- `DELETE /api/me/api-keys/:id` (key voter, signed in). Revoke one of this account’s keys. Later calls with that secret are rejected.
### Vote PIN

- `POST /api/me/pin/keypad` (key voter, signed in). Issue the scrambled phone keypad used to enter the vote PIN.
- `POST /api/me/pin` (key voter, signed in). Set the 4–8 digit vote PIN. Body: pin.
- `POST /api/me/pin/verify` (key voter, signed in). Verify the vote PIN and receive a short-lived pinToken for POST /api/elections/:id/vote. Body: pin.
- `POST /api/me/pin/forgot` (key voter, signed in). Start a PIN reset for the signed-in person. Completes with email MFA.
- `POST /api/pin/forgot` (key voter). Start a PIN reset from an email address. Sends a one-time code. Body: email.
### Identity

- `GET /api/identity/methods` (key read). Identity method types a person may bind: email, passkey, Web3, smart card, driver license, passport.
- `GET /api/me/identity` (key read, signed in). Full identity view for the signed-in person: emails, passkeys, Ethereum addresses, civic credentials. No trapdoor and no PIN.
- `POST /api/identity/email/start` (key voter, signed in). Start binding another email. One email is primary. Cap is 5. Body: email.
- `POST /api/identity/web3/challenge` (key voter, signed in). Challenge used to prove control of an Ethereum address before it is bound. Body: address.
- `POST /api/identity/web3/verify` (key voter, signed in). Bind a signature-verified Ethereum address. Only one address is active. Body: address, signature.
- `POST /api/identity/smart-card/challenge` (key voter, signed in). Challenge for binding a smart card.
- `POST /api/identity/smart-card/verify` (key voter, signed in). Bind a smart card after the reader signs the challenge.
- `POST /api/identity/civic-id/verify` (key voter, signed in). Bind a hashed driver license or passport. Images and full document numbers are not stored.
- `GET /api/me/emails` (key read, signed in). Email methods on this person.
- `POST /api/me/emails/primary` (key voter, signed in). Choose the primary email. Exactly one email is primary. Body: id or email.
- `DELETE /api/me/emails/:id` (key voter, signed in). Remove one email method.
- `GET /api/me/passkeys` (key read, signed in). Passkeys bound to this person, including each credential COSE algorithm. Cap is 5.
- `DELETE /api/me/passkeys/:credentialId` (key voter, signed in). Remove one passkey.
- `GET /api/me/eth-accounts` (key read, signed in). Verified Ethereum addresses and which one is active.
- `POST /api/me/eth-accounts` (key voter, signed in). Submit the signature that binds an Ethereum address. Body: address, signature.
- `POST /api/me/eth-accounts/active` (key voter, signed in). Switch the single active Ethereum address. Body: address.
- `GET /api/me/credentials` (key read, signed in). Smart cards and civic documents on this person.
- `POST /api/persons/:id/person-key` (key officer, signed in). Registrar or clerk binds the person key for someone on their jurisdiction.
- `POST /api/persons/:id/methods` (key officer, signed in). Officer adds an identity method to a person in their jurisdiction.
- `POST /api/persons/:id/eth-accounts` (key officer, signed in). Officer records an Ethereum address on a person. Body: address.
- `POST /api/persons/:id/eth-accounts/active` (key officer, signed in). Officer switches the person’s active Ethereum address. Body: address.
- `GET /api/persons/:id/identity` (key read, signed in). Registrar or clerk reads a person’s identity. A read-only key still needs that officer grant.
- `GET /api/office/credentials` (key read, signed in). Credentials waiting for civil-officer review.
- `POST /api/persons/:id/methods/:methodId/review` (key officer, signed in). Approve or reject a smart card or civic document. Body: decision.
- `POST /api/persons/:id/methods/:methodId/revoke` (key officer, signed in). Revoke an expired card or license. Revocation is an event.
- `POST /api/integrations/credentials/status` (API key refused). Credential-provider status callback. Uses the host provider secret header, not a personal API key. An API key is refused.
### Elections

- `GET /api/elections` (key read). Published elections. Counts follow the hourly disclosure rule.
- `POST /api/elections` (key officer, signed in). Clerk creates an election in a jurisdiction they already serve. Body: title, jurisdictionId, startTime, cutoffTime, questions or ballot, electionType (0 poll, 1 vote; omitted means poll). electionType is immutable.
- `POST /api/elections/:id/l2-open` (key officer, signed in). Retry the sequencer open for one election. Idempotent: an open election is not opened again.
- `POST /api/elections/:id/chain-dead-letter/replay` (key officer, signed in). Writer puts dead-lettered ballots back on the queue. The tally stays blocked while any remain. Optional body nullifier replays one row. Body: nullifier (optional).
- `POST /api/elections/:id/chain-dead-letter/exclude` (tally_operator, signed in). Two different tally operators exclude a dead-lettered ballot after the deadline. A failed replay is required, except a supplementary hold, which can be excluded once the deadline has passed. The public audit log stores the count and the fixed reason code. The operator note stays private. Excluded ballots are not counted. The ballot is not deleted. Body: nullifier, reason.
- `GET /api/elections/:id` (key read). One election. When the caller is signed in, includes that person’s registration status. Choice is never included.
- `PATCH /api/elections/:id` (key officer, signed in). Clerk edits the ballot before the roll is frozen.
- `PUT /api/elections/:id` (key officer, signed in). Same edit as PATCH.
- `DELETE /api/elections/:id` (key officer, signed in). Clerk deletes an unused election. Body confirmTitle must match the saved title. Refused after freeze, registration, a ballot, or a factory transaction. Body: confirmTitle.
- `GET /api/elections/:id/info` (key read). Voter-facing questions, options, and supporting info.
- `GET /api/elections/:id/info/:questionId/:optionId` (key read). One option and its external links.
- `GET /api/elections/:id/results` (key read). Plurality or IRV results from the final tally. Empty of option counts before tally. A poll may include almost-live hourly choice sums after the results gate. A vote stays empty of those sums. Excluded ballots are not counted.
- `GET /api/elections/:id/summary` (key read). Short public status: state, window, disclosed ballot count, links.
- `GET /api/elections/:id/ballots` (key read). Disclosed ballot proofs for closed hours. Choice is not a field.
- `GET /api/elections/:id/artifacts` (key read). Auditor pack: roots, counts, and public checks. No Node private database.
- `GET /api/elections/:id/l1` (key read). L1 certification status for the tally, when a tally exists.
- `GET /api/elections/:id/tally-key` (key read). Public tally ceremony view. The Node does not return a tally private key.
- `GET /api/elections/:id/staff` (key read, signed in). Election staff list. Caller must already be staff for that election.
- `POST /api/elections/:id/staff` (key officer, signed in). Platform admin approves election staff. Body: handle or userId.
- `DELETE /api/elections/:id/staff` (key officer, signed in). Platform admin revokes election staff. Body: handle or userId.
- `GET /api/elections/:id/registrations` (key read, signed in). Clerk, registrar, or disqualification officer lists the roll and requests.
- `GET /api/elections/:id/registration-requests` (key read, signed in). Clerk or registrar lists registration requests. Filter with ?status=.
- `POST /api/elections/:id/register` (key voter, signed in). Voter asks to join the roll. A registrar or clerk of that jurisdiction must approve. Body: identityCommitment.
- `POST /api/elections/:id/registration-requests/:requestId/approve` (key officer, signed in). Clerk or registrar approves a registration request and inserts the commitment.
- `POST /api/elections/:id/registration-requests/:requestId/deny` (key officer, signed in). Clerk or registrar declines a registration request. Body: reason.
- `POST /api/elections/:id/freeze` (key officer, signed in). Clerk freezes the eligible and disqualification roots.
- `POST /api/elections/:id/vote` (key voter). Submit a ballot. A signed-in voter must send pinToken from POST /api/me/pin/verify. The body is a proof plus ciphertext. Choice is not a public field. A second ballot for the same nullifier is rejected unless re-vote is enabled. When it is on, the replacement is counted only in the final tally, and a published poll block stays as first published. A read-only key is refused. Body: proof, public inputs, ciphertext, pinToken, identityCommitment when an external party is active.
- `POST /api/elections/:id/disqualify` (key officer, signed in). Disqualification officer applies a coded reason and an evidence hash. Body: identityCommitment, reasonCode, evidenceHash.
- `POST /api/elections/:id/disqualify/revoke` (key officer, signed in). Disqualification officer records a revocation event.
- `POST /api/elections/:id/revoke` (key officer, signed in). Same revocation event as /disqualify/revoke.
- `GET /api/elections/:id/envelopes` (key read, signed in). Tally operator reads encrypted envelopes after cutoff. Plaintext choice is not stored.
- `POST /api/elections/:id/guardians` (key officer, signed in). Tally operator enrolls a guardian in the opens-ballots ceremony. Non-production cryptography.
- `POST /api/elections/:id/guardians/deals` (key officer, signed in). Tally operator posts a guardian deal.
- `GET /api/elections/:id/guardians/:index/inbox` (key read). Encrypted shares addressed to one enrolled guardian index.
- `POST /api/elections/:id/guardians/partials` (key officer, signed in). Tally operator submits partial decryptions of the full aggregate after cutoff.
- `POST /api/elections/:id/choice-blocks/partials` (key officer, signed in). Tally operator submits partial decryptions for one published poll hour block. A vote has no block. The response is the guardian index and the block id. Body: blockId, index, partials tagged for that block aggregate.
- `POST /api/elections/:id/tally` (key officer, signed in). Tally operator posts the tally after cutoff. Invented counts that do not match opened ballots are rejected for opens-ballots.
- `POST /api/elections/:id/certify-l1` (key officer, signed in). Tally operator asks the Node to mirror the tally to L1 when L1 env is set.
### External parties

- `GET /api/elections/:id/parties` (key read). External eligibility parties for an election. Endpoint URLs are included only for staff.
- `POST /api/elections/:id/parties` (key officer, signed in). Election staff registers an external eligibility party. Body: name, mode, operatorHandle.
- `POST /api/elections/:id/parties/check` (key officer, signed in). Staff checks whether a commitment is cleared to cast. Body: identityCommitment.
- `PATCH /api/elections/:id/parties/:partyId` (key officer, signed in). Staff changes a party status. Body: status.
- `GET /api/elections/:id/parties/:partyId/rejections` (key read, signed in). Staff lists party rejections.
- `POST /api/elections/:id/parties/:partyId/reject` (key officer, signed in). Staff or the party operator records a rejection. Body: identityCommitment, reasonCode, evidenceHash.
- `POST /api/elections/:id/parties/:partyId/clear` (key officer, signed in). Staff or the party operator clears a rejection. Body: identityCommitment, evidenceHash.
- `POST /api/elections/:id/parties/:partyId/attest` (key officer, signed in). Staff or the party operator attests a commitment. Body: identityCommitment, expiresAt, evidenceHash.
### Jurisdictions

- `GET /api/jurisdictions` (key read). Jurisdictions on this Node. Officer lists are included only for officers.
- `POST /api/jurisdictions` (key officer, signed in). Platform admin creates a jurisdiction. Body: name, metadataURI. The Node assigns a UUID id; a caller cannot choose it..
- `GET /api/jurisdictions/:id` (key read). One jurisdiction.
- `GET /api/jurisdictions/:id/roles` (key read, signed in). Officers granted on a jurisdiction. Caller must already be an officer.
- `POST /api/jurisdictions/:id/roles` (key officer, signed in). Platform admin grants clerk, registrar, disqualification officer, tally operator, or election staff. Body: role, handle or userId.
- `DELETE /api/jurisdictions/:id/roles` (key officer, signed in). Platform admin revokes a jurisdiction grant. Body: role, handle or userId.
- `POST /api/admin/roles` (key officer, signed in). Same grant as POST /api/jurisdictions/:id/roles. Body: jurisdictionId, role, handle or userId.
- `POST /api/admin/grant` (key officer, signed in). Alias of POST /api/admin/roles. Body: jurisdictionId, role, handle or userId.
- `GET /api/users` (key read, signed in). Platform admin lists accounts and their jurisdiction grants. A read-only key may list. It cannot change roles.
- `PATCH /api/users/:id` (key officer, signed in). Platform admin sets a role the account is already allowed to grant: voter, observer, clerk, registrar, disqualification_officer, tally_operator, or election_staff. Body: role.
- `GET /api/reason-codes` (key read). Public disqualification reason catalog.
### Pages

- `GET /api/pages` (key read). Published public pages and the shared-contract site view.
- `GET /api/pages/:slug` (key read). One published page.
- `GET /api/site` (key read). Public site record, including pinned contract addresses.
- `GET /api/office/site` (key read, signed in). Clerk reads the office site record.
- `PATCH /api/office/site` (key officer, signed in). Clerk pins shared contract addresses. Environment pins win over the stored site.
- `GET /api/office/pages` (key read, signed in). Clerk lists CMS pages, including drafts they may edit.
- `POST /api/office/pages` (key officer, signed in). Clerk creates a page.
- `GET /api/office/pages/:id` (key read, signed in). Clerk reads one CMS page.
- `PATCH /api/office/pages/:id` (key officer, signed in). Clerk edits a CMS page.
- `DELETE /api/office/pages/:id` (key officer, signed in). Clerk deletes a CMS page.
### Terms

- `GET /api/terms` (key read). Current Terms of Use metadata and whether the caller has accepted this PDF hash.
- `GET /api/terms.pdf` (key read). Terms PDF bytes. SHA-256 is in the X-Pdf-SHA256 header.
- `GET /terms.pdf` (key read). Same Terms PDF as GET /api/terms.pdf.
- `POST /api/terms/view` (key voter). Record that the signed-in person viewed the Terms.
- `POST /api/terms/accept` (key voter, signed in). Accept the current Terms. Acceptance stores the SHA-256 of the PDF bytes. Body: acceptedTerms.
### Feedback

- `GET /api/feedback` (key read). Feedback form limits, categories, and whether the operator inbox is configured.
- `POST /api/feedback` (key voter). Send one feedback message. This is also how a person contacts support. Rate-limited. A read-only key is refused because the call sends mail. Body: category, name, email, message, acceptedTerms.
### Receipts

- `GET /api/receipts/metrics` (key read). Public receipt metrics and hourly turnout. No candidate and no option.
- `POST /api/receipts/verify` (key read). Check a hash-only receipt or its locked PDF. Returns whether the ballot counted. Never returns a choice. Body: proof or receipt text, or PDF bytes.
- `POST /api/receipts/email` (key voter, signed in). Email the voter their hash-only receipt after the ballot is accepted.
- `POST /api/receipts/pdf` (key voter, signed in). Download the locked receipt PDF for a ballot this caller may access.
### Outcomes

- `GET /api/outcomes` (key read). Every election grouped before, during, and after voting. No unofficial option counts during the open window.
- `GET /api/outcomes/:id` (key read). One election’s public outcome monitor.
- `GET /api/outcomes/reports` (key read). Issued official outcome reports.
- `GET /api/outcomes/reports/:id` (key read). One official outcome report record.
- `GET /api/outcomes/reports/:id/pdf` (key read). Locked official outcome PDF.
- `POST /api/outcomes/verify` (key read). Check an official outcome PDF was not modified. Body: pdf bytes or id.
- `GET /api/me/outcome-subscriptions` (key read, signed in). Elections whose official PDF this person will be emailed. Subscription is opt-in; voting never subscribes anyone.
- `PUT /api/me/outcome-subscriptions/:electionId` (key voter, signed in). Subscribe or confirm a subscription to an official outcome PDF.
- `POST /api/me/outcome-subscriptions` (key voter, signed in). Subscribe the caller to an election’s official outcome PDF. Body: electionId.
- `GET /api/admin/outcome-report-template` (key read, signed in). Platform admin reads the official outcome PDF template. QR and hash seals stay required.
- `PATCH /api/admin/outcome-report-template` (key officer, signed in). Platform admin edits template copy. QR and hash seals cannot be removed.
- `POST /api/admin/outcome-report-template/preview` (key officer, signed in). Platform admin previews the outcome PDF template.
### Explorer

- `GET /api/explorer/disclosure` (key read). Hourly disclosure window the explorer uses.
- `GET /api/explorer/blocks` (key read). Civic L2 blocks.
- `GET /api/explorer/blocks/:n` (key read). One civic L2 block.
- `GET /api/explorer/txs/:hash` (key read). One civic L2 transaction. Ballot plaintext is not a field.
- `GET /api/explorer/nullifiers/:value` (key read). Whether a nullifier was accepted. The nullifier does not reveal the choice or the person.
- `GET /api/explorer/search` (key read). Search blocks, transactions, and elections.
- `GET /api/explorer/elections/:id` (key read). Explorer view of one election.
- `POST /api/explorer/ingest` (key officer). Operator ingest of civic L2 events. Send the host ingest secret in X-ZK-Voting-Ingest-Secret. A personal API key does not replace that secret. Minimum key level when a key is also sent: officer.
### Polls

- `GET /api/polls` (key read). Token polls when POLLS_ENABLED is on. Polls are signal, not binding elections. Omitted from the Node when the flag is off.
- `GET /api/polls/:id` (key read). One token poll.
- `GET /api/polls/:id/weight` (key read). Read-only token weight for an address. The Node does not move tokens. erc20_votes reports getPastVotes at the Ethereum snapshot.
- `GET /api/polls/:id/delegates` (key read). Delegates with nonzero getPastVotes at an erc20_votes snapshot. Absent on balance-hold polls.
- `GET /api/polls/:id/snapshot-proof` (key read). Poseidon membership proof that an address and its voting power are in the snapshot root. Query: address.
- `GET /api/polls/:id/typed-data` (key read). EIP-712 typed data a holder signs. Query: address, choices.
- `POST /api/polls/:id/ballots` (key voter). Submit a signed token-poll ballot. No account on this site is required. A read-only key is refused.
- `POST /api/polls/:id/tally` (key voter, signed in). Any signed-in person may ask the Node to tally a closed token poll. Counts come from accepted ballots.
- `GET /api/polls/:id/results` (key read). Token poll results after tally.
- `GET /api/polls/:id/artifacts` (key read). Token poll auditor pack.
- `GET /api/polls/:id/ballots.json` (key read). Disclosed token-poll ballots.
- `GET /api/polls/:id/outcome.pdf` (key read). Token poll outcome PDF.
### Mail

- `GET /api/mail/templates` (key read, signed in). Platform admin lists operator mail templates stored on the Node. Mail is never written to civic L2.
- `GET /api/mail/templates/:id` (key read, signed in). Platform admin previews one operator mail template, including api_key.created.
- `GET /api/mail/outbox` (key read, signed in). Platform admin lists queued operator mail. Bodies stay on the detail route.
- `GET /api/mail/outbox/:id` (key read, signed in). Platform admin reads one outbox message, including text and HTML.

Routes that are not listed here reject a personal API key.

Civic public good. Not a commercial product.

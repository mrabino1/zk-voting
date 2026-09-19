# Person identity

**NOT FOR PROFIT** — civic public good. Not a commercial product. See [`/NOT_FOR_PROFIT.md`](../NOT_FOR_PROFIT.md).

A **person** is one Node user. They are uniquely identified. They may prove who they are with **email**, an **Ethereum wallet** (signature verification), a **smart-card reader** (PIV, CAC, national eID), a **driver’s license or passport** (hashed civic ID), or a **passkey**. Several Ethereum addresses may be **internally verified** (each extra address must **sign a challenge**). **Exactly one** Ethereum address is **active**. A person may bind **multiple** smart cards and **multiple** driver’s licenses / passports. Civil officers inspect each card or license and **revoke** it when that civil registration has expired. A later third-party DMV / eID connector can POST the same status; until then review is **manual**.

**Every sign-in path completes with email MFA** (a 6-digit code sent by **AWS SES**), in the same transactional-mail pattern as DealPunchList. Dev login on a local host can skip MFA. `NODE_ENV=test` skips MFA on non-email factors unless `REQUIRE_EMAIL_MFA=1` so existing passkey/web3 tests stay green.

The vote Merkle leaf is still an **identity commitment**. It is never the active address, never a name, never a credential id, and never a license or passport number.

This Node does **not** store passport or license **images** or **full document numbers**. Civic ID is a keccak hash of `kind|issuer|normalizedNumber`. It is **not** court-ready commercial identity verification.

```
Person (one Node user)
  ├── authMethods[]     email | web3 | smart_card | civic_id | passkey
  ├── emails[]          up to 5; exactly one `primary` when any exist
  ├── email             MFA/SES default = the primary address
  ├── credentials[]     up to 5 WebAuthn passkeys (any of them can sign in)
  ├── smart cards[]     up to 5; each has status active | revoked | expired
  ├── civic IDs[]       up to 5 driver’s licenses / passports (hash only)
  ├── ethAccounts[]     many signature- or registrar-verified addresses
  └── activeEthAddress   exactly one (or none until the first address is verified)
```

---

## Uniqueness

| Binding | Rule |
| --- | --- |
| Authenticator (email, credential id, wallet, card fingerprint, civic-id hash) | Belongs to at most one person (`METHOD_OWNED`). |
| Emails per person | At most **5** (`EMAIL_CAP`). Exactly one is `primary` whenever any email exists. |
| Passkeys per person | At most **5** (`PASSKEY_CAP`). Any of them can complete WebAuthn login. |
| Ethereum address | Belongs to at most one person (`ADDRESS_OWNED`). Self-service adds require a wallet signature (`SIGNATURE_REQUIRED`). |
| Smart card / civic ID | Belongs to at most one person (`METHOD_OWNED`). Up to **5** live smart cards and **5** live licenses/passports (`SMART_CARD_CAP` / `CIVIC_ID_CAP`). Revoked or expired slots can be replaced. |
| Optional registrar `personKeyHash` | keccak256 of a civil-file token. Unique (`PERSON_KEY_OWNED`). The Node stores the hash, never a legal name. |

Signing a Web3 challenge with a wallet that is **already a web3 auth method** logs that person in (`POST /api/identity/web3/verify` still does this as a bind+session side effect, then MFA when required). Dedicated returning-user login is `POST /api/auth/web3/challenge` then `POST /api/auth/web3/login`. Signing a wallet that is only on someone else’s **internal** `ethAccounts` list does **not** register you as them on the bind route; it returns `ADDRESS_OWNED`. The login route resolves that address to the bound Person when you control the key.

---

## Email MFA (AWS SES)

1. First factor succeeds (email address, Ethereum signature, smart-card mock/attest, civic-id hash, or passkey).
2. If the person has no email yet, the client collects one (`POST /api/auth/mfa/email`).
3. The Node emails a 6-digit code via **SESv2** (`SES_FROM_ADDRESS` + `AWS_REGION`, default AWS credential chain).
4. `POST /api/auth/mfa/verify` `{ code }` sets the session cookie. The pending MFA cookie is `republic.mfa` (10 minutes, 5 attempts).

When `SES_FROM_ADDRESS` and `AWS_REGION` are set, `requireEmailMfa` is on for production. Tests default it off (capture mailer still drives the **email** first-factor path, which always uses OTP). `REQUIRE_EMAIL_MFA=1` forces MFA in tests.

Dev login (`ALLOW_DEV_LOGIN`) never requires MFA.

---

## How each method binds and logs in

### Email (username)

**Register:** `POST /api/identity/email/start` `{ email, handle? }` → SES code → `POST /api/auth/mfa/verify`. The first address becomes **primary**. Further addresses (up to 5) are added the same way while signed in.

**Login:** `POST /api/auth/email/start` `{ email }` → SES code to **that** address → verify. Unknown emails are `404 UNKNOWN_CREDENTIAL` (does not create a person).

**Primary:** `POST /api/me/emails/primary` `{ id }` or `{ email }` makes that bound address primary and clears the previous one. `DELETE /api/me/emails/:id` cannot remove the primary (`PRIMARY_REQUIRED`); set another primary first. `GET /api/me/emails` and `GET /api/me` / `GET /api/me/identity` list every address and which is primary.

Login/MFA after passkey, wallet, smart card, or civic ID, and the Terms PDF, send to the **primary** address by default. Caps are code constants (`MAX_EMAILS_PER_PERSON = 5`); no extra env vars.

### Web3 wallet

**Register / bind**

1. `POST /api/identity/web3/challenge` `{ address }` → SIWE-like bind message (nonce stored on the Node).
2. Wallet `personal_sign`s that message.
3. `POST /api/identity/web3/verify` `{ address, signature }` reconstructs the message from the **stored** challenge (the client message is not trusted).
4. Adds `web3` auth method **and** an internally verified ETH account (signature is the verification). First account becomes active. Then email MFA when required.

Further wallets while signed in: `POST /api/identity/web3/challenge` then `POST /api/me/eth-accounts` `{ address, signature }`. Unsigned `POST /api/me/eth-accounts` is `SIGNATURE_REQUIRED`. A registrar may still attest an address with `POST /api/persons/:id/eth-accounts` (`verifiedBy: registrar`).

**Login (returning user)**

1. `POST /api/auth/web3/challenge` `{ address }` → SIWE-like **login** message (different text from bind; stored nonce).
2. Wallet `personal_sign`s that message.
3. `POST /api/auth/web3/login` `{ address, signature }` verifies against the stored message and resolves the Person who already has that web3 method or verified ETH address. Unknown wallets are `404 UNKNOWN_CREDENTIAL` — login does not create a person. Then email MFA when required.

### Smart-card reader

Kiosk or clerk desk. Fingerprint is a hex digest or keccak256 of a PEM. Live X.509 path verification is **not** in this Node build.

- Self-service mock: `{ mock: true }` only when `ALLOW_SMART_CARD_MOCK=1` or `NODE_ENV=test`.
- Production: registrar `POST /api/persons/:id/methods` `{ type: "smart_card", fingerprint, expiresAt? }`.
- Returning-user login: `POST /api/auth/smart-card/challenge` then `POST /api/auth/smart-card/login` (does not create a person), then email MFA. **Revoked or expired cards are `403 CREDENTIAL_REVOKED` / `CREDENTIAL_EXPIRED`.**
- Officers list every card at `GET /api/office/credentials` and revoke with `POST /api/persons/:id/methods/:methodId/revoke`.

### Driver’s license or passport (`civic_id`)

Socially certified photo ID. Hash only: `keccak256(utf8("republic:civic_id:v1|{kind}|{issuer}|{number}"))`.

- Kinds: `drivers_license` | `passport`.
- Self-service mock: `{ mock: true }` when `ALLOW_CIVIC_ID_MOCK=1` (or smart-card mock / tests).
- Production: registrar attest. The registrar may send `documentNumber` and `expiresAt`; the Node hashes the number and **does not persist** it.
- Login: `POST /api/auth/civic-id/login` `{ kind, issuer, documentNumber }` recomputes the hash. Then email MFA. Revoked or expired documents cannot sign in.
- A person may hold several licenses (for example an old state and a new state). Officers revoke the expired one by hand until a provider is configured.

### Passkey

WebAuthn resident credential. A person may register **up to 5** passkeys (`PASSKEY_CAP` on the 6th). `POST /api/auth/passkey/register/begin` then `finish` records a `passkey` auth method, then MFA when required. Returning users call `POST /api/auth/passkey/login/begin` then `finish` with **any** of their credentials. `GET /api/me/passkeys` lists them; `DELETE /api/me/passkeys/:credentialId` unbinds one. See [`PASSKEYS.md`](./PASSKEYS.md).

---

## Election registration (request → civil approval)

Identifying a person (email, passkey, wallet, card, license) is **not** the same as being on an election roll.

1. The person signs in and `POST /api/elections/:id/register` `{ identityCommitment }`.
2. If they are not a clerk/registrar of that election’s jurisdiction, the Node stores a **pending** request (`202 PENDING_REVIEW`) and does **not** insert the Merkle leaf.
3. A **registrar or clerk** of that jurisdiction (or `platform_admin`) reviews the request, including each smart card and driver’s license, then `POST .../registration-requests/:requestId/approve` or `deny`.
4. Approve inserts the identity commitment (never a name). The voter may then cast a ballot once the roll is frozen and the window is open.

Officers may still insert a commitment immediately from the back office (kiosk / clerk desk). That path is the civil actor acting, not self-service.

---

## Credential provider (manual today)

`GET /api/config` `identity.credentialProvider.mode` is `manual` until `CREDENTIAL_PROVIDER_SECRET` is set. A later DMV / AAMVA / national-eID system should `POST /api/integrations/credentials/status` with that secret and `{ civicIdHash | fingerprint | methodId, status, expiresAt, reason }`. The Person model does not change. Unset secret → `501 CREDENTIAL_PROVIDER_MANUAL`.

---

## HTTP

```
GET  /api/identity/methods
GET  /api/config                      (identity.methods, identity.credentialProvider, auth.emailLogin, auth.requireEmailMfa, auth.emailMfaVendor=ses)

POST /api/auth/email/start
POST /api/auth/web3/challenge
POST /api/auth/web3/login
POST /api/auth/smart-card/challenge
POST /api/auth/smart-card/login
POST /api/auth/civic-id/login
POST /api/auth/passkey/login/begin
POST /api/auth/passkey/login/finish
POST /api/auth/mfa/email
POST /api/auth/mfa/resend
POST /api/auth/mfa/verify
GET  /api/auth/mfa/status
POST /api/auth/logout

POST /api/identity/email/start
POST /api/identity/web3/challenge
POST /api/identity/web3/verify
POST /api/identity/smart-card/challenge
POST /api/identity/smart-card/verify
POST /api/identity/civic-id/verify

GET  /api/me/identity
GET  /api/me/emails
POST /api/me/emails/primary          ({ id } or { email }; exactly one primary)
DELETE /api/me/emails/:id            (not the primary — PRIMARY_REQUIRED)
GET  /api/me/passkeys
DELETE /api/me/passkeys/:credentialId
GET  /api/me/eth-accounts
POST /api/me/eth-accounts            (signature required)
POST /api/me/eth-accounts/active
GET  /api/me/credentials

GET  /api/elections/:id/registration-requests
POST /api/elections/:id/register     (voter → 202 pending; officer → 201 on the roll)
POST /api/elections/:id/registration-requests/:requestId/approve
POST /api/elections/:id/registration-requests/:requestId/deny

GET  /api/office/credentials         (clerk / registrar)
GET  /api/persons/:id/identity
POST /api/persons/:id/methods         (registrar; type email | web3 | smart_card | civic_id | passkey)
POST /api/persons/:id/methods/:methodId/review
POST /api/persons/:id/methods/:methodId/revoke
POST /api/integrations/credentials/status   (provider secret; 501 until configured)
```

Passkey begin/finish stay under `/api/auth/passkey/*`. Wallet **login** is `/api/auth/web3/*`. Identity **bind** routes stay under `/api/identity/*` so registration cannot be confused with returning-user login.

---

## On chain

`smart-contracts/src/PersonRegistry.sol` — `personId` is `bytes32` (never a name). `verifyAddress` / `setActive` are registrar/admin. Globally unique via `personOf[account]`. Not a substitute for `VoterRegistry`; it only answers which EOA or smart account this person is using for gasless ops.

---

## Privacy

Public ballot rows remain `{ nullifier, ballotHash, electionId, relayer }`. No `userId`, no choice, no identity commitment, no active ETH address on the vote. Hourly disclosure is unchanged ([`ARCHITECTURE.md`](./ARCHITECTURE.md)). Civic document numbers never appear in `republic.json`.

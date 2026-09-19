# Person identity

**NOT FOR PROFIT** — civic public good. Not a commercial product. See [`/NOT_FOR_PROFIT.md`](../NOT_FOR_PROFIT.md).

A **person** is one Node user. They are uniquely identified. They may prove who they are with **email**, an **Ethereum wallet** (signature verification), a **smart-card reader** (PIV, CAC, national eID), a **driver’s license or passport** (hashed civic ID), or a **passkey**. Several Ethereum addresses may be **internally verified**. **Exactly one** Ethereum address is **active**.

**Every sign-in path completes with email MFA** (a 6-digit code sent by **AWS SES**), in the same transactional-mail pattern as DealPunchList. Dev login on a local host can skip MFA. `NODE_ENV=test` skips MFA on non-email factors unless `REQUIRE_EMAIL_MFA=1` so existing passkey/web3 tests stay green.

The vote Merkle leaf is still an **identity commitment**. It is never the active address, never a name, never a credential id, and never a license or passport number.

This Node does **not** store passport or license **images** or **full document numbers**. Civic ID is a keccak hash of `kind|issuer|normalizedNumber`. It is **not** court-ready commercial identity verification.

```
Person (one Node user)
  ├── authMethods[]     email | web3 | smart_card | civic_id | passkey
  ├── email             MFA destination (also an email auth method)
  ├── ethAccounts[]      many verified addresses, globally unique to that person
  └── activeEthAddress   exactly one (or none until the first address is verified)
```

---

## Uniqueness

| Binding | Rule |
| --- | --- |
| Authenticator (email, credential id, wallet, card fingerprint, civic-id hash) | Belongs to at most one person (`METHOD_OWNED`). |
| Ethereum address | Belongs to at most one person (`ADDRESS_OWNED`). |
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

**Register:** `POST /api/identity/email/start` `{ email, handle? }` → SES code → `POST /api/auth/mfa/verify`.

**Login:** `POST /api/auth/email/start` `{ email }` → SES code → verify. Unknown emails are `404 UNKNOWN_CREDENTIAL` (does not create a person).

### Web3 wallet

**Register / bind**

1. `POST /api/identity/web3/challenge` `{ address }` → SIWE-like bind message (nonce stored on the Node).
2. Wallet `personal_sign`s that message.
3. `POST /api/identity/web3/verify` `{ address, signature }` reconstructs the message from the **stored** challenge (the client message is not trusted).
4. Adds `web3` auth method **and** an internally verified ETH account. First account becomes active. Then email MFA when required.

**Login (returning user)**

1. `POST /api/auth/web3/challenge` `{ address }` → SIWE-like **login** message (different text from bind; stored nonce).
2. Wallet `personal_sign`s that message.
3. `POST /api/auth/web3/login` `{ address, signature }` verifies against the stored message and resolves the Person who already has that web3 method or verified ETH address. Unknown wallets are `404 UNKNOWN_CREDENTIAL` — login does not create a person. Then email MFA when required.

### Smart-card reader

Kiosk or clerk desk. Fingerprint is a hex digest or keccak256 of a PEM. Live X.509 path verification is **not** in this Node build.

- Self-service mock: `{ mock: true }` only when `ALLOW_SMART_CARD_MOCK=1` or `NODE_ENV=test`.
- Production: registrar `POST /api/persons/:id/methods` `{ type: "smart_card", fingerprint }`.
- Returning-user login: `POST /api/auth/smart-card/challenge` then `POST /api/auth/smart-card/login` (does not create a person), then email MFA.

### Driver’s license or passport (`civic_id`)

Socially certified photo ID. Hash only: `keccak256(utf8("republic:civic_id:v1|{kind}|{issuer}|{number}"))`.

- Kinds: `drivers_license` | `passport`.
- Self-service mock: `{ mock: true }` when `ALLOW_CIVIC_ID_MOCK=1` (or smart-card mock / tests).
- Production: registrar attest. The registrar may send `documentNumber`; the Node hashes it and **does not persist** the number.
- Login: `POST /api/auth/civic-id/login` `{ kind, issuer, documentNumber }` recomputes the hash. Then email MFA.

### Passkey

WebAuthn resident credential. `POST /api/auth/passkey/register/finish` records a `passkey` auth method, then MFA when required. Returning users call `POST /api/auth/passkey/login/begin` then `finish`. See [`PASSKEYS.md`](./PASSKEYS.md).

---

## HTTP

```
GET  /api/identity/methods
GET  /api/config                      (identity.methods, auth.emailLogin, auth.requireEmailMfa, auth.emailMfaVendor=ses)

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

POST /api/persons/:id/methods         (registrar; type email | web3 | smart_card | civic_id | passkey)
```

Passkey begin/finish stay under `/api/auth/passkey/*`. Wallet **login** is `/api/auth/web3/*`. Identity **bind** routes stay under `/api/identity/*` so registration cannot be confused with returning-user login.

---

## On chain

`smart-contracts/src/PersonRegistry.sol` — `personId` is `bytes32` (never a name). `verifyAddress` / `setActive` are registrar/admin. Globally unique via `personOf[account]`. Not a substitute for `VoterRegistry`; it only answers which EOA or smart account this person is using for gasless ops.

---

## Privacy

Public ballot rows remain `{ nullifier, ballotHash, electionId, relayer }`. No `userId`, no choice, no identity commitment, no active ETH address on the vote. Hourly disclosure is unchanged ([`ARCHITECTURE.md`](./ARCHITECTURE.md)). Civic document numbers never appear in `republic.json`.

# Person identity

**NOT FOR PROFIT** — civic public good. Not a commercial product. See [`/NOT_FOR_PROFIT.md`](../NOT_FOR_PROFIT.md).

A **person** is one Node user. They are uniquely identified. They may prove who they are with a **passkey**, a **Web3 wallet**, or a **smart-card digital ID** (PIV, CAC, national eID). Several Ethereum addresses may be **internally verified**. **Exactly one** Ethereum address is **active**.

The vote Merkle leaf is still an **identity commitment**. It is never the active address, never a name, and never a credential id.

```
Person (one Node user)
  ├── authMethods[]     passkey | web3 | smart_card   (all may be verified)
  ├── ethAccounts[]      many verified addresses, globally unique to that person
  └── activeEthAddress   exactly one (or none until the first address is verified)
```

---

## Uniqueness

| Binding | Rule |
| --- | --- |
| Authenticator (credential id, wallet, card fingerprint) | Belongs to at most one person (`METHOD_OWNED`). |
| Ethereum address | Belongs to at most one person (`ADDRESS_OWNED`). |
| Optional registrar `personKeyHash` | keccak256 of a civil-file token. Unique (`PERSON_KEY_OWNED`). The Node stores the hash, never a legal name. |

Signing a Web3 challenge with a wallet that is **already a web3 auth method** logs that person in. Signing a wallet that is only on someone else’s **internal** `ethAccounts` list does **not** log you in as them; it returns `ADDRESS_OWNED`.

---

## Active address vs vote leaf

1. First internally verified Ethereum address becomes active automatically.
2. Switching active (`POST /api/me/eth-accounts/active` or registrar) does not un-verify the previous address.
3. `PersonRegistry.setActive` on chain reverts `SameActive` if that address is already active. The Node setter is idempotent.
4. Registration still inserts `identityCommitment` into `VoterRegistry`. Gasless ops may use the active address as the account abstraction sender. Explorers must not treat that sender as the ballot.

---

## How each method binds

### Passkey

WebAuthn resident credential. `POST /api/auth/passkey/register/finish` creates the session and records a `passkey` auth method. The device may also register its derived local address via `POST /api/me/eth-accounts` after login. See [`PASSKEYS.md`](./PASSKEYS.md).

### Web3 wallet

1. `POST /api/identity/web3/challenge` `{ address }` → SIWE-like message (nonce stored on the Node).
2. Wallet `personal_sign`s that message.
3. `POST /api/identity/web3/verify` `{ address, signature }` reconstructs the message from the **stored** challenge (the client message is not trusted).
4. Adds `web3` auth method **and** an internally verified ETH account. First account becomes active.

### Smart-card digital ID

Kiosk or clerk desk. Fingerprint is a hex digest or keccak256 of a PEM. Live X.509 path verification is **not** in this Node build.

- Self-service mock: `{ mock: true }` only when `ALLOW_SMART_CARD_MOCK=1` or `NODE_ENV=test`.
- Production: registrar `POST /api/persons/:id/methods` `{ type: "smart_card", fingerprint }`.

---

## HTTP

```
GET  /api/identity/methods
GET  /api/config                      (identity.methods, identity.oneActiveEthAddress)
GET  /api/me                          (identity + user.activeEthAddress)
GET  /api/me/identity

POST /api/identity/web3/challenge
POST /api/identity/web3/verify
POST /api/identity/smart-card/challenge
POST /api/identity/smart-card/verify

POST /api/me/eth-accounts             (session; internally verify another address)
POST /api/me/eth-accounts/active       (must already be verified for this person)

POST /api/persons/:id/person-key     (registrar / platform_admin)
POST /api/persons/:id/methods
POST /api/persons/:id/eth-accounts
POST /api/persons/:id/eth-accounts/active
```

Passkey begin/finish stay under `/api/auth/passkey/*`. Identity bind routes are **not** under `/api/auth/web3` so the auth router cannot swallow them.

---

## On chain

`smart-contracts/src/PersonRegistry.sol` — `personId` is `bytes32` (never a name). `verifyAddress` / `setActive` are registrar/admin. Globally unique via `personOf[account]`. Not a substitute for `VoterRegistry`; it only answers which EOA or smart account this person is using for gasless ops.

---

## Privacy

Public ballot rows remain `{ nullifier, ballotHash, electionId, relayer }`. No `userId`, no choice, no identity commitment, no active ETH address on the vote. Hourly disclosure is unchanged ([`ARCHITECTURE.md`](./ARCHITECTURE.md)).

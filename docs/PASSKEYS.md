# Passkeys

**NOT FOR PROFIT** — civic public good. Not a commercial product. See [`/NOT_FOR_PROFIT.md`](../NOT_FOR_PROFIT.md).

Republic voters do not handle seed phrases. A **WebAuthn** credential on the device is the root secret. Two independent derivations are taken from it:

1. An **Ethereum smart-account** key (secp256k1), used only to authorize a UserOperation.
2. A **ZK identity** `(identityTrapdoor, nullifierSecret)`, used only inside the vote circuit.

The ballot is unlinkable from the smart-account address. L2 gas is **sponsored** (paymaster). This document is the implementation note for that construction; the interface contract is [`ARCHITECTURE.md`](./ARCHITECTURE.md).

---

## Why passkeys

| Problem | Passkey answer |
| --- | --- |
| Seed phrases in a civic UX | Resident WebAuthn key; nothing to write down. |
| Malware exfiltrating an unlocked private key | PRF / `hmac-secret` stays in the authenticator. Plaintext secp256k1 is unwrapped only in memory for one signature, then dropped. |
| “The voter paid gas, so their EOA is next to the ballot” | Bundler submits the UserOp; paymaster pays; vote `msg.sender` is the relayer. |
| Linking civil identity → wallet → choice | Wallet is not the Merkle leaf; choice is not a public field. |

This follows the same idea as Inertia-style passkey-held wallets: the browser never displays a mnemonic. Republic adds a second PRF domain for the ZK trapdoor so the **account key and the vote identity are not the same bytes**.

---

## WebAuthn PRF wrapping the Ethereum key

### Create

1. `navigator.credentials.create` with `residentKey: "required"` (or `discoverable credential`), `userVerification: "required"`, and `extensions: { prf: { eval: { first: saltAccount } } }` (and a second salt for identity when the authenticator supports two evals / two salts).
2. Persist `credentialId` (and COSE P-256 `x,y` if using on-chain WebAuthn verification) on the Node. Not the PRF output.
3. `prf.eval` first output → **HKDF-SHA-256** → either:
   - **Wrap** a randomly generated secp256k1 private key (AES-GCM or equivalent) and store the blob in IndexedDB, or
   - **Derive** the secp256k1 key directly from HKDF (simpler; rotation means a new account).
4. `PasskeyAccountFactory.createAccount(credIdHash, pubX, pubY, salt)` deploys the ERC-4337-style account whose owner is the **P-256 / WebAuthn** public key when the on-chain verifier checks assertions, **or** whose spending key is the wrapped secp256k1, depending on the account flavor in `src/account/`.

Republic v1 may use secp256k1 inside the account for UserOp signatures (browser `viem` / `noble-curves`) while the WebAuthn assertion is what **unlocks** that key via PRF. A stricter flavor verifies WebAuthn on chain (`PasskeyAccount`). Both are gasless from the voter’s point of view.

### Sign a UserOp

1. `navigator.credentials.get` with `extensions.prf.eval` (same salts).
2. HKDF → unwrap (or re-derive) secp256k1.
3. Sign the UserOp hash.
4. **Zero** the key material in memory (overwrite `Uint8Array`, drop closures).
5. Hand the UserOp to the Node relayer / bundler. The voter does not broadcast from a personal RPC with a funded EOA.

### Fallback if PRF is unavailable

Some authenticators still lack `prf` / `hmac-secret`. Then:

- Still create the passkey for **login** (discoverable credential).
- Wrap the secp256k1 key with a key derived from the **assertion signature** (or from a device-bound secret the Node never sees).
- Document this path as **weaker**: a cloned assertion transcript might be more useful to an attacker than PRF output that never left the authenticator.
- **Never** display a mnemonic as the fallback.

---

## ZK identity (second PRF domain)

```text
prf.eval(saltIdentity) ──► HKDF ──► (identityTrapdoor, nullifierSecret)
                              │
                              └── Poseidon(trapdoor, nullifierSecret) = identityCommitment
```

The commitment is the **Merkle leaf** `VoterRegistry.register` inserts. It is not the smart-account address, not the credential id, and not a name.

A person may also bind a **Web3 wallet** or a **smart-card digital ID**. Those authenticators identify the same person. Several ETH addresses can be verified internally; only one is active. Details: [`IDENTITY.md`](./IDENTITY.md).

At vote time the circuit (`circuits/vote.circom`) proves knowledge of trapdoor + secret whose leaf is in the **eligible** tree, and reveals

```text
nullifier = Hash(nullifierSecret, electionId)
```

(Poseidon in production; the circom `Hasher()` stand-in is **not** Poseidon). The nullifier is unlinkable to the passkey account and to the civil file without the trapdoor.

Use **domain-separated salts** so account HKDF and identity HKDF cannot be swapped:

- `saltAccount`  = `HKDF-Extract` info `"republic:account:v1"` + `credentialId` + chain id
- `saltIdentity` = `"republic:identity:v1"` + `credentialId` + `jurisdictionId`

Do not reuse the Ethereum private key as `identityTrapdoor`. That would make every on-chain account signature a potential identity leak.

### SPA construction (`apps/node/public/passkey-wallet.js`)

The browser wallet implements those two domains. After create, it **re-evals** PRF with salts derived from the new `credentialId` (create-time `prf.eval` only enables the extension; that output is discarded).

Exact HKDF-SHA-256 (WebCrypto; equivalent to HKDF-Extract then Expand, L = 32):

```text
saltAccount  = HKDF(ikm = credentialId, salt = "republic:account:v1",  info = decimal chain id)
saltIdentity = HKDF(ikm = credentialId, salt = "republic:identity:v1", info = jurisdictionId)

prf.eval({ first: saltAccount, second: saltIdentity })

account wrap key = HKDF(ikm = prf.first,  salt = "republic:account:v1",  info = "republic-secp256k1-wrap")
(trapdoor || nullifierSecret) = HKDF(ikm = prf.second, salt = "republic:identity:v1", info = "trapdoor+nullifier", L = 64)
```

If the authenticator returns `first` but not `second`, the wallet runs a **second assertion** with `eval.first = saltIdentity`. It will not fold identity into the account seed.

`jurisdictionId` is bound when the wallet is provisioned (selected election, else `demo`) and stored on the IndexedDB record so later votes re-derive the same leaf. Default chain id is Republic L2 `27427`. Login work can reuse `prfEvalSaltsForCredential` / `buildPrfEvalExtension` without changing this file’s wrap path.

#### IndexedDB v1 → v2 (breaking demo reset)

Wallet store `republic-wallet` is **version 2**. Record field `version` is `2`, `identityScheme` is `prf-hkdf-identity-v2`.

v1 wraps (single random PRF salt; trapdoor HKDF’d from the account seed) **cannot** be unwrapped under the new salts. The SPA refuses to sign or register from a v1 record and asks the voter to **reset the device wallet** and create a new passkey. The local address and identity commitment change; any prior demo roll row will not match. There is no silent in-place identity regeneration, because v1’s PRF salt was not domain-separated.

#### Intentional demo deviations that remain

- Commitment hasher is still **keccak256(trapdoor || nullifierSecret)** in the SPA; production circuits use Poseidon (`circuits/`).
- Account “address” is still `SHA-256(seed)[0:20]` (`republic-local-address`), not secp256k1/keccak.
- UserOp stand-in is HMAC-SHA256 of the seed, not an ERC-4337 secp256k1 signature.
- When PRF is missing, account wrap and identity still use **two** HKDF domains of the credential id (not the same bytes). That path is weaker than authenticator PRF and is demo-only.
- Node HTTP still stores credential ids only; it does not see PRF output or trapdoors.

---

## Gasless L2

Voters **never pay** Republic L2 gas. There is no token.

| Piece | Role |
| --- | --- |
| `RepublicPaymaster` | Sponsors UserOps whose `callData` targets `BallotInbox`, `VoterRegistry.register`, or `PasskeyAccountFactory`. |
| Bundler / relayer | `msg.sender` on those calls. `RELAYER_ROLE` where the contracts require it. |
| Jurisdiction | Funds the paymaster **at cost** (sequencer/operator budget). |

If the paymaster is empty, registration and voting stall (liveness). That is an operator problem (`docs/OPERATOR.md`), not a reason to ask voters for ETH.

UserOp `sender` is the passkey account. Inbox events still record the **relayer**, not a “voter EOA voted”. The explorer must not collapse those fields into a public voter profile ([`BLOCK_EXPLORER.md`](./BLOCK_EXPLORER.md)).

---

## Unlinkability from the ballot

A coercer can observe:

- That a passkey account exists (factory event, maybe a registration UserOp).
- That **some** nullifier appeared in `VoteAccepted`.
- The encrypted `ballotHash` (not the option).

They cannot, from chain data alone:

- Map `nullifier` → smart-account address.
- Map `nullifier` → civil name.
- Map `ballotHash` → option id.
- Demand an “I voted for X” receipt from the Node (forbidden).

Caveats (honest, not marketing):

- **Registration UX** still ties a person to a commitment in the clerk’s off-chain file. That is a legal roll, not a public join.
- **Timing / network metadata** (kiosk IP, bundler logs) can leak if operators keep identifying logs next to UserOp hashes. Do not.
- **First versions** may be weaker on coercion resistance (a voter might still prove how they voted *off-chain* if they keep the witness). Last-vote-counts / MACI-style messaging is a later upgrade. Passkeys do not by themselves solve vote buying.
- If PRF is skipped and the same secp256k1 key is used as the trapdoor, unlinkability **collapses**. Do not ship that.

---

## Node HTTP

```text
POST /api/auth/passkey/register/begin
POST /api/auth/passkey/register/finish
POST /api/auth/passkey/login/begin
POST /api/auth/passkey/login/finish
POST /api/elections/:id/register    (after passkey; commitment, not name)
POST /api/elections/:id/vote        (relays UserOp / proof)
GET  /api/identity/methods
POST /api/identity/web3/challenge
POST /api/identity/web3/verify
POST /api/identity/smart-card/challenge
POST /api/identity/smart-card/verify
GET  /api/me/identity
POST /api/me/eth-accounts
POST /api/me/eth-accounts/active
POST /api/persons/:id/person-key     (registrar)
POST /api/persons/:id/methods
POST /api/persons/:id/eth-accounts
POST /api/persons/:id/eth-accounts/active
```

Relying party id, origins, and attestation policy are jurisdiction / host configuration. Production (`master`) must pin RP id to the public site. `test/unstable` may use localhost.

The Node stores credential ids and wrapped-key **ciphertexts** if the wrap-in-IndexedDB-plus-backup path is enabled. It must not store PRF output or trapdoors.

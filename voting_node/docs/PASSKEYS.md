# Passkeys

**NOT FOR PROFIT** — civic public good. Not a commercial product. See [`/NOT_FOR_PROFIT.md`](../NOT_FOR_PROFIT.md).

ZK-Voting voters do not handle seed phrases. A **WebAuthn** credential on the device is the root secret. Two independent derivations are taken from it:

1. An **Ethereum smart-account** key (secp256k1), used only to authorize a UserOperation.
2. A **ZK identity** `(identityTrapdoor, nullifierSecret)`, used only inside the vote circuit.

The ballot is unlinkable from the smart-account address. L2 gas is **sponsored** (paymaster). This document is the implementation note for that construction; the package map
is [`ARCHITECTURE.md`](./ARCHITECTURE.md). **Implemented today** in
`apps/node/public/passkey-wallet.js`: WebAuthn + PRF wrap of a 32-byte seed in
IndexedDB. `getAddress()` returns `zk-voting-local-address` (SHA-256 of the seed).
Production Ethereum addresses (keccak256 of the uncompressed secp256k1 pubkey)
are **Future** in that helper — it does not ship a curve implementation.

---

## Why passkeys

| Problem | Passkey answer |
| --- | --- |
| Seed phrases in a civic UX | Resident WebAuthn key; nothing to write down. |
| Malware exfiltrating an unlocked private key | PRF / `hmac-secret` stays in the authenticator. Plaintext secp256k1 is unwrapped only in memory for one signature, then dropped. |
| “The voter paid gas, so their EOA is next to the ballot” | Bundler submits the UserOp; paymaster pays; vote `msg.sender` is the relayer. |
| Linking civil identity → wallet → choice | Wallet is not the Merkle leaf; choice is not a public field. |

The browser never displays a mnemonic. ZK-Voting adds a second PRF domain for the ZK trapdoor so the **account key and the vote identity are not the same bytes**.

---

## WebAuthn PRF wrapping the Ethereum key

### Create

1. `navigator.credentials.create` with `residentKey: "required"` (or `discoverable credential`), `userVerification: "required"`, and `extensions: { prf: { eval: { first: saltAccount } } }` (and a second salt for identity when the authenticator supports two evals / two salts).
2. Persist `credentialId` (and COSE P-256 `x,y` if using on-chain WebAuthn verification) on the Node. Not the PRF output.
3. `prf.eval` first output → **HKDF-SHA-256** → either:
   - **Wrap** a randomly generated secp256k1 private key (AES-GCM or equivalent) and store the blob in IndexedDB, or
   - **Derive** the secp256k1 key directly from HKDF (simpler; rotation means a new account).
4. `PasskeyAccountFactory.createAccount(credIdHash, pubX, pubY, salt)` deploys the ERC-4337-style account whose owner is the **P-256 / WebAuthn** public key when the on-chain verifier checks assertions, **or** whose spending key is the wrapped secp256k1, depending on the account flavor in `src/account/`.

ZK-Voting v1 may use secp256k1 inside the account for UserOp signatures (browser `viem` / `noble-curves`) while the WebAuthn assertion is what **unlocks** that key via PRF. A stricter flavor verifies WebAuthn on chain (`PasskeyAccount`). Both are gasless from the voter’s point of view.

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

A person may also bind **email** (up to 5, one primary), a **Web3 wallet**, a **smart-card reader**, or a hashed **driver’s license / passport**. Those authenticators identify the same person. Sign-in still completes with email MFA. Several ETH addresses can be verified internally; only one is active. A person may register **up to 5 passkeys**; any of them can log in. Details: [`IDENTITY.md`](./IDENTITY.md).

At vote time the circuit (`circuits/vote.circom`) proves knowledge of trapdoor + secret whose leaf is in the **eligible** tree, and reveals

```text
nullifier = Hash(nullifierSecret, electionId)
```

Circom `Hasher()` and the demo SPA commitment are both Poseidon(2). The nullifier is unlinkable to the passkey account and to the civil file without the trapdoor. Wiring Poseidon is not a ceremony. The circuit also proves the leaf is outside the disqualification chain (`disqRoot`).

Use **domain-separated salts** so account HKDF and identity HKDF cannot be swapped:

- `saltAccount`  = `HKDF-Extract` info `"zk-voting:account:v1"` + `credentialId` + chain id
- `saltIdentity` = `"zk-voting:identity:v1"` + `credentialId` + `jurisdictionId`

Do not reuse the Ethereum private key as `identityTrapdoor`. That would make every on-chain account signature a potential identity leak.

### SPA construction (`apps/node/public/passkey-wallet.js`)

The browser wallet implements those two domains. After create, it **re-evals** PRF with salts derived from the new `credentialId` (create-time `prf.eval` only enables the extension; that output is discarded).

Exact HKDF-SHA-256 (WebCrypto; equivalent to HKDF-Extract then Expand, L = 32):

```text
saltAccount  = HKDF(ikm = credentialId, salt = "zk-voting:account:v1",  info = decimal chain id)
saltIdentity = HKDF(ikm = credentialId, salt = "zk-voting:identity:v1", info = jurisdictionId)

prf.eval({ first: saltAccount, second: saltIdentity })

account wrap key = HKDF(ikm = prf.first,  salt = "zk-voting:account:v1",  info = "zk-voting-secp256k1-wrap")
(trapdoor || nullifierSecret) = HKDF(ikm = prf.second, salt = "zk-voting:identity:v1", info = "trapdoor+nullifier", L = 64)
```

If the authenticator returns `first` but not `second`, the wallet runs a **second assertion** with `eval.first = saltIdentity`. It will not fold identity into the account seed.

`jurisdictionId` is bound when the wallet is provisioned (selected election, else `demo`) and stored on the IndexedDB record so later votes re-derive the same leaf. Default chain id is ZK-Voting L2 `27427`. Returning-user `loginPasskey` is session-only and does not eval these salts; wallet unwrap still uses `prfEvalSaltsForCredential` / `buildPrfEvalExtension`.

#### IndexedDB record version 3 (Poseidon leaf)

Wallet store `zk-voting-wallet` schema is **version 2**. Record field `version` is `3`, `identityScheme` is `prf-hkdf-poseidon-v3`.

v1 wraps (single random PRF salt; trapdoor HKDF’d from the account seed) cannot be unwrapped under the domain salts. v2 records stored `keccak256(trapdoor || nullifierSecret)`, which is not the circuit leaf. The SPA treats both as stale and asks the voter to **reset the device wallet** and create a new passkey. The identity commitment changes; any prior demo roll row will not match.

#### Intentional demo deviations that remain

- The demo SPA commitment is **Poseidon(trapdoor, nullifierSecret)** (`poseidonCommitmentHex`), the same leaf as `circuits/identity.circom`. 32-byte HKDF outputs are reduced mod the bn254 scalar field. Foundry `IdentityCommitment.toLeaf` is still keccak for unit-test trees. Do not insert a keccak leaf into a Poseidon tree.
- Account “address” is still `SHA-256(seed)[0:20]` (`zk-voting-local-address`), not secp256k1/keccak.
- UserOp stand-in is HMAC-SHA256 of the seed, not an ERC-4337 secp256k1 signature.
- When the identity-domain PRF output is missing, the device may still wrap an account seed. It does **not** derive a vote identity from the credential id. Voting throws `IDENTITY_PRF_REQUIRED`.
- Node HTTP still stores credential ids only; it does not see PRF output or trapdoors.

---

## Gasless L2

Voters **never pay** ZK-Voting L2 gas. There is no token.

| Piece | Role |
| --- | --- |
| `ZkVotingPaymaster` | Sponsors UserOps whose `callData` targets `BallotInbox`, `VoterRegistry.register`, or `PasskeyAccountFactory`. |
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
GET  /api/me/passkeys
DELETE /api/me/passkeys/:credentialId
POST /api/auth/web3/challenge
POST /api/auth/web3/login
POST /api/auth/logout
POST /api/auth/dev-login              (ALLOW_DEV_LOGIN / NODE_ENV=test only)
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

Relying party id and origins follow the request host when that host is allowed by `VOTE_FQDN`, `WEBAUTHN_ORIGINS`, `RP_ID`, or `WEBAUTHN_HOST_SUFFIXES`. A public `RP_ID` is used only when it is the host or a parent of it. Otherwise the request hostname is the RP ID, so a rotating test host does not share passkeys with the voting hostname. An unknown `Host` does not widen the allowlist. Registration and login require user verification and a resident key. Attestation stays `none`: the server still checks the challenge, the origin, the RP ID hash, the user-presence and user-verification flags, and stores the COSE public key from the authenticator data. It does not store a public key supplied beside the attestation. See [OPERATOR.md](./OPERATOR.md) for `VOTE_FQDN` and the setup token.

The Node stores credential ids and wrapped-key **ciphertexts** if the wrap-in-IndexedDB-plus-backup path is enabled. It must not store PRF output or trapdoors.

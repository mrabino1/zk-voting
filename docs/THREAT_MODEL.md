# Threat model — election identity and L1 certification

**NOT FOR PROFIT** — civic public good. Not a commercial product.

Anything that lets people run a binding vote will be attacked. Republic does
not treat a public UUID as a security boundary. This file is the adversarial
map for **who can occupy an L1 result slot**, impersonate a jurisdiction, or
confuse the public record. Crypto gaps (MockVerifier, Poseidon, ceremony)
are labeled elsewhere; they are **not** an identity defense.

Implemented on `test/unstable`. If this disagrees with the contracts, the
contracts win.

---

## What an authoritarian adversary wants

1. **Overwrite** an honest certified tally on Ethereum (courts look here).
2. **Mimic** an honest contest (same UUID, same uint256, same jurisdiction
   name) so media and voters cite the fake.
3. **Front-run** L1 so `AlreadyPosted` freezes a lie.
4. **Confuse** explorers, CMS pages, and unofficial dashboards without
   touching L1 (cheap, high impact).
5. **Capture keys** (factory admin, L1 publisher, Node `platform_admin`)
   rather than break keccak.

Defense in depth: different ids on different layers, fail closed when a
pin is missing, first L1 writer wins **and that is treated as a key-custody
problem**, not a UUID problem.

---

## Canonical L1 identity

```
certificationId = keccak256(abi.encode(
  keccak256("republic.election.identity.v1"),
  factory,          // shared ElectionFactory
  electionId,       // factory uint256
  jurisdictionId    // Election.params, not a client string
))
```

`publicIdHash` is an attribute (ASCII-lowercased UUID). It never keys the
slot. `publicIdCollision` is detection, not exclusion.

| Attacker action | Honest L1 slot |
| --- | --- |
| Copy UUID | Different `(factory, electionId, jurisdictionId)` → different slot |
| Same uint256 on a rogue factory | `WrongFactory` when the mirror is pinned |
| Same factory id, other jurisdiction | Different `jurisdictionId` in the key; on-chain `JurisdictionMismatch` when the factory is readable |
| First writer of the honest triple | **Occupies the slot.** `AlreadyPosted` then protects the lie. |

That last row is why publisher keys are election-critical.

---

## Attack tree (identity / L1)

### Closed or fail-closed on this line

| Vector | Control |
| --- | --- |
| Client `id` / `uuid` squat | Node ignores them; mints UUID v5 from factory + uint256 + jurisdiction |
| Client `factoryAddress` | Ignored; only chain create or the env pin is stored |
| Client `onChainElectionId` | Ignored; demo allocates locally; on-chain ids come from the factory |
| Self-declared clerk of another body | `ElectionFactory` + `JurisdictionRegistry.isClerk` (registry **must** be wired; `DeployL2` / `_deployElectionStack` now do that) |
| Officer (registrar / tally) creating elections | `isClerk` is the clerks mapping, not `officers` |
| Rotated clerk keeps create rights | `setClerk` clears the previous address from `clerks` |
| Global L1 publisher certifies every body | After `setL2Factory`, `_canPost` ignores `publishers[]`; need jurisdiction publisher, tally operator (readable factory), or admin |
| Unpin / swap the factory pin | `setL2Factory` reverts `FactoryAlreadyPinned` (or `ZeroAddress`); first non-zero pin wins |
| Legacy `postResult(uint256)` collision | Reverts `UseIdentityPost` when factory is pinned; `DeployL1` requires `L2_FACTORY` |
| Node L1 post without factory | Failed closed; no uint256 fallback |
| Copied v5 UUID on outcomes | `publicIdMatchesScope` recomputes v5 |
| Legacy v4 UUID with a factory pin | `publicIdMatchesScope` fails closed |
| Mixed-case UUID attribute | Solidity and JS `publicIdHash` lowercase ASCII |
| `AlreadyPosted` bookkeeping lies | Re-read `resultHashOfIdentity` before and after the write; mismatch → `already_posted_mismatch` |
| Unauthenticated explorer ingest | `EXPLORER_INGEST_SECRET` required outside tests |
| Captured clerk rewrites About / FAQ / home | Unscoped CMS pages and site title are `platform_admin` only; clerks publish jurisdiction-tagged pages |
| `ALLOW_DEV_LOGIN` on a public host | Ignored when `NODE_ENV=production`; route 404s |
| Public officer roster for phishing | Unauthenticated `/api/jurisdictions` returns names only; `/roles` requires a signed-in officer |

### Residual (must stay in the operator’s head)

| Vector | Why it remains | Operator duty |
| --- | --- | --- |
| Compromised **mirror admin** | Break-glass `_canPost` | Multisig / cold admin; do not use admin as the daily publisher |
| Compromised **jurisdiction publisher** or **tallyOperator** | They are allowed to write that body’s slot | Per-body keys; rotate; pin factory so they cannot pick another factory |
| First L1 writer wins | Mirror is a court copy, not a challenge game | Certify only after local tally; monitor `hashMismatch` |
| Factory **admin** / `PLATFORM_ADMIN_ROLE` | Bootstrap still bypasses clerk ACL | Narrow who holds factory admin; registry still required for everyone else |
| Unreadable L2 factory on L1 | No `JurisdictionMismatch` check (L2 address has no code on L1) | Always pin; grant only `setJurisdictionPublisher` per body — never a global publisher |
| Hostile **Node operator** editing JSON | Forked hosts are trusted for their own UI | `/outcomes` checks internal consistency; courts use L1 + auditor pack |
| BallotInbox / Groth16 still `uint256` | Per-factory storage | Proofs are not portable across factories |
| Compromised **Node `platform_admin`** | Host can rewrite About / FAQ and grant clerks | One Node per jurisdiction when possible; treat host keys as election-critical |
| Explorer ingest secret leak | Ingest can poison the public L2 log (not L1) | Treat the secret like a publisher key; never run production with `NODE_ENV=test` |
| MockVerifier / stand-in hasher | Documented non-production | Do not run a binding election on `test/unstable` crypto |

---

## Authoritarian playbook (identity / L1 / public record)

Assume a well-resourced adversary that wants the **appearance** of a stolen
election without breaking keccak. They will mix cheap confusion with rare
overwrite. The design treats those as different failures.

| Play | Goal | Why it fails or degrades |
| --- | --- | --- |
| Copy the honest UUID into a rogue contest | Media cites the fake | L1 slot is not the UUID; outcomes `publicIdMatchesScope` fails; `publicIdCollision` flags the copy |
| Deploy a private factory with the same uint256 | “We certified election 1 too” | Pinned mirror `WrongFactory`; Node ignores client `factoryAddress` |
| Self-declare as clerk of the honest body | Mint an election that *looks* official on-chain | Registry `isClerk`; officers cannot create; rotated clerks lose create |
| Steal one global L1 publisher | Overwrite every jurisdiction | After pin, global `publishers[]` is ignored; per-body keys |
| Unpin the factory after compromise | Revive that global key | Pin is one-way (`FactoryAlreadyPinned`) |
| Front-run L1 with a lie | Freeze `AlreadyPosted` on a false hash | First writer wins **by design**; operators monitor `hashMismatch` / `already_posted_mismatch` |
| Unauthenticated explorer ingest | Dashboards show fake turnout | Shared secret; unset secret refuses ingest outside tests |
| Captured clerk on a shared Node | Rewrite About / FAQ as if the host endorsed it | Unscoped pages and site title are host-only |
| Enable `ALLOW_DEV_LOGIN` on the public host | Instant `platform_admin` | `NODE_ENV=production` ignores it |
| Scrape `/api/jurisdictions` for clerk handles | Targeted phishing of the official desk | Public list is names only; roster is officer-auth |
| Ambiguous `/elections/1` | Serve the wrong contest | 409 `ELECTION_ID_COLLISION` rather than the first match |
| DoS the Node or explorer | Hide the honest UI | Courts read L1 + auditor pack; L2 ingest failure does not halt sequencing |
| Capture factory admin or mirror admin | Bootstrap elections / break-glass post | Residual. Multisig those keys; they are not “just devops” |

Trust that **scales**: many jurisdictions share one factory and one L1
mirror; each forks its Node. A hostile Node can lie to its visitors. It
cannot occupy another body’s certification slot.

---

## Scaling and trust

- **Many jurisdictions, one factory.** That is the pin. Fork the Node, not the factory. UUID v5 and L1 slots both include that address.
- **Many Nodes, one L1 mirror.** Confusion on a rogue Node does not move the honest slot. Pin `ELECTION_FACTORY_ADDRESS` on every honest Node.
- **Availability.** Ambiguous refs return 409 rather than the wrong election. Explorer ingest failure does not halt L2.
- **Detection.** `publicIdCollision`, outcomes `publicIdMatchesScope` / `l1FactoryMatchesPinned` / `already_posted_mismatch`. Detection is not prevention for a stolen publisher key.

---

## Verification (this branch)

Foundry: `ElectionIdentity.t.sol` (copied UUID, two factories, clerk spoof, officer cannot create, rotated clerk, pinned factory rejects rogue factory / global publisher / legacy uint256 / unpin). Node + chain-client: ignored client ids, v5 scope, ingest secret, AlreadyPosted re-read / hash mismatch, unscoped CMS host-only.

Related: [`ARCHITECTURE.md`](./ARCHITECTURE.md) (identifiers), [`OPERATOR.md`](./OPERATOR.md) (pins and publishers).

# smart-contracts

**NOT FOR PROFIT** — civic public good. Not a commercial product.

Foundry package for Republic / zk-voting: an unbounded `ElectionFactory` (EIP-1167 clones), identity-commitment registries, a ZK ballot inbox, tally verifier, passkey account abstraction with a gasless paymaster, and L1 rollup settlement for Republic L2.

There is no token. There are no voter fees. The leaf in the Merkle tree is an **identity commitment**, never a wallet address. `msg.sender` on `submitVote` is the relayer.

## Layout

- `src/ElectionFactory.sol` — unlimited elections, start + cutoff, `maxParticipants == 0` unlimited roll
- `src/VoterRegistry.sol` / `PersonRegistry.sol` / `DisqualificationRegistry.sol` / `BallotInbox.sol` / `Tally.sol`
- `src/account/` — passkey AA + `RepublicPaymaster`
- `src/l2/` — `RollupSettlement`, mailbox, L1 tally mirror
- `src/zk/` — `MockVerifier` (unit tests), structural `VoteVerifier`, `Groth16VerifierAdapter`
- `src/hasher/` — `KeccakHasher` (tests), `StandInHasher` (proving path), `HashScheme` ids
- `test/` — unit, fuzz (`test/fuzz`), invariant (`test/invariant`)
- `script/` — `DeployLocal`, `DeployL1`, `DeployL2`, `CreateElection`

## Test

```bash
forge test --via-ir
```

Unit tests use `MockVerifier`. Non-mock deploy:

```bash
REPUBLIC_PROVING_PATH=1 forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
```

Solidity 0.8.24. License AGPL-3.0-or-later. See `/NOT_FOR_PROFIT.md`.

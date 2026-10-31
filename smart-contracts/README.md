# smart-contracts

**NOT FOR PROFIT** — civic public good. Not a commercial product.

Foundry package for zk-voting: an unbounded `ElectionFactory` (EIP-1167 clones), identity-commitment registries, a ZK ballot inbox, tally contract (`Tally.sol` implementing `ITallyVerifier`), passkey account abstraction with a gasless paymaster, and L1 rollup settlement for ZK-Voting L2.

There is no token. There are no voter fees. The leaf in the Merkle tree is an **identity commitment**, never a wallet address. `msg.sender` on `submitVote` is the relayer. A nullifier is accepted once; a second ballot reverts `NullifierUsed`. Double voting is impossible. `acceptedBallots` counts unique voters.

## Layout

- `src/ElectionFactory.sol` — unlimited elections, start + cutoff, `maxParticipants == 0` unlimited roll
- `src/VoterRegistry.sol` / `PersonRegistry.sol` / `DisqualificationRegistry.sol` / `BallotInbox.sol` / `Tally.sol` (`ITallyVerifier`)
- `src/account/` — passkey AA + `ZkVotingPaymaster`
- `src/l2/` — `RollupSettlement`, mailbox, L1 tally mirror
- `src/zk/` — `MockVerifier` (tests), `TallyPublicInputs` (versioned tally instance), structural `VoteVerifier`, `Groth16VerifierAdapter`
- `src/hasher/` — `KeccakHasher` (unit tests), `PoseidonHasher` (vote circuit), legacy `StandInHasher`, `HashScheme` ids
- `test/` — unit (`Tally.t.sol` covers SUM_ONLY vs OPENS_BALLOTS), fuzz (`test/fuzz`), invariant (`test/invariant`)
- `script/` — `DeployLocal`, `DeployL1`, `DeployL2`, `CreateElection`, `CertifyL1` (tally hash → `L1TallyMirror`; `certify_l1.sh` no-ops if L1 env unset)

## Test

```bash
forge test --via-ir
```

Unit tests use `MockVerifier`. `UntrustedGroth16Test` verifies a real untrusted Vote(4) proof (not accept-all). Non-mock deploy:

```bash
ZK_VOTING_PROVING_PATH=1 forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
```

## Gas economics

Live gas price and ETH/USD ($10,000 when no price feed answers), compiled bytecode versus today's EIP-170 / EIP-3860 caps and the Glamsterdam EIP-7954 caps (65,536 and 131,072 bytes), one-time L1 deploy gas, and poll-versus-vote cost across ballot counts and open hours:

```bash
forge build
L1_RPC=<your Ethereum JSON-RPC> ../voting_node/scripts/get-gas-economics.sh --measure
```

`./script/get-gas-economics.sh` forwards to that script. Options, environment variables, and sample output: [`../voting_node/scripts/README.md`](../voting_node/scripts/README.md).

Solidity 0.8.24. License AGPL-3.0-or-later. See `/NOT_FOR_PROFIT.md`.

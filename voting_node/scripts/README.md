# scripts/

Host-side helpers for local chains, contract deploys, and gas economics.
**NOT FOR PROFIT** — civic public good, not a commercial product.

Nothing here names a node, a host, or a key. Every RPC URL, chain id, price
source, and signer comes from a flag, the environment, or the repository `.env`
(read as plain `KEY=VALUE`, never executed). The environment and flags win
over `.env`. RPC URLs are printed as `scheme://host[:port]/…`, so a key in the
path or query string is never echoed.

| Script | What it does |
| --- | --- |
| [`start-anvil.sh`](./start-anvil.sh) | Start (or stop) a local Anvil chain and print its RPC URL |
| [`deploy.sh`](./deploy.sh) | Run `DeployLocal`, `DeployL2`, or `DeployL1`, guard against a redeploy, write a record |
| [`get-gas-economics.sh`](./get-gas-economics.sh) | Gas price, ETH/USD, bytecode sizes vs EIP-170/3860, deploy gas, per-call and per-election gas |
| [`migrations-verify.sh`](./migrations-verify.sh) | Production-image boot check (unrelated to the above) |

## Prerequisites

- Foundry (`forge`, `cast`, `anvil`):

  ```bash
  curl -L https://foundry.paradigm.xyz | bash
  foundryup
  ```

  See the [Foundry book](https://book.getfoundry.sh/getting-started/installation).
  The scripts add `~/.foundry/bin` to `PATH` if it is missing.
- `bash`, `curl`, `python3`. `jq` is optional.
- A build: `(cd smart-contracts && forge build)`. The first `via_ir` build takes a few minutes.

## Quick start (everything local)

```bash
./scripts/start-anvil.sh --background
./scripts/deploy.sh --target local
L1_RPC=<your Ethereum JSON-RPC> ./scripts/get-gas-economics.sh --measure --l2-rpc http://127.0.0.1:8545
./scripts/start-anvil.sh --stop
```

## start-anvil.sh

```bash
./scripts/start-anvil.sh                     # foreground, Ctrl-C to stop
./scripts/start-anvil.sh --background        # prints the RPC URL on stdout
./scripts/start-anvil.sh --fork-url "$L1_RPC" --chain-id 31337
./scripts/start-anvil.sh --stop
```

| Variable | Flag | Default |
| --- | --- | --- |
| `ANVIL_HOST` | `--host` | `127.0.0.1` (a non-loopback bind prints a warning) |
| `ANVIL_PORT` | `--port` | `8545` |
| `ANVIL_CHAIN_ID` | `--chain-id` | `31337` (the only chain where `DeployLocal` allows `MockVerifier` by default) |
| `ANVIL_BLOCK_TIME` | `--block-time` | empty = mine on each transaction |
| `ANVIL_FORK_URL` | `--fork-url` | empty = fresh chain |
| `ANVIL_FORK_BLOCK` | `--fork-block` | latest |
| `ANVIL_ACCOUNTS` / `ANVIL_BALANCE` | | `10` / `10000` ETH |
| `ANVIL_STATE` | `--state` | empty = state is lost on stop |
| `ANVIL_LOG` | | `$TMPDIR/zk-voting-anvil.log` (pid file next to it) |
| `ANVIL_EXTRA_ARGS` | | extra `anvil` arguments |

It refuses to start when something already answers JSON-RPC on the port. The
dev accounts are Anvil's own public test accounts; the script prints no other
keys. Never fund them on a real network.

## deploy.sh

```bash
./scripts/deploy.sh --target local                         # Anvil; unlocked dev account, no key needed
./scripts/deploy.sh --target local --dry-run               # simulate only
DEPLOY_RPC_URL=<L2 EVM RPC> DEPLOYER_ACCOUNT=deployer ./scripts/deploy.sh --target l2
L2_FACTORY=0x... BATCH_VERIFIER=0x... ./scripts/deploy.sh --target l1 --account deployer --dry-run
```

| Variable | Flag | Meaning |
| --- | --- | --- |
| `DEPLOY_TARGET` | `--target` | `local` (DeployLocal, default), `l2` (DeployL2), `l1` (DeployL1) |
| `DEPLOY_RPC_URL` | `--rpc-url` | RPC. Defaults: local `http://127.0.0.1:$ANVIL_PORT`, l1 `$L1_RPC` (or `$ETH_RPC_URL`). l2 has no default |
| `DEPLOYER_ACCOUNT` | `--account` | Foundry keystore name (`cast wallet import NAME --interactive`). Preferred |
| `DEPLOYER_ADDRESS` | `--sender` | Sender for a keystore or unlocked account |
| `DEPLOYER_PRIVATE_KEY` | | Raw key (env or `.env`, never a flag). Not printed |
| `DEPLOYMENTS_FILE` | `--record` | Record path, default `deployments/<chainId>.json` (gitignored) |
| `FORCE_REDEPLOY=1` | `--force` | Deploy even though addresses or a record exist |
| | `--dry-run` | Simulate; no broadcast, no record |
| | `--yes` | Required to broadcast to chain id 1 |

Rules:

- **Signer.** `--account`, then `DEPLOYER_PRIVATE_KEY`, then (Anvil only) the node's first unlocked dev account. On any other chain with no signer it stops.
- **Deploy once.** For `l1` and `l2` it refuses when any of `SETTLEMENT_ADDRESS`, `VERIFIER_ADDRESS`, `L1_TALLY_MIRROR_ADDRESS`, `L1_SETTLEMENT_ADDRESS`, `ELECTION_FACTORY_ADDRESS`, `BALLOT_INBOX_ADDRESS` is set, or the record says `"deployed": true`, unless `--force`. For `local` those pins are hidden from the forge run (a local Anvil is disposable), and a record only blocks when its factory still has code on the node.
- **Output.** It parses the `NAME=0x…` lines the forge scripts log, writes the record (addresses, deployer, time, and gas used per transaction from the broadcast receipts), and prints the `KEY=0x…` lines to put in `.env`.
- **Dev and proving flags.** Set `ZK_VOTING_ALLOW_MOCK_VERIFIER`, `ZK_VOTING_USE_MOCK_VERIFIER`, `ZK_VOTING_PROVING_PATH`, `ZK_VOTING_HASH_SCHEME`, `ZK_VOTING_VOTE_VERIFIER`, `ZK_VOTING_TALLY_VERIFIER`, `ZK_VOTING_SETTLEMENT_MOCK_MODE`. Each one is also passed to forge under the older flag prefix the Solidity scripts read today; that bridge goes away once they read `ZK_VOTING_*`.
- `l1` also needs `L2_FACTORY` (or `ELECTION_FACTORY_ADDRESS`) and `BATCH_VERIFIER`, as `DeployL1.s.sol` documents.
- Anything after `--` goes to `forge script` (for example `-- --verify`).

## get-gas-economics.sh

```bash
L1_RPC=<node> ./scripts/get-gas-economics.sh                 # sizes, deploy gas, live prices
L1_RPC=<node> ./scripts/get-gas-economics.sh --measure       # + forge gas report, per-election model
./scripts/get-gas-economics.sh --gas-gwei 5 --eth-usd 2500 --measure --voters 50000 --batches 20
./scripts/get-gas-economics.sh --offline                     # no network
```

| Variable | Flag | Default |
| --- | --- | --- |
| `L1_RPC` (or `ETH_RPC_URL`) | `--l1-rpc` | **required** unless `GAS_GWEI` or `--offline`; read from `.env` if present |
| `GAS_GWEI` | `--gas-gwei` | from `eth_gasPrice` |
| `GAS_L2_RPC` | `--l2-rpc` | none; L2 rows then use the L1 price |
| `GAS_L2_GWEI` | `--l2-gas-gwei` | from `eth_gasPrice` on `GAS_L2_RPC` |
| `L1_CHAIN_ID` | | if set, a mismatch with the node prints a warning |
| `ETH_USD` | `--eth-usd` | fetched; if the feed does not answer, **10000**. `--no-price` skips the fetch and uses 10000 |
| `PRICE_API_URL` / `PRICE_JSON_PATH` | | CoinGecko `simple/price` / `ethereum.usd` |
| `PRICE_FALLBACK_URL` / `PRICE_FALLBACK_JSON_PATH` | | Coinbase spot / `data.amount` |
| `GAS_MATCH_CONTRACT` | `--match-contract` | all unit and integration tests (fuzz and invariant skipped) |
| | `--ops-filter RE` | also list every measured function matching `RE` |
| `VOTERS` | `--voters` | `1000` unique voters in the highlighted run |
| `BALLOTS` | `--ballots` | same as voters. Higher means re-votes |
| `HOURS` | `--hours` | `12` open hours. L1 batches default to hours + 2 (hourly, final, supplementary) |
| `BATCHES` | `--batches` | overrides that L1 batch count for the highlighted run |
| `GROTH16_EXTRA_GAS` | `--groth16-gas` | `250000` once per L1 settlement (`0` hides it). Not per ballot |
| `DEPLOYMENTS_FILE` | `--record` | `deployments/<chainId>.json` for the L2, then L1, chain |
| `OUT_DIR` | `--out-dir` | `smart-contracts/out`; `--build` runs `forge build` first |
| `RPC_TIMEOUT` / `RPC_CONNECT_TIMEOUT` | | `15` / `5` seconds |
| `ENV_FILE` | | `.env` at the repository root |

What it reports:

1. L1 gas price and base fee from the node, an optional L2 gas price, and ETH/USD.
2. Every concrete contract compiled from `smart-contracts/src`, found from `out/` (so renames need no edit here): runtime and initcode size against today's EIP-170 / EIP-3860 caps and the Glamsterdam EIP-7954 caps (65,536 B runtime, 131,072 B initcode). `PRE` exceeds today's cap and fits Glamsterdam. `OVER` exceeds Glamsterdam. `TIGHT` is 90 % or more of the Glamsterdam cap. The L1 sum is a one-time shared deploy, not a per-election cost.
3. Deploy gas per contract: measured from a `deploy.sh` record when one exists, otherwise a size-based floor marked `~`.
4. The L1 bill only. The civic L2 is the operator's VPS, so its gas is $0, and a poll and a vote post the same Ethereum transactions. One-time: deploy `RollupSettlement`, `L1TallyMirror`, and `ZkVotingMailbox` once. During an election: one `submitBatch` per open hour, plus the final batch, plus one supplementary batch, plus one certification. Ballot count does not change that count. A second figure shows the prover posting every 4 L2 blocks while a block is sealed every 2 seconds. Tests use `MockVerifier`; `GROTH16_EXTRA_GAS` is added once per settlement. Without a live gas price, dollars use 10 gwei at the ETH price above.

If a source fails it says so and keeps going: a missing price feed uses $10,000;
an unreachable node prices the scenarios at 1 / 10 / 30 gwei. Exit status: `0` ok, `1` a
contract exceeds the Glamsterdam cap or there are no artifacts, `2` bad arguments.
`PRE` does not fail.
`smart-contracts/script/get-gas-economics.sh` forwards here.

## Sample run

Anvil from `start-anvil.sh`, `deploy.sh --target local`, then the gas script
with a public mainnet RPC as `L1_RPC` and the Anvil as the L2 (2026-10-24).
The sample predates the Glamsterdam size columns and the poll-versus-vote scenarios.

```text
$ ./scripts/start-anvil.sh --background
  RPC URL:   http://127.0.0.1:8545
  Chain id:  31337
  ...

$ ./scripts/deploy.sh --target local
zk-voting deploy
  target:  local (DeployLocal.s.sol)
  rpc:     http://127.0.0.1:8545 (chain 31337, anvil/v1.8.6)
  signer:  Anvil unlocked dev account 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266
  mode:    broadcast
  record:  deployments/31337.json
...
Deployed addresses
  ACCOUNT_FACTORY_ADDRESS            0x9A676e781A523b5d0C0e43731313A708CB607508
  BALLOT_INBOX_ADDRESS               0x8A791620dd6260079BF849Dc5567aDC3F2FdC318
  DISQUALIFICATION_REGISTRY_ADDRESS  0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6
  ELECTION_ADDRESS                   0xB1eDe3F5AC8654124Cb5124aDf0Fd3885CbDD1F7
  ELECTION_FACTORY_ADDRESS           0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9
  ENTRY_POINT_ADDRESS                0x0DCd1Bf9A1b36cE34237eEaFef220932846BCD82
  HASHER_ADDRESS                     0x5FbDB2315678afecb367f032d93F642f64180aa3
  IMPLEMENTATION_ADDRESS             0xd8058efe0198ae9dD7D563e1b4938Dcbc86A1F81
  JURISDICTION_REGISTRY_ADDRESS      0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9
  L1_SETTLEMENT_ADDRESS              0x9A9f2CCfdE556A7E9Ff0848998Aa4a0CFD8863AE
  L1_TALLY_MIRROR_ADDRESS            0x3Aa5ebB10DC797CAC828524e59A333d0A371443c
  MAILBOX_ADDRESS                    0x68B1D87F95878fE05B998F19b66F4baba5De1aed
  PAYMASTER_ADDRESS                  0x0B306BF915C4d645ff596e518fAf3F9669b97016
  SETTLEMENT_ADDRESS                 0x9A9f2CCfdE556A7E9Ff0848998Aa4a0CFD8863AE
  TALLY_ADDRESS                      0x610178dA211FEF7D417bC0e6FeD39F05609AD788
  VERIFIER_ADDRESS                   0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
  VOTER_REGISTRY_ADDRESS             0xa513E6E4b8f2a923D98304ec87F64353C4D5C853
  ELECTION_ID                        1
  PROVING_PATH                       0
  VERIFIER_KIND                      MockVerifier

Gas used: 17,132,393 over 24 transactions

Record written: deployments/31337.json

Set these in .env (or your secret store) for the app and the next deploy step:
ELECTION_FACTORY_ADDRESS=0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9
BALLOT_INBOX_ADDRESS=0x8A791620dd6260079BF849Dc5567aDC3F2FdC318
VERIFIER_ADDRESS=0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
SETTLEMENT_ADDRESS=0x9A9f2CCfdE556A7E9Ff0848998Aa4a0CFD8863AE
L1_SETTLEMENT_ADDRESS=0x9A9f2CCfdE556A7E9Ff0848998Aa4a0CFD8863AE
L1_TALLY_MIRROR_ADDRESS=0x3Aa5ebB10DC797CAC828524e59A333d0A371443c

$ ./scripts/get-gas-economics.sh --measure --l2-rpc http://127.0.0.1:8545
zk-voting gas economics
=======================
L1 node:     https://ethereum-rpc.publicnode.com (chain 1)
L1 gas:      0.060 gwei (base fee 0.060 gwei)  [eth_gasPrice]
L2 node:     http://127.0.0.1:8545 (chain 31337)
L2 gas:      1.048 gwei  [eth_gasPrice]
ETH/USD:     $2,367.32  [https://api.coingecko.com/…]
Compiler:    optimizer=on runs=200 viaIR=on evm=cancun
Deploy gas:  measured from deployments/31337.json (chain 31337, local)

Bytecode size vs EIP-170 (runtime 24,576 B) and EIP-3860 (initcode 49,152 B)
----------------------------------------------------------------------------
contract                   layer  runtime B   %170    init B  %3860    deploy gas     L1 ETH     L1 USD  flag
L1TallyMirror              L1         5,037  20.5%     5,264  10.7%     1,213,117   0.000073      $0.17  
RollupSettlement           L1         2,549  10.4%     2,913   5.9%       700,557   0.000042      $0.10  
ZkVotingMailbox            L1         2,237   9.1%     2,423   4.9%       561,365   0.000034      $0.08  
BallotInbox                L2         4,622  18.8%     4,800   9.8%     1,054,266   0.000063      $0.15  
DisqualificationRegistry   L2         5,622  22.9%     5,903  12.0%     1,270,707   0.000076      $0.18  
Election                   L2         4,056  16.5%     4,096   8.3%      ~929,736   0.000056      $0.13  
ElectionFactory            L2         7,802  31.7%    16,955  34.5%     3,856,490   0.000232      $0.55  
ExternalPartyRegistry      L2         4,459  18.1%     4,499   9.2%    ~1,016,784   0.000061      $0.14  
Groth16VerifierAdapter     L2           954   3.9%     1,166   2.4%      ~262,456   0.000016      $0.04  
JurisdictionRegistry       L2         3,085  12.6%     3,301   6.7%       768,351   0.000046      $0.11  
KeccakHasher               L2           250   1.0%       276   0.6%       107,491   0.000006      $0.02  
MockVerifier               L2         4,885  19.9%     4,985  10.1%     1,129,460   0.000068      $0.16  
PasskeyAccount             L2         3,347  13.6%     3,637   7.4%      ~780,592   0.000047      $0.11  
PasskeyAccountFactory      L2         5,293  21.5%     5,475  11.1%     1,194,742   0.000072      $0.17  
PersonRegistry             L2         1,585   6.4%     1,890   3.8%      ~400,240   0.000024      $0.06  
PoseidonHasher             L2         8,765  35.7%     8,792  17.9%    ~1,946,672   0.000117      $0.28  
StandInHasher              L2           237   1.0%       263   0.5%      ~104,608   0.000006      $0.01  
Tally                      L2         5,279  21.5%     5,450  11.1%     1,195,926   0.000072      $0.17  
VoteVerifier               L2         2,475  10.1%     2,861   5.8%      ~593,776   0.000036      $0.08  
VoterRegistry              L2         8,102  33.0%     8,411  17.1%     1,806,063   0.000108      $0.26  
ZkVotingEntryPoint         L2         2,620  10.7%     2,647   5.4%       619,517   0.000037      $0.09  
ZkVotingPaymaster          L2         1,900   7.7%     2,148   4.4%       466,111   0.000028      $0.07  
(~ = size-based floor, not measured; L1 cost = gas x L1 gas price)
Libraries (inlined, no deploy line): Clones, DisqualificationSet, ElectionIdentity, ElectionState, EligibleSet, FrontierTree, HashScheme, IdentityCommitment, IncrementalMerkleTree, PoseidonT3, ReasonCodes, Roles, TallyPublicInputs, TallyScheme, WebAuthn
Closest to EIP-170: PoseidonHasher 35.7%, VoterRegistry 33.0%, ElectionFactory 31.7%
Sum of L1 rows: 2,475,039 gas = 0.000149 ETH $0.35 at L1 gas price
Sum of L2 rows: 19,503,988 gas = 0.001171 ETH $2.77 at L1 gas price (includes alternatives, e.g. both verifiers and hashers)
Recorded DeployLocal.s.sol run: 17,132,393 gas over 24 txs = 0.001028 ETH $2.43 at L1 gas price

Per-call gas (forge test --gas-report, median; tests use MockVerifier)
----------------------------------------------------------------------
layer contract.function                                median        max  calls        ETH        USD  when
L2    JurisdictionRegistry.createJurisdiction         116,891    116,891    338   0.000122      $0.29  once per jurisdiction
L2    ElectionFactory.createElection                  659,591    719,351    253   0.000691      $1.64  once per election
L2    PasskeyAccountFactory.createAccount             743,603    743,603      3   0.000779      $1.84  once per voter account
L2    VoterRegistry.register                          395,123  1,641,042    682   0.000414      $0.98  per voter
L2    BallotInbox.submitVote                          208,612    395,145    132   0.000219      $0.52  per ballot
L2    BallotInbox.submitVoteWithClearance              71,912    282,835      6   0.000075      $0.18  per ballot (clearance path)
L2    Tally.submitTally                               117,870    163,499     20   0.000123      $0.29  once per election
L2    Tally.submitOpenedTally                          83,330    254,480      6   0.000087      $0.21  once per election (opened)
L1    RollupSettlement.submitBatch                    154,063    172,847     14   0.000009      $0.02  per settled batch
L1    L1TallyMirror.postResult                        180,018    220,202     13   0.000011      $0.03  once per election
L1    L1TallyMirror.postCertifiedResult               207,477    308,141     15   0.000012      $0.03  once per election (certified)
L1 rows priced at L1 gas price; L2 rows at L2 gas price.

Per-election model: 1,000 voters, 1 L1 batch(es)
------------------------------------------------
L2 election stack:
  createElection                    659,591 gas
  register x voters             395,123,000 gas
  submitVote x voters           208,612,000 gas
  submitTally                       117,870 gas
  total                         604,512,461 gas = 0.633346 ETH $1,499.33
L1 settlement:
  submitBatch x batches             154,063 gas
  postResult                        180,018 gas
  total                             334,081 gas = 0.000020 ETH $0.05
With a real Groth16 verify (+250,000 gas per ballot, GROTH16_EXTRA_GAS): L2 total 854,512,461 gas = 0.895270 ETH $2,119.39
L2 gas per voter (register + vote, amortized): 604,512 = $1.50
Voters pay nothing. These figures size the operator's gas budget.
```

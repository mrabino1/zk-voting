#!/usr/bin/env bash
# zk-voting gas economics.
#
# Ported from nuursha-nft-erc20-whitelabel scripts/get-gas-economics.sh and
# adapted to ZK-Voting deployables under smart-contracts/src:
#   1. ETH/USD from CoinGecko (Coinbase spot if CoinGecko is down)
#   2. Gas gwei from the local node http://edps4:8545, then fallbacks
#   3. Compiled bytecode in out/ vs EIP-170 (24576) and EIP-3860 (49152)
#   4. A USD view of those sizes, plus documented L1 ranges
#
# Nuursha NFT mint, claim, and ERC-20 gas tables are not used. This repo has
# no token and no voter fee. Usage ranges are the order-of-magnitude scenarios
# in voting_cost_estimate.md, not Foundry measurements. Pass --gas-report for
# a forge snapshot of the key calls.
#
# Usage (from smart-contracts/, after `forge build --via-ir`):
#   ./script/get-gas-economics.sh
#   ./script/get-gas-economics.sh --gas-report
#
# Overrides: OUT_DIR, ETH_USD, GAS_GWEI, ETH_RPC_URL.
# Exit 0 when every listed contract is within both size caps.
# Exit 1 when any contract is over EIP-170 or EIP-3860, or an artifact is missing.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SC_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$SC_DIR/.." && pwd)"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/smart-contracts/out}"

EIP170=24576
EIP3860=49152

# Concrete contracts only. Interfaces, libraries, abstracts, and tests are omitted.
# PoseidonT3 is internal and is counted inside PoseidonHasher.
CONTRACTS=(
  Election
  ElectionFactory
  BallotInbox
  VoterRegistry
  PersonRegistry
  DisqualificationRegistry
  JurisdictionRegistry
  KeccakHasher
  PoseidonHasher
  StandInHasher
  MockVerifier
  VoteVerifier
  Groth16VerifierAdapter
  Tally
  ZkVotingPaymaster
  PasskeyAccountFactory
  PasskeyAccount
  ZkVotingEntryPoint
  RollupSettlement
  ZkVotingMailbox
  L1TallyMirror
)

WITH_GAS_REPORT=0
usage() {
  cat <<EOF
Usage: $(basename "$0") [--gas-report]

Reads Foundry artifacts in \$OUT_DIR (default: smart-contracts/out).
Build first: forge build --via-ir

  --gas-report   append forge test --gas-report for key ZK-Voting calls
EOF
}

for arg in "$@"; do
  case "$arg" in
    --gas-report) WITH_GAS_REPORT=1 ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "unknown argument: $arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

ETH_USD_SOURCE=""
GAS_SOURCE=""

try_curl() {
  # try_curl URL [curl args...]  — prints body or returns non-zero
  local url="$1"
  shift
  curl -fsS --connect-timeout 3 --max-time 12 -A "zk-voting-gas-economics/1" "$@" "$url"
}

fetch_eth_usd() {
  if [[ -n "${ETH_USD:-}" ]]; then
    ETH_USD_SOURCE="env ETH_USD"
    return 0
  fi
  local body px
  if body="$(try_curl "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd" 2>/dev/null)"; then
    if px="$(printf '%s' "$body" | jq -er '.ethereum.usd' 2>/dev/null)"; then
      ETH_USD="$px"
      ETH_USD_SOURCE="CoinGecko"
      return 0
    fi
  fi
  if body="$(try_curl "https://api.coinbase.com/v2/prices/ETH-USD/spot" 2>/dev/null)"; then
    if px="$(printf '%s' "$body" | jq -er '.data.amount' 2>/dev/null)"; then
      ETH_USD="$px"
      ETH_USD_SOURCE="Coinbase spot"
      return 0
    fi
  fi
  ETH_USD=""
  ETH_USD_SOURCE="unavailable"
  return 0
}

# Print decimal gwei from an eth_gasPrice hex result.
wei_hex_to_gwei() {
  python3 -c 'import sys; print(f"{int(sys.argv[1], 16) / 1e9:.6f}")' "$1"
}

try_rpc_gas() {
  local url="$1"
  local body wei
  body="$(try_curl "$url" -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_gasPrice","params":[]}' 2>/dev/null)" || return 1
  wei="$(printf '%s' "$body" | jq -er '.result | select(type=="string" and startswith("0x") and length>2)' 2>/dev/null)" || return 1
  GAS_GWEI="$(wei_hex_to_gwei "$wei")"
  GAS_SOURCE="$url eth_gasPrice"
}

try_etherscan_gas() {
  local url="https://api.etherscan.io/api?module=gastracker&action=gasoracle"
  if [[ -n "${ETHERSCAN_API_KEY:-}" ]]; then
    url="${url}&apikey=${ETHERSCAN_API_KEY}"
  fi
  local body px
  body="$(try_curl "$url" 2>/dev/null)" || return 1
  px="$(printf '%s' "$body" | jq -er '.result.ProposeGasPrice | select(. != null and . != "")' 2>/dev/null)" || return 1
  GAS_GWEI="$px"
  GAS_SOURCE="Etherscan gas oracle (ProposeGasPrice)"
}

try_blockscout_gas() {
  local body px
  body="$(try_curl "https://eth.blockscout.com/api/v2/stats" 2>/dev/null)" || return 1
  # average is a wei string on current Blockscout; fall back to a gwei number.
  px="$(printf '%s' "$body" | jq -er '.gas_prices.average // .gas_price // empty' 2>/dev/null)" || return 1
  [[ -n "$px" && "$px" != "null" ]] || return 1
  if [[ "$px" == 0x* ]]; then
    GAS_GWEI="$(wei_hex_to_gwei "$px")"
  elif python3 -c 'import sys; v=float(sys.argv[1]); raise SystemExit(0 if v>1000 else 1)' "$px" 2>/dev/null; then
    GAS_GWEI="$(python3 -c 'import sys; print(f"{float(sys.argv[1]) / 1e9:.6f}")' "$px")"
  else
    GAS_GWEI="$(python3 -c 'import sys; print(f"{float(sys.argv[1]):.6f}")' "$px")"
  fi
  GAS_SOURCE="Blockscout eth stats"
}

fetch_gas_gwei() {
  if [[ -n "${GAS_GWEI:-}" ]]; then
    GAS_SOURCE="env GAS_GWEI"
    return 0
  fi
  local url
  local -a urls=("http://edps4:8545")
  if [[ -n "${ETH_RPC_URL:-}" ]]; then
    urls+=("$ETH_RPC_URL")
  fi
  urls+=(
    "http://127.0.0.1:8545"
    "https://ethereum-rpc.publicnode.com"
    "https://eth.llamarpc.com"
    "https://cloudflare-eth.com"
  )
  for url in "${urls[@]}"; do
    if try_rpc_gas "$url"; then
      return 0
    fi
  done
  if try_etherscan_gas; then
    return 0
  fi
  if try_blockscout_gas; then
    return 0
  fi
  GAS_GWEI=""
  GAS_SOURCE="unavailable"
  return 0
}

fetch_eth_usd
fetch_gas_gwei

export OUT_DIR EIP170 EIP3860 ETH_USD GAS_GWEI ETH_USD_SOURCE GAS_SOURCE
export CONTRACTS_CSV
CONTRACTS_CSV="$(IFS=,; echo "${CONTRACTS[*]}")"

set +e
python3 - <<'PY'
import json, os, sys

out_dir = os.environ["OUT_DIR"]
eip170 = int(os.environ["EIP170"])
eip3860 = int(os.environ["EIP3860"])
eth_raw = os.environ.get("ETH_USD", "")
gas_raw = os.environ.get("GAS_GWEI", "")
eth_src = os.environ.get("ETH_USD_SOURCE", "")
gas_src = os.environ.get("GAS_SOURCE", "")
names = [n for n in os.environ["CONTRACTS_CSV"].split(",") if n]

def parse_num(raw):
    if not raw:
        return None
    try:
        return float(raw)
    except ValueError:
        return None

eth = parse_num(eth_raw)
gwei = parse_num(gas_raw)

def byte_len(obj):
    if not isinstance(obj, str) or obj in ("", "0x"):
        return 0, False
    linked = "__$" in obj
    h = obj[2:] if obj.startswith("0x") else obj
    if len(h) % 2:
        h = h[:-1]
    return len(h) // 2, linked

def nonzero_and_zero(obj):
    h = obj[2:] if isinstance(obj, str) and obj.startswith("0x") else (obj or "")
    if len(h) % 2:
        h = h[:-1]
    nz = z = 0
    for i in range(0, len(h), 2):
        if h[i:i+2] == "00":
            z += 1
        else:
            nz += 1
    return nz, z

def usd(gas):
    if eth is None or gwei is None:
        return None
    return gas * gwei * 1e-9 * eth

def fmt_usd(v):
    if v is None:
        return "n/a"
    if v >= 100:
        return f"${v:,.0f}"
    if v >= 1:
        return f"${v:,.2f}"
    return f"${v:,.4f}"

print("ZK-Voting gas economics (zk-voting)")
print("Port of nuursha scripts/get-gas-economics.sh, adapted to ZK-Voting deployables.")
print(f"OUT_DIR: {out_dir}")
print()
print("Market")
if eth is None:
    print(f"  ETH/USD:  unavailable ({eth_src})")
else:
    print(f"  ETH/USD:  {eth:,.2f}  ({eth_src})")
if gwei is None:
    print(f"  Gas:      unavailable ({gas_src})")
else:
    print(f"  Gas:      {gwei:.4f} gwei  ({gas_src})")
print("  USD = gas * gwei * 1e-9 * ETH_USD")
print()
print("Bytecode vs EIP-170 (runtime <= 24576) and EIP-3860 (initcode <= 49152)")
print("  Runtime is deployedBytecode. Initcode is bytecode. Metadata is included.")
print("  Election is the EIP-1167 implementation. Clones are ~45 bytes and are not a separate artifact.")
print("  PoseidonT3 is an internal library; its constants sit inside PoseidonHasher.")
print()
header = f"  {'contract':<28} {'runtime':>8} {'%170':>7} {'init':>8} {'%3860':>7}  status"
print(header)
print("  " + "-" * (len(header) - 2))

over_170 = []
over_3860 = []
missing = []
rows = []

for name in names:
    path = os.path.join(out_dir, f"{name}.sol", f"{name}.json")
    if not os.path.isfile(path):
        missing.append(name)
        print(f"  {name:<28} {'—':>8} {'—':>7} {'—':>8} {'—':>7}  MISSING")
        continue
    with open(path, encoding="utf-8") as fh:
        art = json.load(fh)
    runtime_obj = (art.get("deployedBytecode") or {}).get("object") or ""
    init_obj = (art.get("bytecode") or {}).get("object") or ""
    runtime, run_unlinked = byte_len(runtime_obj)
    init, init_unlinked = byte_len(init_obj)
    flags = []
    if runtime > eip170:
        flags.append("OVER EIP-170")
        over_170.append(name)
    if init > eip3860:
        flags.append("OVER EIP-3860")
        over_3860.append(name)
    if run_unlinked or init_unlinked:
        flags.append("UNLINKED")
    if not flags:
        flags.append("ok")
    pct170 = 100.0 * runtime / eip170
    pct3860 = 100.0 * init / eip3860
    print(f"  {name:<28} {runtime:8d} {pct170:6.1f}% {init:8d} {pct3860:6.1f}%  {', '.join(flags)}")
    nz, z = nonzero_and_zero(init_obj)
    # Creation-tx schedule floor. Excludes constructor execution.
    # 21000 intrinsic + calldata (16/4) + 32000 CREATE + 2 gas per init word + 200 per runtime byte.
    words = (init + 31) // 32
    floor = 21000 + nz * 16 + z * 4 + 32000 + words * 2 + runtime * 200
    rows.append((name, runtime, init, floor))

print()
print(f"Size summary: {len(names)} contracts, {len(over_170)} over EIP-170, {len(over_3860)} over EIP-3860, {len(missing)} missing")
if over_170:
    print("OVER EIP-170: " + ", ".join(over_170))
else:
    print("OVER EIP-170: none")
if over_3860:
    print("OVER EIP-3860: " + ", ".join(over_3860))
else:
    print("OVER EIP-3860: none")
if missing:
    print("MISSING: " + ", ".join(missing))
print()
print("Deployment schedule floor (not a forge measurement)")
print("  gas = 21000 + calldata(16 per nonzero init byte, 4 per zero) + 32000 CREATE")
print("        + 2 gas per 32-byte init word (EIP-3860) + 200 gas per runtime byte.")
print("  Constructor execution (SSTORE and external calls) is not included.")
print()
print(f"  {'contract':<28} {'floor gas':>12} {'usd':>12}")
print("  " + "-" * 54)
for name, runtime, init, floor in rows:
    print(f"  {name:<28} {floor:12,d} {fmt_usd(usd(floor)):>12}")
print()
print("Usage (Nuursha NFT / claim / ERC-20 tables omitted)")
print("  ZK-Voting has no token and no voter fee. Voters do not pay L1 or L2 gas")
print("  on the civic path. The ranges below are order-of-magnitude scenarios from")
print("  voting_cost_estimate.md. This repo does not ship a measured submitBatch snapshot")
print("  in that document. Pass --gas-report for Foundry gas on the key calls.")
print()
estimates = [
    ("RollupSettlement.submitBatch mockMode", 50_000, 150_000, "SSTORE + event, no pairing"),
    ("RollupSettlement.submitBatch real Groth16", 230_000, 350_000, "industry BN254 verify + store; not measured here"),
    ("L1TallyMirror.postResult", 40_000, 100_000, "once per election"),
]
print(f"  {'op':<44} {'gas':>18} {'usd low':>12} {'usd high':>12}")
print("  " + "-" * 90)
for label, lo, hi, _note in estimates:
    print(f"  {label:<44} {lo:>8,d}–{hi:<8,d} {fmt_usd(usd(lo)):>12} {fmt_usd(usd(hi)):>12}")
print()
for label, lo, hi, note in estimates:
    print(f"  - {label}: {note}")
print()
print("Key calls a --gas-report snapshot covers:")
print("  BallotInbox.submitVote, ElectionFactory.createElection, VoterRegistry.register,")
print("  Tally.submitTally / submitOpenedTally, RollupSettlement.submitBatch,")
print("  L1TallyMirror.postResult, ZkVotingPaymaster.validateAndPay.")

status = 0
if over_170 or over_3860 or missing:
    status = 1
sys.exit(status)
PY
size_status=$?
set -e

if [[ "$WITH_GAS_REPORT" -eq 1 ]]; then
  echo
  echo "forge gas-report (key calls)"
  echo "  forge test --via-ir --gas-report on BallotInbox, ElectionFactory, ElectionLifecycle,"
  echo "  VoterRegistry, PersonRegistry, Tally, RollupSettlement, L1TallyMirror, Paymaster."
  echo "  Fuzz and invariant tests are not included."
  echo
  (
    cd "$SC_DIR"
    forge test --via-ir --gas-report --color never \
      --match-contract 'BallotInboxTest|ElectionFactoryTest|ElectionLifecycleTest|VoterRegistryTest|PersonRegistryTest|TallyTest|RollupSettlementTest|L1TallyMirrorTest|PaymasterTest'
  ) || size_status=$?
fi

exit "$size_status"

#!/usr/bin/env bash
# zk-voting gas economics: live gas price and ETH/USD, contract sizes vs the
# EIP-170 / EIP-3860 caps, deploy gas, and (with --measure) per-call gas from
# the Foundry test suite rolled up into a per-election cost.
# NOT FOR PROFIT — civic public good, not a commercial product.
#
# Nothing is hardcoded: the L1 node is L1_RPC (env, .env, or --l1-rpc), the
# price source is PRICE_API_URL, and every number can be overridden.
set -euo pipefail

# shellcheck source-path=SCRIPTDIR source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

usage() {
  cat <<USAGE
Usage: $(basename "$0") [options]

Gas price (one is required unless --offline):
  --l1-rpc URL         L1 JSON-RPC for eth_gasPrice          (L1_RPC, or ETH_RPC_URL)
  --gas-gwei N         fixed L1 gas price, skips the RPC     (GAS_GWEI)
  --l2-rpc URL         optional EVM RPC for the election stack (GAS_L2_RPC)
  --l2-gas-gwei N      fixed L2 gas price                    (GAS_L2_GWEI)
  --offline            no network: sizes and gas only, no prices

ETH/USD:
  --eth-usd N          fixed price, skips the API            (ETH_USD)
  --no-price           do not fetch a price
                       Source: PRICE_API_URL + PRICE_JSON_PATH (default CoinGecko
                       simple/price, ethereum.usd), then PRICE_FALLBACK_URL +
                       PRICE_FALLBACK_JSON_PATH (default Coinbase spot, data.amount)

Gas measurements:
  --measure            run forge test --gas-report and price the key calls
                       (alias: --gas-report)
  --match-contract RE  test contracts to run with --measure  (GAS_MATCH_CONTRACT)
  --ops-filter RE      also list every measured function matching RE
  --voters N           voters in the per-election model      (VOTERS, default 1000)
  --batches N          L1 batches per election               (BATCHES, default 1)
  --groth16-gas N      extra gas per ballot for a real Groth16 verify
                       (GROTH16_EXTRA_GAS, default 250000; 0 to hide)
  --record FILE        deployment record from scripts/deploy.sh for measured
                       deploy gas (DEPLOYMENTS_FILE; default
                       deployments/<chainId>.json for the L2, then L1, chain)
  --out-dir DIR        forge artifacts                       (OUT_DIR, default smart-contracts/out)
  --build              run forge build first
  -h, --help           this help

Exit status: 0 ok, 1 a contract is over a size cap or no artifacts, 2 usage.
USAGE
}

load_repo_env

L1_URL="${L1_RPC:-${ETH_RPC_URL:-}}"
L2_URL="${GAS_L2_RPC:-}"
GAS_GWEI="${GAS_GWEI:-}"
L2_GWEI="${GAS_L2_GWEI:-}"
ETH_USD="${ETH_USD:-}"
OFFLINE=0
NO_PRICE=0
MEASURE=0
BUILD=0
MATCH_CONTRACT="${GAS_MATCH_CONTRACT:-}"
OPS_FILTER=""
VOTERS="${VOTERS:-1000}"
BATCHES="${BATCHES:-1}"
GROTH16="${GROTH16_EXTRA_GAS:-250000}"
RECORD="${DEPLOYMENTS_FILE:-}"
OUT_DIR="${OUT_DIR:-$SC_DIR/out}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --l1-rpc | --rpc-url) L1_URL="${2:?$1 needs a value}"; shift 2 ;;
    --gas-gwei) GAS_GWEI="${2:?$1 needs a value}"; shift 2 ;;
    --l2-rpc) L2_URL="${2:?$1 needs a value}"; shift 2 ;;
    --l2-gas-gwei) L2_GWEI="${2:?$1 needs a value}"; shift 2 ;;
    --offline) OFFLINE=1; shift ;;
    --eth-usd) ETH_USD="${2:?$1 needs a value}"; shift 2 ;;
    --no-price) NO_PRICE=1; shift ;;
    --measure | --gas-report) MEASURE=1; shift ;;
    --match-contract) MATCH_CONTRACT="${2:?$1 needs a value}"; shift 2 ;;
    --ops-filter) OPS_FILTER="${2:?$1 needs a value}"; shift 2 ;;
    --voters) VOTERS="${2:?$1 needs a value}"; shift 2 ;;
    --batches) BATCHES="${2:?$1 needs a value}"; shift 2 ;;
    --groth16-gas) GROTH16="${2:?$1 needs a value}"; shift 2 ;;
    --record) RECORD="${2:?$1 needs a value}"; shift 2 ;;
    --out-dir) OUT_DIR="${2:?$1 needs a value}"; shift 2 ;;
    --build) BUILD=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; printf 'error: unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

for n in VOTERS BATCHES GROTH16; do
  [[ "${!n}" =~ ^[0-9]+$ ]] || { printf 'error: %s must be a whole number (got %s)\n' "$n" "${!n}" >&2; exit 2; }
done

need python3 "It renders the report."
need curl

if [[ "$OFFLINE" -eq 0 && -z "$GAS_GWEI" && -z "$L1_URL" ]]; then
  die "no L1 gas source. Set L1_RPC (env or .env) to your Ethereum node, pass --l1-rpc URL, set GAS_GWEI / --gas-gwei, or use --offline."
fi
if [[ "$OFFLINE" -eq 1 ]]; then
  NO_PRICE=1
  L1_URL=""
  L2_URL=""
fi

# wei (hex) -> gwei, 6 decimals
hex_wei_to_gwei() {
  python3 -c 'import sys; print(f"{int(sys.argv[1], 16) / 1e9:.6f}")' "$1"
}

chain_id_of() {
  local hex
  hex="$(rpc_call "$1" eth_chainId)" || return 1
  hex_to_dec "$hex"
}

L1_DESC="none"
L1_GAS_SRC=""
L1_BASE=""
L1_CHAIN=""
if [[ -n "$GAS_GWEI" ]]; then
  L1_GAS_SRC="GAS_GWEI override"
  [[ -n "$L1_URL" ]] && L1_DESC="$(redact_url "$L1_URL") (not queried: GAS_GWEI set)"
elif [[ -n "$L1_URL" ]]; then
  L1_DESC="$(redact_url "$L1_URL")"
  if L1_CHAIN="$(chain_id_of "$L1_URL")"; then
    L1_DESC="$L1_DESC (chain $L1_CHAIN)"
    if [[ -n "${L1_CHAIN_ID:-}" && "$L1_CHAIN_ID" != "$L1_CHAIN" ]]; then
      warn "L1_CHAIN_ID=$L1_CHAIN_ID but the L1 node reports chain $L1_CHAIN"
    fi
    hex="$(rpc_call "$L1_URL" eth_gasPrice)" && GAS_GWEI="$(hex_wei_to_gwei "$hex")" && L1_GAS_SRC="eth_gasPrice"
    block="$(rpc_call "$L1_URL" eth_getBlockByNumber '["latest",false]' || true)"
    base="$(printf '%s' "$block" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("baseFeePerGas") or "")
except Exception: print("")' 2>/dev/null || true)"
    [[ -n "$base" ]] && L1_BASE="$(hex_wei_to_gwei "$base")"
  fi
  if [[ -z "$GAS_GWEI" ]]; then
    warn "L1 node $(redact_url "$L1_URL") did not answer eth_gasPrice; costs will show n/a (set GAS_GWEI to price them)"
  fi
else
  L1_DESC="none (--offline)"
fi

L2_DESC=""
L2_GAS_SRC=""
L2_CHAIN=""
if [[ -n "$L2_GWEI" ]]; then
  L2_GAS_SRC="GAS_L2_GWEI override"
elif [[ -n "$L2_URL" ]]; then
  L2_DESC="$(redact_url "$L2_URL")"
  if L2_CHAIN="$(chain_id_of "$L2_URL")"; then
    L2_DESC="$L2_DESC (chain $L2_CHAIN)"
    hex="$(rpc_call "$L2_URL" eth_gasPrice)" && L2_GWEI="$(hex_wei_to_gwei "$hex")" && L2_GAS_SRC="eth_gasPrice"
  fi
  [[ -n "$L2_GWEI" ]] || warn "L2 node $L2_DESC did not answer eth_gasPrice; L2 rows use the L1 price"
fi

# --- ETH/USD -------------------------------------------------------------------
json_path() { # json_path a.b.c < json
  python3 -c 'import json,sys
v=json.load(sys.stdin)
for k in sys.argv[1].split("."):
    v=v[int(k)] if isinstance(v,list) else v[k]
print(float(v))' "$1" 2>/dev/null
}

fetch_price() { # URL PATH
  local body
  body="$(curl -fsS --connect-timeout 5 --max-time 10 -H 'accept: application/json' "$1" 2>/dev/null)" || return 1
  printf '%s' "$body" | json_path "$2"
}

PRICE_SRC="none"
if [[ -n "$ETH_USD" ]]; then
  PRICE_SRC="ETH_USD override"
elif [[ "$NO_PRICE" -eq 0 ]]; then
  p_url="${PRICE_API_URL:-https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd}"
  p_path="${PRICE_JSON_PATH:-ethereum.usd}"
  f_url="${PRICE_FALLBACK_URL:-https://api.coinbase.com/v2/prices/ETH-USD/spot}"
  f_path="${PRICE_FALLBACK_JSON_PATH:-data.amount}"
  if ETH_USD="$(fetch_price "$p_url" "$p_path")"; then
    PRICE_SRC="$(redact_url "$p_url")"
  elif [[ -n "$f_url" ]] && ETH_USD="$(fetch_price "$f_url" "$f_path")"; then
    PRICE_SRC="$(redact_url "$f_url") (fallback)"
  else
    ETH_USD=""
    warn "no ETH/USD price from the price APIs; USD columns show n/a (set ETH_USD to fix one)"
  fi
fi

# --- artifacts -------------------------------------------------------------------
if [[ "$BUILD" -eq 1 ]]; then
  need forge "$FOUNDRY_HINT"
  info "forge build (via_ir; the first build takes a few minutes)..."
  (cd "$SC_DIR" && forge build >&2)
fi
if [[ ! -d "$OUT_DIR" ]]; then
  die "no forge artifacts at $OUT_DIR. Run: (cd smart-contracts && forge build), or pass --build."
fi

# --- deployment record ---------------------------------------------------------
RECORD_DESC=""
if [[ -z "$RECORD" ]]; then
  for c in "$L2_CHAIN" "$L1_CHAIN"; do
    if [[ -n "$c" && -f "$REPO_ROOT/deployments/$c.json" ]]; then
      RECORD="$REPO_ROOT/deployments/$c.json"
      break
    fi
  done
elif [[ ! -f "$RECORD" ]]; then
  warn "record $RECORD not found; deploy gas will be estimated"
fi
[[ -n "$RECORD" ]] && RECORD_DESC="${RECORD#"$REPO_ROOT"/}"

# --- forge gas report ----------------------------------------------------------
GAS_REPORT=""
cleanup() { [[ -n "$GAS_REPORT" ]] && rm -f "$GAS_REPORT"; return 0; }
trap cleanup EXIT
if [[ "$MEASURE" -eq 1 ]]; then
  need forge "$FOUNDRY_HINT"
  GAS_REPORT="$(mktemp "${TMPDIR:-/tmp}/zk-voting-gas.XXXXXX")"
  args=(test --gas-report --json --no-match-path 'test/{fuzz,invariant}/**')
  [[ -n "$MATCH_CONTRACT" ]] && args+=(--match-contract "$MATCH_CONTRACT")
  info "forge ${args[*]}  (this can take a few minutes)..."
  if ! (cd "$SC_DIR" && forge "${args[@]}") >"$GAS_REPORT" 2>"$GAS_REPORT.err"; then
    warn "forge test failed; per-call gas may be partial. Last lines:"
    tail -n 15 "$GAS_REPORT.err" >&2 || true
  fi
  rm -f "$GAS_REPORT.err"
fi

GE_SC_DIR="$SC_DIR" GE_OUT_DIR="$OUT_DIR" \
  GE_L1_DESC="$L1_DESC" GE_L1_GWEI="$GAS_GWEI" GE_L1_GAS_SRC="$L1_GAS_SRC" GE_L1_BASEFEE_GWEI="$L1_BASE" \
  GE_L2_DESC="$L2_DESC" GE_L2_GWEI="$L2_GWEI" GE_L2_GAS_SRC="$L2_GAS_SRC" \
  GE_ETH_USD="$ETH_USD" GE_PRICE_SRC="$PRICE_SRC" \
  GE_RECORD="$RECORD" GE_RECORD_DESC="$RECORD_DESC" GE_GAS_REPORT="$GAS_REPORT" \
  GE_VOTERS="$VOTERS" GE_BATCHES="$BATCHES" GE_GROTH16_EXTRA_GAS="$GROTH16" GE_OPS_FILTER="$OPS_FILTER" \
  python3 -B "$(dirname "${BASH_SOURCE[0]}")/lib/gas_economics.py"

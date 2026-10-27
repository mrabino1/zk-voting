#!/usr/bin/env bash
# Start a local Anvil chain for development, deploy tests, and gas measurement.
# NOT FOR PROFIT — civic public good, not a commercial product.
#
# Every setting comes from a flag, the environment, or the repo .env:
#   ANVIL_HOST        bind address            (default 127.0.0.1)
#   ANVIL_PORT        RPC port                (default 8545)
#   ANVIL_CHAIN_ID    chain id                (default 31337; the deploy scripts
#                                              only allow MockVerifier on 31337)
#   ANVIL_BLOCK_TIME  seconds per block       (default unset = mine on each tx)
#   ANVIL_FORK_URL    fork this RPC           (default unset = fresh chain)
#   ANVIL_FORK_BLOCK  fork at this block      (optional, needs ANVIL_FORK_URL)
#   ANVIL_ACCOUNTS    dev accounts to fund    (default 10)
#   ANVIL_BALANCE     ETH per dev account     (default 10000)
#   ANVIL_STATE       file to load/save state (optional)
#   ANVIL_LOG         log file for --background (default $TMPDIR/zk-voting-anvil.log)
#   ANVIL_EXTRA_ARGS  extra raw anvil flags   (optional)
set -euo pipefail

# shellcheck source-path=SCRIPTDIR source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

usage() {
  cat <<USAGE
Usage: $(basename "$0") [options]

Start a local Anvil node. Flags override env, env overrides .env.

  --host ADDR          bind address            (ANVIL_HOST, default 127.0.0.1)
  --port N             RPC port                (ANVIL_PORT, default 8545)
  --chain-id N         chain id                (ANVIL_CHAIN_ID, default 31337)
  --block-time S       seconds per block       (ANVIL_BLOCK_TIME, default: per tx)
  --fork-url URL       fork a network          (ANVIL_FORK_URL)
  --fork-block N       fork block number       (ANVIL_FORK_BLOCK)
  --state FILE         load and save state     (ANVIL_STATE)
  --background         run detached; print the PID and log path
  --stop               stop a node started with --background
  -h, --help           this help

Anvil's dev accounts use its well-known public test mnemonic. They are for
local chains only. Never send real funds to them on any public network.
USAGE
}

load_repo_env

HOST="${ANVIL_HOST:-127.0.0.1}"
PORT="${ANVIL_PORT:-8545}"
CHAIN_ID="${ANVIL_CHAIN_ID:-31337}"
BLOCK_TIME="${ANVIL_BLOCK_TIME:-}"
FORK_URL="${ANVIL_FORK_URL:-}"
FORK_BLOCK="${ANVIL_FORK_BLOCK:-}"
ACCOUNTS="${ANVIL_ACCOUNTS:-10}"
BALANCE="${ANVIL_BALANCE:-10000}"
STATE="${ANVIL_STATE:-}"
LOG="${ANVIL_LOG:-${TMPDIR:-/tmp}/zk-voting-anvil.log}"
BACKGROUND=0
STOP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="${2:?--host needs a value}"; shift 2 ;;
    --port) PORT="${2:?--port needs a value}"; shift 2 ;;
    --chain-id) CHAIN_ID="${2:?--chain-id needs a value}"; shift 2 ;;
    --block-time) BLOCK_TIME="${2:?--block-time needs a value}"; shift 2 ;;
    --fork-url) FORK_URL="${2:?--fork-url needs a value}"; shift 2 ;;
    --fork-block) FORK_BLOCK="${2:?--fork-block needs a value}"; shift 2 ;;
    --state) STATE="${2:?--state needs a value}"; shift 2 ;;
    --background) BACKGROUND=1; shift ;;
    --stop) STOP=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
done

PID_FILE="${LOG%.log}.pid"

if [[ "$STOP" -eq 1 ]]; then
  if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    kill "$(cat "$PID_FILE")"
    rm -f "$PID_FILE"
    info "stopped anvil (pid file $PID_FILE)"
  else
    info "no running anvil from $PID_FILE"
  fi
  exit 0
fi

need anvil "$FOUNDRY_HINT"

[[ "$PORT" =~ ^[0-9]+$ ]] || die "ANVIL_PORT must be a number (got '$PORT')"
[[ "$CHAIN_ID" =~ ^[0-9]+$ ]] || die "ANVIL_CHAIN_ID must be a number (got '$CHAIN_ID')"
[[ -z "$BLOCK_TIME" || "$BLOCK_TIME" =~ ^[0-9]+$ ]] || die "ANVIL_BLOCK_TIME must be whole seconds"
[[ -z "$FORK_BLOCK" || -n "$FORK_URL" ]] || die "ANVIL_FORK_BLOCK needs ANVIL_FORK_URL"

CLIENT_HOST="$HOST"
[[ "$CLIENT_HOST" == "0.0.0.0" ]] && CLIENT_HOST="127.0.0.1"
RPC_URL="http://$CLIENT_HOST:$PORT"

if rpc_call "$RPC_URL" eth_chainId >/dev/null 2>&1; then
  die "something already answers JSON-RPC at $RPC_URL. Stop it, or pick another --port."
fi

args=(--host "$HOST" --port "$PORT" --chain-id "$CHAIN_ID" --accounts "$ACCOUNTS" --balance "$BALANCE")
[[ -n "$BLOCK_TIME" ]] && args+=(--block-time "$BLOCK_TIME")
if [[ -n "$FORK_URL" ]]; then
  args+=(--fork-url "$FORK_URL")
  [[ -n "$FORK_BLOCK" ]] && args+=(--fork-block-number "$FORK_BLOCK")
fi
if [[ -n "$STATE" ]]; then
  args+=(--state "$STATE")
fi
if [[ -n "${ANVIL_EXTRA_ARGS:-}" ]]; then
  read -r -a extra <<<"$ANVIL_EXTRA_ARGS"
  args+=("${extra[@]}")
fi

if [[ "$HOST" != "127.0.0.1" && "$HOST" != "localhost" ]]; then
  warn "anvil binds $HOST. Its RPC has no auth and its dev keys are public. Expose it only on a trusted network."
fi
if [[ "$CHAIN_ID" != "31337" ]]; then
  warn "chain id $CHAIN_ID is not 31337. scripts/deploy.sh --target local refuses the mock verifier off chain 31337 unless the deploy script's allow-mock flag is set (ZK_VOTING_ALLOW_MOCK_VERIFIER=1)."
fi

print_banner() {
  info ""
  info "zk-voting local chain"
  info "  RPC URL:   $RPC_URL"
  info "  Chain id:  $CHAIN_ID"
  if [[ -n "$BLOCK_TIME" ]]; then info "  Blocks:    every ${BLOCK_TIME}s"; else info "  Blocks:    mined on each transaction"; fi
  if [[ -n "$FORK_URL" ]]; then info "  Fork:      $(redact_url "$FORK_URL")${FORK_BLOCK:+ @ block $FORK_BLOCK}"; fi
  info "  Accounts:  $ACCOUNTS dev accounts with $BALANCE ETH each"
  info ""
  info "  The dev accounts come from Anvil's well-known public test mnemonic. Anvil lists"
  info "  them below (or in the log). They are public knowledge: use them on local chains"
  info "  only and never fund them on a real network."
  info ""
  info "  Next:  ./scripts/deploy.sh --target local --rpc-url $RPC_URL"
  info "         ./scripts/get-gas-economics.sh --measure --l2-rpc $RPC_URL"
  info ""
}

if [[ "$BACKGROUND" -eq 1 ]]; then
  if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    die "an anvil from this script is already running (pid $(cat "$PID_FILE")). Use --stop first."
  fi
  nohup anvil "${args[@]}" >"$LOG" 2>&1 &
  echo $! >"$PID_FILE"
  for _ in $(seq 1 50); do
    if rpc_call "$RPC_URL" eth_chainId >/dev/null 2>&1; then
      print_banner
      info "  Running in the background: pid $(cat "$PID_FILE"), log $LOG"
      info "  Stop it with: $(basename "$0") --stop"
      printf '%s\n' "$RPC_URL"
      exit 0
    fi
    sleep 0.2
  done
  die "anvil did not answer at $RPC_URL; see $LOG"
fi

print_banner
exec anvil "${args[@]}"
